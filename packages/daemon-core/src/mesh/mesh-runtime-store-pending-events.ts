/**
 * MeshRuntimeStore G3 pending-coordinator-event persistence — extracted from
 * mesh-runtime-store.ts (behavior-preserving code move, file-size gate).
 *
 * Same contract as the sibling mesh-runtime-store-turn-attempts.ts: these were
 * `MeshRuntimeStore` methods and now take the store as `self`; the class keeps
 * thin delegating wrappers so every call site is unchanged. No SQL string,
 * WAL-checkpoint order, error handling, or result shape was changed — only
 * physical location + `this.` -> `self.`.
 */

import type { MeshRuntimeStore } from './mesh-runtime-store.js';

// ── G3: Pending Coordinator Events ──────────────────────────────────────

export function insertPendingEvent(self: MeshRuntimeStore, event: {
    id: string;
    meshId: string;
    coordinatorDaemonId?: string | null;
    event: string;
    payload?: unknown;
    fingerprint?: string | null;
    queuedAt: number;
    // v2 envelope columns (B2a) — all optional so v1 callers/rows are unaffected.
    // dispatchedBy / intendedFor are pre-serialized CoordinatorIdentity JSON.
    protocolVersion?: string | null;
    eventId?: string | null;
    scope?: string | null;
    dispatchedBy?: string | null;
    intendedFor?: string | null;
}): boolean {
    const result = self.db.prepare(
        `INSERT OR IGNORE INTO mesh_pending_events
         (id, mesh_id, coordinator_daemon_id, event, payload, fingerprint, queued_at,
          protocol_version, event_id, scope, dispatched_by, intended_for)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        event.id,
        event.meshId,
        event.coordinatorDaemonId ?? null,
        event.event,
        JSON.stringify(event.payload ?? {}),
        event.fingerprint ?? null,
        event.queuedAt,
        event.protocolVersion ?? null,
        event.eventId ?? null,
        event.scope ?? null,
        event.dispatchedBy ?? null,
        event.intendedFor ?? null,
    );
    self.maybeCheckpointWal();
    return result.changes > 0;
}


/**
 * Drain undrained pending events for a mesh, atomically marking them drained.
 * When `opts.onlyEvents` is supplied, ONLY rows whose `event` is in that set are
 * drained — the rest stay queued (drained=0) for a later drain. This is how the
 * reconcile loop force-drains terminal/force-inject events into a *generating*
 * coordinator while leaving non-force progress events for the coordinator's next
 * idle transition. Filtering happens inside the same transaction as the
 * drained=1 marking, so force-drain + a concurrent full drain can never both
 * consume the same row.
 */
export function drainPendingEvents(self: MeshRuntimeStore, 
    meshId: string,
    coordinatorDaemonId?: string | null | ReadonlyArray<string>,
    // `drainedBy` (REFINE-EVENT-SESSION-SCOPED-UNICAST) is the pre-serialized
    // drainer CoordinatorIdentity JSON, recorded on the rows this call consumes so
    // a mis-delivered unicast is auditable after the fact instead of inferred.
    // Omitted → the column stays NULL, exactly as before (no behaviour change).
    opts?: { onlyEvents?: ReadonlySet<string>; drainedBy?: string | null },
): Array<{ id: string; event: string; payload: unknown }> {
    return self.transaction(() => {
        const onlyEvents = opts?.onlyEvents;
        // An explicit-but-empty filter means "drain nothing" (no event name can match).
        if (onlyEvents && onlyEvents.size === 0) return [];
        const eventList = onlyEvents ? [...onlyEvents] : [];
        // A coordinator daemon can answer to more than one id form: its canonical
        // status id (e.g. `standalone_<machineId>` / `daemon_<machineId>`, which the
        // MCP layer stamps via ctx.localDaemonId) AND the bare machineId (stamped by
        // the local queue-assignment path). Accept ANY of them so a unicast event
        // stamped with either id is drained here. Unscoped (NULL) rows always match.
        const daemonIds = (Array.isArray(coordinatorDaemonId)
            ? coordinatorDaemonId
            : coordinatorDaemonId ? [coordinatorDaemonId] : [])
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        // Filter by event name IN-SQL when onlyEvents is set so the LIMIT applies to
        // matching rows — a long run of non-force events ahead in the queue must not
        // crowd a force event out of the 100-row window.
        const clauses = ['mesh_id = ?', 'drained = 0'];
        const params: unknown[] = [meshId];
        if (daemonIds.length > 0) {
            clauses.push(`(coordinator_daemon_id IS NULL OR coordinator_daemon_id IN (${daemonIds.map(() => '?').join(',')}))`);
            params.push(...daemonIds);
        }
        if (eventList.length > 0) {
            clauses.push(`event IN (${eventList.map(() => '?').join(',')})`);
            params.push(...eventList);
        }
        const rows = self.db.prepare(
            `SELECT id, event, payload FROM mesh_pending_events WHERE ${clauses.join(' AND ')} ORDER BY queued_at ASC LIMIT 100`
        ).all(...params) as Array<{ id: string; event: string; payload: string }>;
        if (rows.length === 0) return [];
        const ids = rows.map(r => r.id);
        const now = Date.now();
        self.db.prepare(
            `UPDATE mesh_pending_events SET drained = 1, drained_at = ?, drained_by = ? WHERE id IN (${ids.map(() => '?').join(',')})`
        ).run(now, opts?.drainedBy ?? null, ...ids);
        return rows.map(r => ({
            id: r.id,
            event: r.event,
            payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
        }));
    });
}


/** Non-destructive peek — returns undrained events without marking them drained. */
export function peekPendingEvents(self: MeshRuntimeStore, meshId: string, coordinatorDaemonId?: string | null | ReadonlyArray<string>): Array<{ id: string; event: string; payload: unknown }> {
    const daemonIds = (Array.isArray(coordinatorDaemonId)
        ? coordinatorDaemonId
        : coordinatorDaemonId ? [coordinatorDaemonId] : [])
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const whereClause = daemonIds.length > 0
        ? `WHERE mesh_id = ? AND drained = 0 AND (coordinator_daemon_id IS NULL OR coordinator_daemon_id IN (${daemonIds.map(() => '?').join(',')}))`
        : `WHERE mesh_id = ? AND drained = 0`;
    const params: unknown[] = daemonIds.length > 0 ? [meshId, ...daemonIds] : [meshId];
    const rows = self.db.prepare(
        `SELECT id, event, payload FROM mesh_pending_events ${whereClause} ORDER BY queued_at ASC LIMIT 100`
    ).all(...params) as Array<{ id: string; event: string; payload: string }>;
    return rows.map(r => ({
        id: r.id,
        event: r.event,
        payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
    }));
}


/**
 * REFINE-EVENT-SESSION-SCOPED-UNICAST — drain attribution audit. Returns the most
 * recent pending-event rows for a mesh with WHO drained each one, so a suspected
 * mis-delivery ("my refine result went to another coordinator session") is answered
 * from the ledger instead of inferred from timing. `drainedBy` is the serialized
 * drainer CoordinatorIdentity, or null when the row is still queued, was drained
 * before this column existed, or was drained by a caller that passed no identity.
 */
export function recentDrainedPendingEvents(self: MeshRuntimeStore, meshId: string, limit = 100): Array<{
    id: string;
    event: string;
    scope: string | null;
    intendedFor: string | null;
    drainedBy: string | null;
    drained: boolean;
    queuedAt: number;
    drainedAt: number | null;
}> {
    const rows = self.db.prepare(
        `SELECT id, event, scope, intended_for, drained_by, drained, queued_at, drained_at
         FROM mesh_pending_events WHERE mesh_id = ? ORDER BY queued_at DESC LIMIT ?`
    ).all(meshId, Math.max(1, limit)) as Array<Record<string, unknown>>;
    return rows.map(r => ({
        id: r.id as string,
        event: r.event as string,
        scope: (r.scope as string | null) ?? null,
        intendedFor: (r.intended_for as string | null) ?? null,
        drainedBy: (r.drained_by as string | null) ?? null,
        drained: r.drained === 1,
        queuedAt: r.queued_at as number,
        drainedAt: (r.drained_at as number | null) ?? null,
    }));
}


/**
 * ENTER-LOSS layer ③ (boot-time composer-residue sweep) — recently-DRAINED
 * pending-event rows across ALL meshes, payloads included. The sweep matches
 * each payload's coordinatorMessage against the composer text of restored
 * idle sessions: an event is marked drained BEFORE its body is written to the
 * PTY (the consume-before-submit ordering this incident class exploits), so a
 * body stranded in a composer by a mid-submit daemon death is identifiable
 * ONLY from these drained rows — the undrained queue no longer holds it.
 * Drained rows are soft-marked (retained until mesh deletion), so this reads
 * history, not live queue state.
 */
export function recentDrainedPendingEventPayloads(self: MeshRuntimeStore, sinceEpochMs: number, limit = 200): Array<{
    id: string;
    meshId: string;
    event: string;
    payload: unknown;
    drainedAt: number;
}> {
    const rows = self.db.prepare(
        `SELECT id, mesh_id, event, payload, drained_at FROM mesh_pending_events
         WHERE drained = 1 AND drained_at IS NOT NULL AND drained_at >= ?
         ORDER BY drained_at DESC LIMIT ?`
    ).all(sinceEpochMs, Math.max(1, limit)) as Array<{ id: string; mesh_id: string; event: string; payload: string; drained_at: number }>;
    return rows.map(r => ({
        id: r.id,
        meshId: r.mesh_id,
        event: r.event,
        payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
        drainedAt: r.drained_at,
    }));
}


export function hasPendingEventFingerprint(self: MeshRuntimeStore, meshId: string, fingerprint: string): boolean {
    const row = self.db.prepare(
        'SELECT 1 FROM mesh_pending_events WHERE mesh_id = ? AND fingerprint = ? AND drained = 0 LIMIT 1'
    ).get(meshId, fingerprint);
    return row !== undefined;
}


/**
 * B3a — v2 eventId idempotency. Returns true when a row with this event_id has
 * ALREADY been drained (drained = 1) for the mesh. Drained rows are retained
 * (soft-marked, not deleted until mesh deletion), so this is a durable, restart-
 * surviving dedup: a v2 event whose eventId was already consumed is skipped on
 * re-delivery even when its content fingerprint differs. Scoped by mesh_id +
 * the partial event_id index (idx_mesh_pending_events_event_id).
 */
export function hasDrainedEventId(self: MeshRuntimeStore, meshId: string, eventId: string): boolean {
    if (!eventId) return false;
    const row = self.db.prepare(
        'SELECT 1 FROM mesh_pending_events WHERE mesh_id = ? AND event_id = ? AND drained = 1 LIMIT 1'
    ).get(meshId, eventId);
    return row !== undefined;
}


/**
 * B3a — snapshot of the v2 event_ids ALREADY drained (drained = 1) for the mesh.
 * Taken BEFORE a drain call marks the current batch drained=1, so the resulting
 * set names only PRIOR drains — the re-delivery dedup baseline. (Reading it after
 * the drain would self-match the batch's own freshly-drained rows.) Non-v2 rows
 * have a NULL event_id and are excluded by the index/WHERE.
 */
export function drainedEventIdsForMesh(self: MeshRuntimeStore, meshId: string): Set<string> {
    const rows = self.db.prepare(
        'SELECT DISTINCT event_id FROM mesh_pending_events WHERE mesh_id = ? AND drained = 1 AND event_id IS NOT NULL'
    ).all(meshId) as Array<{ event_id: string }>;
    return new Set(rows.map(r => r.event_id));
}


export function pendingEventCount(self: MeshRuntimeStore, meshId: string): number {
    const row = self.db.prepare(
        'SELECT COUNT(*) as cnt FROM mesh_pending_events WHERE mesh_id = ? AND drained = 0'
    ).get(meshId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}


/**
 * Mark specific pending-event rows drained by id (ack). Used by the
 * unresolved-delegate durable-forward outbox: an event is peeked (not drained)
 * while its push to the coordinator is unconfirmed, then marked drained ONLY
 * after the push is acked. A failed push leaves the row undrained so the next
 * reconcile tick retries it. Returns the number of rows newly marked drained.
 */
export function markPendingEventsDrainedById(self: MeshRuntimeStore, ids: ReadonlyArray<string>): number {
    const idList = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (idList.length === 0) return 0;
    const now = Date.now();
    return self.db.prepare(
        `UPDATE mesh_pending_events SET drained = 1, drained_at = ? WHERE drained = 0 AND id IN (${idList.map(() => '?').join(',')})`
    ).run(now, ...idList).changes;
}


/**
 * STRICT-ROUTE-HOLD-DURABILITY: return an ALREADY-DRAINED row to the queue
 * (drained=1 → drained=0), in place, by fingerprint.
 *
 * Why this exists (the rc.33 defect): a strict-routed completion whose originating
 * coordinator session is not currently live is "held" by re-queuing it. That
 * re-queue used to call the normal insert path, which CANNOT work for a held
 * event — three independent suppressors reject it:
 *
 *   1. `idx_mesh_pending_events_fingerprint` is UNIQUE on (mesh_id, fingerprint)
 *      with NO `drained` qualifier, and insertPendingEvent uses INSERT OR IGNORE.
 *      The just-drained row still occupies that fingerprint, so the "fresh
 *      undrained copy" is silently ignored — changes = 0, no row added.
 *   2. hasPendingCoordinatorEventDuplicate → hasPendingEventFingerprint queries
 *      `drained = 0`, so it does NOT see the drained original and reports no
 *      duplicate — the caller believes the re-queue succeeded.
 *   3. Even if a copy did land, the v2 eventId is already in
 *      drainedEventIdsForMesh(), so routeV2EventsForDrainer would skip it as
 *      already-delivered on the next drain.
 *
 * The pre-restart hold only ever worked because the in-memory reconcile loop
 * re-read the event; nothing durable was written. A restart inside the 60s TTL
 * therefore lost the completion permanently (observed: task ec6c901a — exactly
 * one row, drained=1, and zero lines in the JSONL mirror).
 *
 * Flipping the EXISTING row back to drained=0 is the only correct move: it keeps
 * the unique fingerprint (no duplicate row can ever be created), removes the
 * eventId from the drained-baseline so the v2 idempotency filter stops swallowing
 * it, and makes the hold survive a process restart. queued_at is deliberately
 * PRESERVED so the strict TTL keeps measuring the event's true age across holds
 * and cannot be refreshed into an immortal row.
 *
 * Returns true when a drained row was found and returned to the queue.
 */
export function requeueDrainedPendingEventByFingerprint(self: MeshRuntimeStore, meshId: string, fingerprint: string): boolean {
    if (!fingerprint) return false;
    // drained_by is cleared with drained_at: the row is queued again, so the
    // previous drainer is no longer the consumer of record. Leaving it set would
    // make the audit surface attribute the row to a coordinator that gave it back.
    const changes = self.db.prepare(
        `UPDATE mesh_pending_events SET drained = 0, drained_at = NULL, drained_by = NULL
         WHERE mesh_id = ? AND fingerprint = ? AND drained = 1`
    ).run(meshId, fingerprint).changes;
    if (changes > 0) self.maybeCheckpointWal();
    return changes > 0;
}


/**
 * COORD-GENERATION-HANDOFF (defect 3): rewrite a queued row's payload in place,
 * used to strip the `targetCoordinatorSessionId` of a coordinator confirmed dead
 * so the event falls through to daemon-level delivery.
 *
 * Why a payload rewrite is required rather than just re-queuing: the in-memory
 * event the caller holds is a COPY. requeueDrainedPendingEventByFingerprint flips
 * `drained` but never touches `payload`, so without this the dead session stamp
 * survives in SQLite and the very next drain re-reads it, re-enters the strict-
 * unmatched branch, and the event loops on every 4s tick until the TTL kills it —
 * i.e. the reattribution would silently not stick.
 *
 * Scoped by fingerprint + drained = 0, so it can only ever touch the row this
 * caller just returned to the queue. `queued_at` and `fingerprint` are untouched:
 * the row keeps its identity (no duplicate can be created, all fingerprint-keyed
 * dedup continues to match) and its true age.
 *
 * Returns true when a queued row was found and rewritten.
 */
export function updatePendingEventPayloadByFingerprint(self: MeshRuntimeStore, meshId: string, fingerprint: string, payload: unknown): boolean {
    if (!fingerprint) return false;
    const changes = self.db.prepare(
        `UPDATE mesh_pending_events SET payload = ?
         WHERE mesh_id = ? AND fingerprint = ? AND drained = 0`
    ).run(JSON.stringify(payload), meshId, fingerprint).changes;
    if (changes > 0) self.maybeCheckpointWal();
    return changes > 0;
}


/**
 * ENTER-LOSS layer ③ (composer-residue recovery) — the row-id twin of
 * requeueDrainedPendingEventByFingerprint, with identical semantics: flip the
 * EXISTING drained row back to drained=0 IN PLACE. Never a re-insert — the
 * UNIQUE (mesh_id, fingerprint) index stays occupied by this very row, so no
 * duplicate can be created and the DUPNOTIF suppressors are never in play.
 * `queued_at` is preserved (age keeps measuring from the original enqueue) and
 * `drained_by` is cleared with `drained_at` (the previous drainer is no longer
 * the consumer of record).
 *
 * The sweep identifies residue from `recentDrainedPendingEventPayloads`, which
 * returns row ids — an id is a strictly more precise handle than the
 * fingerprint (fingerprints can be NULL on legacy rows), hence this variant.
 * Returns true when a drained row was found and returned to the queue.
 */
export function requeueDrainedPendingEventById(self: MeshRuntimeStore, rowId: string): boolean {
    if (!rowId) return false;
    const changes = self.db.prepare(
        `UPDATE mesh_pending_events SET drained = 0, drained_at = NULL, drained_by = NULL
         WHERE id = ? AND drained = 1`
    ).run(rowId).changes;
    if (changes > 0) self.maybeCheckpointWal();
    return changes > 0;
}


/**
 * Hard-delete pending-event rows by id (including the dedup fingerprint history).
 * Used to expire an unresolved-delegate outbox entry that has exhausted its retry
 * budget — fully removing it frees the fingerprint so a genuinely new completion
 * for the same task could be re-queued later. Returns the number of rows deleted.
 */
export function deletePendingEventsById(self: MeshRuntimeStore, ids: ReadonlyArray<string>): number {
    const idList = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (idList.length === 0) return 0;
    return self.db.prepare(
        `DELETE FROM mesh_pending_events WHERE id IN (${idList.map(() => '?').join(',')})`
    ).run(...idList).changes;
}


/**
 * Retention prune for mesh_pending_events. This table has no lifecycle GC of its
 * own: a drained row is soft-marked (drained=1) and RETAINED — deliberately, so
 * drainedEventIdsForMesh() has a durable v2-eventId dedup baseline — and an
 * undrained row queued for a coordinator that never returned (a dead/evicted
 * coordinator identity) stays drained=0 forever. Both accumulate without bound
 * (observed: tens of thousands of rows, mostly stale). This is the missing
 * retention step. Two independent windows:
 *
 *   - drained rows older than `drainedOlderThanMs`: the coordinator consumed them
 *     long ago; the only thing they still back is the eventId re-delivery guard,
 *     which is only meaningful for the recent past (a re-delivery of a week-old
 *     event cannot occur — its producer session is long gone). Safe to delete.
 *   - UNDRAINED rows older than `undrainedOlderThanMs` (a much wider window):
 *     these are orphaned events for a coordinator identity that never drained
 *     them. Kept wide so a genuinely-offline-but-returning coordinator still
 *     receives its backlog; only genuinely unrecoverable orphans are swept.
 *     TERMINAL events named in `neverExpireEvents` are exempt from this window
 *     outright — see that option's doc below.
 *
 * Both windows key off `queued_at` (always present) — `drained_at` can be NULL on
 * legacy rows. Returns the number of rows deleted, split by which window matched:
 * `drainedExpired` (already-delivered rows past the dedup-useful window — not a
 * drop, the coordinator already got these) and `undrainedExpired` (rows that were
 * NEVER delivered — a genuine silent drop, same shape as the retired JSONL trim's
 * `pending_trim_dropped`). `undrainedRows` carries the id/meshId/event/payload of
 * every undrained-expired row BEFORE deletion so the caller can mirror it to the
 * mesh ledger as `event_held` (recoverable via mesh_requeue_held_events) instead of
 * losing it silently — this is the observability gap the retired trim used to cover
 * and the SQLite-only cutover left open. Best-effort / idempotent: running it
 * repeatedly with nothing to prune is a cheap no-op.
 */
export function prunePendingEvents(self: MeshRuntimeStore, opts: {
    drainedOlderThanMs: number;
    undrainedOlderThanMs: number;
    /**
     * TERMINAL-NEVER-EXPIRES. Event names that are EXEMPT from the undrained
     * window entirely — never age-expired, however old they get. Caller-supplied
     * (the store must not own mesh event taxonomy) and matched by exact event
     * name, never by prefix/substring: a substring match would be a silent
     * over-match the moment a new event name happens to contain one of these.
     *
     * The undrained window exists to sweep orphans whose information is
     * re-derivable — a `refine:*` lifecycle marker, an `agent:ready` — for a
     * coordinator identity that never returned. A terminal completion is the
     * opposite: its finalSummary/worker result exists ONLY in this row, so
     * expiring it destroys the single copy of a worker's output. Bounding table
     * growth is not worth that, and terminal rows are naturally bounded anyway
     * (one per dispatched task, not a per-tick lifecycle stream). Exempt rows are
     * excluded from the delete AND from `undrainedRows`, so they are neither
     * deleted nor mirrored — they simply stay queued and deliverable.
     */
    neverExpireEvents?: ReadonlySet<string>;
}): {
    drainedExpired: number;
    undrainedExpired: number;
    undrainedRows: Array<{ id: string; meshId: string; event: string; payload: unknown }>;
    /** Undrained rows past the window that were KEPT because their event name is
     *  in `neverExpireEvents`. Observability only — a non-zero value means the
     *  terminal exemption actively prevented a data-destroying expiry. */
    terminalExempt: number;
} {
    const now = Date.now();
    const drainedCutoff = now - Math.max(0, opts.drainedOlderThanMs);
    const undrainedCutoff = now - Math.max(0, opts.undrainedOlderThanMs);
    const neverExpire = opts.neverExpireEvents;

    // Capture the undrained-expired rows BEFORE deleting them — these never
    // reached a coordinator, so deleting them is a silent drop unless the caller
    // mirrors this snapshot to the ledger first.
    const undrainedSelectRows = self.db.prepare(
        'SELECT id, mesh_id, event, payload FROM mesh_pending_events WHERE drained = 0 AND queued_at < ?'
    ).all(undrainedCutoff) as Array<{ id: string; mesh_id: string; event: string; payload: string }>;

    // Split the window's rows into "may expire" and "terminal — exempt". The
    // delete below is then driven by the explicit expirable id list rather than
    // by the age predicate alone, so an exempt row cannot be deleted even if the
    // two ever disagreed.
    const expirableRows: typeof undrainedSelectRows = [];
    let terminalExempt = 0;
    for (const r of undrainedSelectRows) {
        if (neverExpire?.has(r.event)) terminalExempt++;
        else expirableRows.push(r);
    }

    const undrainedRows = expirableRows.map(r => ({
        id: r.id,
        meshId: r.mesh_id,
        event: r.event,
        payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
    }));

    const drainedExpired = self.db.prepare(
        'DELETE FROM mesh_pending_events WHERE drained = 1 AND queued_at < ?'
    ).run(drainedCutoff).changes;

    // Delete by explicit id (chunked to stay under SQLite's variable limit) rather
    // than by the age predicate, so the exempt rows are structurally unreachable.
    let undrainedExpired = 0;
    for (let i = 0; i < undrainedRows.length; i += 500) {
        const chunk = undrainedRows.slice(i, i + 500);
        undrainedExpired += self.db.prepare(
            `DELETE FROM mesh_pending_events WHERE id IN (${chunk.map(() => '?').join(',')})`
        ).run(...chunk.map(r => r.id)).changes;
    }
    return { drainedExpired, undrainedExpired, undrainedRows, terminalExempt };
}
