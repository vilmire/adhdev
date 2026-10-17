/**
 * Cross-process mkdir lock with an owner record, for the launch-defaults store
 * and launch-default Inbox proposals.
 *
 * The lock is a directory (atomic create); right after creating it the holder
 * writes `owner.json` ({pid, nonce, acquiredAt}). A lock is reclaimed only when
 * its holder is provably gone:
 *   - the recorded pid no longer exists (`process.kill(pid, 0)` → ESRCH), or
 *   - there is no owner record and the directory is older than
 *     OWNERLESS_STALE_MS (a lock left by a build that predates owner records;
 *     a live holder writes its record microseconds after mkdir).
 * A live pid — including one that may have been reused — is never stolen.
 *
 * Reclaim runs under a second mkdir guard (`<lock>.reclaim`) and re-reads the
 * owner record there: only the exact abandoned instance (same nonce, or still
 * ownerless and old) is removed, never a lock a live writer took in between.
 * The guard's own window is synchronous and tiny; if a guard is ever left
 * behind, acquisition refuses with a reason naming that path.
 */
import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const OWNERLESS_STALE_MS = 60_000;
const OWNER_FILE = 'owner.json';

export interface LockOwner { pid: number; nonce: string; acquiredAt: number }
export type OwnedLockResult =
    | { ok: true; owner: LockOwner; release(): void }
    /** `busy`: held by a live owner (or a reclaim is in progress). `errno`: the
     * mkdir failure code otherwise (e.g. ENOENT when the parent is gone). */
    | { ok: false; busy: boolean; errno?: string; reason: string };
export interface OwnedLockOptions {
    isPidAlive?: (pid: number) => boolean;
    now?: () => number;
}

export function isPidAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

type Observed = { kind: 'owner'; owner: LockOwner } | { kind: 'ownerless'; mtimeMs: number } | { kind: 'gone' };

function readOwner(lock: string): Observed {
    try {
        const value: unknown = JSON.parse(readFileSync(join(lock, OWNER_FILE), 'utf8'));
        const v = value as Partial<LockOwner> | null;
        if (v && Number.isSafeInteger(v.pid) && (v.pid as number) > 0 && typeof v.nonce === 'string' && v.nonce) {
            return { kind: 'owner', owner: { pid: v.pid as number, nonce: v.nonce, acquiredAt: Number(v.acquiredAt) || 0 } };
        }
    } catch { /* absent or torn record: fall through to the directory age */ }
    try { return { kind: 'ownerless', mtimeMs: statSync(lock).mtimeMs }; }
    catch { return { kind: 'gone' }; }
}

function abandoned(observed: Observed, alive: (pid: number) => boolean, now: number): boolean {
    if (observed.kind === 'owner') return !alive(observed.owner.pid);
    if (observed.kind === 'ownerless') return now - observed.mtimeMs >= OWNERLESS_STALE_MS;
    return false;
}

function sameInstance(a: Observed, b: Observed): boolean {
    if (a.kind === 'owner' && b.kind === 'owner') return a.owner.pid === b.owner.pid && a.owner.nonce === b.owner.nonce;
    return a.kind === 'ownerless' && b.kind === 'ownerless';
}

/** Remove an abandoned lock under the reclaim guard. True when the caller should retry mkdir. */
function reclaim(lock: string, alive: (pid: number) => boolean, now: () => number): boolean {
    const observed = readOwner(lock);
    if (observed.kind === 'gone') return true;
    if (!abandoned(observed, alive, now())) return false;
    const guard = `${lock}.reclaim`;
    try { mkdirSync(guard, { mode: 0o700 }); } catch { return false; }
    try {
        const recheck = readOwner(lock);
        if (recheck.kind === 'gone') return true;
        if (!sameInstance(observed, recheck) || !abandoned(recheck, alive, now())) return false;
        try { unlinkSync(join(lock, OWNER_FILE)); } catch { /* ownerless or torn record */ }
        try { rmdirSync(lock); return true; } catch { return false; }
    } finally {
        try { rmdirSync(guard); } catch { /* left for operator recovery; acquisition names it */ }
    }
}

export function acquireOwnedLock(lock: string, options: OwnedLockOptions = {}): OwnedLockResult {
    const alive = options.isPidAlive ?? isPidAlive;
    const now = options.now ?? Date.now;
    const held = (): OwnedLockResult => {
        let reclaimGuard = false;
        try { reclaimGuard = statSync(`${lock}.reclaim`).isDirectory(); } catch { /* none */ }
        return { ok: false, busy: true, reason: reclaimGuard
            ? `write_lock_reclaim_in_progress: ${lock}.reclaim` : `write_lock_held: ${lock}` };
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        try { mkdirSync(lock, { mode: 0o700 }); }
        catch (error) {
            const errno = (error as NodeJS.ErrnoException).code;
            if (errno !== 'EEXIST') return { ok: false, busy: false, ...(errno ? { errno } : {}), reason: `write_lock_unavailable: ${lock}` };
            if (!reclaim(lock, alive, now)) return held();
            continue;
        }
        const owner: LockOwner = { pid: process.pid, nonce: randomBytes(16).toString('hex'), acquiredAt: now() };
        try { writeFileSync(join(lock, OWNER_FILE), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
        catch {
            try { rmdirSync(lock); } catch { /* ownerless lock ages out after OWNERLESS_STALE_MS */ }
            return { ok: false, busy: false, reason: `write_lock_unavailable: ${lock}` };
        }
        return { ok: true, owner, release: () => {
            // Remove only our own instance; a lock that is no longer ours stays.
            const current = readOwner(lock);
            if (current.kind !== 'owner' || current.owner.nonce !== owner.nonce) return;
            try { unlinkSync(join(lock, OWNER_FILE)); rmdirSync(lock); } catch { /* reclaimable once this pid exits */ }
        } };
    }
    return held();
}
