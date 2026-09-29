// mesh_send_task — direct dispatch to a named node/session (one exit; the coordinator
// daemon decides whether it is a local send or a mesh relay), the busy-session
// admission gate, and the untargeted queue fall-through.
// Split out of mesh-tools-session.ts; re-exported there.

import {
    type MeshContext,
    commandForNode,
    buildMissionInactiveWarning,
    findNodeWithRefresh,
    hasRecentDuplicateDispatch,
    resolveMeshDispatchRoute,
    triggerMeshQueueAndReport,
    drainCoordinatorPendingEvents,
} from './mesh-tools-internal.js';
import { type MeshTaskInput, readTaskInput } from './mesh-tool-shared.js';
import {
    isIdleSessionRecord,
    isTerminalSessionRecord,
    unwrapCommandPayload,
    isWorkerTaskMode,
    readSessionRecordId,
    isMeshCoordinatorSessionRecord,
    isUnmanagedSessionRecord,
    resolveSessionProviderType,
} from './mesh-session-helpers.js';
import {
    validateMeshTaskModeRequest,
    buildMeshTaskModeViolationError,
} from '@adhdev/daemon-core';
import { IpcTransport } from '../transports/ipc.js';
import {
    getSessionMetadata,
    meshSessionCacheKey,
    meshSessionProviderMetadata,
    SESSION_PROVIDER_METADATA_TTL_MS,
} from './mesh-session-metadata.js';
import { randomUUID } from 'node:crypto';
import { resolveCoordinatorDaemonId } from './mesh-node-identity.js';
import {
    checkDirectDispatchQuotaGate,
    buildQuotaExhaustedDispatchFailure,
    buildCoordinatorP2pRelayFailure,
    resolveRemoteDispatchTarget,
    sendDirectAgentTask,
    type DirectDispatchRoute,
    type DirectDispatchTarget,
} from './mesh-remote-dispatch.js';
import { buildDirectTaskPayload, buildQueueTriggerGuidance } from './mesh-tools-internal-core.js';
import {
    queueEnqueue,
    missionQuery,
    recordLocal,
    directDispatchRecord,
    turnCancel,
} from '../ipc/turn-commands.js';
import { isMeshTaskDifficulty, MESH_TASK_DIFFICULTIES, appendWorkerProtocolFooter, readString } from '@adhdev/mesh-shared';
import {
    type MeshDeliveryMode,
    type MeshWorkQueueEntry,
    isTaskReadonly,
    isDirtyNode,
    resolveAutoFastForwardPolicy,
    isMeshNodeFreshEnoughToLaunch,
    resolveDispatchMessage,
} from '@adhdev/daemon-core';
import { readNodeRuntime } from './mesh-held-node-state.js';
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { computeIdleDispatchAckRisk, openDirectDispatchAttempt, P2P_TRANSPORT_ABSENCE_CODES, observeDirectDispatchOutcome } from './mesh-direct-dispatch-attempt.js';

type MeshSendTaskArgs = Parameters<typeof meshSendTask>[1];

/** The mesh_send_task request, validated and normalized once at the tool boundary. */
interface SendTaskRequest {
    message: string;
    taskInput: MeshTaskInput | undefined;
    readonly: boolean;
    missionId: string | undefined;
    ownedPaths: unknown[] | undefined;
    difficulty: string;
    taskMode: ReturnType<typeof validateMeshTaskModeRequest>['taskMode'];
    delivery: { mode: MeshDeliveryMode; unrecognized?: string };
    deliveryModeWarning: Record<string, unknown>;
    allowStaleNode: boolean;
    allowQuotaExhausted: boolean;
}

type AttemptRef = { attemptId: string; generation: number } | null;

/**
 * Validate the raw tool args (the dispatcher performs no runtime schema
 * validation) and normalize them once. Returns the JSON refusal as a string.
 */
async function parseSendTaskRequest(ctx: MeshContext, args: MeshSendTaskArgs): Promise<SendTaskRequest | string> {
    // DELIVERY-MSG-GUARD: make the schema's nominal `required: ['message']` real. The
    // tool dispatcher forwards raw args without runtime schema validation, so a caller
    // omitting message (or passing a non-string) would hand undefined down the direct-
    // dispatch path — buildDirectTaskPayload / recordDirectDispatchTask — and crash the
    // queue row's NOT NULL. Reject at the tool boundary.
    const message = readString(args.message);
    if (!message) {
        return JSON.stringify({
            success: false,
            code: 'invalid_message',
            error: 'mesh_send_task requires a non-empty string `message`.',
        });
    }
    // MESH-IMAGE-DISPATCH: optional structured attachment (e.g. a screenshot). Validated
    // at the tool boundary for the same reason `message` is — the dispatcher performs no
    // runtime schema validation, so a malformed envelope would otherwise surface deep in
    // the worker daemon or be dropped without a word.
    let taskInput: MeshTaskInput | undefined;
    try {
        taskInput = readTaskInput(args.input);
    } catch (e: any) {
        return JSON.stringify({
            success: false,
            code: 'invalid_input',
            error: `mesh_send_task received an unusable \`input\`: ${e?.message || e}`,
        });
    }
    const requestedTaskMode = readString(args.task_mode) || readString(args.taskMode);
    const readonly = args.readonly === true || args.read_only === true;
    // Optional mission attribution. When set, the direct-dispatched task is also
    // materialised as an assigned queue entry so it counts toward the mission's
    // task aggregates — see recordDirectDispatchTask. Absent → unattributed
    // direct dispatch.
    const missionId = readString(args.missionId) || readString(args.mission_id) || undefined;
    // H1 (path ownership): raw passthrough — normalizeOwnedPaths (daemon-side, inside
    // recordDirectDispatchTask) does the real validation/normalization; here we only
    // avoid forwarding a non-array value.
    const rawOwnedPaths = args.ownedPaths ?? args.owned_paths;
    const ownedPaths = Array.isArray(rawOwnedPaths) ? rawOwnedPaths : undefined;
    // MISSION-UPSERT-SILENT-CREATE: an unresolvable mission_id previously dispatched fine
    // and only produced silence — buildMissionInactiveWarning warns solely for a
    // KNOWN-but-inactive mission and returns undefined for an unknown id (see its own doc
    // comment), so the task landed unattributed with zero feedback. Reject at the tool
    // boundary, same convention as invalid_message/missing_difficulty.
    if (missionId && !(await missionQuery(ctx.transport, { meshId: ctx.mesh.id, id: missionId })).missions[0]) {
        return JSON.stringify({
            success: false,
            code: 'mission_not_found',
            error: `mission '${missionId}' does not exist on this mesh — refusing to dispatch a task with an unresolvable mission_id. Omit mission_id, or use mesh_mission_list to get a valid full id.`,
            missionId,
        });
    }
    // DIFFICULTY-REQUIRED: like `message` above, the schema's `required` is nominal —
    // the dispatcher forwards raw args without runtime validation. Reject at the tool
    // boundary so the caller gets a teaching error naming the field and its allowed
    // values, rather than the bare throw the daemon-core guard would raise.
    const difficultyRaw = readString(args.difficulty);
    if (!difficultyRaw || !isMeshTaskDifficulty(difficultyRaw)) {
        return JSON.stringify({
            success: false,
            code: difficultyRaw ? 'invalid_difficulty' : 'missing_difficulty',
            error: difficultyRaw
                ? `mesh_send_task received an unrecognized \`difficulty\` value '${difficultyRaw}'. Allowed: ${MESH_TASK_DIFFICULTIES.join(' | ')}.`
                : `mesh_send_task requires a \`difficulty\`. Allowed: ${MESH_TASK_DIFFICULTIES.join(' | ')}. Classify the task by how hard the work actually is.`,
            allowedDifficulties: MESH_TASK_DIFFICULTIES,
        });
    }
    // DELIVERY-MODE (both branches): normalized ONCE here so the local and the remote
    // (P2P) dispatch read the same mode, and a typo is reported on every outcome instead
    // of only on the local busy path. An unrecognized value falls back to when_idle.
    const { normalizeDeliveryMode } = await import('@adhdev/daemon-core');
    const delivery = normalizeDeliveryMode(args.delivery_mode ?? args.deliveryMode) as { mode: MeshDeliveryMode; unrecognized?: string };
    const deliveryModeWarning = delivery.unrecognized
        ? { deliveryModeWarning: `Unrecognized delivery_mode '${delivery.unrecognized}' was ignored (treated as when_idle). Valid values are 'when_idle' and 'interrupt'.` }
        : {};
    const modeValidation = validateMeshTaskModeRequest(requestedTaskMode, message, readonly);
    if (!modeValidation.valid) {
        return JSON.stringify({
            success: false,
            code: 'live_debug_readonly_guardrail_violation',
            taskMode: modeValidation.taskMode || requestedTaskMode,
            violations: modeValidation.violations,
            // GUARDRAIL-TEACHING-ERROR: match location per violation, so the caller
            // can see what tripped the guard instead of rewording blind.
            ...(modeValidation.violationDetails ? { violationDetails: modeValidation.violationDetails } : {}),
            allowedOperations: modeValidation.allowedOperations,
            error: buildMeshTaskModeViolationError(modeValidation),
        });
    }
    return {
        message,
        taskInput,
        readonly,
        missionId,
        ownedPaths,
        difficulty: difficultyRaw,
        taskMode: modeValidation.taskMode,
        delivery,
        deliveryModeWarning,
        allowStaleNode: args.allow_stale_node === true || args.allowStaleNode === true,
        // QUOTA-GATE opt-out (preview rc.43 run 10) — see checkDirectDispatchQuotaGate's
        // doc comment (mesh-remote-dispatch.ts) for what this gates and why.
        allowQuotaExhausted: args.allow_quota_exhausted === true || args.allowQuotaExhausted === true,
    };
}

/** Node-level refusals: read-only node, convergence onto a worktree, dirty/stale git. */
function checkSendTaskNodeGates(ctx: MeshContext, node: LocalMeshNodeEntry, args: MeshSendTaskArgs, req: SendTaskRequest): string | null {
    const { taskMode } = req;
    // Policy check: read-only node cannot receive tasks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
    }

    // WTDISPATCH-FANOUT: a `convergence` task lands its work onto base (merge → push →
    // cleanup) and is base-only. Refuse a direct dispatch that targets a worktree-clone
    // node, fail-closed — co-located sibling worktree sessions racing a convergence
    // push/production-deploy is exactly the 4-way fan-out the live repro hit. Mirrors the
    // queue claim guard (claimNextQueueTask) and the auto-launch eligibility filter so the
    // base-only invariant holds across every dispatch entry point.
    if (taskMode === 'convergence' && node.isLocalWorktree === true) {
        return JSON.stringify({
            success: false,
            recoverable: true,
            code: 'mesh_convergence_target_is_worktree',
            reason: 'mesh_convergence_target_is_worktree',
            nodeId: args.node_id,
            sessionId: args.session_id,
            taskMode,
            error: `Node '${args.node_id}' is a worktree clone; a convergence task is base-only (it merges/pushes onto base). Dispatching it to a worktree session risks a multi-worktree push/deploy race.`,
            nextAction: `Dispatch the convergence task to the base node for this mesh, or run the deterministic fast-forward convergence path (mesh_fast_forward_node / mesh_refine_node) instead of mesh_send_task.`,
        });
    }

    // GIT-GATE (owner-requested follow-up to H1, wiring-unification): the claim path
    // (mesh-queue-assignment.ts, daemon-side) already refuses a write claim onto a
    // dirty/stale-behind node for an ALREADY-idle session, and the auto-launch spawn
    // gate refuses it before even launching one — but a direct dispatch via
    // mesh_send_task bypassed both, since it targets a node/session explicitly and
    // never goes through either gate. Apply the SAME predicates here, fail-closed
    // unless the caller explicitly opts out with allow_stale_node (e.g. a deliberate
    // "fix the dirty tree" task). Readonly dispatches are exempt — same write-only
    // scope as the claim-path gate.
    if (req.allowStaleNode || isTaskReadonly({ readonly: req.readonly, taskMode })) return null;
    const dirty = isDirtyNode(node);
    const maxBehind = resolveAutoFastForwardPolicy(ctx.mesh).maxBehind;
    const staleBehind = !isMeshNodeFreshEnoughToLaunch(node, { maxBehind });
    if (!dirty && !staleBehind) return null;
    const behind = typeof (node as any)?.git?.behind === 'number' ? (node as any).git.behind : undefined;
    return JSON.stringify({
        success: false,
        recoverable: true,
        code: dirty ? 'dirty_workspace' : 'node_stale_behind_upstream',
        reason: dirty ? 'dirty_workspace' : 'node_stale_behind_upstream',
        nodeId: args.node_id,
        sessionId: args.session_id,
        taskMode: taskMode || 'unspecified',
        error: dirty
            ? `Node '${args.node_id}' has a dirty workspace (uncommitted changes) — refusing a non-readonly direct dispatch that could race a concurrent edit.`
            : `Node '${args.node_id}' is behind its upstream${behind !== undefined ? ` (${behind} commit(s), max ${maxBehind ?? 0})` : ''} — refusing a non-readonly direct dispatch against stale code.`,
        nextAction: `Let the node's auto fast-forward / clean-up run first, retry with a readonly task_mode, or pass allow_stale_node: true to dispatch anyway (e.g. a task whose job IS to fix the dirty/stale tree).`,
    });
}

/**
 * A named session must be a visible, mesh-managed worker. A coordinator session
 * is refused; an unmanaged one (no meshNodeFor / meshCoordinatorFor /
 * launchedByCoordinator) could be the coordinator's own session or an unrelated
 * one — its completion events would never reach the coordinator ledger, and
 * dispatching risks self-send. Returns the refusal, or null for a worker.
 */
function refuseNonWorkerSession(
    args: MeshSendTaskArgs,
    taskMode: SendTaskRequest['taskMode'],
    session: any,
    unmanagedExtra: Record<string, unknown> = {},
): string | null {
    if (isMeshCoordinatorSessionRecord(session)) {
        return JSON.stringify({
            success: false,
            recoverable: true,
            code: 'mesh_target_session_is_coordinator',
            reason: 'mesh_target_session_is_coordinator',
            nodeId: args.node_id,
            sessionId: args.session_id,
            taskMode: taskMode || 'unspecified',
            error: `Session '${args.session_id}' is a Repo Mesh coordinator session, not a visible worker session. Launch or use a visible worker session before dispatching this task.`,
            nextAction: `Call mesh_launch_session for node '${args.node_id}' and then retry mesh_send_task with that worker session_id, or use mesh_enqueue_task for queue-based worker assignment.`,
        });
    }
    if (isUnmanagedSessionRecord(session)) {
        return JSON.stringify({
            success: false,
            recoverable: true,
            code: 'mesh_target_session_unmanaged',
            reason: 'mesh_target_session_unmanaged',
            nodeId: args.node_id,
            sessionId: args.session_id,
            taskMode: taskMode || 'unspecified',
            unsafeTranscriptAlias: true,
            ...unmanagedExtra,
            error: `Session '${args.session_id}' on node '${args.node_id}' has no Repo Mesh delegation metadata (missing meshNodeFor/meshCoordinatorFor/launchedByCoordinator). It may be the coordinator's own session or an unrelated session — dispatching risks self-send and orphaned completion events that never reach the coordinator ledger.`,
            nextAction: `Call mesh_launch_session for node '${args.node_id}' to start a fresh managed worker session, then retry mesh_send_task with the returned session_id. Alternatively use mesh_enqueue_task for queue-based assignment without specifying session_id.`,
        });
    }
    return null;
}

/**
 * The explicitly named session as the coordinator daemon holds it (worker task
 * modes only), refusing a coordinator / unmanaged target. A lookup failure
 * leaves the session unknown.
 */
async function resolveExplicitWorkerSession(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: MeshSendTaskArgs,
    req: SendTaskRequest,
): Promise<{ session: any | undefined } | string> {
    if (!args.session_id || !isWorkerTaskMode(req.taskMode, req.readonly)) return { session: undefined };
    try {
        // The node's runtime, as the coordinator daemon answers it (readNodeRuntime).
        const { probe } = await readNodeRuntime(ctx, node);
        const session = probe.sessions.find(s => readSessionRecordId(s) === args.session_id);
        if (session) {
            const refusal = refuseNonWorkerSession(args, req.taskMode, session);
            if (refusal) return refusal;
        }
        return { session };
    } catch {
        return { session: undefined };
    }
}

/** A pinned queue row for this send (busy-session exits and the untargeted pull). */
async function enqueueSendTask(ctx: MeshContext, args: MeshSendTaskArgs, req: SendTaskRequest): Promise<MeshWorkQueueEntry> {
    const { taskInput, readonly, missionId, ownedPaths } = req;
    return (await queueEnqueue(ctx.transport, { meshId: ctx.mesh.id, message: req.message, options: {
        targetNodeId: args.node_id,
        targetSessionId: args.session_id,
        taskMode: req.taskMode,
        difficulty: req.difficulty,
        // MESH-IMAGE-DISPATCH: the queued task carries the same envelope the direct
        // dispatch forwards — the claim dispatch delivers it.
        ...(taskInput ? { input: taskInput } : {}),
        ...(readonly ? { readonly: true } : {}),
        ...(missionId ? { missionId } : {}),
        ...(ownedPaths ? { ownedPaths } : {}),
        // COORD-EVENT-MISROUTE (anchor preservation): stamp the originating coordinator
        // SESSION anchor exactly as meshEnqueueTask does (mesh-tools-queue.ts). Without it
        // the queued task carries no sourceCoordinatorSessionId, so at claim time
        // targetCoordinatorSessionId is empty (mesh-queue-assignment.ts) and the completion
        // loses its session anchor — falling back to daemon-level fan-out across every
        // local coordinator instead of routing back to the coordinator session that issued it.
        ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
    } })).entry as unknown as MeshWorkQueueEntry;
}

/**
 * The ONE admission gate for a `mesh_send_task` that names an explicit session
 * (`session_id`) — shared by the LOCAL and the REMOTE (P2P) branch so the two cannot
 * drift (preview rc.37: the remote branch had no gate at all and sent
 * `agent_command send_chat policy:queue` into a generating worker, where the body ran as
 * an unaccounted turn 2 and the worker's mesh stamp was overwritten).
 *
 * Only runs when the session is live and NOT idle and NOT terminal. Returns the JSON
 * response for a refused / queued / interrupted-and-queued delivery, or null when the
 * caller should go on to dispatch directly (the decision was `immediate`, or the
 * status is unrecognised — the historical local fall-through, kept identical here).
 * Nothing is sent to the session's input on any non-null outcome: a busy session only
 * ever receives the task through the pinned queue row's claim, which opens the
 * turn-ledger attempt before the body is written.
 */
async function admitExplicitSessionDelivery(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: MeshSendTaskArgs,
    req: SendTaskRequest,
    session: any,
    providerType: string,
): Promise<string | null> {
    if (!session || isIdleSessionRecord(session) || isTerminalSessionRecord(session)) return null;
    const { taskMode, missionId } = req;
    const sessionStatus = typeof session?.status === 'string' ? session.status : 'unknown';
    const { resolveDeliveryDecision } = await import('@adhdev/daemon-core');
    const { mode: deliveryMode, unrecognized: unrecognizedDeliveryMode } = req.delivery;
    const agentCommand = (action: string, extra: Record<string, unknown> = {}) => commandForNode(ctx, node, 'agent_command', {
        targetSessionId: args.session_id,
        agentType: providerType,
        cliType: providerType,
        providerType: providerType,
        action,
        ...extra,
    });
    // Probe the target provider's interrupt capability from its live spec.
    // Only needed when the caller actually asked to interrupt.
    let interruptSupported = false;
    let interruptUnsupportedMessage: string | undefined;
    let interruptConfidence: string | undefined;
    if (deliveryMode === 'interrupt') {
        try {
            const probe = unwrapCommandPayload(await agentCommand('interrupt_capability'));
            interruptSupported = probe?.supported === true;
            interruptUnsupportedMessage = typeof probe?.message === 'string' ? probe.message : undefined;
            interruptConfidence = typeof probe?.confidence === 'string' ? probe.confidence : undefined;
        } catch (e: any) {
            // Probe failure is NOT treated as "supported" — fail closed, and say why.
            interruptSupported = false;
            interruptUnsupportedMessage = `Could not determine interrupt capability for provider '${providerType}' on node '${args.node_id}': ${e?.message || e}. `
                + 'Refusing to interrupt on an unverified capability.';
        }
    }
    const policyResult = resolveDeliveryDecision(sessionStatus, {
        kind: 'task',
        deliveryMode,
        interruptSupported,
        ...(interruptUnsupportedMessage ? { interruptUnsupportedMessage } : {}),
    });
    // ── interrupt requested but the provider cannot ──────────────────
    // Reported as an explicit failure. We do NOT fall through to the queued
    // branch: the caller asked to change a running session's trajectory, and
    // silently delivering after the current turn completes is a materially
    // different outcome that must not be reported as success.
    if (policyResult.decision === 'rejected' && policyResult.reason === 'interrupt_unsupported_for_provider') {
        return JSON.stringify({
            success: false,
            dispatched: false,
            decision: 'interrupt_unsupported',
            reason: policyResult.reason,
            nodeId: args.node_id,
            sessionId: args.session_id,
            sessionStatus,
            providerType: providerType,
            requestedDeliveryMode: deliveryMode,
            message: policyResult.message,
            nextAction: `Re-send this task with delivery_mode 'when_idle' to have it delivered when session '${args.session_id}' finishes on its own, `
                + 'or stop the session and launch a fresh one if the in-flight work must not complete.',
        });
    }
    // ── interrupt: abort the running turn, then let the queued-delivery
    //    funnel deliver the task on the session's idle transition ──────
    if (policyResult.decision === 'interrupt') {
        const interruptResult = unwrapCommandPayload(await agentCommand('interrupt_turn', {
            dispatchSource: 'mesh-tools-session:mesh_send_task:interrupt',
        }));
        if (interruptResult?.success !== true || interruptResult?.interrupted !== true) {
            // The stop key did not go out. Report the failure — do NOT queue
            // behind a turn the caller explicitly wanted cancelled.
            return JSON.stringify({
                success: false,
                dispatched: false,
                decision: 'interrupt_failed',
                reason: interruptResult?.reason || 'interrupt_rejected',
                nodeId: args.node_id,
                sessionId: args.session_id,
                sessionStatus,
                providerType: providerType,
                error: interruptResult?.error || 'The provider did not accept the interrupt.',
                nextAction: `Nothing was cancelled and nothing was delivered. Re-send with delivery_mode 'when_idle', `
                    + 'or inspect the session with mesh_read_terminal before retrying.',
            });
        }
        // The turn is cancelled. Deliver via the SAME pinned-queue funnel the
        // when_idle path uses (enqueueTask + the existing idle-transition
        // claim), rather than writing the prompt now: the TUI needs a moment
        // to unwind the aborted turn and repaint an idle prompt, and only the
        // FSM knows when that has actually happened. Reusing the funnel means
        // no new injection path and no bypass of the PTY send gate.
        const interruptedTask = await enqueueSendTask(ctx, args, req);
        return JSON.stringify({
            success: true,
            dispatched: false,
            decision: 'interrupted_and_queued',
            taskId: interruptedTask.id,
            reason: policyResult.reason,
            nodeId: args.node_id,
            sessionId: args.session_id,
            sessionStatus,
            providerType: providerType,
            taskMode: taskMode || undefined,
            interrupt: {
                sent: true,
                key: interruptResult?.keyName,
                // 'declared' means the stop key is declared by the spec but the
                // busy->idle effect was not measured live for this provider.
                confidence: interruptResult?.confidence || interruptConfidence || 'declared',
            },
            turnDiscarded: true,
            message: `Interrupted the in-flight turn on session '${args.session_id}' via ${interruptResult?.keyName || 'the stop control'}. `
                + 'That turn was cancelled and its unfinished work is lost. '
                + `Task '${interruptedTask.id}' is pinned to this session and delivers as soon as it reports idle.`,
            nextAction: interruptResult?.confidence === 'proven'
                ? `Track with mesh_status; no manual resend needed.`
                : `Interrupt support for '${providerType}' is DECLARED by its spec but not live-verified. `
                    + 'Confirm with mesh_status that the session returned to idle and picked up the task; if it did not, use mesh_read_terminal to inspect.',
            ...(unrecognizedDeliveryMode ? { deliveryModeWarning: `Unrecognized delivery_mode '${unrecognizedDeliveryMode}' ignored.` } : {}),
            ...((await buildMissionInactiveWarning(ctx, missionId)) ?? {}),
        });
    }
    if (policyResult.decision === 'queued') {
        // RC17-QUEUED-DELIVERY-STRANDED: this branch used to create a standalone
        // SessionDelivery row (status:'queued') and hand the caller a deliveryId to
        // poll. Nothing ever re-drove that row — the queue-claim funnel
        // (tryAssignQueueTask, wired to fire automatically on the session's idle
        // transition in mesh-event-forwarding.ts) only claims rows created via
        // enqueueTask/claimNextTask, so a busy session that went idle left the
        // delivery permanently stuck at 'queued'.
        //
        // The task is enqueued with targetNodeId/targetSessionId pinned to this exact
        // node+session. claimNextTask's candidate query (mesh-runtime-store.ts) filters
        // strictly on targetSessionId equivalence, so only this session can claim it,
        // and the existing agent:generating_completed / agent:ready handlers call
        // tryAssignQueueTask the moment this session goes idle — no new dispatch
        // path, no new idle-transition wiring.
        const queuedTask = await enqueueSendTask(ctx, args, req);
        return JSON.stringify({
            success: true,
            dispatched: false,
            decision: 'queued_delivery',
            taskId: queuedTask.id,
            reason: policyResult.reason,
            nodeId: args.node_id,
            sessionId: args.session_id,
            sessionStatus,
            taskMode: taskMode || undefined,
            message: policyResult.message,
            nextAction: `Task '${queuedTask.id}' is queued and pinned to session '${args.session_id}' — it auto-delivers the moment the session goes idle. Use mesh_status or mesh_task_history to track it; no manual resend needed.`,
            // A misspelled delivery_mode silently became when_idle. Say so — a
            // caller who meant to interrupt must not read this queued result as
            // "my steering landed".
            ...(unrecognizedDeliveryMode
                ? {
                    deliveryModeWarning: `Unrecognized delivery_mode '${unrecognizedDeliveryMode}' was ignored; this task was queued (when_idle) and the running turn was NOT interrupted. `
                        + "Valid values are 'when_idle' and 'interrupt'.",
                }
                : {}),
            ...((await buildMissionInactiveWarning(ctx, missionId)) ?? {}),
        });
    }
    return null;
}

/**
 * F1: materialize the worker-protocol footer (and any relevant handoff notes)
 * onto the DISPATCHED body only — the ledger/dispatch rows keep the authored
 * `message`.
 *
 * MULTIPART-FOOTER-PARITY: when the attachment envelope carries its own text
 * part, the provider may render the parts and never look at `message` — the
 * footer must land there too, or the worker never learns the protocol on an
 * image-attached dispatch. appendWorkerProtocolFooter is idempotent, so this is
 * safe even if the text part already carries the marker.
 */
function buildWorkerDispatchBody(ctx: MeshContext, node: LocalMeshNodeEntry, taskId: string, req: SendTaskRequest): { body: string; input: MeshTaskInput | undefined } {
    const { message, taskMode, difficulty, readonly, missionId, taskInput } = req;
    const body = resolveDispatchMessage(
        {
            id: taskId, message, taskMode, difficulty,
            ...(readonly ? { readonly: true } : {}),
            ...(missionId ? { missionId } : {}),
        },
        ctx.mesh.id,
        node,
    );
    const input = taskInput && Array.isArray(taskInput.parts)
        ? {
            ...taskInput,
            parts: taskInput.parts.map(part =>
                part && typeof part === 'object' && part.type === 'text' && typeof (part as any).text === 'string'
                    ? { ...part, text: appendWorkerProtocolFooter((part as any).text, { taskId, taskMode, difficulty, readonly }) }
                    : part,
            ),
        }
        : taskInput;
    return { body, input };
}

/**
 * The meshContext stamped on the dispatch. The daemon attaches it to the target
 * instance BEFORE prompt injection (setupMeshEventForwarding reads
 * meshNodeFor + meshActiveTaskId to route completion events back);
 * coordinatorDaemonId routes the completion to the right coordinator queue, the
 * coordinator session anchor to THIS coordinator session (multi-coordinator),
 * and the turn-ledger attempt ref (C-W6c) resolves the worker's evidence
 * (forwarded completion, session_error, …) to this attempt.
 */
function buildDispatchMeshContext(ctx: MeshContext, nodeId: string, taskId: string, coordinatorDaemonId: string | undefined, attemptRef: AttemptRef) {
    return {
        meshId: ctx.mesh.id,
        nodeId,
        taskId,
        ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
        ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
        ...(attemptRef ? { attemptId: attemptRef.attemptId, attemptGeneration: attemptRef.generation } : {}),
    };
}

/** The `task_dispatched` ledger record of a direct dispatch. */
async function recordTaskDispatched(
    ctx: MeshContext,
    req: SendTaskRequest,
    p: { via: 'p2p_direct' | 'local_direct'; taskId: string; nodeId: string; sessionId: string | undefined; providerType: string | undefined; coordinatorDaemonId: string | undefined; dispatchedToIdleSession?: boolean },
): Promise<void> {
    await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
        kind: 'task_dispatched',
        nodeId: p.nodeId,
        sessionId: p.sessionId,
        providerType: p.providerType,
        payload: buildDirectTaskPayload(req.message, p.via, {
            taskId: p.taskId,
            taskMode: req.taskMode,
            providerType: p.providerType,
            targetSessionId: p.sessionId,
            ...(p.dispatchedToIdleSession !== undefined ? { dispatchedToIdleSession: p.dispatchedToIdleSession } : {}),
            ...(p.nodeId ? { selectedNodeId: p.nodeId } : {}),
            ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
            // COORD-EVENT-MISROUTE: persist the dispatching coordinator daemon anchor (same
            // value stamped into meshContext) so a transcript-reconcile synth recovers it
            // from the ledger instead of the worker's own self-daemon.
            ...(p.coordinatorDaemonId ? { coordinatorDaemonId: p.coordinatorDaemonId } : {}),
        }),
    });
}

/**
 * MISSIONLESS-DIRECT-DISPATCH-NO-ATTEMPT: written unconditionally — the
 * materialised row carries the turn-ledger attempt opened before the send
 * (C-W8: the attempt, not this call, is what makes the completion
 * reducer-authoritative); missionId only affects mission attribution. C-W9a: the
 * task row is written by the daemon (`direct_dispatch_record`), called only
 * AFTER the dispatch is known to have succeeded.
 */
async function recordDirectDispatch(
    ctx: MeshContext,
    req: SendTaskRequest,
    p: { via: 'p2p_direct' | 'local_direct'; taskId: string; nodeId: string; sessionId: string | undefined; dispatchedAt: string; attemptRef: AttemptRef },
): Promise<void> {
    const { missionId, ownedPaths, readonly } = req;
    await directDispatchRecord(ctx.transport, {
        meshId: ctx.mesh.id,
        taskId: p.taskId,
        message: req.message,
        task: {
            ...(missionId ? { missionId } : {}),
            ...(ownedPaths ? { ownedPaths } : {}),
            assignedNodeId: p.nodeId,
            assignedSessionId: p.sessionId,
            taskMode: req.taskMode,
            difficulty: req.difficulty,
            ...(readonly ? { readonly: true } : {}),
            dispatchedAt: p.dispatchedAt,
            ...(p.attemptRef ? { attemptId: p.attemptRef.attemptId } : {}),
        },
    });
}

/**
 * The explicitly targeted LOCAL session's provider (cache → held runtime), with
 * the coordinator/unmanaged refusals applied for every task mode — the early
 * validation only runs for worker task modes (it excludes live_debug_readonly),
 * so no task mode bypasses them here.
 */
async function resolveLocalTargetProviderType(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: MeshSendTaskArgs & { session_id: string },
    req: SendTaskRequest,
    explicitTargetSession: any,
): Promise<{ providerType: string } | string> {
    const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
    let providerType = cached?.providerType || '';
    if (!providerType) {
        let explicitSession = explicitTargetSession;
        if (!explicitSession) {
            const { probe } = await readNodeRuntime(ctx, node);
            explicitSession = probe.sessions.find(session => readSessionRecordId(session) === args.session_id);
        }
        if (!explicitSession) {
            return JSON.stringify({
                success: false,
                recoverable: true,
                code: 'mesh_target_session_not_found',
                reason: 'mesh_target_session_not_found',
                transport: 'local_ipc',
                retryRecommended: true,
                nodeId: args.node_id,
                sessionId: args.session_id,
                error: `Local session '${args.session_id}' is not present in live status for node '${args.node_id}'.`,
                nextAction: `Launch a fresh session with mesh_launch_session(node_id: '${args.node_id}') or retry without session_id so Repo Mesh can target a live delegate session.`,
            });
        }
        const refusal = refuseNonWorkerSession(args, req.taskMode, explicitSession, { unsafeDelegateTarget: true });
        if (refusal) return refusal;
        providerType = resolveSessionProviderType(explicitSession);
        if (providerType) {
            meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, args.session_id), {
                providerType,
                providerSessionId: readString(explicitSession?.providerSessionId) || undefined,
                expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
            });
        }
    }
    if (!providerType) {
        return JSON.stringify({
            success: false,
            recoverable: true,
            code: 'mesh_target_session_provider_unknown',
            reason: 'mesh_target_session_provider_unknown',
            transport: 'local_ipc',
            retryRecommended: false,
            nodeId: args.node_id,
            sessionId: args.session_id,
            error: `Local session '${args.session_id}' is live but does not expose providerType/cliType, so agent_command cannot be routed safely.`,
            nextAction: `Relaunch the target session on node '${args.node_id}' or retry without session_id so Repo Mesh can pick a session with provider metadata.`,
        });
    }
    return { providerType };
}

/**
 * The target of a direct dispatch on the route the coordinator daemon chose.
 * local — the explicitly named session this daemon serves (provider from the cache
 * or held runtime, coordinator/unmanaged refusals, then the quota gate).
 * remote — the owning daemon's session, verified or auto-picked from the held
 * runtime (resolveRemoteDispatchTarget: provider pin, relay safety, quota gate).
 * Returns the JSON refusal as a string.
 */
async function resolveDirectDispatchTarget(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    route: DirectDispatchRoute,
    args: MeshSendTaskArgs,
    req: SendTaskRequest,
    explicitTargetSession: any,
): Promise<DirectDispatchTarget | string> {
    if (route === 'remote') {
        const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id || ''));
        const target = await resolveRemoteDispatchTarget(ctx, node, {
            session_id: args.session_id,
            providerType: cached?.providerType,
            verifiedSession: explicitTargetSession,
            coordinatorDaemonId: resolveCoordinatorDaemonId(ctx),
            allowQuotaExhausted: req.allowQuotaExhausted,
        });
        return 'success' in target ? JSON.stringify(target) : target;
    }
    const sessionId = args.session_id!;
    const resolved = await resolveLocalTargetProviderType(ctx, node, { ...args, session_id: sessionId }, req, explicitTargetSession);
    if (typeof resolved === 'string') return resolved;
    // QUOTA GATE (direct dispatch, local session) — preview rc.43 run 10: see
    // checkDirectDispatchQuotaGate's doc comment (mesh-remote-dispatch.ts). This is
    // the exact case that motivated the fix — a LOCAL explicit session_id dispatch
    // to a MainPC worker whose provider had already reported "session limit" — so
    // it is checked as early as the provider is known, before the delivery
    // admission gate and before anything is sent.
    if (!req.allowQuotaExhausted) {
        const quotaGate = checkDirectDispatchQuotaGate(node, resolved.providerType, ctx.mesh.policy?.quotaRouting ?? null);
        if (quotaGate) {
            return JSON.stringify(buildQuotaExhaustedDispatchFailure(node, resolved.providerType, sessionId, quotaGate));
        }
    }
    return { sessionId, providerType: resolved.providerType };
}

/**
 * THE direct dispatch of mesh_send_task. The coordinator daemon has already chosen
 * the route (mesh_dispatch_route); everything after the target resolution is one
 * sequence on both routes:
 *
 *   admission gate (a named busy session is queued / interrupted, never injected)
 *   → open the mesh_direct turn-ledger attempt and pre-record task_dispatched
 *   → ONE agent_command send_chat (sendDirectAgentTask — local command surface or
 *     mesh relay, per the route)
 *   → delivered / dispatch_failed against the attempt, and the dispatch row.
 *
 * CANON-A (direct-dispatch completion race — root fix): the dispatch row (the
 * task_dispatched ledger record + the mesh_direct attempt, C-W8) is written ★BEFORE
 * the send, exactly as the enqueue→claim path claims the queue row 'assigned' before
 * delivering. A FAST direct dispatch to an already-idle, reused session could
 * otherwise have its genuine completion reach the coordinator forwarder BEFORE the
 * row existed → sessionHasActiveAssignment=false → the prior-terminal
 * providerSessionId dedup (mesh-event-forwarding.ts) swallowed the new task's
 * completion as a duplicate of the prior turn.
 */
async function dispatchSendTaskDirect(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    route: DirectDispatchRoute,
    args: MeshSendTaskArgs,
    req: SendTaskRequest,
    explicitTargetSession: any,
): Promise<string> {
    const target = await resolveDirectDispatchTarget(ctx, node, route, args, req, explicitTargetSession);
    if (typeof target === 'string') return target;
    // BUSY-SESSION GATE: an explicit target session that is live and busy gets the
    // admission decision — queued_delivery / interrupted_and_queued /
    // interrupt_unsupported / interrupt_failed — BEFORE any attempt is opened and
    // before anything is sent (preview rc.37: sending `agent_command send_chat` into a
    // generating worker ran the body as an unaccounted turn 2).
    if (args.session_id) {
        const admission = await admitExplicitSessionDelivery(ctx, node, args, req, explicitTargetSession, target.providerType);
        if (admission !== null) return admission;
    }

    const via = route === 'remote' ? 'p2p_direct' as const : 'local_direct' as const;
    // Whether the session was idle at dispatch time: an idle session that receives the
    // send should transition to generating; recorded for stale detection and surfaced
    // as dispatchAcknowledgementRisk when the dispatch row did not pre-record.
    const sessionWasIdle = explicitTargetSession ? isIdleSessionRecord(explicitTargetSession) : false;
    const taskId = randomUUID();
    const dispatchedAt = new Date().toISOString();
    const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
    try {
        await recordTaskDispatched(ctx, req, {
            via, taskId, nodeId: args.node_id, sessionId: target.sessionId || undefined,
            providerType: target.providerType, coordinatorDaemonId,
            ...(explicitTargetSession ? { dispatchedToIdleSession: sessionWasIdle } : {}),
        });
    } catch { /* best-effort */ }
    const dispatch = buildWorkerDispatchBody(ctx, node, taskId, req);
    // C-W6c: open the attempt in the NEW turn ledger (C1 reducer) BEFORE the send, so
    // its attemptRef rides in meshContext — the worker's cli-manager.ts echoes
    // meshContext.attemptId/attemptGeneration onto its turn evidence. A sessionless
    // dispatch does not know its session yet, so the taskId stands in: the reducer
    // keys dispatch_accepted's attempt off `${scope}:${eventId}`, not off sessionId.
    const attemptRef = await openDirectDispatchAttempt(ctx, {
        taskId,
        nodeId: args.node_id,
        sessionId: target.sessionId || taskId,
        providerType: target.providerType,
    });
    // DISPATCH-ACK-RISK-STALE (C-W8): the open mesh_direct attempt IS the pre-recorded
    // dispatch row — it is what sessionHasActiveAssignment keys on at completion time,
    // so the prior-terminal dedup gate is skipped. A genuine residual risk remains
    // only if it did not open.
    const dispatchPreRecorded = attemptRef !== null;
    const result = await sendDirectAgentTask(ctx, node, route, target, {
        message: dispatch.body,
        ...(dispatch.input ? { input: dispatch.input } : {}),
        // D2: the task id IS this dispatch's message identity (the mesh_direct attempt
        // records the same), so a retried send is ONE message to the worker's funnel.
        // The admission gate above routed every busy-session outcome through the
        // pinned queue, so what reaches here is an idle target or a sessionless
        // auto-pick (idle sessions only): plain `queue`.
        messageId: taskId,
        policy: { mode: 'queue' },
        origin: 'mcp',
        meshContext: buildDispatchMeshContext(ctx, args.node_id, taskId, coordinatorDaemonId, attemptRef),
    });

    if (!result.success) {
        // `result` carries the worker's own `{code, error}` answer whenever the worker
        // WAS reached and refused (session_busy_with_task, mesh_sender_not_on_roster,
        // mesh_node_bootstrap_pending, provider_quota_exhausted, …); only the P2P
        // transport-absence codes mean it was never reached at all.
        const failureCode = readString((result as { code?: unknown }).code);
        const workerAbsent = !!failureCode && P2P_TRANSPORT_ABSENCE_CODES.has(failureCode);
        const failureDetail = readString(result.error);
        await observeDirectDispatchOutcome(ctx, attemptRef, {
            taskId, sessionId: target.sessionId || taskId, outcome: 'dispatch_failed', workerAbsent,
            ...(!workerAbsent && failureCode ? { refusalCode: failureCode } : {}),
            // Local-only (never sent as ledger evidence — see observeDirectDispatchOutcome):
            // capped so a verbose transport/provider error message cannot grow the owner's
            // WARN log unboundedly.
            ...(failureDetail ? { refusalDetail: failureDetail.slice(0, 200) } : {}),
            nodeId: args.node_id,
        });
        // C-W8: a mesh_direct attempt has no dispatcher to re-deliver its reclaimed
        // generation, so close it (intentional_cleanup: bookkeeping only, no session
        // side effect) — leaving it would mask a genuinely-unrelated later idle as an
        // active assignment. The task_dispatched ledger record stays (append-only).
        if (attemptRef) {
            try { await turnCancel(ctx.transport, { attemptId: attemptRef.attemptId, reason: 'intentional_cleanup' }); } catch { /* best-effort */ }
        }
        return JSON.stringify({
            ...result,
            success: false,
            dispatched: false,
            nodeId: args.node_id,
            ...(args.session_id ? { sessionId: args.session_id } : {}),
            taskMode: req.taskMode,
            ...req.deliveryModeWarning,
        });
    }

    // C-W6c: the send was accepted — record the delivery against the attempt opened
    // before it, then materialise the dispatch row (C-W8: the attempt is the ONLY
    // attempt; the worker-MCP token was minted daemon-side when the ledger opened it).
    await observeDirectDispatchOutcome(ctx, attemptRef, {
        taskId, sessionId: result.sessionId || taskId, outcome: 'delivered', via: route === 'remote' ? 'p2p' : 'local',
    });
    try {
        await recordDirectDispatch(ctx, req, {
            via, taskId, nodeId: args.node_id, sessionId: result.sessionId || undefined, dispatchedAt, attemptRef,
        });
    } catch { /* best-effort */ }
    return JSON.stringify({
        success: true,
        dispatched: true,
        decision: 'immediate',
        source: 'direct',
        taskId,
        // C-W8: the trackable delivery handle is the turn-ledger attempt.
        ...(attemptRef ? { attemptId: attemptRef.attemptId } : {}),
        taskMode: req.taskMode,
        providerType: result.providerType,
        nodeId: args.node_id,
        sessionId: result.sessionId,
        // DISPATCH-ACK-RISK-STALE: only warn on a GENUINE residual loss risk — an idle
        // session whose dispatch row did NOT survive pre-record.
        ...(result.sessionId ? computeIdleDispatchAckRisk(sessionWasIdle, dispatchPreRecorded, result.sessionId) : {}),
        ...((await buildMissionInactiveWarning(ctx, req.missionId)) ?? {}),
        ...req.deliveryModeWarning,
    });
}

/** Untargeted local task: the queue pull. */
async function enqueueUntargetedSendTask(ctx: MeshContext, args: MeshSendTaskArgs, req: SendTaskRequest): Promise<string> {
    const task = await enqueueSendTask(ctx, args, req);
    const queueTrigger = await triggerMeshQueueAndReport(ctx);
    // Also drain any pending coordinator events so the caller sees them inline
    const pendingEvents = await drainCoordinatorPendingEvents(ctx);
    const result: Record<string, unknown> = {
        success: true,
        source: 'queue',
        nodeId: args.node_id,
        taskId: task.id,
        status: task.status,
        taskMode: task.taskMode,
        queueTrigger,
        ...buildQueueTriggerGuidance(queueTrigger),
        ...((await buildMissionInactiveWarning(ctx, req.missionId)) ?? {}),
        ...req.deliveryModeWarning,
    };
    if (pendingEvents.length > 0) {
        result.pendingCoordinatorEvents = pendingEvents;
    }
    return JSON.stringify(result);
}

export async function meshSendTask(
    ctx: MeshContext,
    args: {
        node_id: string; session_id?: string; message: string;
        /** MESH-IMAGE-DISPATCH: optional multipart attachment delivered with `message`. */
        input?: unknown;
        task_mode?: string; taskMode?: string;
        readonly?: boolean; read_only?: boolean;
        mission_id?: string; missionId?: string;
        /** H1 (path ownership) — see mesh-work-queue.ts MeshEnqueueTaskOptions.ownedPaths doc. */
        owned_paths?: unknown; ownedPaths?: unknown;
        difficulty?: string;
        delivery_mode?: string; deliveryMode?: string;
        /** GIT-GATE: opt out of the dirty/stale-behind refusal for a non-readonly direct dispatch. */
        allow_stale_node?: boolean; allowStaleNode?: boolean;
        /** QUOTA-GATE: opt out of the quota-exhausted refusal for a direct dispatch. */
        allow_quota_exhausted?: boolean; allowQuotaExhausted?: boolean;
    },
): Promise<string> {
    const req = await parseSendTaskRequest(ctx, args);
    if (typeof req === 'string') return req;
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const nodeRefusal = checkSendTaskNodeGates(ctx, node, args, req);
    if (nodeRefusal) return nodeRefusal;
    const target = await resolveExplicitWorkerSession(ctx, node, args, req);
    if (typeof target === 'string') return target;
    const explicitTargetSession = target.session;

    // Avoid duplicate side effects when an MCP/tool call is interrupted after
    // the daemon already accepted the send and the coordinator retries the
    // exact same node/session/message immediately.
    const duplicate = await hasRecentDuplicateDispatch(ctx, args);
    if (duplicate.duplicate) {
        return JSON.stringify({
            success: true,
            duplicate: true,
            dispatched: false,
            warning: 'Duplicate mesh_send_task suppressed: the same node/session/message was dispatched recently.',
            nodeId: args.node_id,
            sessionId: args.session_id,
            source: duplicate.source,
            previousDispatch: duplicate.entry ? {
                id: duplicate.entry.id,
                timestamp: duplicate.entry.timestamp || duplicate.entry.updatedAt || duplicate.entry.createdAt,
                nodeId: duplicate.entry.nodeId || duplicate.entry.targetNodeId || duplicate.entry.assignedNodeId,
                sessionId: duplicate.entry.sessionId || duplicate.entry.targetSessionId || duplicate.entry.assignedSessionId,
            } : undefined,
        });
    }

    try {
        // ── The coordinator daemon decides the route (MCP asks, daemon decides) ─
        //
        // `mesh_dispatch_route` (daemon-core mesh-status-view.ts) answers from the
        // coordinator's roster and its own identity: `remote` = another daemon owns
        // the node's checkout; `local` = this daemon serves it; `unreachable` = owned
        // elsewhere with no mesh channel.
        const route = await resolveMeshDispatchRoute(ctx, args.node_id);
        if (route.route === 'unreachable' || route.route === 'error') {
            return JSON.stringify({
                success: false,
                code: route.route === 'unreachable' ? 'mesh_node_unreachable' : 'mesh_dispatch_route_unavailable',
                nodeId: args.node_id,
                ...(args.session_id ? { sessionId: args.session_id } : {}),
                taskMode: req.taskMode || 'unspecified',
                error: route.route === 'unreachable'
                    ? `Node '${args.node_id}' is served by another daemon and the coordinator daemon has no mesh channel to it (${route.reason}).`
                    : `The coordinator daemon could not decide how to reach node '${args.node_id}': ${route.reason}`,
            });
        }
        // One direct exit for both routes; only an untargeted send to a node this daemon
        // serves falls through to the queue pull (the local claim picks the session).
        const directRoute: DirectDispatchRoute | null = route.route === 'remote' && ctx.transport instanceof IpcTransport
            ? 'remote'
            : args.session_id ? 'local' : null;
        if (directRoute) return await dispatchSendTaskDirect(ctx, node, directRoute, args, req, explicitTargetSession);
        return await enqueueUntargetedSendTask(ctx, args, req);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'mesh_send_task',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
            sessionId: args.session_id,
        });
        return JSON.stringify(failure);
    }
}
