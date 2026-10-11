import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatgptBrowser,ChatgptSendError,ChatgptSubscription} from '../dist/index.js';

const fake={account:async()=>'',read:async()=>{throw Error('unused')},send:async()=>{},search:async()=>({accountScope:'',matches:[],complete:true}),download:async()=>({name:'',contentType:'',bytes:new Uint8Array()}),close:async()=>{}};

test('CDP accepts literal loopback only',async()=>{
 for(const endpoint of ['http://localhost:9222','http://192.0.2.1:9222','ws://example.com/devtools/browser/x','http://user:pass@127.0.0.1:9222']){
  assert.throws(()=>new ChatgptBrowser({endpoint}),/CHATGPT_BROWSER_ENDPOINT_NOT_LOOPBACK/);
 }
 const browser=new ChatgptBrowser({endpoint:'http://127.0.0.1:59996'});await browser.close();
});

test('state directory refuses symlinks and group access',()=>{
 const root=mkdtempSync(join(tmpdir(),'channel-dir-check-'));
 try{
  const privateDir=join(root,'private');mkdirSync(privateDir,{mode:0o700});
  const link=join(root,'linked');symlinkSync(privateDir,link,'dir');
  assert.throws(()=>new ChatgptSubscription({directory:link,browser:fake}),/CHATGPT_STATE_DIRECTORY_UNSAFE|EEXIST/);
  const openDir=join(root,'open');mkdirSync(openDir,{mode:0o755});chmodSync(openDir,0o755);
  assert.throws(()=>new ChatgptSubscription({directory:openDir,browser:fake}),/CHATGPT_STATE_DIRECTORY_UNSAFE/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('a stale pending symlink cannot redirect a receipt write',async()=>{
 const root=mkdtempSync(join(tmpdir(),'channel-pending-check-'));
 const target=join(root,'outside.txt');writeFileSync(target,'unchanged');
 const state=join(root,'state');mkdirSync(state,{mode:0o700});
 const owner=new ChatgptSubscription({directory:state,browser:fake});
 try{
  symlinkSync(target,join(state,'sends.json.pending'));
  owner.atomic('sends.json',{count:1});
  assert.equal(readFileSync(target,'utf8'),'unchanged');
  assert.equal(JSON.parse(readFileSync(join(state,'sends.json'),'utf8')).count,1);
 }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});

test('operator-needed recovery codes survive availability and send reporting',async()=>{
 const codes=['CHATGPT_SIGNIN_ACCOUNT_REQUIRED','CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED','CHATGPT_SIGNIN_ACCOUNT_MISMATCH','CHATGPT_SIGNIN_NEEDS_OPERATOR','CHATGPT_CHALLENGE_NEEDS_OPERATOR'];
 for(const code of codes){
  const root=mkdtempSync(join(tmpdir(),'channel-recovery-code-'));const directory=join(root,'state');mkdirSync(directory,{mode:0o700});
  const owner=new ChatgptSubscription({directory,browser:{...fake,account:async()=>{throw Error(code);}}});
  try{
   assert.deepEqual(await owner.available(),{available:false,reason:code});
   assert.equal(new ChatgptSendError('account',Error(code)).message,code);
  }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('an existing authenticated browser must match the configured account before any other read',async()=>{
 const browser=new ChatgptBrowser({endpoint:'http://127.0.0.1:59995',accountEmail:'person@example.com'});
 const originalFetch=globalThis.fetch;const calls=[];
 browser.control=async()=>({evaluate:async(callback,input)=>callback(input)});
 try{
  globalThis.fetch=async path=>{calls.push(path);return {ok:true,json:async()=>({user:{id:'user-id',email:'other@example.com'},account:{id:'account-id'},accessToken:'test-token'})};};
  await assert.rejects(browser.search('example'),/CHATGPT_SIGNIN_ACCOUNT_MISMATCH/);
  assert.deepEqual(calls,['/api/auth/session']);
  calls.length=0;
  globalThis.fetch=async path=>{calls.push(path);return {ok:true,json:async()=>({user:{id:'user-id'},account:{id:'account-id'},accessToken:'test-token'})};};
  await assert.rejects(browser.account(),/CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED/);
  assert.deepEqual(calls,['/api/auth/session']);
 }finally{globalThis.fetch=originalFetch;await browser.close();}
});
