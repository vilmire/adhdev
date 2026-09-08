/**
 * `mesh_turn_events` queries that are scoped by KIND rather than by task, plus
 * the turn-table retention prune and its cascade into the two child tables.
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

/**
 * The one `mesh_turn_events.kind` the retention cascade must NOT collect, because
 * another sweep already owns its lifetime: `worker_handoff_note` rows are pruned
 * by pruneExpiredHandoffNotes (worker-handoff-notes.ts) on a note-age anchor, and
 * that sweep also mirrors its cutoff onto an in-memory text store. Cascading them
 * here would drop the index row while the text still lived.
 *
 * Duplicated as a literal rather than imported: the canonical definition is
 * WORKER_HANDOFF_EVENT_KIND in worker-report.ts, which imports mesh-runtime-store.ts,
 * which imports THIS file — a static import back would close an import cycle (same
 * reason as the registerLedgerBulkChangeListener hook in
 * mesh-runtime-store-turn-rows.ts). The two are pinned together by a parity
 * assertion in mesh-lifecycle-retention.test.ts.
 */
const TURN_EVENT_KIND_OWNED_ELSEWHERE = 'worker_handoff_note';

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

/**
 * Delete every event belonging to the given attempts — the CASCADE half of the
 * mesh_turn_attempts retention prune.
 *
 * ★Cascade, deliberately NOT an independent age window. `mesh_turn_events` has
 * no foreign key to `mesh_turn_attempts` (see the CREATE TABLE in
 * mesh-runtime-store.ts), so nothing removes these rows when their parent goes.
 * Giving them their own TTL instead would produce the strictly worse state of a
 * LIVE attempt whose causal event log has been silently truncated underneath it:
 * the reducer reads events by attempt to reconstruct what already happened, and
 * a half-empty log reads as "it never happened". Tying the lifetime to the
 * parent means an attempt either has its full history or is gone entirely.
 *
 * `excludeKinds` carries the one exception: `worker.handoff` events are owned by
 * pruneExpiredHandoffNotes (worker-handoff-notes.ts), which anchors them to note
 * age under an owner-decided 30-day rule and mirrors the same cutoff onto an
 * in-memory text store. Cascading them here would delete the index row while
 * that text store still held the note, so the two sweeps would disagree. Leaving
 * them to their own sweep is the "longer of the two" resolution — the note
 * survives its parent attempt and is collected on its own schedule.
 *
 * Chunked to stay under SQLite's bind-parameter limit, same as
 * pruneTerminalQueueEntries.
 */
export function deleteTurnEventsForAttempts(
    db: TurnEventQueryDb,
    attemptIds: string[],
    excludeKinds: string[] = [],
): number {
    let removed = 0;
    const kindFilter = excludeKinds.length
        ? ` AND kind NOT IN (${excludeKinds.map(() => '?').join(',')})`
        : '';
    for (let i = 0; i < attemptIds.length; i += 500) {
        const chunk = attemptIds.slice(i, i + 500);
        const info = db.prepare(`
            DELETE FROM mesh_turn_events
            WHERE attempt_id IN (${chunk.map(() => '?').join(',')})${kindFilter}
        `).run(...chunk, ...excludeKinds);
        removed += info.changes ?? 0;
    }
    return removed;
}

/**
 * Delete held-suspension rows belonging to the given attempts (same cascade).
 *
 * ★`status = 'held'` rows are NEVER deleted here regardless of age. A held row
 * is an UNRESOLVED waiting_approval/waiting_choice edge that the restart
 * reconcile drain still has to apply; dropping one silently loses a suspension
 * the FSM was going to replay. Only rows a terminal commit already resolved
 * (status != 'held') are collectable, and even those only when their parent
 * attempt is being removed.
 */
export function deleteHeldSuspensionsForAttempts(
    db: TurnEventQueryDb,
    attemptIds: string[],
): number {
    let removed = 0;
    for (let i = 0; i < attemptIds.length; i += 500) {
        const chunk = attemptIds.slice(i, i + 500);
        const info = db.prepare(`
            DELETE FROM mesh_turn_held_suspensions
            WHERE attempt_id IN (${chunk.map(() => '?').join(',')})
              AND status != 'held'
        `).run(...chunk);
        removed += info.changes ?? 0;
    }
    return removed;
}

/**
 * Retention prune for TERMINAL mesh_turn_attempts rows, cascading to the two
 * child tables (mesh_turn_events, mesh_turn_held_suspensions). The turn tables
 * were the remaining unbounded growth in mesh-runtime.db: every dispatched turn
 * writes one attempt row plus its causal event log, and nothing ever deleted
 * them. Window is env-tunable (resolveTurnAttemptRetentionMs, clamped [1d, 90d])
 * and read at sweep time.
 *
 * Caller wraps this in the store's transaction, so the candidate SELECT and the
 * three DELETEs commit as one unit.
 *
 * This is deliberately NOT a plain age TTL. Three exclusions, each protecting a
 * reader that would otherwise silently lose state:
 *
 *  1. NONTERMINAL rows (terminal_outcome IS NULL) are never deleted at any age.
 *     They are the recovery set — listActiveTurnAttempts feeds the restart
 *     reconcile drain, and a nonterminal row that is old is precisely the stuck
 *     turn that most needs recovering, not the one safest to drop.
 *
 *  2. The NEWEST attempt of each session survives regardless of age.
 *     getLatestTurnAttemptForSession resolves by session_id with NO time bound
 *     and backs the presented session status (mesh-turn-presentation.ts), so
 *     deleting a session's last row does not age out history — it blanks the
 *     session's displayed state. One row per session is a trivial floor.
 *
 *  3. Attempts still carrying an UNRESOLVED held suspension (status = 'held')
 *     are kept. Such a row is a waiting_* edge the reconcile drain has yet to
 *     apply; the child row must outlive the sweep, and keeping the parent with
 *     it is what stops the cascade from manufacturing an orphan.
 *
 * Age is measured from terminal_at (when the attempt actually finished), not
 * updated_at, so a late bookkeeping touch cannot extend the window. Timestamps
 * are ISO-8601 TEXT, so the lexicographic `<` cutoff is a correct time
 * comparison and a row exactly AT the cutoff is kept (strict `<`).
 *
 * Returns per-table row counts (content-free metrics; never payload content).
 */
export function pruneTerminalTurnAttemptsWithCascade(
    db: TurnEventQueryDb,
    olderThanMs: number,
): { attempts: number; events: number; heldSuspensions: number } {
    const cutoffIso = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
    const candidates = db.prepare(`
        SELECT a.attempt_id FROM mesh_turn_attempts a
        WHERE a.terminal_outcome IS NOT NULL
          AND a.terminal_at IS NOT NULL
          AND a.terminal_at < ?
          -- (2) keep each session's newest attempt, whatever its age. A row is
          -- deletable only if some OTHER attempt of the same session ranks ahead
          -- of it under getLatestTurnAttemptForSession's ordering (updated_at
          -- DESC, attempt_seq DESC) — i.e. it is not the row that read returns.
          -- Rows with a NULL session_id are unreachable by that read.
          AND (
              a.session_id IS NULL
              OR EXISTS (
                  SELECT 1 FROM mesh_turn_attempts b
                  WHERE b.session_id = a.session_id
                    AND b.attempt_id != a.attempt_id
                    AND (b.updated_at > a.updated_at
                         OR (b.updated_at = a.updated_at AND b.attempt_seq > a.attempt_seq))
              )
          )
          -- (3) keep anything with an unresolved held suspension
          AND NOT EXISTS (
              SELECT 1 FROM mesh_turn_held_suspensions h
              WHERE h.attempt_id = a.attempt_id AND h.status = 'held'
          )
    `).all(cutoffIso) as Array<{ attempt_id: string }>;
    const deletable = candidates.map(r => r.attempt_id);
    if (deletable.length === 0) return { attempts: 0, events: 0, heldSuspensions: 0 };

    const events = deleteTurnEventsForAttempts(db, deletable, [TURN_EVENT_KIND_OWNED_ELSEWHERE]);
    const heldSuspensions = deleteHeldSuspensionsForAttempts(db, deletable);
    let attempts = 0;
    for (let i = 0; i < deletable.length; i += 500) {
        const chunk = deletable.slice(i, i + 500);
        attempts += db.prepare(
            `DELETE FROM mesh_turn_attempts WHERE attempt_id IN (${chunk.map(() => '?').join(',')})`
        ).run(...chunk).changes ?? 0;
    }
    return { attempts, events, heldSuspensions };
}
