import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGoogleSignInRecovery} from '../dist/index.js';

function pageAt(initial){
 let state=initial;const steps=[];
 const locator=(visible,click=async()=>{})=>({first(){return this;},isVisible:async()=>visible,click});
 return {steps,page:{
  url:()=>state==='google'||state==='password'?'https://accounts.google.com/signin':state==='login'?'https://chatgpt.com/auth/login':'https://chatgpt.com/',
  goto:async url=>{if(state!=='signed-in'&&state!=='challenge')state=url.includes('/auth/login')?'login':'root';},
  title:async()=>state==='challenge'?'Just a moment':'ChatGPT',
  evaluate:async()=>({authenticated:state==='signed-in',email:'person@example.com'}),
  getByRole:(role,{name})=>{
   if(role==='button'&&name==='Continue with Google')return locator(state==='login',async()=>{steps.push('google');state='google';});
   if(role==='textbox')return locator(false);
   return locator(false);
  },
  getByText:()=>locator(state==='google',async()=>{steps.push('account');state='signed-in';}),
  locator:selector=>selector==='body'?{innerText:async()=>state==='google'?'Choose an account':''}:locator(state==='password'),
 }};
}

test('saved Google session restores ChatGPT without exposing account choice in diagnostics',async()=>{
 const {page,steps}=pageAt('root');const events=[];
 await createGoogleSignInRecovery({accountEmail:'person@example.com',diagnostic:event=>events.push(event)})(page);
 assert.deepEqual(steps,['google','account']);
 assert.ok(events.some(event=>event.step==='authenticated'));
 assert.ok(events.every(event=>!JSON.stringify(event).includes('person@example.com')));
});

test('a signed-in session needs no account selection',async()=>{
 const {page,steps}=pageAt('signed-in');await createGoogleSignInRecovery()(page);assert.deepEqual(steps,[]);
});

test('a configured account cannot silently use another signed-in account',async()=>{
 const {page}=pageAt('signed-in');
 await assert.rejects(createGoogleSignInRecovery({accountEmail:'other@example.com'})(page),/CHATGPT_SIGNIN_ACCOUNT_MISMATCH/);
});

test('a configured account must have a confirmable session identity',async()=>{
 const {page}=pageAt('signed-in');page.evaluate=async()=>({authenticated:true,email:null});
 await assert.rejects(createGoogleSignInRecovery({accountEmail:'person@example.com'})(page),/CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED/);
});

test('an account picker without a configured account stops explicitly',async()=>{
 const {page}=pageAt('root');await assert.rejects(createGoogleSignInRecovery()(page),/CHATGPT_SIGNIN_ACCOUNT_REQUIRED/);
});

test('protective challenges stop for the operator',async()=>{
 const {page}=pageAt('challenge');await assert.rejects(createGoogleSignInRecovery()(page),/CHATGPT_CHALLENGE_NEEDS_OPERATOR/);
});

test('a Google password prompt stops without entering credentials',async()=>{
 const {page}=pageAt('password');page.goto=async()=>{};
 await assert.rejects(createGoogleSignInRecovery({accountEmail:'person@example.com'})(page),/CHATGPT_SIGNIN_NEEDS_OPERATOR/);
});
