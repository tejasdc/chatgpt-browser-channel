import {lstatSync,mkdirSync} from 'node:fs';

/** Refuse to store dialogue in a redirected or group/world-accessible directory. */
export function ensurePrivateDirectory(path:string):void{
 let stat;
 try{stat=lstatSync(path);}
 catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;mkdirSync(path,{recursive:true,mode:0o700});stat=lstatSync(path);}
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error('CHATGPT_STATE_DIRECTORY_UNSAFE');
}
