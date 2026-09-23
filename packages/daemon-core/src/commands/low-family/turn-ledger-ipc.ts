/**
 * turn-ledger-ipc — daemon-side responders for the eight C-W6 IPC commands
 * (`@adhdev/mesh-shared` `turn-ipc.ts`).
 *
 * Wiring-unification Phase C, workstream C-W6
 * (docs/design/2026-09-23-wiring-unification.md §5 C2 "MCP server" paragraph).
 *
 * (C-W8: + `note_upsert` / `note_forget` — operating notes over local IPC.)
 *
 * SCOPE: this file is the RESPONDER side. `mcp-server/src/ipc/turn-commands.ts`
 * (C-W6 pre-work, landed) is the CLIENT — it calls `transport.command(name,
 * args)` exactly like every other mesh tool. These specs are what answers
 * that call once it reaches the daemon that owns the turn ledger / seqscribe
 * node. `sources: ['ipc']` on every spec below means these eight commands are
 * reachable ONLY over the local IPC transport (`IpcTransport`/`LocalTransport`
 * — never P2P/WS/ext), matching the design's "executed in the daemon that
 * owns the turn ledger and the seqscribe node" and the fact that mcp-server
 * is always local to that daemon's machine.
 *
 * LATE-BINDING THE TURN LEDGER
 * -----------------------------
 * `createMeshRuntimeTurnLedger()` (turn-ledger/runtime-ledger.ts, C-W2) is
 * constructed once at boot and should be threaded through `components`/
 * `CommandRouterDeps` — that boot wiring is C-W3's (see the C-W6 report's
 * REQUESTED EDITS: "Construct one `createMeshRuntimeTurnLedger(...)` and pass
 * it by value"). It is not there yet at the time this file lands, so
 * `setActiveTurnLedgerForIpc()` below is a late-binding module-level slot:
 * whichever boot stage constructs the ledger calls it once, and every handler
 * here reads it through `activeTurnLedger()`, returning the structured
 * `turn_ledger_unavailable` error code (not a thrown exception, not a silent
 * no-op) when it is unset — mid-boot, mid-migration, or before C-W3 wires it
 * at all. This is intentionally the SAME shape `TurnIpcError` already
 * documents for "a daemon answered but its turn ledger is not armed yet".
 *
 * WHAT MOVES HERE VS. WHAT DOESN'T (per the C-W2 report + the C-W6 brief)
 * -------------------------------------------------------------------------
 *   - mesh_record       → `meshRecord()` (mesh/mesh-record.ts, C-W2 pre-work,
 *     already the target of `appendLedgerEntry`'s replication leg).
 *   - operator_status    → `ledger.observe()` with an `operator_status`
 *     evidence body. The former `recordMeshCoordinatorToolCall` log write
 *     (`mesh_tool_call_log`, rate-limit advisory) is a SEPARATE concern this
 *     command does not replace — mcp-server call sites that only wanted the
 *     rate-limit advisory, not an evidence-kind status, stay open for the
 *     C-W6 migration to sort per-site (flagged in the pre-work report).
 *   - turn_observe / turn_cancel → `ledger.observe()` directly (turn_cancel
 *     builds a `cancel`-kind evidence envelope from attemptId XOR taskId).
 *   - turn_query          → `TurnStore` read methods (own-daemon scope only
 *     today — `listOpenAttempts`/`listAttemptsForTask`/`listEvents`). Fleet
 *     scope and `replicationPending` need `mesh_topic_index` (C-W3's table,
 *     not built yet) — see the handler's own comment.
 *   - mesh_index_query    → NOT YET BACKED. `mesh/mesh-topic-index.ts` is
 *     C-W3's file (my HARD RULES explicitly bar me from touching it). This
 *     handler returns `turn_ledger_unavailable` with a detail naming the
 *     missing dependency until C-W3 lands it — a REQUESTED EDIT, not a gap
 *     silently swallowed.
 *   - mission_upsert / mission_query → `mesh/mesh-missions.ts`'s existing
 *     `upsertMeshMission`/`getMeshMissions`/`getMeshMission` (already the
 *     mission-table API; this just exposes it over IPC instead of letting
 *     mcp-server call it in-process).
 */

import { randomUUID } from 'crypto';
import { CANCEL_REASONS, type CancelReason, type TurnEvidence } from '@adhdev/mesh-shared';
import {
    decodeMeshIndexQueryRequest,
    decodeMeshRecordRequest,
    isMeshIndexQueryResponse,
    MESH_RECORD_PAYLOAD_KEYS,
    MAX_MESH_RECORD_STRING,
    decodeMissionQueryRequest,
    decodeMissionUpsertRequest,
    decodeNoteForgetRequest,
    decodeNoteUpsertRequest,
    decodeOperatorStatusRequest,
    decodeTurnCancelRequest,
    decodeTurnObserveRequest,
    decodeTurnQueryRequest,
    type MeshIndexQueryResponse,
    type MeshTopicIndexRow,
    type MeshMissionRecordWire,
    type MeshRecordResponse,
    type MissionQueryResponse,
    type MissionUpsertResponse,
    type NoteForgetResponse,
    type NoteUpsertResponse,
    type OperatorStatusResponse,
    type TurnCancelResponse,
    type TurnObserveResponse,
    type TurnQueryResponse,
} from '@adhdev/mesh-shared';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';
import type { TurnLedger } from '../../mesh/turn-ledger/ledger.js';
import { getActiveTurnLedger, setActiveTurnLedger } from '../../mesh/turn-ledger/active-ledger.js';
import { meshRecordAppended } from '../../mesh/mesh-record.js';
import type { MeshIndexView, MeshTopicIndex } from '../../mesh/mesh-topic-index.js';
import {
    getMeshMission,
    getMeshMissions,
    upsertMeshMission,
    type MeshMissionRecord,
} from '../../mesh/mesh-missions.js';
import { LOG } from '../../logging/logger.js';
import { forgetOperatingNote, readOperatingNotes, recordOperatingNote } from '../../mesh/mesh-operating-notes.js';
import { isWorkerMcpEnabled, mintWorkerTaskToken } from '../../mesh/worker-mcp-isolation.js';

// ─── late-binding slot (see file header) ────────────────────────────────────


/** The `mesh_topic_index` reader behind `mesh_index_query` (bound with the ledger). */
export interface TurnLedgerIpcIndex {
    index: Pick<MeshTopicIndex, 'query'>;
    /** This daemon's seqscribe writer id (`writer: 'own'` scope); null → own-scope reads answer empty. */
    ownWriter: () => string | null;
    /** C7-5: another writer's `mesh.<id>.events` entries have not replicated here yet. */
    replicationPending?: (meshId: string) => boolean;
}

let indexSlot: TurnLedgerIpcIndex | null = null;

/**
 * C-W3's boot stage calls this once, right after
 * `createMeshRuntimeTurnLedger()` — REQUESTED EDIT, see file header. Passing
 * `null` (e.g. on a re-boot path, or a daemon that never arms seqscribe)
 * makes every handler below answer `turn_ledger_unavailable` again rather
 * than holding a stale reference.
 */
export function setActiveTurnLedgerForIpc(ledger: TurnLedger | null, index: TurnLedgerIpcIndex | null = null): void {
    // C-W8: the ledger lives in the process-wide slot (mesh/turn-ledger/
    // runtime-ledger.ts) so mesh/ writers reach the same one; the index is IPC-only.
    setActiveTurnLedger(ledger);
    indexSlot = ledger ? index : null;
}

/** Test-only accessor — mirrors the pattern other late-bound slots in this codebase use. */
export function getActiveTurnLedgerForIpc(): TurnLedger | null {
    return getActiveTurnLedger();
}

interface IpcErrorResult {
    success: false;
    error: string;
    code: 'daemon_required' | 'turn_ledger_unavailable' | 'ledger_not_owner';
    [key: string]: unknown;
}

function unavailable(detail: string): IpcErrorResult {
    return { success: false, error: `turn ledger unavailable: ${detail}`, code: 'turn_ledger_unavailable' };
}

function badRequest(command: string): { success: false; error: string } {
    return { success: false, error: `${command}: request failed decode (bad shape)` };
}

// ─── turn_observe ────────────────────────────────────────────────────────

/**
 * WORKER-MCP (design §9.2.1, "★함정"): a direct dispatch (`mesh_send_task`)
 * bypasses the queue claim, whose seam mints the worker's task token. C-W8
 * moves the direct arm's mint onto ATTEMPT CREATION here — the daemon that owns
 * the ledger (and the in-memory token registry) — instead of the retired
 * `recordDirectDispatchTask` → legacy `openTurnAttempt` block, which ran in the
 * mcp-server process over IPC and so minted into the wrong process's registry.
 * Only a freshly APPLIED `dispatch_accepted` of scope `mesh_direct` mints; a
 * replay (`recorded`/`duplicate`) keeps the token already minted.
 */
function mintDirectDispatchWorkerToken(
    evidence: TurnEvidence,
    verdict: string,
    attempt: { attemptId: string; meshId: string | null; taskId: string | null; sessionId: string; nodeId: string | null },
): void {
    if (evidence.kind !== 'dispatch_accepted' || evidence.scope !== 'mesh_direct' || verdict !== 'applied') return;
    if (!isWorkerMcpEnabled() || !attempt.meshId || !attempt.taskId) return;
    try {
        mintWorkerTaskToken({
            meshId: attempt.meshId,
            taskId: attempt.taskId,
            attemptId: attempt.attemptId,
            ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
            ...(attempt.nodeId ? { nodeId: attempt.nodeId } : {}),
        });
    } catch (e: any) {
        LOG.warn('TurnLedgerIpc', `worker token mint failed for direct dispatch ${attempt.taskId}: ${e?.message ?? String(e)}`);
    }
}

const turnObserve: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeTurnObserveRequest(args);
    if (!req) return badRequest('turn_observe');
    const ledger = getActiveTurnLedger();
    if (!ledger) return unavailable('no active turn ledger (boot wiring pending — see file header)');
    try {
        const result = ledger.observe(req.evidence);
        if (!result.attempt) {
            return { success: false, error: 'turn_observe: evidence did not resolve to an attempt', code: 'ledger_not_owner' };
        }
        mintDirectDispatchWorkerToken(req.evidence, result.verdict, result.attempt);
        const response: TurnObserveResponse = {
            verdict: result.verdict === 'duplicate' ? 'recorded' : result.verdict === 'forwarded' ? 'recorded' : result.verdict,
            attemptRef: { attemptId: result.attempt.attemptId, generation: result.attempt.generation },
            ...(result.attempt.terminal ? { outcome: result.attempt.terminal.outcome } : {}),
        };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

// ─── mesh_record ─────────────────────────────────────────────────────────

const meshRecordHandler: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeMeshRecordRequest(args);
    if (!req) return badRequest('mesh_record');
    try {
        const result = await meshRecordAppended(req.meshId, req.ledgerKind, {
            ...(req.nodeId ? { nodeId: req.nodeId } : {}),
            ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            ...(req.taskId ? { taskId: req.taskId } : {}),
            payload: req.payload,
        });
        // The real append coordinate on `mesh.<id>.events`. seqscribe seqs
        // start at 1, so `seq: 0` unambiguously means "not appended" (no node
        // armed in this daemon / refused / rejected — each ERROR-logged).
        const response: MeshRecordResponse = { eventId: result.eventId, seq: result.appended?.seq ?? 0 };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

// ─── turn_cancel ─────────────────────────────────────────────────────────

function isCancelReason(value: string): value is CancelReason {
    return (CANCEL_REASONS as readonly string[]).includes(value);
}

const turnCancel: LowFamilyHandler = async (ctx: LowFamilyContext, args: any) => {
    const req = decodeTurnCancelRequest(args);
    if (!req) return badRequest('turn_cancel');
    // The wire contract's `reason` is the broad TurnReason union (shared with
    // turn_observe's evidence), but `cancel`-kind evidence only accepts the
    // narrower 5-value CancelReason — reject the rest with a clear message
    // rather than a cryptic reducer rejection.
    if (!isCancelReason(req.reason)) {
        return { success: false, error: `turn_cancel: '${req.reason}' is not a valid cancel reason (expected one of ${CANCEL_REASONS.join(', ')})` };
    }
    const ledger = getActiveTurnLedger();
    if (!ledger) return unavailable('no active turn ledger (boot wiring pending — see file header)');
    try {
        const attempt = req.attemptId
            ? ledger.getAttempt(req.attemptId)
            : req.taskId
                ? findLatestAttemptForTask(ledger, req.taskId)
                : null;
        if (!attempt) {
            return { success: false, error: 'turn_cancel: no attempt found for the given attemptId/taskId', code: 'ledger_not_owner' };
        }
        const evidence: TurnEvidence = {
            eventId: randomUUID(),
            at: Date.now(),
            source: 'mcp_probe',
            sessionId: attempt.sessionId,
            observedBy: ctx.deps.statusInstanceId ?? ledger.selfDaemonId,
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
            kind: 'cancel',
            reason: req.reason,
        };
        const result = ledger.observe(evidence);
        const response: TurnCancelResponse = {
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
            verdict: result.verdict === 'duplicate' || result.verdict === 'forwarded' ? 'recorded' : result.verdict,
        };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

/** `TurnLedger` has no direct `findLatestAttemptForTask` — it is a `TurnStore` method reached through `ledger.store`. */
function findLatestAttemptForTask(ledger: TurnLedger, taskId: string) {
    // meshId is unknown from a bare taskId at this call site; the store
    // method accepts `meshId: string | null` and scans across meshes when
    // null (see turn-ledger/store.ts findLatestAttemptForTask).
    return (ledger.store as unknown as {
        findLatestAttemptForTask(meshId: string | null, taskId: string): ReturnType<TurnLedger['getAttempt']>;
    }).findLatestAttemptForTask(null, taskId);
}

// ─── operator_status ───────────────────────────────────────────────────────

const operatorStatus: LowFamilyHandler = async (ctx: LowFamilyContext, args: any) => {
    const req = decodeOperatorStatusRequest(args);
    if (!req) return badRequest('operator_status');
    const ledger = getActiveTurnLedger();
    if (!ledger) return unavailable('no active turn ledger (boot wiring pending — see file header)');
    try {
        const attempt = findLatestAttemptForTask(ledger, req.taskId);
        if (!attempt) {
            // Fire-and-forget by design (per the wire contract's own doc
            // comment) — a task with no open/known attempt is not an error
            // worth surfacing to the caller, just a no-op accept.
            const response: OperatorStatusResponse = { accepted: true };
            return { success: true, ...response };
        }
        const evidence: TurnEvidence = {
            eventId: randomUUID(),
            at: Date.now(),
            source: 'mcp_probe',
            sessionId: attempt.sessionId,
            observedBy: ctx.deps.statusInstanceId ?? ledger.selfDaemonId,
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
            kind: 'operator_status',
            status: req.status,
            reason: req.reason,
        };
        ledger.observe(evidence);
        const response: OperatorStatusResponse = { accepted: true };
        return { success: true, ...response };
    } catch (e: any) {
        LOG.warn('TurnLedgerIpc', `operator_status observe failed (accepted anyway, fire-and-forget): ${e?.message ?? String(e)}`);
        const response: OperatorStatusResponse = { accepted: true };
        return { success: true, ...response };
    }
};

// ─── turn_query ─────────────────────────────────────────────────────────

const turnQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeTurnQueryRequest(args);
    if (!req) return badRequest('turn_query');
    const ledger = getActiveTurnLedger();
    if (!ledger) return unavailable('no active turn ledger (boot wiring pending — see file header)');
    try {
        const store = ledger.store as unknown as {
            getAttempt(attemptId: string): ReturnType<TurnLedger['getAttempt']>;
            listAttemptsForTask(meshId: string, taskId: string): ReturnType<TurnLedger['getAttempt']>[];
            listOpenAttempts(opts: { meshId?: string }): ReturnType<TurnLedger['getAttempt']>[];
            listEvents(attemptId: string): Array<{
                eventId: string; attemptId: string | null; generation: number | null;
                sessionId: string; kind: string; source: string; verdict: string; atMs: number;
            }>;
        };

        let attempts: NonNullable<ReturnType<TurnLedger['getAttempt']>>[] = [];
        if (req.attemptId) {
            const a = store.getAttempt(req.attemptId);
            if (a) attempts = [a];
        } else if (req.taskId) {
            attempts = store.listAttemptsForTask(req.meshId, req.taskId).filter((a): a is NonNullable<typeof a> => a !== null);
        } else {
            attempts = store.listOpenAttempts({ meshId: req.meshId }).filter((a): a is NonNullable<typeof a> => a !== null);
        }
        if (req.sessionId) attempts = attempts.filter((a) => a.sessionId === req.sessionId);
        if (req.state) attempts = attempts.filter((a) => a.state === req.state);
        if (typeof req.tail === 'number') attempts = attempts.slice(-req.tail);

        const events = req.attemptId ? store.listEvents(req.attemptId) : [];

        const response: TurnQueryResponse = {
            attempts: attempts.map((a) => ({
                attemptId: a.attemptId,
                generation: a.generation,
                ...(a.meshId ? { meshId: a.meshId } : {}),
                ...(a.taskId ? { taskId: a.taskId } : {}),
                sessionId: a.sessionId,
                ...(a.nodeId ? { nodeId: a.nodeId } : {}),
                ...(a.providerType ? { providerType: a.providerType } : {}),
                state: a.state,
                ...(a.terminal ? { terminalOutcome: a.terminal.outcome, terminalReason: a.terminal.reason } : {}),
                acceptedAt: a.acceptedAt,
                ...(a.terminal ? { terminalAt: a.terminal.at } : {}),
            })),
            events: events.map((e) => ({
                eventId: e.eventId,
                ...(e.attemptId ? { attemptId: e.attemptId } : {}),
                ...(e.generation !== null && e.generation !== undefined ? { generation: e.generation } : {}),
                sessionId: e.sessionId,
                kind: e.kind as TurnQueryResponse['events'][number]['kind'],
                source: e.source,
                verdict: e.verdict as TurnQueryResponse['events'][number]['verdict'],
                atMs: e.atMs,
            })),
            // C7-5 freshness: `mesh.<id>.events` replication-lag tracking is
            // C-W3's `mesh-topic-index.ts` (not built yet — see file header).
            // Own-scope reads (this handler, today) are always fresh by
            // construction (same daemon's own SQLite write path), so
            // `replicationPending` is correctly omitted here, not defaulted
            // to false — the field's absence means "not applicable to this
            // scope," which fleet-scope reads (mesh_index_query) will need
            // to set explicitly once that table exists.
        };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

// ─── mesh_index_query ────────────────────────────────────────────────────

const MESH_RECORD_PAYLOAD_KEY_SET: ReadonlySet<string> = new Set(MESH_RECORD_PAYLOAD_KEYS);
const MESH_INDEX_QUERY_MAX_TAIL = 500;

/**
 * One index view → the wire row, or null. The payload is re-projected onto the
 * `mesh_record` allow-list (MESH_RECORD_PAYLOAD_KEYS, scalar values, bounded
 * strings) — a fleet-wide read must never surface a key nobody reviewed, even
 * if a peer's entry carried one — and the row is then held to the wire guard.
 */
function toIndexRow(meshId: string, view: MeshIndexView): MeshTopicIndexRow | null {
    const payload: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(view.payload ?? {})) {
        if (!MESH_RECORD_PAYLOAD_KEY_SET.has(key)) continue;
        if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) payload[key] = value;
        else if (typeof value === 'string' && value.length <= MAX_MESH_RECORD_STRING) payload[key] = value;
    }
    const row: MeshTopicIndexRow = {
        writer: view.writer,
        seq: view.seq,
        meshId,
        eventId: view.id,
        kind: view.kind,
        ...(view.kind ? { ledgerKind: view.kind } : {}),
        ...(view.taskId ? { taskId: view.taskId } : {}),
        ...(view.sessionId ? { sessionId: view.sessionId } : {}),
        ...(view.nodeId ? { nodeId: view.nodeId } : {}),
        atMs: view.atMs,
        payload,
    };
    return isMeshIndexQueryResponse({ rows: [row] }) ? row : null;
}

const meshIndexQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeMeshIndexQueryRequest(args);
    if (!req) return badRequest('mesh_index_query');
    const slot = indexSlot;
    if (!getActiveTurnLedger() || !slot) return { ...unavailable('no mesh_topic_index bound (boot wiring pending)'), rows: [] };
    try {
        const scope = req.writer ?? 'fleet';
        const ownWriter = scope === 'own' ? slot.ownWriter() : null;
        if (scope === 'own' && !ownWriter) {
            const empty: MeshIndexQueryResponse = { rows: [] };
            return { success: true, ...empty };
        }
        const views = slot.index.query(req.meshId, {
            writer: scope === 'own' ? { scope: 'own', writer: ownWriter! } : { scope: 'fleet' },
            ...(req.ledgerKind ? { kinds: [req.ledgerKind] } : {}),
            ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            ...(req.taskId ? { taskId: req.taskId } : {}),
            ...(req.since !== undefined ? { sinceMs: req.since } : {}),
            tail: Math.min(req.tail && req.tail > 0 ? req.tail : MESH_INDEX_QUERY_MAX_TAIL, MESH_INDEX_QUERY_MAX_TAIL),
        });
        const rows = views.map((view) => toIndexRow(req.meshId, view)).filter((row): row is MeshTopicIndexRow => row !== null);
        const pending = scope === 'fleet' && slot.replicationPending ? slot.replicationPending(req.meshId) : false;
        const response: MeshIndexQueryResponse = { rows, ...(pending ? { replicationPending: true } : {}) };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

// ─── mission_upsert / mission_query ─────────────────────────────────────

function toWireMission(record: MeshMissionRecord): MeshMissionRecordWire {
    return {
        id: record.id,
        meshId: record.meshId,
        title: record.title,
        goal: record.goal,
        status: record.status,
        ...(record.source ? { source: record.source } : {}),
    };
}

const missionUpsert: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeMissionUpsertRequest(args);
    if (!req) return badRequest('mission_upsert');
    try {
        const record = upsertMeshMission(req.meshId, {
            ...(req.id ? { id: req.id } : {}),
            title: req.title,
            ...(req.goal !== undefined ? { goal: req.goal } : {}),
            ...(req.status ? { status: req.status } : {}),
            ...(req.source ? { source: req.source } : {}),
        });
        const response: MissionUpsertResponse = { mission: toWireMission(record) };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

const missionQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeMissionQueryRequest(args);
    if (!req) return badRequest('mission_query');
    try {
        if (req.id) {
            const record = getMeshMission(req.meshId, req.id);
            const response: MissionQueryResponse = { missions: record ? [toWireMission(record)] : [] };
            return { success: true, ...response };
        }
        const records = getMeshMissions(req.meshId, req.statuses ? [...req.statuses] : undefined);
        const response: MissionQueryResponse = { missions: records.map(toWireMission) };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

// ─── note_upsert / note_forget (C-W8) ─────────────────────────────────────

const noteUpsert: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeNoteUpsertRequest(args);
    if (!req) return badRequest('note_upsert');
    try {
        const before = new Set(readOperatingNotes(req.meshId).map((n) => n.id));
        const note = recordOperatingNote(req.meshId, {
            text: req.text,
            ...(req.category ? { category: req.category } : {}),
            ...(req.pinned ? { pinned: true } : {}),
            ...(req.expiresAt ? { expiresAt: new Date(req.expiresAt).toISOString() } : {}),
            ...(req.supersedes ? { supersedes: req.supersedes } : {}),
            ...(req.subjectKey ? { subjectKey: req.subjectKey } : {}),
            ...(req.sourceCoordinator ? { sourceCoordinator: req.sourceCoordinator, callerSessionId: req.sourceCoordinator } : {}),
        });
        const deduped = before.has(note.id);
        const response: NoteUpsertResponse = { noteId: note.id, deduped, createdAt: note.payload.createdAt };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

const noteForget: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeNoteForgetRequest(args);
    if (!req) return badRequest('note_forget');
    try {
        const result = forgetOperatingNote(req.meshId, {
            ...(req.noteId ? { noteId: req.noteId } : {}),
            ...(req.text ? { text: req.text } : {}),
            ...(req.reason ? { reason: req.reason } : {}),
        });
        const response: NoteForgetResponse = { matched: result.matched, tombstoneId: result.tombstoneId };
        return { success: true, ...response };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};

// ─── registration ────────────────────────────────────────────────────────

export const turnLedgerIpcHandlers: Record<string, LowFamilyHandler> = {
    turn_observe: turnObserve,
    mesh_record: meshRecordHandler,
    turn_cancel: turnCancel,
    operator_status: operatorStatus,
    turn_query: turnQuery,
    mesh_index_query: meshIndexQuery,
    mission_upsert: missionUpsert,
    mission_query: missionQuery,
    note_upsert: noteUpsert,
    note_forget: noteForget,
};

export const turnLedgerIpcSpecs = defineCommandSpecs('low', turnLedgerIpcHandlers, {
    turn_observe: { sources: ['ipc'] },
    mesh_record: { sources: ['ipc'] },
    turn_cancel: { sources: ['ipc'] },
    operator_status: { sources: ['ipc'] },
    turn_query: { sources: ['ipc'] },
    mesh_index_query: { sources: ['ipc'] },
    mission_upsert: { sources: ['ipc'] },
    mission_query: { sources: ['ipc'] },
    note_upsert: { sources: ['ipc'] },
    note_forget: { sources: ['ipc'] },
});
