import Database from 'better-sqlite3';
import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, type BigIntStats } from 'node:fs';
import { dirname } from 'node:path';

export type MeshConfigLockReason = 'legacy_lock_present' | 'sqlite_busy' | 'incarnation_changed' | 'path_changed' | 'unsafe_inode'
    | 'enoent' | 'journal_mode_changed' | 'released' | 'not_held' | (string & {});

function describe(code: 'store_busy' | 'project_storage_unavailable', lockPath: string | undefined, reason: string | undefined): string {
    const where = lockPath ? `: ${lockPath}` : '';
    if (code === 'store_busy') {
        const base = `meshes.json write lock is held${where}`;
        return reason === 'legacy_lock_present'
            ? `${base} (an older ADHDev version holds ${lockPath ?? 'the legacy lock'}; stop older daemons/CLIs using this config directory, or remove the directory if none is running)`
            : base;
    }
    return `meshes.json write lock is unavailable${where}${reason ? ` (reason: ${reason}; restart the daemon if the config directory was replaced)` : ''}`;
}

export class MeshConfigStrictLockError extends Error {
    constructor(readonly code: 'store_busy' | 'project_storage_unavailable', readonly lockPath?: string, readonly reason?: MeshConfigLockReason) {
        super(describe(code, lockPath, reason));
    }
}

const warnedReasons = new Set<string>();
function warnOnce(reason: string, message: string): void {
    if (warnedReasons.has(reason)) return;
    warnedReasons.add(reason);
    // Lazy: the logger resolves the config dir at module load, and this module is
    // imported by the config layer itself (cheap consumers must not pull it in).
    void import('../logging/logger.js').then(m => m.LOG.warn('MeshConfig', message), () => {});
}
function reasonOf(e: unknown): string {
    const err = e as { code?: string; message?: string };
    const m = err.message ?? '';
    if (m === 'unsafe_mutex_inode') return 'unsafe_inode';
    if (m === 'mutex_incarnation_changed') return 'incarnation_changed';
    if (m === 'mutex_path_changed') return 'path_changed';
    if (m === 'mutex_journal_mode_changed') return 'journal_mode_changed';
    if (err.code) return err.code === 'ENOENT' ? 'enoent' : err.code;
    return m || 'unknown';
}

// This file is a persistent, local-filesystem SQLite mutex, never a payload DB.
// BEGIN EXCLUSIVE holds the kernel's SQLite byte-range locks on its inode.
// No participant unlinks, renames, stale-steals, or writes to it, including on
// crash recovery. OS connection teardown releases ownership. There is no
// check-marker/enter-callback gap and release never acts on a pathname.
// As with native flock, arbitrary privileged replacement of the lock directory
// is outside mutual exclusion. Detect observed replacement/ABA and fail closed.
const incarnations = new Map<string, string>();
// Paths whose mutex THIS process currently holds; never re-pinned while held.
const heldPaths = new Set<string>();
/** Test-only: drops pins and warn-once state (production re-pins on its own). */
export function __resetMeshConfigMutexIncarnationsForTests(): void { incarnations.clear(); warnedReasons.clear(); heldPaths.clear(); }
// ctime is deliberately excluded: chmod/xattrs (Spotlight, Time Machine, quarantine, AV)
// change it on a healthy install. dev+ino+birthtime still detect replacement.
function identity(s: BigIntStats): string {
    if (!s.isFile() || s.nlink !== 1n || s.ino <= 0n) throw new Error('unsafe_mutex_inode');
    return [s.dev, s.ino, s.birthtimeNs, s.size].join(':');
}
export interface MeshConfigMutex { assertHeld(): void; release(): void }
export function acquireMeshConfigMutex(configPath: string, timeout: number): MeshConfigMutex {
    const path = `${configPath}.write-lock.sqlite`;
    const legacy = `${configPath}.lock`;
    let fd: number | undefined;
    let db: InstanceType<typeof Database> | undefined;
    let released = false;
    let added = false;
    try {
        // Fail closed on retained old-protocol holders, regardless of age or
        // marker. Mixed old/new writers must be drained before rollout; old
        // binaries cannot acquire this protocol and cannot be made safe here.
        const deadline = Date.now() + timeout;
        for (;;) {
            try { lstatSync(legacy); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e; }
            if (Date.now() >= deadline) throw new MeshConfigStrictLockError('store_busy', legacy, 'legacy_lock_present');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
        // Re-pin safety: the pin only protects holders. If this process holds no
        // mutex for `path`, a changed/missing lock file is adopted (created with
        // O_CREAT) instead of failing until restart. A holder in ANOTHER process
        // still runs assertHeld() before every publish and refuses if the path was
        // swapped under it, so two processes can never both successfully publish.
        const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CREAT;
        try { fd = openSync(path, flags, 0o600); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            // Intentional convenience: the config dir was removed/replaced at runtime, so
            // recreate it and keep writes working instead of failing until restart.
            mkdirSync(dirname(path), { recursive: true });
            fd = openSync(path, flags, 0o600);
        }
        const pinned = identity(fstatSync(fd, { bigint: true }));
        if (identity(lstatSync(path, { bigint: true })) !== pinned) throw new Error('mutex_path_changed');
        const known = incarnations.get(path);
        if (known && known !== pinned) {
            if (heldPaths.has(path)) throw new Error('mutex_incarnation_changed');
            warnOnce('repin', `meshes.json write-lock file ${path} was replaced or recreated; re-pinning to the new file`);
        }
        incarnations.set(path, pinned);
        db = new Database(path, { timeout: Math.max(0, deadline - Date.now()), fileMustExist: true });
        // No schema or payload writes: an empty SQLite file supports locking.
        // DELETE journal mode is required; a substituted WAL DB is refused.
        if (db.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('mutex_journal_mode_changed');
        db.exec('BEGIN EXCLUSIVE');
        const assertHeld = () => {
            let bad: string | undefined;
            if (released) bad = 'released';
            else if (!db?.inTransaction) bad = 'not_held';
            else {
                try {
                    if (identity(fstatSync(fd!, { bigint: true })) !== pinned || identity(lstatSync(path, { bigint: true })) !== pinned) bad = 'path_changed';
                } catch (e) { bad = reasonOf(e) === 'unsafe_inode' ? 'path_changed' : reasonOf(e); }
            }
            if (bad) throw new MeshConfigStrictLockError('project_storage_unavailable', path, bad);
            try { lstatSync(legacy); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
            throw new MeshConfigStrictLockError('store_busy', legacy, 'legacy_lock_present');
        };
        heldPaths.add(path); added = true;
        assertHeld();
        return { assertHeld, release() {
            if (released) return;
            try { assertHeld(); }
            finally {
                released = true;
                heldPaths.delete(path);
                // Closing the owned connection releases only our transaction;
                // it cannot remove another process's replacement lock inode.
                try { db!.close(); } finally { closeSync(fd!); }
            }
        } };
    } catch (e) {
        if (added) heldPaths.delete(path);
        try { db?.close(); } finally { if (fd !== undefined) closeSync(fd); }
        if (e instanceof MeshConfigStrictLockError) {
            if (e.reason === 'legacy_lock_present') warnOnce('legacy_lock_present', e.message);
            throw e;
        }
        const reason = (e as { code?: string }).code === 'SQLITE_BUSY' ? 'sqlite_busy' : reasonOf(e);
        const err = new MeshConfigStrictLockError(reason === 'sqlite_busy' ? 'store_busy' : 'project_storage_unavailable', path, reason);
        if (reason !== 'sqlite_busy') warnOnce(reason, err.message);
        throw err;
    }
}
