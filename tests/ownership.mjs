import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {ChatgptBrowser,ChatgptSubscription} from '../dist/index.js';

test('one owner per browser and state directory',async()=>{
 const endpoint='http://127.0.0.1:59998';
 const browser=new ChatgptBrowser({endpoint});
 const directory=mkdtempSync(join(tmpdir(),'channel-check-'));
 const fake={account:async()=>'',read:async()=>{throw Error('unused')},send:async()=>{},search:async()=>({accountScope:'',matches:[],complete:true}),download:async()=>({name:'',contentType:'',bytes:new Uint8Array()}),close:async()=>{}};
 try{
  assert.throws(()=>new ChatgptBrowser({endpoint}),/CHATGPT_BROWSER_OWNER_BUSY/);
  const owner=new ChatgptSubscription({directory,browser:fake});
  try{assert.throws(()=>new ChatgptSubscription({directory,browser:fake}),/CHATGPT_OWNER_BUSY/);}
  finally{await owner.close();}
 }finally{await browser.close();rmSync(directory,{recursive:true,force:true});}
 const next=new ChatgptBrowser({endpoint});await next.close();
});

test('a forced process kill releases both ownership locks',async()=>{
 const endpoint='http://127.0.0.1:59997';
 const directory=mkdtempSync(join(tmpdir(),'channel-crash-check-'));
 const child=spawn(process.execPath,['tests/lock-child.mjs',endpoint,directory],{stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{
   let output='';child.stdout.setEncoding('utf8');
   child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('ready\n'))resolve();});
   child.once('exit',code=>reject(new Error('child exited before ready: '+code)));
  });
  assert.throws(()=>new ChatgptBrowser({endpoint}),/CHATGPT_BROWSER_OWNER_BUSY/);
  const fake={account:async()=>'',read:async()=>{throw Error('unused')},send:async()=>{},search:async()=>({accountScope:'',matches:[],complete:true}),download:async()=>({name:'',contentType:'',bytes:new Uint8Array()}),close:async()=>{}};
  assert.throws(()=>new ChatgptSubscription({directory,browser:fake}),/CHATGPT_OWNER_BUSY/);
  const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;
  const browser=new ChatgptBrowser({endpoint});const subscription=new ChatgptSubscription({directory,browser:fake});
  await subscription.close();await browser.close();
 }finally{if(child.exitCode===null)child.kill('SIGKILL');rmSync(directory,{recursive:true,force:true});}
});
