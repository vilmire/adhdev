/**
 * turn-commands — typed client for the six C-W6 IPC commands
 * (`@adhdev/mesh-shared` `turn-ipc.ts`), executed in the daemon that owns the
 * turn ledger and the seqscribe node.
 *
 * Wiring-unification Phase C, workstream C-W6
 * (docs/design/2026-09-23-wiring-unification.md §5 C2 "MCP server" paragraph).
 *
 * SCOPE: this file is the CLIENT only. It calls through the existing
 * `CommandTransport` (`../transports/mode.js` — `IpcTransport` for the cloud
 * daemon, `LocalTransport` for standalone HTTP) exactly the way every other
 * mesh tool does via `commandForNode`/`ctx.transport.command()`
 * (`../tools/mesh-tools-internal.ts`). It does NOT add a new transport, does
 * not touch daemon-core (the responder-side `CommandSpec`s for these six
 * commands land with C-W6 proper, in daemon-core, by a different workstream),
 * and does not touch any `mesh-tools-*.ts` file — migrating call sites onto
 * this client is also C-W6 proper's job, not this pre-work.
 *
 * DAEMON-LESS FAILURE
 * --------------------
 * Today neither transport's `command()` distinguishes "could not connect" from
 * any other failure — both surface a thrown `Error` with only a free-text
 * `.message` (`ipc.ts`: "Cannot connect to daemon IPC at …", "Daemon IPC
 * connection closed: …"; `local.ts`: `describeFetchFailure` wraps a fetch
 * abort/timeout/connection-refused). There is no `.code` on either. This
 * client CANNOT change that (daemon-core and the transports are out of this
 * workstream's ownership), so `classifyTransportFailure` below is a
 * BEST-EFFORT client-side classifier: it pattern-matches the known message
 * shapes emitted by both transports today and by `IpcConnectionLoadGuard`'s
 * structured `{code: 'ipc_busy'|'rate_limited', error, retryAfterMs?}`
 * rejections (`@adhdev/daemon-core` `ipc-protocol.ts` — these arrive as a
 * plain thrown `Error` too, since `IpcTransport`'s `sendIpcCommand` only ever
 * preserves `payload.error` as the message, never `payload.code`). A future
 * change that adds `.code` to the transport's thrown errors would let this
 * classifier drop the string matching in favor of a direct check — call that
 * out explicitly if/when it happens, rather than layering more patterns on.
 */

import {
    IPC_BUSY_ERROR_CODE,
    IPC_RATE_LIMITED_ERROR_CODE,
} from '@adhdev/daemon-core';
import {
    decodeActiveWorkQueryResponse,
    decodeDirectDispatchRecordResponse,
    decodeGraphAuditRecordResponse,
    decodeQueueCancelResponse,
    decodeQueueEnqueueGraphResponse,
    decodeQueueEnqueueResponse,
    decodeQueueQueryResponse,
    decodeQueueRequeueResponse,
    decodeRecordLocalResponse,
    decodeRecoveryContextQueryResponse,
    type ActiveWorkQueryRequest,
    type ActiveWorkQueryResponse,
    type DirectDispatchRecordRequest,
    type DirectDispatchRecordResponse,
    type GraphAuditRecordRequest,
    type GraphAuditRecordResponse,
    type QueueCancelRequest,
    type QueueCancelResponse,
    type QueueEnqueueGraphRequest,
    type QueueEnqueueGraphResponse,
    type QueueEnqueueRequest,
    type QueueEnqueueResponse,
    type QueueQueryRequest,
    type QueueQueryResponse,
    type QueueRequeueRequest,
    type QueueRequeueResponse,
    type RecordLocalRequest,
    type RecordLocalResponse,
    type RecoveryContextQueryRequest,
    type RecoveryContextQueryResponse,
    decodeGraphGateAbandonResponse,
    decodeGraphGateClaimResponse,
    decodeGraphGateReleaseResponse,
    decodeGraphNodePatchResponse,
    decodeGraphViewQueryResponse,
    decodeOrphanedPinNotifyResponse,
    decodePruneStaleDirectResponse,
    decodeTaskStatsQueryResponse,
    type GraphGateAbandonRequest,
    type GraphGateAbandonResponse,
    type GraphGateClaimRequest,
    type GraphGateClaimResponse,
    type GraphGateReleaseRequest,
    type GraphGateReleaseResponse,
    type GraphNodePatchRequest,
    type GraphNodePatchResponse,
    type GraphViewQueryRequest,
    type GraphViewQueryResponse,
    type OrphanedPinNotifyRequest,
    type OrphanedPinNotifyResponse,
    type PruneStaleDirectRequest,
    type PruneStaleDirectResponse,
    type TaskStatsQueryRequest,
    type TaskStatsQueryResponse,
    decodeLedgerQueryResponse,
    decodeMeshIndexQueryResponse,
    decodeMeshRecordResponse,
    decodeMissionListQueryResponse,
    decodeMissionQueryResponse,
    decodeMissionUpsertResponse,
    decodeNoteForgetResponse,
    decodeNoteUpsertResponse,
    decodeOperatorStatusResponse,
    decodeToolCallRecordResponse,
    decodeTurnCancelResponse,
    decodeTurnObserveResponse,
    decodeTurnQueryResponse,
    isTurnIpcErrorCode,
    TURN_IPC_PROTOCOL_VERSION,
    type LedgerQueryRequest,
    type LedgerQueryResponse,
    type MeshIndexQueryRequest,
    type MeshIndexQueryResponse,
    type MeshRecordRequest,
    type MeshRecordResponse,
    type MissionListQueryRequest,
    type MissionListQueryResponse,
    type MissionQueryRequest,
    type MissionQueryResponse,
    type MissionUpsertRequest,
    type MissionUpsertResponse,
    type NoteForgetRequest,
    type NoteForgetResponse,
    type NoteUpsertRequest,
    type NoteUpsertResponse,
    type OperatorStatusRequest,
    type OperatorStatusResponse,
    type ToolCallRecordRequest,
    type ToolCallRecordResponse,
    type TurnCancelRequest,
    type TurnCancelResponse,
    type TurnIpcCommand,
    type TurnIpcErrorCode,
    type TurnObserveRequest,
    type TurnObserveResponse,
    type TurnQueryRequest,
    type TurnQueryResponse,
} from '@adhdev/mesh-shared';

import type { CommandTransport } from '../transports/mode.js';

// ─── error type ─────────────────────────────────────────────────────────────

/**
 * Thrown by every function in this file on a command failure. `code` is
 * always populated: a structured daemon rejection is passed through as-is;
 * an unrecognized transport failure is classified best-effort (see file
 * header) and otherwise falls back to `turn_ledger_unavailable` — the
 * "something is wrong, but not a routing/ownership mismatch" default, since
 * `ledger_not_owner` and `daemon_required` both mean something the classifier
 * can name precisely when it applies.
 */
export class TurnIpcCommandError extends Error {
    readonly code: TurnIpcErrorCode | 'ipc_busy' | 'rate_limited';
    readonly command: TurnIpcCommand;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;

    constructor(
        code: TurnIpcCommandError['code'],
        command: TurnIpcCommand,
        message: string,
        opts?: { retryAfterMs?: number; cause?: unknown },
    ) {
        super(message);
        this.name = 'TurnIpcCommandError';
        this.code = code;
        this.command = command;
        this.retryAfterMs = opts?.retryAfterMs;
        this.cause = opts?.cause;
    }
}

// ─── daemon-less / overload classification (best-effort — see file header) ──

// Substrings from IpcTransport's own thrown-error messages (transports/ipc.ts)
// and LocalTransport's describeFetchFailure (transports/local.ts) that mean
// "no daemon was reachable to ask", as opposed to a semantic command failure.
const CONNECTION_FAILURE_PATTERNS = [
    /cannot connect to daemon ipc/i,
    /daemon ipc connection closed/i,
    /websocket is not available in this node runtime/i,
    /failed to create ipc connection/i,
    /status fetch failed/i,
    /command .* failed: \d+/i, // LocalTransport HTTP non-2xx (connection succeeded, daemon rejected — still "unreachable to serve this")
    /econnrefused/i,
    /fetch failed/i,
    // LocalTransport's describeFetchFailure (transports/local.ts) renames a
    // TimeoutError/AbortError into this exact phrase — the original error name
    // never survives into the message, so matching "timeouterror" literally
    // (as this pattern list once did) never fires. "did not respond" is the
    // stable substring both its timeout branches share.
    /did not respond\)/i,
];

function isConnectionFailureMessage(message: string): boolean {
    return CONNECTION_FAILURE_PATTERNS.some((re) => re.test(message));
}

/**
 * Classify a thrown transport error into this contract's error code. Exported
 * so a caller building its own error-handling (rather than using the wrapper
 * functions below) can reuse the same classification.
 */
export function classifyTransportFailure(command: TurnIpcCommand, error: unknown): TurnIpcCommandError {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown transport failure');
    if (message.includes(IPC_BUSY_ERROR_CODE)) {
        return new TurnIpcCommandError('ipc_busy', command, message, { cause: error });
    }
    if (message.includes(IPC_RATE_LIMITED_ERROR_CODE)) {
        return new TurnIpcCommandError('rate_limited', command, message, { cause: error });
    }
    if (isConnectionFailureMessage(message)) {
        return new TurnIpcCommandError('daemon_required', command, message, { cause: error });
    }
    return new TurnIpcCommandError('turn_ledger_unavailable', command, message, { cause: error });
}

// ─── generic dispatch ────────────────────────────────────────────────────────

/**
 * BUGFIX (found during C-W6 migration, 2026-09-23): every daemon-side handler
 * in `turn-ledger-ipc.ts` (the responder, landed alongside this client) returns
 * `{success: true, ...response}` or `{success: false, error, code?}` — the same
 * envelope every other `CommandTransport.command()` verb in this codebase
 * returns (`unwrapCommandPayload` exists precisely because callers routinely
 * see this shape). The wire-contract decoders in `@adhdev/mesh-shared`
 * (`isMissionUpsertResponse` etc.) use `hasOnlyKeys` and therefore reject the
 * envelope outright — `decodeMissionUpsertResponse({success:true, mission})`
 * returns `null` even for a perfectly well-formed daemon response. This
 * function strips the envelope BEFORE handing the inner value to the
 * contract's decoder, and turns a `{success:false}` envelope into a typed
 * `TurnIpcCommandError` carrying the daemon's own `code` when it supplied one
 * (falling back to `turn_ledger_unavailable`, matching `classifyTransportFailure`'s
 * own default) instead of masking it as a generic decode failure.
 */
function unwrapEnvelope(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string; code?: TurnIpcErrorCode } {
    if (raw !== null && typeof raw === 'object' && 'success' in (raw as Record<string, unknown>)) {
        // `interactionId` is the host runtime's own envelope stamp
        // (daemon-core boot/host-runtime.ts `execute` returns
        // `{ ...result, interactionId }` on every transport) — not part of any
        // wire contract, so it is stripped with the envelope. Live regression
        // 2026-09-25 (standalone pass): every turn-IPC response failed
        // `unexpected shape from daemon` because of this one key; the unit
        // tests fed bare responses and never saw it.
        const { success, error, code, interactionId: _interactionId, ...rest } = raw as { success: unknown; error?: unknown; code?: unknown; interactionId?: unknown; [k: string]: unknown };
        if (success === false) {
            return {
                ok: false,
                error: typeof error === 'string' ? error : 'command rejected (no error message)',
                ...(typeof code === 'string' && isTurnIpcErrorCode(code) ? { code } : {}),
            };
        }
        return { ok: true, value: rest };
    }
    // No `success` key at all — pass the raw value through unchanged (defensive:
    // a future responder that returns the bare response shape directly still works).
    return { ok: true, value: raw };
}

async function dispatch<Req extends { v: typeof TURN_IPC_PROTOCOL_VERSION }, Res>(
    transport: CommandTransport,
    command: TurnIpcCommand,
    request: Req,
    decodeResponse: (value: unknown) => Res | null,
): Promise<Res> {
    let raw: unknown;
    try {
        raw = await transport.command(command, request as unknown as Record<string, unknown>);
    } catch (error) {
        throw classifyTransportFailure(command, error);
    }
    const unwrapped = unwrapEnvelope(raw);
    if (!unwrapped.ok) {
        throw new TurnIpcCommandError(unwrapped.code ?? 'turn_ledger_unavailable', command, unwrapped.error);
    }
    const decoded = decodeResponse(unwrapped.value);
    if (decoded === null) {
        throw new TurnIpcCommandError(
            'turn_ledger_unavailable',
            command,
            `${command} response failed decode (unexpected shape from daemon)`,
        );
    }
    return decoded;
}

// ─── one function per command ────────────────────────────────────────────────

/** Submit one TurnEvidence to the owning daemon's turn ledger; returns the reducer verdict. */
export async function turnObserve(
    transport: CommandTransport,
    args: Omit<TurnObserveRequest, 'v'>,
): Promise<TurnObserveResponse> {
    return dispatch(transport, 'turn_observe', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeTurnObserveResponse);
}

/** Append one content-free scalar record to `mesh.<id>.events` (topic only — see `recordLocal` for a record that keeps its full payload). */
export async function meshRecord(
    transport: CommandTransport,
    args: Omit<MeshRecordRequest, 'v'>,
): Promise<MeshRecordResponse> {
    return dispatch(transport, 'mesh_record', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMeshRecordResponse);
}

/** Cancel an attempt by attemptId or taskId (exactly one). */
export async function turnCancel(
    transport: CommandTransport,
    args: Omit<TurnCancelRequest, 'v'>,
): Promise<TurnCancelResponse> {
    return dispatch(transport, 'turn_cancel', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeTurnCancelResponse);
}

/** Record a fire-and-forget operator/tool-call status (replaces `recordMeshCoordinatorToolCall`). */
export async function operatorStatus(
    transport: CommandTransport,
    args: Omit<OperatorStatusRequest, 'v'>,
): Promise<OperatorStatusResponse> {
    return dispatch(transport, 'operator_status', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeOperatorStatusResponse);
}

/** Read attempt/event rows, own or fleet scope depending on the caller's filters. */
export async function turnQuery(
    transport: CommandTransport,
    args: Omit<TurnQueryRequest, 'v'>,
): Promise<TurnQueryResponse> {
    return dispatch(transport, 'turn_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeTurnQueryResponse);
}

/** Read `mesh_topic_index` rows (fleet-wide replication index). */
export async function meshIndexQuery(
    transport: CommandTransport,
    args: Omit<MeshIndexQueryRequest, 'v'>,
): Promise<MeshIndexQueryResponse> {
    return dispatch(transport, 'mesh_index_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMeshIndexQueryResponse);
}

/**
 * Create/update a mission (replaces the in-process `upsertMeshMission`). Added
 * during C-W6 (was missing from the C-W6 pre-work client — turn-ipc.ts's wire
 * contract already had `mission_upsert`/`mission_query` from the 2026-09-23
 * "missions have no home in the six commands" decision, but no wrapper
 * function called them yet).
 */
export async function missionUpsert(
    transport: CommandTransport,
    args: Omit<MissionUpsertRequest, 'v'>,
): Promise<MissionUpsertResponse> {
    return dispatch(transport, 'mission_upsert', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMissionUpsertResponse);
}

/** List/read missions for a mesh (replaces the in-process `getMeshMissions`/`getMeshMission`). */
export async function missionQuery(
    transport: CommandTransport,
    args: Omit<MissionQueryRequest, 'v'>,
): Promise<MissionQueryResponse> {
    return dispatch(transport, 'mission_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMissionQueryResponse);
}

/**
 * Record a coordinator operating note on the owning daemon (C-W8; replaces the
 * in-process `appendLedgerEntry('coordinator_operating_note')`). Free text over
 * local IPC — the daemon keeps it in `mesh_operating_notes`, never on a topic.
 */
export async function noteUpsert(
    transport: CommandTransport,
    args: Omit<NoteUpsertRequest, 'v'>,
): Promise<NoteUpsertResponse> {
    return dispatch(transport, 'note_upsert', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeNoteUpsertResponse);
}

/** Retract operating notes by id and/or exact text (C-W8; replaces the in-process `tombstoneOperatingNote`). */
export async function noteForget(
    transport: CommandTransport,
    args: Omit<NoteForgetRequest, 'v'>,
): Promise<NoteForgetResponse> {
    return dispatch(transport, 'note_forget', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeNoteForgetResponse);
}

/**
 * Bump the per-mesh-tool-call rate counter on the owning daemon and get back
 * whether the caller is over the window (C-W9b; replaces the in-process
 * `recordMeshToolCall`/`recordMeshCoordinatorToolCall`).
 */
export async function toolCallRecord(
    transport: CommandTransport,
    args: Omit<ToolCallRecordRequest, 'v'>,
): Promise<ToolCallRecordResponse> {
    return dispatch(transport, 'tool_call_record', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeToolCallRecordResponse);
}

/**
 * Read the daemon's records (C-W9a: its `mesh_local_records` plus the turn
 * ledger's task outcomes) with arbitrary kind/since/node filters, optionally
 * with the record summary attached (C-W9b) — see the mesh-shared file
 * section's CONTENT BOUNDARY note for why `entries[].payload` is an
 * unvalidated JSON passthrough here.
 */
export async function ledgerQuery(
    transport: CommandTransport,
    args: Omit<LedgerQueryRequest, 'v'>,
): Promise<LedgerQueryResponse> {
    return dispatch(transport, 'ledger_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeLedgerQueryResponse);
}

/**
 * Read the `mesh_mission_list` tool's full bounded/folded mission projection
 * (C-W9b; replaces the in-process `listMeshMissionsForTool`). Additive sibling
 * of `missionQuery` — see the mesh-shared file section's note on why this is a
 * separate command rather than a widened `mission_query`.
 */
export async function missionListQuery(
    transport: CommandTransport,
    args: Omit<MissionListQueryRequest, 'v'>,
): Promise<MissionListQueryResponse> {
    return dispatch(transport, 'mission_list_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMissionListQueryResponse);
}

// ─── C-W9a: records, queue composites, active work ───────────────────────────
// Every mcp-server access to the daemon's `mesh-runtime.db` that used to run
// in-process (record appends, queue mutations and reads, the active-work
// inputs, recovery hints) goes through these — executed in the daemon.

/**
 * Record one mesh event with its FULL payload kept locally on the daemon
 * (`meshRecord(..., { local: true })`): the topic leg is the content-free
 * projection, the local row keeps the nested/free-text payload (dispatch
 * records, MAGI question/synthesis, checkpoint messages, reconcile evidence).
 */
export async function recordLocal(
    transport: CommandTransport,
    args: Omit<RecordLocalRequest, 'nodeId' | 'sessionId' | 'providerType' | 'taskId' | 'v'> & {
        nodeId?: string | null;
        sessionId?: string | null;
        providerType?: string | null;
        taskId?: string | null;
    },
): Promise<RecordLocalResponse> {
    // An absent/blank optional id is OMITTED (the wire contract only accepts identifiers,
    // and the retired in-process append simply stored nothing for it).
    const id = (value: string | null | undefined): string | undefined =>
        typeof value === 'string' && value.trim() && !/\s/.test(value) ? value : undefined;
    const nodeId = id(args.nodeId);
    const sessionId = id(args.sessionId);
    const providerType = id(args.providerType);
    const taskId = id(args.taskId);
    return dispatch(transport, 'record_local', {
        v: TURN_IPC_PROTOCOL_VERSION,
        meshId: args.meshId,
        kind: args.kind,
        ...(nodeId ? { nodeId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(providerType ? { providerType } : {}),
        ...(taskId ? { taskId } : {}),
        payload: args.payload,
    }, decodeRecordLocalResponse);
}

/** Read queue rows (optionally status-filtered, one task, or view-projected). */
export async function queueQuery(
    transport: CommandTransport,
    args: Omit<QueueQueryRequest, 'v'>,
): Promise<QueueQueryResponse> {
    return dispatch(transport, 'queue_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeQueueQueryResponse);
}

/** Enqueue one task (+ its single-surface decision record) in the daemon. A daemon guard refusal throws with its message. */
export async function queueEnqueue(
    transport: CommandTransport,
    args: Omit<QueueEnqueueRequest, 'v'>,
): Promise<QueueEnqueueResponse> {
    return dispatch(transport, 'queue_enqueue', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeQueueEnqueueResponse);
}

/** Atomic batch enqueue (compat or graph path) with its audit trail. A domain refusal is an `ok: false` RESULT. */
export async function queueEnqueueGraph(
    transport: CommandTransport,
    args: Omit<QueueEnqueueGraphRequest, 'v'>,
): Promise<QueueEnqueueGraphResponse> {
    return dispatch(transport, 'queue_enqueue_graph', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeQueueEnqueueGraphResponse);
}

/** Cancel a queue task; returns the row after and before the cancel. */
export async function queueCancel(
    transport: CommandTransport,
    args: Omit<QueueCancelRequest, 'v'>,
): Promise<QueueCancelResponse> {
    return dispatch(transport, 'queue_cancel', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeQueueCancelResponse);
}

/** Requeue a queue task. */
export async function queueRequeue(
    transport: CommandTransport,
    args: Omit<QueueRequeueRequest, 'v'>,
): Promise<QueueRequeueResponse> {
    return dispatch(transport, 'queue_requeue', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeQueueRequeueResponse);
}

/** A direct dispatch's bookkeeping (task row + decision record), best-effort per step. */
export async function directDispatchRecord(
    transport: CommandTransport,
    args: Omit<DirectDispatchRecordRequest, 'v'>,
): Promise<DirectDispatchRecordResponse> {
    return dispatch(transport, 'direct_dispatch_record', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeDirectDispatchRecordResponse);
}

/** A graph gate / node-patch provenance record, written by the daemon's allow-listed recorder. */
export async function graphAuditRecord(
    transport: CommandTransport,
    args: Omit<GraphAuditRecordRequest, 'v'>,
): Promise<GraphAuditRecordResponse> {
    return dispatch(transport, 'graph_audit_record', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeGraphAuditRecordResponse);
}

/** Active work computed in the daemon (and/or the record + direct-dispatch inputs it reads). */
export async function activeWorkQuery(
    transport: CommandTransport,
    args: Omit<ActiveWorkQueryRequest, 'v'>,
): Promise<ActiveWorkQueryResponse> {
    return dispatch(transport, 'active_work_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeActiveWorkQueryResponse);
}

/** The recovery context (recent failures, last dispatched task) for a node or session. */
export async function recoveryContextQuery(
    transport: CommandTransport,
    args: Omit<RecoveryContextQueryRequest, 'v'>,
): Promise<RecoveryContextQueryResponse> {
    return dispatch(transport, 'recovery_context_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeRecoveryContextQueryResponse);
}

// ─── C-W9c: graph gates/plan/patch, task/mission stats, prune audit, orphaned-pin notify ──
//
// The last mcp-server call sites that reached daemon-core's MeshRuntimeStore-
// backed graph/stats/active-work modules in-process (design's 2026-09-24
// 19:00 stamp). Every one of these now runs in the daemon that owns the rows;
// `graphAuditRecord` above is superseded for graph gate/patch provenance
// (mesh-graph-ipc.ts writes its own audit record inline) but stays exported
// in case another caller still uses the standalone command.

/** Claim a graph gate's coordinator lease (`mesh_graph_gate_claim`'s core, now in the daemon). */
export async function graphGateClaim(
    transport: CommandTransport,
    args: Omit<GraphGateClaimRequest, 'v'>,
): Promise<GraphGateClaimResponse> {
    return dispatch(transport, 'graph_gate_claim', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeGraphGateClaimResponse);
}

/** Release a claimed graph gate. A domain refusal is a RESULT (`released: false` + `refusalCode`), not a thrown error. */
export async function graphGateRelease(
    transport: CommandTransport,
    args: Omit<GraphGateReleaseRequest, 'v'>,
): Promise<GraphGateReleaseResponse> {
    return dispatch(transport, 'graph_gate_release', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeGraphGateReleaseResponse);
}

/** Abandon (permanently deny) a graph gate — cancels every node it was holding. */
export async function graphGateAbandon(
    transport: CommandTransport,
    args: Omit<GraphGateAbandonRequest, 'v'>,
): Promise<GraphGateAbandonResponse> {
    return dispatch(transport, 'graph_gate_abandon', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeGraphGateAbandonResponse);
}

/** Patch a still-pending graph node's base spec and immediately re-settle it. A domain refusal is a RESULT (`patched: false` + `refusalCode`). */
export async function graphNodePatch(
    transport: CommandTransport,
    args: Omit<GraphNodePatchRequest, 'v'>,
): Promise<GraphNodePatchResponse> {
    return dispatch(transport, 'graph_node_patch', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeGraphNodePatchResponse);
}

/** The read-only graph projection (nodes, edges, gates, workspaces, next coordinator actions). */
export async function graphViewQuery(
    transport: CommandTransport,
    args: Omit<GraphViewQueryRequest, 'v'>,
): Promise<GraphViewQueryResponse> {
    return dispatch(transport, 'graph_view_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeGraphViewQueryResponse);
}

/** Per-task (and optionally per-mission rollup) time/attempt stats, computed in the daemon. */
export async function taskStatsQuery(
    transport: CommandTransport,
    args: Omit<TaskStatsQueryRequest, 'v'>,
): Promise<TaskStatsQueryResponse> {
    return dispatch(transport, 'task_stats_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeTaskStatsQueryResponse);
}

/** Run (or dry-run) the stale-direct-dispatch prune, entirely in the daemon (`mesh_prune_stale_direct`'s core). */
export async function pruneStaleDirect(
    transport: CommandTransport,
    args: Omit<PruneStaleDirectRequest, 'v'>,
): Promise<PruneStaleDirectResponse> {
    return dispatch(transport, 'prune_stale_direct', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodePruneStaleDirectResponse);
}

/** Find + page the coordinator about queue tasks orphaned by a session stop (CANCEL-ORPHANS-PINNED-TASK). */
export async function orphanedPinNotify(
    transport: CommandTransport,
    args: Omit<OrphanedPinNotifyRequest, 'v'>,
): Promise<OrphanedPinNotifyResponse> {
    return dispatch(transport, 'orphaned_pin_notify', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeOrphanedPinNotifyResponse);
}
