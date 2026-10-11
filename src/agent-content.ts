export type AgentContentSource = Readonly<{
 provider:'chatgpt';conversationId:string;messageId:string;version:string;url:string;detailKey:string;
}>;
export type AgentContentPart =
 | Readonly<{kind:'markdown';id:string;text:string}>
 | Readonly<{kind:'writing';id:string;title:string;content:string;selectedOptionId:string|null;
    options:readonly Readonly<{id:string;label:string;content:string}>[];source:AgentContentSource}>
 | Readonly<{kind:'file';id:string;name:string;path:string;source:AgentContentSource}>
 | Readonly<{kind:'unsupported';id:string;providerType:string;summary:string;source:AgentContentSource}>;
export type AgentContent = Readonly<{version:1;parts:readonly AgentContentPart[]}>;
