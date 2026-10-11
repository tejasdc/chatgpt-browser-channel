import type { AgentContent } from './agent-content.js';
export type NativeSessionAnchor = Readonly<{
    sourceId: string;
    sourceVersion: string;
    messageId: string;
    branch: string;
    textHash: string;
}>;
export type NativeSessionBinding = Readonly<{
    accountScope: string;
    sessionId: string;
    anchor?: NativeSessionAnchor;
}>;
export type NativeSessionReference = Readonly<{
    accountScope: string;
    sessionId: string;
    anchor: NativeSessionAnchor;
}>;
export type AgentRunRequest = Readonly<{
    attachments?: readonly Readonly<{
        name: string;
        contentType: string;
        path: string;
    }>[];
}>;
export type AgentMessage = Readonly<{
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool: string | null;
    phase: string | null;
    detailKey?: string;
    submissionId?: string;
    turnId?: string;
    richContent?: AgentContent;
}>;
export type AgentHistoryPage = Readonly<{
    messages: readonly AgentMessage[];
    nextCursor: string | null;
}>;
export type ProviderEvent = Readonly<{
    kind: 'identity';
    sessionId: string;
    turnId: string | null;
    nativeBinding?: NativeSessionBinding;
}> | Readonly<{
    kind: 'message';
    message: AgentMessage;
}> | Readonly<{
    kind: 'text';
    text: string;
}> | Readonly<{
    kind: 'tool';
    name: string;
}>;
export type ProviderResult = Readonly<{
    sessionId: string;
    turnId: string | null;
    text: string;
    state: 'completed' | 'failed' | 'canceled' | 'uncertain';
    error: string | null;
    nativeBinding?: NativeSessionBinding;
}>;
export type ProviderRunIdentity = Readonly<{
    id: string;
    sessionId: string | null;
    turnId: string | null;
    nativeBinding?: NativeSessionBinding;
}>;
export type ProviderInput = Readonly<{
    id: string;
    prompt: string;
    cwd?: string;
    purpose: 'chat' | 'extract' | 'develop' | 'transform';
    sessionId: string | null;
    onEvent: (event: ProviderEvent) => Promise<void>;
    model?: string;
    attachments?: AgentRunRequest['attachments'];
    nativeBinding?: NativeSessionBinding;
    policy?: 'consultation';
    tools?: unknown;
}>;
export type ProviderExecution = Readonly<{
    result: Promise<ProviderResult>;
    cancel(): Promise<void>;
}>;
export interface SubscriptionProvider {
    readonly id: 'chatgpt';
    readonly models: readonly string[];
    readonly attachmentTypes: readonly string[];
    available(): Promise<Readonly<{
        available: boolean;
        reason: string | null;
    }>>;
    start(input: ProviderInput): Promise<ProviderExecution>;
    history(sessionId: string, cursor: string | null, limit: number, binding?: NativeSessionBinding): Promise<AgentHistoryPage>;
    detail(sessionId: string, key: string, binding?: NativeSessionBinding): Promise<Readonly<{
        content: string;
    }>>;
}
export type SessionSourceRefresh = Readonly<{
    accountScope: string | null;
    state: 'idle' | 'refreshing' | 'partial' | 'failed';
    inventoryComplete: boolean;
    discovered: number;
    saved: number;
    indexed: number;
    failed: number;
    reportedTotal: number | null;
    lastAttemptAt: string | null;
    lastCompleteAt: string | null;
    reason: string | null;
}>;
export interface SessionSources {
    import(name: string, content: string, scope: string): Promise<readonly Readonly<{
        provider: string;
        nativeId: string;
        scope: string;
    }>[]>;
    retains?(version: string): Promise<boolean>;
}
