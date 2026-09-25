/**
 * mesh-store-ipc — daemon-side responders for the IPC commands through which
 * the mcp-server reaches this daemon's `mesh-runtime.db` (records, queue,
 * missions, active work) instead of opening it in-process.
 *
 * Wiring-unification Phase C: C-W9b's three commands (`tool_call_record`,
 * `ledger_query`, `mission_list_query`) and C-W9a's ten (`record_local`, the
 * `queue_*` composites, `direct_dispatch_record`, `graph_audit_record`,
 * `active_work_query`, `recovery_context_query`). Wire contract:
 * `@adhdev/mesh-shared` `turn-ipc.ts`. Registered with the turn-ledger IPC
 * commands (turn-ledger-ipc.ts spreads these handlers into its map and gives
 * every spec `sources: ['ipc']` — local IPC only, never P2P/WS).
 *
 * Every handler answers the standard `{ success: true, ...response }` /
 * `{ success: false, error }` envelope the mcp client unwraps
 * (`mcp-server/src/ipc/turn-commands.ts`). A domain refusal the daemon's own
 * guard raises (enqueue validation, host ownership, …) comes back as the
 * error message verbatim, so the tool keeps reporting the same text/code.
 */

import {
    decodeActiveWorkQueryRequest,
    decodeDirectDispatchRecordRequest,
    decodeGraphAuditRecordRequest,
    decodeLedgerQueryRequest,
    decodeMissionListQueryRequest,
    decodeQueueCancelRequest,
    decodeQueueEnqueueGraphRequest,
    decodeQueueEnqueueRequest,
    decodeQueueQueryRequest,
    decodeQueueRequeueRequest,
    decodeRecordLocalRequest,
    decodeRecoveryContextQueryRequest,
    decodeToolCallRecordRequest,
    isEvidenceIdentifier,
    type ActiveWorkQueryResponse,
    type DirectDispatchRecordResponse,
    type GraphAuditRecordResponse,
    type LedgerQueryEntryWire,
    type LedgerQueryResponse,
    type MissionListQueryResponse,
    type QueueCancelResponse,
    type QueueEnqueueGraphResponse,
    type QueueEnqueueResponse,
    type QueueEntryWire,
    type QueueQueryResponse,
    type QueueRequeueResponse,
    type RecordLocalResponse,
    type RecoveryContextQueryResponse,
    type ToolCallRecordResponse,
    type MissionListSummaryWire,
} from '@adhdev/mesh-shared';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import type { MeshLedgerEntry } from '../../mesh/mesh-ledger.js';
import { meshRecord } from '../../mesh/mesh-record.js';
import { getLocalRecordSummary, getSessionRecoveryContext, readLocalRecords } from '../../mesh/mesh-local-records.js';
import {
    cancelTask,
    enqueueTask,
    enqueueTaskGraph,
    getActiveDirectDispatches,
    getQueue,
    recordDirectDispatchTask,
    recordMeshToolCall,
    requeueTask,
    type MeshTaskGraphEntrySpec,
    type MeshTaskStatus,
    type MeshWorkQueueEntry,
} from '../../mesh/mesh-work-queue.js';
import { summarizeQueueEntryInputForView } from '../../mesh/mesh-task-predicates.js';
import {
    recordDirectDispatchDecision,
    recordGraphEnqueueCommitted,
    recordGraphEnqueueRolledBack,
    recordGraphEnqueueValidationFailed,
    recordGraphGateAbandoned,
    recordGraphGateClaimed,
    recordGraphGateReleased,
    recordGraphNodePatched,
    recordSingleEnqueueDecision,
} from '../../mesh/mesh-graph-provenance.js';
import { commitMeshGraphPlan, MeshGraphPlanError, type MeshGraphPlanRequest } from '../../mesh/mesh-graph-plan.js';
import { listMeshMissionsForTool, type MeshMissionStatus } from '../../mesh/mesh-missions.js';
import { buildMeshActiveWork } from '../../mesh/mesh-active-work.js';
import { computeMeshGraphUsage, listMeshBlockedGates } from '../../mesh/mesh-graph-usage.js';
import { buildMeshSchedulingRuntime } from '../../mesh/mesh-scheduling-runtime.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import type { RepoMeshDaemonRole } from '../../repo-mesh-types.js';
import { LOG } from '../../logging/logger.js';

function badRequest(command: string): { success: false; error: string } {
    return { success: false, error: `${command}: request failed decode (bad shape)` };
}

function failure(e: unknown): { success: false; error: string } {
    return { success: false, error: (e as any)?.message ?? String(e) };
}

/** JSON passthrough of a queue row (the wire guard needs only `id` + `status`). */
function queueWire(entry: MeshWorkQueueEntry | null | undefined): QueueEntryWire | null {
    return entry ? entry as unknown as QueueEntryWire : null;
}

// ─── tool_call_record (C-W9b) ───────────────────────────────────────────────

const toolCallRecord: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeToolCallRecordRequest(args);
    if (!req) return badRequest('tool_call_record');
    const result: ToolCallRecordResponse = recordMeshToolCall({
        meshId: req.meshId,
        tool: req.tool,
        sessionId: req.sessionId ?? null,
        callerRole: req.callerRole,
    });
    return { success: true, rateLimitExceeded: result.rateLimitExceeded, callsInWindow: result.callsInWindow, advisory: result.advisory };
};

// ─── ledger_query (C-W9b; served by the local records since C-W9a) ──────────

/** An entry on the wire: optional ids that are not identifiers are omitted rather than failing the whole response. */
function toLedgerQueryEntry(entry: MeshLedgerEntry): LedgerQueryEntryWire | null {
    if (!isEvidenceIdentifier(entry.id) || !isEvidenceIdentifier(entry.meshId)) return null;
    const id = (value: unknown): string | undefined => (isEvidenceIdentifier(value) ? value : undefined);
    const nodeId = id(entry.nodeId);
    const sessionId = id(entry.sessionId);
    const providerType = id(entry.providerType);
    const taskId = id(entry.taskId);
    return {
        id: entry.id,
        meshId: entry.meshId,
        timestamp: entry.timestamp,
        kind: entry.kind,
        ...(nodeId ? { nodeId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(providerType ? { providerType } : {}),
        ...(taskId ? { taskId } : {}),
        payload: entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload) ? entry.payload : {},
    };
}

const ledgerQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeLedgerQueryRequest(args);
    if (!req) return badRequest('ledger_query');
    try {
        const entries = readLocalRecords(req.meshId, {
            ...(req.tail !== undefined ? { tail: req.tail } : {}),
            ...(req.since !== undefined ? { since: req.since } : {}),
            ...(req.kind ? { kind: [...req.kind] as MeshLedgerEntry['kind'][] } : {}),
            ...(req.node ? { node: req.node } : {}),
        });
        const response: LedgerQueryResponse = {
            entries: entries.map(toLedgerQueryEntry).filter((e): e is LedgerQueryEntryWire => e !== null),
            ...(req.includeSummary ? { summary: getLocalRecordSummary(req.meshId) } : {}),
        };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── mission_list_query (C-W9b) ─────────────────────────────────────────────

/** The wire row for one mission: only the keys `isMissionListSummaryWire` allows (verbose ⇒ `goal`, slim ⇒ `goalPreview`+`goalTruncated`). */
function toMissionListSummaryWire(summary: Record<string, unknown>): MissionListSummaryWire {
    const base = {
        id: summary.id,
        meshId: summary.meshId,
        title: summary.title,
        status: summary.status,
        ...(summary.source !== undefined ? { source: summary.source } : {}),
        tasks: summary.tasks,
        ...(summary.stats !== undefined ? { stats: summary.stats } : {}),
        ...(summary.brief !== undefined ? { brief: summary.brief } : {}),
    };
    return (typeof summary.goal === 'string'
        ? { ...base, goal: summary.goal }
        : { ...base, goalPreview: summary.goalPreview ?? '', goalTruncated: summary.goalTruncated === true }) as MissionListSummaryWire;
}

const missionListQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeMissionListQueryRequest(args);
    if (!req) return badRequest('mission_list_query');
    try {
        const result = listMeshMissionsForTool(req.meshId, {
            ...(req.statuses ? { statuses: [...req.statuses] as MeshMissionStatus[] } : {}),
            ...(req.verbose !== undefined ? { verbose: req.verbose } : {}),
            ...(req.includeMagi !== undefined ? { includeMagi: req.includeMagi } : {}),
            ...(req.withStats !== undefined ? { withStats: req.withStats } : {}),
            ...(req.limit !== undefined ? { limit: req.limit } : {}),
            ...(req.historyIdLimit !== undefined ? { historyIdLimit: req.historyIdLimit } : {}),
        });
        // Project each summary onto the wire contract. `listMeshMissionsForTool`
        // returns the daemon's own `MeshMissionSummary`/`MeshMissionSlimSummary`,
        // which still carries the legacy flat counters (`total`/`pending`/…),
        // `createdAt`/`updatedAt`/`lastActivityAt` and `closeCandidateEmittedAt`
        // next to the `tasks` aggregate; the strict wire decoder
        // (`isMissionListSummaryWire`, `hasOnlyKeys`) rejects any of them, so
        // spreading the summary raw made `mesh_mission_list` fail
        // `response failed decode` on every mesh with ≥1 mission (found live on
        // preview, 2026-09-25 — the unit tests only ever listed an empty mesh).
        const response: MissionListQueryResponse = {
            missions: (result.missions as unknown as Record<string, unknown>[]).map(toMissionListSummaryWire),
            historyFold: result.historyFold ?? null,
            truncated: result.truncated,
            matched: result.matched,
            ...(result.overflowIds ? { overflowIds: result.overflowIds } : {}),
        };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── record_local ───────────────────────────────────────────────────────────

const recordLocal: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeRecordLocalRequest(args);
    if (!req) return badRequest('record_local');
    const result = meshRecord(req.meshId, req.kind, {
        ...(req.nodeId ? { nodeId: req.nodeId } : {}),
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        ...(req.providerType ? { providerType: req.providerType } : {}),
        ...(req.taskId ? { taskId: req.taskId } : {}),
        payload: req.payload,
    }, { local: true });
    const response: RecordLocalResponse = {
        eventId: result.eventId,
        timestamp: result.timestamp,
        storedLocally: result.storedLocally,
        published: result.published,
    };
    return { success: true, ...response };
};

// ─── queue_* ────────────────────────────────────────────────────────────────

/**
 * THIS daemon's role in the mesh (`meshHost.role` on its own mesh record —
 * `host` unless pairing made it a `member`), resolved through the router's mesh
 * view (inline cache, then local config). Unresolvable mesh ⇒ undefined (no
 * stamp — the mutation then behaves exactly as before).
 *
 * Why it is stamped here: `requireMeshHostQueueOwner` guards the queue
 * mutations but only fires on `ownerRole === 'member'`, and until this seam no
 * production caller set it — the guard was dead. The mcp-server reaches the
 * queue ONLY through these responders, over local IPC, from whatever MCP client
 * runs on this machine (a manually attached agent works on a member machine
 * too — coordinator launch is host-gated, the MCP server is not). Without the
 * stamp, such a client enqueued into a member's local queue that no host ever
 * schedules.
 */
async function ownQueueRole(ctx: LowFamilyContext, meshId: string): Promise<RepoMeshDaemonRole | undefined> {
    try {
        const record = await ctx?.getMeshForCommand?.(meshId, undefined, { preferInline: true });
        return record?.mesh ? resolveMeshHostStatus(record.mesh).role : undefined;
    } catch {
        return undefined;
    }
}

/** The caller's options with `ownerRole` replaced by this daemon's own (never the caller's). */
function withOwnRole<T extends Record<string, unknown>>(opts: T | undefined, role: RepoMeshDaemonRole | undefined): T & { ownerRole?: RepoMeshDaemonRole } {
    const { ownerRole: _callerClaim, ...rest } = (opts ?? {}) as T & { ownerRole?: unknown };
    return (role ? { ...rest, ownerRole: role } : rest) as T & { ownerRole?: RepoMeshDaemonRole };
}

const queueQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeQueueQueryRequest(args);
    if (!req) return badRequest('queue_query');
    try {
        let entries = getQueue(req.meshId, req.statuses ? { status: [...req.statuses] as MeshTaskStatus[] } : undefined);
        if (req.taskId) entries = entries.filter((e) => e.id === req.taskId);
        const wire = (req.view ? entries.map((e) => summarizeQueueEntryInputForView(e)) : entries) as unknown as QueueEntryWire[];
        const response: QueueQueryResponse = { entries: wire };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

const queueEnqueue: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeQueueEnqueueRequest(args);
    if (!req) return badRequest('queue_enqueue');
    try {
        const role = await ownQueueRole(_ctx, req.meshId);
        const entry = enqueueTask(req.meshId, req.message, withOwnRole(req.options as Record<string, unknown> | undefined, role) as Parameters<typeof enqueueTask>[2]);
        // design :697-731 — written AFTER the insert so a failed enqueue leaves no decision row.
        if (req.decision) {
            recordSingleEnqueueDecision(req.meshId, { ...(req.decision as any), taskId: entry.id });
        }
        const response: QueueEnqueueResponse = { entry: queueWire(entry)! };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

function readAudit(audit: Record<string, unknown> | undefined): {
    batchId?: string; missionId?: string; coordinatorSessionId?: string; onDependencyFailure?: string;
    orchestrationDecision?: unknown; taskCount?: number; errorCodes: string[];
} {
    const a = audit ?? {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
        ...(str(a.batchId) ? { batchId: str(a.batchId) } : {}),
        ...(str(a.missionId) ? { missionId: str(a.missionId) } : {}),
        ...(str(a.coordinatorSessionId) ? { coordinatorSessionId: str(a.coordinatorSessionId) } : {}),
        ...(str(a.onDependencyFailure) ? { onDependencyFailure: str(a.onDependencyFailure) } : {}),
        ...(a.orchestrationDecision !== undefined ? { orchestrationDecision: a.orchestrationDecision } : {}),
        ...(typeof a.taskCount === 'number' ? { taskCount: a.taskCount } : {}),
        errorCodes: Array.isArray(a.errorCodes) ? a.errorCodes.filter((c): c is string => typeof c === 'string') : [],
    };
}

const queueEnqueueGraph: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeQueueEnqueueGraphRequest(args);
    if (!req) return badRequest('queue_enqueue_graph');
    const audit = readAudit(req.audit);
    const taskCount = audit.taskCount ?? (req.mode === 'compat' ? req.specs!.length : (Array.isArray((req.plan as any)?.tasks) ? (req.plan as any).tasks.length : 0));
    try {
        const queueOpts = withOwnRole(undefined, await ownQueueRole(_ctx, req.meshId));
        if (req.mode === 'compat') {
            const tasks = enqueueTaskGraph(req.meshId, [...req.specs!] as unknown as MeshTaskGraphEntrySpec[], queueOpts);
            const response: QueueEnqueueGraphResponse = { ok: true, tasks: tasks as unknown as QueueEntryWire[] };
            return { success: true, ...response };
        }
        const plan = commitMeshGraphPlan({ ...(req.plan as unknown as Omit<MeshGraphPlanRequest, 'meshId'>), meshId: req.meshId }, queueOpts);
        recordGraphEnqueueCommitted(req.meshId, {
            graphId: plan.graphId,
            batchId: plan.batchId,
            enqueueSurface: 'batch',
            schemaVersion: 2,
            planDigest: plan.planDigest,
            ...(audit.missionId ? { missionId: audit.missionId } : {}),
            ...(audit.coordinatorSessionId ? { coordinatorSessionId: audit.coordinatorSessionId } : {}),
            taskCount: plan.tasks.length,
            gateCount: plan.gates.length,
            workspaceCount: plan.workspaces.length,
            dependencyEdgeCount: plan.dependencyEdgeCount,
            onDependencyFailure: audit.onDependencyFailure ?? 'block',
            ...(audit.orchestrationDecision !== undefined ? { orchestrationDecision: audit.orchestrationDecision as any } : {}),
            ...(plan.replayed ? { replayed: true } : {}),
        });
        const { tasks, ...graph } = plan;
        const response: QueueEnqueueGraphResponse = { ok: true, tasks: tasks as unknown as QueueEntryWire[], graph: graph as unknown as Record<string, unknown> };
        return { success: true, ...response };
    } catch (e: any) {
        const message = e?.message || String(e);
        const code: string | undefined = e instanceof MeshGraphPlanError ? e.code : audit.errorCodes.find((c) => message.includes(c));
        // design :741-743, :752-753 — the audit record is written AFTER the failed
        // transaction rolled back (here, in the catch), never inside it.
        if (req.mode === 'graph') {
            recordGraphEnqueueRolledBack(req.meshId, {
                code: code ?? 'graph_plan_failed',
                ...(audit.batchId ? { batchId: audit.batchId } : {}),
                taskCount,
                error: message,
            });
        } else {
            recordGraphEnqueueValidationFailed(req.meshId, {
                code: code ?? 'batch_enqueue_failed',
                ...(audit.batchId ? { batchId: audit.batchId } : {}),
                taskCount,
            });
        }
        const response: QueueEnqueueGraphResponse = {
            ok: false,
            ...(code ? { refusalCode: code } : {}),
            message,
            ...(e instanceof MeshGraphPlanError && e.extra ? { extra: e.extra } : {}),
        };
        return { success: true, ...response };
    }
};

const queueCancel: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeQueueCancelRequest(args);
    if (!req) return badRequest('queue_cancel');
    try {
        // MESH-DISPATCH-MISROUTE: the PRE-cancel row carries the assignment a caller must stop.
        const before = getQueue(req.meshId).find((t) => t.id === req.taskId) ?? null;
        const task = cancelTask(req.meshId, req.taskId, withOwnRole({ ...(req.reason !== undefined ? { reason: req.reason } : {}) }, await ownQueueRole(_ctx, req.meshId)));
        const response: QueueCancelResponse = { task: queueWire(task), before: queueWire(before) };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

const queueRequeue: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeQueueRequeueRequest(args);
    if (!req) return badRequest('queue_requeue');
    try {
        const task = requeueTask(req.meshId, req.taskId, withOwnRole(req.options as Record<string, unknown> | undefined, await ownQueueRole(_ctx, req.meshId)) as Parameters<typeof requeueTask>[2]);
        const response: QueueRequeueResponse = { task: queueWire(task) };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── direct_dispatch_record ─────────────────────────────────────────────────

const directDispatchRecord: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeDirectDispatchRecordRequest(args);
    if (!req) return badRequest('direct_dispatch_record');
    const response: DirectDispatchRecordResponse = { taskRecorded: false, decisionRecorded: false };
    // Best-effort, step by step: the dispatch already happened; its bookkeeping must never fail it.
    if (req.task) {
        try {
            recordDirectDispatchTask(req.meshId, req.message, { ...(req.task as any), id: req.taskId });
            response.taskRecorded = true;
        } catch (e: any) {
            LOG.warn('MeshStoreIpc', `direct_dispatch_record: task row for ${req.taskId} failed: ${e?.message ?? String(e)}`);
        }
    }
    if (req.decision) {
        try {
            recordDirectDispatchDecision(req.meshId, { ...(req.decision as any), taskId: req.taskId });
            response.decisionRecorded = true;
        } catch (e: any) {
            LOG.warn('MeshStoreIpc', `direct_dispatch_record: decision for ${req.taskId} failed: ${e?.message ?? String(e)}`);
        }
    }
    return { success: true, ...response };
};

// ─── graph_audit_record ─────────────────────────────────────────────────────

const GRAPH_AUDIT_RECORDERS: Record<string, (meshId: string, fields: any) => void> = {
    gate_claimed: recordGraphGateClaimed,
    gate_released: recordGraphGateReleased,
    gate_abandoned: recordGraphGateAbandoned,
    node_patched: recordGraphNodePatched,
};

const graphAuditRecord: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeGraphAuditRecordRequest(args);
    if (!req) return badRequest('graph_audit_record');
    const recorder = GRAPH_AUDIT_RECORDERS[req.event];
    try {
        recorder(req.meshId, req.fields);
        const response: GraphAuditRecordResponse = { recorded: true };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── active_work_query ──────────────────────────────────────────────────────

/**
 * D3(b) + D6 (the 2026-09-25 graph orchestration simplification):
 * fold the open-gate listing (expired gates included, with state + age) and the
 * graph usage counters into `activeWork.summary`, which mesh_status passes
 * through verbatim as `activeWorkSummary`. Identifiers/enums/counters only.
 * Best-effort: a graph-store fault leaves the summary exactly as it was.
 */
function withGraphGateSummary<T extends { summary: object }>(meshId: string, activeWork: T): T {
    try {
        const gates = listMeshBlockedGates(meshId);
        const graphUsage = computeMeshGraphUsage(meshId);
        return {
            ...activeWork,
            summary: {
                ...activeWork.summary,
                ...(gates.blockedGatesTotal > 0 ? gates : {}),
                graphUsage,
            },
        };
    } catch {
        return activeWork;
    }
}

const DEFAULT_ACTIVE_WORK_RECORD_TAIL = 200;

const activeWorkQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeActiveWorkQueryRequest(args);
    if (!req) return badRequest('active_work_query');
    try {
        const records = readLocalRecords(req.meshId, { tail: req.recordTail ?? DEFAULT_ACTIVE_WORK_RECORD_TAIL });
        const directDispatches = getActiveDirectDispatches(req.meshId);
        const liveQueue = req.queue || req.includeSchedulingRuntime || req.compute !== false ? getQueue(req.meshId) : [];
        const queue = (req.queue ? [...req.queue] : liveQueue) as unknown as MeshWorkQueueEntry[];
        const response: ActiveWorkQueryResponse = {
            ...(req.compute !== false ? {
                activeWork: withGraphGateSummary(req.meshId, buildMeshActiveWork({
                    meshId: req.meshId,
                    queue,
                    ledgerEntries: records,
                    directDispatches,
                    nodes: req.nodes ? [...req.nodes] : [],
                    ...(req.includeTerminalDirect ? { includeTerminalDirect: true } : {}),
                })) as unknown as Record<string, unknown>,
            } : {}),
            ...(req.includeInputs ? {
                records: records as unknown as Record<string, unknown>[],
                directDispatches: directDispatches as unknown as Record<string, unknown>[],
            } : {}),
            ...(req.includeSummary ? { summary: getLocalRecordSummary(req.meshId) as unknown as Record<string, unknown> } : {}),
            ...(req.includeSchedulingRuntime && req.mesh
                ? { schedulingRuntime: buildMeshSchedulingRuntime(req.mesh as any, liveQueue) as unknown as Record<string, unknown> }
                : {}),
        };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── recovery_context_query ─────────────────────────────────────────────────

const recoveryContextQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeRecoveryContextQueryRequest(args);
    if (!req) return badRequest('recovery_context_query');
    try {
        const context = getSessionRecoveryContext(req.meshId, {
            ...(req.nodeId ? { nodeId: req.nodeId } : {}),
            ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            ...(req.maxRetries !== undefined ? { maxRetries: req.maxRetries } : {}),
        });
        const response: RecoveryContextQueryResponse = { context: context as unknown as Record<string, unknown> };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── registration (merged into turnLedgerIpcHandlers by turn-ledger-ipc.ts) ─

export const meshStoreIpcHandlers: Record<string, LowFamilyHandler> = {
    tool_call_record: toolCallRecord,
    ledger_query: ledgerQuery,
    mission_list_query: missionListQuery,
    record_local: recordLocal,
    queue_query: queueQuery,
    queue_enqueue: queueEnqueue,
    queue_enqueue_graph: queueEnqueueGraph,
    queue_cancel: queueCancel,
    queue_requeue: queueRequeue,
    direct_dispatch_record: directDispatchRecord,
    graph_audit_record: graphAuditRecord,
    active_work_query: activeWorkQuery,
    recovery_context_query: recoveryContextQuery,
};
