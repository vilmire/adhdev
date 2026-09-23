/**
 * WAL checkpoint scheduling for MeshRuntimeStore, off the write path.
 *
 * IPC load audit 2026-09-23 (Phase P, audit table row 7): the store used to stat the
 * WAL file every 500 writes and, when it was over 50 MB, run a synchronous
 * `wal_checkpoint(TRUNCATE)` inside whatever write happened to be the 500th. On the
 * preview daemon the WAL sat at ~196 MB, so that forced TRUNCATE kept firing on hot
 * paths (ledger appends, queue updates). A TRUNCATE checkpoint also waits on the
 * busy handler (5 s) for readers — MCP processes open this DB directly — so one
 * unlucky write could stall the event loop for seconds.
 *
 * Now a write only bumps a counter and a timestamp. A timer does the rest:
 *   - every interval with writes since the last tick: `wal_checkpoint(PASSIVE)`,
 *     which never waits on readers or writers;
 *   - WAL over the size threshold AND no write for `idleMs`: `wal_checkpoint(TRUNCATE)`
 *     with the busy timeout dropped to 0 for that one statement, so a reader holding a
 *     snapshot makes it return busy instead of blocking. A busy result stays pending and
 *     is retried on the next idle tick.
 * The threshold (50 MB) is unchanged. `journal_size_limit` is set to the same value so
 * SQLite itself shrinks the WAL back to the limit whenever a checkpoint lets it restart
 * from the beginning — before this the file only ever shrank on a TRUNCATE.
 *
 * The timer is created lazily on the first write and unref'd, so a store that is only
 * read (or a short-lived MCP process) never holds the event loop open.
 */

import { existsSync, statSync } from 'fs';
import { LOG } from '../logging/logger.js';
import type { Database as DatabaseHandle } from 'better-sqlite3';

export interface WalCheckpointPolicy {
    /** Timer period. */
    intervalMs: number;
    /** WAL size above which an idle TRUNCATE is attempted. */
    maxBytes: number;
    /** Quiet period (no writes) before a TRUNCATE is allowed. */
    idleMs: number;
    /** Busy timeout restored after the non-blocking TRUNCATE attempt. */
    busyTimeoutMs: number;
}

export const DEFAULT_WAL_CHECKPOINT_POLICY: WalCheckpointPolicy = {
    intervalMs: 30_000,
    maxBytes: 50 * 1024 * 1024,
    idleMs: 10_000,
    busyTimeoutMs: 5_000,
};

export type WalCheckpointAction = 'none' | 'passive' | 'truncate' | 'truncate_busy';

export class WalCheckpointScheduler {
    /** Writes since the last tick. Read by tests through the store (`walWriteCounter`). */
    writesSinceTick = 0;
    private lastWriteAt = 0;
    /** The WAL was over the threshold on a tick that was not idle (or TRUNCATE was busy). */
    private truncatePending = false;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly db: DatabaseHandle,
        private readonly walPath: string,
        private readonly policy: WalCheckpointPolicy = DEFAULT_WAL_CHECKPOINT_POLICY,
    ) {}

    /** Called on every checkpoint-relevant write. O(1): no stat, no pragma. */
    noteWrite(now: number = Date.now()): void {
        this.writesSinceTick++;
        this.lastWriteAt = now;
        if (!this.timer) {
            this.timer = setInterval(() => { this.tick(); }, this.policy.intervalMs);
            this.timer.unref?.();
        }
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** One scheduler pass. Public for tests; production calls it only from the timer. */
    tick(now: number = Date.now()): WalCheckpointAction {
        const writes = this.writesSinceTick;
        if (writes === 0 && !this.truncatePending) return 'none';
        this.writesSinceTick = 0;
        try {
            const size = existsSync(this.walPath) ? statSync(this.walPath).size : 0;
            const overThreshold = size >= this.policy.maxBytes;
            const idle = now - this.lastWriteAt >= this.policy.idleMs;
            if (overThreshold && idle) {
                // Pending until proven done: a thrown SQLITE_BUSY lands in the catch below.
                this.truncatePending = true;
                const busy = this.truncateWithoutWaiting();
                this.truncatePending = busy;
                if (busy) {
                    LOG.info('MeshRuntimeStore', `WAL ${Math.round(size / 1024 / 1024)}MB over threshold; idle TRUNCATE checkpoint was busy (a reader holds a snapshot), will retry`);
                    return 'truncate_busy';
                }
                LOG.info('MeshRuntimeStore', `WAL ${Math.round(size / 1024 / 1024)}MB over threshold; truncated during an idle window`);
                return 'truncate';
            }
            this.truncatePending = overThreshold;
            if (writes > 0) {
                this.db.pragma('wal_checkpoint(PASSIVE)');
                return 'passive';
            }
            return 'none';
        } catch {
            return 'none'; // best-effort: a checkpoint failure must never surface to a caller
        }
    }

    /** TRUNCATE with busy_timeout 0 for this one statement. Returns true when busy. */
    private truncateWithoutWaiting(): boolean {
        this.db.pragma('busy_timeout = 0');
        try {
            const rows = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }> | undefined;
            return Array.isArray(rows) && rows[0]?.busy === 1;
        } finally {
            this.db.pragma(`busy_timeout = ${this.policy.busyTimeoutMs}`);
        }
    }
}
