import {chromium} from 'playwright';
import type {Browser,BrowserContext,Page} from 'playwright';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {acquireOwnerLock} from './owner-lock.js';
import {ensurePrivateDirectory} from './private-directory.js';
import type {AgentRunRequest,NativeSessionBinding} from './ports.js';
import {chatgptAccountScope,readChatgptConversation,verifyChatgptAnchor} from './chatgpt-content.js';
import type {ChatgptConversation} from './chatgpt-content.js';
import {ChatgptSourceReadError,readChatgptInventory} from './chatgpt-inventory.js';

/** Attach to a separately owned browser or launch a persistent local profile. */
export type ChatgptBrowserOptions=Readonly<{profile?:string;executablePath?:string;headless?:boolean;endpoint?:string;accountEmail?:string;recover?:(page:Page)=>Promise<void>;diagnostic?:(event:Readonly<Record<string,unknown>>)=>void}>;
/** ChatGPT's thinking levels, in the order its composer's power slider holds them (0 to 4). */
export const chatgptThinkingLevels=['light','medium','high','extra-high','pro'] as const;
export type ChatgptThinkingLevel=typeof chatgptThinkingLevels[number];
type SendStage='account'|'conversation'|'navigation'|'composer'|'mode'|'thinking'|'attachments'|'input'|'send-button'|'binding-check'|'dispatch'|'acknowledgement';
const sendFailureCodes=new Set(['CHATGPT_BROWSER_UNAVAILABLE','CHATGPT_AUTHENTICATED_READ_UNAVAILABLE','CHATGPT_AUTH_REQUIRED','CHATGPT_SIGNIN_ACCOUNT_REQUIRED','CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED','CHATGPT_SIGNIN_ACCOUNT_MISMATCH','CHATGPT_SIGNIN_NEEDS_OPERATOR','CHATGPT_CHALLENGE_NEEDS_OPERATOR','CHATGPT_ACCOUNT_UNCONFIRMED','CHATGPT_ACCOUNT_MISMATCH','CHATGPT_RATE_LIMITED','CHATGPT_SOURCE_UNAVAILABLE','CHATGPT_READ_UNAVAILABLE','CHATGPT_CONVERSATION_INVALID','CHATGPT_CONVERSATION_MISMATCH','CHATGPT_COMPOSER_HAS_DRAFT','CHATGPT_MODE_UNCONFIRMED','CHATGPT_THINKING_UNCONFIRMED','CHATGPT_ATTACHMENT_UNCONFIRMED','CHATGPT_BRANCH_CHANGED_BEFORE_SEND','CHATGPT_SEND_AMBIGUOUS','CHATGPT_SEND_UNCONFIRMED','CHATGPT_OBSERVATION_STOPPED']);
const sendButton=/^Send(?: prompt| message)?$/i;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** A conversation's id from its address: /c/<id>, or /g/g-p-…/c/<id> for a chat inside a project. */
const conversationIn=(url:URL):string|null=>/(?:^|\/)c\/([a-zA-Z0-9-]+)$/.exec(url.pathname)?.[1]??null;
export class ChatgptSendError extends Error{
 constructor(readonly stage:SendStage,error:unknown){super(error instanceof Error&&sendFailureCodes.has(error.message)?error.message:error instanceof Error&&error.name==='TimeoutError'?'CHATGPT_BROWSER_TIMEOUT':'CHATGPT_BROWSER_OPERATION_FAILED');}
}
export interface ChatgptBrowserPort {
 account():Promise<string>;
 read(sessionId:string,accountScope:string):Promise<ChatgptConversation>;
 search(query:string):Promise<Readonly<{accountScope:string;matches:readonly Readonly<{sessionId:string;messageId:string|null}>[];complete:boolean}>>;
 send(input:Readonly<{prompt:string;binding:NativeSessionBinding|null;mode:'chat'|'work';thinking?:ChatgptThinkingLevel|null;project?:string|null;attachments:NonNullable<AgentRunRequest['attachments']>;
  prepared:(accountScope:string,baseline:string|null)=>Promise<void>;dispatching:()=>Promise<void>;accepted:(binding:NativeSessionBinding,messageId:string)=>Promise<void>}>):Promise<void>;
 download(binding:NativeSessionBinding,messageId:string,path:string):Promise<Readonly<{name:string;contentType:string;bytes:Uint8Array}>>;
 close():Promise<void>;
}
export class ChatgptBrowser implements ChatgptBrowserPort {
 private readonly releaseOwnerLock:()=>void;
 private browserContext:Promise<BrowserContext>|undefined;
 private attached:Browser|undefined;
 private observer:Promise<Page>|undefined;
 private uiTail:Promise<void>=Promise.resolve();
 private recovering:Promise<void>|undefined;
 /** Tabs of sends that failed after dispatch, kept for inspection; only the newest three stay open. */
 private kept:Page[]=[];
 /** Set by close(): waits for ChatGPT's throttle end at once so a stop is never held by them. */
 private closing=false;
 private wakeClosing=new Set<()=>void>();
 private pauseUnlessClosing(ms:number):Promise<void>{
  return new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.wakeClosing.delete(done);resolve();};const timer=setTimeout(done,ms);this.wakeClosing.add(done);});
 }
 constructor(private readonly options:ChatgptBrowserOptions){
  if(!options.endpoint&&!options.profile)throw new Error('CHATGPT_BROWSER_UNCONFIGURED');
  let endpoint=options.endpoint;
  if(endpoint){
   let url:URL;try{url=new URL(endpoint);}catch{throw new Error('CHATGPT_BROWSER_ENDPOINT_NOT_LOOPBACK');}
   if(!['http:','ws:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error('CHATGPT_BROWSER_ENDPOINT_NOT_LOOPBACK');
   endpoint=url.href;
  }
  if(!endpoint)ensurePrivateDirectory(options.profile!);
  const identity=endpoint?'endpoint:'+endpoint:'profile:'+resolve(options.profile!);
  const directory=join(homedir(),'.cache','chatgpt-browser-channel','locks');ensurePrivateDirectory(directory);
  this.releaseOwnerLock=acquireOwnerLock(join(directory,createHash('sha256').update(identity).digest('hex')+'.lock'),'CHATGPT_BROWSER_OWNER_BUSY');
 }
 private browser():Promise<BrowserContext>{
  if(!this.browserContext)this.browserContext=(this.options.endpoint?this.attach(this.options.endpoint):chromium.launchPersistentContext(this.options.profile!,{headless:this.options.headless??false,
   ...(this.options.executablePath?{executablePath:this.options.executablePath}:{}),acceptDownloads:true,chromiumSandbox:true})).then(context=>{context.setDefaultTimeout(30_000);return context;}).catch(()=>{this.browserContext=undefined;throw new Error('CHATGPT_BROWSER_UNAVAILABLE');});
  return this.browserContext;
 }
 private async attach(endpoint:string):Promise<BrowserContext>{
  const browser=await chromium.connectOverCDP(endpoint);
  // The host restarts its Chrome on its own; forget the old connection so the next call reattaches.
  browser.on('disconnected',()=>{if(this.attached===browser){this.attached=undefined;this.browserContext=undefined;this.observer=undefined;}});
  this.attached=browser;
  const context=browser.contexts()[0];
  if(!context)throw new Error('CHATGPT_BROWSER_UNAVAILABLE');
  return context;
 }
 private control():Promise<Page>{
  if(!this.observer)this.observer=this.browser().then(async context=>{const page=await context.newPage();await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded'});return page;}).catch(()=>{this.observer=undefined;throw new Error('CHATGPT_BROWSER_UNAVAILABLE');});
  return this.observer;
 }
 private ready():Promise<void>{
  if(!this.options.recover)return Promise.reject(new Error('CHATGPT_AUTH_REQUIRED'));
  if(!this.recovering)this.recovering=this.browser().then(async context=>{
   const page=await context.newPage();
   try{
    await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded'});
    await this.options.recover!(page);
    const signedIn=await page.evaluate(async()=>{
     const response=await fetch('/api/auth/session',{credentials:'include'}).catch(()=>null);
     if(!response?.ok)return false;
     const session=await response.json().catch(()=>null) as {accessToken?:string}|null;
     return !!session?.accessToken;
    }).catch(()=>false);
    if(!signedIn)throw new Error('CHATGPT_AUTH_REQUIRED');
   }finally{await page.close().catch(()=>{});}
  }).finally(()=>{this.recovering=undefined;});
  return this.recovering;
 }
 private note(event:Readonly<Record<string,unknown>>):void{try{this.options.diagnostic?.(event);}catch{}}
 private async request(path:string,scope?:string):Promise<Readonly<{accountScope:string;data:unknown}>>{
  const read=async()=>(await this.control()).evaluate(async ({path,accountEmail})=>{
   const session=await fetch('/api/auth/session',{credentials:'include'});if(!session.ok)return {error:'CHATGPT_AUTH_REQUIRED'};
   const auth=await session.json() as {user?:{id?:string;email?:string};account?:{id?:string};accessToken?:string};
   if(!auth.user?.id||!auth.account?.id||!auth.accessToken)return {error:'CHATGPT_AUTH_REQUIRED'};
   if(accountEmail){
    if(!auth.user.email)return {error:'CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED'};
    if(auth.user.email.toLowerCase()!==accountEmail.toLowerCase())return {error:'CHATGPT_SIGNIN_ACCOUNT_MISMATCH'};
   }
   const response=path?await fetch(path,{credentials:'include',headers:{Authorization:'Bearer '+auth.accessToken,'ChatGPT-Account-Id':auth.account.id}}):null;
   if(response&&!response.ok)return {error:response.status===429?'CHATGPT_RATE_LIMITED':response.status===401||response.status===403?'CHATGPT_AUTH_REQUIRED':response.status===404?'CHATGPT_SOURCE_UNAVAILABLE':'CHATGPT_READ_UNAVAILABLE'};
   return {userId:auth.user.id,accountId:auth.account.id,data:response?await response.json():null};
  },{path,accountEmail:this.options.accountEmail}).catch(()=>({error:'CHATGPT_AUTHENTICATED_READ_UNAVAILABLE'} as {error:string;userId?:string;accountId?:string;data?:unknown}));
  let response=await read();
  if(response.error==='CHATGPT_AUTH_REQUIRED'||response.error==='CHATGPT_AUTHENTICATED_READ_UNAVAILABLE'){
   await this.ready();
   // The reading tab may have been redirected or detached while the repair ran; start a fresh one.
   const stale=this.observer;this.observer=undefined;await (await stale?.catch(()=>null))?.close().catch(()=>{});
   response=await read();
  }
  // ChatGPT answers 429 when it is read too often (several agents at once, or long waits). Every
  // read waits that out here, 15 s doubling to two minutes, about four minutes in all, so no caller
  // fails a send over a throttle.
  for(let pause=15_000;response.error==='CHATGPT_RATE_LIMITED'&&pause<=120_000&&!this.closing;pause*=2){
   this.note({event:'chatgpt_rate_limited',pause_ms:pause});
   await this.pauseUnlessClosing(pause);if(this.closing)break;response=await read();
  }
  if(response.error)throw new Error(response.error);
  if(!response.userId||!response.accountId)throw new Error('CHATGPT_ACCOUNT_UNCONFIRMED');
  const accountScope=chatgptAccountScope(response.userId,response.accountId);
  if(scope&&scope!==accountScope)throw new Error('CHATGPT_ACCOUNT_MISMATCH');
  return {accountScope,data:response.data};
 }
 async account():Promise<string>{return (await this.request('')).accountScope;}
 async inventory(scope:string,archived:boolean,offset:number){
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('CHATGPT_INVENTORY_CURSOR_INVALID');
  const limit=100;
  const response=await this.request('/backend-api/conversations?offset='+offset+'&limit='+limit+'&order=updated&is_archived='+archived,scope);
  return readChatgptInventory(response.data,offset,limit);
 }
 async read(sessionId:string,accountScope:string):Promise<ChatgptConversation>{
  if(!/^[a-zA-Z0-9-]+$/.test(sessionId))throw new Error('CHATGPT_CONVERSATION_INVALID');
  const response=await this.request('/backend-api/conversation/'+sessionId,accountScope);
  try{return readChatgptConversation(response.data,sessionId);}catch{throw new ChatgptSourceReadError('CHATGPT_CONVERSATION_INVALID',response.data);}
 }
 async search(query:string){
  const response=await this.request('/backend-api/conversations/search?query='+encodeURIComponent(query));
  const data=response.data as {items?:{conversation_id?:string;payload?:{message_id?:string}}[];cursor?:unknown};
  if(!Array.isArray(data.items))throw new Error('CHATGPT_SEARCH_UNAVAILABLE');
  const matches=data.items.map(value=>{if(typeof value.conversation_id!=='string')throw new Error('CHATGPT_SEARCH_IDENTITY_MISSING');return {sessionId:value.conversation_id,messageId:value.payload?.message_id??null};});
  return {accountScope:response.accountScope,matches,complete:data.cursor===null};
 }
 private async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  const previous=this.uiTail;let release!:()=>void;this.uiTail=new Promise(resolve=>{release=resolve;});
  await previous;try{return await work();}finally{release();}
 }
 /** Moves the composer's power slider to the asked level and reads back what ChatGPT selected. */
 private async setThinking(page:Page,level:ChatgptThinkingLevel):Promise<void>{
  const target=chatgptThinkingLevels.indexOf(level);
  const picker=page.getByRole('button',{name:'Select ChatGPT model'});
  await picker.click();
  const slider=page.locator('[data-reasoning-slider=true]');await slider.waitFor({state:'visible'});await slider.focus();
  // A missing position must never read as 0 and incorrectly confirm Light.
  const current=async()=>{const value=await page.locator('[data-reasoning-slider=true] [role=slider]').getAttribute('aria-valuenow');
   if(value===null||!/^[0-4]$/.test(value))throw new Error('CHATGPT_THINKING_UNCONFIRMED');return Number(value);};
  for(let step=0;step<8;step++){
   const now=await current();if(now===target)break;
   await page.keyboard.press(now<target?'ArrowRight':'ArrowLeft');await sleep(250);
  }
  const reached=await current();
  await page.keyboard.press('Escape');
  if(reached!==target)throw new Error('CHATGPT_THINKING_UNCONFIRMED');
 }
 async send(input:Parameters<ChatgptBrowserPort['send']>[0]):Promise<void>{
  let stage:SendStage='account';
  return this.exclusive(async()=>{
   const scope=await this.account();if(input.binding&&scope!==input.binding.accountScope)throw new Error('CHATGPT_ACCOUNT_MISMATCH');
   stage='conversation';
   const before=input.binding?await this.read(input.binding.sessionId,scope):null;
   if(before&&input.binding?.anchor)verifyChatgptAnchor(before,input.binding.anchor);
   const context=await this.browser();const page=await context.newPage();
   // Keep a dispatched page available for manual inspection if acknowledgement fails.
   let dispatched=false;
   try{
    stage='navigation';
    let target=input.binding?'https://chatgpt.com/c/'+input.binding.sessionId:'https://chatgpt.com/';
    await page.goto(target,{waitUntil:'domcontentloaded'});
    if(await page.getByRole('button',{name:'Log in'}).isVisible().catch(()=>false)){
     await this.ready();await page.goto(target,{waitUntil:'domcontentloaded'});
    }
    // Agent chats may open inside a configured ChatGPT project, keeping other chats easy to find in the
    // ChatGPT app. A missing project falls back to an ordinary chat.
    if(!input.binding&&input.project){
     // The project's own page (https://chatgpt.com/g/g-p-…/project) starts a chat inside it.
     if(/^https:\/\/chatgpt\.com\/g\/g-p-[a-z0-9]+\/project$/.test(input.project)){target=input.project;await page.goto(target,{waitUntil:'domcontentloaded'});}
     else this.note({event:'chatgpt_project_missing'});
    }
    // ChatGPT shows "Could not load this ChatGPT conversation" when it is throttling reads; wait and reload.
    for(let pause=30_000;pause<=120_000&&await page.getByText('Could not load this ChatGPT conversation').isVisible().catch(()=>false);pause*=2){
     this.note({event:'chatgpt_rate_limited',pause_ms:pause,where:'page'});await sleep(pause);await page.goto(target,{waitUntil:'domcontentloaded'});await sleep(3000);
    }
    stage='composer';
    const composer=page.getByRole('textbox',{name:/^(Ask ChatGPT|New chat in .+|Ask anything)$/}).or(page.locator('#prompt-textarea')).first();await composer.waitFor({state:'visible'});
    if(input.binding&&conversationIn(new URL(page.url()))!==input.binding.sessionId)throw new Error('CHATGPT_CONVERSATION_MISMATCH');
    // ChatGPT keeps an unsent new-chat draft (text and files) between visits. Only agents use this
    // browser, so a draft in a new chat may be left from an interrupted send and is cleared.
    // A draft inside an existing conversation still refuses.
    const leftovers=page.getByRole('button',{name:/^Remove /});
    if(!input.binding){
     for(let file=await leftovers.count();file>0;file--)await leftovers.first().click().catch(()=>{});
     if((await composer.innerText()).trim()){await composer.click();await page.keyboard.press('Control+A');await page.keyboard.press('Delete');}
    }
    if((await composer.innerText()).trim()||await leftovers.count())throw new Error('CHATGPT_COMPOSER_HAS_DRAFT');
    stage='mode';
    if(!input.binding){
     const mode=page.getByRole('button',{name:input.mode==='work'?'Work':'Chat',exact:true}).first();
     if(await mode.getAttribute('aria-pressed')!=='true')await mode.click();
     if(await mode.getAttribute('aria-pressed')!=='true')throw new Error('CHATGPT_MODE_UNCONFIRMED');
    }
    stage='thinking';
    if(input.thinking)await this.setThinking(page,input.thinking);
    stage='attachments';
    if(input.attachments.length){
     const removals=page.getByRole('button',{name:/^Remove /});const before=await removals.count();
     await page.locator('input[type=file]:not([accept])').first().setInputFiles(input.attachments.map(value=>value.path));
     await removals.nth(before+input.attachments.length-1).waitFor({state:'visible',timeout:120_000}).catch(()=>{throw new Error('CHATGPT_ATTACHMENT_UNCONFIRMED');});
    }
    stage='input';
    // ChatGPT stores a message without its surrounding whitespace, so that is what is typed and matched.
    await composer.click();await page.keyboard.insertText(input.prompt.trim());
    stage='send-button';
    const send=page.getByRole('button',{name:sendButton});await send.waitFor({state:'visible'});
    // Uploads finish before ChatGPT enables Send; a large file can take a while.
    const uploaded=Date.now()+300_000;while(await send.isDisabled()&&Date.now()<uploaded)await sleep(1000);
    if(await send.isDisabled())throw new Error('CHATGPT_ATTACHMENT_UNCONFIRMED');
    stage='binding-check';
    if(await this.account()!==scope)throw new Error('CHATGPT_ACCOUNT_MISMATCH');
    if(before){const current=await this.read(before.id,scope);if(current.currentNode!==before.currentNode)throw new Error('CHATGPT_BRANCH_CHANGED_BEFORE_SEND');if(input.binding?.anchor)verifyChatgptAnchor(current,input.binding.anchor);}
    await input.prepared(scope,before?.currentNode??null);
    stage='dispatch';
    await input.dispatching();dispatched=true;
    await send.click();
    stage='acknowledgement';
    await page.waitForURL(url=>conversationIn(url)!==null,{timeout:60_000});
    const sessionId=conversationIn(new URL(page.url()))!;if(input.binding&&sessionId!==input.binding.sessionId)throw new Error('CHATGPT_CONVERSATION_MISMATCH');
    const binding:NativeSessionBinding=input.binding??{accountScope:scope,sessionId};
    // ChatGPT throttles conversation reads (429) when several agents use it; a throttle while
    // confirming a send is waited out, rather than immediately reported as unconfirmed.
    const deadline=Date.now()+300_000;let pause=2000;
    while(Date.now()<deadline){
     const after=await this.read(sessionId,scope).catch((error:unknown)=>{if(error instanceof Error&&error.message==='CHATGPT_RATE_LIMITED')return null;throw error;});
     if(!after){pause=Math.min(pause*2,60_000);await page.waitForTimeout(pause);continue;}
     pause=2000;
     const newMessages=after.ancestry.filter(node=>node.message?.['author']&&!(before?.nodes.has(node.id))&&(!before||node.parent===before.currentNode));
     const candidates=newMessages.filter(node=>{
      const author=node.message!['author'] as {role?:string};const content=node.message!['content'] as {parts?:unknown[]};
      return author.role==='user'&&content.parts?.filter(part=>typeof part==='string').join('\n').trim()===input.prompt.trim();
     });
     if(candidates.length>1)throw new Error('CHATGPT_SEND_AMBIGUOUS');
     if(candidates.length===1){await input.accepted(binding,candidates[0]!.id);await page.close().catch(()=>{});return;}
     await page.waitForTimeout(pause);
    }
    throw new Error('CHATGPT_SEND_UNCONFIRMED');
   }catch(error){
    if(!dispatched)await page.close();
    else{this.kept.push(page);while(this.kept.length>3)await this.kept.shift()!.close().catch(()=>{});}
    throw error;
   }
  }).catch(error=>{throw new ChatgptSendError(stage,error);});
 }
 async download(binding:NativeSessionBinding,messageId:string,path:string):Promise<Readonly<{name:string;contentType:string;bytes:Uint8Array}>>{
  return this.exclusive(async()=>{
   await this.read(binding.sessionId,binding.accountScope);
   const context=await this.browser();const page=await context.newPage();
   try{
    await page.goto('https://chatgpt.com/c/'+binding.sessionId,{waitUntil:'domcontentloaded'});
    if(!/^[a-zA-Z0-9-]+$/.test(messageId))throw new Error('CHATGPT_MESSAGE_INVALID');
    const exact=page.locator('[data-message-id="'+messageId+'"]');
    await exact.waitFor({state:'visible'});await exact.scrollIntoViewIfNeeded();
    const turn=exact.locator('xpath=ancestor::*[@data-conversation-screenshot-content]');
    const file=turn.getByRole('button',{name:path.split('/').at(-1)!,exact:true});
    await file.waitFor({state:'visible'});await file.hover();
    const target=file.locator('..').getByRole('button',{name:'Download file',exact:true});
    await target.waitFor({state:'visible'});
    if(await this.account()!==binding.accountScope)throw new Error('CHATGPT_ACCOUNT_MISMATCH');
    const [download]=await Promise.all([page.waitForEvent('download'),target.click()]);
    const stream=await download.createReadStream();if(!stream)throw new Error('CHATGPT_DOWNLOAD_FAILED');
    const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));
    return {name:download.suggestedFilename(),contentType:'application/octet-stream',bytes:Buffer.concat(chunks)};
   }finally{await page.close();}
  });
 }
 async close():Promise<void>{
  this.closing=true;for(const wake of [...this.wakeClosing])wake();
  // An attached browser belongs to the host: close only this process's tab and let go of it.
  if(this.attached){const observer=this.observer;this.observer=undefined;if(observer)await (await observer.catch(()=>null))?.close().catch(()=>{});await this.attached.close().catch(()=>{});this.attached=undefined;this.browserContext=undefined;this.releaseOwnerLock();return;}
  if(this.browserContext)await(await this.browserContext).close();this.browserContext=undefined;this.observer=undefined;
  this.releaseOwnerLock();
 }
}
