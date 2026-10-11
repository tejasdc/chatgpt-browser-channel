import { spawnSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
/** The parent retains the locked open-file description after flock exits. */
export function acquireOwnerLock(path, busyCode) {
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        const result = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8' });
        if (result.error)
            throw new Error('CHATGPT_FLOCK_UNAVAILABLE', { cause: result.error });
        if (result.status !== 0)
            throw new Error(result.status === 1 ? busyCode : 'CHATGPT_FLOCK_FAILED');
    }
    catch (error) {
        closeSync(fd);
        throw error;
    }
    let released = false;
    return () => { if (released)
        return; released = true; closeSync(fd); };
}
