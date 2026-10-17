/**
 * Durable relay store over `mesh-runtime.db` (design 2026-10-07-assistant-layer.md
 * §4.6, §4.8 "데몬 재시작": thread and relay rows survive a restart, so an
 * undelivered relay becomes backlog instead of being lost).
 *
 * Same port as `InMemoryAssistantRelayStore`; the tables are created by
 * `ensureAssistantRelaySchema` (mesh/mesh-runtime-store-schema.ts, run by
 * `MeshRuntimeStore.migrate`). Report bodies stay local with bounded retention.
 *
 * `AssistantMetricsStore` is the local `assistant_metric_daily` counter table
 * (§1 M1–M7). Nothing here is sent anywhere.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import {
    ATTEMPT_BODY_TTL_MS, ATTEMPT_BODY_MAX_CHARS, ATTEMPT_BODY_MAX_ROWS, ATTEMPT_BODY_TOTAL_BYTES,
    RELAY_DELIVERED_RETENTION_MS,
    THREAD_CLOSED_RETENTION_MS,
    evidencePrefixMatches,
    toUnrenderedCounts,
    type AttemptBodyMeta,
    type AssistantRelayRow,
    type AssistantRelayStore,
    type AssistantThreadRow,
    type UnrenderedRelayCounts,
    type VerifiedAttemptBody,
} from './assistant-relay-store.js';

interface ThreadDbRow { mesh_id: string; opened_at: number; last_send_at: number; closed_at: number | null }
interface RelayDbRow {
    attempt_id: string; mesh_id: string; coordinator_session_id: string;
    committed_at: number; delivered_at: number | null; relayed_at: number | null; kind: string; outcome: string;
}

function toThread(r: ThreadDbRow): AssistantThreadRow {
    return { meshId: r.mesh_id, openedAt: r.opened_at, lastSendAt: r.last_send_at, closedAt: r.closed_at ?? null };
}

function toRelay(r: RelayDbRow): AssistantRelayRow {
    return {
        attemptId: r.attempt_id,
        meshId: r.mesh_id,
        coordinatorSessionId: r.coordinator_session_id,
        committedAt: r.committed_at,
        deliveredAt: r.delivered_at ?? null,
        relayedAt: r.relayed_at ?? null,
        kind: 'relay',
        outcome: r.outcome,
    };
}

export class SqliteAssistantRelayStore implements AssistantRelayStore {
    constructor(private readonly db: DatabaseHandle) {}

    openThread(meshId: string, at: number): void {
        // An open thread keeps its openedAt and refreshes lastSendAt; a closed (or
        // absent) one starts over.
        this.db.prepare(`
            INSERT INTO assistant_threads (mesh_id, opened_at, last_send_at, closed_at) VALUES (?, ?, ?, NULL)
            ON CONFLICT(mesh_id) DO UPDATE SET
                opened_at = CASE WHEN assistant_threads.closed_at IS NULL THEN assistant_threads.opened_at ELSE excluded.opened_at END,
                last_send_at = excluded.last_send_at,
                closed_at = NULL
        `).run(meshId, at, at);
    }

    closeThread(meshId: string, at: number): void {
        this.db.prepare('UPDATE assistant_threads SET closed_at = ? WHERE mesh_id = ? AND closed_at IS NULL').run(at, meshId);
    }

    isThreadOpen(meshId: string): boolean {
        return !!this.db.prepare('SELECT 1 FROM assistant_threads WHERE mesh_id = ? AND closed_at IS NULL').get(meshId);
    }

    openThreads(): AssistantThreadRow[] {
        return (this.db.prepare('SELECT * FROM assistant_threads WHERE closed_at IS NULL ORDER BY mesh_id').all() as ThreadDbRow[]).map(toThread);
    }

    recordCommitted(row: Omit<AssistantRelayRow, 'deliveredAt' | 'relayedAt'>): boolean {
        const r = this.db.prepare(`
            INSERT OR IGNORE INTO assistant_relays (attempt_id, mesh_id, coordinator_session_id, committed_at, delivered_at, relayed_at, kind, outcome)
            VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
        `).run(row.attemptId, row.meshId, row.coordinatorSessionId, row.committedAt, row.kind, row.outcome);
        return r.changes > 0;
    }

    markDelivered(attemptIds: readonly string[], at: number, rendered?: readonly string[]): void {
        if (!attemptIds.length) return;
        const sent = new Set(rendered ?? attemptIds);
        const stmt = this.db.prepare('UPDATE assistant_relays SET delivered_at = ?, relayed_at = ? WHERE attempt_id = ? AND delivered_at IS NULL');
        this.db.transaction((ids: readonly string[]) => {
            for (const id of ids) stmt.run(at, sent.has(id) ? at : null, id);
        })(attemptIds);
    }

    listUndelivered(): AssistantRelayRow[] {
        return (this.db.prepare('SELECT * FROM assistant_relays WHERE delivered_at IS NULL ORDER BY committed_at, attempt_id').all() as RelayDbRow[]).map(toRelay);
    }

    countUnrendered(): UnrenderedRelayCounts {
        const rows = this.db.prepare(
            'SELECT mesh_id, COUNT(*) AS n FROM assistant_relays WHERE delivered_at IS NOT NULL AND relayed_at IS NULL GROUP BY mesh_id',
        ).all() as Array<{ mesh_id: string; n: number }>;
        return toUnrenderedCounts(new Map(rows.map((r) => [r.mesh_id, Number(r.n)])));
    }

    captureAttemptBody(attemptId: string, meshId: string, sessionId: string, body: string, at: number, evidenceRef: string, meta?: AttemptBodyMeta): void {
        if (!evidenceRef || !body || body.length > ATTEMPT_BODY_MAX_CHARS) return; // never truncate an exact report
        if (meta?.completeness === 'envelope_unverified') return; // never persist an unverified body as exact
        const partsJson = JSON.stringify(meta?.parts ?? []);
        const completeness = meta?.completeness ?? null;
        this.db.transaction(() => {
            // Same evidence ref keeps the first exact body. A changed ref (v1 truncated
            // row, or a new parts hash) is replaced. A NULL ref is the legacy unproven row.
            this.db.prepare(`INSERT INTO assistant_attempt_bodies
                (attempt_id, mesh_id, coordinator_session_id, captured_at, body, evidence_ref, parts_json, completeness)
                SELECT attempt_id, mesh_id, coordinator_session_id, ?, ?, ?, ?, ? FROM assistant_relays
                WHERE attempt_id = ? AND mesh_id = ? AND coordinator_session_id = ?
                ON CONFLICT(attempt_id) DO UPDATE SET
                    body=excluded.body, captured_at=excluded.captured_at, evidence_ref=excluded.evidence_ref,
                    parts_json=excluded.parts_json, completeness=excluded.completeness
                WHERE assistant_attempt_bodies.mesh_id=excluded.mesh_id
                  AND assistant_attempt_bodies.coordinator_session_id=excluded.coordinator_session_id
                  AND (assistant_attempt_bodies.evidence_ref IS NULL OR assistant_attempt_bodies.evidence_ref != excluded.evidence_ref)`).run(at, body, evidenceRef, partsJson, completeness, attemptId, meshId, sessionId);
            this.pruneBodies(at);
        })();
    }

    readAttemptBody(attemptId: string, meshId: string, sessionId: string, now: number, evidenceRef: string): string | null {
        const row = this.db.prepare(`SELECT body FROM assistant_attempt_bodies
            WHERE attempt_id = ? AND mesh_id = ? AND coordinator_session_id = ? AND captured_at >= ? AND evidence_ref = ?`)
            .get(attemptId, meshId, sessionId, now - ATTEMPT_BODY_TTL_MS, evidenceRef) as { body: string } | undefined;
        return row?.body ?? null;
    }

    readVerifiedAttemptBody(attemptId: string, meshId: string, sessionId: string, now: number, stablePrefix: string): VerifiedAttemptBody | null {
        const row = this.db.prepare(`SELECT body, evidence_ref, parts_json, completeness FROM assistant_attempt_bodies
            WHERE attempt_id = ? AND mesh_id = ? AND coordinator_session_id = ? AND captured_at >= ?`)
            .get(attemptId, meshId, sessionId, now - ATTEMPT_BODY_TTL_MS) as { body: string; evidence_ref: string | null; parts_json: string | null; completeness: string | null } | undefined;
        if (!row?.evidence_ref || !evidencePrefixMatches(row.evidence_ref, stablePrefix)) return null;
        if (row.completeness && row.completeness !== 'final_native') return null;
        let parts: Array<{ at: number; chars: number }> = [];
        try {
            const parsed = JSON.parse(row.parts_json || '[]') as unknown;
            if (Array.isArray(parsed)) parts = parsed.filter((p): p is { at: number; chars: number } => !!p && typeof p === 'object' && typeof (p as { at?: unknown }).at === 'number');
        } catch { /* parts are optional for coverage */ }
        return { body: row.body, evidenceRef: row.evidence_ref, parts };
    }

    private pruneBodies(now: number): void {
        this.db.prepare('DELETE FROM assistant_attempt_bodies WHERE captured_at < ?').run(now - ATTEMPT_BODY_TTL_MS);
        const rows = this.db.prepare('SELECT attempt_id, length(CAST(body AS BLOB)) AS bytes FROM assistant_attempt_bodies ORDER BY captured_at DESC, attempt_id DESC')
            .all() as Array<{ attempt_id: string; bytes: number }>;
        let total = 0, count = 0;
        const drop = this.db.prepare('DELETE FROM assistant_attempt_bodies WHERE attempt_id = ?');
        for (const row of rows) {
            if (++count > ATTEMPT_BODY_MAX_ROWS || total + row.bytes > ATTEMPT_BODY_TOTAL_BYTES) drop.run(row.attempt_id);
            else total += row.bytes;
        }
    }

    prune(now: number): void {
        this.pruneBodies(now);
        this.db.prepare('DELETE FROM assistant_relays WHERE delivered_at IS NOT NULL AND ? - delivered_at > ?').run(now, RELAY_DELIVERED_RETENTION_MS);
        this.db.prepare('DELETE FROM assistant_threads WHERE closed_at IS NOT NULL AND ? - closed_at > ?').run(now, THREAD_CLOSED_RETENTION_MS);
    }
}

// ── metrics ─────────────────────────────────────────────────────────────────

export const ASSISTANT_METRIC_COLUMNS = [
    'assistant_sends', 'human_sends', 'relays', 'project_reads', 'memory_writes', 'memory_discards',
    'skill_views', 'skill_attaches', 'skill_writes', 'review_turns', 'review_turns_with_writes',
    'review_writes_applied', 'review_writes_approved', 'relay_gaps',
] as const;
export type AssistantMetricColumn = typeof ASSISTANT_METRIC_COLUMNS[number];

export const ASSISTANT_METRIC_RETENTION_DAYS = 90;

/** Local calendar day `YYYY-MM-DD` (activity days are the owner's days). */
export function metricDay(at: number): string {
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type AssistantMetricRow = { day: string; meshId: string } & Record<AssistantMetricColumn, number>;

export class AssistantMetricsStore {
    constructor(private readonly db: DatabaseHandle) {}

    /** Add `n` to one counter of (day of `at`, mesh). Global counters use meshId ''. */
    bump(column: AssistantMetricColumn, meshId: string, at: number, n: number = 1): void {
        if (!(ASSISTANT_METRIC_COLUMNS as readonly string[]).includes(column)) throw new Error(`unknown metric column: ${column}`);
        if (!Number.isFinite(n) || n === 0) return;
        this.db.prepare(`
            INSERT INTO assistant_metric_daily (day, mesh_id, ${column}) VALUES (?, ?, ?)
            ON CONFLICT(day, mesh_id) DO UPDATE SET ${column} = ${column} + excluded.${column}
        `).run(metricDay(at), meshId, n);
    }

    rows(sinceDay?: string): AssistantMetricRow[] {
        const raw = (sinceDay
            ? this.db.prepare('SELECT * FROM assistant_metric_daily WHERE day >= ? ORDER BY day, mesh_id').all(sinceDay)
            : this.db.prepare('SELECT * FROM assistant_metric_daily ORDER BY day, mesh_id').all()) as Array<Record<string, unknown>>;
        return raw.map((r) => {
            const row = { day: String(r.day), meshId: String(r.mesh_id ?? '') } as AssistantMetricRow;
            for (const c of ASSISTANT_METRIC_COLUMNS) row[c] = Number(r[c] ?? 0);
            return row;
        });
    }

    /**
     * M7 (research 2026-10-08 Q7): one review-turn write landed — `applied`
     * directly (clean review window) or `approved` by the owner after staging.
     * Bumps the per-kind counter, and `review_turns_with_writes` only the first
     * time this review turn is credited. Global counters (mesh_id '').
     * A staged write that is discarded or expires never reaches here.
     */
    creditReviewWrite(reviewTurnId: string, kind: 'applied' | 'approved', at: number): void {
        if (!reviewTurnId) return;
        this.db.transaction(() => {
            this.bump(kind === 'applied' ? 'review_writes_applied' : 'review_writes_approved', '', at);
            const first = this.db.prepare('INSERT OR IGNORE INTO assistant_review_credit (review_turn_id, credited_at) VALUES (?, ?)').run(reviewTurnId, at).changes > 0;
            if (first) this.bump('review_turns_with_writes', '', at);
        })();
    }

    /** Drop rows older than the retention window (90 days). */
    prune(now: number): number {
        const cutoffMs = now - ASSISTANT_METRIC_RETENTION_DAYS * 24 * 60 * 60_000;
        this.db.prepare('DELETE FROM assistant_review_credit WHERE credited_at < ?').run(cutoffMs);
        return this.db.prepare('DELETE FROM assistant_metric_daily WHERE day < ?').run(metricDay(cutoffMs)).changes;
    }
}
