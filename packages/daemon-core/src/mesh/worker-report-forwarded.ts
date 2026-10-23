/**
 * Worker identity for reports that do not originate on this daemon: a remote worker
 * resolved from its assignment stamp, and a report forwarded by another daemon whose
 * claimed (mesh, task, session) must match an owner row here before it is accepted.
 */
import { verifyWorkerSessionBind, verifyWorkerTaskToken, findWorkerTaskTokenForSession, type WorkerTokenExchangeResult } from './worker-mcp-isolation.js';
import { resolveRecentlyTerminalAttempt, WORKER_LATE_REPORT_GRACE_MS, acceptLateWorkerCompletionReport, type LateWorkerIdentity } from './worker-report-late.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { WorkerCompletionReport } from './worker-report-validation.js';
import { acceptWorkerCompletionReportForIdentity, normalizeWorkerReportedAtMs, workerIdentityPostdates, type WorkerReportResult } from './worker-report.js';

// ─── Remote worker (F7): the report is owned by another daemon ─────────

/**
 * What THIS daemon stamped on a worker session when it received a mesh
 * dispatch (`attachMeshAssignment`: `meshNodeFor` / `meshActiveTaskId` /
 * `meshActiveAttemptId` / `meshCoordinatorDaemonId`). Daemon state, never a
 * caller argument — the command layer reads it off the live instance.
 *
 * `taskId`/`attemptId` are OPTIONAL: when the owner terminalizes the attempt,
 * this daemon releases the attempt ref (and a detach clears the task marker)
 * while a coordinator-launched member keeps its mesh + coordinator membership.
 * A late report (F7b) then carries only the membership, and the owner resolves
 * the attempt from its own ledger.
 */
export interface WorkerAssignmentStamp {
    meshId: string;
    /** The coordinator daemon that dispatched the task — it owns the attempt. */
    ownerDaemonId: string;
    taskId?: string;
    attemptId?: string;
    nodeId?: string;
    generation?: number;
}

/** A worker whose task lives on ANOTHER daemon's ledger (the attempt's owner). */
export interface RemoteWorkerIdentity {
    meshId: string;
    sessionId: string;
    ownerDaemonId: string;
    taskId?: string;
    attemptId?: string;
    nodeId?: string;
    generation?: number;
}

/**
 * F7 (wiring-unification live pass, rc.36): resolve a worker whose task is
 * owned by a REMOTE coordinator daemon.
 *
 * The worker's MCP talks to its LOCAL daemon, but the queue row, the turn
 * attempt and the minted task token all live on the OWNER (the token is minted
 * where the attempt opens — `dispatch_accepted` / the queue claim — and never
 * leaves it, so the owner authorises a forwarded report without it). So
 * `resolveWorkerIdentity` here finds no assigned row and no token and refuses,
 * even though the task is live. The only local proof this daemon holds is the
 * assignment stamp it wrote when it received the dispatch.
 *
 * Fail-closed at every branch:
 *   - only a BIND credential (a token is minted by the owner; one presented
 *     here that this daemon does not know proves nothing);
 *   - the stamp must be on the bind's own session, for the bind's own mesh,
 *     and name an owner;
 *   - an owner that is THIS daemon is not remote — the local path already
 *     answered, and its refusal stands.
 * The OWNER re-resolves everything against its own state before accepting
 * (`resolveForwardedWorkerIdentity`), so this is a routing decision, not an
 * authority: a stale stamp is refused there.
 */
export function resolveRemoteWorkerIdentity(
    credential: { bind?: unknown; token?: unknown; taskId?: unknown; attemptId?: unknown },
    deps: {
        readAssignmentStamp: (sessionId: string) => WorkerAssignmentStamp | null;
        isSelfDaemon: (daemonId: string) => boolean;
        resolveMeshHostOwner?: (
            meshId: string,
            sessionId: string,
            nodeId?: string,
        ) => WorkerAssignmentStamp | null;
    },
): RemoteWorkerIdentity | null {
    const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const hasRawToken = trim(credential.token).length > 0;
    const binding = verifyWorkerSessionBind(credential.bind);
    const directToken = verifyWorkerTaskToken(credential.token);
    if (hasRawToken && !directToken) return null;
    const sessionId = binding?.sessionId || (directToken?.sessionId ? directToken.sessionId.trim() : '');
    const expectedMeshId = binding?.meshId || (directToken?.meshId ? directToken.meshId.trim() : '');
    if (!sessionId || !expectedMeshId) return null;
    if (
        binding &&
        directToken &&
        (binding.meshId !== directToken.meshId ||
            (directToken.sessionId && binding.sessionId !== directToken.sessionId))
    ) {
        return null;
    }
    let stamp: WorkerAssignmentStamp | null = null;
    try {
        stamp = deps.readAssignmentStamp(sessionId);
    } catch {
        stamp = null;
    }
    let fallbackStamp: WorkerAssignmentStamp | null = null;
    if ((!stamp || !trim(stamp.ownerDaemonId)) && deps.resolveMeshHostOwner) {
        try {
            fallbackStamp = deps.resolveMeshHostOwner(
                expectedMeshId,
                sessionId,
                binding?.nodeId || directToken?.nodeId,
            );
        } catch {
            fallbackStamp = null;
        }
    }
    const effectiveStamp = stamp && trim(stamp.ownerDaemonId) ? stamp : fallbackStamp;
    if (!effectiveStamp) return null;
    const meshId = trim(effectiveStamp.meshId);
    const ownerDaemonId = trim(effectiveStamp.ownerDaemonId);
    if (!meshId || !ownerDaemonId) return null;
    if (meshId !== expectedMeshId) return null;
    if (deps.isSelfDaemon(ownerDaemonId)) return null;
    const reqTaskId = trim(credential.taskId);
    const reqAttemptId = trim(credential.attemptId);
    const tokenTaskId = trim(directToken?.taskId);
    const tokenAttemptId = trim(directToken?.attemptId);
    const stampTaskId = trim(effectiveStamp.taskId) || trim(stamp?.taskId);
    const stampAttemptId = trim(effectiveStamp.attemptId) || trim(stamp?.attemptId);
    if (
        (reqTaskId && tokenTaskId && reqTaskId !== tokenTaskId) ||
        (reqTaskId && stampTaskId && reqTaskId !== stampTaskId) ||
        (tokenTaskId && stampTaskId && tokenTaskId !== stampTaskId)
    ) {
        return null;
    }
    if (
        (reqAttemptId && tokenAttemptId && reqAttemptId !== tokenAttemptId) ||
        (reqAttemptId && stampAttemptId && reqAttemptId !== stampAttemptId) ||
        (tokenAttemptId && stampAttemptId && tokenAttemptId !== stampAttemptId)
    ) {
        return null;
    }
    const taskId =
        tokenTaskId ||
        reqTaskId ||
        stampTaskId ||
        (!stamp ? trim(binding?.spawnedForTaskId) : '');
    const attemptId =
        tokenAttemptId ||
        reqAttemptId ||
        stampAttemptId;
    const nodeId = trim(effectiveStamp.nodeId) || trim(stamp?.nodeId) || binding?.nodeId || directToken?.nodeId;
    const generation = Number.isInteger(effectiveStamp.generation)
        ? effectiveStamp.generation
        : Number.isInteger(stamp?.generation)
          ? stamp?.generation
          : undefined;
    return {
        meshId,
        sessionId,
        ownerDaemonId,
        ...(taskId ? { taskId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(generation !== undefined ? { generation } : {}),
        ...(nodeId ? { nodeId } : {}),
    };
}

/**
 * The identity claim a worker daemon forwards to the owner (never trusted
 * as-is). `taskId`/`attemptId` are consistency checks only: when present they
 * must agree with what the owner resolves.
 */
export interface ForwardedWorkerReportClaim {
    meshId: string;
    sessionId: string;
    taskId?: string;
    attemptId?: string;
    generation?: number;
}

/**
 * Who relayed a forwarded report, and how the OWNER maps a node to its daemon.
 *
 * `senderDaemonId` is stamped by the owner's mesh transport from the
 * authenticated P2P channel the command arrived on (never read from the
 * sender's own payload — see `MESH_SENDER_DAEMON_ID_ARG`). `nodeDaemonId` reads
 * the owner's own mesh roster.
 */
export interface ForwardedReportSender {
    senderDaemonId: string;
    nodeDaemonId: (nodeId: string) => string | undefined;
}

/** Why the owner refused a forwarded report — logged and returned to the worker. */
export type ForwardedReportRefusalReason =
    /** The transport did not say which daemon sent the command. */
    | 'sender_unknown'
    /** No assigned row for the session here, and no recently-terminal attempt either. */
    | 'no_live_task'
    /** The claim names a task other than the one the owner has on that session. */
    | 'task_mismatch'
    /** The claim names an attempt other than the task's attempt on the owner. */
    | 'attempt_mismatch'
    | 'generation_mismatch'
    /** The owner's row/attempt carries no node, or the owner's roster cannot place it. */
    | 'node_unresolved'
    /** The node the owner assigned the task to belongs to a different daemon than the sender. */
    | 'sender_not_node_owner';

type ForwardedWorkerIdentityResolution =
    | { live: WorkerTokenExchangeResult }
    | { late: LateWorkerIdentity }
    | { refused: ForwardedReportRefusalReason; detail: string };

/**
 * F7, OWNER side: re-resolve a forwarded claim against THIS daemon's state.
 *
 * ★No token requirement (rc.37 Finding A). The worker's task token is minted
 * HERE, where the attempt opens, and never leaves this daemon — the remote
 * worker holds only a bind minted by ITS daemon, which this daemon cannot
 * verify. So the forwarded path is authorised on what the owner itself knows
 * plus the transport's authenticated sender:
 *   1. live — the owner's own `assigned` queue row names that session
 *      (`findAssignedBySession`, exact-task match first when the claim names
 *      one), the row's node belongs to the SENDER daemon on the owner's roster
 *      (`daemonIdsEquivalent`), and the claim's task/attempt, when given, agree
 *      with the row and its attempt;
 *   2. late (F7b) — the session's latest mesh attempt on this ledger is terminal
 *      within the grace window, still its task's current attempt, agrees with
 *      the claim, and its node belongs to the sender.
 * Every refusal carries a typed reason + a detail naming what the owner holds,
 * so the worker (and the owner log) never see a bare "unauthenticated".
 *
 * A claim that CONTRADICTS the owner's row is refused rather than re-pointed at
 * the session's live task: in the live incident the contradicting claim was a
 * report about a different body, and landing it on the live task would have
 * committed that task with another task's summary.
 */
export function resolveForwardedWorkerIdentity(
    claim: ForwardedWorkerReportClaim,
    sender: ForwardedReportSender,
    nowMs = Date.now(),
    isSelfDaemon?: (daemonId: string) => boolean,
): ForwardedWorkerIdentityResolution {
    const refuse = (reason: ForwardedReportRefusalReason, detail: string): ForwardedWorkerIdentityResolution => ({ refused: reason, detail });
    const senderDaemonId = typeof sender.senderDaemonId === 'string' ? sender.senderDaemonId.trim() : '';
    if (!senderDaemonId) return refuse('sender_unknown', 'the mesh transport did not identify the relaying daemon');

    const senderOwnsNode = (nodeId: string | undefined): ForwardedWorkerIdentityResolution | null => {
        if (!nodeId) return refuse('node_unresolved', 'the owner\'s record of this task names no node');
        let owner: string | undefined;
        try { owner = sender.nodeDaemonId(nodeId); } catch { owner = undefined; }
        if (!owner) return refuse('node_unresolved', `node ${nodeId} is not on the owner's mesh roster`);
        if (!daemonIdsEquivalent(owner, senderDaemonId)) {
            return refuse('sender_not_node_owner', `node ${nodeId} belongs to daemon ${owner}, not the relaying daemon ${senderDaemonId}`);
        }
        return null;
    };

    const store = MeshRuntimeStore.getInstance();
    let row: ReturnType<MeshRuntimeStore['findAssignedBySession']> = null;
    try {
        row = store.findAssignedBySession(claim.meshId, claim.sessionId, undefined, claim.taskId);
    } catch {
        row = null;
    }
    if (row?.id) {
        if (claim.taskId && claim.taskId !== row.id) {
            return refuse('task_mismatch', `the owner has task ${row.id} assigned to session ${claim.sessionId}, not ${claim.taskId}${describeOwnerRow(store, claim.meshId, claim.taskId)}`);
        }
        const rowNodeId = row.assignedNodeId || row.targetNodeId;
        const nodeRefusal = senderOwnsNode(rowNodeId);
        if (nodeRefusal) return nodeRefusal;
        let latestAttempt: ReturnType<ReturnType<MeshRuntimeStore['turnStore']>['findLatestAttemptForTask']> | null = null;
        try { latestAttempt = store.turnStore().findLatestAttemptForTask(claim.meshId, row.id) ?? null; } catch { latestAttempt = null; }
        let attemptId = row.attemptId;
        if (!attemptId) {
            attemptId = latestAttempt?.attemptId;
        }
        if (claim.attemptId && claim.attemptId !== attemptId) {
            return refuse('attempt_mismatch', `task ${row.id}'s attempt on the owner is ${attemptId ?? '(none)'}, not ${claim.attemptId}`);
        }
        if (latestAttempt && attemptId && latestAttempt.attemptId !== attemptId) {
            return refuse('attempt_mismatch', `task ${row.id}'s latest attempt on the owner is ${latestAttempt.attemptId}, not ${attemptId}`);
        }
        const attempt = attemptId ? store.turnStore().getAttempt(attemptId) : latestAttempt;
        if (claim.generation !== undefined && claim.generation !== attempt?.generation) return refuse('generation_mismatch', 'the claimed generation is no longer current');
        if (attempt && (attempt.sessionId !== claim.sessionId || (isSelfDaemon && !isSelfDaemon(attempt.ownerDaemonId)))) return refuse('attempt_mismatch', 'the attempt is not owned here for this session');
        if (latestAttempt && (latestAttempt.sessionId !== claim.sessionId || (isSelfDaemon && !isSelfDaemon(latestAttempt.ownerDaemonId)))) return refuse('attempt_mismatch', 'the latest attempt is not owned here for this session');
        if (!attempt?.terminal && !latestAttempt?.terminal) {
            const token = findWorkerTaskTokenForSession(claim.meshId, row.id, claim.sessionId);
            return {
                live: {
                    token: token?.token ?? '',
                    meshId: claim.meshId,
                    taskId: row.id,
                    ...(attemptId ? { attemptId } : {}),
                    sessionId: claim.sessionId,
                    nodeId: rowNodeId!,
                },
            };
        }
    }

    const attempt = resolveRecentlyTerminalAttempt(claim.meshId, claim.sessionId, nowMs, isSelfDaemon);
    if (!attempt) {
        return refuse('no_live_task', `the owner has no task assigned to session ${claim.sessionId} and no attempt of it that ended in the last ${Math.round(WORKER_LATE_REPORT_GRACE_MS / 60000)} min${claim.taskId ? describeOwnerRow(store, claim.meshId, claim.taskId) : ''}`);
    }
    if (claim.taskId && claim.taskId !== attempt.taskId) {
        return refuse('task_mismatch', `session ${claim.sessionId}'s latest attempt on the owner is for task ${attempt.taskId}, not ${claim.taskId}${describeOwnerRow(store, claim.meshId, claim.taskId)}`);
    }
    if (claim.attemptId && claim.attemptId !== attempt.attemptId) {
        return refuse('attempt_mismatch', `task ${attempt.taskId}'s attempt on the owner is ${attempt.attemptId}, not ${claim.attemptId}`);
    }
    if (claim.generation !== undefined && claim.generation !== store.turnStore().getAttempt(attempt.attemptId)?.generation) return refuse('generation_mismatch', 'the terminal generation does not match');
    const nodeRefusal = senderOwnsNode(attempt.nodeId);
    if (nodeRefusal) return nodeRefusal;
    return {
        late: {
            token: '',
            meshId: claim.meshId,
            taskId: attempt.taskId,
            attemptId: attempt.attemptId,
            sessionId: claim.sessionId,
            ...(attempt.nodeId ? { nodeId: attempt.nodeId } : {}),
            terminalOutcome: attempt.terminalOutcome,
            terminalAtMs: attempt.terminalAtMs,
        },
    };
}

/** " (task X is <status> on the owner …)" — what the owner holds for a claimed task id, for refusal details. */
function describeOwnerRow(store: MeshRuntimeStore, meshId: string, taskId: string): string {
    try {
        const entry = store.findQueueEntryById(meshId, taskId);
        if (!entry) return ` (task ${taskId} is unknown to the owner)`;
        const session = entry.assignedSessionId ? `, assigned to session ${entry.assignedSessionId}` : ', never claimed by a session';
        return ` (task ${taskId} is ${entry.status} on the owner${session})`;
    } catch {
        return '';
    }
}

/**
 * F7, OWNER side: accept a report a remote worker daemon forwarded over the mesh
 * command relay. Same bodies as a local report — live: the same fence, evidence
 * row, handoff note (text appended to `mesh.<id>.handoff` by this daemon) and
 * terminal chokepoint; late: the F7b evidence-only body. A refusal's `detail`
 * starts with its typed reason (`<reason>: <what the owner holds>`).
 */
export function acceptForwardedWorkerCompletionReport(
    claim: ForwardedWorkerReportClaim,
    report: WorkerCompletionReport,
    opts: { sender: ForwardedReportSender; nowMs?: number; isSelfDaemon?: (daemonId: string) => boolean; reportedAtMs?: unknown },
): WorkerReportResult {
    const nowMs = opts.nowMs ?? Date.now();
    const reportedAt = normalizeWorkerReportedAtMs(opts.reportedAtMs, nowMs);
    if (reportedAt === 'too_old') return { accepted: false, refusal: 'stale_report' };
    const resolved = resolveForwardedWorkerIdentity(claim, opts.sender, nowMs, opts.isSelfDaemon);
    if ('refused' in resolved) return { accepted: false, refusal: 'unauthenticated', detail: `${resolved.refused}: ${resolved.detail}` };
    if ('late' in resolved) return acceptLateWorkerCompletionReport(resolved.late, report, nowMs);
    if (typeof reportedAt === 'number' && workerIdentityPostdates(resolved.live, reportedAt)) return { accepted: false, refusal: 'stale_report' };
    return acceptWorkerCompletionReportForIdentity(resolved.live, report, { nowMs });
}
