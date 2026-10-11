import type { ChatgptConversation } from './chatgpt-content.js';
export type ChatgptInventoryItem = Readonly<{
    id: string;
    revision: string;
}>;
export type ChatgptInventoryPage = Readonly<{
    items: readonly ChatgptInventoryItem[];
    nextOffset: number | null;
    reportedTotal: number;
    raw: unknown;
}>;
export interface ChatgptInventoryBrowser {
    account(): Promise<string>;
    inventory(scope: string, archived: boolean, offset: number): Promise<ChatgptInventoryPage>;
    read(id: string, scope: string): Promise<ChatgptConversation>;
}
export declare class ChatgptSourceReadError extends Error {
    readonly raw: unknown;
    constructor(code: string, raw: unknown);
}
export declare function readChatgptInventory(raw: unknown, offset: number, limit: number): ChatgptInventoryPage;
