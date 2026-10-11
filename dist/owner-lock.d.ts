/** The parent retains the locked open-file description after flock exits. */
export declare function acquireOwnerLock(path: string, busyCode: string): () => void;
