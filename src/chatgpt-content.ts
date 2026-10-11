import {createHash} from 'node:crypto';
import type {AgentContent,AgentContentPart,AgentContentSource} from './agent-content.js';
import type {AgentMessage} from './ports.js';
import {arrayField,field,record,stringField} from './provider-values.js';

export type ChatgptMessage=AgentMessage&Readonly<{richContent:AgentContent}>;
export type ChatgptNode=Readonly<{id:string;parent:string|null;message:Readonly<Record<string,unknown>>|null}>;
export type ChatgptConversation=Readonly<{
 id:string;title:string;currentNode:string;nodes:ReadonlyMap<string,ChatgptNode>;ancestry:readonly ChatgptNode[];raw:Readonly<Record<string,unknown>>;
}>;
export const chatgptDigest=(value:string):string=>createHash('sha256').update(value).digest('hex');
export const chatgptAccountScope=(userId:string,accountId:string):string=>{
 if(!userId||!accountId)throw new Error('CHATGPT_ACCOUNT_UNCONFIRMED');
 return 'chatgpt:'+chatgptDigest(JSON.stringify([userId,accountId]));
};
export function readChatgptConversation(raw:unknown,expectedId?:string):ChatgptConversation{
 if(!record(raw)||!record(raw['mapping']))throw new Error('CHATGPT_CONVERSATION_INVALID');
 const id=stringField(raw,'conversation_id')??stringField(raw,'id');
 const currentNode=stringField(raw,'current_node');
 if(!id||!currentNode)throw new Error('CHATGPT_CONVERSATION_IDENTITY_MISSING');
 if(expectedId&&id!==expectedId)throw new Error('CHATGPT_CONVERSATION_MISMATCH');
 const nodes=new Map<string,ChatgptNode>();
 for(const [nodeId,node] of Object.entries(raw['mapping'])){
  if(!record(node))throw new Error('CHATGPT_NODE_INVALID');
  const message=field(node,'message');
  nodes.set(nodeId,{id:nodeId,parent:stringField(node,'parent'),message:record(message)?message:null});
 }
 const ancestry:ChatgptNode[]=[];const visited=new Set<string>();let cursor:string|null=currentNode;
 while(cursor){
  if(visited.has(cursor))throw new Error('CHATGPT_BRANCH_CYCLE');
  const node=nodes.get(cursor);if(!node)throw new Error('CHATGPT_BRANCH_INCOMPLETE');
  visited.add(cursor);ancestry.unshift(node);cursor=node.parent;
 }
 return {id,title:stringField(raw,'title')??'ChatGPT conversation',currentNode,nodes,ancestry,raw};
}
export function chatgptMessageText(message:unknown):string{
 return arrayField(field(message,'content'),'parts').map(part=>typeof part==='string'?part:stringField(part,'text')??'').filter(Boolean).join('\n');
}
export function verifyChatgptAnchor(conversation:ChatgptConversation,anchor:Readonly<{messageId:string;branch:string;textHash:string}>):void{
 const message=conversation.ancestry.find(node=>node.id===anchor.messageId);
 if(!message?.message)throw new Error('CHATGPT_MESSAGE_NOT_ON_ACTIVE_BRANCH');
 if(!conversation.ancestry.some(node=>node.id===anchor.branch))throw new Error('CHATGPT_BRANCH_MISMATCH');
 if(chatgptDigest(chatgptMessageText(message.message))!==anchor.textHash)throw new Error('CHATGPT_EVIDENCE_CHANGED');
}
// These observed fields describe execution and presentation bookkeeping, not response content.
const operationalMetadata=new Set(['async_source','can_save','chime_version','conversation_followup_suggestions_eligible','cot_version','default_model_slug','finish_details','finished_duration_sec','hide_inline_actions','is_complete','is_visually_hidden_from_conversation','message_source','message_type','model_slug','model_switcher_deny','parent_id','poll_freshness_max_mins','poll_interval_ms','poll_on_websocket_inactivity_ms','poll_suppress_reconnect_banner','reasoning_end_time','reasoning_recap_type','reasoning_start_time','reasoning_status','request_id','resolved_model_slug','serialization_metadata','thinking_effort','turn_exchange_id','turn_id','working_turn_id']);
const contentMetadata=['citations','content_references','attachments','canvas','artifacts','search_result_groups','selected_sources'];
function projectContent(conversation:ChatgptConversation,node:ChatgptNode):AgentContent{
 const message=node.message!;const content=field(message,'content');const metadata=field(message,'metadata');
 const source:AgentContentSource={provider:'chatgpt',conversationId:conversation.id,messageId:node.id,
  version:chatgptDigest(JSON.stringify(message)),url:'https://chatgpt.com/c/'+encodeURIComponent(conversation.id),detailKey:node.id+':'+chatgptDigest(JSON.stringify(message))};
 const parts:AgentContentPart[]=[];const text=chatgptMessageText(message);
 if(text)parts.push({kind:'markdown',id:node.id+':text',text});
 const blocks=field(metadata,'writing_blocks');
 if(record(blocks))for(const [key,value] of Object.entries(blocks)){
  const block=record(value)?value:null;const blockMeta=field(block,'metadata');
  const id=stringField(block,'id')??key;const blockContent=stringField(block,'content');
  const options=arrayField(blockMeta,'options').flatMap(option=>{
   const id=stringField(option,'id'),label=stringField(option,'label'),content=stringField(option,'content');
   return id&&label&&content!==null?[{id,label,content}]:[];
  });
  if(!block||blockContent===null||options.length!==arrayField(blockMeta,'options').length){
   parts.push({kind:'unsupported',id:node.id+':writing:'+key,providerType:'writing_block',summary:'This writing block needs a newer renderer.',source});continue;
  }
  parts.push({kind:'writing',id,title:stringField(block,'title')??'Writing',content:blockContent,
   selectedOptionId:stringField(blockMeta,'active_option_id'),options,source});
 }
 for(const match of text.matchAll(/\[([^\]]+)\]\((sandbox:\/[^\s)]+)\)/g)){
  parts.push({kind:'file',id:node.id+':file:'+chatgptDigest(match[2]!),name:match[1]!,path:match[2]!,source});
 }
 const contentType=stringField(content,'content_type')??'unknown';
 const opaqueParts=arrayField(content,'parts').some(part=>typeof part!=='string');
 if(contentType!=='text'||opaqueParts)parts.push({kind:'unsupported',id:node.id+':content',providerType:contentType,summary:'Additional ChatGPT content is not supported here yet.',source});
 for(const key of contentMetadata){
  const value=field(metadata,key);
  if(value!==undefined&&value!==null&&(!Array.isArray(value)||value.length))parts.push({kind:'unsupported',id:node.id+':'+key,providerType:key,summary:'Additional '+key.replaceAll('_',' ')+' are available in the original response.',source});
 }
 const unknown=record(metadata)?Object.keys(metadata).filter(key=>!operationalMetadata.has(key)&&key!=='writing_blocks'&&!contentMetadata.includes(key)):[];
 if(unknown.length)parts.push({kind:'unsupported',id:node.id+':unrecognized',providerType:'unrecognized_response_data',summary:'Additional response fields need a renderer: '+unknown.join(', ')+'. The original data is retained.',source});
 return {version:1,parts};
}
export function projectChatgptMessages(conversation:ChatgptConversation):readonly ChatgptMessage[]{
 return conversation.ancestry.flatMap(node=>{
  if(!node.message)return [];
  const role=stringField(field(node.message,'author'),'role');
  if(role!=='user'&&role!=='assistant'&&role!=='tool')return [];
  const channel=stringField(node.message,'channel');
  const metadata=field(node.message,'metadata');
  if(field(metadata,'is_visually_hidden_from_conversation')===true)return [];
  const richContent=projectContent(conversation,node);
  return [{id:node.id,role,content:chatgptMessageText(node.message),tool:role==='tool'?stringField(field(node.message,'author'),'name')??'ChatGPT tool':null,
   phase:role==='assistant'&&(channel==='final'||field(node.message,'end_turn')===true)?'final_answer':channel,detailKey:node.id+':'+chatgptDigest(JSON.stringify(node.message)),richContent}];
 });
}
