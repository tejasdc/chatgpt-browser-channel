import type { Page } from 'playwright';
import type { AgentRunRequest, NativeSessionBinding } from './ports.js';
import type { ChatgptConversation } from './chatgpt-content.js';
/** Attach to a separately owned browser or launch a persistent local profile. */
export type ChatgptBrowserOptions = Readonly<{
    profile?: string;
    executablePath?: string;
    headless?: boolean;
    endpoint?: string;
    accountEmail?: string;
    recover?: (page: Page) => Promise<void>;
    diagnostic?: (event: Readonly<Record<string, unknown>>) => void;
}>;
/** ChatGPT's thinking levels, in the order its composer's power slider holds them (0 to 4). */
export declare const chatgptThinkingLevels: readonly ["light", "medium", "high", "extra-high", "pro"];
export type ChatgptThinkingLevel = typeof chatgptThinkingLevels[number];
type SendStage = 'account' | 'conversation' | 'navigation' | 'composer' | 'mode' | 'thinking' | 'attachments' | 'input' | 'send-button' | 'binding-check' | 'dispatch' | 'acknowledgement';
export declare class ChatgptSendError extends Error {
    readonly stage: SendStage;
    constructor(stage: SendStage, error: unknown);
}
export interface ChatgptBrowserPort {
    account(): Promise<string>;
    read(sessionId: string, accountScope: string): Promise<ChatgptConversation>;
    search(query: string): Promise<Readonly<{
        accountScope: string;
        matches: readonly Readonly<{
            sessionId: string;
            messageId: string | null;
        }>[];
        complete: boolean;
    }>>;
    send(input: Readonly<{
        prompt: string;
        binding: NativeSessionBinding | null;
        mode: 'chat' | 'work';
        thinking?: ChatgptThinkingLevel | null;
        project?: string | null;
        attachments: NonNullable<AgentRunRequest['attachments']>;
        prepared: (accountScope: string, baseline: string | null) => Promise<void>;
        dispatching: () => Promise<void>;
        accepted: (binding: NativeSessionBinding, messageId: string) => Promise<void>;
    }>): Promise<void>;
    download(binding: NativeSessionBinding, messageId: string, path: string): Promise<Readonly<{
        name: string;
        contentType: string;
        bytes: Uint8Array;
    }>>;
    close(): Promise<void>;
}
export declare class ChatgptBrowser implements ChatgptBrowserPort {
    private readonly options;
    private readonly releaseOwnerLock;
    private browserContext;
    private attached;
    private observer;
    private uiTail;
    private recovering;
    /** Tabs of sends that failed after dispatch, kept for inspection; only the newest three stay open. */
    private kept;
    /** Set by close(): waits for ChatGPT's throttle end at once so a stop is never held by them. */
    private closing;
    private wakeClosing;
    private pauseUnlessClosing;
    constructor(options: ChatgptBrowserOptions);
    private browser;
    private attach;
    private control;
    private ready;
    private note;
    private request;
    account(): Promise<string>;
    inventory(scope: string, archived: boolean, offset: number): Promise<Readonly<{
        items: readonly import("./chatgpt-inventory.js").ChatgptInventoryItem[];
        nextOffset: number | null;
        reportedTotal: number;
        raw: unknown;
    }>>;
    read(sessionId: string, accountScope: string): Promise<ChatgptConversation>;
    search(query: string): Promise<{
        accountScope: string;
        matches: {
            sessionId: string;
            messageId: string | null;
        }[];
        complete: boolean;
    }>;
    private exclusive;
    /** Moves the composer's power slider to the asked level and reads back what ChatGPT selected. */
    private setThinking;
    send(input: Parameters<ChatgptBrowserPort['send']>[0]): Promise<void>;
    download(binding: NativeSessionBinding, messageId: string, path: string): Promise<Readonly<{
        name: string;
        contentType: string;
        bytes: Uint8Array;
    }>>;
    close(): Promise<void>;
}
export {};
