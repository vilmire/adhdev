/**
 * WORKER-MCP LOW family — the daemon side of the worker reporting tools.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §4 (B), §5 (C), §9.1.1.
 *
 * ─── Why these live in the DAEMON and not in the MCP server ──────────────
 *
 * The mcp-server process cannot do this work itself, for two independent
 * reasons, and both are structural rather than stylistic:
 *
 *  1. **The ledger.** `turn_events` and the turn reducer live in the
 *     daemon's SQLite store. Two processes writing terminal outcomes would mean
 *     two reducers, which is exactly the "two truths" the single-terminal-writer
 *     rule exists to prevent.
 *  2. **seqscribe.** `~/.adhdev/seqscribe.db` is held under a single-owner
 *     `BEGIN EXCLUSIVE` lock by the daemon; a second opener gets `ERR_DB_OWNED`.
 *     The mcp-server's seqscribe node is permanently null, so it could not
 *     append a handoff note even if it wanted to (design §9.1.1).
 *
 * ∴ the worker's report travels worker → (stdio) → mcp-server → (IPC) → daemon,
 * and the daemon is the only writer. This is the same conclusion decision F
 * reached independently for the proxy-append rule.
 *
 * ─── Authentication ─────────────────────────────────────────────────────
 *
 * Every handler here is fail-closed on identity. The caller presents a bind (or
 * a token); the daemon resolves it against state only the daemon has. Nothing
 * the caller asserts about WHICH task it is working on is trusted — there is no
 * `taskId` argument on purpose, because an argument can be wrong and a lookup
 * cannot (design §4: "워커가 taskId 를 인자로 넣지 않는다").
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';
import { stripRouterInternalArgs } from '../router-internal-args.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { currentMeshAttemptRef } from '../../providers/cli-provider-mesh-assignment.js';
import { LOG } from '../../logging/logger.js';
import type {
    ForwardedReportSender,
    ForwardedWorkerReportClaim,
    RemoteWorkerIdentity,
    WorkerAssignmentStamp,
    WorkerCompletionReport,
    WorkerProgressUpdateResult,
    WorkerReportResult,
} from '../../mesh/worker-report.js';

/**
 * F7: the owner-side command a REMOTE worker daemon relays a report through
 * (`dispatchMeshCommand` → the owner's `handleMeshCommand`, source `mesh`).
 */
export const WORKER_REPORT_FORWARD_COMMAND = 'worker_report_forwarded';

/**
 * F7 (progress axis): the owner-side command a REMOTE worker daemon relays a
 * `worker_progress_update` note through — same relay, same sender
 * authorisation as {@link WORKER_REPORT_FORWARD_COMMAND}. Without it a remote
 * worker's every progress note was refused `unauthenticated` on its own daemon
 * (which holds no attempt) and lost.
 */
export const WORKER_PROGRESS_FORWARD_COMMAND = 'worker_progress_forwarded';

/**
 * rc.37 Finding A: the router-internal arg the OWNER's mesh transport stamps
 * with the daemon id of the authenticated P2P peer a command arrived from
 * (daemon-cloud `CloudCommandTransports.handleMeshCommand`, applied as a
 * `withMeshDirectDispatch` extra so it OVERRIDES anything the peer put in its
 * args). Leading underscore = router-internal: strict decoders strip it, and
 * no wire contract carries it. The forwarded-report handler authorises on it
 * (the sender must own the node the owner assigned the task to).
 */
export const MESH_SENDER_DAEMON_ID_ARG = '_meshSenderDaemonId';

function readNonEmpty(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The assignment stamp THIS daemon wrote on a live worker session when it
 * received the dispatch (`attachMeshAssignment`). Read off the instance, never
 * off the caller's args.
 */
function assignmentStampReader(ctx: LowFamilyContext): (sessionId: string) => WorkerAssignmentStamp | null {
    return (sessionId: string) => {
        let settings: Record<string, any> | undefined;
        try {
            const state: any = ctx?.deps?.instanceManager?.getInstance?.(sessionId)?.getState?.();
            settings = state?.settings && typeof state.settings === 'object' ? state.settings : undefined;
        } catch {
            return null;
        }
        if (!settings) return null;
        const meshId = readNonEmpty(settings.meshNodeFor);
        const ownerDaemonId = readNonEmpty(settings.meshCoordinatorDaemonId);
        if (!meshId || !ownerDaemonId) return null;
        // Task + attempt markers are present while the task is live; after the
        // owner terminalizes it they are released (F7b late report) and only the
        // membership remains — the owner then resolves from its own ledger.
        const attemptRef = currentMeshAttemptRef(settings);
        const taskId = readNonEmpty(settings.meshActiveTaskId);
        const nodeId = readNonEmpty(settings.meshNodeId) || readNonEmpty(settings.meshLastNodeId);
        return {
            meshId,
            ownerDaemonId,
            ...(taskId ? { taskId } : {}),
            ...(attemptRef ? { attemptId: attemptRef.attemptId } : {}),
            ...(nodeId ? { nodeId } : {}),
        };
    };
}

/**
 * F7 (mailbox axis): the live session on THIS daemon whose assignment stamp
 * names (meshId, taskId) with ANOTHER daemon as owner — i.e. this daemon hosts
 * the worker of a remote-owned task. Read off this daemon's own instances (the
 * stamp `attachMeshAssignment` wrote on receipt of the dispatch), never off the
 * caller's args. Unknown self id ⇒ null (fail closed, as `resolveRemoteWorker`).
 */
export function findLocalWorkerOfRemoteTask(ctx: LowFamilyContext, meshId: string, taskId: string): { sessionId: string; ownerDaemonId: string } | null {
    const isSelf = selfDaemonPredicate(ctx);
    if (!isSelf || !meshId || !taskId) return null;
    let ids: string[] = [];
    try { ids = ctx?.deps?.instanceManager?.listInstanceIds?.() ?? []; } catch { ids = []; }
    const read = assignmentStampReader(ctx);
    for (const sessionId of ids) {
        const stamp = read(sessionId);
        if (stamp && stamp.meshId === meshId && stamp.taskId === taskId && !isSelf(stamp.ownerDaemonId)) {
            return { sessionId, ownerDaemonId: stamp.ownerDaemonId };
        }
    }
    return null;
}

/** This daemon's own-id predicate, or undefined when the host never told us our id. */
function selfDaemonPredicate(ctx: LowFamilyContext): ((daemonId: string) => boolean) | undefined {
    const selfDaemonId = readNonEmpty(ctx?.deps?.statusInstanceId);
    return selfDaemonId ? (daemonId: string) => daemonIdsEquivalent(daemonId, selfDaemonId) : undefined;
}

/**
 * F7: when no LOCAL task resolves, is this a worker whose task another daemon
 * owns? Unknown self id ⇒ no (fail closed — forwarding to an id that might be
 * our own would self-dial).
 */
export async function resolveRemoteWorker(ctx: LowFamilyContext, args: any): Promise<RemoteWorkerIdentity | null> {
    const selfDaemonId = readNonEmpty(ctx?.deps?.statusInstanceId);
    if (!selfDaemonId) return null;
    const { resolveRemoteWorkerIdentity } = await import('../../mesh/worker-report.js');
    return resolveRemoteWorkerIdentity({ bind: args?.bind }, {
        readAssignmentStamp: assignmentStampReader(ctx),
        isSelfDaemon: (daemonId) => daemonIdsEquivalent(daemonId, selfDaemonId),
    });
}

/**
 * The OWNER's roster answer to "which daemon owns node X?" for one mesh —
 * resolved once per forwarded report from the router's mesh view (inline cache
 * first, then local config), through the shared multi-form daemon-id reader.
 * An unresolvable mesh yields a lookup that knows no node (fail-closed:
 * `node_unresolved`).
 */
async function ownerRosterNodeDaemonLookup(ctx: LowFamilyContext, meshId: string): Promise<(nodeId: string) => string | undefined> {
    let nodes: any[] = [];
    try {
        const record = await ctx?.getMeshForCommand?.(meshId, undefined, { preferInline: true });
        nodes = Array.isArray(record?.mesh?.nodes) ? record!.mesh.nodes : [];
    } catch {
        nodes = [];
    }
    return (nodeId: string) => {
        const node = nodes.find((n: any) => meshNodeIdMatches(n, nodeId));
        return node ? readMeshNodeDaemonId(node) : undefined;
    };
}

/** The command-layer answer for a report result — identical for local and forwarded reports. */
function toReportResponse(result: WorkerReportResult): Record<string, unknown> & { success: boolean } {
    if (!result.accepted) {
        return {
            success: false,
            error: result.refusal,
            ...(result.detail ? { detail: result.detail } : {}),
            hint: result.refusal === 'unauthenticated'
                ? 'No live task is bound to this worker session — the task may already be terminal or reassigned.'
                : result.refusal === 'invalid_for_task_mode'
                    ? 'Fix the touchedFiles list to match the task mode and call again.'
                    : result.refusal === 'storage_failed'
                        ? 'Nothing was recorded — call again.'
                        : 'The completion was refused by the turn ledger; the task state is authoritative.',
        };
    }
    return {
        success: true,
        taskId: result.taskId,
        ...(result.attemptId ? { attemptId: result.attemptId } : {}),
        outcome: result.outcome,
        duplicate: result.duplicate,
        handoffNoteRecorded: result.handoffNoteRecorded,
        // ★F5: carries WHY a note did not persist, so the tool layer can
        // warn instead of printing the unconditional "stored" line.
        ...(result.handoffNoteError ? { handoffNoteError: result.handoffNoteError } : {}),
        // H1 (path ownership): present only on a declared-but-mismatched report —
        // evidence, never a refusal (the completion above already committed).
        ...(result.ownedPathsMismatch ? { ownedPathsMismatch: result.ownedPathsMismatch } : {}),
        // F7b: accepted as evidence after the ledger already terminalized the attempt.
        ...(result.late ? { late: true, terminalOutcome: result.late.terminalOutcome } : {}),
    };
}

/** The command-layer answer for a progress update — identical for local and forwarded notes. */
function toProgressResponse(result: WorkerProgressUpdateResult): Record<string, unknown> & { success: boolean } {
    if (!result.accepted) {
        return {
            success: false,
            error: result.refusal || 'unauthenticated',
            ...(result.detail ? { detail: result.detail } : {}),
        };
    }
    return {
        success: true,
        ...(result.taskId ? { taskId: result.taskId } : {}),
        // ★F3: whether the note reached the coordinator, or was recorded
        // only. The filter is at the producer, so this is the one place
        // the worker can learn which of the two happened.
        surfacedToCoordinator: result.surfacedToCoordinator === true,
    };
}

/** A relay answer may arrive wrapped (`{ result }` / `{ payload }`); find the handler's own object. */
function unwrapRelayResult(raw: unknown): (Record<string, unknown> & { success: boolean }) | null {
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        const record = cursor as Record<string, unknown>;
        if (typeof record.success === 'boolean') return record as Record<string, unknown> & { success: boolean };
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        break;
    }
    return null;
}

/**
 * F7: relay a validated report to the attempt's OWNER daemon over the mesh
 * command relay. Nothing is written on this (the worker's) daemon — the owner
 * holds the queue row, the attempt and the token, and its reducer is the only
 * terminal writer. The owner's answer is returned as-is, so the worker sees
 * the same result a local report would give.
 */
async function forwardReportToOwner(
    ctx: LowFamilyContext,
    remote: RemoteWorkerIdentity,
    report: WorkerCompletionReport,
): Promise<Record<string, unknown> & { success: boolean }> {
    return forwardToOwner(ctx, remote, WORKER_REPORT_FORWARD_COMMAND, { report }, `${report.outcome} report`);
}

/**
 * The relay itself, shared by the completion report and the progress note:
 * the claim (never trusted by the owner) + the command's own payload, one
 * worker-side log line carrying the owner's verdict and refusal reason.
 */
async function forwardToOwner(
    ctx: LowFamilyContext,
    remote: RemoteWorkerIdentity,
    command: string,
    payload: Record<string, unknown>,
    what: string,
): Promise<Record<string, unknown> & { success: boolean }> {
    const dispatch = ctx?.deps?.dispatchMeshCommand;
    if (!dispatch) {
        return {
            success: false,
            error: 'unauthenticated',
            detail: `this worker's task is owned by daemon ${remote.ownerDaemonId}, and this daemon has no mesh transport to reach it`,
            hint: 'No live task is bound to this worker session — the task may already be terminal or reassigned.',
        };
    }
    const claim: ForwardedWorkerReportClaim = {
        meshId: remote.meshId,
        sessionId: remote.sessionId,
        ...(remote.taskId ? { taskId: remote.taskId } : {}),
        ...(remote.attemptId ? { attemptId: remote.attemptId } : {}),
    };
    let raw: unknown;
    try {
        raw = await dispatch(remote.ownerDaemonId, command, {
            ...claim,
            ...(remote.nodeId ? { nodeId: remote.nodeId } : {}),
            ...payload,
        });
    } catch (e: any) {
        LOG.warn('WorkerReport', `Forwarding ${what} for session ${remote.sessionId} (task ${remote.taskId ?? '?'}) to owner ${remote.ownerDaemonId.slice(0, 16)} failed: ${e?.message || e}`);
        return {
            success: false,
            error: 'forward_failed',
            detail: e?.message || String(e),
            hint: 'Nothing was recorded — call again.',
        };
    }
    const answer = unwrapRelayResult(raw);
    if (!answer) {
        return { success: false, error: 'forward_failed', detail: `the owner daemon returned no ${command} result`, hint: 'Nothing was recorded — call again.' };
    }
    const line = `Forwarded ${what} for session ${remote.sessionId} (task ${remote.taskId ?? '?'} attempt ${remote.attemptId ?? '?'}) to owner ${remote.ownerDaemonId.slice(0, 16)} → ${answer.success === true ? 'accepted' : `refused (${String(answer.error)}${typeof answer.detail === 'string' && answer.detail ? ` — ${answer.detail}` : ''})`}`;
    if (answer.success === true) LOG.info('WorkerReport', line);
    else LOG.warn('WorkerReport', line);
    return answer;
}

const CLAIM_KEYS = ['meshId', 'taskId', 'attemptId', 'sessionId', 'nodeId'] as const;
const FORWARD_KEYS = new Set<string>([...CLAIM_KEYS, 'report']);
const PROGRESS_FORWARD_KEYS = new Set<string>([...CLAIM_KEYS, 'note']);

/**
 * The claim half of a forwarded request, strict: only `allowedKeys` present
 * (router-internal `_` keys stripped first), meshId + sessionId required, and a
 * present optional id must be a non-empty string.
 */
function decodeForwardedClaim(
    args: unknown,
    allowedKeys: ReadonlySet<string>,
): { claim: ForwardedWorkerReportClaim; record: Record<string, unknown> } | null {
    const input = stripRouterInternalArgs(args);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!allowedKeys.has(key)) return null;
    const meshId = readNonEmpty(record.meshId);
    const sessionId = readNonEmpty(record.sessionId);
    if (!meshId || !sessionId) return null;
    // Optional consistency checks — but a present one must be a non-empty string.
    for (const key of ['taskId', 'attemptId', 'nodeId'] as const) {
        if (record[key] !== undefined && !readNonEmpty(record[key])) return null;
    }
    const taskId = readNonEmpty(record.taskId);
    const attemptId = readNonEmpty(record.attemptId);
    return {
        claim: { meshId, sessionId, ...(taskId ? { taskId } : {}), ...(attemptId ? { attemptId } : {}) },
        record,
    };
}

/**
 * Strict decoder for the forwarded-report request: exactly the claim fields,
 * an optional nodeId, and the report object (validated separately by the same
 * validator a local report goes through). Router-internal `_` keys stripped.
 */
export function decodeForwardedWorkerReport(args: unknown): { claim: ForwardedWorkerReportClaim; report: unknown } | null {
    const decoded = decodeForwardedClaim(args, FORWARD_KEYS);
    if (!decoded) return null;
    const { report } = decoded.record;
    if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
    return { claim: decoded.claim, report };
}

/**
 * Strict decoder for the forwarded progress request: exactly the claim fields,
 * an optional nodeId, and a non-empty `note` string (trimmed, as the local
 * update trims it). Router-internal `_` keys stripped.
 */
export function decodeForwardedWorkerProgress(args: unknown): { claim: ForwardedWorkerReportClaim; note: string } | null {
    const decoded = decodeForwardedClaim(args, PROGRESS_FORWARD_KEYS);
    if (!decoded) return null;
    const note = readNonEmpty(decoded.record.note);
    if (!note) return null;
    return { claim: decoded.claim, note };
}

export const workerReportHandlers: Record<string, LowFamilyHandler> = {
    /**
     * Exchange a session bind for the caller's current task identity.
     *
     * Exposed as its own command so the MCP server can answer "do I have a task
     * right now" — which is what decides whether it publishes the reporting
     * tools at all — without having to submit a report to find out.
     *
     * ★The task TOKEN is deliberately NOT returned. The caller does not need it:
     * it presents the bind again on the actual report, and the daemon re-resolves.
     * Returning the token would put a second live secret on the wire for no gain.
     */
    worker_resolve_task: async (_ctx: LowFamilyContext, args: any) => {
        try {
            const { resolveWorkerIdentity } = await import('../../mesh/worker-report.js');
            const identity = resolveWorkerIdentity({ token: args?.token, bind: args?.bind });
            if (!identity) {
                // F7: a task owned by a remote coordinator daemon is still a live task.
                const remote = await resolveRemoteWorker(_ctx, args);
                if (remote?.taskId && remote.attemptId) {
                    return {
                        success: true,
                        meshId: remote.meshId,
                        taskId: remote.taskId,
                        attemptId: remote.attemptId,
                        sessionId: remote.sessionId,
                        ...(remote.nodeId ? { nodeId: remote.nodeId } : {}),
                    };
                }
                return {
                    success: false,
                    error: 'worker_not_bound',
                    hint: 'No live task is bound to this worker session. A report is only possible while a task is assigned.',
                };
            }
            return {
                success: true,
                meshId: identity.meshId,
                taskId: identity.taskId,
                ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
                ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
            };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },

    /**
     * Accept a structured completion report.
     *
     * Validation errors come back as a STRUCTURED list rather than a single
     * string so the MCP layer can hand the worker something it can act on
     * field-by-field — the retry loop is the whole reason the schema is enforced
     * at the tool layer instead of being parsed out of prose.
     */
    worker_report_completion: async (_ctx: LowFamilyContext, args: any) => {
        try {
            const { validateWorkerCompletionReport, acceptWorkerCompletionReport, hasLocalWorkerIdentity } =
                await import('../../mesh/worker-report.js');
            const { report, errors } = validateWorkerCompletionReport(args?.report);
            if (!report) {
                return { success: false, error: 'invalid_report', validationErrors: errors };
            }
            const credential = { token: args?.token, bind: args?.bind };
            // F7: the task may be owned by a REMOTE coordinator daemon (queue row,
            // attempt and token all live there). No local identity + a valid
            // assignment stamp naming another owner ⇒ relay to that owner; nothing
            // is written here.
            const isSelfDaemon = selfDaemonPredicate(_ctx);
            if (!hasLocalWorkerIdentity(credential, { isSelfDaemon })) {
                const remote = await resolveRemoteWorker(_ctx, args);
                if (remote) return await forwardReportToOwner(_ctx, remote, report);
            }
            return toReportResponse(acceptWorkerCompletionReport(credential, report, { isSelfDaemon }));
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },

    /**
     * F7, OWNER side: a report a remote worker daemon relayed here (it has no
     * local attempt; this daemon owns the queue row, the attempt and the
     * token). The claim is re-resolved against this daemon's own state
     * (`resolveForwardedWorkerIdentity`) — nothing in it is trusted — and the
     * report then takes the local acceptance body verbatim.
     */
    [WORKER_REPORT_FORWARD_COMMAND]: async (_ctx: LowFamilyContext, args: any) => {
        const decoded = decodeForwardedWorkerReport(args);
        if (!decoded) return { success: false, error: `${WORKER_REPORT_FORWARD_COMMAND}: request failed decode (bad shape)` };
        const { claim } = decoded;
        const senderDaemonId = readNonEmpty(args?.[MESH_SENDER_DAEMON_ID_ARG]);
        const claimLabel = `session ${claim.sessionId} (claimed task ${claim.taskId ?? '?'} attempt ${claim.attemptId ?? '?'}) from ${senderDaemonId ? senderDaemonId.slice(0, 20) : 'an unidentified daemon'}`;
        try {
            const { validateWorkerCompletionReport, acceptForwardedWorkerCompletionReport } =
                await import('../../mesh/worker-report.js');
            const { report, errors } = validateWorkerCompletionReport(decoded.report);
            if (!report) {
                LOG.warn('WorkerReport', `Forwarded report for ${claimLabel} refused: invalid_report (${errors.length} validation error(s))`);
                return { success: false, error: 'invalid_report', validationErrors: errors };
            }
            const sender: ForwardedReportSender = {
                senderDaemonId,
                nodeDaemonId: await ownerRosterNodeDaemonLookup(_ctx, claim.meshId),
            };
            const result = acceptForwardedWorkerCompletionReport(claim, report, { sender, isSelfDaemon: selfDaemonPredicate(_ctx) });
            // ONE owner-side line per forwarded report (the refusal used to be silent).
            if (result.accepted) {
                LOG.info('WorkerReport', `Forwarded ${report.outcome} report for ${claimLabel} → accepted as task ${result.taskId} attempt ${result.attemptId ?? '?'}${result.late ? ` (late, after ${result.late.terminalOutcome})` : ''}${result.duplicate ? ' (duplicate)' : ''}`);
            } else {
                LOG.warn('WorkerReport', `Forwarded ${report.outcome} report for ${claimLabel} → refused ${result.refusal}${result.detail ? ` — ${result.detail}` : ''}`);
            }
            return toReportResponse(result);
        } catch (e: any) {
            LOG.warn('WorkerReport', `Forwarded report for ${claimLabel} failed: ${e?.message || e}`);
            return { success: false, error: e?.message || String(e) };
        }
    },

    /** Record a mid-task progress note. Never terminal. */
    worker_progress_update: async (_ctx: LowFamilyContext, args: any) => {
        const note = typeof args?.note === 'string' ? args.note.trim() : '';
        if (!note) return { success: false, error: 'note required' };
        try {
            const { acceptWorkerProgressUpdate, hasLocalWorkerIdentity } = await import('../../mesh/worker-report.js');
            const credential = { token: args?.token, bind: args?.bind };
            // F7 (progress axis): same routing as the completion report — no
            // local task + an assignment stamp naming another owner ⇒ relay the
            // note to that owner (it holds the attempt the row hangs off).
            if (!hasLocalWorkerIdentity(credential, { isSelfDaemon: selfDaemonPredicate(_ctx) })) {
                const remote = await resolveRemoteWorker(_ctx, args);
                if (remote) return await forwardToOwner(_ctx, remote, WORKER_PROGRESS_FORWARD_COMMAND, { note }, 'progress note');
            }
            return toProgressResponse(acceptWorkerProgressUpdate(credential, note));
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },

    /**
     * F7 (progress axis), OWNER side: a progress note a remote worker daemon
     * relayed here. Authorised exactly like a forwarded completion report
     * (`resolveForwardedWorkerIdentity` with the transport-stamped sender), then
     * recorded by the local progress body.
     */
    [WORKER_PROGRESS_FORWARD_COMMAND]: async (_ctx: LowFamilyContext, args: any) => {
        const decoded = decodeForwardedWorkerProgress(args);
        if (!decoded) return { success: false, error: `${WORKER_PROGRESS_FORWARD_COMMAND}: request failed decode (bad shape)` };
        const { claim, note } = decoded;
        const senderDaemonId = readNonEmpty(args?.[MESH_SENDER_DAEMON_ID_ARG]);
        const claimLabel = `session ${claim.sessionId} (claimed task ${claim.taskId ?? '?'} attempt ${claim.attemptId ?? '?'}) from ${senderDaemonId ? senderDaemonId.slice(0, 20) : 'an unidentified daemon'}`;
        try {
            const { acceptForwardedWorkerProgressUpdate } = await import('../../mesh/worker-report.js');
            const sender: ForwardedReportSender = {
                senderDaemonId,
                nodeDaemonId: await ownerRosterNodeDaemonLookup(_ctx, claim.meshId),
            };
            const result = acceptForwardedWorkerProgressUpdate(claim, note, { sender, isSelfDaemon: selfDaemonPredicate(_ctx) });
            // ONE owner-side line per forwarded progress note.
            if (result.accepted) {
                LOG.info('WorkerReport', `Forwarded progress note for ${claimLabel} → accepted for task ${result.taskId ?? '?'}${result.surfacedToCoordinator ? ' (surfaced to coordinator)' : ''}`);
            } else {
                LOG.warn('WorkerReport', `Forwarded progress note for ${claimLabel} → refused ${result.refusal ?? 'unauthenticated'}${result.detail ? ` — ${result.detail}` : ''}`);
            }
            return toProgressResponse(result);
        } catch (e: any) {
            LOG.warn('WorkerReport', `Forwarded progress note for ${claimLabel} failed: ${e?.message || e}`);
            return { success: false, error: e?.message || String(e) };
        }
    },
};

export const workerReportSpecs = defineCommandSpecs('low', workerReportHandlers, {
    // Only another daemon's relay may present a forwarded report or progress
    // note (never a dashboard, the API, or a local worker MCP over IPC).
    [WORKER_REPORT_FORWARD_COMMAND]: { sources: ['mesh'] },
    [WORKER_PROGRESS_FORWARD_COMMAND]: { sources: ['mesh'] },
});
