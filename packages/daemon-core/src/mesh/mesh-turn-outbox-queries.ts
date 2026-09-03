/**
 * `mesh_turn_outbox` queries — the turn outbox's entire SQL surface.
 *
 * ★★ REMOVED IN 5c together with `mesh_turn_outbox` itself
 * (docs/design/2026-08-29-seqscribe-outbox-migration.md §5 rows 1-3, 10).
 * This whole FILE is the 5c deletion unit: every statement here targets that
 * one table, and no symbol in it has a consumer that outlives the table. That
 * is also why this slice was chosen for the split — the file-size gate wanted a
 * decomposition, and the most defensible boundary is the one that is already
 * scheduled to be deleted wholesale, so 5c-1 becomes `rm` plus removing the
 * delegators rather than another round of surgery.
 *
 * Split out of MeshRuntimeStore so the store file stays under the file-size
 * gate's frozen baseline — the gate explicitly asks for decomposition rather
 * than a raised limit. Same pattern (and same reason) as
 * mesh-turn-event-queries.ts: the store keeps thin delegating methods because
 * its `db` handle is private, and the SQL plus row mapping live here.
 *
 * ★ Pure move: the statements, parameter order and row mapping are byte-for-byte
 * what MeshRuntimeStore ran before. The one thing deliberately NOT moved is
 * `maybeCheckpointWal()` — it is private class state (a write counter), so the
 * three mutating delegators still invoke it on the store side, preserving the
 * exact call order (statement first, then checkpoint).
 */

/** The `better-sqlite3` surface these helpers need, without importing the driver. */
export interface TurnOutboxQueryDb {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        get(...params: unknown[]): unknown;
        run(...params: unknown[]): { changes: number };
    };
}

/** A due outbox row, as the drain consumes it. */
export interface DueTurnOutboxRow {
    id: string;
    meshId: string;
    attemptId: string | null;
    taskId: string | null;
    kind: string;
    payload: string;
    attemptCount: number;
    createdAt: string;
}

/** Enqueue an outbound notification. INSERT OR IGNORE on the row id = exactly-once. */
export function insertTurnOutboxRow(db: TurnOutboxQueryDb, row: {
    id: string; meshId: string; attemptId?: string; taskId?: string;
    kind: string; payload?: string; nextAttemptAtMs?: number | null;
    createdAt: string; updatedAt: string;
}): boolean {
    const res = db.prepare(`
        INSERT OR IGNORE INTO mesh_turn_outbox (
            id, mesh_id, attempt_id, task_id, kind, payload, status, next_attempt_at_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
        row.id, row.meshId, row.attemptId ?? null, row.taskId ?? null,
        row.kind, row.payload ?? '{}', row.nextAttemptAtMs ?? null, row.createdAt, row.updatedAt,
    );
    return res.changes > 0;
}

/** Due pending outbox rows (status='pending', next_attempt_at_ms NULL or <= nowMs). */
export function selectDueTurnOutbox(
    db: TurnOutboxQueryDb,
    nowMs: number,
    meshId?: string,
): DueTurnOutboxRow[] {
    const rows = (meshId
        ? db.prepare(`
            SELECT * FROM mesh_turn_outbox
            WHERE status = 'pending' AND mesh_id = ? AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
            ORDER BY created_at ASC
        `).all(meshId, nowMs)
        : db.prepare(`
            SELECT * FROM mesh_turn_outbox
            WHERE status = 'pending' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
            ORDER BY created_at ASC
        `).all(nowMs)) as Array<Record<string, unknown>>;
    return rows.map(r => ({
        id: r.id as string,
        meshId: r.mesh_id as string,
        attemptId: r.attempt_id as string | null,
        taskId: r.task_id as string | null,
        kind: r.kind as string,
        payload: r.payload as string,
        attemptCount: r.attempt_count as number,
        createdAt: r.created_at as string,
    }));
}

/** Oldest pending outbox row age in ms (observability: outbox backlog age). */
export function selectOldestPendingTurnOutboxAgeMs(
    db: TurnOutboxQueryDb,
    nowMs: number,
): number | null {
    const row = db.prepare(`
        SELECT MIN(created_at) AS oldest FROM mesh_turn_outbox WHERE status = 'pending'
    `).get() as { oldest: string | null } | undefined;
    if (!row?.oldest) return null;
    const parsed = Date.parse(row.oldest);
    return Number.isNaN(parsed) ? null : Math.max(0, nowMs - parsed);
}

export function updateTurnOutboxDelivered(db: TurnOutboxQueryDb, id: string, updatedAt: string): void {
    db.prepare(`
        UPDATE mesh_turn_outbox SET status = 'delivered', updated_at = ? WHERE id = ? AND status = 'pending'
    `).run(updatedAt, id);
}

/** Record a failed delivery attempt and schedule the retry (or park as 'failed' when no retry remains). */
export function updateTurnOutboxAttemptFailed(
    db: TurnOutboxQueryDb,
    id: string,
    opts: { updatedAt: string; nextAttemptAtMs?: number | null; terminal?: boolean },
): void {
    if (opts.terminal) {
        db.prepare(`
            UPDATE mesh_turn_outbox SET status = 'failed', attempt_count = attempt_count + 1, updated_at = ?
            WHERE id = ? AND status = 'pending'
        `).run(opts.updatedAt, id);
    } else {
        db.prepare(`
            UPDATE mesh_turn_outbox SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'
        `).run(opts.nextAttemptAtMs ?? null, opts.updatedAt, id);
    }
}

/**
 * Task ids of outbox rows marked `delivered` AT OR AFTER `sinceIso`.
 *
 * ★ Why a `sinceIso` window rather than the whole table: `delivered` rows are
 * NEVER pruned (there is no `DELETE FROM mesh_turn_outbox` anywhere), so an
 * all-time enumeration is unbounded AND spans daemon generations the redrive
 * counterpart cannot possibly have seen. Windowing on `updated_at` — which
 * `updateTurnOutboxDelivered` stamps at the moment of delivery — restricts the
 * denominator to the same process lifetime the redrive set covers. See the
 * epoch note in mesh-turn-outbox-coverage-diagnostics.ts.
 *
 * Rows with a NULL task_id are excluded: the redrive path cannot re-arm a
 * task-less entry (`buildRedriveInjection` returns null for one), so counting
 * it against coverage would assert an impossible obligation.
 */
export function selectDeliveredTurnOutboxTaskIdsSince(
    db: TurnOutboxQueryDb,
    sinceIso: string,
    limit: number,
): string[] {
    const rows = db.prepare(`
        SELECT DISTINCT task_id FROM mesh_turn_outbox
        WHERE status = 'delivered' AND task_id IS NOT NULL AND updated_at >= ?
        ORDER BY updated_at ASC
        LIMIT ?
    `).all(sinceIso, limit) as Array<{ task_id: string }>;
    return rows.map(r => r.task_id);
}

export function countTurnOutboxRowsByStatus(
    db: TurnOutboxQueryDb,
    meshId?: string,
): Record<string, number> {
    const rows = (meshId
        ? db.prepare('SELECT status, COUNT(*) AS n FROM mesh_turn_outbox WHERE mesh_id = ? GROUP BY status').all(meshId)
        : db.prepare('SELECT status, COUNT(*) AS n FROM mesh_turn_outbox GROUP BY status').all()
    ) as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
}
