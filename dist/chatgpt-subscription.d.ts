import type { AgentHistoryPage, NativeSessionBinding, NativeSessionReference, ProviderExecution, ProviderInput, ProviderResult, ProviderRunIdentity, SubscriptionProvider } from './ports.js';
import type { ChatgptBrowserPort } from './chatgpt-browser.js';
type Options = Readonly<{
    directory: string;
    browser: ChatgptBrowserPort;
    pollMs?: number;
    agentProject?: string;
    personalModelPrefix?: string;
    diagnostic?: (event: Readonly<Record<string, unknown>>) => void;
}>;
/** Pace sends to avoid accidental bursts across process restarts. */
export declare const chatgptPacing: {
    readonly perHour: 6;
    readonly minGapMs: 120000;
};
export declare class ChatgptSubscription implements SubscriptionProvider {
    private readonly options;
    readonly id: "chatgpt";
    /** `chat` and `work` pick the mode and leave thinking as it is; a thinking level picks Chat at that level. */
    readonly models: readonly string[];
    /** ChatGPT reads any file a person can attach; its own upload refuses what it cannot take. */
    readonly attachmentTypes: readonly string[];
    readonly supportsSessionTools = false;
    readonly supportsStop = false;
    private readonly receipts;
    private readonly observations;
    private readonly active;
    private readonly listeners;
    private readonly inFlight;
    private closed;
    private closing;
    private sends;
    private waiting;
    private paceTail;
    private readonly releaseOwnerLock;
    constructor(options: Options);
    private track;
    pendingCount(): number;
    /** Waits until a send fits the pace, then records it; queued sends go out in order. */
    private pace;
    /** What Provider accounts shows: sends per hour for the last day, totals, and the pace. */
    usage(): {
        perHour: {
            hour: string;
            count: number;
        }[];
        lastDay: number;
        lastWeek: number;
        lastHour: number;
        waiting: number;
        pacing: {
            perHour: 6;
            minGapMinutes: number;
        };
    };
    private resumeAnswers;
    private readOnAcrossOutage;
    private atomic;
    private save;
    private event;
    effect(id: string): {
        runId: string;
        promptHash: string;
        requestedModel: string | null;
        ownerContext: string | null;
        events: readonly Readonly<{
            cursor: string;
            eventId: string;
            kind: "identity" | "message" | "result";
            at: string;
            payload: unknown;
        }>[];
        state: string;
        acknowledgedAt: string | null;
        nativeBinding: Readonly<{
            accountScope: string;
            sessionId: string;
            anchor?: import("./ports.js").NativeSessionAnchor;
        }> | null;
        result: Readonly<{
            sessionId: string;
            turnId: string | null;
            text: string;
            state: "completed" | "failed" | "canceled" | "uncertain";
            error: string | null;
            nativeBinding?: NativeSessionBinding;
        }> | null;
        error: string | null;
    } | null;
    private waitForResult;
    observeEffect(id: string, after: string | null, signal: AbortSignal): Promise<{
        error?: string | null | undefined;
        runId: string;
        events: Readonly<{
            cursor: string;
            eventId: string;
            kind: "identity" | "message" | "result";
            at: string;
            payload: unknown;
        }>[];
        nextCursor: string | null;
        complete: boolean;
        result: Readonly<{
            sessionId: string;
            turnId: string | null;
            text: string;
            state: "completed" | "failed" | "canceled" | "uncertain";
            error: string | null;
            nativeBinding?: NativeSessionBinding;
        }> | null;
    }>;
    private retain;
    available(): Promise<{
        available: boolean;
        reason: null;
    } | {
        available: boolean;
        reason: string;
    }>;
    bind(reference: NativeSessionReference): Promise<NativeSessionBinding>;
    searchSources(query: string): Promise<{
        sources: {
            name: string;
            content: string;
            scope: string;
            matchedEventId: string | null;
        }[];
        complete: boolean;
    }>;
    snapshot(binding: NativeSessionBinding): Promise<{
        name: string;
        content: string;
        scope: string;
        branch: string;
    }>;
    start(input: ProviderInput): Promise<ProviderExecution>;
    startOwned(input: ProviderInput, ownerContext: string, beforeDispatch: () => Promise<void>): Promise<ProviderExecution>;
    private startEffect;
    private execute;
    /** Reads an acknowledged request's conversation until its answer is complete and verified. */
    private awaitAnswer;
    private correlate;
    private outcome;
    /** The model ChatGPT recorded on the final answer of this request's exchange. */
    private answerModel;
    reconcile(identity: ProviderRunIdentity): Promise<ProviderResult>;
    history(sessionId: string, cursor: string | null, limit: number, binding?: NativeSessionBinding): Promise<AgentHistoryPage>;
    detail(sessionId: string, key: string, binding?: NativeSessionBinding): Promise<Readonly<{
        content: string;
    }>>;
    artifact(binding: NativeSessionBinding, messageId: string, path: string): Promise<Readonly<{
        name: string;
        contentType: string;
        bytes: Uint8Array;
    }>>;
    close(): Promise<void>;
}
export {};
