/**
 * TURN-LEDGER (Stage 5) persistence — extracted from mesh-runtime-store.ts
 * (behavior-preserving code move, file-size gate).
 *
 * These functions were `MeshRuntimeStore` methods; they now take the store
 * instance as `self` (same pattern as router.ts → router-refine.ts). The class
 * keeps thin delegating wrappers for every entry point, so the public surface
 * and every existing call site are unchanged. No SQL string, WAL-checkpoint
 * order, error handling, or result shape was changed — only physical location
 * + `this.` → `self.`.
 */
import type { MeshRuntimeStore } from './mesh-runtime-store.js';
import {
    meshTurnAttemptFromRow,
    meshTurnHeldSuspensionFromRow,
    type MeshTurnAttemptRow,
    type MeshTurnHeldSuspensionRow,
} from './mesh-runtime-store-turn-rows.js';

/** Insert shape for mesh_turn_attempts (was the inline param type of MeshRuntimeStore.insertTurnAttempt). */
export interface MeshTurnAttemptInsert {
    attemptId: string; meshId: string; taskId: string; attemptSeq: number;
    nodeId?: string; sessionId?: string; providerType?: string;
    coordinatorDaemonId?: string; coordinatorSessionId?: string;
    dispatchNonce?: number; stage: string; leaseDeadlineMs?: number | null;
    acceptedAt?: string; createdAt: string; updatedAt: string;
}

/** Options for advanceTurnAttemptStage (was the inline param type). */
export interface MeshTurnAttemptStageOpts {
    updatedAt: string; leaseDeadlineMs?: number | null; deliveredAt?: string; consumedAt?: string;
}

/** Insert shape for mesh_turn_events (was the inline param type of insertTurnEvent). */
export interface MeshTurnEventInsert {
    eventId: string; meshId: string; attemptId: string; taskId: string;
    kind: string; dedupeKey?: string; payload?: string;
    occurredAtMs?: number | null; recordedAt: string;
}

/** Insert shape for mesh_turn_held_suspensions (was the inline param type of insertHeldTurnSuspension). */
export interface MeshHeldTurnSuspensionInsert {
    holdId: string; meshId: string; attemptId: string; taskId: string;
    stage: string; sessionId?: string; dispatchNonce?: number | null;
    occurredAtMs?: number | null; recordedAt: string;
}

/**
 * Insert a new turn attempt. INSERT OR IGNORE on the PRIMARY KEY / the
 * UNIQUE(mesh_id, task_id, attempt_seq) constraint makes a retried open (e.g. a
 * dispatch restarted after a crash between the queue claim and this write)
 * idempotent: returns true when this call inserted the row, false when an
 * attempt for that identity already exists (caller then reads it back).
 */
export function insertTurnAttempt(self: MeshRuntimeStore, row: MeshTurnAttemptInsert): boolean {
    const res = self.db.prepare(`
        INSERT OR IGNORE INTO mesh_turn_attempts (
            attempt_id, mesh_id, task_id, attempt_seq, node_id, session_id,
            provider_type, coordinator_daemon_id, coordinator_session_id,
            dispatch_nonce, stage, lease_deadline_ms, accepted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.attemptId, row.meshId, row.taskId, row.attemptSeq,
        row.nodeId ?? null, row.sessionId ?? null, row.providerType ?? null,
        row.coordinatorDaemonId ?? null, row.coordinatorSessionId ?? null,
        row.dispatchNonce ?? null, row.stage, row.leaseDeadlineMs ?? null,
        row.acceptedAt ?? null, row.createdAt, row.updatedAt,
    );
    self.maybeCheckpointWal();
    return res.changes > 0;
}

export function getTurnAttempt(self: MeshRuntimeStore, attemptId: string): MeshTurnAttemptRow | null {
    const row = self.db.prepare('SELECT * FROM mesh_turn_attempts WHERE attempt_id = ?')
        .get(attemptId) as Record<string, unknown> | undefined;
    return row ? meshTurnAttemptFromRow(row) : null;
}

/**
 * The CURRENT attempt for a task: the highest attempt_seq row. Reassignment
 * monotonically increases the seq (it is the dispatch nonce), so the max-seq row
 * is the only attempt late events may still mutate.
 */
export function getCurrentTurnAttempt(self: MeshRuntimeStore, meshId: string, taskId: string): MeshTurnAttemptRow | null {
    const row = self.db.prepare(`
        SELECT * FROM mesh_turn_attempts
        WHERE mesh_id = ? AND task_id = ?
        ORDER BY attempt_seq DESC LIMIT 1
    `).get(meshId, taskId) as Record<string, unknown> | undefined;
    return row ? meshTurnAttemptFromRow(row) : null;
}

/**
 * The CURRENT attempt bound to a worker session, across meshes/tasks: the
 * nonterminal row if one exists, else the most recently touched terminal row.
 * Stage 6's presentation layer resolves sessions (not tasks) — read_chat,
 * session status, dashboard and the restart gate all key on sessionId.
 */
/**
 * The attempt that governs a session's presented execution status.
 *
 * A nonterminal attempt is preferred (an in-flight turn outranks a finished
 * one), but ONLY when it is its task's CURRENT attempt — i.e. no higher
 * attempt_seq exists for the same task.
 *
 * ORPHAN-LEGACY-ATTEMPT (fix ③): without that restriction, a stranded
 * lower-seq row (classically a `legacy-<taskId>-0` minted mid-turn while the
 * real dispatch already held seq >= 1) outranks the real, COMPLETED attempt
 * purely because it is nonterminal. Such a row is unreachable by
 * construction — every ACK and every completion targets the current attempt,
 * and the reducer's stale-attempt guard refuses to mutate a non-current row —
 * so it stays `generating` forever and pins the session's presented status to
 * `generating` even though its turn finished. Fixes ① (no new orphans) and ②
 * (close the existing ones) address the rows themselves; this guard is the
 * read-side safety net for any that still slip through, e.g. mid-flight
 * before the reclaim sweep runs.
 *
 * `attempt_seq DESC` is the final tie-break, not decoration: attempts of one
 * task are routinely written inside the same millisecond, so `updated_at`
 * alone leaves ties that SQLite may resolve either way — which would make
 * the selection (and therefore the presented session status) flap between
 * runs. Preferring the newer attempt is the correct resolution.
 */
export function getLatestTurnAttemptForSession(self: MeshRuntimeStore, sessionId: string): MeshTurnAttemptRow | null {
    const row = self.db.prepare(`
        SELECT a.* FROM mesh_turn_attempts a
        WHERE a.session_id = ?
        ORDER BY
            (a.terminal_outcome IS NULL AND NOT EXISTS (
                SELECT 1 FROM mesh_turn_attempts b
                WHERE b.mesh_id = a.mesh_id AND b.task_id = a.task_id
                  AND b.attempt_seq > a.attempt_seq
            )) DESC,
            a.updated_at DESC,
            a.attempt_seq DESC
        LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;
    return row ? meshTurnAttemptFromRow(row) : null;
}

export function getTurnAttemptBySeq(self: MeshRuntimeStore, meshId: string, taskId: string, attemptSeq: number): MeshTurnAttemptRow | null {
    const row = self.db.prepare(`
        SELECT * FROM mesh_turn_attempts WHERE mesh_id = ? AND task_id = ? AND attempt_seq = ?
    `).get(meshId, taskId, attemptSeq) as Record<string, unknown> | undefined;
    return row ? meshTurnAttemptFromRow(row) : null;
}

export function listTurnAttemptsForTask(self: MeshRuntimeStore, meshId: string, taskId: string): MeshTurnAttemptRow[] {
    const rows = self.db.prepare(`
        SELECT * FROM mesh_turn_attempts WHERE mesh_id = ? AND task_id = ? ORDER BY attempt_seq ASC
    `).all(meshId, taskId) as Array<Record<string, unknown>>;
    return rows.map(meshTurnAttemptFromRow);
}

/**
 * ORPHAN-LEGACY-ATTEMPT (fix ②): nonterminal attempts that a HIGHER-seq
 * attempt of the same task has superseded.
 *
 * Such a row is unreachable by construction: `getCurrentTurnAttempt` returns
 * the max-seq row, so every ACK and every completion proposal resolves to the
 * newer attempt and the reducer's stale-attempt guard explicitly refuses to
 * mutate the older one. Nothing in the system can ever move it to terminal —
 * it would sit at `generating` indefinitely, and (before fix ③) outrank the
 * real completed attempt when presenting the session's status.
 *
 * Deliberately keyed on seq supersession rather than on the `legacy-` id
 * prefix: the id form is a symptom of one known minting path, whereas
 * "a newer attempt exists for this task" is the actual unreachability
 * condition and covers any future path that strands a row the same way.
 */
export function listSupersededNonterminalTurnAttempts(self: MeshRuntimeStore, meshId: string): MeshTurnAttemptRow[] {
    const rows = self.db.prepare(`
        SELECT a.* FROM mesh_turn_attempts a
        WHERE a.mesh_id = ?
          AND a.terminal_outcome IS NULL
          AND EXISTS (
              SELECT 1 FROM mesh_turn_attempts b
              WHERE b.mesh_id = a.mesh_id AND b.task_id = a.task_id
                AND b.attempt_seq > a.attempt_seq
          )
        ORDER BY a.created_at ASC
    `).all(meshId) as Array<Record<string, unknown>>;
    return rows.map(meshTurnAttemptFromRow);
}

/**
 * QUEUE-TERMINAL-ATTEMPT: nonterminal attempts whose task's `mesh_queue` row
 * is ALREADY terminal (`completed` / `failed` / `cancelled`).
 *
 * The queue row is an independent writer from the turn-ledger reducer — see
 * Stage 5's rollout gate (some paths, e.g. mission cascade / requeueTask auto-
 * fail, flip the queue row through the legacy/shadow path without ever
 * routing a completion proposal through the reducer). When the queue has
 * already recorded a terminal outcome for a task, that is independent proof
 * the work is done, so an attempt row still sitting nonterminal is not a live
 * turn being protected — it is a finished task that was never told. Closing
 * it cannot kill a real in-flight turn: a genuinely active turn has its queue
 * row still `pending`/`assigned`, which this predicate excludes by
 * construction (only `completed`/`failed`/`cancelled` queue rows qualify).
 *
 * `EXISTS` (not a JOIN) so a task_id with NO matching queue row — nothing to
 * compare against — is excluded rather than treated as a false match; a NULL
 * comparison in a JOIN would silently drop or wrongly include such rows
 * depending on the join type, which is exactly the ambiguity this predicate
 * must not have. Measured on the live ledger (RCA 2b3d260d): 14 of 735
 * nonterminal attempts match, 2 of 721 `delivered`-stage rows — a live turn
 * is essentially never caught by this condition.
 *
 * Deliberately independent of `attempt_seq` / current-vs-superseded: unlike
 * listSupersededNonterminalTurnAttempts, this predicate targets the SOLE
 * (and therefore trivially "current") attempt of a task just as often as a
 * stale one — a task with only ONE attempt whose queue row is terminal is
 * exactly the residue class this exists to close (confirmed case: a
 * `waiting_choice` attempt whose queue row already reads `cancelled`).
 * `reclaimOrphanedTurnAttempts` (seq supersession) runs first in the same
 * restart-recovery sweep, so a stale non-current sibling row is already
 * closed by the time this predicate's SELECT runs.
 */
export function listQueueTerminatedNonterminalTurnAttempts(self: MeshRuntimeStore, meshId: string): MeshTurnAttemptRow[] {
    const rows = self.db.prepare(`
        SELECT a.* FROM mesh_turn_attempts a
        WHERE a.mesh_id = ?
          AND a.terminal_outcome IS NULL
          AND EXISTS (
              SELECT 1 FROM mesh_queue q
              WHERE q.mesh_id = a.mesh_id AND q.id = a.task_id
                AND q.status IN ('completed', 'failed', 'cancelled')
          )
        ORDER BY a.created_at ASC
    `).all(meshId) as Array<Record<string, unknown>>;
    return rows.map(meshTurnAttemptFromRow);
}

/** Nonterminal attempts — the restart-recovery reconstruction set. */
export function listActiveTurnAttempts(self: MeshRuntimeStore, meshId: string): MeshTurnAttemptRow[] {
    const rows = self.db.prepare(`
        SELECT * FROM mesh_turn_attempts
        WHERE mesh_id = ? AND terminal_outcome IS NULL
        ORDER BY created_at ASC
    `).all(meshId) as Array<Record<string, unknown>>;
    return rows.map(meshTurnAttemptFromRow);
}

/**
 * Monotonic, idempotent nonterminal stage advance. The SQL guard accepts the
 * write only when `allowedFrom` (a comma-free SQL CASE whitelist built by the
 * reducer) matches the CURRENT stage — the transition rules live in exactly one
 * place (mesh-turn-ledger.ts) and are enforced inside the DB write so a
 * concurrent reducer instance cannot sneak a regression past the check.
 * Returns the stage the row is in AFTER this call (post-write read-back), so
 * idempotent/reordered events converge on the same observable result.
 */
export function advanceTurnAttemptStage(
    self: MeshRuntimeStore,
    attemptId: string,
    toStage: string,
    allowedFromCsv: string,
    opts: MeshTurnAttemptStageOpts,
): string | null {
    const fromList = allowedFromCsv.split(',').map(s => `'${s}'`).join(',');
    self.db.prepare(`
        UPDATE mesh_turn_attempts
        SET stage = @toStage, updated_at = @updatedAt,
            lease_deadline_ms = COALESCE(@leaseDeadlineMs, lease_deadline_ms),
            delivered_at = COALESCE(@deliveredAt, delivered_at),
            consumed_at = COALESCE(@consumedAt, consumed_at)
        WHERE attempt_id = @attemptId
          AND terminal_outcome IS NULL
          AND stage IN (${fromList})
    `).run({
        attemptId, toStage, updatedAt: opts.updatedAt,
        leaseDeadlineMs: opts.leaseDeadlineMs ?? null,
        deliveredAt: opts.deliveredAt ?? null,
        consumedAt: opts.consumedAt ?? null,
    });
    self.maybeCheckpointWal();
    const after = self.getTurnAttempt(attemptId);
    return after ? after.stage : null;
}

/**
 * EXACTLY-ONCE terminal commit. The conditional UPDATE wins only while
 * terminal_outcome IS NULL, so two concurrent completion proposals commit at
 * most one terminal transaction; the loser reads back the winner's outcome.
 * Returns the row after the attempt (always re-read).
 */
export function commitTurnAttemptTerminal(
    self: MeshRuntimeStore,
    attemptId: string,
    outcome: string,
    reason: string | null,
    terminalAt: string,
): { committed: boolean; row: MeshTurnAttemptRow | null } {
    const res = self.db.prepare(`
        UPDATE mesh_turn_attempts
        SET terminal_outcome = ?, terminal_reason = ?, terminal_at = ?, stage = ?, updated_at = ?
        WHERE attempt_id = ? AND terminal_outcome IS NULL
    `).run(outcome, reason, terminalAt, outcome, terminalAt, attemptId);
    self.maybeCheckpointWal();
    return { committed: res.changes > 0, row: self.getTurnAttempt(attemptId) };
}

/** Redrive bookkeeping: bump the durable redrive counter and set the next lease deadline. */
export function markTurnAttemptRedriven(self: MeshRuntimeStore, attemptId: string, leaseDeadlineMs: number, updatedAt: string): void {
    self.db.prepare(`
        UPDATE mesh_turn_attempts
        SET redrive_count = redrive_count + 1, lease_deadline_ms = ?, updated_at = ?
        WHERE attempt_id = ? AND terminal_outcome IS NULL
    `).run(leaseDeadlineMs, updatedAt, attemptId);
    self.maybeCheckpointWal();
}

/**
 * DUP-CLAIM-REBIND: point a still-open attempt at the session that is ACTUALLY
 * working it. Used when a node refuses a duplicate dispatch and names the live
 * holder — the attempt was opened against the session we tried to dispatch to,
 * but the work is running on the holder, so the binding (not the attempt) is what
 * is wrong. Conditional on `terminal_outcome IS NULL` so a settled attempt is
 * never rewritten; returns whether the rebind landed.
 */
export function rebindTurnAttemptSession(self: MeshRuntimeStore, attemptId: string, sessionId: string, updatedAt: string): boolean {
    const res = self.db.prepare(`
        UPDATE mesh_turn_attempts
        SET session_id = ?, updated_at = ?
        WHERE attempt_id = ? AND terminal_outcome IS NULL
    `).run(sessionId, updatedAt, attemptId);
    self.maybeCheckpointWal();
    return res.changes > 0;
}

// ── TURN-LEDGER (Stage 5): idempotency-keyed causal events ───────────────

/**
 * Append a causal event. INSERT OR IGNORE on UNIQUE(attempt_id, kind, dedupe_key)
 * makes repeated/reordered arrivals insert-once. Returns true when this call
 * inserted (first arrival), false on a duplicate.
 */
export function insertTurnEvent(self: MeshRuntimeStore, row: MeshTurnEventInsert): boolean {
    const res = self.db.prepare(`
        INSERT OR IGNORE INTO mesh_turn_events (
            event_id, mesh_id, attempt_id, task_id, kind, dedupe_key, payload, occurred_at_ms, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.eventId, row.meshId, row.attemptId, row.taskId, row.kind,
        row.dedupeKey ?? '', row.payload ?? '{}', row.occurredAtMs ?? null, row.recordedAt,
    );
    return res.changes > 0;
}

export function hasTurnEvent(self: MeshRuntimeStore, attemptId: string, kind: string, dedupeKey = ''): boolean {
    const row = self.db.prepare(
        'SELECT 1 FROM mesh_turn_events WHERE attempt_id = ? AND kind = ? AND dedupe_key = ? LIMIT 1',
    ).get(attemptId, kind, dedupeKey);
    return row !== undefined;
}

// ── TURN-LEDGER (Stage 5): held suspensions (pre-consumed waiting_*) ─────

/**
 * Hold a pre-consumed suspension edge. INSERT OR IGNORE on the hold id
 * (`<attemptId>:<stage>`) makes duplicate/reordered suspension arrivals
 * insert-once. Returns true when this call inserted (first hold).
 */
export function insertHeldTurnSuspension(self: MeshRuntimeStore, row: MeshHeldTurnSuspensionInsert): boolean {
    const res = self.db.prepare(`
        INSERT OR IGNORE INTO mesh_turn_held_suspensions (
            hold_id, mesh_id, attempt_id, task_id, stage, session_id, dispatch_nonce, occurred_at_ms, recorded_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held')
    `).run(
        row.holdId, row.meshId, row.attemptId, row.taskId, row.stage,
        row.sessionId ?? null, row.dispatchNonce ?? null, row.occurredAtMs ?? null, row.recordedAt,
    );
    self.maybeCheckpointWal();
    return res.changes > 0;
}

/** The hold row for one (attempt, stage) pair, any status (held/applied/dropped). */
export function getHeldTurnSuspension(self: MeshRuntimeStore, attemptId: string, stage: string): MeshTurnHeldSuspensionRow | null {
    const row = self.db.prepare(
        'SELECT * FROM mesh_turn_held_suspensions WHERE hold_id = ? LIMIT 1',
    ).get(`${attemptId}:${stage}`) as Record<string, unknown> | undefined;
    return row ? meshTurnHeldSuspensionFromRow(row) : null;
}

/** Hold rows for an attempt, oldest occurrence first (drain order). */
export function listHeldTurnSuspensionsForAttempt(self: MeshRuntimeStore, attemptId: string, status?: string): MeshTurnHeldSuspensionRow[] {
    const rows = (status
        ? self.db.prepare(`
            SELECT * FROM mesh_turn_held_suspensions
            WHERE attempt_id = ? AND status = ?
            ORDER BY occurred_at_ms ASC, hold_id ASC
        `).all(attemptId, status)
        : self.db.prepare(`
            SELECT * FROM mesh_turn_held_suspensions
            WHERE attempt_id = ?
            ORDER BY occurred_at_ms ASC, hold_id ASC
        `).all(attemptId)) as Array<Record<string, unknown>>;
    return rows.map(meshTurnHeldSuspensionFromRow);
}

/** Hold rows for a mesh by status (the restart-reconcile drain set). */
export function listHeldTurnSuspensionsForMesh(self: MeshRuntimeStore, meshId: string, status: string): MeshTurnHeldSuspensionRow[] {
    const rows = self.db.prepare(`
        SELECT * FROM mesh_turn_held_suspensions
        WHERE mesh_id = ? AND status = ?
        ORDER BY occurred_at_ms ASC, hold_id ASC
    `).all(meshId, status) as Array<Record<string, unknown>>;
    return rows.map(meshTurnHeldSuspensionFromRow);
}

/**
 * Resolve a hold exactly once: the status='held' guard makes a concurrent
 * drain/terminal resolution converge on a single winner. Returns true when
 * this call flipped the row.
 */
export function resolveHeldTurnSuspension(self: MeshRuntimeStore, holdId: string, status: 'applied' | 'dropped', resolution: string, resolvedAt: string): boolean {
    const res = self.db.prepare(`
        UPDATE mesh_turn_held_suspensions
        SET status = ?, resolution = ?, resolved_at = ?
        WHERE hold_id = ? AND status = 'held'
    `).run(status, resolution, resolvedAt, holdId);
    self.maybeCheckpointWal();
    return res.changes > 0;
}
