/**
 * Cleanup of per-process seqscribe DBs left in the config dir.
 *
 * `ADHDEV_SEQSCRIBE_DB_SUFFIX` (config-dir.ts) isolates one process's seqscribe
 * file inside a shared config dir; a standalone run names it
 * `seqscribe-standalone-<pid>.db`, so every run leaves its own file (plus
 * `.lock`, `-wal`, `-shm`, `.lock-journal`) that nothing ever removes (measured
 * on the preview Mac 2026-09-29: five of them). The daemon's own DB
 * (`seqscribe.db`) and any suffix that is not `standalone-<pid>` are never
 * touched.
 *
 * A file set is removed only when BOTH hold: its pid is not a live process and
 * every file of the set is older than `minAgeMs` (a day) — the age gate covers
 * pid reuse (a recycled pid must also have gone quiet for a day) and the
 * live-pid check covers a long-lived standalone process. Best-effort; never
 * throws.
 */

import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { LOG } from '../logging/logger.js';

export const STALE_SUFFIX_DB_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const SUFFIX_DB_FILE_RE = /^seqscribe-standalone-(\d+)\.db(?:\.lock|-wal|-shm|\.lock-journal)?$/;

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM = exists but not ours → alive; ESRCH = gone.
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

export interface StaleSuffixDbOptions {
    minAgeMs?: number;
    isPidAlive?: (pid: number) => boolean;
}

/** Delete dead per-process seqscribe DB file sets in `configDir`. Returns files removed. */
export function pruneStaleSuffixSeqscribeDbs(
    configDir: string,
    now: number = Date.now(),
    opts: StaleSuffixDbOptions = {},
): number {
    const minAgeMs = opts.minAgeMs ?? STALE_SUFFIX_DB_MIN_AGE_MS;
    const isPidAlive = opts.isPidAlive ?? pidAlive;
    let names: string[];
    try {
        names = readdirSync(configDir);
    } catch {
        return 0;
    }
    const sets = new Map<number, Array<{ path: string; mtimeMs: number }>>();
    for (const name of names) {
        const match = SUFFIX_DB_FILE_RE.exec(name);
        if (!match) continue;
        const path = join(configDir, name);
        try {
            const st = statSync(path);
            if (!st.isFile()) continue;
            const pid = Number(match[1]);
            const list = sets.get(pid) ?? [];
            list.push({ path, mtimeMs: st.mtimeMs });
            sets.set(pid, list);
        } catch {
            // vanished between readdir and stat
        }
    }
    let removed = 0;
    for (const [pid, files] of sets) {
        if (isPidAlive(pid)) continue;
        if (files.some((f) => now - f.mtimeMs <= minAgeMs)) continue;
        for (const f of files) {
            try {
                unlinkSync(f.path);
                removed++;
            } catch (error) {
                LOG.warn('DiskRetention', `Failed to delete ${f.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    if (removed > 0) LOG.info('DiskRetention', `Pruned ${removed} stale per-process seqscribe DB file(s)`);
    return removed;
}
