// ---------------------------------------------------------------------------
// turn-ledger/store — row CRUD over turn_attempts / turn_events / turn_holds
// ---------------------------------------------------------------------------
// Wiring-unification Phase C3 (C-W2). Pure persistence: no reducer, no
// publish, no clock of its own (every write takes `nowMs`). Bound to one
// better-sqlite3 handle — `mesh-runtime.db` in production, `:memory:` in
// tests — so the ledger's transaction covers these rows AND `mesh_queue` /
// graph rows on the same handle.
//
// Only this file, migrate-v1.ts and schema.ts write the turn tables
// (gate `check:turn-single-emitter`, rule 1).
// ---------------------------------------------------------------------------

import type { Database as DatabaseHandle, Statement } from 'better-sqlite3';
import type { ConsumeProfile, HoldReason, LivenessResult, SummaryRef, TurnScope } from '@adhdev/mesh-shared';
import type { HoldOnExpire, TurnAttempt, TurnAttemptData, TurnHold, TurnState } from './types.js';

// ─── row shapes ──────────────────────────────────────────────────────────

interface AttemptRow {
    attempt_id: string; scope: TurnScope; mesh_id: string | null; task_id: string | null; attempt_no: number;
    session_id: string; node_id: string | null; provider_type: string | null; owner_daemon_id: string; generation: number;
    prev_gen_session_id: string | null; prev_gen_consumed: number | null; dispatch_nonce: number | null; message_id: string | null;
    input_json: string | null; via: string | null; consume_profile: string; max_task_retries: number; state: string; suspension: string | null;
    redrive_count: number; reclaim_count: number; hollow_count: number; liveness_fail_streak: number; last_liveness: string | null;
    coordinator_daemon_id: string | null; coordinator_session_id: string | null; accepted_at: number; delivered_at: number | null;
    consumed_at: number | null; last_activity_at: number | null; last_probe_at: number | null; weak_since: number | null;
    candidate_notified_generation: number | null; last_no_progress_notice_at: number | null; notified_at: number | null;
    terminal_outcome: string | null; terminal_reason: string | null; terminal_source: string | null; terminal_strength: string | null;
    terminal_at: number | null; terminal_summary_json: string | null; data_json: string; created_at: number; updated_at: number;
}

export type TurnEventVerdict = 'applied' | 'recorded' | 'rejected' | 'forwarded';
export type TurnPublishState = 'none' | 'pending' | 'published';

export interface TurnEventRow {
    eventId: string;
    meshId: string | null;
    attemptId: string | null;
    generation: number | null;
    sessionId: string;
    kind: string;
    source: string;
    verdict: TurnEventVerdict;
    rule: string | null;
    rejection: string | null;
    dedupeKey: string;
    fromState: string | null;
    toState: string | null;
    payload: Record<string, unknown>;
    observedBy: string | null;
    srcWriter: string | null;
    srcSeq: number | null;
    publishState: TurnPublishState;
    publishedSeq: number | null;
    atMs: number;
    recordedAt: number;
}

export type TurnEventInsert = Omit<TurnEventRow, 'publishedSeq' | 'rule' | 'rejection' | 'dedupeKey' | 'fromState' | 'toState' | 'observedBy' | 'srcWriter' | 'srcSeq' | 'meshId' | 'attemptId' | 'generation'>
    & Partial<Pick<TurnEventRow, 'rule' | 'rejection' | 'dedupeKey' | 'fromState' | 'toState' | 'observedBy' | 'srcWriter' | 'srcSeq' | 'meshId' | 'attemptId' | 'generation'>>;

interface EventRowRaw {
    event_id: string; mesh_id: string | null; attempt_id: string | null; generation: number | null; session_id: string; kind: string;
    source: string; verdict: TurnEventVerdict; rule: string | null; rejection: string | null; dedupe_key: string; from_state: string | null;
    to_state: string | null; payload_json: string; observed_by: string | null; src_writer: string | null; src_seq: number | null;
    publish_state: TurnPublishState; published_seq: number | null; at_ms: number; recorded_at: number;
}

interface HoldRowRaw {
    hold_id: string; attempt_id: string; generation: number | null; reason: string; until_ms: number | null; on_expire: string;
    data_json: string; status: string; created_at: number; resolved_at: number | null;
}

export interface MeshOperatingNoteRow {
    noteId: string;
    meshId: string;
    text: string;
    category: string | null;
    tombstonedAt: number | null;
    callerSessionId: string | null;
    createdAt: number;
}

function parseJsonObject(text: string | null | undefined): Record<string, unknown> {
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function parseSummary(text: string | null): SummaryRef | undefined {
    if (!text) return undefined;
    const parsed = parseJsonObject(text);
    return typeof parsed.topic === 'string' && typeof parsed.writer === 'string' && typeof parsed.seq === 'number'
        ? { topic: parsed.topic, writer: parsed.writer, seq: parsed.seq }
        : undefined;
}

export function attemptFromRow(row: AttemptRow): TurnAttempt {
    const summary = parseSummary(row.terminal_summary_json);
    return {
        attemptId: row.attempt_id,
        scope: row.scope,
        meshId: row.mesh_id,
        taskId: row.task_id,
        attemptNo: row.attempt_no,
        sessionId: row.session_id,
        nodeId: row.node_id,
        providerType: row.provider_type,
        ownerDaemonId: row.owner_daemon_id,
        generation: row.generation,
        prevGeneration: row.prev_gen_session_id !== null ? { sessionId: row.prev_gen_session_id, consumed: row.prev_gen_consumed === 1 } : null,
        dispatchNonce: row.dispatch_nonce,
        messageId: row.message_id,
        consumeProfile: (row.consume_profile === 'native_source' ? 'native_source' : 'default') as ConsumeProfile,
        maxTaskRetries: row.max_task_retries,
        state: row.state as TurnState,
        suspension: row.suspension === 'approval' || row.suspension === 'choice' ? row.suspension : null,
        redriveCount: row.redrive_count,
        reclaimCount: row.reclaim_count,
        hollowCount: row.hollow_count,
        livenessFailStreak: row.liveness_fail_streak,
        lastLiveness: (row.last_liveness as LivenessResult | null) ?? null,
        coordinator: { daemonId: row.coordinator_daemon_id, sessionId: row.coordinator_session_id },
        acceptedAt: row.accepted_at,
        deliveredAt: row.delivered_at,
        consumedAt: row.consumed_at,
        lastActivityAt: row.last_activity_at,
        weakSince: row.weak_since,
        candidateNotifiedGeneration: row.candidate_notified_generation,
        lastNoProgressNoticeAt: row.last_no_progress_notice_at,
        notifiedAt: row.notified_at,
        terminal: row.terminal_outcome
            ? {
                outcome: row.terminal_outcome as NonNullable<TurnAttempt['terminal']>['outcome'],
                reason: row.terminal_reason as NonNullable<TurnAttempt['terminal']>['reason'],
                source: row.terminal_source as NonNullable<TurnAttempt['terminal']>['source'],
                strength: row.terminal_strength as NonNullable<TurnAttempt['terminal']>['strength'],
                at: row.terminal_at ?? row.updated_at,
                ...(summary ? { summary } : {}),
            }
            : null,
        data: parseJsonObject(row.data_json) as TurnAttemptData,
    };
}

function eventFromRow(row: EventRowRaw): TurnEventRow {
    return {
        eventId: row.event_id, meshId: row.mesh_id, attemptId: row.attempt_id, generation: row.generation, sessionId: row.session_id,
        kind: row.kind, source: row.source, verdict: row.verdict, rule: row.rule, rejection: row.rejection, dedupeKey: row.dedupe_key,
        fromState: row.from_state, toState: row.to_state, payload: parseJsonObject(row.payload_json), observedBy: row.observed_by,
        srcWriter: row.src_writer, srcSeq: row.src_seq, publishState: row.publish_state, publishedSeq: row.published_seq,
        atMs: row.at_ms, recordedAt: row.recorded_at,
    };
}

function holdFromRow(row: HoldRowRaw): TurnHold {
    return {
        holdId: row.hold_id,
        attemptId: row.attempt_id,
        generation: row.generation,
        reason: row.reason as HoldReason,
        until: row.until_ms,
        onExpire: row.on_expire as HoldOnExpire,
        data: parseJsonObject(row.data_json) as TurnHold['data'],
        createdAt: row.created_at,
    };
}

/** Attempt-level extras migrate-v1 and the dispatch path set; not part of TurnAttempt. */
export interface TurnAttemptExtras {
    inputJson?: string | null;
    via?: string | null;
}

// ─── the store ───────────────────────────────────────────────────────────

export class TurnStore {
    private readonly stmts = new Map<string, Statement>();

    constructor(readonly db: DatabaseHandle) {}

    private stmt(sql: string): Statement {
        let s = this.stmts.get(sql);
        if (!s) {
            s = this.db.prepare(sql);
            this.stmts.set(sql, s);
        }
        return s;
    }

    // ── attempts ─────────────────────────────────────────────────────────

    getAttempt(attemptId: string): TurnAttempt | null {
        const row = this.stmt('SELECT * FROM turn_attempts WHERE attempt_id = ?').get(attemptId) as AttemptRow | undefined;
        return row ? attemptFromRow(row) : null;
    }

    /** The one open attempt a session holds (UNIQUE partial index), if any. */
    findOpenAttemptForSession(sessionId: string): TurnAttempt | null {
        const row = this.stmt('SELECT * FROM turn_attempts WHERE session_id = ? AND terminal_outcome IS NULL').get(sessionId) as AttemptRow | undefined;
        return row ? attemptFromRow(row) : null;
    }

    /** Latest attempt (highest attempt_no) of a task; meshId null = any mesh (evidence carries no mesh id). */
    findLatestAttemptForTask(meshId: string | null, taskId: string): TurnAttempt | null {
        const row = (meshId
            ? this.stmt('SELECT * FROM turn_attempts WHERE mesh_id = ? AND task_id = ? ORDER BY attempt_no DESC LIMIT 1').get(meshId, taskId)
            : this.stmt('SELECT * FROM turn_attempts WHERE task_id = ? ORDER BY attempt_no DESC, created_at DESC LIMIT 1').get(taskId)) as AttemptRow | undefined;
        return row ? attemptFromRow(row) : null;
    }

    listOpenAttempts(opts: { meshId?: string; ownerDaemonId?: string } = {}): TurnAttempt[] {
        const where: string[] = ['terminal_outcome IS NULL'];
        const args: unknown[] = [];
        if (opts.meshId) { where.push('mesh_id = ?'); args.push(opts.meshId); }
        if (opts.ownerDaemonId) { where.push('owner_daemon_id = ?'); args.push(opts.ownerDaemonId); }
        const rows = this.db.prepare(`SELECT * FROM turn_attempts WHERE ${where.join(' AND ')} ORDER BY accepted_at`).all(...args) as AttemptRow[];
        return rows.map(attemptFromRow);
    }

    listAttemptsForTask(meshId: string, taskId: string): TurnAttempt[] {
        const rows = this.stmt('SELECT * FROM turn_attempts WHERE mesh_id = ? AND task_id = ? ORDER BY attempt_no').all(meshId, taskId) as AttemptRow[];
        return rows.map(attemptFromRow);
    }

    /** null = unknown attempt. */
    isTerminal(attemptId: string): boolean | null {
        const row = this.stmt('SELECT terminal_outcome FROM turn_attempts WHERE attempt_id = ?').get(attemptId) as { terminal_outcome: string | null } | undefined;
        return row ? row.terminal_outcome !== null : null;
    }

    /** `ExpireHoldsContext.sessionIdFor` — the store-side join (no turn_holds.session_id column). */
    sessionIdForAttempt(attemptId: string): string {
        const row = this.stmt('SELECT session_id FROM turn_attempts WHERE attempt_id = ?').get(attemptId) as { session_id: string } | undefined;
        return row?.session_id ?? '';
    }

    upsertAttempt(attempt: TurnAttempt, nowMs: number, extras: TurnAttemptExtras = {}): void {
        const t = attempt.terminal;
        this.stmt(`INSERT INTO turn_attempts (
                attempt_id, scope, mesh_id, task_id, attempt_no, session_id, node_id, provider_type, owner_daemon_id, generation,
                prev_gen_session_id, prev_gen_consumed, dispatch_nonce, message_id, input_json, via, consume_profile, max_task_retries,
                state, suspension, redrive_count, reclaim_count, hollow_count, liveness_fail_streak, last_liveness,
                coordinator_daemon_id, coordinator_session_id, accepted_at, delivered_at, consumed_at, last_activity_at, weak_since,
                candidate_notified_generation, last_no_progress_notice_at, notified_at,
                terminal_outcome, terminal_reason, terminal_source, terminal_strength, terminal_at, terminal_summary_json,
                data_json, created_at, updated_at)
            VALUES (@attempt_id, @scope, @mesh_id, @task_id, @attempt_no, @session_id, @node_id, @provider_type, @owner_daemon_id, @generation,
                @prev_gen_session_id, @prev_gen_consumed, @dispatch_nonce, @message_id, @input_json, @via, @consume_profile, @max_task_retries,
                @state, @suspension, @redrive_count, @reclaim_count, @hollow_count, @liveness_fail_streak, @last_liveness,
                @coordinator_daemon_id, @coordinator_session_id, @accepted_at, @delivered_at, @consumed_at, @last_activity_at, @weak_since,
                @candidate_notified_generation, @last_no_progress_notice_at, @notified_at,
                @terminal_outcome, @terminal_reason, @terminal_source, @terminal_strength, @terminal_at, @terminal_summary_json,
                @data_json, @now, @now)
            ON CONFLICT(attempt_id) DO UPDATE SET
                scope = excluded.scope, mesh_id = excluded.mesh_id, task_id = excluded.task_id, attempt_no = excluded.attempt_no,
                session_id = excluded.session_id, node_id = excluded.node_id, provider_type = excluded.provider_type,
                owner_daemon_id = excluded.owner_daemon_id, generation = excluded.generation,
                prev_gen_session_id = excluded.prev_gen_session_id, prev_gen_consumed = excluded.prev_gen_consumed,
                dispatch_nonce = excluded.dispatch_nonce, message_id = excluded.message_id,
                input_json = COALESCE(excluded.input_json, turn_attempts.input_json), via = COALESCE(excluded.via, turn_attempts.via),
                consume_profile = excluded.consume_profile, max_task_retries = excluded.max_task_retries,
                state = excluded.state, suspension = excluded.suspension, redrive_count = excluded.redrive_count,
                reclaim_count = excluded.reclaim_count, hollow_count = excluded.hollow_count,
                liveness_fail_streak = excluded.liveness_fail_streak, last_liveness = excluded.last_liveness,
                coordinator_daemon_id = excluded.coordinator_daemon_id, coordinator_session_id = excluded.coordinator_session_id,
                accepted_at = excluded.accepted_at, delivered_at = excluded.delivered_at, consumed_at = excluded.consumed_at,
                last_activity_at = excluded.last_activity_at, weak_since = excluded.weak_since,
                candidate_notified_generation = excluded.candidate_notified_generation,
                last_no_progress_notice_at = excluded.last_no_progress_notice_at, notified_at = excluded.notified_at,
                terminal_outcome = excluded.terminal_outcome, terminal_reason = excluded.terminal_reason,
                terminal_source = excluded.terminal_source, terminal_strength = excluded.terminal_strength,
                terminal_at = excluded.terminal_at, terminal_summary_json = excluded.terminal_summary_json,
                data_json = excluded.data_json, updated_at = excluded.updated_at`).run({
            attempt_id: attempt.attemptId,
            scope: attempt.scope,
            mesh_id: attempt.meshId,
            task_id: attempt.taskId,
            attempt_no: attempt.attemptNo,
            session_id: attempt.sessionId,
            node_id: attempt.nodeId,
            provider_type: attempt.providerType,
            owner_daemon_id: attempt.ownerDaemonId,
            generation: attempt.generation,
            prev_gen_session_id: attempt.prevGeneration?.sessionId ?? null,
            prev_gen_consumed: attempt.prevGeneration ? (attempt.prevGeneration.consumed ? 1 : 0) : null,
            dispatch_nonce: attempt.dispatchNonce,
            message_id: attempt.messageId,
            input_json: extras.inputJson ?? null,
            via: extras.via ?? null,
            consume_profile: attempt.consumeProfile,
            max_task_retries: attempt.maxTaskRetries,
            state: attempt.state,
            suspension: attempt.suspension,
            redrive_count: attempt.redriveCount,
            reclaim_count: attempt.reclaimCount,
            hollow_count: attempt.hollowCount,
            liveness_fail_streak: attempt.livenessFailStreak,
            last_liveness: attempt.lastLiveness,
            coordinator_daemon_id: attempt.coordinator.daemonId,
            coordinator_session_id: attempt.coordinator.sessionId,
            accepted_at: attempt.acceptedAt,
            delivered_at: attempt.deliveredAt,
            consumed_at: attempt.consumedAt,
            last_activity_at: attempt.lastActivityAt,
            weak_since: attempt.weakSince,
            candidate_notified_generation: attempt.candidateNotifiedGeneration,
            last_no_progress_notice_at: attempt.lastNoProgressNoticeAt,
            notified_at: attempt.notifiedAt,
            terminal_outcome: t?.outcome ?? null,
            terminal_reason: t?.reason ?? null,
            terminal_source: t?.source ?? null,
            terminal_strength: t?.strength ?? null,
            terminal_at: t?.at ?? null,
            terminal_summary_json: t?.summary ? JSON.stringify(t.summary) : null,
            data_json: JSON.stringify(attempt.data ?? {}),
            now: nowMs,
        });
    }

    /** Scheduler probe bookkeeping (C4 probeDue); not a reducer field. */
    markProbed(attemptId: string, nowMs: number): void {
        this.stmt('UPDATE turn_attempts SET last_probe_at = ?, updated_at = ? WHERE attempt_id = ?').run(nowMs, nowMs, attemptId);
    }

    /** C10-4: terminal plain attempts are local-only and pruned after 7 d (their events go with them). */
    pruneTerminalPlainAttempts(olderThanMs: number, nowMs: number): { attempts: number; events: number; holds: number } {
        const cutoff = nowMs - olderThanMs;
        const ids = (this.stmt(`SELECT attempt_id FROM turn_attempts WHERE scope = 'plain' AND terminal_outcome IS NOT NULL AND terminal_at < ?`)
            .all(cutoff) as Array<{ attempt_id: string }>).map((r) => r.attempt_id);
        let events = 0;
        let holds = 0;
        for (const id of ids) {
            events += this.stmt('DELETE FROM turn_events WHERE attempt_id = ?').run(id).changes;
            holds += this.stmt('DELETE FROM turn_holds WHERE attempt_id = ?').run(id).changes;
            this.stmt('DELETE FROM turn_attempts WHERE attempt_id = ?').run(id);
        }
        return { attempts: ids.length, events, holds };
    }

    // ── holds ────────────────────────────────────────────────────────────

    activeHolds(attemptId: string): TurnHold[] {
        const rows = this.stmt(`SELECT * FROM turn_holds WHERE attempt_id = ? AND status = 'active' ORDER BY hold_id`).all(attemptId) as HoldRowRaw[];
        return rows.map(holdFromRow);
    }

    /**
     * Make `holds` the attempt's exact active set: upsert every hold given
     * (a re-armed hold keeps its id and gets its new deadline), resolve every
     * active hold that is not in the set.
     */
    syncHolds(attemptId: string, holds: readonly TurnHold[], nowMs: number): { armed: number; resolved: number } {
        const keep = new Set(holds.map((h) => h.holdId));
        let resolved = 0;
        for (const active of this.activeHolds(attemptId)) {
            if (keep.has(active.holdId)) continue;
            resolved += this.stmt(`UPDATE turn_holds SET status = 'resolved', resolved_at = ? WHERE hold_id = ? AND status = 'active'`).run(nowMs, active.holdId).changes;
        }
        for (const hold of holds) {
            this.stmt(`INSERT INTO turn_holds (hold_id, attempt_id, generation, reason, until_ms, on_expire, data_json, status, created_at, resolved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)
                ON CONFLICT(hold_id) DO UPDATE SET attempt_id = excluded.attempt_id, generation = excluded.generation, reason = excluded.reason,
                    until_ms = excluded.until_ms, on_expire = excluded.on_expire, data_json = excluded.data_json, status = 'active',
                    created_at = excluded.created_at, resolved_at = NULL`)
                .run(hold.holdId, hold.attemptId, hold.generation, hold.reason, hold.until, hold.onExpire, JSON.stringify(hold.data ?? {}), hold.createdAt);
        }
        return { armed: holds.length, resolved };
    }

    /** Active holds whose deadline passed, in deadline order (scheduler `expiredHolds()`). */
    dueHolds(nowMs: number, limit = 500): TurnHold[] {
        const rows = this.stmt(`SELECT * FROM turn_holds WHERE status = 'active' AND until_ms IS NOT NULL AND until_ms <= ? ORDER BY until_ms, hold_id LIMIT ?`)
            .all(nowMs, limit) as HoldRowRaw[];
        return rows.map(holdFromRow);
    }

    /** Earliest active deadline, for the scheduler's single setTimeout (C4). */
    nextHoldDeadline(): number | null {
        const row = this.stmt(`SELECT MIN(until_ms) AS next FROM turn_holds WHERE status = 'active' AND until_ms IS NOT NULL`).get() as { next: number | null } | undefined;
        return row?.next ?? null;
    }

    // ── events ───────────────────────────────────────────────────────────

    hasEvent(eventId: string): boolean {
        return !!this.stmt('SELECT 1 FROM turn_events WHERE event_id = ?').get(eventId);
    }

    getEvent(eventId: string): TurnEventRow | null {
        const row = this.stmt('SELECT * FROM turn_events WHERE event_id = ?').get(eventId) as EventRowRaw | undefined;
        return row ? eventFromRow(row) : null;
    }

    /** INSERT OR IGNORE — the PK (event_id) and UNIQUE(attempt, generation, kind, dedupe) collapse replays. Returns true when inserted. */
    insertEvent(row: TurnEventInsert): boolean {
        const info = this.stmt(`INSERT OR IGNORE INTO turn_events (
                event_id, mesh_id, attempt_id, generation, session_id, kind, source, verdict, rule, rejection, dedupe_key,
                from_state, to_state, payload_json, observed_by, src_writer, src_seq, publish_state, published_seq, at_ms, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
            row.eventId, row.meshId ?? null, row.attemptId ?? null, row.generation ?? null, row.sessionId, row.kind, row.source, row.verdict,
            row.rule ?? null, row.rejection ?? null, row.dedupeKey ?? '', row.fromState ?? null, row.toState ?? null,
            JSON.stringify(row.payload ?? {}), row.observedBy ?? null, row.srcWriter ?? null, row.srcSeq ?? null,
            row.publishState, row.atMs, row.recordedAt,
        );
        return info.changes > 0;
    }

    listEvents(attemptId: string): TurnEventRow[] {
        const rows = this.stmt('SELECT * FROM turn_events WHERE attempt_id = ? ORDER BY recorded_at, rowid').all(attemptId) as EventRowRaw[];
        return rows.map(eventFromRow);
    }

    /** `pending` rows in write order — the publisher's queue (C7-1) and the boot/tick republish input. */
    pendingPublish(limit = 256): TurnEventRow[] {
        const rows = this.stmt(`SELECT * FROM turn_events WHERE publish_state = 'pending' ORDER BY recorded_at, rowid LIMIT ?`).all(limit) as EventRowRaw[];
        return rows.map(eventFromRow);
    }

    countPendingPublish(olderThanMs?: number): number {
        const row = (olderThanMs === undefined
            ? this.stmt(`SELECT COUNT(*) AS n FROM turn_events WHERE publish_state = 'pending'`).get()
            : this.stmt(`SELECT COUNT(*) AS n FROM turn_events WHERE publish_state = 'pending' AND recorded_at < ?`).get(olderThanMs)) as { n: number };
        return row.n;
    }

    /** `pending → published(src_seq)`. Idempotent; a republish of a published row is a no-op. */
    markPublished(eventId: string, writer: string, seq: number): boolean {
        return this.stmt(`UPDATE turn_events SET publish_state = 'published', published_seq = ?, src_writer = COALESCE(src_writer, ?)
            WHERE event_id = ? AND publish_state = 'pending'`).run(seq, writer, eventId).changes > 0;
    }

    // ── operating notes (C3: out of the legacy event ledger) ────────────

    insertOperatingNote(note: Omit<MeshOperatingNoteRow, 'tombstonedAt'>): boolean {
        return this.stmt(`INSERT OR IGNORE INTO mesh_operating_notes (note_id, mesh_id, text, category, tombstoned_at, caller_session_id, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(note.noteId, note.meshId, note.text, note.category, note.callerSessionId, note.createdAt).changes > 0;
    }

    tombstoneOperatingNote(meshId: string, noteId: string, atMs: number): boolean {
        return this.stmt(`UPDATE mesh_operating_notes SET tombstoned_at = ? WHERE mesh_id = ? AND note_id = ? AND tombstoned_at IS NULL`)
            .run(atMs, meshId, noteId).changes > 0;
    }

    listOperatingNotes(meshId: string, opts: { includeTombstoned?: boolean } = {}): MeshOperatingNoteRow[] {
        const rows = this.db.prepare(`SELECT * FROM mesh_operating_notes WHERE mesh_id = ?${opts.includeTombstoned ? '' : ' AND tombstoned_at IS NULL'} ORDER BY created_at, note_id`)
            .all(meshId) as Array<{ note_id: string; mesh_id: string; text: string; category: string | null; tombstoned_at: number | null; caller_session_id: string | null; created_at: number }>;
        return rows.map((r) => ({ noteId: r.note_id, meshId: r.mesh_id, text: r.text, category: r.category, tombstonedAt: r.tombstoned_at, callerSessionId: r.caller_session_id, createdAt: r.created_at }));
    }
}
