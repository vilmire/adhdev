// ---------------------------------------------------------------------------
// turn-ledger/migrate-v1 — the one-way fold of the legacy turn/outbox/ledger
// tables into turn_attempts / turn_events / turn_holds (design §5 C3)
// ---------------------------------------------------------------------------
// `PRAGMA user_version` 0 → 1 (C3 correction 2: nothing used user_version
// before; this migration introduces it). Idempotent and crash-safe:
//
//   0. `beforeFold` hook — the legacy `*.pending-events.jsonl` import
//      (mesh-events-pending-migration.ts) runs first so its rows fold too.
//   1. EXPORT every legacy table (rollback audit) as one JSONL file, one row
//      per line with a `_table` discriminator, BEFORE any mutation.
//   2. Per mesh, ONE transaction with MOVE semantics (insert new rows, delete
//      the mesh's legacy rows): a crash leaves already-moved meshes moved and
//      the rest untouched, and the re-run continues with the rest.
//        a. fold reassigned/superseded attempt chains into generations;
//           a genuine retry after a terminal opens attemptNo + 1;
//        b. non-terminal attempts with no queue row, idle longer than the hard
//           ceiling → failed / migration_orphan / scheduler;
//        c. mesh_turn_events 1:1 (generation = the folded generation);
//        d. held suspensions → turn_holds (held → active, applied/dropped →
//           resolved); mesh_inflight_hold → liveness hold (open attempts only);
//        e. mesh_session_delivery / mesh_direct_dispatches → attempt columns
//           (rows with no attempt dropped and counted);
//        f. mesh_completion_fingerprints dropped (turn_events UNIQUE replaces);
//        g. undrained mesh_pending_events → one `turn.notify{mesh_event}`
//           `pending` row each (published by the ledger's republish);
//        h. operating notes + tombstones → mesh_operating_notes; every other
//           mesh_event_ledger row is dropped (the topic already holds its
//           projected copy since Phase 2; C3: "no import into seqscribe").
//   3. One final transaction: DROP the nine legacy tables, user_version = 1.
//
// Free-text legacy fields (operator cancel reasons, delivery message bodies)
// are NOT carried into the closed TurnReason / content-free columns; they
// survive verbatim in the export file only. Unmapped reasons are counted.
// ---------------------------------------------------------------------------

import { closeSync, mkdirSync, openSync, writeSync } from 'fs';
import { dirname } from 'path';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import {
    MESH_TOPIC_PROTOCOL_VERSION,
    isEvidenceIdentifier,
    type CommitStrength,
    type EvidenceSourceId,
    type MeshTopicEntry,
    type TurnOutcome,
    type TurnReason,
} from '@adhdev/mesh-shared';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from './policy.js';
import {
    LEGACY_TURN_TABLES,
    TURN_LEDGER_SCHEMA_VERSION,
    ensureTurnLedgerSchema,
    readUserVersion,
    tableExists,
} from './schema.js';
import { TurnStore } from './store.js';
import type { TurnAttempt, TurnHold, TurnState } from './types.js';

export interface TurnLedgerMigrationOptions {
    /** The local daemon — owner of every migrated attempt (no historical value exists). */
    ownerDaemonId: string;
    nowMs?: number;
    policy?: TurnPolicy;
    /** JSONL export path; null skips the export (tests only). */
    exportPath: string | null;
    /** Step 0: the legacy pending-events JSONL import. */
    beforeFold?: () => void;
}

export interface TurnLedgerMigrationReport {
    skipped: boolean;
    meshes: number;
    legacyAttempts: number;
    attempts: number;
    folds: number;
    retries: number;
    orphans: number;
    openAttempts: number;
    unmappedReasons: number;
    events: number;
    eventCollisions: number;
    heldSuspensions: number;
    holdsActive: number;
    inflightHolds: number;
    inflightHoldsDropped: number;
    deliveries: number;
    deliveriesMerged: number;
    deliveriesDropped: number;
    directDispatches: number;
    directDispatchesMerged: number;
    directDispatchesDropped: number;
    fingerprintsDropped: number;
    pendingEvents: number;
    pendingUndrained: number;
    pendingNotified: number;
    pendingDrainedAcked: number;
    ledgerRows: number;
    operatingNotes: number;
    operatingNoteTombstones: number;
    ledgerRowsDropped: number;
    exportedRows: number;
    exportPath: string | null;
    droppedTables: string[];
}

function emptyReport(): TurnLedgerMigrationReport {
    return {
        skipped: false, meshes: 0, legacyAttempts: 0, attempts: 0, folds: 0, retries: 0, orphans: 0, openAttempts: 0, unmappedReasons: 0,
        events: 0, eventCollisions: 0, heldSuspensions: 0, holdsActive: 0, inflightHolds: 0, inflightHoldsDropped: 0,
        deliveries: 0, deliveriesMerged: 0, deliveriesDropped: 0, directDispatches: 0, directDispatchesMerged: 0, directDispatchesDropped: 0,
        fingerprintsDropped: 0, pendingEvents: 0, pendingUndrained: 0, pendingNotified: 0, pendingDrainedAcked: 0,
        ledgerRows: 0, operatingNotes: 0, operatingNoteTombstones: 0, ledgerRowsDropped: 0,
        exportedRows: 0, exportPath: null, droppedTables: [],
    };
}

/** The reasons whose successor row is the SAME attempt one generation later (C3 step 1). */
export function isFoldReason(reason: string | null | undefined): boolean {
    if (!reason) return false;
    return reason.startsWith('reassigned:') || reason === 'superseded_by_attempt' || reason === 'superseded_by_queue_terminal';
}

const OPERATOR_CANCEL_KIND = 'coordinator_operating_note';
const OPERATOR_TOMBSTONE_KIND = 'coordinator_operating_note_tombstone';
const TERMINAL_EVENTS = new Set(['agent:generating_completed', 'agent:stopped']);

interface LegacyAttemptRow {
    attempt_id: string; mesh_id: string; task_id: string; attempt_seq: number; node_id: string | null; session_id: string | null;
    provider_type: string | null; coordinator_daemon_id: string | null; coordinator_session_id: string | null; dispatch_nonce: number | null;
    stage: string; redrive_count: number; lease_deadline_ms: number | null; accepted_at: string | null; delivered_at: string | null;
    consumed_at: string | null; terminal_outcome: string | null; terminal_reason: string | null; terminal_at: string | null;
    created_at: string; updated_at: string;
}

function ms(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const value = Date.parse(iso);
    return Number.isFinite(value) ? value : null;
}

const TERMINAL_STAGES = new Set(['completed', 'failed', 'cancelled']);

function mapStage(stage: string): { state: TurnState; suspension: TurnAttempt['suspension'] } {
    switch (stage) {
        case 'accepted': case 'delivered': case 'consumed': case 'generating': case 'finalizing':
            return { state: stage, suspension: null };
        case 'waiting_approval': return { state: 'suspended', suspension: 'approval' };
        case 'waiting_choice': return { state: 'suspended', suspension: 'choice' };
        case 'completed': case 'failed': case 'cancelled':
            return { state: stage, suspension: null };
        default:
            return { state: 'accepted', suspension: null };
    }
}

/** Legacy free-form reason → closed TurnReason + provenance. `mapped:false` = fell back by outcome. */
export function mapLegacyTerminal(reason: string | null, outcome: TurnOutcome): { reason: TurnReason; source: EvidenceSourceId; strength: CommitStrength; mapped: boolean } {
    const r = (reason ?? '').trim();
    const pick = (value: TurnReason, source: EvidenceSourceId, strength: CommitStrength = 'genuine') => ({ reason: value, source, strength, mapped: true });
    if (r === 'provider_event' || r === 'task_completed') return pick('turn_end', 'fsm_edge');
    if (r.startsWith('worker_reported')) return pick('worker_reported', 'worker_tool', 'tool_report');
    if (r === 'redrive_deadline_transcript_evidence') return pick('transcript_final', 'coordinator_probe');
    if (r.startsWith('task_status_terminal:') || r.startsWith('unsettled_attempt_safety_net')) return pick('operator_update', 'operator', 'operator');
    if (r === 'operator_cancel') return pick('operator_cancel', 'operator', 'operator');
    if (r === 'task_stalled') return pick('hard_ceiling', 'scheduler');
    if (r === 'reassigned:dispatch_failed') return pick('dispatch_failed', 'scheduler');
    if (r === 'reassigned:delivered_not_consumed_redrive') return pick('delivered_not_consumed_redrive', 'scheduler');
    if (r === 'reassigned:delivered_no_turn_deadline') return pick('delivered_no_turn_deadline', 'scheduler');
    if (r === 'reassigned:reclaim_after_unknown_grace') return pick('session_dead', 'scheduler');
    if (r.startsWith('reassigned:')) return pick('assigned_stranded_dispatch_unconfirmed', 'scheduler');
    if (r === 'superseded_by_attempt' || r === 'superseded_by_queue_terminal') return pick('superseded', 'scheduler', 'operator');
    const fallback: Record<TurnOutcome, TurnReason> = { completed: 'turn_end', failed: 'session_error', cancelled: 'operator_cancel' };
    return {
        reason: fallback[outcome],
        source: outcome === 'cancelled' ? 'operator' : 'scheduler',
        strength: outcome === 'cancelled' ? 'operator' : 'genuine',
        mapped: r === '',
    };
}

/** Dump every legacy table as JSONL (`{_table, ...columns}`), one line per row. Returns rows written. */
export function exportLegacyTurnTables(db: DatabaseHandle, path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a', 0o600);
    let written = 0;
    try {
        for (const table of LEGACY_TURN_TABLES) {
            if (!tableExists(db, table)) continue;
            for (const row of db.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<Record<string, unknown>>) {
                writeSync(fd, `${JSON.stringify({ _table: table, ...row })}\n`);
                written++;
            }
        }
    } finally {
        closeSync(fd);
    }
    return written;
}

/** `turn-ledger-premigrate-<ts>.jsonl` next to the ledger (caller supplies the dir). */
export function turnLedgerExportPath(ledgerDir: string, nowMs: number): string {
    return `${ledgerDir.replace(/[\\/]+$/, '')}/turn-ledger-premigrate-${nowMs}.jsonl`;
}

function parseObject(text: unknown): Record<string, unknown> {
    if (typeof text !== 'string' || !text) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

interface Chain {
    attempt: TurnAttempt;
    /** legacy attempt_id → folded generation */
    members: Map<string, number>;
    queueRow: boolean;
    lastUpdatedMs: number;
}

function legacyMeshIds(db: DatabaseHandle): string[] {
    const ids = new Set<string>();
    for (const table of LEGACY_TURN_TABLES) {
        if (!tableExists(db, table)) continue;
        for (const row of db.prepare(`SELECT DISTINCT mesh_id AS m FROM ${table}`).all() as Array<{ m: string | null }>) {
            ids.add(row.m ?? '');
        }
    }
    return [...ids].sort();
}

function migrateMesh(db: DatabaseHandle, store: TurnStore, meshId: string, opts: Required<Pick<TurnLedgerMigrationOptions, 'ownerDaemonId'>> & { nowMs: number; policy: TurnPolicy }, report: TurnLedgerMigrationReport): void {
    const has = (table: string) => tableExists(db, table);
    const nowMs = opts.nowMs;
    const chains: Chain[] = [];
    const byLegacyId = new Map<string, Chain>();
    const latestChainForTask = new Map<string, Chain>();

    // ── a/b. attempts → folded chains ────────────────────────────────────
    if (has('mesh_turn_attempts')) {
        const rows = db.prepare(`SELECT * FROM mesh_turn_attempts WHERE mesh_id = ? ORDER BY task_id, attempt_seq, created_at`).all(meshId) as LegacyAttemptRow[];
        report.legacyAttempts += rows.length;
        const queueRow = db.prepare(`SELECT 1 AS ok FROM mesh_queue WHERE mesh_id = ? AND id = ?`);
        let prev: LegacyAttemptRow | null = null;
        let chain: Chain | null = null;
        let attemptNo = 0;
        for (const row of rows) {
            const sameTask = prev !== null && prev.task_id === row.task_id;
            const { state, suspension } = mapStage(row.stage);
            const session = row.session_id && row.session_id.length > 0 ? row.session_id : `unknown:${row.attempt_id}`;
            const outcome = (row.terminal_outcome ?? (TERMINAL_STAGES.has(row.stage) ? row.stage : null)) as TurnOutcome | null;
            if (sameTask && chain && isFoldReason(prev!.terminal_reason)) {
                // Same attempt, next generation: the predecessor was reassigned/superseded.
                const a = chain.attempt;
                a.prevGeneration = { sessionId: a.sessionId, consumed: a.consumedAt !== null };
                a.generation += 1;
                a.reclaimCount += 1;
                report.folds++;
                chain.members.set(row.attempt_id, a.generation);
            } else {
                if (sameTask) { attemptNo += 1; report.retries++; } else attemptNo = 0;
                const hasQueue = !!queueRow.get(meshId, row.task_id);
                chain = {
                    attempt: {
                        attemptId: row.attempt_id, scope: hasQueue ? 'mesh_queue' : 'mesh_direct', meshId: meshId || null, taskId: row.task_id,
                        attemptNo, sessionId: session, nodeId: row.node_id, providerType: row.provider_type, ownerDaemonId: opts.ownerDaemonId,
                        generation: 0, prevGeneration: null, dispatchNonce: row.dispatch_nonce, messageId: null, consumeProfile: 'default', maxTaskRetries: 1,
                        state, suspension, redriveCount: 0, reclaimCount: 0, hollowCount: 0, livenessFailStreak: 0, lastLiveness: null,
                        coordinator: { daemonId: row.coordinator_daemon_id, sessionId: row.coordinator_session_id },
                        acceptedAt: ms(row.accepted_at) ?? ms(row.created_at) ?? nowMs, deliveredAt: null, consumedAt: null, lastActivityAt: null,
                        weakSince: null, candidateNotifiedGeneration: null, lastNoProgressNoticeAt: null, notifiedAt: null, terminal: null, data: {},
                    },
                    members: new Map([[row.attempt_id, 0]]),
                    queueRow: hasQueue,
                    lastUpdatedMs: 0,
                };
                chains.push(chain);
            }
            // The chain's live fields follow its LATEST generation.
            const a = chain.attempt;
            a.sessionId = session;
            a.nodeId = row.node_id ?? a.nodeId;
            a.providerType = row.provider_type ?? a.providerType;
            a.dispatchNonce = row.dispatch_nonce ?? a.dispatchNonce;
            a.state = state;
            a.suspension = suspension;
            a.redriveCount = row.redrive_count ?? 0;
            a.deliveredAt = ms(row.delivered_at);
            a.consumedAt = ms(row.consumed_at);
            a.coordinator = { daemonId: row.coordinator_daemon_id ?? a.coordinator.daemonId, sessionId: row.coordinator_session_id ?? a.coordinator.sessionId };
            if (outcome) {
                const mapped = mapLegacyTerminal(row.terminal_reason, outcome);
                if (!mapped.mapped) report.unmappedReasons++;
                a.state = outcome;
                a.suspension = null;
                a.terminal = { outcome, reason: mapped.reason, source: mapped.source, strength: mapped.strength, at: ms(row.terminal_at) ?? ms(row.updated_at) ?? nowMs };
            } else {
                a.terminal = null;
            }
            chain.lastUpdatedMs = ms(row.updated_at) ?? nowMs;
            byLegacyId.set(row.attempt_id, chain);
            latestChainForTask.set(row.task_id, chain);
            prev = row;
        }
    }

    const openBySession = new Map<string, Chain>();
    for (const chain of chains) {
        const a = chain.attempt;
        if (a.terminal) continue;
        // b. August orphans: no queue row and idle past the hard ceiling.
        const orphan = !chain.queueRow && nowMs - chain.lastUpdatedMs > opts.policy.hardCeilingMs;
        // ≤1 open attempt per session: the older of two open attempts on one session is orphaned too.
        const holder = openBySession.get(a.sessionId);
        if (orphan || holder) {
            const victim = orphan || !holder ? chain : (holder.lastUpdatedMs <= chain.lastUpdatedMs ? holder : chain);
            victim.attempt.state = 'failed';
            victim.attempt.suspension = null;
            victim.attempt.terminal = { outcome: 'failed', reason: 'migration_orphan', source: 'scheduler', strength: 'genuine', at: nowMs };
            report.orphans++;
            if (victim === holder) openBySession.set(a.sessionId, chain);
            continue;
        }
        openBySession.set(a.sessionId, chain);
    }
    for (const chain of chains) {
        store.upsertAttempt(chain.attempt, nowMs);
        report.attempts++;
        if (!chain.attempt.terminal) {
            report.openAttempts++;
            // Invariant 4: every open non-plain attempt carries a hard ceiling (fresh from migration).
            store.syncHolds(chain.attempt.attemptId, [{
                holdId: `${chain.attempt.attemptId}:hard_ceiling`, attemptId: chain.attempt.attemptId, generation: null, reason: 'hard_ceiling',
                until: nowMs + opts.policy.hardCeilingMs, onExpire: 'escalate', data: {}, createdAt: nowMs,
            } satisfies TurnHold], nowMs);
        }
    }

    // ── c. events 1:1 ────────────────────────────────────────────────────
    if (has('mesh_turn_events')) {
        const rows = db.prepare(`SELECT * FROM mesh_turn_events WHERE mesh_id = ?`).all(meshId) as Array<{
            event_id: string; attempt_id: string; task_id: string; kind: string; dedupe_key: string; payload: string; occurred_at_ms: number | null; recorded_at: string;
        }>;
        for (const row of rows) {
            const chain = byLegacyId.get(row.attempt_id);
            const generation = chain?.members.get(row.attempt_id) ?? 0;
            const verdict = row.kind.startsWith('rejected_') ? 'rejected' as const : 'applied' as const;
            const recordedAt = ms(row.recorded_at) ?? nowMs;
            const inserted = store.insertEvent({
                eventId: row.event_id,
                meshId: meshId || null,
                attemptId: chain?.attempt.attemptId ?? row.attempt_id,
                generation,
                sessionId: chain?.attempt.sessionId ?? '',
                kind: row.kind,
                source: 'migration',
                verdict,
                ...(verdict === 'rejected' ? { rejection: row.kind.slice('rejected_'.length) } : {}),
                dedupeKey: row.dedupe_key ?? '',
                payload: { ...(meshId ? { meshId } : {}), legacy: parseObject(row.payload) },
                publishState: 'none',
                atMs: row.occurred_at_ms ?? recordedAt,
                recordedAt,
            });
            if (inserted) report.events++;
            else report.eventCollisions++;
        }
    }

    // ── d. held suspensions / inflight holds → turn_holds ────────────────
    if (has('mesh_turn_held_suspensions')) {
        const rows = db.prepare(`SELECT * FROM mesh_turn_held_suspensions WHERE mesh_id = ?`).all(meshId) as Array<{
            hold_id: string; attempt_id: string; stage: string; status: string; recorded_at: string; resolved_at: string | null;
        }>;
        const insert = db.prepare(`INSERT OR IGNORE INTO turn_holds (hold_id, attempt_id, generation, reason, until_ms, on_expire, data_json, status, created_at, resolved_at)
            VALUES (?, ?, ?, 'suspension_before_consumed', NULL, 'release', ?, ?, ?, ?)`);
        for (const row of rows) {
            report.heldSuspensions++;
            const chain = byLegacyId.get(row.attempt_id);
            const attemptId = chain?.attempt.attemptId ?? row.attempt_id;
            const modal = row.stage === 'waiting_choice' ? 'choice' : 'approval';
            const open = row.status === 'held' && chain && !chain.attempt.terminal;
            if (open) report.holdsActive++;
            insert.run(
                open ? `${attemptId}:suspension_before_consumed` : `legacy:${row.hold_id}`,
                attemptId,
                chain?.members.get(row.attempt_id) ?? null,
                JSON.stringify({ modal, legacyStatus: row.status }),
                open ? 'active' : 'resolved',
                ms(row.recorded_at) ?? nowMs,
                open ? null : (ms(row.resolved_at) ?? nowMs),
            );
        }
    }
    if (has('mesh_inflight_hold')) {
        const rows = db.prepare(`SELECT * FROM mesh_inflight_hold WHERE mesh_id IS ?`).all(meshId || null) as Array<{ task_id: string; held_at: number | null }>;
        for (const row of rows) {
            report.inflightHolds++;
            const chain = latestChainForTask.get(row.task_id);
            if (!chain || chain.attempt.terminal) { report.inflightHoldsDropped++; continue; }
            const a = chain.attempt;
            const holds = [...store.activeHolds(a.attemptId).filter((h) => h.reason !== 'liveness'), {
                holdId: `${a.attemptId}:liveness`, attemptId: a.attemptId, generation: a.generation, reason: 'liveness' as const,
                until: (row.held_at ?? nowMs) + opts.policy.livenessDeadlineMs, onExpire: 'escalate' as const, data: {}, createdAt: row.held_at ?? nowMs,
            }];
            store.syncHolds(a.attemptId, holds, nowMs);
        }
    }

    // ── e. delivery / direct-dispatch rows → attempt columns ─────────────
    const setDelivery = db.prepare(`UPDATE turn_attempts SET delivered_at = COALESCE(delivered_at, ?), notified_at = COALESCE(notified_at, ?),
        input_json = COALESCE(input_json, ?), updated_at = ? WHERE attempt_id = ?`);
    if (has('mesh_session_delivery')) {
        const rows = db.prepare(`SELECT * FROM mesh_session_delivery WHERE mesh_id = ?`).all(meshId) as Array<{
            task_id: string | null; status: string; input: string | null; created_at: string; updated_at: string;
        }>;
        for (const row of rows) {
            report.deliveries++;
            const chain = row.task_id ? latestChainForTask.get(row.task_id) : undefined;
            if (!chain) { report.deliveriesDropped++; continue; }
            const delivered = ['delivered', 'acked', 'completed'].includes(row.status) ? ms(row.created_at) : null;
            const notified = ['acked', 'completed'].includes(row.status) ? ms(row.updated_at) : null;
            setDelivery.run(delivered, notified, row.input, nowMs, chain.attempt.attemptId);
            report.deliveriesMerged++;
        }
    }
    if (has('mesh_direct_dispatches')) {
        const rows = db.prepare(`SELECT * FROM mesh_direct_dispatches WHERE mesh_id = ?`).all(meshId) as Array<{
            task_id: string; via: string; status: string; input: string | null; task_mode: string | null; dispatched_to_idle_session: number;
        }>;
        const setDirect = db.prepare(`UPDATE turn_attempts SET input_json = COALESCE(input_json, ?), via = COALESCE(via, ?), data_json = ?, updated_at = ? WHERE attempt_id = ?`);
        for (const row of rows) {
            report.directDispatches++;
            const chain = latestChainForTask.get(row.task_id);
            if (!chain) { report.directDispatchesDropped++; continue; }
            const data = { ...chain.attempt.data, directDispatch: { status: row.status, idleSession: row.dispatched_to_idle_session === 1, ...(row.task_mode ? { taskMode: row.task_mode } : {}) } };
            setDirect.run(row.input, row.via, JSON.stringify(data), nowMs, chain.attempt.attemptId);
            report.directDispatchesMerged++;
        }
    }

    // ── f. fingerprints: dropped ─────────────────────────────────────────
    if (has('mesh_completion_fingerprints')) {
        report.fingerprintsDropped += (db.prepare(`SELECT COUNT(*) AS n FROM mesh_completion_fingerprints WHERE mesh_id = ?`).get(meshId) as { n: number }).n;
    }

    // ── g. pending events: undrained → turn.notify{mesh_event} pending ───
    if (has('mesh_pending_events')) {
        const rows = db.prepare(`SELECT * FROM mesh_pending_events WHERE mesh_id = ? ORDER BY queued_at, id`).all(meshId) as Array<{
            id: string; coordinator_daemon_id: string | null; event: string; payload: string; queued_at: number; drained: number; drained_at: number | null; intended_for: string | null;
        }>;
        const markNotified = db.prepare(`UPDATE turn_attempts SET notified_at = COALESCE(notified_at, ?) WHERE attempt_id = ?`);
        for (const row of rows) {
            report.pendingEvents++;
            const payload = parseObject(row.payload);
            const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined;
            if (row.drained === 1) {
                const chain = taskId ? latestChainForTask.get(taskId) : undefined;
                if (chain && TERMINAL_EVENTS.has(row.event) && row.drained_at) {
                    markNotified.run(row.drained_at, chain.attempt.attemptId);
                    report.pendingDrainedAcked++;
                }
                continue;
            }
            report.pendingUndrained++;
            const eventId = `migrated_pending:${row.id}`;
            const target = row.coordinator_daemon_id && isEvidenceIdentifier(row.coordinator_daemon_id) ? row.coordinator_daemon_id : opts.ownerDaemonId;
            const targetSession = row.intended_for && isEvidenceIdentifier(row.intended_for) ? row.intended_for : undefined;
            const entry: MeshTopicEntry = {
                v: MESH_TOPIC_PROTOCOL_VERSION, eventId, at: row.queued_at, k: 'turn.notify', notify: 'mesh_event', targetDaemonId: target,
                ...(targetSession ? { targetSessionId: targetSession } : {}),
                ...(taskId && isEvidenceIdentifier(taskId) ? { taskId } : {}),
            };
            if (!meshId) continue; // a notice with no mesh has no topic to publish on
            const inserted = store.insertEvent({
                eventId, meshId, attemptId: null, generation: null, sessionId: targetSession ?? '', kind: 'notify', source: 'migration',
                verdict: 'applied', dedupeKey: eventId,
                payload: { meshId, notify: 'mesh_event', event: row.event, entry, local: { payload } },
                publishState: 'pending', atMs: row.queued_at, recordedAt: nowMs,
            });
            if (inserted) report.pendingNotified++;
        }
    }

    // ── h. operating notes out of mesh_event_ledger; the rest dropped ───
    if (has('mesh_event_ledger')) {
        report.ledgerRows += (db.prepare(`SELECT COUNT(*) AS n FROM mesh_event_ledger WHERE mesh_id = ?`).get(meshId) as { n: number }).n;
        const notes = db.prepare(`SELECT * FROM mesh_event_ledger WHERE mesh_id = ? AND kind IN (?, ?) ORDER BY timestamp, rowid`)
            .all(meshId, OPERATOR_CANCEL_KIND, OPERATOR_TOMBSTONE_KIND) as Array<{ id: string; timestamp: string; kind: string; session_id: string | null; payload: string }>;
        const byText = new Map<string, string[]>();
        for (const row of notes) {
            const payload = parseObject(row.payload);
            const at = ms(row.timestamp) ?? nowMs;
            if (row.kind === OPERATOR_CANCEL_KIND) {
                const text = typeof payload.text === 'string' ? payload.text.trim() : '';
                if (!text) continue;
                if (store.insertOperatingNote({ noteId: row.id, meshId, text, category: typeof payload.category === 'string' ? payload.category : null, callerSessionId: row.session_id, createdAt: at })) {
                    report.operatingNotes++;
                    byText.set(text, [...(byText.get(text) ?? []), row.id]);
                }
            } else {
                report.operatingNoteTombstones++;
                const targetId = typeof payload.targetNoteId === 'string' ? payload.targetNoteId.trim() : '';
                const targetFp = typeof payload.targetFingerprint === 'string' ? payload.targetFingerprint.trim() : '';
                if (targetId) store.tombstoneOperatingNote(meshId, targetId, at);
                for (const id of targetFp ? byText.get(targetFp) ?? [] : []) store.tombstoneOperatingNote(meshId, id, at);
            }
        }
    }

    // ── move: delete this mesh's legacy rows ─────────────────────────────
    for (const table of LEGACY_TURN_TABLES) {
        if (!has(table)) continue;
        const changes = db.prepare(`DELETE FROM ${table} WHERE mesh_id IS ?`).run(meshId || null).changes
            + (meshId ? 0 : db.prepare(`DELETE FROM ${table} WHERE mesh_id = ''`).run().changes);
        if (table === 'mesh_event_ledger') report.ledgerRowsDropped += changes;
    }
}

/**
 * Run the one-way v1 migration. No-op (`skipped: true`) once user_version ≥ 1.
 * Throws on a failure inside a mesh's transaction (that mesh is rolled back;
 * earlier meshes stay moved) — the caller logs and the next boot resumes.
 */
export function migrateTurnLedgerV1(db: DatabaseHandle, options: TurnLedgerMigrationOptions): TurnLedgerMigrationReport {
    const report = emptyReport();
    ensureTurnLedgerSchema(db);
    if (readUserVersion(db) >= TURN_LEDGER_SCHEMA_VERSION) {
        report.skipped = true;
        return report;
    }
    const nowMs = options.nowMs ?? Date.now();
    const policy = options.policy ?? DEFAULT_TURN_POLICY;
    options.beforeFold?.();

    if (options.exportPath) {
        report.exportedRows = exportLegacyTurnTables(db, options.exportPath);
        report.exportPath = options.exportPath;
    }

    const store = new TurnStore(db);
    const meshIds = legacyMeshIds(db);
    for (const meshId of meshIds) {
        db.transaction(() => migrateMesh(db, store, meshId, { ownerDaemonId: options.ownerDaemonId, nowMs, policy }, report)).immediate();
        report.meshes++;
    }

    db.transaction(() => {
        for (const table of LEGACY_TURN_TABLES) {
            if (!tableExists(db, table)) continue;
            db.exec(`DROP TABLE ${table}`);
            report.droppedTables.push(table);
        }
        db.pragma(`user_version = ${TURN_LEDGER_SCHEMA_VERSION}`);
    }).immediate();
    return report;
}

/** The migration log line (C8 live checklist item 1). */
export function formatTurnLedgerMigrationLine(r: TurnLedgerMigrationReport): string {
    if (r.skipped) return `turn-ledger migration v1: already at user_version ${TURN_LEDGER_SCHEMA_VERSION}`;
    return `turn-ledger migration v1: attempts ${r.legacyAttempts}→${r.attempts} (${r.folds} folds, ${r.retries} retries, ${r.orphans} orphans, ${r.openAttempts} open, ${r.unmappedReasons} free-text reasons),`
        + ` events ${r.events} (+${r.eventCollisions} collisions), held ${r.heldSuspensions} (${r.holdsActive} active), inflight holds ${r.inflightHolds} (${r.inflightHoldsDropped} dropped),`
        + ` deliveries ${r.deliveriesMerged}/${r.deliveries} merged (${r.deliveriesDropped} dropped), direct ${r.directDispatchesMerged}/${r.directDispatches} merged (${r.directDispatchesDropped} dropped),`
        + ` fingerprints ${r.fingerprintsDropped} dropped, pending ${r.pendingEvents} (${r.pendingUndrained} undrained → ${r.pendingNotified} turn.notify pending, ${r.pendingDrainedAcked} acks),`
        + ` ledger ${r.ledgerRows} rows (${r.operatingNotes} notes, ${r.operatingNoteTombstones} tombstones kept; ${r.ledgerRowsDropped} dropped),`
        + ` meshes ${r.meshes}, exported ${r.exportedRows} rows${r.exportPath ? ` → ${r.exportPath}` : ''}, dropped [${r.droppedTables.join(',')}], user_version=${TURN_LEDGER_SCHEMA_VERSION}`;
}
