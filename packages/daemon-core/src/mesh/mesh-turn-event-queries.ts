/**
 * `mesh_turn_events` queries that are scoped by KIND rather than by task.
 *
 * Split out of MeshRuntimeStore so the store file stays under the file-size
 * gate's frozen baseline — the gate explicitly asks for decomposition rather
 * than a raised limit. The store keeps thin delegating methods (its `db` handle
 * is private, so the statements must be issued through it); the SQL and the row
 * mapping live here.
 *
 * ★These probe by (mesh_id, kind) with no task_id. The long-standing
 * idx_mesh_turn_events_task index is (mesh_id, task_id, kind) — task_id sits
 * BETWEEN the two matched columns, so it cannot serve them. The companion
 * idx_mesh_turn_events_kind (mesh_id, kind, recorded_at) exists for exactly
 * these two statements, and covers both the newest-first scan and the
 * age-bounded delete.
 */

/** The `better-sqlite3` surface these helpers need, without importing the driver. */
export interface TurnEventQueryDb {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): { changes?: number };
    };
}

export interface TurnEventRow {
    eventId: string;
    attemptId: string;
    taskId: string;
    kind: string;
    dedupeKey: string;
    payload: string;
    occurredAtMs: number | null;
    recordedAt: string;
}

/** All events for one task, oldest first — the long-standing by-task read. */
export function selectTurnEventsForTask(
    db: TurnEventQueryDb,
    meshId: string,
    taskId: string,
): Omit<TurnEventRow, 'taskId'>[] {
    const rows = db.prepare(`
        SELECT * FROM mesh_turn_events WHERE mesh_id = ? AND task_id = ? ORDER BY recorded_at ASC, event_id ASC
    `).all(meshId, taskId) as Array<Record<string, unknown>>;
    return rows.map(r => ({
        eventId: r.event_id as string,
        attemptId: r.attempt_id as string,
        kind: r.kind as string,
        dedupeKey: (r.dedupe_key as string) ?? '',
        payload: r.payload as string,
        occurredAtMs: r.occurred_at_ms as number | null,
        recordedAt: r.recorded_at as string,
    }));
}

/** All events of one kind on a mesh, newest first. */
export function selectTurnEventsByKind(
    db: TurnEventQueryDb,
    meshId: string,
    kind: string,
    limit: number,
): TurnEventRow[] {
    const rows = db.prepare(`
        SELECT * FROM mesh_turn_events WHERE mesh_id = ? AND kind = ?
        ORDER BY recorded_at DESC, event_id DESC LIMIT ?
    `).all(meshId, kind, Math.max(1, Math.floor(limit))) as Array<Record<string, unknown>>;
    return rows.map(r => ({
        eventId: r.event_id as string,
        attemptId: r.attempt_id as string,
        taskId: r.task_id as string,
        kind: r.kind as string,
        dedupeKey: (r.dedupe_key as string) ?? '',
        payload: r.payload as string,
        occurredAtMs: r.occurred_at_ms as number | null,
        recordedAt: r.recorded_at as string,
    }));
}

/**
 * Delete events of one kind recorded before `cutoffIso`. Returns the row count
 * so a retention sweep can log what it removed instead of sweeping silently.
 *
 * `meshId` omitted ⇒ every mesh. The retention pass wants that: it runs on a
 * timer with no mesh list in hand, and making it enumerate meshes first would
 * let the sweep silently skip any mesh absent from whichever list it consulted.
 */
export function deleteTurnEventsByKindOlderThan(
    db: TurnEventQueryDb,
    kind: string,
    cutoffIso: string,
    meshId?: string,
): number {
    const info = meshId
        ? db.prepare(`
            DELETE FROM mesh_turn_events WHERE mesh_id = ? AND kind = ? AND recorded_at < ?
        `).run(meshId, kind, cutoffIso)
        : db.prepare(`
            DELETE FROM mesh_turn_events WHERE kind = ? AND recorded_at < ?
        `).run(kind, cutoffIso);
    return info.changes ?? 0;
}
