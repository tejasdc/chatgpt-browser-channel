import type { SessionSources, SessionSourceRefresh } from './ports.js';
import type { ChatgptInventoryBrowser } from './chatgpt-inventory.js';
type Options = Readonly<{
    directory: string;
    browser: ChatgptInventoryBrowser;
    sources: Pick<SessionSources, 'import'> & {
        retains?: (version: string) => Promise<boolean>;
    };
    now?: () => Date;
    staleAfterMs?: number;
    readSpacingMs?: number;
}>;
/** Read-only source custody. Scheduling and the browser lifetime belong to composition. */
export declare class ChatgptRefresh {
    private readonly options;
    private checkpoint;
    private pending;
    private initialized;
    private restoring;
    private state;
    private reason;
    private readonly releaseOwnerLock;
    private readonly stop;
    private closing;
    private closed;
    constructor(options: Options);
    private now;
    status(): SessionSourceRefresh;
    refresh(input?: Readonly<{
        signal?: AbortSignal;
        maxDetails?: number;
    }>): Promise<SessionSourceRefresh>;
    restore(): Promise<void>;
    close(): Promise<void>;
    private restoreSources;
    private atomic;
    private save;
    private retain;
    private check;
    private index;
    private pause;
    private page;
    /** Newest-first pages until the first conversation whose marker is already known. */
    private recent;
    /** The first listing reads every conversation twice, since offset pages are not a snapshot. */
    private everything;
    private inventory;
    private perform;
    private safeReason;
}
export {};
