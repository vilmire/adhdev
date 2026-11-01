/**
 * Deferred execution of the assistant's own stop / restart / switch (design
 * 2026-11-01 §5.3, owner decision H5): the assistant cannot cut itself
 * mid-turn, so the request waits for the end of the current turn
 * (`turn{committed}`) and runs exactly once. One pending job at most; it is
 * persisted (`assistant_session_control`, single row) and restored once after a
 * daemon restart.
 */

import type { DeferredAssistantJob } from './session-control.js';

export interface PendingJobStore {
    read(): DeferredAssistantJob | null;
    write(job: DeferredAssistantJob): void;
    clear(): void;
}

export interface PendingSessionControlDeps {
    store: PendingJobStore;
    /** True while the assistant has an open turn (requests then wait for commit). */
    turnOpen(sessionId: string): boolean;
    /** Run one job now (stop; or stop + launch). */
    run(job: DeferredAssistantJob): Promise<{ success: boolean; code?: string; error?: string }>;
    /** Jobs older than this are dropped rather than run (stale owner intent). */
    maxAgeMs?: number;
    now?: () => number;
    log?(line: string): void;
}

export const PENDING_SESSION_CONTROL_MAX_AGE_MS = 30 * 60_000;

export class PendingSessionControl {
    private running = false;
    constructor(private readonly deps: PendingSessionControlDeps) {}

    /** Queue (or, when no turn is open, run at once). Replaces an earlier pending job. */
    async request(job: DeferredAssistantJob): Promise<{ success: boolean; queued?: boolean; code?: string; error?: string }> {
        if (!this.deps.turnOpen(job.sessionId)) {
            const out = await this.execute(job);
            return { success: out.success, queued: false, ...(out.code ? { code: out.code } : {}), ...(out.error ? { error: out.error } : {}) };
        }
        this.deps.store.write(job);
        this.deps.log?.(`[session-control] role=assistant action=${job.action} outcome=queued_until_turn_end`);
        return { success: true, queued: true };
    }

    /** `turn{committed}` for `sessionId`: run the pending job (once). */
    async onTurnCommitted(sessionId: string): Promise<void> {
        const job = this.deps.store.read();
        if (!job || job.sessionId !== sessionId) return;
        await this.execute(job);
    }

    /** After a daemon restart: run a still-fresh job, drop a stale one. */
    async restore(): Promise<void> {
        const job = this.deps.store.read();
        if (!job) return;
        await this.execute(job);
    }

    private async execute(job: DeferredAssistantJob): Promise<{ success: boolean; code?: string; error?: string }> {
        if (this.running) return { success: false, code: 'control_in_progress' };
        const now = (this.deps.now ?? Date.now)();
        if (now - job.requestedAt > (this.deps.maxAgeMs ?? PENDING_SESSION_CONTROL_MAX_AGE_MS)) {
            this.deps.store.clear();
            this.deps.log?.('[session-control] role=assistant outcome=dropped_stale');
            return { success: false, code: 'request_stale' };
        }
        this.running = true;
        // Clear BEFORE running: a crash mid-run must not replay a half-done stop.
        this.deps.store.clear();
        try {
            const out = await this.deps.run(job);
            this.deps.log?.(`[session-control] role=assistant action=${job.action} outcome=${out.success ? 'done' : out.code ?? 'failed'}`);
            return out;
        } finally {
            this.running = false;
        }
    }
}

type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };

/** SQLite-backed single-row store over `assistant_session_control`. */
export function createSqlitePendingJobStore(db: Db): PendingJobStore {
    return {
        read() {
            const row = db.prepare('SELECT job_json FROM assistant_session_control WHERE id = 1').get() as { job_json?: string } | undefined;
            if (!row?.job_json) return null;
            try { return JSON.parse(row.job_json) as DeferredAssistantJob; } catch { return null; }
        },
        write(job) {
            db.prepare('INSERT INTO assistant_session_control (id, job_json, requested_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET job_json = excluded.job_json, requested_at = excluded.requested_at')
                .run(JSON.stringify(job), job.requestedAt);
        },
        clear() { db.prepare('DELETE FROM assistant_session_control WHERE id = 1').run(); },
    };
}
