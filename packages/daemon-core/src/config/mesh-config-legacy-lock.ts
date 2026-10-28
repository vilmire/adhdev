import { lstatSync, readdirSync, rmdirSync } from 'node:fs';
import { LOG } from '../logging/logger.js';

/** The old (pre-SQLite-mutex) protocol's owner marker inside `<meshes.json>.lock`. */
export const LEGACY_OWNER_MARKER = 'operator-recovery-owner';
/** Real old-protocol spans were sub-second and the old code itself stole after 15 s;
 * 10 minutes is far past any live holder, so a lock this old was abandoned. */
export const LEGACY_LOCK_RECLAIM_MIN_AGE_MS = 10 * 60_000;

export type LegacyLockReclaimResult =
    | { reclaimed: true; ageMs: number }
    | { reclaimed: false; reason: 'absent' | 'not_directory' | 'fresh' | 'has_contents' | 'error' };

/**
 * Conservative cleanup of a legacy `<configPath>.lock` directory left by a
 * crashed/SIGKILLed old daemon (the old 15 s stale-steal no longer exists, so
 * it would otherwise make every mesh write fail with store_busy forever).
 * Boot-time only — never call from the acquire hot path. Removes the lock only
 * when it is a directory, older than `minAgeMs`, and EMPTY (so it carries no
 * `operator-recovery-owner` marker or anything unexpected); uses rmdir, never a
 * recursive delete. A fresh lock is left alone so a live old writer is respected.
 */
export function reclaimStaleLegacyMeshConfigLock(
    configPath: string,
    opts: { now?: number; minAgeMs?: number } = {},
): LegacyLockReclaimResult {
    const lock = `${configPath}.lock`;
    const now = opts.now ?? Date.now();
    const minAgeMs = opts.minAgeMs ?? LEGACY_LOCK_RECLAIM_MIN_AGE_MS;
    try {
        let st;
        try { st = lstatSync(lock); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { reclaimed: false, reason: 'absent' }; throw e; }
        if (!st.isDirectory()) return { reclaimed: false, reason: 'not_directory' };
        const ageMs = now - st.mtimeMs;
        if (!(ageMs > minAgeMs)) return { reclaimed: false, reason: 'fresh' };
        // Marker present (or any other content) => keep; rmdir below also refuses non-empty dirs.
        if (readdirSync(lock).length > 0) return { reclaimed: false, reason: 'has_contents' };
        rmdirSync(lock);
        LOG.warn('MeshConfig', `Removed abandoned legacy mesh write lock ${lock} (age ${Math.round(ageMs / 1000)}s, no ${LEGACY_OWNER_MARKER} marker); left by a crashed older ADHDev version`);
        return { reclaimed: true, ageMs };
    } catch (e) {
        LOG.warn('MeshConfig', `Could not reclaim legacy mesh write lock ${lock}: ${(e as Error).message}`);
        return { reclaimed: false, reason: 'error' };
    }
}
