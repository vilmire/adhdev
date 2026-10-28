import Database from 'better-sqlite3';
import { constants, openSync, closeSync, fstatSync, lstatSync, type BigIntStats } from 'node:fs';

export class MeshConfigStrictLockError extends Error {
    constructor(readonly code: 'store_busy' | 'project_storage_unavailable', readonly lockPath?: string) {
        super(`${code === 'store_busy' ? 'meshes.json write lock is held' : 'meshes.json write lock is unavailable'}${lockPath ? `: ${lockPath}` : ''}`);
    }
}

// This file is a persistent, local-filesystem SQLite mutex, never a payload DB.
// BEGIN EXCLUSIVE holds the kernel's SQLite byte-range locks on its inode.
// No participant unlinks, renames, stale-steals, or writes to it, including on
// crash recovery. OS connection teardown releases ownership. There is no
// check-marker/enter-callback gap and release never acts on a pathname.
// As with native flock, arbitrary privileged replacement of the lock directory
// is outside mutual exclusion. Detect observed replacement/ABA and fail closed.
const incarnations = new Map<string, string>();
function identity(s: BigIntStats): string {
    if (!s.isFile() || s.nlink !== 1n || s.ino <= 0n) throw new Error('unsafe_mutex_inode');
    return [s.dev, s.ino, s.birthtimeNs, s.ctimeNs, s.size].join(':');
}
export interface MeshConfigMutex { assertHeld(): void; release(): void }
export function acquireMeshConfigMutex(configPath: string, timeout: number): MeshConfigMutex {
    const path = `${configPath}.write-lock.sqlite`;
    const legacy = `${configPath}.lock`;
    let fd: number | undefined;
    let db: InstanceType<typeof Database> | undefined;
    let released = false;
    try {
        // Fail closed on retained old-protocol holders, regardless of age or
        // marker. Mixed old/new writers must be drained before rollout; old
        // binaries cannot acquire this protocol and cannot be made safe here.
        const deadline = Date.now() + timeout;
        for (;;) {
            try { lstatSync(legacy); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e; }
            if (Date.now() >= deadline) throw new MeshConfigStrictLockError('store_busy', legacy);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
        const known = incarnations.get(path);
        fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | (known ? 0 : constants.O_CREAT), 0o600);
        const pinned = identity(fstatSync(fd, { bigint: true }));
        if (known && known !== pinned) throw new Error('mutex_incarnation_changed');
        if (identity(lstatSync(path, { bigint: true })) !== pinned) throw new Error('mutex_path_changed');
        incarnations.set(path, pinned);
        db = new Database(path, { timeout: Math.max(0, deadline - Date.now()), fileMustExist: true });
        // No schema or payload writes: an empty SQLite file supports locking.
        // DELETE journal mode is required; a substituted WAL DB is refused.
        if (db.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('mutex_journal_mode_changed');
        db.exec('BEGIN EXCLUSIVE');
        const assertHeld = () => {
            if (released || !db?.inTransaction || identity(fstatSync(fd!, { bigint: true })) !== pinned || identity(lstatSync(path, { bigint: true })) !== pinned) {
                throw new MeshConfigStrictLockError('project_storage_unavailable', path);
            }
            try { lstatSync(legacy); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
            throw new MeshConfigStrictLockError('store_busy', legacy);
        };
        assertHeld();
        return { assertHeld, release() {
            if (released) return;
            try { assertHeld(); }
            finally {
                released = true;
                // Closing the owned connection releases only our transaction;
                // it cannot remove another process's replacement lock inode.
                try { db!.close(); } finally { closeSync(fd!); }
            }
        } };
    } catch (e) {
        try { db?.close(); } finally { if (fd !== undefined) closeSync(fd); }
        if (e instanceof MeshConfigStrictLockError) throw e;
        throw new MeshConfigStrictLockError((e as { code?: string }).code === 'SQLITE_BUSY' ? 'store_busy' : 'project_storage_unavailable', path);
    }
}
