import {ChatgptBrowser,ChatgptSubscription} from '../dist/index.js';
const [, ,endpoint,directory]=process.argv;
const browser=new ChatgptBrowser({endpoint});
new ChatgptSubscription({directory,browser:{account:async()=>'',read:async()=>{throw Error('unused')},send:async()=>{},search:async()=>({accountScope:'',matches:[],complete:true}),download:async()=>({name:'',contentType:'',bytes:new Uint8Array()}),close:async()=>{}}});
process.stdout.write('ready\n');
setInterval(()=>{},60_000);
