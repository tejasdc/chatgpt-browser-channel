import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {SessionSources,SessionSourceRefresh} from './ports.js';
import type {ChatgptInventoryBrowser,ChatgptInventoryItem,ChatgptInventoryPage} from './chatgpt-inventory.js';
import {ChatgptSourceReadError} from './chatgpt-inventory.js';
import {chatgptDigest} from './chatgpt-content.js';
import {ensurePrivateDirectory} from './private-directory.js';
import {acquireOwnerLock} from './owner-lock.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema=z.object({
 id:z.string().regex(/^[a-zA-Z0-9-]+$/),revision:hash,savedRevision:hash.nullable(),rawHash:hash.nullable(),
 indexedHash:hash.nullable(),verifiedAt:z.string().datetime().nullable(),error:z.string().nullable(),
 rejectedHash:hash.nullable().default(null),
});
const checkpointSchema=z.object({
 version:z.literal(1),accountScope:z.string().regex(/^chatgpt:[a-f0-9]{64}$/),
 lastAttemptAt:z.string().datetime().nullable(),lastCompleteAt:z.string().datetime().nullable(),
 inventoryComplete:z.boolean(),reportedTotal:z.number().int().nonnegative().nullable(),
 cursor:z.object({pass:z.number().int(),archived:z.boolean(),offset:z.number().int().nonnegative()}).nullable(),
 pages:z.array(hash),wanted:z.array(z.string()),records:z.array(receiptSchema),
});
type Checkpoint=z.infer<typeof checkpointSchema>;
type DetailReceipt=z.infer<typeof receiptSchema>;
type Options=Readonly<{
 directory:string;browser:ChatgptInventoryBrowser;sources:Pick<SessionSources,'import'>&{retains?:(version:string)=>Promise<boolean>};
 now?:()=>Date;staleAfterMs?:number;readSpacingMs?:number;
}>;

/** Read-only source custody. Scheduling and the browser lifetime belong to composition. */
export class ChatgptRefresh {
 private checkpoint:Checkpoint|null=null;
 private pending:Promise<SessionSourceRefresh>|undefined;
 private initialized=false;
 private restoring:Promise<void>|null=null;
 private state:SessionSourceRefresh['state']='partial';
 private reason:string|null='ChatGPT history has not been refreshed.';
 private readonly releaseOwnerLock:()=>void;
 private readonly stop=new AbortController();
 private closing:Promise<void>|undefined;
 private closed=false;
 constructor(private readonly options:Options){
  ensurePrivateDirectory(options.directory);
  this.releaseOwnerLock=acquireOwnerLock(join(options.directory,'.history-owner.lock'),'CHATGPT_HISTORY_OWNER_BUSY');
 }
 private now():Date{return this.options.now?.()??new Date();}
 status():SessionSourceRefresh {
  const saved=this.checkpoint;
  const wanted=new Set(saved?.wanted??[]);
  const records=(saved?.records??[]).filter(value=>wanted.has(value.id));
  const fresh=records.filter(value=>value.rawHash&&value.savedRevision===value.revision);
  const lastObservation=Math.max(Date.parse(saved?.lastAttemptAt??''),Date.parse(saved?.lastCompleteAt??'')||0);
  const stale=!!saved?.lastAttemptAt&&this.now().getTime()-lastObservation>(this.options.staleAfterMs??600_000);
  return {
   accountScope:saved?.accountScope??null,state:this.state==='idle'&&stale?'partial':this.state,
   inventoryComplete:saved?.inventoryComplete??false,discovered:wanted.size,saved:fresh.length,
   indexed:fresh.filter(value=>value.indexedHash===value.rawHash).length,failed:records.filter(value=>value.error).length,
   reportedTotal:saved?.reportedTotal??null,lastAttemptAt:saved?.lastAttemptAt??null,lastCompleteAt:saved?.lastCompleteAt??null,
   reason:stale&&this.state==='idle'?'ChatGPT refresh is overdue; saved history remains searchable.':this.reason,
  };
 }
 refresh(input:Readonly<{signal?:AbortSignal;maxDetails?:number}>={}):Promise<SessionSourceRefresh> {
  if(this.closed)return Promise.reject(new Error('CHATGPT_REFRESH_PAUSED'));
  if(this.pending)return this.pending;
  if(input.maxDetails!==undefined&&(!Number.isSafeInteger(input.maxDetails)||input.maxDetails<0))return Promise.reject(new Error('CHATGPT_REFRESH_BUDGET_INVALID'));
  const signal=input.signal?AbortSignal.any([input.signal,this.stop.signal]):this.stop.signal;
  this.pending=this.perform({...input,signal}).finally(()=>{this.pending=undefined;});return this.pending;
 }
 restore():Promise<void>{
  if(this.closed)return Promise.reject(new Error('CHATGPT_REFRESH_PAUSED'));
  if(this.initialized)return Promise.resolve();
  this.restoring??=this.restoreSources().finally(()=>{this.restoring=null;});return this.restoring;
 }
 async close():Promise<void>{
  if(this.closing)return this.closing;
  this.closed=true;this.stop.abort();
  this.closing=(async()=>{const active:Promise<unknown>[]=[];if(this.pending)active.push(this.pending);if(this.restoring)active.push(this.restoring);await Promise.allSettled(active);this.releaseOwnerLock();})();
  return this.closing;
 }
 private async restoreSources():Promise<void>{
  ensurePrivateDirectory(join(this.options.directory,'snapshots'));
  const existing=await readFile(join(this.options.directory,'refresh.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing)this.checkpoint=checkpointSchema.parse(JSON.parse(existing));
  if(this.checkpoint){
   // Only a download interrupted before it reached search needs finishing here; new
   // messages arrive through the refresh itself, which never talks to ChatGPT at startup.
   for(const entry of this.checkpoint.records){
    if(entry.rawHash&&entry.indexedHash===entry.rawHash&&await this.options.sources.retains?.(entry.rawHash)!==false)continue;
    entry.indexedHash=null;try{await this.index(entry,this.checkpoint.accountScope);}catch(error){entry.error=this.safeReason(error);}
   }
   await this.save();this.reason='Saved ChatGPT history is searchable. Background refresh has not completed.';
  }
  this.initialized=true;
 }
 private async atomic(path:string,content:string):Promise<void>{
  const temporary=path+'.'+randomUUID()+'.pending';const file=await open(temporary,'wx',0o600);
  try{await file.writeFile(content);await file.sync();}finally{await file.close();}
  await rename(temporary,path);const directory=await open(this.options.directory,'r');try{await directory.sync();}finally{await directory.close();}
 }
 private async save():Promise<void>{await this.atomic(join(this.options.directory,'refresh.json'),JSON.stringify(this.checkpoint));}
 private async retain(content:string):Promise<string>{
  const version=chatgptDigest(content),path=join(this.options.directory,'snapshots',version+'.json');
  try{const file=await open(path,'wx',0o600);try{await file.writeFile(content);await file.sync();}finally{await file.close();}}
  catch(error){if(!(typeof error==='object'&&error&&'code' in error&&error.code==='EEXIST'))throw error;if(await readFile(path,'utf8')!==content)throw new Error('CHATGPT_SNAPSHOT_CORRUPT');}
  const directory=await open(join(this.options.directory,'snapshots'),'r');try{await directory.sync();}finally{await directory.close();}
  return version;
 }
 private check(signal?:AbortSignal):void{if(signal?.aborted)throw new Error('CHATGPT_REFRESH_PAUSED');}
 private async index(entry:DetailReceipt,scope:string):Promise<void>{
  if(!entry.rawHash)return;
  const content=await readFile(join(this.options.directory,'snapshots',entry.rawHash+'.json'),'utf8');
  if(chatgptDigest(content)!==entry.rawHash)throw new Error('CHATGPT_SNAPSHOT_CORRUPT');
  const imported=await this.options.sources.import('chatgpt-'+entry.id+'.json',content,scope);
  if(!imported.length||imported.some(source=>source.provider!=='chatgpt'||source.nativeId!==entry.id||source.scope!==scope))throw new Error('CHATGPT_SOURCE_IDENTITY_MISMATCH');
  entry.indexedHash=entry.rawHash;entry.error=null;
 }
 private pause(signal?:AbortSignal):Promise<void>{
  // One conversation at a time with a gap, so a backlog never reads as a burst to ChatGPT.
  return new Promise(resolve=>{const timer=setTimeout(resolve,this.options.readSpacingMs??2000);signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
 }
 private async page(archived:boolean,offset:number):Promise<ChatgptInventoryPage>{
  const checkpoint=this.checkpoint!;
  const page:ChatgptInventoryPage=await this.options.browser.inventory(checkpoint.accountScope,archived,offset).catch(async error=>{
   if(error instanceof ChatgptSourceReadError){checkpoint.pages.push(await this.retain(JSON.stringify(error.raw)));await this.save();}throw error;
  });
  checkpoint.pages.push(await this.retain(JSON.stringify(page.raw)));
  return page;
 }
 /** Newest-first pages until the first conversation whose marker is already known. */
 private async recent(known:ReadonlyMap<string,DetailReceipt>,signal?:AbortSignal):Promise<ChatgptInventoryItem[]>{
  const checkpoint=this.checkpoint!;const items:ChatgptInventoryItem[]=[];let offset:number|null=0;
  while(offset!==null){
   this.check(signal);
   const page=await this.page(false,offset);
   const unchanged=page.items.findIndex(item=>known.get(item.id)?.revision===item.revision);
   items.push(...(unchanged<0?page.items:page.items.slice(0,unchanged)));
   if(unchanged>=0)break;
   if(page.nextOffset!==null&&page.nextOffset<=offset)throw new Error('CHATGPT_INVENTORY_CURSOR_INVALID');
   offset=page.nextOffset;
  }
  checkpoint.wanted=[...new Set([...checkpoint.wanted,...items.map(item=>item.id)])];await this.save();
  return items;
 }
 /** The first listing reads every conversation twice, since offset pages are not a snapshot. */
 private async everything(signal?:AbortSignal):Promise<ChatgptInventoryItem[]>{
  const checkpoint=this.checkpoint!;checkpoint.inventoryComplete=false;await this.save();
  const first=await this.inventory(1,signal);const second=await this.inventory(2,signal);
  const fingerprint=(items:ChatgptInventoryItem[])=>JSON.stringify([...items].sort((a,b)=>a.id.localeCompare(b.id)));
  if(fingerprint(first)!==fingerprint(second))throw new Error('CHATGPT_INVENTORY_CHANGED');
  checkpoint.inventoryComplete=true;checkpoint.cursor=null;checkpoint.wanted=second.map(item=>item.id);
  return second;
 }
 private async inventory(pass:number,signal?:AbortSignal):Promise<ChatgptInventoryItem[]>{
  const checkpoint=this.checkpoint!;const items=new Map<string,ChatgptInventoryItem>();let total=0;
  for(const archived of [false,true]){
   let offset:number|null=0;
   while(offset!==null){
    this.check(signal);checkpoint.cursor={pass,archived,offset};await this.save();
    const page:ChatgptInventoryPage=await this.options.browser.inventory(checkpoint.accountScope,archived,offset).catch(async error=>{
     if(error instanceof ChatgptSourceReadError){checkpoint.pages.push(await this.retain(JSON.stringify(error.raw)));await this.save();}throw error;
    });
    const version=await this.retain(JSON.stringify(page.raw));checkpoint.pages.push(version);
    for(const item of page.items){if(items.has(item.id))throw new Error('CHATGPT_INVENTORY_CHANGED');items.set(item.id,item);}
    if(pass===1)checkpoint.wanted=[...items.keys()];
    if(page.nextOffset!==null&&page.nextOffset<=offset)throw new Error('CHATGPT_INVENTORY_CURSOR_INVALID');
    offset=page.nextOffset;if(offset===null)total+=page.reportedTotal;
    await this.save();
   }
  }
  if(items.size!==total)throw new Error('CHATGPT_INVENTORY_INCOMPLETE');
  checkpoint.reportedTotal=total;
  return [...items.values()];
 }
 private async perform(input:Readonly<{signal?:AbortSignal;maxDetails?:number}>):Promise<SessionSourceRefresh>{
  this.state='refreshing';this.reason='Checking ChatGPT inventory and retaining local transcripts.';
  let durableReady=false;
  try{
   await this.restore();
   const saved=await readFile(join(this.options.directory,'refresh.json'),'utf8').catch(error=>{if(error.code==='ENOENT'&&!this.checkpoint)return null;throw error;});
   if(saved)this.checkpoint=checkpointSchema.parse(JSON.parse(saved));
   durableReady=!!this.checkpoint;
   this.check(input.signal);
   const scope=await this.options.browser.account();
   if(!/^chatgpt:[a-f0-9]{64}$/.test(scope))throw new Error('CHATGPT_ACCOUNT_UNCONFIRMED');
   if(this.checkpoint&&this.checkpoint.accountScope!==scope)throw new Error('CHATGPT_ACCOUNT_MISMATCH');
   this.checkpoint??={version:1,accountScope:scope,lastAttemptAt:null,lastCompleteAt:null,inventoryComplete:false,reportedTotal:null,cursor:null,pages:[],wanted:[],records:[]};
   durableReady=true;
   const checkpoint=this.checkpoint;checkpoint.lastAttemptAt=this.now().toISOString();checkpoint.pages=[];await this.save();this.initialized=true;
   const records=new Map(checkpoint.records.map(value=>[value.id,value]));
   // The list is ordered by last update and each marker covers the latest message, so once
   // the whole list has been read, only the conversations above the first unchanged one can
   // have changed. The full two-pass listing runs only until the first one completes.
   const listed=checkpoint.inventoryComplete&&checkpoint.wanted.length?await this.recent(records,input.signal):await this.everything(input.signal);
   for(const item of listed){const prior=records.get(item.id);records.set(item.id,prior?{...prior,revision:item.revision}:{...item,savedRevision:null,rawHash:null,indexedHash:null,verifiedAt:null,error:null,rejectedHash:null});}
   checkpoint.records=[...records.values()];await this.save();
   let reads=0;
   const needsRead=(value:DetailReceipt)=>value.savedRevision!==value.revision||!value.rawHash;
   // Changed conversations first, newest first; then the backlog never downloaded.
   const wanted=new Set(checkpoint.wanted),order=new Map(listed.map((item,index)=>[item.id,index]));
   const ordered=checkpoint.records.filter(value=>wanted.has(value.id)&&(needsRead(value)||value.indexedHash!==value.rawHash))
    .sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity));
   for(const entry of ordered){
    this.check(input.signal);
    try{
     if(needsRead(entry)){
      if(reads>=(input.maxDetails??Infinity))continue;
      if(reads++)await this.pause(input.signal);
      const conversation=await this.options.browser.read(entry.id,scope);
      if(conversation.id!==entry.id)throw new Error('CHATGPT_CONVERSATION_MISMATCH');
      entry.rawHash=await this.retain(JSON.stringify(conversation.raw));entry.savedRevision=entry.revision;entry.verifiedAt=this.now().toISOString();entry.error=null;entry.rejectedHash=null;await this.save();
     }
     if(entry.rawHash&&entry.indexedHash!==entry.rawHash){
      await this.index(entry,scope);await this.save();
     }
    }catch(error){
     if(error instanceof ChatgptSourceReadError)entry.rejectedHash=await this.retain(JSON.stringify(error.raw));
     entry.error=this.safeReason(error);await this.save();
     if(error instanceof Error&&/ACCOUNT_|AUTH_|AUTHENTICATED_READ|RATE_LIMIT/.test(error.message))throw error;
    }
   }
   const status=this.status();const remaining=checkpoint.records.some(value=>wanted.has(value.id)&&needsRead(value));
   if(status.saved===status.discovered&&status.indexed===status.saved&&!status.failed&&!remaining){
    checkpoint.lastCompleteAt=this.now().toISOString();this.state='idle';this.reason='Accessible inventory retained. The next refresh reads only conversations changed since.';
   }else{this.state='partial';this.reason='ChatGPT history is partially refreshed; retained transcripts remain searchable and pending details will be retried.';}
   await this.save();
  }catch(error){
   this.state=this.checkpoint?'partial':'failed';this.reason=this.safeReason(error);
   if(durableReady)await this.save().catch(()=>{this.state='failed';this.reason='ChatGPT refresh could not save its checkpoint. Previously saved history is retained.';});
  }
  return this.status();
 }
 private safeReason(error:unknown):string{
  const code=error instanceof Error?error.message:'';
  if(code==='CHATGPT_REFRESH_PAUSED')return 'ChatGPT refresh paused; saved transcripts and progress are retained.';
  if(code==='CHATGPT_ACCOUNT_MISMATCH')return 'The ChatGPT account changed. Refresh is paused until the original account is restored.';
  if(code.includes('AUTH_')||code.includes('AUTHENTICATED_READ'))return 'ChatGPT could not be read with the current login. Refresh needs attention; saved history remains searchable.';
  if(code==='CHATGPT_RATE_LIMITED')return 'ChatGPT is limiting reads. Refresh is paused for a later retry; saved history remains searchable.';
  if(code.includes('INVENTORY'))return 'ChatGPT inventory changed or could not be fully read. Coverage remains partial until a stable retry succeeds.';
  return 'ChatGPT refresh could not finish a read or local import. Saved history is retained; retry will resume pending work.';
 }
}
