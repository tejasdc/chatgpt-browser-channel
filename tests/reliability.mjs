import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ChatgptRefresh,ChatgptSubscription,readChatgptConversation} from '../dist/index.js';

const browser={account:async()=>'',read:async()=>{throw Error('unexpected read')},send:async()=>{throw Error('unexpected send')},search:async()=>({accountScope:'',matches:[],complete:true}),download:async()=>({name:'',contentType:'',bytes:new Uint8Array()}),close:async()=>{}};
const scratch=()=>{const root=mkdtempSync(join(tmpdir(),'channel-reliability-'));const directory=join(root,'state');mkdirSync(directory,{mode:0o700});return {root,directory};};

test('an unacknowledged Pro retry is uncertain after restart and never sent again',async()=>{
 const {root,directory}=scratch();const id=randomUUID();let sends=0,reads=0;
 const binding={accountScope:'chatgpt:'+'a'.repeat(64),sessionId:'conversation',anchor:null};
 writeFileSync(join(directory,'run-'+id+'.json'),JSON.stringify({version:1,id,promptHash:'a'.repeat(64),phase:'acknowledged',accountScope:binding.accountScope,baseline:null,binding,messageId:'first-message',answerId:null,thinking:'pro',retryPhase:'dispatched'}),{mode:0o600});
 const owner=new ChatgptSubscription({directory,browser:{...browser,send:async()=>{sends++;},read:async()=>{reads++;throw Error('unexpected read')}}});
 try{
  for(let i=0;i<20&&!owner.effect(id)?.result;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(owner.effect(id)?.result?.state,'uncertain');
  assert.equal(owner.effect(id)?.result?.error,'CHATGPT_PRO_RETRY_UNCONFIRMED');
  assert.equal(sends,0);assert.equal(reads,0);
 }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('a completed receipt without its result event recovers the answer without another send',async()=>{
 const {root,directory}=scratch();const id=randomUUID();let sends=0,reads=0;
 const binding={accountScope:'chatgpt:'+'a'.repeat(64),sessionId:'conversation'};
 const raw={conversation_id:'conversation',current_node:'answer',mapping:{
  question:{parent:null,message:{author:{role:'user'},content:{content_type:'text',parts:['Question']}}},
  answer:{parent:'question',message:{author:{role:'assistant'},content:{content_type:'text',parts:['Recovered answer']},end_turn:true,status:'finished_successfully',metadata:{model_slug:'gpt-test'}}}
 }};
 const conversation=readChatgptConversation(raw,'conversation');
 writeFileSync(join(directory,'run-'+id+'.json'),JSON.stringify({version:1,id,promptHash:'a'.repeat(64),phase:'completed',accountScope:binding.accountScope,baseline:null,binding,messageId:'question',answerId:'answer',thinking:null}),{mode:0o600});
 const owner=new ChatgptSubscription({directory,browser:{...browser,send:async()=>{sends++;},read:async()=>{reads++;return conversation}}});
 try{
  for(let i=0;i<40&&!owner.effect(id)?.result;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(owner.effect(id)?.result?.state,'completed');
  assert.match(owner.effect(id)?.result?.text??'',/Recovered answer/);
  assert.equal(sends,0);assert.equal(reads,1);
 }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('repeating an acknowledged Pro request joins verified answer recovery',async()=>{
 const {root,directory}=scratch();const id=randomUUID();let sends=0;
 const binding={accountScope:'chatgpt:'+'a'.repeat(64),sessionId:'conversation'};
 const raw={conversation_id:'conversation',current_node:'answer',mapping:{
  question:{parent:null,message:{author:{role:'user'},content:{content_type:'text',parts:['Question']}}},
  answer:{parent:'question',message:{author:{role:'assistant'},content:{content_type:'text',parts:['Verified answer']},end_turn:true,status:'finished_successfully',metadata:{resolved_model_slug:'gpt-6-pro'}}}
 }};
 writeFileSync(join(directory,'run-'+id+'.json'),JSON.stringify({version:1,id,promptHash:createHash('sha256').update('Question').digest('hex'),requestedModel:'pro',phase:'acknowledged',accountScope:binding.accountScope,baseline:null,binding,messageId:'question',answerId:null,thinking:'pro'}),{mode:0o600});
 const owner=new ChatgptSubscription({directory,browser:{...browser,send:async()=>{sends++;},read:async()=>readChatgptConversation(raw,'conversation')}});
 try{
  const execution=await owner.start({id,purpose:'chat',sessionId:null,prompt:'Question',model:'pro',onEvent:async()=>{}});
  const result=await execution.result;
  assert.equal(result.state,'completed');
  assert.match(result.text,/Answered by ChatGPT model gpt-6-pro/);
  assert.equal(sends,0);
 }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('uppercase request IDs are refused before a receipt can be written',async()=>{
 const {root,directory}=scratch();const owner=new ChatgptSubscription({directory,browser});
 try{
  await assert.rejects(owner.start({id:randomUUID().toUpperCase(),purpose:'chat',sessionId:null,prompt:'Question',model:'pro',onEvent:async()=>{}}),/INVALID_OPERATION/);
  assert.deepEqual(readdirSync(directory).filter(name=>name.startsWith('run-')),[]);
 }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('a repeated ID joins the active send and receives the verified Pro result',async()=>{
 const {root,directory}=scratch();const id=randomUUID();let sends=0,release,entered;
 const gate=new Promise(resolve=>{release=resolve;});const sending=new Promise(resolve=>{entered=resolve;});
 const binding={accountScope:'chatgpt:'+'a'.repeat(64),sessionId:'conversation'};
 const raw={conversation_id:'conversation',current_node:'answer',mapping:{
  question:{parent:null,message:{author:{role:'user'},content:{content_type:'text',parts:['Question']}}},
  answer:{parent:'question',message:{author:{role:'assistant'},content:{content_type:'text',parts:['Verified answer']},end_turn:true,status:'finished_successfully',metadata:{resolved_model_slug:'gpt-6-pro'}}}
 }};
 const owner=new ChatgptSubscription({directory,browser:{...browser,read:async()=>readChatgptConversation(raw,'conversation'),send:async({prepared,dispatching,accepted})=>{
  sends++;entered();await gate;await prepared(binding.accountScope,null);await dispatching();await accepted(binding,'question');
 }}});
 try{
  const input={id,purpose:'chat',sessionId:null,prompt:'Question',model:'pro',onEvent:async()=>{}};
  const first=await owner.start(input);await sending;
  const repeated=await owner.start(input);release();
  const results=await Promise.all([first.result,repeated.result]);
  assert.deepEqual(results.map(result=>result.state),['completed','completed']);
  assert.ok(results.every(result=>/Answered by ChatGPT model gpt-6-pro/.test(result.text)));
  assert.equal(sends,1);
 }finally{release?.();await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('unsupported models are refused before any receipt or browser dispatch',async()=>{
 const {root,directory}=scratch();let sends=0;
 const owner=new ChatgptSubscription({directory,browser:{...browser,send:async()=>{sends++;}}});
 try{
  await assert.rejects(owner.start({id:randomUUID(),purpose:'chat',sessionId:null,prompt:'Question',model:'pr0',onEvent:async()=>{}}),/CHATGPT_MODEL_UNSUPPORTED/);
  assert.equal(sends,0);
  assert.deepEqual(readdirSync(directory).filter(name=>name.startsWith('run-')),[]);
 }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('a request ID cannot be reused with a different supported model',async()=>{
 const {root,directory}=scratch();const id=randomUUID();
 writeFileSync(join(directory,'run-'+id+'.json'),JSON.stringify({version:1,id,promptHash:createHash('sha256').update('Question').digest('hex'),requestedModel:'pro',phase:'prepared',accountScope:null,baseline:null,binding:null,messageId:null,answerId:null}),{mode:0o600});
 const owner=new ChatgptSubscription({directory,browser});
 try{await assert.rejects(owner.start({id,purpose:'chat',sessionId:null,prompt:'Question',model:'chat',onEvent:async()=>{}}),/ID_REUSE/);}
 finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('a legacy receipt without model identity cannot be submitted again',async()=>{
 const {root,directory}=scratch();const id=randomUUID();
 writeFileSync(join(directory,'run-'+id+'.json'),JSON.stringify({version:1,id,promptHash:createHash('sha256').update('Question').digest('hex'),phase:'prepared',accountScope:null,baseline:null,binding:null,messageId:null,answerId:null,thinking:null}),{mode:0o600});
 const owner=new ChatgptSubscription({directory,browser});
 try{await assert.rejects(owner.start({id,purpose:'chat',sessionId:null,prompt:'Question',model:'pro',onEvent:async()=>{}}),/ID_REUSE/);}
 finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('history ownership lasts until refresh closes',async()=>{
 const {root,directory}=scratch();const options={directory,browser,sources:{import:async()=>[]}};
 const first=new ChatgptRefresh(options);
 try{assert.throws(()=>new ChatgptRefresh(options),/CHATGPT_HISTORY_OWNER_BUSY/);}
 finally{await first.close();}
 const next=new ChatgptRefresh(options);await next.close();rmSync(root,{recursive:true,force:true});
});

test('subscription close retains ownership until an active send settles',async()=>{
 const {root,directory}=scratch();let release,entered;
 const sendGate=new Promise(resolve=>{release=resolve;});
 const sendEntered=new Promise(resolve=>{entered=resolve;});
 const owner=new ChatgptSubscription({directory,browser:{...browser,send:async()=>{entered();await sendGate;throw Error('send ended')}}});
 const id=randomUUID();const execution=await owner.start({id,purpose:'chat',prompt:'test',model:'chat',onEvent:async()=>{}});
 execution.result.catch(()=>{});
 await sendEntered;
 const closing=owner.close();
 assert.throws(()=>new ChatgptSubscription({directory,browser}),/CHATGPT_OWNER_BUSY/);
 release();await closing;
 const next=new ChatgptSubscription({directory,browser});await next.close();rmSync(root,{recursive:true,force:true});
});
