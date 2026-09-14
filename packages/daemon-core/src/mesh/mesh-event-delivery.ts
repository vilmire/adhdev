// ---------------------------------------------------------------------------
// Coordinator-side delivery predicates + the event-driven idle/busy drain.
//
// Pure move out of mesh-event-forwarding.ts (file-size gate decomposition,
// mission B1 — that file sat 4 lines under the 2,400 threshold with the repo's
// highest churn, so the next ordinary feature commit would have tripped
// `new-oversize`). No logic changed: every function below is byte-identical to
// the version that lived in mesh-event-forwarding.ts, and the parent re-exports
// the public ones so no importer moves.
//
// This module is a LEAF with respect to its parent: nothing here calls back into
// mesh-event-forwarding.ts, which is what makes the split acyclic (the same
// layering rule the A-4 split recorded in mesh-events-coordinator.ts). The two
// forward-handling functions that DO call back (handleMeshForwardEvent and
// forwardUnresolvedDelegateEvent) deliberately stayed behind.
// ---------------------------------------------------------------------------
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getMachineId } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import {
    drainPendingMeshCoordinatorEvents,
    requeueDrainedPendingMeshCoordinatorEvent,
    type PendingMeshCoordinatorEvent,
} from './mesh-events-pending.js';
import type { ProviderInstance } from '../providers/provider-instance.js';
import { readNonEmptyString, readWorkerResultMetadata } from './mesh-events-utils.js';
import { shouldForceInjectMeshEvent } from './mesh-event-classify.js';
import { AUTO_LAUNCH_AWAIT_CLAIM_MS } from './mesh-queue-assignment.js';
import { injectPendingIntoCoordinator } from './mesh-reconcile-coordinator-drain.js';
import { meshNodeIdMatches, expandDaemonIdForms, sessionIdsEquivalent, type MeshNodeIdentified } from '@adhdev/mesh-shared';

/**
 * NOTIF-IMMEDIACY: size ceiling for the Tier 2 mid-generation split write.
 *
 * ★ Deliberately DUPLICATED here rather than imported from
 * providers/spec/submit-policy.ts (`MID_GENERATION_MAX_BODY_CHARS`): `mesh/**`
 * must not value-import `providers/**` (enforced by check:boundaries, and this
 * file is not in the frozen baseline). The value is a policy threshold, not a
 * behavioural coupling — the provider side enforces its own submit rules
 * regardless of what the mesh caller decides, so a drift here costs immediacy
 * for over-sized bodies, never correctness: anything above the ceiling simply
 * takes the ordinary held path.
 *
 * Keep in sync with submit-policy.ts's MID_GENERATION_MAX_BODY_CHARS
 * (= VERIFIED_SUBMIT_MIN_CHARS, 512), which carries the full derivation.
 */
const MID_GENERATION_MAX_BODY_CHARS = 512;

/**
 * NOTIF-IMMEDIACY: may THIS body reach THIS busy coordinator through the Tier 2
 * mid-generation split write, or must it take the platform-neutral Tier 1 route?
 *
 * Pure and exported so the policy is testable without a live mesh/store — the
 * three conditions below are the entire authorisation surface for writing into a
 * generating session, and each one is load-bearing:
 *
 *  1. `specOptIn` — the spec declares `send_message.mid_generation_queue`. The
 *     split write was measured against claude-cli v2.1.220 ONLY; a CLI without a
 *     mid-turn input queue would swallow the body silently, and since the row is
 *     already `drained = 1` a silent swallow is permanent loss of the
 *     completion's finalSummary. Never assumed, never inferred.
 *  2. `bodyLength <= MID_GENERATION_MAX_BODY_CHARS` — the mid-generation path
 *     skips the echo-verified submit (a generating screen never goes quiet), so
 *     a large body's CR is unconfirmed. That is exactly the composer-residue
 *     defect (oss 7cd5b777, 10,937 chars). Over the ceiling → Tier 1.
 *  3. POSIX — the driver refuses win32 before reading any state, so this is
 *     belt-and-braces; win32 simply takes Tier 1, which is platform-neutral. The
 *     ConPTY question is deliberately NOT re-litigated here.
 *
 * Returning false is always SAFE: Tier 1 still delivers the body at the
 * coordinator's next turn boundary. Only immediacy is traded away.
 */
export function isMidGenerationSplitEligible(input: {
    specOptIn: boolean;
    bodyLength: number;
    platform?: NodeJS.Platform;
}): boolean {
    if (!input.specOptIn) return false;
    if (input.bodyLength > MID_GENERATION_MAX_BODY_CHARS) return false;
    return (input.platform ?? process.platform) !== 'win32';
}

// ---------------------------------------------------------------------------
// BOOTSTRAP-MSG: worktreeHasQueuedTask predicate (exported for unit testing)
// ---------------------------------------------------------------------------
// Returns true when a queue task entry should be counted as "this worktree node already
// has work being handled" — suppressing the misleading 'use mesh_launch_session' advice
// in the worktree_bootstrap_complete system message.
//
// Mirrors the autoLaunchPending logic in triggerMeshQueue (mesh-queue-assignment.ts):
//   • assigned           → true  (session claimed it)
//   • pending, no al     → true  (queue will auto-launch, no action needed)
//   • pending, al started|completed within AUTO_LAUNCH_AWAIT_CLAIM_MS
//                        → true  (session spun up, will claim soon)
//   • pending, al started|completed but OUTSIDE the window
//                        → false (launch timed out, manual launch IS needed)
//   • pending, other al  → true  (not yet tried, queue will handle)
export function bootstrapQueueTaskCountsAsHandled(
    task: { status: string; targetNodeId?: string | null; autoLaunch?: { status: string; updatedAt: string } | null },
    bootstrapNodeId: string,
    nowMs: number,
): boolean {
    if (!meshNodeIdMatches({ id: task.targetNodeId } as MeshNodeIdentified, bootstrapNodeId)) return false;
    if (task.status === 'assigned') return true;
    const al = task.autoLaunch;
    if (!al) return true;
    if (al.status === 'started' || al.status === 'completed') {
        const launchedAtMs = Date.parse(al.updatedAt);
        return Number.isFinite(launchedAtMs) && nowMs - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS;
    }
    return true;
}

/**
 * KIMI-HOLLOW-COMPLETION: the narrow admission predicate for a completion
 * proposal whose producer explicitly proved that its final assistant content
 * is zero bytes and whose evidence grade is insufficient.
 *
 * A structured worker/tool report is completion evidence independent of chat
 * text, so it is excluded even when a version-skewed producer also carries the
 * two weak text fields. Missing length is UNKNOWN, not zero: only the explicit
 * numeric 0 reproduces incident f20f5a85 and spends a retry.
 */
export function shouldRequeueHollowCompletion(metadataEvent: Record<string, unknown>): boolean {
    const diagnostic = metadataEvent.completionDiagnostic
        && typeof metadataEvent.completionDiagnostic === 'object'
        && !Array.isArray(metadataEvent.completionDiagnostic)
        ? metadataEvent.completionDiagnostic as Record<string, unknown>
        : undefined;
    if (diagnostic?.finalAssistantContentLength !== 0) return false;
    if (readNonEmptyString(metadataEvent.evidenceLevel) !== 'insufficient') return false;
    if (readWorkerResultMetadata(metadataEvent)) return false;
    if (readNonEmptyString(diagnostic.finalSummarySource) === 'tool_report') return false;
    return true;
}

// Exported (was file-private before the B1 move) purely so its single caller,
// which stayed behind in mesh-event-forwarding.ts, can still reach it. Not part
// of the module's intended public surface — the parent does not re-export it.
export function nonRetryableProviderFailureReason(metadataEvent: Record<string, unknown>): 'auth_failed' | 'billing_failed' | null {
    const diagnostic = metadataEvent.completionDiagnostic
        && typeof metadataEvent.completionDiagnostic === 'object'
        && !Array.isArray(metadataEvent.completionDiagnostic)
        ? metadataEvent.completionDiagnostic as Record<string, unknown>
        : undefined;
    const reason = readNonEmptyString(diagnostic?.reason) || readNonEmptyString(metadataEvent.errorReason);
    return reason === 'auth_failed' || reason === 'billing_failed' ? reason : null;
}

// The set of coordinator-daemon ids this daemon answers to when draining the
// pending-events queue. Mirrors resolveCoordinatorDaemonIds in mesh-reconcile-loop:
// a unicast event may be stamped with the status id, the bare machineId, OR the
// config-form node daemonId (`daemon_<machineId>`) depending on which dispatch path
// created the worker. We expand to EVERY equivalent form so a `daemon_<machineId>`
// completion matches a coordinator that knows itself as bare `<machineId>` (the
// base-node completion-surface bug) and vice versa.
// Exported (was file-private before the B1 move) for the callers that stayed in
// mesh-event-forwarding.ts. Not part of the module's intended public surface.
export function resolveCoordinatorDrainDaemonIds(components: DaemonComponents): string[] {
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const machineId = readNonEmptyString(getMachineId());
    return expandDaemonIdForms([statusInstanceId, machineId]);
}


// Reconstruct the metadataEvent that injectMeshSystemMessage consumes from a forwarded
// (cross-machine) mesh event. The remote relay hop arrives as a flat payload, NOT the
// original provider event object, so this whitelists the fields the coordinator-side
// pipeline reads and re-projects them. Kept pure + exported so the relay-path field
// preservation (esp. taskId) is unit-testable without driving injectMeshSystemMessage.
//
// IMPORTANT asymmetry: the LOCAL in-process forward path (onMeshCoordinatorEventForwarded)
// passes the whole event through as metadataEvent, so every field on the event survives
// there for free. This remote-only path must explicitly mirror each field it needs.
export function buildRelayMetadataEvent(payload: Record<string, unknown>): Record<string, unknown> {
    const relayModalMessage = readNonEmptyString(payload.modalMessage);
    const relayModalButtons = Array.isArray(payload.modalButtons)
        ? (payload.modalButtons as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        : null;
    return {
        // Preserve the dispatch task id across the machine boundary. The `received` trace
        // stage reads payload.taskId; without mirroring it here the rebuilt metadataEvent
        // loses it, so injectMeshSystemMessage's traceCtx.taskId and the
        // updateDirectDispatchStatus(eventTaskId) call go undefined — the EvtTrace
        // queued/surfaced stages show task=- and the direct-dispatch ledger falls back to a
        // session_id match (which can flip a sibling row). The local in-process forward path
        // keeps event.taskId/meshActiveTaskId for free; this mirrors it for the remote relay.
        // Same taskId/meshActiveTaskId ordering the local unroutable trace uses.
        taskId: readNonEmptyString(payload.taskId) || readNonEmptyString(payload.meshActiveTaskId),
        attemptId: readNonEmptyString(payload.attemptId) || readNonEmptyString(payload.meshActiveAttemptId),
        ...(typeof payload.dispatchNonce === 'number'
            ? { dispatchNonce: payload.dispatchNonce }
            : (typeof payload.meshActiveDispatchNonce === 'number'
                ? { dispatchNonce: payload.meshActiveDispatchNonce }
                : {})),
        targetSessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.instanceId),
        providerType: readNonEmptyString(payload.providerType),
        providerSessionId: readNonEmptyString(payload.providerSessionId),
        // Preserve the originating coordinator SESSION id across the machine boundary so
        // the completion routes back to the exact coordinator session (multi-coordinator).
        // buildForwardPayloadFromPending spreads the worker event's metadata, so the id
        // arrives as payload.meshCoordinatorSessionId; the top-level targetCoordinatorSessionId
        // is also accepted as a fallback. injectMeshSystemMessage re-derives the routing
        // anchors from this. Absent → daemon-level fallback (version-skew safe).
        meshCoordinatorSessionId: readNonEmptyString(payload.meshCoordinatorSessionId) || readNonEmptyString(payload.targetCoordinatorSessionId),
        // RC32: preserve the originating coordinator DAEMON anchor across the machine
        // boundary — the daemon-level analogue of meshCoordinatorSessionId above. A
        // sessionless producer (async refine terminal relayed via handleMeshForwardEvent)
        // carries no session stamp; without this mirror the receive-side fallback in
        // injectMeshSystemMessage has nothing to read and the re-queued event
        // self-fallbacks to THIS daemon's id, stranding it from the real coordinator.
        targetCoordinatorDaemonId: readNonEmptyString(payload.targetCoordinatorDaemonId),
        // Carry the session identity fields the worker provider event emits so the
        // coordinator's mirror (updateMeshOwnedSession) gets a real workspace/title/
        // settings. Without these the remote-relay hop reconstructs metadataEvent with
        // an empty workspace, and the dashboard flaps to the generic
        // "Terminal (Mesh Node)" title (and degrades the provider label) between live
        // events and the periodic get_status_metadata snapshot. The local in-process
        // forward path (onMeshCoordinatorEventForwarded) already preserves these; this
        // mirrors them for the remote-only relay path.
        workspace: readNonEmptyString(payload.workspace) || readNonEmptyString(payload.workspaceName),
        workspaceName: readNonEmptyString(payload.workspaceName) || readNonEmptyString(payload.workspace),
        sessionTitle: readNonEmptyString(payload.sessionTitle),
        sessionStatus: readNonEmptyString(payload.sessionStatus),
        sessionChatStatus: readNonEmptyString(payload.sessionChatStatus),
        providerName: readNonEmptyString(payload.providerName),
        ...(payload.sessionSettings && typeof payload.sessionSettings === 'object' && !Array.isArray(payload.sessionSettings) ? { sessionSettings: payload.sessionSettings } : {}),
        finalSummary: readNonEmptyString(payload.finalSummary) || readNonEmptyString(payload.summary),
        evidenceLevel: readNonEmptyString(payload.evidenceLevel),
        // T2: carry the worker's status-snapshot last-message preview across the machine
        // boundary so a summary-less completion still surfaces the assistant reply in the
        // coordinator's inbox mirror. resolveMeshSurfacedSessionPreview reads these
        // (assistant-role only) when finalSummary is absent.
        lastMessagePreview: readNonEmptyString(payload.lastMessagePreview),
        lastMessageRole: readNonEmptyString(payload.lastMessageRole),
        ...(payload.lastMessageAt !== undefined ? { lastMessageAt: payload.lastMessageAt } : {}),
        jobId: readNonEmptyString(payload.jobId),
        interactionId: readNonEmptyString(payload.interactionId),
        status: readNonEmptyString(payload.status),
        targetDaemonId: readNonEmptyString(payload.targetDaemonId),
        // Worker origin identity for a remotely cloned worktree's bootstrap event
        // so the coordinator's hydrate-on-miss upsert is P2P-addressable.
        originDaemonId: readNonEmptyString(payload.originDaemonId)
            || readNonEmptyString(payload.daemonId)
            || readNonEmptyString((payload.metadataEvent as Record<string, unknown> | undefined)?.originDaemonId),
        originMachineId: readNonEmptyString(payload.originMachineId)
            || readNonEmptyString(payload.machineId)
            || readNonEmptyString((payload.metadataEvent as Record<string, unknown> | undefined)?.originMachineId),
        startedAt: readNonEmptyString(payload.startedAt),
        completedAt: readNonEmptyString(payload.completedAt),
        retryOfJobId: readNonEmptyString(payload.retryOfJobId),
        ...(relayModalMessage ? { modalMessage: relayModalMessage } : {}),
        ...(relayModalButtons && relayModalButtons.length > 0 ? { modalButtons: relayModalButtons } : {}),
        // agent:waiting_choice (mission f1d25e11): carry the FULL structured question
        // payload across the machine boundary so a REMOTE worker's AskUserQuestion reaches
        // the coordinator with every question + option intact — the coordinator renders
        // these and answers with mesh_answer_question. The local in-process forward path
        // preserves the whole event for free; this mirrors the fields for the remote relay.
        ...(payload.interactivePrompt && typeof payload.interactivePrompt === 'object' && !Array.isArray(payload.interactivePrompt) ? { interactivePrompt: payload.interactivePrompt } : {}),
        ...(readNonEmptyString(payload.promptId) ? { promptId: readNonEmptyString(payload.promptId) } : {}),
        ...(payload.multiSelect === true ? { multiSelect: true } : {}),
        ...(payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result) ? { result: payload.result } : {}),
        ...(payload.completionDiagnostic && typeof payload.completionDiagnostic === 'object' && !Array.isArray(payload.completionDiagnostic) ? { completionDiagnostic: payload.completionDiagnostic } : {}),
        ...(payload.workerResult && typeof payload.workerResult === 'object' && !Array.isArray(payload.workerResult) ? { workerResult: payload.workerResult } : {}),
        ...(payload.meshWorkerResult && typeof payload.meshWorkerResult === 'object' && !Array.isArray(payload.meshWorkerResult) ? { meshWorkerResult: payload.meshWorkerResult } : {}),
        ...(payload.structuredResult && typeof payload.structuredResult === 'object' && !Array.isArray(payload.structuredResult) ? { structuredResult: payload.structuredResult } : {}),
        ...(payload.timestamp !== undefined ? { timestamp: payload.timestamp } : {}),
        intentional: payload.intentional === true,
        intentionalStop: payload.intentionalStop === true,
        operatorCleanup: payload.operatorCleanup === true,
        reason: readNonEmptyString(payload.reason),
        stopReason: readNonEmptyString(payload.stopReason),
        cleanupReason: readNonEmptyString(payload.cleanupReason),
        source: readNonEmptyString(payload.source),
    };
}

/**
 * NOTIF-HELD-DRAIN (Fix 2): event-driven coordinator drain. The reconcile loop delivers a
 * worker's queued completion to an IDLE local coordinator only on its periodic poll. When a
 * coordinator is sitting idle awaiting exactly that completion, waiting up to a full poll
 * interval is the avoidable delivery latency the RCA flags — and combined with the (now-fixed)
 * modal-park false-positive it stretched into the multi-minute notification stall. So the
 * MOMENT a worker delegate event is persisted for a mesh, attempt the same idle-coordinator
 * drain immediately, mirroring the event-driven worker-claim path (agent:ready /
 * agent:generating_completed → triggerMeshQueue).
 *
 * Safety:
 *  - drainPendingMeshCoordinatorEvents marks rows drained=1 atomically, so this races the
 *    reconcile poll and the coordinator's own idle auto-flush harmlessly — exactly one consumes
 *    each row.
 *  - Only IDLE, non-modal-parked coordinators are delivery targets (never a generating /
 *    consent-modal PTY).
 *  - Strict session routing is honoured: an event naming an originating coordinator session is
 *    delivered only to that live idle session; anything not currently deliverable here
 *    (wrong/absent session, or a message-less lifecycle event) is RE-QUEUED — never dropped —
 *    so the reconcile loop's strict hold/expire path remains the single authority for it.
 */
export function flushPendingForMeshIdleCoordinators(components: DaemonComponents, meshId: string): void {
    // O(1) gate: skip the (relatively expensive) per-instance getState scan when the queue is
    // empty for this mesh.
    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.pendingEventCount(meshId) === 0) return;
    } catch { /* store unavailable — fall through and let the drain decide */ }

    const idleCoordinators: { instance: ProviderInstance; sessionId: string }[] = [];
    // NOTIF-IMMEDIACY (Tier 1): coordinators that are BUSY but NOT modal-parked. These
    // used to be invisible here — the function returned the moment no idle target was
    // found, so a completion landing while the coordinator was mid-turn waited for the
    // reconcile poll to find an idle edge. Measured cost: median ~1min, worst 873s.
    //
    // They are collected separately and never mixed into `idleCoordinators`, because the
    // two groups get DIFFERENT delivery modes and a busy target must never be handed the
    // idle-turn write.
    const busyCoordinators: { instance: ProviderInstance; sessionId: string }[] = [];
    try {
        for (const inst of components.instanceManager.getByCategory('cli')) {
            const state = inst.getState();
            const settings = state.settings && typeof state.settings === 'object'
                ? state.settings as Record<string, unknown>
                : {};
            if (readNonEmptyString(settings.meshCoordinatorFor) !== meshId) continue;
            const status = readNonEmptyString(state.status).toLowerCase();
            const modalParked = typeof (inst as any).isModalParked === 'function'
                ? (inst as any).isModalParked() === true
                : (status === 'waiting_choice' || status === 'waiting_approval');
            // PTY-OVERTRUST-DRAIN (Defect B): decide idle on the RAW adapter turn-state
            // (getDrainStatus, mask-stripped) to match the reconcile loop — getState().status
            // overlays the auto-approve hold-idle mask that paints a genuinely-idle coordinator
            // `generating`, which would make this opportunistic flush skip a real drain target.
            // Fall back to the masked literal for any instance without getDrainStatus().
            const drainStatus: string | null = typeof (inst as any).getDrainStatus === 'function'
                ? (inst as any).getDrainStatus()
                : null;
            const idle = drainStatus !== null ? drainStatus === 'idle' : (status === 'idle');
            if (idle && !modalParked) {
                idleCoordinators.push({ instance: inst, sessionId: readNonEmptyString(state.instanceId) });
            } else if (!modalParked) {
                // ★ Modal-parked is EXCLUDED from both groups, unchanged. A body delivered
                // into a harness modal has its keystrokes eaten by the modal's key handler
                // (silently answering a question the user never saw), so those coordinators
                // keep waiting for the modal-resolved tick. This is the fail-closed guard the
                // reconcile loop also enforces and it is not relaxed by Tier 1.
                busyCoordinators.push({ instance: inst, sessionId: readNonEmptyString(state.instanceId) });
            }
        }
    } catch { return; }
    // No live coordinator of EITHER kind → nothing to attempt; leave for the reconcile poll.
    if (idleCoordinators.length === 0 && busyCoordinators.length === 0) return;

    const drainDaemonIds = resolveCoordinatorDrainDaemonIds(components);
    let pendingEvents: PendingMeshCoordinatorEvent[];
    try {
        pendingEvents = drainPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
    } catch (e: any) {
        LOG.warn('MeshEvents', `Event-driven coordinator drain failed for mesh ${meshId}: ${e?.message || e}`);
        return;
    }
    if (pendingEvents.length === 0) return;

    let delivered = 0;
    let deliveredBusy = 0;
    for (const pending of pendingEvents) {
        const wantSession = readNonEmptyString(pending.targetCoordinatorSessionId);
        const targets = wantSession
            ? idleCoordinators.filter(c => sessionIdsEquivalent(c.sessionId, wantSession))
            : idleCoordinators;

        // ── NOTIF-IMMEDIACY (Tier 1): no idle target, but a busy one is live ──────
        // Only TERMINAL events (shouldForceInjectMeshEvent: completion / approval /
        // stop / refine · bootstrap) take this route. A silent lifecycle event
        // (agent:ready / generating_started) carries no coordinatorMessage and is
        // queued purely to re-drive the claim state machine — injecting it would spam
        // the coordinator, so it falls through to the requeue branch below unchanged.
        //
        // Strict session routing is applied to the busy group exactly as to the idle
        // group: an event naming an originating coordinator session reaches only that
        // session. Anything not deliverable here is requeued, never dropped.
        if (targets.length === 0 && pending.coordinatorMessage && shouldForceInjectMeshEvent(pending.event)) {
            // ★ SELF-COMPLETION EXCLUSION. A coordinator session can itself be a
            // direct-dispatch target, and when it completes that task its own completion
            // flows through here. It must NOT be told about its own completion — the event
            // exists so the DISPATCHING coordinator (usually on another daemon) can drain it
            // from the shared pending queue.
            //
            // The idle path never had to state this: a session emitting its own completion
            // is mid-transition and was not an idle drain target, so the case could not
            // arise. The busy group is exactly where it does arise, and a broadcast event
            // (no targetCoordinatorSessionId) would otherwise reach it.
            const originSessionId = readNonEmptyString(
                (pending.metadataEvent as Record<string, unknown> | undefined)?.targetSessionId,
            ) || readNonEmptyString((pending.metadataEvent as Record<string, unknown> | undefined)?.sessionId);
            const notSelf = (c: { sessionId: string }) =>
                !originSessionId || !sessionIdsEquivalent(c.sessionId, originSessionId);
            const busyTargets = (wantSession
                ? busyCoordinators.filter(c => sessionIdsEquivalent(c.sessionId, wantSession))
                : busyCoordinators
            ).filter(notSelf);
            if (busyTargets.length > 0) {
                let busyDelivered = 0;
                for (const c of busyTargets) {
                    // Tier 2 eligibility is decided PER TARGET — see
                    // isMidGenerationSplitEligible for why each condition is load-bearing.
                    const splitEligible = isMidGenerationSplitEligible({
                        specOptIn: typeof (c.instance as any).supportsMidGenerationQueue === 'function'
                            && (c.instance as any).supportsMidGenerationQueue() === true,
                        bodyLength: pending.coordinatorMessage.length,
                    });
                    const outcome = injectPendingIntoCoordinator(c.instance as any, pending, {
                        mode: splitEligible ? 'mid-generation-split' : 'next-turn-queue',
                    });
                    if (outcome.delivered) busyDelivered++;
                }
                if (busyDelivered > 0) {
                    delivered += busyDelivered;
                    deliveredBusy += busyDelivered;
                    continue;
                }
                // Every busy target refused → fall through to the requeue below. The row
                // is already drained, so requeue is what keeps the completion alive.
            }
        }
        // Not deliverable into an idle target here (wrong/absent session), or a message-less
        // lifecycle event (agent:ready / generating_started carry no coordinatorMessage and
        // must not be injected): re-queue so the reconcile loop owns it (lazy-synth / strict
        // hold/expire). Re-queue preserves queuedAt so the strict TTL measures true age.
        if (targets.length === 0 || !pending.coordinatorMessage) {
            // MUST be requeueDrainedPendingMeshCoordinatorEvent, not
            // queuePendingMeshCoordinatorEvent: this event was just DRAINED, and the
            // normal persist path cannot return a drained event to the queue. The
            // drained row still occupies UNIQUE (mesh_id, fingerprint), so INSERT OR
            // IGNORE silently discards the fresh copy while hasPendingEventFingerprint
            // (which filters drained = 0) reports no duplicate — the caller is told the
            // re-queue worked when nothing was written. The requeue helper instead flips
            // the existing row back to drained = 0, which also clears the v2 eventId
            // drained-baseline. queuedAt is preserved either way, so the strict TTL keeps
            // measuring true age.
            //
            // This was masked until now: the retired JSONL mirror re-appended the line
            // unconditionally, so the event came back on the next drain even though the
            // SQLite half was a no-op.
            try { requeueDrainedPendingMeshCoordinatorEvent(pending); } catch { /* best-effort re-queue */ }
            continue;
        }
        const message = pending.coordinatorMessage;
        const force = shouldForceInjectMeshEvent(pending.event);
        for (const c of targets) {
            c.instance.onEvent('send_message', {
                input: { text: message, textFallback: message },
                ...(force ? { force: true } : {}),
            });
            delivered++;
        }
    }
    if (delivered > 0) {
        LOG.info(
            'MeshEvents',
            `Event-driven drain delivered ${delivered} pending event(s) for mesh ${meshId} `
            + `(${idleCoordinators.length} idle coordinator(s)`
            + (deliveredBusy > 0
                ? `; ${deliveredBusy} to ${busyCoordinators.length} busy coordinator(s) without waiting for an idle edge`
                : '')
            + ')',
        );
    }
}
