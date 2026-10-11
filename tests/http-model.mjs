import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

test('HTTP refuses unsupported models, changed request identity, and uppercase IDs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'channel-http-model-'));const directory=join(root,'state');mkdirSync(directory,{mode:0o700});
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;probe.close();await once(probe,'close');
 const token='test-token-longer-than-twenty-four-characters';const existingId=randomUUID();
 writeFileSync(join(directory,'run-'+existingId+'.json'),JSON.stringify({version:1,id:existingId,promptHash:createHash('sha256').update('Same words').digest('hex'),requestedModel:'pro',phase:'prepared',accountScope:null,baseline:null,binding:null,messageId:null,answerId:null}),{mode:0o600});
 const legacyId=randomUUID();
 writeFileSync(join(directory,'run-'+legacyId+'.json'),JSON.stringify({version:1,id:legacyId,promptHash:createHash('sha256').update('Old words').digest('hex'),phase:'prepared',accountScope:null,baseline:null,binding:null,messageId:null,answerId:null,thinking:null}),{mode:0o600});
 const child=spawn(process.execPath,['dist/cli.js','serve','--port',String(port)],{cwd:process.cwd(),env:{...process.env,CHANNEL_BROWSER_URL:'http://127.0.0.1:59997',CHANNEL_STATE_DIR:directory,CHANNEL_TOKEN:token},stdio:['ignore','pipe','pipe']});
 try{
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('server exited: '+code);}),new Promise((_,reject)=>setTimeout(()=>reject(Error('server did not start')),3000).unref())]);
  const id=randomUUID();const response=await fetch(`http://127.0.0.1:${port}/requests`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,prompt:'Question',model:'pr0'})});
  assert.equal(response.status,400);assert.equal((await response.json()).error,'CHATGPT_MODEL_UNSUPPORTED');
  const receipt=await fetch(`http://127.0.0.1:${port}/requests/${id}`,{headers:{authorization:'Bearer '+token}});assert.equal(receipt.status,404);
  const mismatch=await fetch(`http://127.0.0.1:${port}/requests`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:existingId,prompt:'Same words',model:'chat'})});
  assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).error,'id_reuse');
  const uppercase=await fetch(`http://127.0.0.1:${port}/requests`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID().toUpperCase(),prompt:'Question',model:'pro'})});
  assert.equal(uppercase.status,400);assert.equal((await uppercase.json()).error,'invalid id');
  const legacy=await fetch(`http://127.0.0.1:${port}/requests`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:legacyId,prompt:'Old words',model:'pro'})});
  assert.equal(legacy.status,409);assert.equal((await legacy.json()).error,'id_reuse');
 }finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}rmSync(root,{recursive:true,force:true});}
});
