/**
 * Cross-process mkdir lock with an owner record, for the launch-defaults store
 * and launch-default Inbox proposals.
 *
 * The lock is a directory (atomic create); right after creating it the holder
 * writes `owner.json` ({pid, nonce, acquiredAt}). By default a lock is reclaimed
 * only when its holder is provably gone:
 *   - the recorded pid no longer exists (`process.kill(pid, 0)` → ESRCH), or
 *   - there is no owner record and the directory is older than
 *     OWNERLESS_STALE_MS (a lock left by a build that predates owner records;
 *     a live holder writes its record microseconds after mkdir).
 * A live pid is never stolen unless the caller opts into a maximum lock age,
 * or the record carries a process start identity that no longer matches the
 * live pid (pid reuse after a crash).
 *
 * Reclaim runs under a second mkdir guard (`<lock>.reclaim`) and re-reads the
 * owner record there: only the exact abandoned instance (same nonce, or still
 * ownerless and old) is removed, never a lock a live writer took in between.
 * The guard's own window is synchronous and tiny; if a guard is ever left
 * behind, acquisition refuses with a reason naming that path.
 *
 * The guard carries its own `owner.json` ({pid, nonce, startId}). An orphaned
 * guard (reclaimer crashed) is removed only with positive proof the reclaimer
 * is dead: its pid is gone, or the live pid's start identity differs from the
 * recorded one (pid reuse). Never by age. Removal is compare-and-swap: the
 * marker's owner file is atomically renamed away, the claimed copy must carry
 * the observed nonce, and only the single winning renamer removes the guard.
 * Legacy/garbled/ownerless guards and live reclaimers stay blocking (fail
 * closed). The protected lock directory and its bytes are never touched here.
 */
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const OWNERLESS_STALE_MS = 60_000;
const OWNER_FILE = 'owner.json';

/** `startId` is the holder's process start identity; a live pid whose start
 * identity differs is a reused pid, not the holder. Absent on old records / win32. */
export interface LockOwner { pid: number; nonce: string; acquiredAt: number; startId?: string }
export type OwnedLockResult =
    | { ok: true; owner: LockOwner; release(): void }
    /** `busy`: held by a live owner (or a reclaim is in progress). `errno`: the
     * mkdir failure code otherwise (e.g. ENOENT when the parent is gone). */
    | { ok: false; busy: boolean; errno?: string; reason: string };
export interface OwnedLockOptions {
    isPidAlive?: (pid: number) => boolean;
    now?: () => number;
    /** Opt-in expiry, including known live owners. Requires external writer
     * fencing: a synchronous transaction can stall and resume after expiry. */
    maxAgeMs?: number;
    /** Expiry for missing/torn owner records only. Does not expire live owners;
     * defaults to maxAgeMs, then OWNERLESS_STALE_MS. */
    ownerlessMaxAgeMs?: number;
    /** Opt into peer probes for stale-looking locks. Never enable in receipt transactions. */
    probePeerIdentity?: boolean;
    /** Process start identity probe (injectable for tests). */
    processStartId?: (pid: number) => string | undefined;
}

/** Numeric OS identity. The version tag prevents comparison with legacy ps text.
 * Darwin's portable ps fallback has second precision; UTC parsing avoids local
 * timezone/DST and locale conversions. A same-second reuse is unknown, not proof. */
export function processStartId(pid: number): string | undefined {
    try {
        if (process.platform === 'linux') {
            const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            // comm (field 2) can contain spaces and parentheses. Field 22 is
            // index 19 after the closing comm parenthesis (field 3 starts there).
            const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
            if (/^[a-f0-9-]{36}$/.test(boot) && /^\d+$/.test(ticks ?? '')) return `linux-start-ticks-v1:${boot}:${ticks}`;
        } else if (process.platform === 'darwin') {
            const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
                encoding: 'utf8', timeout: 2000, windowsHide: true,
                env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            const match = /^\w{3} (\w{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(out);
            if (!match) return undefined;
            const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1]);
            const epochMs = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
            if (month >= 0 && Number.isFinite(epochMs) && epochMs > 0) return `darwin-epoch-seconds-v1:${epochMs / 1000}`;
        }
    } catch { /* An unavailable probe is uncertainty, never reuse evidence. */ }
    return undefined;
}

// Module initialization precedes lock transactions. No process spawn is needed
// for fresh locks, including the receipt store's synchronous hot path.
const ownProcessStartId = processStartId(process.pid);

function identityFormat(value: string | undefined): string | undefined {
    if (/^linux-start-ticks-v1:[a-f0-9-]{36}:\d+$/.test(value ?? '')) return 'linux-start-ticks-v1';
    if (/^darwin-epoch-seconds-v1:\d+$/.test(value ?? '')) return 'darwin-epoch-seconds-v1';
    return undefined;
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
            return { kind: 'owner', owner: { pid: v.pid as number, nonce: v.nonce, acquiredAt: Number(v.acquiredAt) || 0,
                ...(typeof v.startId === 'string' && v.startId ? { startId: v.startId } : {}) } };
        }
    } catch { /* absent or torn record: fall through to the directory age */ }
    try { return { kind: 'ownerless', mtimeMs: statSync(lock).mtimeMs }; }
    catch { return { kind: 'gone' }; }
}

function abandoned(observed: Observed, alive: (pid: number) => boolean, now: number, options: OwnedLockOptions,
    startOf: (pid: number) => string | undefined): boolean {
    if (observed.kind === 'owner') return !alive(observed.owner.pid)
        || ((observed.owner.pid === process.pid || now - observed.owner.acquiredAt >= OWNERLESS_STALE_MS)
            && pidReused(observed.owner, startOf))
        || (options.maxAgeMs !== undefined && now - observed.owner.acquiredAt >= options.maxAgeMs);
    if (observed.kind === 'ownerless') return now - observed.mtimeMs >= (options.ownerlessMaxAgeMs ?? options.maxAgeMs ?? OWNERLESS_STALE_MS);
    return false;
}

function pidReused(owner: LockOwner, startOf: (pid: number) => string | undefined): boolean {
    const format = identityFormat(owner.startId);
    if (!format) return false;
    const current = startOf(owner.pid);
    return identityFormat(current) === format && current !== owner.startId;
}

function sameInstance(a: Observed, b: Observed): boolean {
    if (a.kind === 'owner' && b.kind === 'owner') return a.owner.pid === b.owner.pid && a.owner.nonce === b.owner.nonce;
    return a.kind === 'ownerless' && b.kind === 'ownerless';
}

/** Remove an abandoned lock under the reclaim guard. True when the caller should retry mkdir. */
function reclaim(lock: string, alive: (pid: number) => boolean, now: () => number, options: OwnedLockOptions,
    startOf: (pid: number) => string | undefined): boolean {
    const observed = readOwner(lock);
    if (observed.kind === 'gone') return true;
    if (!abandoned(observed, alive, now(), options, startOf)) return false;
    const guard = `${lock}.reclaim`;
    const guardOwner = takeReclaimGuard(guard, alive, startOf, options.processStartId ?? processStartId);
    if (!guardOwner) return false;
    try {
        const recheck = readOwner(lock);
        if (recheck.kind === 'gone') return true;
        if (!sameInstance(observed, recheck) || !abandoned(recheck, alive, now(), options, startOf)) return false;
        try { unlinkSync(join(lock, OWNER_FILE)); } catch { /* ownerless or torn record */ }
        try { rmdirSync(lock); return true; } catch { return false; }
    } finally {
        releaseReclaimGuard(guard, guardOwner);
    }
}

function releaseReclaimGuard(guard: string, owner: LockOwner): void {
    // Only remove a guard that is still ours.
    const current = readOwner(guard);
    if (current.kind === 'owner' && current.owner.nonce !== owner.nonce) return;
    try { unlinkSync(join(guard, OWNER_FILE)); } catch { /* already gone */ }
    try { rmdirSync(guard); } catch { /* left for operator recovery; acquisition names it */ }
}

/** Create the reclaim guard with an owner record, recovering a provably dead one once. */
function takeReclaimGuard(guard: string, alive: (pid: number) => boolean,
    startOf: (pid: number) => string | undefined, probe: (pid: number) => string | undefined): LockOwner | undefined {
    for (let attempt = 0; attempt < 2; attempt++) {
        try { mkdirSync(guard, { mode: 0o700 }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0 || !recoverDeadGuard(guard, alive, probe)) return undefined;
            continue;
        }
        const startId = startOf(process.pid);
        const owner: LockOwner = { pid: process.pid, nonce: randomBytes(16).toString('hex'), acquiredAt: Date.now(), ...(startId ? { startId } : {}) };
        try { writeFileSync(join(guard, OWNER_FILE), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
        catch { try { rmdirSync(guard); } catch { /* ownerless guard stays blocking */ } return undefined; }
        return owner;
    }
    return undefined;
}

/** True only when the guard's recorded reclaimer is provably dead and this caller won the CAS. */
function recoverDeadGuard(guard: string, alive: (pid: number) => boolean,
    probe: (pid: number) => string | undefined): boolean {
    const observed = readOwner(guard);
    if (observed.kind !== 'owner') return false; // legacy, torn or unknown marker: fail closed
    // Peer start identity is probed here only (failure path, never the hot path).
    const dead = !alive(observed.owner.pid) || pidReused(observed.owner, probe);
    if (!dead) return false;
    const claimed = join(guard, `${OWNER_FILE}.reaped-${randomBytes(8).toString('hex')}`);
    try { renameSync(join(guard, OWNER_FILE), claimed); } catch { return false; } // lost the race or already gone
    let claimedNonce: string | undefined;
    try { claimedNonce = (JSON.parse(readFileSync(claimed, 'utf8')) as Partial<LockOwner>).nonce; } catch { /* unreadable */ }
    if (claimedNonce !== observed.owner.nonce) {
        // We claimed a different (newer) marker than the one we proved dead: put it back.
        try { renameSync(claimed, join(guard, OWNER_FILE)); } catch { /* stays blocking */ }
        return false;
    }
    try { unlinkSync(claimed); rmdirSync(guard); return true; } catch { return false; }
}

export function acquireOwnedLock(lock: string, options: OwnedLockOptions = {}): OwnedLockResult {
    const alive = options.isPidAlive ?? isPidAlive;
    const now = options.now ?? Date.now;
    const startOf = options.processStartId ?? ((pid: number) => pid === process.pid
        ? ownProcessStartId : options.probePeerIdentity ? processStartId(pid) : undefined);
    const held = (): OwnedLockResult => {
        let reclaimGuard = false;
        try { reclaimGuard = statSync(`${lock}.reclaim`).isDirectory(); } catch { /* none */ }
        const guardOwner = reclaimGuard ? readOwner(`${lock}.reclaim`) : undefined;
        const detail = guardOwner?.kind === 'owner' ? ` (reclaimer pid ${guardOwner.owner.pid} not proven dead)` : '';
        return { ok: false, busy: true, reason: reclaimGuard
            ? `write_lock_reclaim_in_progress: ${lock}.reclaim${detail}` : `write_lock_held: ${lock}` };
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        try { mkdirSync(lock, { mode: 0o700 }); }
        catch (error) {
            const errno = (error as NodeJS.ErrnoException).code;
            if (errno !== 'EEXIST') return { ok: false, busy: false, ...(errno ? { errno } : {}), reason: `write_lock_unavailable: ${lock}` };
            if (!reclaim(lock, alive, now, options, startOf)) return held();
            continue;
        }
        const startId = options.processStartId ? options.processStartId(process.pid) : ownProcessStartId;
        const owner: LockOwner = { pid: process.pid, nonce: randomBytes(16).toString('hex'), acquiredAt: now(), ...(startId ? { startId } : {}) };
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
