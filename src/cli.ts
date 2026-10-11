#!/usr/bin/env node
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {ChatgptBrowser} from './chatgpt-browser.js';
import {ChatgptSubscription} from './chatgpt-subscription.js';
import {createGoogleSignInRecovery} from './signin-recovery.js';
const MAX_PENDING_REQUESTS=6;

const help=`chatgpt-browser-channel <status|ask|receipt|serve> [options]

  status                 Check whether the signed-in browser is available.
  ask [--id UUID]        Read a prompt from stdin and await its answer.
      [--model pro]      Select chat, work, light, medium, high, extra-high, or pro.
      [--file PATH]      Attach a local file. Repeat for multiple files.
  receipt --id UUID      Read a durable request receipt without contacting ChatGPT.
  serve                  Start a loopback HTTP interface (requires CHANNEL_TOKEN).
      [--port 8788]     POST /requests, GET /requests/:id, GET /health.
  --json                 Print machine-readable JSON for status or ask.

Set CHANNEL_BROWSER_URL to a loopback Chrome debugging endpoint or
CHANNEL_PROFILE to a private browser profile, and CHANNEL_STATE_DIR to a private
state directory. A saved Google session is reused when possible; set
CHANNEL_GOOGLE_ACCOUNT_EMAIL privately to select its account. Passwords,
second factors, and protective challenges need an operator. Exit codes: 0 success,
1 operation failed, 64 invalid usage.
`;
const args=process.argv.slice(2);
const command=args.shift();
if(!command||command==='--help'||command==='help'){process.stdout.write(help);process.exit(0);}
function value(name:string):string|undefined{const index=args.indexOf(name);if(index<0)return undefined;const result=args[index+1];if(!result||result.startsWith('--'))throw new Error('Missing value for '+name);args.splice(index,2);return result;}
function flag(name:string):boolean{const index=args.indexOf(name);if(index<0)return false;args.splice(index,1);return true;}
async function main():Promise<void>{
 const json=flag('--json'),id=value('--id'),model=value('--model')??'chat',port=Number(value('--port')??'8788');
 const files:string[]=[];for(let file=value('--file');file;file=value('--file'))files.push(resolve(file));
 if(args.length)throw new Error('Unknown option: '+args[0]);
 const endpoint=process.env['CHANNEL_BROWSER_URL'],profile=process.env['CHANNEL_PROFILE'],directory=process.env['CHANNEL_STATE_DIR'];
 if(!directory)throw new Error('Set CHANNEL_STATE_DIR to a private directory.');
 if(!endpoint&&!profile)throw new Error('Set CHANNEL_BROWSER_URL or CHANNEL_PROFILE.');
 const accountEmail=process.env['CHANNEL_GOOGLE_ACCOUNT_EMAIL'];
 const recover=createGoogleSignInRecovery({accountEmail,diagnostic:event=>process.stderr.write(JSON.stringify(event)+'\n')});
 const browser=new ChatgptBrowser(endpoint?{endpoint,accountEmail,recover}:{profile,accountEmail,recover});
 const subscription=new ChatgptSubscription({directory,browser});
 try{
  if(command==='status'){
   const status=await subscription.available();process.stdout.write(json?JSON.stringify(status)+'\n':status.available?'Available\n':'Unavailable: '+status.reason+'\n');if(!status.available)process.exitCode=1;
  }else if(command==='receipt'){
   if(!id)throw new Error('receipt requires --id');const receipt=subscription.effect(id);if(!receipt)throw new Error('Unknown request ID');process.stdout.write(JSON.stringify(receipt)+'\n');
  }else if(command==='ask'){
   const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));const prompt=Buffer.concat(chunks).toString('utf8');if(!prompt.trim())throw new Error('Prompt is empty');
   const requestId=id??randomUUID();const execution=await subscription.start({id:requestId,prompt,purpose:'chat',sessionId:null,model,attachments:files.map(path=>({path,name:path.split('/').at(-1)!,contentType:'application/octet-stream'})),onEvent:async()=>{}});
   const result=await execution.result;process.stdout.write(json?JSON.stringify({id:requestId,...result})+'\n':result.text+'\n');if(result.state!=='completed')process.exitCode=1;
  }else if(command==='serve'){
   const token=process.env['CHANNEL_TOKEN'];if(!token||token.length<24)throw new Error('Set CHANNEL_TOKEN to a private random token of at least 24 characters.');
   if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Invalid port');
   const server=createServer(async(req,res)=>{
    const respond=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    const view=(requestId:string)=>{const receipt=subscription.effect(requestId);if(!receipt)return null;return {id:requestId,state:receipt.state,terminal:!['recorded','running'].includes(receipt.state),acknowledgedAt:receipt.acknowledgedAt,error:receipt.error,result:receipt.result};};
    if(req.headers.authorization!==`Bearer ${token}`){respond(401,{error:'unauthorized'});return;}
    try{
     if(req.method==='GET'&&req.url==='/health'){respond(200,{...await subscription.available(),pending:subscription.pendingCount(),pendingLimit:MAX_PENDING_REQUESTS});return;}
     const match=/^\/requests\/([a-f0-9-]{36})$/.exec(req.url??'');
     if(req.method==='GET'&&match){const receipt=view(match[1]!);respond(receipt?200:404,receipt??{error:'unknown_request'});return;}
     if(req.method==='POST'&&req.url==='/requests'){
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('Request too large');}
      const body=JSON.parse(raw) as {id?:unknown;prompt?:unknown;model?:unknown};
      if(typeof body.prompt!=='string'||!body.prompt.trim())throw new Error('prompt is required');
      if(body.model!==undefined&&(typeof body.model!=='string'||!subscription.models.includes(body.model)))throw new Error('CHATGPT_MODEL_UNSUPPORTED');
      const requestId=typeof body.id==='string'?body.id:randomUUID();if(!/^[a-f0-9-]{36}$/.test(requestId))throw new Error('invalid id');
      const previous=subscription.effect(requestId);
      if(previous){
       if(previous.promptHash!==createHash('sha256').update(body.prompt).digest('hex')||previous.requestedModel===null||previous.requestedModel!==(body.model??'chat')){respond(409,{error:'id_reuse'});return;}
       respond(200,view(requestId));return;
      }
      if(subscription.pendingCount()>=MAX_PENDING_REQUESTS){respond(429,{error:'channel_capacity',pendingLimit:MAX_PENDING_REQUESTS});return;}
      const execution=await subscription.start({id:requestId,prompt:body.prompt,purpose:'chat',sessionId:null,model:typeof body.model==='string'?body.model:'chat',onEvent:async()=>{}});
      void execution.result.catch(error=>process.stderr.write(JSON.stringify({event:'request_failed',id:requestId,code:error instanceof Error?error.message:'error'})+'\n'));
      respond(202,{id:requestId,receipt:`/requests/${requestId}`});return;
     }
     respond(404,{error:'not_found'});
    }catch(error){respond(400,{error:error instanceof Error?error.message:'request_failed'});}
   });
   const stop=()=>{server.close();void subscription.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
   server.listen(port,'127.0.0.1',()=>process.stdout.write(`Listening on 127.0.0.1:${port}\n`));
   await new Promise<void>(resolve=>server.once('close',resolve));
  }else throw new Error('Unknown command: '+command);
 }finally{if(command!=='serve')await subscription.close();}
}
main().catch(error=>{process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=64;});
