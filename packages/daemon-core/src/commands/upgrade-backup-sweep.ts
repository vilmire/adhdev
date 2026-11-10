/**
 * Boot-time cleanup of leftover `<configDir>/upgrade-backup-*` snapshots.
 *
 * upgrade-helper removes its snapshot on every success/rollback path, so survivors are leftovers of an
 * interrupted/failed upgrade (a disk-full death mid-install left 0.3 GiB each live). A daemon that is booting
 * is, by definition, a working install; a snapshot older than the grace period is dead weight unless the upgrade
 * journal still names it (a helper in flight, or a retained snapshot a stale journal documents).
 */
import * as fs from 'fs';
import * as path from 'path';
import { readPosixUpgradeJournal } from './posix-upgrade-health-gate.js';

export const UPGRADE_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKUP_PREFIX = 'upgrade-backup-';

export function sweepStaleUpgradeBackups(configDir: string, opts: { nowMs?: number; maxAgeMs?: number; log?: (m: string) => void } = {}): string[] {
    const now = opts.nowMs ?? Date.now();
    const maxAge = opts.maxAgeMs ?? UPGRADE_BACKUP_MAX_AGE_MS;
    const removed: string[] = [];
    let names: string[];
    try { names = fs.readdirSync(configDir).filter(n => n.startsWith(BACKUP_PREFIX)); } catch { return removed; }
    const referenced = readPosixUpgradeJournal(configDir)?.backupDir;
    const referencedResolved = referenced ? path.resolve(referenced) : null;
    for (const name of names) {
        const dir = path.join(configDir, name);
        if (referencedResolved === path.resolve(dir)) continue;
        try {
            const st = fs.lstatSync(dir);
            if (!st.isDirectory() || now - st.mtimeMs <= maxAge) continue;
            fs.rmSync(dir, { recursive: true, force: true });
            removed.push(dir);
            opts.log?.(`Removed stale upgrade backup ${dir} (age ${Math.round((now - st.mtimeMs) / 3600_000)} h)`);
        } catch { /* locked or raced: next boot */ }
    }
    return removed;
}
