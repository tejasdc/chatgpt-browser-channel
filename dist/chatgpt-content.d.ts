import type { AgentContent } from './agent-content.js';
import type { AgentMessage } from './ports.js';
export type ChatgptMessage = AgentMessage & Readonly<{
    richContent: AgentContent;
}>;
export type ChatgptNode = Readonly<{
    id: string;
    parent: string | null;
    message: Readonly<Record<string, unknown>> | null;
}>;
export type ChatgptConversation = Readonly<{
    id: string;
    title: string;
    currentNode: string;
    nodes: ReadonlyMap<string, ChatgptNode>;
    ancestry: readonly ChatgptNode[];
    raw: Readonly<Record<string, unknown>>;
}>;
export declare const chatgptDigest: (value: string) => string;
export declare const chatgptAccountScope: (userId: string, accountId: string) => string;
export declare function readChatgptConversation(raw: unknown, expectedId?: string): ChatgptConversation;
export declare function chatgptMessageText(message: unknown): string;
export declare function verifyChatgptAnchor(conversation: ChatgptConversation, anchor: Readonly<{
    messageId: string;
    branch: string;
    textHash: string;
}>): void;
export declare function projectChatgptMessages(conversation: ChatgptConversation): readonly ChatgptMessage[];
