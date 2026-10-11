import {constants,readFileSync,readdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireOwnerLock} from './owner-lock.js';
import {ensurePrivateDirectory} from './private-directory.js';
import type {AgentHistoryPage,NativeSessionBinding,NativeSessionReference,ProviderEvent,ProviderExecution,ProviderInput,ProviderResult,ProviderRunIdentity,SubscriptionProvider} from './ports.js';
import {chatgptDigest,chatgptMessageText,projectChatgptMessages,verifyChatgptAnchor} from './chatgpt-content.js';
import type {ChatgptConversation,ChatgptMessage} from './chatgpt-content.js';
import type {ChatgptBrowserPort,ChatgptThinkingLevel} from './chatgpt-browser.js';
import {ChatgptSendError,chatgptThinkingLevels} from './chatgpt-browser.js';
import {field,record,stringField} from './provider-values.js';
const resumeRetry={maxAttempts:20,maxAgeMs:30*60_000,baseDelayMs:2_000,capDelayMs:60_000,jitterFraction:0.2};
const retryDelay=(attempt:number)=>Math.min(resumeRetry.capDelayMs,resumeRetry.baseDelayMs*2**Math.max(0,attempt-1))*(1+resumeRetry.jitterFraction*(2*Math.random()-1));

type EffectEvent=Readonly<{cursor:string;eventId:string;kind:'identity'|'message'|'result';at:string;payload:unknown}>;
type Receipt=Readonly<{version:1;id:string;promptHash:string;sentHash?:string;phase:'prepared'|'dispatched'|'acknowledged'|'completed';accountScope:string|null;
 baseline:string|null;binding:NativeSessionBinding|null;messageId:string|null;answerId:string|null;
 ownerContext?:string;requestedModel?:string;retryMessageId?:string;answerModel?:string;thinking?:string|null;events?:readonly EffectEvent[];result?:ProviderResult;acknowledgedAt?:string;failure?:Readonly<{stage:string;code:string}>}> & RetryReceipt;
type RetryReceipt=Readonly<{retryPhase?:'dispatched'|'acknowledged';retryBaseline?:string|null}>;
type Options=Readonly<{directory:string;browser:ChatgptBrowserPort;pollMs?:number;agentProject?:string;personalModelPrefix?:string;diagnostic?:(event:Readonly<Record<string,unknown>>)=>void}>;
/** A Pro request is verified from the recorded answer model and retried once if it differs. */
const proModel=(model:string|null)=>!!model&&/-pro(?:$|[-.])/.test(model);
/** Pace sends to avoid accidental bursts across process restarts. */
export const chatgptPacing={perHour:6,minGapMs:120_000} as const;
type SendRecord=Readonly<{at:number;kind:'agent'|'his'|'retry'}>;
const retryAtProPrompt='Please answer my previous message again, in full, as your complete answer.';
export class ChatgptSubscription implements SubscriptionProvider {
 readonly id='chatgpt' as const;
 /** `chat` and `work` pick the mode and leave thinking as it is; a thinking level picks Chat at that level. */
 readonly models:readonly string[];
 /** ChatGPT reads any file a person can attach; its own upload refuses what it cannot take. */
 readonly attachmentTypes:readonly string[]=['*/*'];
 readonly supportsSessionTools=false;
 readonly supportsStop=false;
 private readonly receipts=new Map<string,Receipt>();
 private readonly observations=new Set<AbortController>();
 private readonly active=new Set<string>();
 private readonly listeners=new Set<(id:string)=>void>();
 private readonly inFlight=new Set<Promise<unknown>>();
 private closed=false;
 private closing:Promise<void>|undefined;
 private sends:SendRecord[]=[];
 private waiting=0;
 private paceTail:Promise<void>=Promise.resolve();
 private readonly releaseOwnerLock:()=>void;
 constructor(private readonly options:Options){
  const prefix=options.personalModelPrefix??'personal:';
  if(!prefix||!prefix.endsWith(':'))throw new Error('CHATGPT_PERSONAL_PREFIX_INVALID');
  this.models=['chat','work',...chatgptThinkingLevels,...chatgptThinkingLevels.map(level=>prefix+level)];
  ensurePrivateDirectory(options.directory);
  this.releaseOwnerLock=acquireOwnerLock(join(options.directory,'.channel-owner.lock'),'CHATGPT_OWNER_BUSY');
  for(const name of readdirSync(options.directory).filter(name=>/^run-[a-f0-9-]+\.json$/.test(name))){
   const value:unknown=JSON.parse(readFileSync(join(options.directory,name),'utf8'));
   if(!record(value)||value['version']!==1||typeof value['id']!=='string'||typeof value['promptHash']!=='string'||!['prepared','dispatched','acknowledged','completed'].includes(String(value['phase'])))throw new Error('CHATGPT_RECEIPT_INVALID');
   this.receipts.set(value['id'],value as Receipt);
  }
  // An acknowledged request continues to be observed after this process restarts.
  try{const saved:unknown=JSON.parse(readFileSync(join(options.directory,'sends.json'),'utf8'));if(Array.isArray(saved))this.sends=saved.filter(item=>record(item)&&typeof item['at']==='number') as SendRecord[];}catch{}
  queueMicrotask(()=>{if(!this.closed)this.resumeAnswers();});
 }
 private track<T>(task:Promise<T>):Promise<T>{this.inFlight.add(task);void task.finally(()=>this.inFlight.delete(task)).catch(()=>{});return task;}
 pendingCount():number{return this.active.size;}
 /** Waits until a send fits the pace, then records it; queued sends go out in order. */
 private pace(kind:SendRecord['kind'],signal:AbortSignal):Promise<void>{
  const turn=this.paceTail.then(async()=>{
   this.waiting++;
   try{
    for(;;){
     if(signal.aborted)throw new Error('CHATGPT_OBSERVATION_STOPPED');
     const now=Date.now(),recent=this.sends.filter(item=>now-item.at<3_600_000);
     const last=recent.at(-1)?.at??0;
     const freeAt=Math.max(last+chatgptPacing.minGapMs,recent.length>=chatgptPacing.perHour?recent[recent.length-chatgptPacing.perHour]!.at+3_600_000:0);
     if(freeAt<=now)break;
     await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,Math.min(freeAt-now,60_000));signal.addEventListener('abort',done,{once:true});});
    }
    this.sends=[...this.sends.filter(item=>Date.now()-item.at<7*86_400_000),{at:Date.now(),kind}];
    this.atomic('sends.json',this.sends);
   }finally{this.waiting--;}
  });
  this.paceTail=turn.catch(()=>{});
  return turn;
 }
 /** What Provider accounts shows: sends per hour for the last day, totals, and the pace. */
 usage(){
  const now=Date.now(),hour=3_600_000,start=Math.floor(now/hour)*hour-23*hour;
  const perHour=Array.from({length:24},(_,index)=>({hour:new Date(start+index*hour).toISOString(),count:0}));
  for(const item of this.sends)if(item.at>=start)perHour[Math.floor((item.at-start)/hour)]!.count++;
  return {perHour,lastDay:this.sends.filter(item=>now-item.at<86_400_000).length,lastWeek:this.sends.length,
   lastHour:this.sends.filter(item=>now-item.at<hour).length,waiting:this.waiting,pacing:{perHour:chatgptPacing.perHour,minGapMinutes:chatgptPacing.minGapMs/60_000}};
 }
 private resumeAnswers():void{
  if(this.closed)return;
  for(const receipt of this.receipts.values()){
   if(receipt.result||this.active.has(receipt.id))continue;
   // 'prepared' is saved before the request waits its turn and before anything is typed; the phase
   // becomes 'dispatched' first. So a prepared request a previous process left behind was provably
   // never sent: say so, rather than leaving it uncertain.
   if(receipt.phase==='prepared'){
    this.event(receipt.id,{kind:'result',result:{sessionId:receipt.binding?.sessionId??'',turnId:null,...(receipt.binding?{nativeBinding:receipt.binding}:{}),text:'',state:'failed',error:'CHATGPT_NOT_SENT'}});
    continue;
   }
   // Completion and its result event are separate durable writes. A crash between them
   // must read the already answered conversation again without sending another turn.
   if(!['acknowledged','completed'].includes(receipt.phase)||!receipt.binding||!receipt.messageId)continue;
   const id=receipt.id,signal=new AbortController();this.observations.add(signal);this.active.add(id);
   const thinking=(chatgptThinkingLevels as readonly string[]).includes(receipt.thinking??'')?receipt.thinking as ChatgptThinkingLevel:null;
   const task=this.readOnAcrossOutage(id,thinking,signal.signal)
    .then(result=>{this.event(id,{kind:'result',result});},error=>{
     if(error instanceof Error&&error.message==='CHATGPT_OBSERVATION_STOPPED')return;
     const current=this.receipts.get(id)!;
     this.event(id,{kind:'result',result:{sessionId:current.binding!.sessionId,turnId:current.messageId,nativeBinding:current.binding!,text:'',state:'uncertain',error:'CHATGPT_ANSWER_UNREAD'}});
    }).finally(()=>{this.observations.delete(signal);this.active.delete(id);for(const listener of this.listeners)listener(id);});
   this.track(task);
  }
 }
 // ChatGPT already has this request, so its answer exists; a process that just started may find the
 // browser still recovering. Keep reading for a bounded period.
 private async readOnAcrossOutage(id:string,thinking:ChatgptThinkingLevel|null,signal:AbortSignal):Promise<ProviderResult>{
  const started=Date.now(),policy=resumeRetry;
  for(let attempt=0;;attempt++){
   try{return await this.awaitAnswer(id,thinking,signal,async message=>{this.event(id,{kind:'message',message});});}
   catch(error){
    const code=error instanceof Error?error.message:String(error);
    if(code==='CHATGPT_OBSERVATION_STOPPED'||code==='CHATGPT_MODEL_MISMATCH'||attempt+1>=policy.maxAttempts||Date.now()-started>policy.maxAgeMs)throw error;
    this.options.diagnostic?.({event:'chatgpt_resume_retry',code,attempt});
    await new Promise<void>(resolve=>{const timer=setTimeout(resolve,retryDelay(attempt+1));signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
    if(signal.aborted)throw new Error('CHATGPT_OBSERVATION_STOPPED');
   }
  }
 }
 private atomic(name:string,value:unknown):void{
  if(this.closed)throw new Error('CHATGPT_OBSERVATION_STOPPED');
  const path=join(this.options.directory,name);const temporary=path+'.'+randomUUID()+'.pending';
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);const directory=openSync(this.options.directory,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
 }
 // Events and the result are appended only by event(); every other save keeps the stored ones, so a
 // caller holding an older copy of the receipt can never shorten the event list a reader's cursor points into.
 private save(receipt:Receipt,appended=false):void{const stored=this.receipts.get(receipt.id);const {events:_events,result:_result,...fields}=receipt;const saved:Receipt=appended||!stored?{...stored,...receipt}:{...stored,...fields};this.atomic('run-'+receipt.id+'.json',saved);this.receipts.set(receipt.id,saved);for(const listener of this.listeners)listener(receipt.id);}
 private event(id:string,event:ProviderEvent|Readonly<{kind:'result';result:ProviderResult}>):void{
  if(this.closed)return;
  if(event.kind!=='identity'&&event.kind!=='message'&&event.kind!=='result')return;
  const receipt=this.receipts.get(id);if(!receipt)throw new Error('CHATGPT_RECEIPT_UNCONFIRMED');
  const {kind,...payload}=event;const cursor=id+':'+String((receipt.events?.length??0)+1);
  this.save({...receipt,...(event.kind==='result'?{result:event.result}:{}),events:[...(receipt.events??[]),{cursor,eventId:cursor,kind,at:new Date().toISOString(),payload}]},true);
 }
 effect(id:string){
  const receipt=this.receipts.get(id);if(!receipt)return null;
  return {runId:id,promptHash:receipt.promptHash,requestedModel:receipt.requestedModel??null,ownerContext:receipt.ownerContext??null,events:receipt.events??[],
   state:receipt.result?.state??(this.active.has(id)?receipt.phase==='prepared'?'recorded':'running':'uncertain'),
   acknowledgedAt:receipt.acknowledgedAt??null,nativeBinding:receipt.binding,result:receipt.result??null,error:receipt.result?.error??(this.active.has(id)?null:'CHATGPT_EFFECT_OBSERVATION_UNCERTAIN')};
 }
 private waitForResult(id:string):Promise<ProviderResult>{
  return new Promise<ProviderResult>((resolve,reject)=>{
   const changed=(runId:string)=>{
    if(runId!==id)return;
    const result=this.receipts.get(id)?.result;
    if(result){this.listeners.delete(changed);resolve(result);}
    else if(this.closed||!this.active.has(id)){this.listeners.delete(changed);reject(new Error('CHATGPT_EFFECT_OBSERVATION_UNCERTAIN'));}
   };
   this.listeners.add(changed);changed(id);
  });
 }
 async observeEffect(id:string,after:string|null,signal:AbortSignal){
  const changed=()=>{const effect=this.effect(id);if(!effect)throw new Error('CHATGPT_RECEIPT_UNCONFIRMED');
   const at=after===null?-1:effect.events.findIndex(event=>event.cursor===after);if(after!==null&&at<0)throw new Error('CHATGPT_EFFECT_CURSOR_INVALID');
   const events=effect.events.slice(at+1);const complete=!['recorded','running'].includes(effect.state);
   return events.length||complete?{runId:id,events,nextCursor:effect.events.at(-1)?.cursor??null,complete,result:effect.result,...(effect.state==='uncertain'?{error:effect.error}: {})}:null;};
  return new Promise<NonNullable<ReturnType<typeof changed>>>((resolve,reject)=>{
   const cleanup=()=>{this.listeners.delete(listener);signal.removeEventListener('abort',aborted);};
   const check=()=>{try{const value=changed();if(value){cleanup();resolve(value);}}catch(error){cleanup();reject(error);}};
   const listener=(runId:string)=>{if(runId===id)check();};const aborted=()=>{cleanup();reject(new Error('CHATGPT_OBSERVER_CLOSED'));};
   this.listeners.add(listener);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();else check();
  });
 }
 private retain(conversation:ChatgptConversation,scope:string):void{
  this.atomic('conversation-'+chatgptDigest(JSON.stringify([scope,conversation.id]))+'.json',conversation.raw);
  for(const node of conversation.nodes.values())if(node.message){const version=chatgptDigest(JSON.stringify(node.message));const name='message-'+chatgptDigest(JSON.stringify([scope,conversation.id,node.id,version]))+'.json';if(!existsSync(join(this.options.directory,name)))this.atomic(name,{conversationId:conversation.id,nodeId:node.id,message:node.message});}
 }
 async available(){try{await this.options.browser.account();return {available:true,reason:null};}catch(error){
  const code=error instanceof Error?error.message:'';
  return {available:false,reason:['CHATGPT_SIGNIN_ACCOUNT_REQUIRED','CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED','CHATGPT_SIGNIN_ACCOUNT_MISMATCH','CHATGPT_SIGNIN_NEEDS_OPERATOR','CHATGPT_CHALLENGE_NEEDS_OPERATOR'].includes(code)?code:'Open the dedicated ChatGPT browser and sign in.'};
 }}
 async bind(reference:NativeSessionReference):Promise<NativeSessionBinding>{
  const accountScope=await this.options.browser.account();
  if(reference.accountScope.startsWith('chatgpt:')&&reference.accountScope!==accountScope)throw new Error('CHATGPT_ACCOUNT_MISMATCH');
  const conversation=await this.options.browser.read(reference.sessionId,accountScope);
  verifyChatgptAnchor(conversation,reference.anchor);this.retain(conversation,accountScope);
  return {accountScope,sessionId:conversation.id,anchor:reference.anchor};
 }
 async searchSources(query:string){
  const found=await this.options.browser.search(query);const sources=[];
  for(const match of found.matches){
   const conversation=await this.options.browser.read(match.sessionId,found.accountScope);this.retain(conversation,found.accountScope);
   sources.push({name:'chatgpt-'+conversation.id+'.json',content:JSON.stringify(conversation.raw),scope:found.accountScope,matchedEventId:match.messageId});
  }
  return {sources,complete:found.complete};
 }
 async snapshot(binding:NativeSessionBinding){
  const conversation=await this.options.browser.read(binding.sessionId,binding.accountScope);this.retain(conversation,binding.accountScope);
  return {name:'chatgpt-'+conversation.id+'.json',content:JSON.stringify(conversation.raw),scope:binding.accountScope,branch:conversation.currentNode};
 }
 async start(input:ProviderInput):Promise<ProviderExecution>{
  return this.startEffect(input);
 }
 async startOwned(input:ProviderInput,ownerContext:string,beforeDispatch:()=>Promise<void>):Promise<ProviderExecution>{
  return this.startEffect(input,ownerContext,beforeDispatch);
 }
 private async startEffect(input:ProviderInput,ownerContext?:string,beforeDispatch?:()=>Promise<void>):Promise<ProviderExecution>{
  if(this.closed)throw new Error('CHATGPT_OBSERVATION_STOPPED');
  if(input.purpose!=='chat')throw new Error('PROVIDER_PURPOSE_UNSUPPORTED');
  if(input.policy||input.tools)throw new Error('CHATGPT_POLICY_UNSUPPORTED');
  if(input.model!==undefined&&!this.models.includes(input.model))throw new Error('CHATGPT_MODEL_UNSUPPORTED');
  if(!/^[a-f0-9-]{36}$/.test(input.id))throw new Error('INVALID_OPERATION');
  if(input.sessionId&&(!input.nativeBinding||input.nativeBinding.sessionId!==input.sessionId))throw new Error('CHATGPT_BINDING_REQUIRED');
  const previous=this.receipts.get(input.id);
  if(previous&&ownerContext!==undefined&&previous.ownerContext!==ownerContext)throw new Error('ID_REUSE');
  if(previous&&(previous.requestedModel===undefined||previous.requestedModel!==(input.model??'chat')))throw new Error('ID_REUSE');
  if(previous){
   if(previous.promptHash!==chatgptDigest(input.prompt)||input.nativeBinding&&(input.nativeBinding.accountScope!==previous.binding?.accountScope||input.nativeBinding.sessionId!==previous.binding.sessionId))throw new Error('ID_REUSE');
   this.resumeAnswers();
   const current=this.receipts.get(input.id)!;
   const result=current.result?Promise.resolve(current.result):this.active.has(input.id)?this.waitForResult(input.id):this.reconcile({id:input.id,sessionId:current.binding?.sessionId??null,turnId:current.messageId,...(current.binding?{nativeBinding:current.binding}:{})});
   return {result,cancel:async()=>{throw new Error('CHATGPT_STOP_UNSUPPORTED');}};
  }
  const signal=new AbortController();this.observations.add(signal);if(!previous)this.active.add(input.id);
  const observed={...input,onEvent:async(event:ProviderEvent)=>{this.event(input.id,event);await input.onEvent(event);}};
  const result=this.track(this.execute(observed,signal.signal,ownerContext,beforeDispatch).then(result=>{
   this.event(input.id,{kind:'result',result});return result;
  },error=>{
   const receipt=this.receipts.get(input.id);
   if(!this.closed&&receipt&&!previous&&error instanceof ChatgptSendError)this.save({...receipt,failure:{stage:error.stage,code:error.message}});
   // A stop after ChatGPT acknowledged the request leaves it to the next process to read on.
   const resumable=error instanceof Error&&error.message==='CHATGPT_OBSERVATION_STOPPED'&&receipt?.phase==='acknowledged';
   if(!this.closed&&receipt&&!previous&&!resumable)this.event(input.id,{kind:'result',result:{sessionId:receipt.binding?.sessionId??'',turnId:receipt.messageId,...(receipt.binding?{nativeBinding:receipt.binding}:{}),text:'',state:receipt.phase==='prepared'?'failed':'uncertain',error:receipt.phase==='prepared'?'CHATGPT_SEND_FAILED':'CHATGPT_SEND_UNCONFIRMED'}});
   throw error;
  }).finally(()=>{this.observations.delete(signal);if(!previous)this.active.delete(input.id);for(const listener of this.listeners)listener(input.id);}));
  return {result,cancel:async()=>{signal.abort();throw new Error('CHATGPT_STOP_UNSUPPORTED');}};
 }
 private async execute(input:ProviderInput,signal:AbortSignal,ownerContext?:string,beforeDispatch?:()=>Promise<void>):Promise<ProviderResult>{
  if(this.receipts.has(input.id))throw new Error('ID_REUSE');
  let receipt:Receipt={version:1,id:input.id,promptHash:chatgptDigest(input.prompt),sentHash:chatgptDigest(input.prompt.trim()),requestedModel:input.model??'chat',phase:'prepared',accountScope:null,baseline:null,binding:input.nativeBinding??null,messageId:null,answerId:null,...(ownerContext?{ownerContext}:{})};
  this.save(receipt);
  // A caller can opt out of the configured project with a prefixed model selection.
  const prefix=this.options.personalModelPrefix??'personal:';
  const his=input.model?.startsWith(prefix)??false;const level=his?input.model!.slice(prefix.length):input.model;
  const thinking=(chatgptThinkingLevels as readonly string[]).includes(level??'')?level as ChatgptThinkingLevel:null;
  const project=his||!thinking?null:this.options.agentProject??null;
  receipt={...receipt,thinking};this.save(receipt);
  await this.pace(his?'his':'agent',signal);
  await this.options.browser.send({prompt:input.prompt,binding:input.nativeBinding??null,mode:input.model==='work'?'work':'chat',thinking,project,attachments:input.attachments??[],
   prepared:async(accountScope,baseline)=>{receipt={...receipt,accountScope,baseline};this.save(receipt);},
   dispatching:async()=>{if(signal.aborted)throw new Error('CHATGPT_OBSERVATION_STOPPED');await beforeDispatch?.();receipt={...receipt,phase:'dispatched'};this.save(receipt);},
   accepted:async(binding,messageId)=>{receipt={...receipt,binding,messageId,phase:'acknowledged',acknowledgedAt:new Date().toISOString()};this.save(receipt);await input.onEvent({kind:'identity',sessionId:binding.sessionId,turnId:messageId,nativeBinding:binding});},
  });
  if(!receipt.binding||!receipt.messageId)throw new Error('CHATGPT_SEND_UNCONFIRMED');
  return this.awaitAnswer(input.id,thinking,signal,async message=>{await input.onEvent({kind:'message',message});});
 }
 /** Reads an acknowledged request's conversation until its answer is complete and verified. */
 private async awaitAnswer(id:string,thinking:ChatgptThinkingLevel|null,signal:AbortSignal,onMessage:(message:ChatgptMessage)=>Promise<void>):Promise<ProviderResult>{
  let receipt=this.receipts.get(id)!;
  if(!receipt.binding||!receipt.messageId)throw new Error('CHATGPT_SEND_UNCONFIRMED');
  let last='';const sent=Date.now();
  while(!signal.aborted){
   if(receipt.retryPhase==='dispatched'&&!receipt.retryMessageId)return {sessionId:receipt.binding.sessionId,turnId:receipt.messageId,nativeBinding:receipt.binding,text:'',state:'uncertain',error:'CHATGPT_PRO_RETRY_UNCONFIRMED'};
   // Pro answers take minutes to an hour: read every 5 seconds for the first minute, then every 20; ChatGPT throttles frequent reads.
   const pause=Date.now()-sent<60_000?Math.max(this.options.pollMs??5000,5000):Math.max(this.options.pollMs??5000,20_000);
   // A throttled read (429) while the answer is being written is waited out; the answer is not lost.
   const conversation=await this.options.browser.read(receipt.binding.sessionId,receipt.binding.accountScope).catch((error:unknown)=>{
    if(error instanceof Error&&error.message==='CHATGPT_RATE_LIMITED')return null;throw error;});
   if(!conversation){
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,60_000);signal.addEventListener('abort',done,{once:true});});
    continue;
   }
   this.retain(conversation,receipt.binding.accountScope);
   const outcome=this.outcome(receipt,conversation);
   const messages=this.correlate(conversation,receipt.binding.accountScope).filter(message=>message.turnId===receipt.messageId);
   const fingerprint=chatgptDigest(JSON.stringify(messages));
   if(fingerprint!==last){for(const message of messages)await onMessage(message);last=fingerprint;}
   if(outcome.state==='completed'){
    const model=this.answerModel(receipt,conversation);
    if(thinking==='pro'&&!proModel(model)){
     if(!receipt.retryMessageId){
      await this.pace('retry',signal);
      await this.options.browser.send({prompt:retryAtProPrompt,binding:receipt.binding,mode:'chat',thinking:'pro',attachments:[],
       prepared:async(_accountScope,baseline)=>{receipt={...receipt,retryBaseline:baseline};this.save(receipt);},
       dispatching:async()=>{if(signal.aborted)throw new Error('CHATGPT_OBSERVATION_STOPPED');receipt={...receipt,retryPhase:'dispatched'};this.save(receipt);},
       accepted:async(_binding,messageId)=>{receipt={...receipt,retryMessageId:messageId,retryPhase:'acknowledged'};this.save(receipt);}});
      continue;
     }
     receipt={...receipt,phase:'completed',...(model?{answerModel:model}:{})};this.save(receipt);
     return {...outcome,state:'failed',text:'',error:'CHATGPT_MODEL_MISMATCH'};
    }
    const answer=messages.filter(message=>message.role==='assistant'&&message.phase==='final_answer').at(-1);
    receipt={...receipt,phase:'completed',answerId:answer?.id??null,...(model?{answerModel:model}:{})};this.save(receipt);
    const proof=`Answered by ChatGPT model ${model??'(not recorded)'}${thinking?`, asked for ${thinking}`:''}${receipt.retryMessageId?'; the first answer came from another model and was asked again at Pro automatically':''}.`;
    return {...outcome,text:proof+'\n\n'+outcome.text};
   }
   await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,pause);signal.addEventListener('abort',done,{once:true});});
  }
  throw new Error('CHATGPT_OBSERVATION_STOPPED');
 }
 private correlate(conversation:ChatgptConversation,scope:string):readonly ChatgptMessage[]{
  const receipts=[...this.receipts.values()].filter(receipt=>receipt.binding?.sessionId===conversation.id&&receipt.binding.accountScope===scope&&receipt.messageId);
  let active:Receipt|undefined;
  return projectChatgptMessages(conversation).map(message=>{
   if(message.role==='user')active=receipts.find(receipt=>receipt.messageId===message.id);
   return active?{...message,turnId:active.messageId!,...(message.role==='user'?{submissionId:active.id}:{})}:message;
  });
 }
 private outcome(receipt:Receipt,conversation:ChatgptConversation):ProviderResult{
  const binding=receipt.binding!;const base={sessionId:binding.sessionId,turnId:receipt.messageId,nativeBinding:binding};
  // After an automatic retry at Pro, the answer is the one to the retry message.
  const start=conversation.ancestry.findIndex(node=>node.id===(receipt.retryMessageId??receipt.messageId));
  if(start<0)return {...base,state:'uncertain',text:'',error:'CHATGPT_REQUEST_NOT_ON_ACTIVE_BRANCH'};
  const following=conversation.ancestry.slice(start+1);const next=following.findIndex(node=>stringField(field(node.message,'author'),'role')==='user');
  const exchange=next<0?following:following.slice(0,next);
  const final=exchange.filter(node=>stringField(field(node.message,'author'),'role')==='assistant'&&field(node.message,'end_turn')===true&&field(node.message,'status')==='finished_successfully').at(-1);
  if(!final)return {...base,state:'uncertain',text:'',error:'CHATGPT_RESULT_PENDING_OR_UNCONFIRMED'};
  const message=projectChatgptMessages(conversation).find(message=>message.id===final.id);
  // ChatGPT marks citations inline with private-use characters (U+E200 … U+E201) its page renders
  // as chips; the answer handed to an agent drops them rather than showing "filecite turn0file0".
  return {...base,state:'completed',text:(message?.content??'').replace(/[^]*/g,'').replace(/[ \t]+\n/g,'\n'),error:null};
 }
 /** The model ChatGPT recorded on the final answer of this request's exchange. */
 private answerModel(receipt:Receipt,conversation:ChatgptConversation):string|null{
  const start=conversation.ancestry.findIndex(node=>node.id===(receipt.retryMessageId??receipt.messageId));
  if(start<0)return null;
  const following=conversation.ancestry.slice(start+1);const next=following.findIndex(node=>stringField(field(node.message,'author'),'role')==='user');
  const final=(next<0?following:following.slice(0,next)).filter(node=>stringField(field(node.message,'author'),'role')==='assistant'&&field(node.message,'end_turn')===true).at(-1);
  const metadata=field(final?.message,'metadata');
  return stringField(metadata,'resolved_model_slug')??stringField(metadata,'model_slug')??null;
 }
 async reconcile(identity:ProviderRunIdentity):Promise<ProviderResult>{
  if(this.closed)throw new Error('CHATGPT_OBSERVATION_STOPPED');
  let receipt=this.receipts.get(identity.id);
  if(!receipt?.binding||receipt.binding.sessionId!==identity.sessionId||identity.turnId!==null&&receipt.messageId!==identity.turnId)throw new Error('CHATGPT_RECEIPT_UNCONFIRMED');
  if(identity.nativeBinding?.accountScope!==receipt.binding.accountScope)throw new Error('CHATGPT_ACCOUNT_MISMATCH');
  if(receipt.retryPhase==='dispatched'&&!receipt.retryMessageId){const result:ProviderResult={sessionId:receipt.binding.sessionId,turnId:receipt.messageId,nativeBinding:receipt.binding,text:'',state:'uncertain',error:'CHATGPT_PRO_RETRY_UNCONFIRMED'};this.event(identity.id,{kind:'result',result});return result;}
  const conversation=await this.options.browser.read(receipt.binding.sessionId,receipt.binding.accountScope);this.retain(conversation,receipt.binding.accountScope);
  if(!receipt.messageId){
   if(receipt.phase!=='dispatched'||!receipt.baseline)throw new Error('CHATGPT_RECEIPT_UNCONFIRMED');
   const candidates=conversation.ancestry.filter(node=>node.parent===receipt!.baseline&&stringField(field(node.message,'author'),'role')==='user'&&(chatgptDigest(chatgptMessageText(node.message))===receipt!.promptHash||chatgptDigest(chatgptMessageText(node.message).trim())===receipt!.sentHash));
   if(candidates.length!==1)throw new Error('CHATGPT_RECEIPT_UNCONFIRMED');
   receipt={...receipt,messageId:candidates[0]!.id,phase:'acknowledged',acknowledgedAt:new Date().toISOString()};this.save(receipt);
  }
  const result=this.outcome(receipt,conversation);this.event(identity.id,{kind:'result',result});return result;
 }
 async history(sessionId:string,cursor:string|null,limit:number,binding?:NativeSessionBinding):Promise<AgentHistoryPage>{
  if(!binding||binding.sessionId!==sessionId)throw new Error('CHATGPT_BINDING_REQUIRED');
  const conversation=await this.options.browser.read(sessionId,binding.accountScope);this.retain(conversation,binding.accountScope);
  const messages=this.correlate(conversation,binding.accountScope);let end=messages.length;
  if(cursor){const index=messages.findIndex(message=>message.id===cursor);if(index<0)throw new Error('CHATGPT_CURSOR_UNAVAILABLE');end=index;}
  const start=Math.max(0,end-limit);return {messages:messages.slice(start,end),nextCursor:start?messages[start]!.id:null};
 }
 async detail(sessionId:string,key:string,binding?:NativeSessionBinding):Promise<Readonly<{content:string}>>{
  if(!binding||binding.sessionId!==sessionId)throw new Error('CHATGPT_BINDING_REQUIRED');
  const conversation=await this.options.browser.read(sessionId,binding.accountScope);this.retain(conversation,binding.accountScope);
  const [nodeId,version]=key.split(':');
  if(version){
   if(!/^[a-f0-9]{64}$/.test(version))throw new Error('CHATGPT_MESSAGE_UNAVAILABLE');
   const saved:unknown=JSON.parse(readFileSync(join(this.options.directory,'message-'+chatgptDigest(JSON.stringify([binding.accountScope,sessionId,nodeId,version]))+'.json'),'utf8'));
   if(!record(saved)||saved['conversationId']!==sessionId||saved['nodeId']!==nodeId||chatgptDigest(JSON.stringify(saved['message']))!==version)throw new Error('CHATGPT_MESSAGE_UNAVAILABLE');
   return {content:JSON.stringify(saved['message'],null,2)};
  }
  const node=conversation.nodes.get(key);if(!node)throw new Error('CHATGPT_MESSAGE_UNAVAILABLE');
  return {content:JSON.stringify(node.message,null,2)};
 }
 async artifact(binding:NativeSessionBinding,messageId:string,path:string){
  const conversation=await this.options.browser.read(binding.sessionId,binding.accountScope);
  const message=projectChatgptMessages(conversation).find(message=>message.id===messageId);
  if(!message?.richContent.parts.some(part=>part.kind==='file'&&part.path===path))throw new Error('CHATGPT_ARTIFACT_UNAVAILABLE');
  const matching=message.richContent.parts.filter(part=>part.kind==='file'&&part.path.split('/').at(-1)===path.split('/').at(-1));
  if(matching.length!==1)throw new Error('CHATGPT_ARTIFACT_AMBIGUOUS');
  return this.options.browser.download(binding,messageId,path);
 }
 async close():Promise<void>{
  if(this.closing)return this.closing;
  this.closed=true;
  for(const signal of this.observations)signal.abort();
  this.closing=(async()=>{
   await Promise.race([this.options.browser.close().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,3000).unref())]);
   await Promise.allSettled([...this.inFlight]);
   this.releaseOwnerLock();
  })();
  return this.closing;
 }
}
