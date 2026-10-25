/** Bounded metadata-only native history traversal. Independent of delivery/read receipts. */
import type { Database } from 'better-sqlite3';
export interface NativeScanCheckpoint {
    version: 1; sessionId: string; scope: string; provenance: string;
    lower: number; upper: number; boundary: string; digest: string; boundaryAt: number;
    lastNativeTurnId: string | null; expiresAt: number;
}
export class NativeScanCheckpoints {
    constructor(private readonly db: Database) {
        db.exec(`CREATE TABLE IF NOT EXISTS assistant_native_scan_checkpoints (
            session_id TEXT PRIMARY KEY, version INTEGER NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL)`);
    }
    load(sessionId: string, scope: string, now: number): NativeScanCheckpoint | null {
        const row = this.db.prepare('SELECT version,expires_at,payload FROM assistant_native_scan_checkpoints WHERE session_id=?').get(sessionId) as { version: number; expires_at: number; payload: string } | undefined;
        try {
            const x = JSON.parse(row?.payload ?? 'null') as NativeScanCheckpoint | null;
            if (row?.version === 1 && row.expires_at === x?.expiresAt && x?.version === 1 && x.sessionId === sessionId && x.scope === scope && x.expiresAt > now
                && x.expiresAt <= now + 60 * 60_000 && x.lower > 0 && x.lower <= x.boundaryAt && x.boundaryAt <= x.upper
                && x.upper <= now && typeof x.provenance === 'string' && x.provenance.length <= 1024
                && typeof x.boundary === 'string' && x.boundary.length > 0 && x.boundary.length <= 1024
                && /^[a-f0-9]{64}$/.test(x.digest)) return x;
        } catch { /* Unknown version/malformed metadata safely replays. */ }
        this.reset(sessionId);
        return null;
    }
    save(value: NativeScanCheckpoint): void {
        this.db.prepare('INSERT OR REPLACE INTO assistant_native_scan_checkpoints VALUES(?,?,?,?)')
            .run(value.sessionId, 1, value.expiresAt, JSON.stringify(value));
        this.db.exec(`DELETE FROM assistant_native_scan_checkpoints WHERE session_id NOT IN
            (SELECT session_id FROM assistant_native_scan_checkpoints ORDER BY expires_at DESC, session_id LIMIT 128)`);
    }
    reset(sessionId: string): void { this.db.prepare('DELETE FROM assistant_native_scan_checkpoints WHERE session_id=?').run(sessionId); }
}
