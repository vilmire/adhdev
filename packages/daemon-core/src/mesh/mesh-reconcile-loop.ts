// ---------------------------------------------------------------------------
// mesh-reconcile-loop — periodic queue → live coordinator reconciliation
// ---------------------------------------------------------------------------
// Single-model replacement for the old event-based "spontaneous forward" paths
// (remote P2P mesh_forward_event dispatch + live-CLI PTY fire-and-forget inject).
// Those pushed events at the moment a worker transitioned state, and silently
// dropped on the network (P2P) or when the coordinator was generating.
//
// The reliable backbone has always been the pending-events queue (SQLite +
// JSONL): every mesh coordinator event is persisted there before anything else
// (see injectMeshSystemMessage). What was missing was an *active* drainer that
// runs on a schedule rather than only when the coordinator (an LLM) happens to
// call a mesh tool.
//
// This loop is that drainer. On a fixed interval it:
//   1. Finds live CLI coordinator sessions on THIS daemon (meshCoordinatorFor
//      stamp). For each mesh, drains the local queue scoped to this daemon and
//      injects pending events into the coordinator. When a coordinator is idle it
//      receives every queued event. When ONLY generating coordinators exist (the
//      common case while the coordinator is blocked awaiting a worker result), the
//      loop force-drains ONLY the force-inject events (completion / approval / stop /
//      refine·bootstrap terminal) and force-writes them into the generating PTY —
//      the same busy-bypass send-guard escape the live-CLI inject used to use.
//      Non-force progress events stay queued for the next idle tick (injecting them
//      mid-generation would be noise). This is what makes a coordinator parked in
//      `generating` while awaiting a worker's completion actually receive it.
//   2. In cloud mode (dispatchMeshCommand present), pulls each remote worker
//      node daemon's queue over P2P (get_pending_mesh_events) and re-injects via
//      handleMeshForwardEvent — the same pull the MCP drainCoordinatorPendingEvents
//      already does, now driven by the daemon timer instead of an LLM tool call.
//
// IMPORTANT — limits of this loop:
//   - It only delivers to *live CLI coordinator instances* on this daemon. A
//     pure stdio MCP coordinator (an LLM with no live CLI session to inject
//     into) has no inject target here; that case stays pull-driven — the LLM
//     drains the queue when it calls mesh_status / mesh_read_chat. We do NOT try
//     to "wake" an LLM from the daemon; that is structurally impossible over a
//     stdio request/response transport. See docs/refactoring/2026-06-15-mesh-event-to-queue-polling.md §4.7.
//   - Queue persistence (queuePendingMeshCoordinatorEvent) and the SQLite
//     drained=1 idempotency are the trust backbone and are untouched by this loop.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { listMeshes, getMesh } from '../config/mesh-config.js';
import { maybeInjectIdleActiveMissionReminder } from './mesh-idle-reminder.js';
import { LOG, getLogLevel } from '../logging/logger.js';
import { drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, buildPendingEventFingerprint, queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { handleMeshForwardEvent, shouldForceInjectMeshEvent, triggerMeshQueue, resolveForwardEventMeshId } from './mesh-events-coordinator.js';
import { isMeshApprovalEvent, MESH_APPROVAL_EVENTS } from './mesh-event-classify.js';
import {
    peekUnresolvedDelegateForwards,
    ackUnresolvedDelegateForward,
    expireStaleUnresolvedDelegateForwards,
    registerUnresolvedForwardRetryNudge,
} from './mesh-unresolved-forward-outbox.js';
import { readNonEmptyString, readMeshCompletionSummary, buildMeshSystemMessage } from './mesh-events-utils.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { expandDaemonIdForms, daemonIdsEquivalent, sessionIdsEquivalent, meshNodeIdMatches, withStatusProbeMarker } from '@adhdev/mesh-shared';
import { getQueue, reclaimStrandedAssignedTask, updateTaskStatus } from './mesh-work-queue.js';
import { resolveSessionBusyVerdict, runContinuousAutoFastForwardScan, runPendingCoordinatorCatchupScan } from './mesh-queue-assignment.js';
import { readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerEntry } from './mesh-ledger.js';
import { findTerminalLedgerEvidenceForTask } from './mesh-events-stale.js';
import {
    resolveCoordinatorDaemonIds,
    daemonHostsMesh,
    resolveCoordinatorSelfIds,
} from './mesh-reconcile-identity.js';
import {
    resolveAutoPruneMinAgeMs,
    resolvePendingHeldDrainEscalateMs,
    resolveReconcileIntervalMs,
} from './mesh-reconcile-config.js';
import { pullRemoteNodeQueues } from './mesh-remote-event-pull.js';
import {
    reconcileUnterminatedDirectDispatches,
    autoPruneStaleDirectDispatches,
    pollAssignedTaskTerminalEvidence,
} from './mesh-completion-synthesis.js';
import { sessionStatusFromNodes } from './mesh-active-work.js';

// Re-export the extracted public API so existing importers (mesh-events.ts barrel;
// the reconcile-loop test suite) keep their `from './mesh-reconcile-loop.js'` paths.
export { getMeshV2BackstopCounters, __resetMeshV2BackstopCountersForTests } from './mesh-reconcile-v2-backstop.js';
export { __resetReconcileInFlightSynthDebounceForTests } from './mesh-reconcile-acked-hold.js';

// Reconcile-loop timing tunables + their env-override resolvers
// (DEFAULT_RECONCILE_INTERVAL_MS, DEFAULT_AUTO_PRUNE_MIN_AGE_MS,
// DEFAULT_PENDING_HELD_DRAIN_ESCALATE_MS, resolveReconcileIntervalMs,
// resolveAutoPruneMinAgeMs, resolvePendingHeldDrainEscalateMs) live in
// ./mesh-reconcile-config.ts (A-3 extraction) and are imported above.

interface LiveCoordinator {
    meshId: string;
    instance: ReturnType<DaemonComponents['instanceManager']['getInstance']>;
    // Runtime session id of this coordinator instance (getState().instanceId). PHASE 2
    // strict-matches an event's targetCoordinatorSessionId against this so a completion
    // routes back to the exact originating coordinator session, not a sibling on the same
    // daemon (the multi-coordinator misroute).
    sessionId: string;
    // PTY-OVERTRUST-DRAIN (Defect B): drain-eligibility, decided on the RAW adapter
    // turn-state (mask-stripped) — NOT on getState().status, which overlays the
    // auto-approve "hold-idle" visual mask that paints a genuinely-idle coordinator
    // `generating` and so used to strand its worker's completion. True only when the
    // raw adapter is at a real turn end AND the session is not modal-parked. When the
    // instance does not expose getDrainStatus() (non-CLI / older), this falls back to
    // the masked `status === 'idle'` (the pre-fix behaviour) so nothing regresses.
    idle: boolean;
    // True when the coordinator session is parked on a harness modal awaiting a
    // human answer — claude-cli AskUserQuestion (waiting_choice) or a tool-consent
    // prompt (waiting_approval). A force-inject into such a session would write raw
    // keystrokes the modal key handler consumes, silently selecting a choice the
    // user never made (data corruption). PHASE 2 excludes these from force-inject
    // and leaves the event queued for a later (modal-resolved) tick.
    modalParked: boolean;
}

// Observability: last-seen modal-park state per coordinator session, so we LOG.info
// only on a TRANSITION (clear → parked, parked → cleared) instead of every 4s tick.
// Per-process; a restart re-logs the first observation, which is desirable — it
// re-confirms a coordinator that is still parked after the restart (the exact
// "restart does not clear it" symptom the operator needs visibility into).
const coordinatorModalParkState = new Map<string, boolean>();

// Find live CLI coordinator instances on THIS daemon, keyed by mesh.
function findLiveCoordinators(components: DaemonComponents): LiveCoordinator[] {
    const out: LiveCoordinator[] = [];
    for (const inst of components.instanceManager.getByCategory('cli')) {
        const state = inst.getState();
        const settings = state.settings && typeof state.settings === 'object'
            ? state.settings as Record<string, unknown>
            : {};
        const meshId = readNonEmptyString(settings.meshCoordinatorFor);
        if (!meshId) continue;
        const status = readNonEmptyString(state.status).toLowerCase();
        // getState() overlays the modal-park statuses: an active AskUserQuestion
        // prompt surfaces as waiting_choice, a tool-consent prompt as waiting_approval.
        // NOTIF-HELD-DRAIN (Fix 1): consult the instance's own isModalParked() rather than the
        // raw status literal so the corrected classification flows here — a busy mesh
        // coordinator's routine, in-flight tool-consent (auto-approve off) is NOT a human-await
        // modal and must NOT wedge the mesh's pending completion events under `modal_parked`.
        // resolveModalParkStatus() (which isModalParked wraps) already encodes that distinction
        // and the waiting_choice/stalled-auto-approve genuine-modal cases. Fall back to the
        // status literal for any instance that does not expose the method. Lowercase compare —
        // the SessionStatus enum is forked across modules and waiting_choice is absent from some.
        const modalParked = typeof (inst as any).isModalParked === 'function'
            ? (inst as any).isModalParked() === true
            : (status === 'waiting_choice' || status === 'waiting_approval');
        // PTY-OVERTRUST-DRAIN (Defect B, fix A): drain-eligible idle is decided on the
        // RAW adapter turn-state, not getState().status. getState() overlays the
        // auto-approve hold-idle mask that paints a genuinely-idle coordinator
        // `generating` (a UI-flicker suppressant), and the reconcile loop used to trust
        // that mask and HOLD the worker's completion (generating_no_idle_coordinator)
        // even though the PTY was at a real turn end. getDrainStatus() strips the mask
        // (raw adapter idle, modal-park preserved). Fall back to the masked literal for
        // any instance that does not expose it (non-CLI / older) — regression-0.
        const drainStatus: string | null = typeof (inst as any).getDrainStatus === 'function'
            ? (inst as any).getDrainStatus()
            : null;
        const idle = drainStatus !== null ? drainStatus === 'idle' : (status === 'idle');
        const sessionId = readNonEmptyString(state.instanceId);
        // ── NOTIF (B) desync diagnostic (read-only, no behavior change) ───────────
        // The confirmed (B) defect: a coordinator whose FSM is idle (status above ===
        // 'idle' for minutes) is nonetheless classified busy here, so the generating/
        // modal-park hold never drains and a worker completion is stranded until the
        // user's next turn edge. Static analysis found no code path where getState()
        // returns generating while lastStatus and the adapter raw are both idle — so the
        // divergence is a runtime desync between the three status sources. Capture all
        // three (plus the auto-approve mask state that getState() overlays at :803) for
        // EVERY mesh-coordinator candidate on this tick, so the source that diverges from
        // the others can be read directly against the same-tick "skip → generating"/
        // "skip → modal-parked" hold logs below (pair by sessionId + timestamp).
        //
        // CRITICAL: reuse the `state` already fetched above (line ~301) — do NOT call
        // getState() again. getState() runs maybeAutoApproveStatus() as a side effect,
        // which would mutate the very auto-approve mask we are trying to observe. The
        // adapter raw read uses allowParse:false, which only reads engine.activeModal and
        // is side-effect-free.
        if (getLogLevel() === 'debug') {
            let adapterRaw = '?';
            try {
                const a = (inst as any).adapter;
                if (a && typeof a.getStatus === 'function') {
                    adapterRaw = readNonEmptyString(a.getStatus({ allowParse: false })?.status) || '?';
                }
            } catch (e: any) {
                adapterRaw = `err:${e?.message || e}`;
            }
            const lastStatus = readNonEmptyString((inst as any).lastStatus) || '?';
            const autoApproveBusy = (inst as any).autoApproveBusy;
            const maskSince = (inst as any).autoApproveMaskSince;
            // PTY-OVERTRUST-DRAIN: include the mask-stripped drainStatus next to the three
            // legacy sources so the divergence (getState=generating while adapterRaw=idle =
            // the mask) is directly readable, and confirm drain now follows adapterRaw.
            LOG.debug('MeshReconcile', `coordDiag sess=${sessionId || '?'} mesh=${meshId} getState=${status || '?'} drainStatus=${drainStatus || 'n/a'} lastStatus=${lastStatus} adapterRaw=${adapterRaw} autoApproveBusy=${autoApproveBusy === true} maskSince=${maskSince || 0}`);
        }
        // Modal-park transition observability: a coordinator entering modal-park is what
        // begins holding completion events under `modal_parked`; one leaving it is what
        // drains them. Both transitions were previously SILENT (the operator had no log
        // to diagnose a stuck/held completion), so emit a single line per edge.
        const stateKey = `${meshId}::${sessionId || '?'}`;
        const prevParked = coordinatorModalParkState.get(stateKey);
        if (prevParked !== modalParked) {
            coordinatorModalParkState.set(stateKey, modalParked);
            if (modalParked) {
                LOG.info('MeshReconcile', `Coordinator ${sessionId || '?'} (mesh ${meshId}) entered modal-park (status=${status}) — terminal events for it will be held until the modal is answered`);
            } else if (prevParked === true) {
                LOG.info('MeshReconcile', `Coordinator ${sessionId || '?'} (mesh ${meshId}) left modal-park (status=${status}) — held events will drain on this/next tick`);
            }
        }
        out.push({ meshId, instance: inst, sessionId, idle, modalParked });
    }
    return out;
}

/**
 * DRAIN-WITHOUT-INJECT guard. Classify, for a mesh on THIS daemon, whether a
 * queue-drain caller (the MCP `get_pending_mesh_events` poll) may safely consume
 * pending coordinator events — i.e. whether there is a surface that will actually
 * deliver them.
 *
 * Root cause being guarded: `get_pending_mesh_events` marks rows drained=1
 * atomically and unconditionally. When the live CLI coordinator for the mesh is
 * GENERATING (or modal-parked), the reconcile loop correctly HOLDS its terminal
 * events (drained=0) for the coordinator's next idle tick — but a concurrent MCP
 * poll draining the SAME queue consumes those held rows into a tool result that
 * the busy coordinator never surfaces as a turn, so the completion is lost
 * forever (drained=1, never re-queued). The reconcile loop is the authoritative
 * delivery path for a live CLI coordinator; the MCP poll must defer to it.
 *
 * Returns:
 *  - hasLiveCliCoordinator: a CLI session with meshCoordinatorFor === meshId
 *    exists on this daemon (the reconcile loop owns its delivery).
 *  - deliverableNow: there is an IDLE live CLI coordinator (reconcile would
 *    full-drain into it) — draining now is safe and equivalent.
 *  - holdForReconcile: a live CLI coordinator exists but is non-idle
 *    (generating / modal-parked). The MCP poll MUST NOT drain; the reconcile
 *    loop holds the events undrained and injects them on the next idle tick.
 *
 * A mesh with NO live CLI coordinator on this daemon is a pure stdio MCP / LLM
 * coordinator: the MCP tool result IS the only surface, so the poll legitimately
 * drains (holdForReconcile=false). No regression to that path.
 */
export function resolveCoordinatorDrainDeliverability(
    components: Pick<DaemonComponents, 'instanceManager'>,
    meshId: string,
): { hasLiveCliCoordinator: boolean; deliverableNow: boolean; holdForReconcile: boolean } {
    const coordinators = findLiveCoordinators(components as DaemonComponents).filter(c => c.meshId === meshId);
    if (coordinators.length === 0) {
        return { hasLiveCliCoordinator: false, deliverableNow: false, holdForReconcile: false };
    }
    const hasIdle = coordinators.some(c => c.idle);
    return {
        hasLiveCliCoordinator: true,
        deliverableNow: hasIdle,
        // A live CLI coordinator exists but none is idle → the reconcile loop is
        // holding the events; the poll must not steal them.
        holdForReconcile: !hasIdle,
    };
}

/**
 * DRAIN-WITHOUT-INJECT guard for the `get_pending_mesh_events` daemon handler.
 *
 * Decides whether an incoming pending-events DRAIN must be held (return nothing,
 * leave rows drained=0) because the only surface for those events is a LOCAL live
 * CLI coordinator that is currently busy (generating / modal-parked) — in which
 * case the reconcile loop owns delivery on the coordinator's next idle tick, and
 * the poll draining them now would lose them.
 *
 * The hold applies ONLY when BOTH:
 *   1) a live CLI coordinator for this mesh on THIS daemon is non-idle, AND
 *   2) the drain is targeted at THIS daemon (the requested coordinatorDaemonId is
 *      empty/broadcast, or matches one of this daemon's id forms).
 *
 * A REMOTE coordinator pulling our worker's events passes its own (remote)
 * coordinatorDaemonId — condition (2) is false — so the drain proceeds and the
 * remote pull is never blocked by our local coordinator's busy state. A pure
 * stdio MCP coordinator (no live CLI session) never satisfies (1), so its tool
 * result remains the surface and the drain proceeds. No regression to either.
 *
 * SELF-COORDINATOR INBOX LEVEL-DRAIN (Defect 2): the hold above assumes the ONLY
 * surface for a busy local coordinator's events is a future PTY inject on its idle
 * edge, so it defers to the reconcile loop. But when the drain caller IS the local
 * coordinator reading its OWN inbox (the `get_pending_mesh_events` call whose events
 * are returned in the caller's tool RESULT — a data queue the self-coordinating LLM
 * consumes directly), the events ARE surfaced losslessly the moment the tool returns,
 * with NO PTY write. A busy self-coordinating LLM that calls a mesh tool mid-turn would
 * otherwise get an empty inbox (held) and only see the completion on its NEXT busy→idle
 * edge — the measured ~59s strand. `callerIsSelfCoordinatorInboxRead` marks that safe
 * caller: the hold is relaxed for it (return the events), while every OTHER drain (a
 * backfill relay, a broadcast poll, a DIFFERENT coordinator that genuinely needs its PTY)
 * still defers to the reconcile loop. This relaxes delivery INTO the coordinator's own
 * inbox only — it never changes how events are injected into a live PTY prompt.
 */
export function shouldHoldPendingDrainForBusyLocalCoordinator(
    components: Pick<DaemonComponents, 'instanceManager'> & { statusInstanceId?: string },
    meshId: string,
    requestedCoordinatorDaemonId?: string | null,
    callerIsSelfCoordinatorInboxRead?: boolean,
): boolean {
    if (!meshId) return false;
    const deliverability = resolveCoordinatorDrainDeliverability(components, meshId);
    if (!deliverability.holdForReconcile) return false;
    // The local CLI coordinator is busy. Hold only when the drain is for THIS daemon.
    const requested = readNonEmptyString(requestedCoordinatorDaemonId);
    if (!requested) return true; // broadcast drain → would consume the held local events
    const localIds = expandDaemonIdForms([
        readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId),
        readNonEmptyString(loadConfig().machineId),
    ]);
    const targetsLocalCoordinator = localIds.some(id => daemonIdsEquivalent(id, requested));
    if (!targetsLocalCoordinator) return false;
    // SELF-COORDINATOR INBOX LEVEL-DRAIN: the busy local coordinator is itself the caller,
    // reading its own inbox — the drained events return in ITS tool result (lossless data-queue
    // surface, no PTY inject). Do NOT hold; let the self-coordinator see its completions now.
    if (callerIsSelfCoordinatorInboxRead) return false;
    return true;
}

// Inject a drained pending event into a live coordinator session. Force-inject
// events carry force:true so they bypass the busy send-guard and land in the PTY
// even while the coordinator is generating (see shouldForceInjectMeshEvent).
function injectPendingIntoCoordinator(
    coordinator: LiveCoordinator['instance'],
    pending: PendingMeshCoordinatorEvent,
    opts?: { forceOverride?: boolean },
): void {
    if (!coordinator) return;
    // NOTIF-DROP-SYNTH-NO-MESSAGE (defence-in-depth): a queued event with no coordinatorMessage
    // used to be dropped here (drain-without-inject) — the row had already been consumed
    // (drained=1) by the caller's drain, so silently returning lost it forever. The primary fix
    // makes the transcript-reconcile synth always carry a coordinatorMessage, but as a backstop,
    // lazily synthesize the [System] text for any force-inject (terminal: completion / approval /
    // stop / refine·bootstrap) event that still arrives message-less, so it surfaces instead of
    // vanishing. A NON-force lifecycle event (agent:ready / generating_started) legitimately
    // carries no message and must NOT be injected (it is queued only to re-drive the claim state
    // machine on pull) — for it we still return without injecting.
    let coordinatorMessage = pending.coordinatorMessage;
    if (!coordinatorMessage) {
        if (!shouldForceInjectMeshEvent(pending.event)) return;
        const metadataEvent = pending.metadataEvent && typeof pending.metadataEvent === 'object'
            ? pending.metadataEvent
            : {};
        coordinatorMessage = buildMeshSystemMessage({
            event: pending.event,
            nodeLabel: pending.nodeLabel,
            metadataEvent,
        });
        if (!coordinatorMessage) return; // builder produced nothing — nothing to surface
        LOG.warn('MeshReconcile', `Lazily synthesized missing coordinatorMessage for ${pending.event} (mesh ${pending.meshId}) at inject time — a queued terminal event arrived message-less`);
    }
    // forceOverride lets the APPROVAL-Q1-REALTIME nudge path deliver into a busy
    // coordinator WITHOUT a raw PTY force-write (force-inject-into-generating stays
    // intentionally removed): a non-force send_message enters the adapter's
    // pendingOutboundQueue and is surfaced at the coordinator's next turn boundary.
    const force = opts?.forceOverride ?? shouldForceInjectMeshEvent(pending.event);
    // EVTTRACE: event surfaced to the coordinator (injected into its live CLI session).
    // This is the terminal happy-path stage. Observation only.
    traceMeshEventStage('surfaced', {
        taskId: pending.metadataEvent?.taskId,
        sessionId: pending.metadataEvent?.targetSessionId ?? pending.targetCoordinatorSessionId,
        nodeId: pending.nodeId,
        meshId: pending.meshId,
        event: pending.event,
    }, force ? 'force-inject' : 'inject');
    coordinator.onEvent('send_message', {
        input: { text: coordinatorMessage, textFallback: coordinatorMessage },
        ...(force ? { force: true } : {}),
    });
}

// Held-event ledger dedup: fingerprints of held terminal events already written as an
// `event_held` ledger audit record in THIS process. Prevents the 4s reconcile tick from
// re-logging the same held event every interval while a coordinator stays modal-parked.
// Per-process only (not persisted) — if the daemon restarts while an event is still held
// it is re-logged once, which is desirable: it re-confirms the event is still undelivered.
const heldEventLedgerRecorded = new Set<string>();

// C1 (data safety): when a terminal completion/approval/bootstrap event cannot be
// delivered because the only coordinators are modal-parked, the event is held at
// drained=0 in the pending queue (SQLite + JSONL) for a later tick. That queue is
// disk-persisted but carries no operator-visible audit trail and can be silently
// dropped by the pending-file trim (100 KB / 50-entry cap). To guarantee a held
// completion's worker summary is never silently lost, mirror each held terminal event
// into the coordinator's mesh ledger as an `event_held` entry — auditable and
// recoverable (the finalSummary survives even if the pending copy is later trimmed or
// the coordinator session is force-resolved before re-drain). Idempotent per process
// via heldEventLedgerRecorded so a long modal park does not spam the ledger.
function recordHeldTerminalEventsToLedger(
    meshId: string,
    drainDaemonIds: string[],
    reason: string,
    heldForCoordinatorCount: number,
): void {
    let pending: readonly PendingMeshCoordinatorEvent[];
    try {
        pending = getPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
    } catch {
        return; // best-effort audit — never let a peek failure break the tick
    }
    for (const event of pending) {
        // Only audit terminal/force-inject events (completion / approval / stop / refine·
        // bootstrap). Silent lifecycle events (agent:ready / generating_started) carry no
        // worker output to preserve and re-drain harmlessly, so they need no audit trail.
        if (!shouldForceInjectMeshEvent(event.event)) continue;
        const fingerprint = buildPendingEventFingerprint(event);
        const key = `${meshId}::${fingerprint || `${event.event}::${event.nodeId || ''}::${event.queuedAt}`}`;
        if (heldEventLedgerRecorded.has(key)) continue;
        heldEventLedgerRecorded.add(key);
        const finalSummary = readMeshCompletionSummary(event.metadataEvent);
        try {
            appendLedgerEntry(meshId, {
                kind: 'event_held',
                ...(event.nodeId ? { nodeId: event.nodeId } : {}),
                payload: {
                    event: event.event,
                    reason,
                    recoverable: true,
                    heldForCoordinators: heldForCoordinatorCount,
                    nodeLabel: event.nodeLabel,
                    ...(event.workspace ? { workspace: event.workspace } : {}),
                    targetCoordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
                    queuedAt: event.queuedAt,
                    ...(fingerprint ? { fingerprint } : {}),
                    ...(finalSummary ? { finalSummary } : {}),
                },
            });
            LOG.info('MeshReconcile', `Ledger-recorded held ${event.event} for mesh ${meshId} (reason ${reason}) — recoverable from ledger`);
        } catch (e: any) {
            // Failed to persist — drop the dedup marker so the next tick retries.
            heldEventLedgerRecorded.delete(key);
            LOG.warn('MeshReconcile', `Failed to ledger-record held ${event.event} for mesh ${meshId}: ${e?.message || e}`);
        }
    }
}

// PTY-OVERTRUST-DRAIN (Defect B, fix B). Age of the OLDEST queued terminal/force-inject
// event for a mesh, in ms — the signal the generating-hold age-escape gates on. Returns 0
// when there is no held terminal event (no escape needed). Best-effort: a peek failure
// returns 0 (no escape this tick), never throws into the tick.
function oldestHeldTerminalEventAgeMs(meshId: string, drainDaemonIds: string[]): number {
    let pending: readonly PendingMeshCoordinatorEvent[];
    try {
        pending = getPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
    } catch {
        return 0;
    }
    const now = Date.now();
    let maxAge = 0;
    for (const event of pending) {
        if (!shouldForceInjectMeshEvent(event.event)) continue; // only terminal events matter
        const queuedAt = typeof event.queuedAt === 'number' ? event.queuedAt : now;
        const age = now - queuedAt;
        if (age > maxAge) maxAge = age;
    }
    return maxAge;
}

// PTY-OVERTRUST-DRAIN (Defect B, fix B). Re-confirm, on the RAW adapter (mask-stripped),
// which of the held-as-generating coordinators is GENUINELY idle right now. A coordinator
// whose getDrainStatus() reads 'idle' is a real drain target the time-based escape may
// deliver into. One that still reads 'generating'/'modal_parked'/'other' stays held — the
// escape NEVER injects into a genuinely-busy PTY (that is the data-loss force-inject path
// intentionally removed; re-confirmation is what keeps this safe). Falls back to the
// coordinator's already-computed `idle` flag when the instance does not expose
// getDrainStatus() (non-CLI / older) — that flag is itself raw-adapter-derived post-fix-A.
function reconfirmGenuinelyIdleCoordinators(generating: LiveCoordinator[]): LiveCoordinator[] {
    const out: LiveCoordinator[] = [];
    for (const c of generating) {
        const inst = c.instance as any;
        const drainStatus: string | null = typeof inst?.getDrainStatus === 'function'
            ? inst.getDrainStatus()
            : null;
        const genuinelyIdle = drainStatus !== null ? drainStatus === 'idle' : c.idle;
        if (genuinelyIdle) out.push({ ...c, idle: true });
    }
    return out;
}

// Full-drain the local pending queue for a mesh and inject every event into the given
// IDLE target coordinators, honouring strict session routing. Shared by the normal idle
// delivery path and the Defect-B age-escape so both deliver identically (one drain, one
// inject-per-event, strict-route hold for an unmatched session). Returns the number of
// events drained (0 when the queue was empty / drain failed). Callers must have already
// confirmed the targets are genuinely idle.
function drainAndInjectIntoTargets(
    meshId: string,
    drainDaemonIds: string[],
    localDaemonId: string | undefined,
    targetCoordinators: LiveCoordinator[],
    logLabel: string,
): number {
    let pendingEvents: PendingMeshCoordinatorEvent[] = [];
    try {
        pendingEvents = drainPendingMeshCoordinatorEvents(
            meshId,
            drainDaemonIds.length > 0 ? drainDaemonIds : localDaemonId,
        );
    } catch (e: any) {
        LOG.warn('MeshReconcile', `Drain failed for mesh ${meshId}: ${e?.message || e}`);
        return 0;
    }
    if (pendingEvents.length === 0) return 0;

    LOG.info('MeshReconcile', `Reconcile inject → ${logLabel}: ${pendingEvents.length} pending event(s) → ${targetCoordinators.length} coordinator(s) for mesh ${meshId}`);
    for (const pending of pendingEvents) {
        // Strict session routing (multi-coordinator): when the event names an
        // originating coordinator session, deliver ONLY to the live coordinator whose
        // session id matches — a sibling coordinator on the same daemon must NOT receive
        // another coordinator's completion. When the event carries no session id (legacy /
        // version-skewed / single-coordinator), fall back to the daemon-level set
        // (unchanged behaviour — regression-0 for the common case).
        const wantSession = readNonEmptyString(pending.targetCoordinatorSessionId);
        if (wantSession) {
            // Session ids are single-form; sessionIdsEquivalent is the one canonical
            // exact-match predicate — unlike the daemon-level set below it needs no
            // form expansion.
            const matched = targetCoordinators.filter(c => sessionIdsEquivalent(c.sessionId, wantSession));
            if (matched.length === 0) {
                // The originating coordinator session is not deliverable on this daemon
                // right now (gone, or modal-parked and excluded from targets). Strict mode
                // does NOT broadcast to siblings — hold the event for a later tick, and
                // ledger-expire it past a TTL so it can never wedge forever.
                holdOrExpireStrictUnmatchedEvent(pending, wantSession, meshId);
                continue;
            }
            for (const c of matched) injectPendingIntoCoordinator(c.instance, pending);
            continue;
        }
        for (const c of targetCoordinators) {
            injectPendingIntoCoordinator(c.instance, pending);
        }
    }
    return pendingEvents.length;
}

// APPROVAL-Q1-REALTIME stale guard. An approval nudge is RESOLVED once a real terminal
// ledger entry (task_completed / task_failed) for the same node/session landed at or
// after the nudge was queued — the worker either finished or died, so it is no longer
// waiting on that approval. Delivering the nudge then would falsely tell the coordinator
// the worker is still blocked (the exact UX inversion this fix must avoid), so a resolved
// nudge is dropped rather than delivered. Ledger-based so the check is daemon-local and
// deterministic (no dependence on a possibly-remote worker instance's live state).
function isApprovalNudgeResolved(meshId: string, pending: PendingMeshCoordinatorEvent): boolean {
    const metadataEvent = (pending.metadataEvent && typeof pending.metadataEvent === 'object')
        ? pending.metadataEvent as Record<string, unknown>
        : {};
    const nodeId = readNonEmptyString(pending.nodeId) || readNonEmptyString(metadataEvent.meshNodeId);
    const sessionId = readNonEmptyString(metadataEvent.targetSessionId) || readNonEmptyString(metadataEvent.sessionId);
    if (!nodeId && !sessionId) return false; // nothing to correlate a terminal against
    const queuedAt = typeof pending.queuedAt === 'number' && Number.isFinite(pending.queuedAt) ? pending.queuedAt : 0;
    let entries: MeshLedgerEntry[];
    try {
        entries = readLedgerEntries(meshId);
    } catch {
        return false; // best-effort — a read failure never blocks delivery
    }
    return entries.some(e => {
        if (e.kind !== 'task_completed' && e.kind !== 'task_failed') return false;
        if (queuedAt > 0) {
            const t = new Date(e.timestamp).getTime();
            if (Number.isFinite(t) && t < queuedAt) return false; // terminal predates the nudge
        }
        const nodeMatch = !!nodeId && !!e.nodeId && daemonIdsEquivalent(e.nodeId, nodeId);
        const sessionMatch = !!sessionId && !!e.sessionId && sessionIdsEquivalent(e.sessionId, sessionId);
        return nodeMatch || sessionMatch;
    });
}

// APPROVAL-Q1-REALTIME. Deliver queued approval nudges to a mesh's coordinators every
// reconcile tick, EVEN when the only coordinators are busy (generating / modal-parked)
// and there is no idle drain target. This is the crux of the fix: a completion rides the
// idle-edge hold below (its payload lives only in the pending event), but an approval is
// LEVEL-backed (task_approval_needed ledger → mesh_status awaiting_approval) so it must
// NOT wait for an idle edge — during orchestration a coordinator can stay `generating`
// awaiting the very worker that is blocked on the approval, so the idle edge (the flush
// point) may never come, and the coordinator's mesh_approve arrives only after a human
// resolves it ('Not in approval state'). We drain ONLY approval events (leaving every
// other event for the unchanged hold), drop any already-resolved (stale) nudge, and
// deliver the rest into each coordinator's inbox WITHOUT a raw PTY force-write (non-force
// send_message → adapter pendingOutboundQueue → surfaced at the coordinator's next turn
// boundary). Dropping the pending copy after delivery is safe and prevents re-nudging
// every 4s — the level ledger state remains the durable, re-derivable source of truth.
// Returns the number of nudges delivered (0 when none were queued/deliverable).
function drainAndDeliverApprovalNudges(
    meshId: string,
    drainDaemonIds: string[],
    localDaemonId: string | undefined,
    meshCoordinators: LiveCoordinator[],
): number {
    // O(1) guard: only touch the queue when an approval event is actually present.
    let peeked: readonly PendingMeshCoordinatorEvent[];
    try {
        peeked = getPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
    } catch {
        return 0;
    }
    if (!peeked.some(e => isMeshApprovalEvent(e.event))) return 0;

    let drained: PendingMeshCoordinatorEvent[];
    try {
        drained = drainPendingMeshCoordinatorEvents(
            meshId,
            drainDaemonIds.length > 0 ? drainDaemonIds : localDaemonId,
            { onlyEvents: MESH_APPROVAL_EVENTS },
        );
    } catch (e: any) {
        LOG.warn('MeshReconcile', `Approval-nudge drain failed for mesh ${meshId}: ${e?.message || e}`);
        return 0;
    }

    let delivered = 0;
    for (const pending of drained) {
        if (isApprovalNudgeResolved(meshId, pending)) {
            // Stale: already resolved. Drop without delivery — re-surfacing it would
            // mislead the coordinator into believing the worker is still awaiting approval.
            traceMeshEventDrop('approval_nudge_stale_resolved', {
                taskId: readNonEmptyString((pending.metadataEvent as Record<string, unknown>)?.taskId),
                sessionId: readNonEmptyString((pending.metadataEvent as Record<string, unknown>)?.targetSessionId) ?? pending.targetCoordinatorSessionId,
                nodeId: pending.nodeId,
                meshId,
                event: pending.event,
            }, 'approval already resolved (terminal ledger entry present)');
            LOG.info('MeshReconcile', `Dropped stale approval nudge for mesh ${meshId} (${pending.nodeLabel}) — approval already resolved`);
            continue;
        }
        // Strict session routing (multi-coordinator): deliver only to the originating
        // coordinator session when the nudge names one; otherwise broadcast to every
        // coordinator for this mesh. Absent a live matching coordinator we drop the nudge —
        // the level state (awaiting_approval) still surfaces via mesh_status, so nothing is lost.
        const wantSession = readNonEmptyString(pending.targetCoordinatorSessionId);
        const targets = wantSession
            ? meshCoordinators.filter(c => sessionIdsEquivalent(c.sessionId, wantSession))
            : meshCoordinators;
        if (targets.length === 0) continue;
        for (const c of targets) injectPendingIntoCoordinator(c.instance, pending, { forceOverride: false });
        delivered++;
        LOG.info('MeshReconcile', `Delivered approval nudge (level) for mesh ${meshId} (${pending.nodeLabel}) → ${targets.length} coordinator(s) without waiting for an idle edge`);
    }
    return delivered;
}

// One reconcile tick. Two independent phases:
//
//   PHASE 1 — Remote queue pull (the fix for remote worktree completions never
//     reaching an MCP/LLM coordinator). For EVERY mesh this daemon hosts/
//     coordinates, pull each remote worker node's pending-events queue over P2P
//     into THIS daemon's local queue. This runs *regardless of whether a live CLI
//     coordinator exists* — the coordinator is usually a pure stdio MCP LLM with
//     no live CLI session, and it can only observe a remote worker's completion
//     once that event has been pulled into the local queue (which it then drains
//     on its next mesh tool call). Previously this pull was gated behind a live
//     CLI coordinator and so never ran for MCP/LLM coordinators — remote
//     completions sat on the remote node's queue until the LLM happened to call
//     mesh_read_chat, which triggered the MCP-side pull. The daemon now does it
//     autonomously on the timer. Standalone (no dispatchMeshCommand) skips this
//     phase entirely — there are no remote nodes to pull from.
//
//   PHASE 2 — Live CLI inject. For each mesh that has a live CLI coordinator on
//     THIS daemon, drain the local queue and inject pending events into the PTY.
//     Unchanged from before.
// Bug B: how long a row may sit 'assigned' with an unconfirmed dispatch before the
// watchdog reclaims it. Must be comfortably larger than the per-dispatch confirm
// timeout (DISPATCH_CONFIRM_TIMEOUT_MS in mesh-events-coordinator) so a slow-but-live
// dispatch still inside its normal confirm window is never reclaimed early — this is
// the durable backstop for the case the in-process confirm timer can't cover (a timer
// lost to a daemon restart between claim and confirm).
const ASSIGNED_STRANDED_DEADLINE_MS = 5 * 60_000;

// COMPLETION-PROPAGATION F3: how long a row may sit 'assigned' with a CONFIRMED delivery
// (delivered/acked) but no terminal completion before the watchdog reclaims it as a
// delivered-but-lost completion. Distinct from — and deliberately larger than —
// ASSIGNED_STRANDED_DEADLINE_MS: a confirmed-delivered dispatch was genuinely handed to a
// worker, so the deadline must comfortably exceed any realistic single worker turn (a large
// generation) before we treat the missing completion as lost and re-open the task. Paired with
// the non-generating + no-terminal-ledger guards below so a worker still mid-turn is never
// reclaimed out from under itself.
const DELIVERED_NO_TURN_DEADLINE_MS = 15 * 60_000;

// DELIVERED-NOT-CONSUMED (remote autoLaunch delivered≠consumed gap): how long a row may sit
// 'assigned' with a CONFIRMED delivery ('delivered') that was never CONSUMED ('acked' — the
// worker's agent:generating_started never arrived) before the watchdog re-drives it. Far shorter
// than DELIVERED_NO_TURN_DEADLINE_MS (15min): a remote autoLaunch marks markAutoLaunch(completed)
// and returns immediately, relying on agent:ready/reconcile to inject; if the launch→ready→claim
// window (widened on win32 by the 3–4s git spawn latency) drops the inject, the row sits 'assigned'
// but the delivery never flips past 'delivered' to 'acked'. The delivered-not-acked state is the
// cross-daemon consumption signal — positive evidence the worker never started the turn — so we can
// safely re-open the task after a SHORT grace (well above a normal generating_started round-trip so
// a merely-slow start is never torn off) instead of waiting the full 15min turn budget. Floored
// comfortably above the auto-launch cooldown so a legitimate late inject still has room to land.
const ASSIGNED_DELIVERED_UNCONSUMED_REDRIVE_MS = 25_000;

// RECLAIM-FALSEPOS: how many CONSECUTIVE UNKNOWN busy-verdict ticks (past the delivered-no-turn
// deadline) must accumulate before a delivered row whose worker session cannot be positively
// observed is reclaimed. An UNKNOWN verdict means the assigned session is not present in THIS
// daemon's local instance map (remote / gone / id-form skew) — so it may be a REMOTE session that
// is genuinely mid-turn. Reclaiming it on a single UNKNOWN tick tears a live remote worker off its
// task and re-launches a near-duplicate (observed live 2026-07-04, session 21e34616 / task
// a26806c1). We therefore DEFER on UNKNOWN and only reclaim after this bounded grace, so a
// transient/remote absence never triggers a false reclaim while a genuinely-lost completion is
// still eventually recovered. A GENERATING or IDLE_CONFIRMED verdict (locally-present positive
// evidence) resets/bypasses the grace — see recoverStrandedAssignedDispatches.
const RECLAIM_UNKNOWN_GRACE_TICKS = 3;

// Per-row consecutive-UNKNOWN streak for delivered-no-turn reclaim, keyed `${meshId}::${taskId}`.
// In-memory (per process); pruned each pass to the set of currently-assigned rows so a
// completed/reclaimed/claimed-elsewhere row's counter is dropped (no unbounded growth).
const deliveredNoTurnUnknownStreak = new Map<string, number>();

// DELIVERED-NOT-CONSUMED-REDRIVE (fix d): the SHORT-grace re-drive (delivered-but-unconsumed,
// 25s window) previously reclaimed on a SINGLE non-GENERATING tick — and a REMOTE worker's local
// busy verdict is UNKNOWN, not GENERATING, so a genuinely-mid-turn remote worker whose ack merely
// hadn't propagated yet was torn off its task and the SAME prompt re-injected. Give the short path
// the same bounded consecutive-UNKNOWN grace the long delivered-no-turn path uses: only an
// IDLE_CONFIRMED verdict (positive LOCAL evidence the session is present-and-idle) re-drives
// immediately; UNKNOWN accrues a streak and re-drives only after RECLAIM_UNKNOWN_GRACE_TICKS.
const deliveredUnconsumedUnknownStreak = new Map<string, number>();

// Test hook: clear the delivered-no-turn UNKNOWN streaks between cases.
export function __resetReclaimUnknownStreakForTests(): void {
    deliveredNoTurnUnknownStreak.clear();
    deliveredUnconsumedUnknownStreak.clear();
}

// APPROVAL-INBOX-BLINDSPOT (Fix A.3): true when the assigned row's bound session is, per the
// LIVE mesh-node snapshots, sitting at an approval modal (waiting_approval). A REMOTE worker
// blocked on an approval reads UNKNOWN from resolveSessionBusyVerdict (it is not in THIS
// daemon's local instance map), so without this guard the delivered-no-turn / delivered-not-
// consumed UNKNOWN streak advances toward a false reclaim that tears the worker off a task it
// is legitimately paused on awaiting the coordinator's mesh_approve. The live status is read
// from the same node session snapshots mesh_status / the active-work builder use, so it is
// positive cross-daemon evidence (not a local-only observation). When present it HOLDS the row
// without accruing the streak; the reclaim resumes normally once the approval clears.
function assignedRowLiveStatusIsAwaitingApproval(
    mesh: { nodes?: any[] },
    nodeId?: string | null,
    sessionId?: string | null,
): boolean {
    if (!nodeId || !sessionId) return false;
    try {
        return sessionStatusFromNodes(mesh.nodes, nodeId, sessionId).status === 'awaiting_approval';
    } catch {
        return false;
    }
}

// PHASE 2.5 — assigned-stranded dispatch watchdog (Bug B). claimNextTask atomically
// flips a row to 'assigned' BEFORE the fire-and-forget dispatch runs. If that dispatch
// neither rejects (→ no .catch requeue) nor is confirmed delivered — a relay that hangs
// without acking, or a confirm timer lost across a restart — the row stays 'assigned'
// forever: it contributes 0 pending, so PHASE 3 (gated on pendingQueueTaskCount>0) never
// re-examines it, and nothing but a manual requeue clears it. This is that missing net.
//
// Regression guard: a row whose delivery IS confirmed (delivered/acked/completed) is a
// genuinely in-flight (or completion-lost) task — left to PHASE 4's completion reconcile,
// never reclaimed here. And the deadline is generous so a slow-but-live dispatch still in
// its normal confirm window is never reclaimed early. Reclaimed rows return to 'pending'
// with ownership cleared, so the PHASE 3 trigger below re-dispatches them this same tick.
async function recoverStrandedAssignedDispatches(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    store: MeshRuntimeStore,
): Promise<void> {
    const meshId = mesh.id;
    const assigned = getQueue(meshId, { status: ['assigned'] });
    if (!assigned.length) return;
    const nowMs = Date.now();
    // RECLAIM-FALSEPOS: prune UNKNOWN streaks for rows of THIS mesh that are no longer
    // 'assigned' (completed / reclaimed / claimed elsewhere) so the counter map cannot grow
    // unbounded and a re-used task id starts its grace fresh.
    const assignedKeys = new Set(assigned.map(r => `${meshId}::${r.id}`));
    const meshKeyPrefix = `${meshId}::`;
    for (const key of [...deliveredNoTurnUnknownStreak.keys()]) {
        if (key.startsWith(meshKeyPrefix) && !assignedKeys.has(key)) deliveredNoTurnUnknownStreak.delete(key);
    }
    for (const key of [...deliveredUnconsumedUnknownStreak.keys()]) {
        if (key.startsWith(meshKeyPrefix) && !assignedKeys.has(key)) deliveredUnconsumedUnknownStreak.delete(key);
    }
    for (const row of assigned) {
        const dispatchedAtMs = Date.parse(row.dispatchTimestamp ?? '');
        if (!Number.isFinite(dispatchedAtMs)) continue;              // no dispatch ts → can't age it
        const ageMs = nowMs - dispatchedAtMs;
        // DELIVERED-NOT-CONSUMED short-grace re-drive (remote autoLaunch delivered≠consumed gap).
        // Runs BEFORE the ASSIGNED_STRANDED_DEADLINE_MS confirm-window gate below because its whole
        // point is to recover a delivered-but-unconsumed row well inside that window. A remote
        // autoLaunch marks the dispatch delivered (transport acked) but the worker may never emit
        // agent:generating_started — the delivery then sits 'delivered' and never flips to 'acked',
        // so the task is stranded 'assigned' with no live turn. This branch re-opens exactly that
        // row after a short grace:
        //   - the delivery IS confirmed handed off (taskHasConfirmedDelivery) but was NEVER consumed
        //     (!taskDeliveryConsumed → no 'acked'/'completed' delivery) — the cross-daemon "worker
        //     never started the turn" signal, valid even for a REMOTE session whose local busy
        //     verdict is UNKNOWN;
        //   - AND the busy verdict is NOT GENERATING — a locally-present generating session IS
        //     consuming (ack lost/late), so never touch it (regression guard against tearing a live
        //     worker off its turn);
        //   - AND no terminal ledger evidence exists (the completion already landed → leave it).
        // reclaimStrandedAssignedTask returns the row to 'pending' (bounded by MAX_STRANDED_RECLAIMS)
        // so PHASE 3 re-dispatches it this same tick onto a fresh idle session — idempotent: it only
        // mutates a still-'assigned' row, so a completion/ack that raced in already moved the row off
        // 'assigned' and this is a no-op.
        if (
            ageMs >= ASSIGNED_DELIVERED_UNCONSUMED_REDRIVE_MS
            && ageMs < ASSIGNED_STRANDED_DEADLINE_MS
            && store.taskHasConfirmedDelivery(meshId, row.id)
            && !store.taskDeliveryConsumed(meshId, row.id)
        ) {
            const terminal = findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id });
            if (terminal) {
                const status = terminal.kind === 'task_completed' ? 'completed' : 'failed';
                updateTaskStatus(meshId, row.id, status);
                continue;
            }
            const shortStreakKey = `${meshId}::${row.id}`;
            const verdict = row.assignedSessionId
                ? resolveSessionBusyVerdict(components, row.assignedSessionId)
                : 'IDLE_CONFIRMED'; // no session bound → nothing live generating to protect
            // GENERATING → demonstrably alive: never re-drive, reset the grace.
            // IDLE_CONFIRMED → positive LOCAL evidence the session is present-and-idle: re-drive now.
            // UNKNOWN → remote / gone / id-form-skewed session: DEFER. A remote worker whose ack
            //   merely hasn't propagated reads UNKNOWN here — reclaiming on a single UNKNOWN tick
            //   tears a live remote worker off its task and re-injects the same prompt (the exact
            //   delivered_not_consumed_redrive symptom). Accrue a bounded consecutive-UNKNOWN streak
            //   and only re-drive after RECLAIM_UNKNOWN_GRACE_TICKS, matching the long path.
            if (verdict === 'GENERATING') {
                deliveredUnconsumedUnknownStreak.delete(shortStreakKey);
            } else {
                if (verdict === 'IDLE_CONFIRMED') {
                    deliveredUnconsumedUnknownStreak.delete(shortStreakKey);
                } else if (assignedRowLiveStatusIsAwaitingApproval(mesh, row.assignedNodeId, row.assignedSessionId)) {
                    // APPROVAL-INBOX-BLINDSPOT (Fix A.3): the UNKNOWN (remote) worker is live and
                    // sitting at an approval modal — it is legitimately paused awaiting the
                    // coordinator's mesh_approve, NOT a lost delivery. HOLD without advancing the
                    // streak so a genuine approval-blocked worker is never re-driven out from
                    // under its pending approval.
                    traceMeshEventDrop('short_redrive_deferred_awaiting_approval', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:waiting_approval',
                    }, 'live_awaiting_approval');
                    continue;
                } else {
                    const streak = (deliveredUnconsumedUnknownStreak.get(shortStreakKey) ?? 0) + 1;
                    deliveredUnconsumedUnknownStreak.set(shortStreakKey, streak);
                    if (streak < RECLAIM_UNKNOWN_GRACE_TICKS) {
                        traceMeshEventDrop('short_redrive_deferred_unknown_verdict', {
                            taskId: row.id,
                            sessionId: row.assignedSessionId,
                            nodeId: row.assignedNodeId,
                            meshId,
                            event: 'agent:generating_started',
                        }, `unknown ${streak}/${RECLAIM_UNKNOWN_GRACE_TICKS}`);
                        continue;
                    }
                }
                const redriven = reclaimStrandedAssignedTask(meshId, row.id, {
                    reason: 'delivered_not_consumed_redrive',
                    ageMs,
                });
                if (redriven) {
                    deliveredUnconsumedUnknownStreak.delete(shortStreakKey);
                    LOG.warn('MeshReconcile', `Re-drove delivered-but-unconsumed task ${row.id} on mesh ${meshId} `
                        + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}, delivered but no `
                        + `generating_started in ${Math.round(ageMs / 1000)}s, verdict ${verdict} → ${redriven.status})`);
                    traceMeshEventDrop('assigned_delivered_not_consumed_redrive', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_started',
                    }, `delivered_not_consumed ${Math.round(ageMs / 1000)}s → ${redriven.status}`);
                    continue;
                }
            }
        }
        if (ageMs < ASSIGNED_STRANDED_DEADLINE_MS) continue;  // still in confirm window
        const terminal = findTerminalLedgerEvidenceForTask({
            meshId,
            taskId: row.id,
        });
        if (terminal) {
            const status = terminal.kind === 'task_completed' ? 'completed' : 'failed';
            updateTaskStatus(meshId, row.id, status);
            LOG.warn('MeshReconcile', `Skipped stranded reclaim redispatch for terminal task ${row.id} on mesh ${meshId}; ${terminal.kind} ledger evidence already exists`);
            traceMeshEventDrop('assigned_stranded_terminal_ledger', {
                taskId: row.id,
                sessionId: row.assignedSessionId,
                nodeId: row.assignedNodeId,
                meshId,
                event: 'agent:generating_completed',
            }, terminal.kind);
            continue;
        }
        if (store.taskHasConfirmedDelivery(meshId, row.id)) {
            // COMPLETION-PROPAGATION F3 (delivered-but-lost completion): the dispatch WAS
            // confirmed handed to a worker (delivered/acked) but no terminal completion ever
            // landed and none is in the ledger (checked just above). Normally this is PHASE 4's
            // job, but PHASE 4 only covers direct-dispatch rows / a live re-read; a claim-path
            // queue row whose completion event was lost (the manual-launch flip-miss signature)
            // sits 'assigned' forever.
            //
            // RECLAIM-FALSEPOS tri-state verdict: the reclaim used to gate ONLY on
            // isSessionActivelyGenerating(), whose local instance lookup returns "not generating"
            // for a REMOTE (or id-form-skewed) session that is genuinely mid-turn — so such a
            // worker was reclaimed at the deadline and re-launched same tick (near-duplicate
            // execution; observed live 2026-07-04, session 21e34616 / task a26806c1). Resolve an
            // explicit GENERATING / IDLE_CONFIRMED / UNKNOWN verdict instead:
            //   - GENERATING     → worker demonstrably alive; never reclaim, reset grace.
            //   - IDLE_CONFIRMED → positive LOCAL evidence (present instance, inactive) → reclaim
            //                      now (past deadline) with the delivered-no-turn reason.
            //   - UNKNOWN        → session not locally observable (remote / gone / id-skew). Do
            //                      NOT fold into a definitive idle. DEFER: count consecutive
            //                      UNKNOWN ticks and only reclaim after RECLAIM_UNKNOWN_GRACE_TICKS
            //                      so a live remote worker is never torn off its task on a single
            //                      absent observation; a genuinely-lost completion is still
            //                      recovered after the bounded grace.
            // reclaimStrandedAssignedTask ends the single-flight window (F4), so a subsequent
            // re-dispatch/requeue is unblocked.
            if (nowMs - dispatchedAtMs < DELIVERED_NO_TURN_DEADLINE_MS) continue;   // still within turn budget
            const streakKey = `${meshId}::${row.id}`;
            const verdict = row.assignedSessionId
                ? resolveSessionBusyVerdict(components, row.assignedSessionId)
                : 'IDLE_CONFIRMED'; // no session bound → nothing live to protect
            if (verdict === 'GENERATING') {
                deliveredNoTurnUnknownStreak.delete(streakKey); // demonstrably alive → reset grace
                continue;  // worker still working
            }
            let reclaimReason: 'delivered_no_turn_deadline' | 'reclaim_after_unknown_grace';
            if (verdict === 'IDLE_CONFIRMED') {
                deliveredNoTurnUnknownStreak.delete(streakKey);
                reclaimReason = 'delivered_no_turn_deadline';
            } else if (assignedRowLiveStatusIsAwaitingApproval(mesh, row.assignedNodeId, row.assignedSessionId)) {
                // APPROVAL-INBOX-BLINDSPOT (Fix A.3): the UNKNOWN (remote) worker is live and
                // sitting at an approval modal — legitimately paused awaiting the coordinator's
                // mesh_approve, NOT a delivered-but-lost completion. HOLD without advancing the
                // streak so a genuine approval-blocked worker is never reclaimed at the
                // delivered-no-turn deadline. The reclaim resumes normally once the approval
                // clears (the live status leaves waiting_approval).
                traceMeshEventDrop('reclaim_deferred_awaiting_approval', {
                    taskId: row.id,
                    sessionId: row.assignedSessionId,
                    nodeId: row.assignedNodeId,
                    meshId,
                    event: 'agent:waiting_approval',
                }, 'live_awaiting_approval');
                continue;
            } else {
                // UNKNOWN — defer and accumulate the consecutive-UNKNOWN streak.
                const streak = (deliveredNoTurnUnknownStreak.get(streakKey) ?? 0) + 1;
                deliveredNoTurnUnknownStreak.set(streakKey, streak);
                if (streak < RECLAIM_UNKNOWN_GRACE_TICKS) {
                    // Still within grace — hold this tick. Content-free trace (ids + streak only).
                    traceMeshEventDrop('reclaim_deferred_unknown_verdict', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_completed',
                    }, `unknown ${streak}/${RECLAIM_UNKNOWN_GRACE_TICKS}`);
                    continue;
                }
                reclaimReason = 'reclaim_after_unknown_grace';
            }
            // TASK-PROMPT-REDRIVE-AFTER-COMPLETE (Fix A-i): before re-driving, poll the worker
            // transcript for terminal evidence — the SAME check PHASE 4 does for direct dispatches,
            // now for this claim-path queue row. An autoLaunch/worktree worker's
            // generating_started/completed events don't reliably reach the coordinator ledger, so
            // the ledger check above (findTerminalLedgerEvidenceForTask) can be empty at the 15-min
            // deadline for a task the worker actually FINISHED — and re-driving then re-injects the
            // same prompt into the already-idle worker (the owner's symptom). If the worker is idle
            // with a final assistant summary dated after dispatch, the task is done: flip it
            // 'completed' instead of reclaiming. Conservative by construction (mid-turn / no
            // summary / stale summary / unreadable → null → fall through to the reclaim below), so
            // this can only PREVENT a wrong re-drive, never invent a completion. Runs only at the
            // deadline (rare), so the extra read is not a hot-path cost.
            const terminalEvidence = await pollAssignedTaskTerminalEvidence(components, mesh, row);
            if (terminalEvidence) {
                deliveredNoTurnUnknownStreak.delete(streakKey);
                // updateTaskStatus ends the single-flight dispatch window on any transition off
                // 'assigned', so a later requeue/re-dispatch is never blocked by a stale mark.
                updateTaskStatus(meshId, row.id, terminalEvidence);
                if (!findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id })) {
                    try {
                        appendLedgerEntry(meshId, {
                            kind: terminalEvidence === 'completed' ? 'task_completed' : 'task_failed',
                            nodeId: row.assignedNodeId,
                            sessionId: row.assignedSessionId,
                            providerType: row.assignedProviderType,
                            payload: {
                                taskId: row.id,
                                event: 'agent:generating_completed',
                                source: 'redrive_deadline_transcript_evidence',
                            },
                        });
                    } catch { /* best-effort ledger write */ }
                }
                LOG.warn('MeshReconcile', `Skipped delivered-no-turn re-drive for task ${row.id} on mesh ${meshId} `
                    + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}): worker transcript is idle with a `
                    + `final assistant message after dispatch — the completion event was lost/late, task is ${terminalEvidence}, NOT re-driving`);
                traceMeshEventDrop('redrive_deadline_transcript_completed', {
                    taskId: row.id,
                    sessionId: row.assignedSessionId,
                    nodeId: row.assignedNodeId,
                    meshId,
                    event: 'agent:generating_completed',
                }, `${reclaimReason} → transcript ${terminalEvidence}`);
                continue;
            }
            const reclaimedLost = reclaimStrandedAssignedTask(meshId, row.id, {
                reason: reclaimReason,
                ageMs: nowMs - dispatchedAtMs,
            });
            if (reclaimedLost) {
                deliveredNoTurnUnknownStreak.delete(streakKey);
                LOG.warn('MeshReconcile', `Reclaimed delivered-but-lost task ${row.id} on mesh ${meshId} `
                    + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}, delivered but no `
                    + `completion in ${Math.round((nowMs - dispatchedAtMs) / 1000)}s, verdict ${verdict} → ${reclaimReason} → ${reclaimedLost.status})`);
                traceMeshEventDrop('assigned_stranded_delivered_no_turn', {
                    taskId: row.id,
                    sessionId: row.assignedSessionId,
                    nodeId: row.assignedNodeId,
                    meshId,
                    event: 'agent:generating_completed',
                }, `delivered ${Math.round((nowMs - dispatchedAtMs) / 1000)}s ${reclaimReason} → ${reclaimedLost.status}`);
            }
            continue;
        }
        const reclaimed = reclaimStrandedAssignedTask(meshId, row.id, {
            reason: 'assigned_stranded_dispatch_unconfirmed',
            ageMs: nowMs - dispatchedAtMs,
        });
        if (reclaimed) {
            LOG.warn('MeshReconcile', `Reclaimed stranded assigned task ${row.id} on mesh ${meshId} `
                + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}, dispatched `
                + `${Math.round((nowMs - dispatchedAtMs) / 1000)}s ago, never confirmed delivered → ${reclaimed.status})`);
            // EVTTRACE: the dispatch for this task was stranded (assigned, never confirmed
            // delivered) and reclaimed (CANON-B) — its expected completion event never
            // arrived. Observation only; the reclaim decision above is unchanged.
            traceMeshEventDrop('assigned_stranded_reclaim', {
                taskId: row.id,
                sessionId: row.assignedSessionId,
                nodeId: row.assignedNodeId,
                meshId,
                event: 'agent:generating_completed',
            }, `unconfirmed ${Math.round((nowMs - dispatchedAtMs) / 1000)}s → ${reclaimed.status}`);
        }
    }
}

// ── PHASE 2.6: assigned-zombie sweep (runtime-store GC, SoT 1-11 (a)) ─────────
// recoverStrandedAssignedDispatches (PHASE 2.5) can only age a row by its
// dispatchTimestamp — a row that never got one (a legacy claim, a crashed claim
// path, a row whose payload drifted) is invisible to it FOREVER: it contributes 0
// pending (PHASE 3 skips), holds the node-busy gate (hasActiveNodeAssignment), and
// nothing ever transitions it. This sweep is that missing terminal net, scoped
// PRECISELY to the rows PHASE 2.5 can never touch (no parseable dispatchTimestamp)
// so the two nets never race each other over the same row.
//
// Conservative by construction:
//   - age-gated on updatedAt/createdAt (>= ZOMBIE_ASSIGNED_MIN_AGE_MS) so a freshly
//     claimed row mid-launch is never touched;
//   - terminal ledger evidence wins first (row flips to the evidenced terminal,
//     mirroring PHASE 2.5's terminal branch);
//   - only fails a row whose assigned session is POSITIVELY absent on the daemon
//     that owns the assigned node — a locally-present session (idle or generating)
//     is skipped, and a REMOTE node's session (not locally observable) is skipped
//     entirely rather than guessed dead;
//   - the failure reason is explicit in both the queue mutation trace and a
//     task_failed ledger entry, so the transition is auditable, never silent.
const ZOMBIE_ASSIGNED_MIN_AGE_MS = 30 * 60 * 1000; // 30 min — generous vs. session launch/restart races

export function reconcileZombieAssignedTasks(
    components: DaemonComponents,
    mesh: { id: string; nodes?: unknown[] },
    selfIds: string[],
): void {
    const meshId = mesh.id;
    const assigned = getQueue(meshId, { status: ['assigned'] });
    if (!assigned.length) return;
    const nowMs = Date.now();

    // True when THIS daemon is authoritative for the row's assigned node — the only
    // case where "no local instance" positively means "session no longer exists".
    // Accepts a daemon-id form match against selfIds, or a mesh-node whose daemonId
    // resolves to this daemon. Absent assignedNodeId → local (nothing remote to defer to).
    const assignedNodeIsLocal = (assignedNodeId?: string): boolean => {
        if (!assignedNodeId) return true;
        if (selfIds.some(id => daemonIdsEquivalent(id, assignedNodeId))) return true;
        const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : [];
        const node = nodes.find(n => meshNodeIdMatches(n as never, assignedNodeId)) as { daemonId?: unknown } | undefined;
        const nodeDaemonId = readNonEmptyString(node?.daemonId);
        return !!nodeDaemonId && selfIds.some(id => daemonIdsEquivalent(id, nodeDaemonId));
    };

    for (const row of assigned) {
        // Rows WITH a parseable dispatchTimestamp belong to PHASE 2.5 — never double-handle.
        if (Number.isFinite(Date.parse(row.dispatchTimestamp ?? ''))) continue;
        const updatedMs = Date.parse(row.updatedAt ?? '');
        const createdMs = Date.parse(row.createdAt ?? '');
        const anchorMs = Number.isFinite(updatedMs) ? updatedMs : createdMs;
        if (!Number.isFinite(anchorMs)) continue;              // cannot age it → leave untouched
        if (nowMs - anchorMs < ZOMBIE_ASSIGNED_MIN_AGE_MS) continue;

        // A terminal already evidenced in the ledger → flip the row to that terminal
        // (the completion arrived but the queue flip was lost), same as PHASE 2.5.
        const terminal = findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id });
        if (terminal) {
            const status = terminal.kind === 'task_completed' ? 'completed' : 'failed';
            updateTaskStatus(meshId, row.id, status);
            LOG.warn('MeshReconcile', `Zombie assigned task ${row.id} on mesh ${meshId} had ${terminal.kind} ledger evidence — flipped to ${status}`);
            continue;
        }

        if (!assignedNodeIsLocal(row.assignedNodeId)) continue; // remote session not locally observable — never guess
        if (row.assignedSessionId) {
            const verdict = resolveSessionBusyVerdict(components, row.assignedSessionId);
            if (verdict !== 'UNKNOWN') continue; // session exists locally (idle or busy) → not a zombie
        }

        const reason = row.assignedSessionId
            ? 'assigned_zombie_session_missing'
            : 'assigned_zombie_no_session_bound';
        const failed = updateTaskStatus(meshId, row.id, 'failed');
        if (!failed) continue;
        try {
            appendLedgerEntry(meshId, {
                kind: 'task_failed',
                nodeId: row.assignedNodeId,
                sessionId: row.assignedSessionId,
                payload: {
                    taskId: row.id,
                    reason,
                    source: 'reconcile_zombie_assigned_sweep',
                    ageMs: nowMs - anchorMs,
                },
            });
        } catch { /* ledger write is best-effort */ }
        LOG.warn('MeshReconcile', `Failed zombie assigned task ${row.id} on mesh ${meshId} `
            + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}, no dispatchTimestamp, `
            + `stale ${Math.round((nowMs - anchorMs) / 60000)}m, ${reason})`);
        traceMeshEventDrop('assigned_zombie_failed', {
            taskId: row.id,
            sessionId: row.assignedSessionId,
            nodeId: row.assignedNodeId,
            meshId,
            event: 'agent:generating_completed',
        }, `${reason} stale=${Math.round((nowMs - anchorMs) / 60000)}m`);
    }
}

export async function runMeshReconcileTick(components: DaemonComponents): Promise<void> {
    const localDaemonId = readNonEmptyString(loadConfig().machineId) || undefined;
    // The id-set used to scope the local queue drain (status id + machineId). See
    // resolveCoordinatorDaemonIds — the status id is what the MCP layer stamps and
    // is mandatory here for a generating CLI coordinator to self-receive completions.
    const drainDaemonIds = resolveCoordinatorDaemonIds(components);
    const dispatchMeshCommand = components.dispatchMeshCommand;
    const store = (() => {
        try { return MeshRuntimeStore.getInstance(); } catch { return undefined; }
    })();

    // ── PHASE 0: retry the worker-side unresolved-delegate forward outbox ──────
    // Cloud-only (needs dispatchMeshCommand). A worker that is NOT a member of the
    // coordinator's mesh cannot be reached by the coordinator's PHASE 1 pull (it is
    // in no mesh.node), so its completion must be PUSHED to the coordinator. This
    // drains the durable outbox enqueued by forwardUnresolvedDelegateEvent and retries
    // any push that has not yet been acked. Since the spontaneous immediate push was
    // removed (polling single-model §2.1), this PHASE 0 retry is the ONLY delivery
    // path for unresolved-delegate events; the enqueue site nudges an early run of it
    // (scheduleUnresolvedForwardNudge) so happy-path latency stays sub-interval.
    // See mesh-unresolved-forward-outbox.ts.
    if (dispatchMeshCommand) {
        try {
            await retryUnresolvedDelegateForwards(components);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Unresolved-delegate forward retry failed: ${e?.message || e}`);
        }
    }

    // ── PHASE 1: pull remote node queues for every mesh this daemon hosts ──────
    // Cloud-only (dispatchMeshCommand present). Runs whether or not a live CLI
    // coordinator exists — this is what lets an MCP/LLM coordinator ever see a
    // remote worker's completion.
    if (dispatchMeshCommand) {
        for (const mesh of listMeshes()) {
            // Expand to every id-form this daemon answers to for this mesh (runtime
            // drain ids ∪ config-form node/host ids) and use it for BOTH the host gate
            // and the remote pull filter, so a worker stamp in any form is recovered.
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await pullRemoteNodeQueues(components, mesh, localDaemonId, selfIds);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Remote node pull failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 2.5: assigned-stranded dispatch watchdog (Bug B) ─────────────────
    // Runs before PHASE 3 so any row it returns to 'pending' is re-dispatched by the
    // PHASE 3 trigger in this same tick. See recoverStrandedAssignedDispatches.
    if (store) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await recoverStrandedAssignedDispatches(components, mesh, store);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Assigned-stranded watchdog failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
            // PHASE 2.6 — assigned-zombie sweep: terminal-fails the rows PHASE 2.5
            // can never age (no dispatchTimestamp) whose session is positively gone.
            try {
                reconcileZombieAssignedTasks(components, mesh, selfIds);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Assigned-zombie sweep failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 2.6: DS3 coordinator local catch-up ──────────────────────────────
    // Drain `coordinator_catchup` markers a remote node's Refinery queued after pushing
    // the base to origin, and guarded-ff this daemon's own coordinator base checkout up to
    // the pushed commit (busy → deferred to a later tick; ahead/diverged/dirty → the ff
    // helper structured-blocks, never rebases). Runs for EVERY mesh this daemon hosts
    // (not gated on continuous mode) and BEFORE PHASE 3 so a caught-up base is current
    // before any new task is dispatched. No markers → immediate no-op.
    for (const mesh of listMeshes()) {
        const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
        if (!daemonHostsMesh(mesh, selfIds)) continue;
        try {
            await runPendingCoordinatorCatchupScan(components, mesh);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Coordinator catch-up scan failed for mesh ${mesh.id}: ${e?.message || e}`);
        }
    }

    // ── PHASE 2.7: continuous remote auto fast-forward (opt-in, default OFF) ────
    // mode:"continuous" + remoteNodes:true only. Catch up an online/clean/behind
    // REMOTE base node that emits no fresh idle edge (e.g. a long-idle base node while
    // upstream advanced). Runs BEFORE PHASE 3's queue claim so a node it advances is
    // caught up before any new task is dispatched onto it. Cloud-only (dispatchMeshCommand);
    // a per-node cooldown + workspace lease inside the scan keep the 4s cadence from
    // hammering peers. No-op for every mesh that has not opted into continuous mode, so
    // the default (idle-edge only) path is byte-for-byte unchanged.
    if (dispatchMeshCommand) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await runContinuousAutoFastForwardScan(components, mesh);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Continuous auto fast-forward scan failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 3: recover pending queue claims for newly-idle sessions ──────────
    // The event-driven claim paths (agent:ready / agent:generating_completed in
    // mesh-events-coordinator) re-claim the queue the moment a session goes idle,
    // but that depends on a single event being emitted AND (for a remote node)
    // successfully forwarded to this coordinator. If that event is missed/dropped,
    // a pending task targeting a now-idle session would sit unclaimed forever —
    // there was no periodic safety net. This phase is that net: for every mesh this
    // daemon hosts that has at least one pending task, run one triggerMeshQueue so a
    // session that became idle without a delivered ready-event still gets its work.
    //
    // O(1) guard: skip the (relatively expensive) full idle-session + remote-idle
    // scan entirely when the queue has no pending tasks — a COUNT(*) over the
    // indexed status column, so an idle mesh costs one cheap query per tick.
    // claimNextQueueTask is atomic, so racing the event-driven path can only have
    // one winner; double-claiming is impossible.
    // The mesh work-queue is SQLite-only (claimNextQueueTask/countQueueStatus all go
    // through MeshRuntimeStore — there is no JSONL fallback for the QUEUE, only for
    // pending EVENTS drained in PHASE 1/2). So when SQLite is unavailable (store
    // undefined, e.g. better-sqlite3 native load failure on a clean install),
    // triggerMeshQueue can do no useful work — it would only re-throw inside the
    // store and emit the WARN below every tick × mesh count, flooding the logs. Skip
    // the phase entirely in that case; the JSONL event-delivery path is unaffected.
    if (store) {
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                if (store.pendingQueueTaskCount(mesh.id) === 0) continue;
            } catch { /* fall through and let triggerMeshQueue decide */ }
            try {
                await triggerMeshQueue(components, mesh.id);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Pending-claim recovery trigger failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 4: synthesize lost completions for unterminated direct dispatches ─
    // Symmetric to PHASE 3 (which recovers a *lost claim* for a newly-idle session)
    // but for the opposite gap: a worker that ALREADY completed, went idle, and
    // whose terminal completion event was never persisted (dropped before reaching
    // the queue/outbox, or its forward was lost). PHASE 1/2/3 can only deliver an
    // event that exists in a queue — they cannot recover a completion that was
    // never recorded, so the coordinator keeps believing the worker is generating.
    //
    // reconcileDirectDispatchCompletionFromTranscript already synthesizes the
    // missing terminal event from the worker's transcript, but until now it ran
    // ONLY when an LLM coordinator polled mesh_status (mcp_mesh_status_transcript_
    // reconciliation). This phase pulls that same correction onto the daemon timer
    // so it no longer depends on the LLM polling. The reconcile is idempotent
    // (hasTerminalLedgerAfterDispatch guards against re-synthesis), so attempting it
    // every tick for the same dispatch is safe — once a terminal exists it no-ops.
    for (const mesh of listMeshes()) {
        const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
        if (!daemonHostsMesh(mesh, selfIds)) continue;
        try {
            await reconcileUnterminatedDirectDispatches(components, mesh, selfIds, localDaemonId);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Completion reconcile failed for mesh ${mesh.id}: ${e?.message || e}`);
        }
    }

    // ── PHASE 5: auto-prune orphaned direct dispatch records ───────────────────
    // staleDirectWork (orphaned direct-dispatch rows whose node/session is no longer in the
    // live mesh) otherwise accumulates indefinitely: a removed worktree node or a cleanly
    // terminated session leaves its direct-dispatch row behind, stuck in a non-terminal status
    // (e.g. generating) for days. This is NOT a false-idle bug — it is the separate problem of
    // orphaned records that the only existing cleanup path (manual MCP mesh_prune_stale_direct)
    // never reaches unless an operator runs it by hand.
    //
    // This phase runs the SAME prune core the manual tool calls (pruneStaleDirectDispatches),
    // in execute mode, on the daemon timer. The only difference from the manual path is a
    // conservative age gate (DEFAULT_AUTO_PRUNE_MIN_AGE_MS): a freshly-orphaned record is held
    // back until it is provably stale, so a transient probe miss never auto-prunes live work.
    // Every other safety rule is inherited unchanged from the core — active/pending/generating
    // work and fresh unacknowledged dispatch failures are never pruned, ledger-only audit entries
    // are preserved, and the prune itself is recorded with a direct_dispatch_pruned ledger entry.
    // Idempotent: a pruned row is gone from getActiveDirectDispatches, so the next tick finds
    // nothing to re-prune. Isolated in its own try/catch per mesh so it can never kill the tick.
    {
        const minAgeMs = resolveAutoPruneMinAgeMs();
        for (const mesh of listMeshes()) {
            const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
            if (!daemonHostsMesh(mesh, selfIds)) continue;
            try {
                await autoPruneStaleDirectDispatches(components, mesh, selfIds, localDaemonId, minAgeMs);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Auto-prune stale direct failed for mesh ${mesh.id}: ${e?.message || e}`);
            }
        }
    }

    // ── PHASE 2: inject into live CLI coordinators on this daemon ──────────────
    const coordinators = findLiveCoordinators(components);
    if (coordinators.length === 0) {
        // No live CLI coordinator on this daemon — nothing to inject into.
        // (MCP-only LLM coordinators drain the local queue via their own tool
        //  calls; PHASE 1 above has already populated it from remote nodes.)
        return;
    }

    // Group coordinators by mesh; multiple coordinator instances for one mesh is
    // unusual but supported (each gets the same drained events).
    const byMesh = new Map<string, LiveCoordinator[]>();
    for (const c of coordinators) {
        const list = byMesh.get(c.meshId);
        if (list) list.push(c);
        else byMesh.set(c.meshId, [c]);
    }

    for (const [meshId, meshCoordinators] of byMesh) {
        // Drain the local queue scoped to this coordinator daemon and inject.
        //     - If an idle coordinator exists, FULL-drain and deliver every event to it
        //       (the idle input box accepts the prompt as a real next turn). The drain
        //       marks consumed rows drained=1 atomically, so the pull path can't re-deliver.
        //     - If only GENERATING coordinators exist (no idle target), we HOLD: leave the
        //       events queued (drained=0) for the coordinator's next idle/turn-end tick.
        //
        // NOTIF-SURFACE-LOCAL (false-idle hold): we used to force-inject terminal events
        // (completion/approval/stop/refine·bootstrap) straight into a *generating*
        // coordinator's PTY (forceSendMessage → atomic content+\r write), on the theory it
        // bypassed the busy send-guard and broke the await-result deadlock. But a raw PTY
        // write into a claude-cli that is mid-generation is NOT consumed as a new turn — the
        // bytes land in the terminal input buffer and the LLM never reads them on its next
        // turn. The `surfaced/force-inject` trace fired, the row was marked drained=1, and the
        // genuine completion was lost forever (the exact same-daemon local-worktree miss: the
        // coordinator's OWN session is generating at the moment its worker completes). The
        // deadlock the force path guarded against does not actually require force: a
        // coordinator that dispatched a task via mesh_send_task returns to idle when that
        // tool call resolves (dispatch is fire-and-forget; the worker runs for minutes while
        // the coordinator is idle/between turns), so the completion lands on the very next
        // idle tick (≤ one reconcile interval). Holding the event undrained for that idle
        // tick is therefore the single, reliable delivery — and it is the SAME skip-and-hold
        // the modal-park branch below already uses. This also makes double-injection
        // structurally impossible: there is exactly one delivery path (the idle full-drain),
        // so we never need a surface-time fingerprint to dedup a force-write against a re-drain.
        const idleCoordinators = meshCoordinators.filter(c => c.idle);
        // A coordinator parked on a harness modal (waiting_choice / waiting_approval) is
        // non-idle; it is held under the modal-park branch (a force-inject into a modal would
        // write raw keystrokes the modal key handler eats, silently selecting a choice the
        // user never made). A plainly-generating coordinator (non-idle, non-modal-parked) is
        // ALSO held now — for the false-idle reason above — but separately, so the C1 ledger
        // audit and the operator-facing skip log can name the right hold reason.
        const generatingCoordinators = meshCoordinators.filter(c => !c.idle && !c.modalParked);
        const modalParkedCoordinators = meshCoordinators.filter(c => !c.idle && c.modalParked);
        // Only an IDLE coordinator is a deliverable target. A generating coordinator's PTY
        // does not consume an injected prompt as a turn, so it is held (not a target).
        const targetCoordinators = idleCoordinators;

        // ── no-idle-target short-circuit (MUST precede the drain) ─────────────────
        // When there is no IDLE coordinator for this mesh — only generating and/or
        // modal-parked ones — there is nowhere a queued event can land as a real turn.
        // We skip-and-hold: by NOT draining we leave the events at drained=0 in the queue,
        // so a later tick (once a coordinator returns to idle) delivers them. This
        // short-circuit MUST run BEFORE drainPendingMeshCoordinatorEvents — the drain marks
        // rows drained=1 atomically, which would lose the events for a coordinator that is
        // only transiently busy (the false-idle local-worktree miss). Both the generating
        // hold and the modal-park hold record a C1 ledger audit copy so a held completion's
        // worker summary is recoverable even if the coordinator never returns or the pending
        // file is later trimmed.
        if (targetCoordinators.length === 0) {
            // ── APPROVAL-Q1-REALTIME: level-deliver approval nudges BEFORE the hold ──
            // Approval events are LEVEL-backed (task_approval_needed ledger →
            // mesh_status awaiting_approval), so they must not be edge-held like a
            // completion (whose payload lives only in the pending event). Drain and
            // deliver them to the busy coordinator's inbox (non-force, next-turn-boundary)
            // this tick, dropping any already-resolved (stale) nudge — and leave ONLY the
            // completion/other events in the queue for the existing hold semantics below
            // (their behaviour is unchanged: shouldForceInjectMeshEvent no longer sees the
            // approval rows because this drained them). MUST run first so the modal-park
            // orphan-escape and the generating-hold audit only ever see non-approval events.
            drainAndDeliverApprovalNudges(meshId, drainDaemonIds, localDaemonId, meshCoordinators);
            // If approval nudges were the only queued events, nothing remains to hold — skip
            // the hold branches (and their "holding pending event(s)" log) entirely.
            if (store) {
                try { if (store.pendingEventCount(meshId) === 0) continue; } catch { /* fall through */ }
            }
            if (modalParkedCoordinators.length > 0) {
                // ── orphan escape (MUST precede the blanket modal-park hold) ──────────
                // A modal-parked coordinator with no idle/generating sibling otherwise
                // wedges EVERY pending event under `modal_parked` until that modal resolves
                // — including a STRICT-routed completion whose originating coordinator
                // session is GONE (an orphan: the worktree/session that produced it was
                // removed, or that coordinator session died). Such an event will never be
                // deliverable to its target session no matter what the modal-parked sibling
                // does, so holding it under modal_parked is a permanent-held leak (the very
                // "data restart re-reproduces it" symptom — the gate is reconstructed live
                // from the still-parked modal, so a restart does not clear it). Route those
                // orphan events through the strict-route hold/expire path so the bounded
                // STRICT_SESSION_MATCH_TTL eventually expires them (recoverable, ledgered)
                // instead of leaving them held forever. A strict event whose target session
                // IS live but merely modal-parked is left to the blanket hold below (it is
                // genuinely transiently blocked, not orphaned).
                const liveSessionIds = new Set(
                    meshCoordinators.map(c => readNonEmptyString(c.sessionId)).filter(Boolean),
                );
                let orphanEscaped = 0;
                const hasPendingForOrphanPeek = !store
                    || (() => { try { return store.pendingEventCount(meshId) > 0; } catch { return true; } })();
                if (hasPendingForOrphanPeek) {
                    // Identify which pending event NAMES correspond to orphan-targeted events
                    // (a strict targetCoordinatorSessionId that matches no live coordinator).
                    let peeked: readonly PendingMeshCoordinatorEvent[] = [];
                    try {
                        peeked = getPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
                    } catch { peeked = []; }
                    const isOrphan = (e: PendingMeshCoordinatorEvent): boolean => {
                        const want = readNonEmptyString(e.targetCoordinatorSessionId);
                        return !!want && !liveSessionIds.has(want);
                    };
                    const orphanEventNames = new Set(peeked.filter(isOrphan).map(e => e.event));
                    if (orphanEventNames.size > 0) {
                        // The drain filter is event-NAME scoped (not per-row), so draining by the
                        // orphan event names also pulls any non-orphan event sharing that name. Drain
                        // them all, then re-route: orphan-targeted events go through the strict-route
                        // hold/expire path (bounded TTL → eventually ledger-expired, recoverable);
                        // non-orphan events of the same name are re-queued unchanged (queuedAt
                        // preserved) so they remain genuinely held for their still-live, modal-parked
                        // target. This is the same per-event strict routing PHASE 2 does below — just
                        // reached here because the blanket modal-park short-circuit would otherwise
                        // wedge the orphans forever.
                        let drained: PendingMeshCoordinatorEvent[] = [];
                        try {
                            drained = drainPendingMeshCoordinatorEvents(
                                meshId,
                                drainDaemonIds.length > 0 ? drainDaemonIds : localDaemonId,
                                { onlyEvents: orphanEventNames },
                            );
                        } catch (e: any) {
                            LOG.warn('MeshReconcile', `Orphan-escape drain failed for mesh ${meshId}: ${e?.message || e}`);
                            drained = [];
                        }
                        for (const pending of drained) {
                            if (isOrphan(pending)) {
                                holdOrExpireStrictUnmatchedEvent(pending, readNonEmptyString(pending.targetCoordinatorSessionId), meshId);
                                orphanEscaped++;
                            } else {
                                // Still-live (modal-parked) target — re-queue unchanged so it is held
                                // for the next modal-resolved tick, exactly like the blanket hold would.
                                try { queuePendingMeshCoordinatorEvent(pending); } catch { /* best-effort re-queue */ }
                            }
                        }
                    }
                }
                LOG.info('MeshReconcile', `Reconcile skip → modal-parked: holding pending event(s) for mesh ${meshId} (${modalParkedCoordinators.length} coordinator(s) awaiting a modal answer; events left queued${orphanEscaped > 0 ? `; ${orphanEscaped} orphan-targeted event(s) routed to strict-route TTL` : ''})`);
                // NOTIF (B) diagnostic: name the session(s) classified modal-parked so the
                // same-tick coordDiag line (paired by sessionId) shows whether the modal-park
                // overlay is a real human-await or an unreleased mask (the getState_overlay origin).
                if (getLogLevel() === 'debug') {
                    LOG.debug('MeshReconcile', `coordHoldModalParked mesh=${meshId} heldFor=[${modalParkedCoordinators.map(c => c.sessionId || '?').join(',')}] (these were classified modal-parked; cross-ref same-tick coordDiag by sessionId)`);
                }
                // C1: mirror held terminal events into the ledger so a held completion's
                // worker summary is auditable/recoverable even if the modal is never
                // resolved, the coordinator restarts, or the pending file is later trimmed.
                // The events stay queued (drained=0) for re-drain on a later tick; this only
                // adds the durable audit copy. Idempotent per process — only newly-held
                // events are logged. O(1)-gated: skip the peek when the queue is empty.
                let hasPending = true;
                if (store) {
                    try { hasPending = store.pendingEventCount(meshId) > 0; } catch { /* peek below */ }
                }
                if (hasPending) {
                    recordHeldTerminalEventsToLedger(
                        meshId,
                        drainDaemonIds.length > 0 ? drainDaemonIds : (localDaemonId ? [localDaemonId] : []),
                        'modal_parked',
                        modalParkedCoordinators.length,
                    );
                }
            } else if (generatingCoordinators.length > 0) {
                // ── generating hold (NOTIF-SURFACE-LOCAL false-idle fix) ─────────────
                // The only coordinator(s) for this mesh are plainly generating (no idle, no
                // modal). A raw force-write into a generating claude-cli PTY is not consumed
                // as a turn, so we do NOT inject and do NOT drain — the events stay queued
                // (drained=0) and the next tick that finds the coordinator idle full-drains
                // them as real turns (the coordinator returns to idle when its current
                // tool-call/turn resolves; a dispatched worker runs for minutes while the
                // coordinator is idle, so this lands within one reconcile interval). C1: mirror
                // any held terminal events into the ledger so a completion's worker summary is
                // recoverable even before that idle tick. Idempotent per process; O(1)-gated.
                let hasPending = true;
                if (store) {
                    try { hasPending = store.pendingEventCount(meshId) > 0; } catch { /* peek below */ }
                }
                if (hasPending) {
                    // ── PTY-OVERTRUST-DRAIN (Defect B, fix B): age-based escape ───────────
                    // Fix A already routes the common mask-driven false-busy to the idle path,
                    // so reaching here means the coordinator's RAW adapter reads generating.
                    // That is almost always genuine — but a status-source desync fix A does not
                    // reach can momentarily make the raw adapter read generating while the PTY
                    // is actually at a turn end, stranding the completion across many ticks. As a
                    // TIME-BASED BACKSTOP, once the oldest held terminal event has aged past the
                    // escalate threshold, RE-CONFIRM each held coordinator's raw adapter idle and,
                    // if genuinely idle, drain ONCE into it. The re-confirmation gate is what makes
                    // this safe: it NEVER injects into a genuinely-generating PTY (that is the
                    // data-loss force-inject path intentionally removed). A coordinator still
                    // genuinely generating stays held.
                    const escalateMs = resolvePendingHeldDrainEscalateMs();
                    const heldAgeMs = oldestHeldTerminalEventAgeMs(
                        meshId,
                        drainDaemonIds.length > 0 ? drainDaemonIds : (localDaemonId ? [localDaemonId] : []),
                    );
                    if (heldAgeMs >= escalateMs) {
                        const escapeTargets = reconfirmGenuinelyIdleCoordinators(generatingCoordinators);
                        if (escapeTargets.length > 0) {
                            LOG.info('MeshReconcile', `Reconcile age-escape → generating-hold: held terminal event(s) for mesh ${meshId} aged ${Math.round(heldAgeMs / 1000)}s (≥ ${Math.round(escalateMs / 1000)}s) and ${escapeTargets.length} coordinator(s) re-confirmed genuinely idle on the raw adapter — draining once`);
                            const drained = drainAndInjectIntoTargets(meshId, drainDaemonIds, localDaemonId, escapeTargets, 'age-escape');
                            if (drained > 0) continue; // delivered → no hold this tick
                        }
                    }
                    LOG.info('MeshReconcile', `Reconcile skip → generating: holding pending event(s) for mesh ${meshId} (${generatingCoordinators.length} coordinator(s) busy; events left queued for the next idle tick)`);
                    // NOTIF (B) diagnostic: this is the hold that strands the completion. Name
                    // the sessionId(s) the loop just classified non-idle/non-modal so the
                    // same-tick coordDiag line above (paired by sessionId) reveals which status
                    // source diverged. If a coordDiag for one of these sessions shows getState
                    // (or lastStatus/adapterRaw) === idle, that is the runtime desync origin.
                    if (getLogLevel() === 'debug') {
                        LOG.debug('MeshReconcile', `coordHoldGenerating mesh=${meshId} heldFor=[${generatingCoordinators.map(c => c.sessionId || '?').join(',')}] (these were classified busy; cross-ref same-tick coordDiag by sessionId)`);
                    }
                    recordHeldTerminalEventsToLedger(
                        meshId,
                        drainDaemonIds.length > 0 ? drainDaemonIds : (localDaemonId ? [localDaemonId] : []),
                        'generating_no_idle_coordinator',
                        generatingCoordinators.length,
                    );
                }
            }
            continue;
        }

        // O(1) guard: skip the drain entirely when the queue is empty.
        if (store) {
            try {
                if (store.pendingEventCount(meshId) === 0) {
                    // An idle coordinator is present (the no-idle short-circuit already
                    // `continue`d above) and the pending queue is empty → this mesh is at a
                    // fully-idle edge with nothing to inject. Nudge (once/debounced) if it
                    // still has active missions but no work in flight, so a lingering mission
                    // is not left drifting in 'active'. Best-effort; never blocks the loop.
                    maybeInjectIdleActiveMissionReminder(
                        meshId,
                        targetCoordinators[0].instance,
                        getMesh(meshId)?.policy,
                    );
                    continue;
                }
            } catch { /* fall through to drain */ }
        }

        // An idle coordinator is present (targetCoordinators.length > 0): FULL-drain every
        // queued event and deliver it to the idle input box as a real turn. The no-idle case
        // (generating/modal-only) was already held above and never reaches here, so there is
        // no force-drain-into-generating path left — the single delivery is the idle drain.
        drainAndInjectIntoTargets(meshId, drainDaemonIds, localDaemonId, targetCoordinators, 'idle');
    }
}

// Strict-routing TTL: how long a drained completion whose originating coordinator session
// is not currently deliverable is held (re-queued for re-drain) before it is ledger-
// expired. Bounded so a coordinator session that never returns cannot wedge the event
// forever; broad enough to ride out a transient modal-park / brief restart.
const STRICT_SESSION_MATCH_TTL_MS = 60_000;

// Re-queue (hold) a strict-routed event whose coordinator session is not live, or — once it
// has aged past STRICT_SESSION_MATCH_TTL_MS — ledger-expire it (recoverable) and drop it.
// We deliberately do NOT broadcast an aged-out event to sibling coordinators: that is the
// very misroute strict routing exists to prevent. The drain already marked the row drained=1,
// so re-queuing re-persists a fresh undrained copy (dedup keys on drained=0 only); queuedAt is
// preserved so the TTL measures the event's true age across re-queues.
function holdOrExpireStrictUnmatchedEvent(
    pending: PendingMeshCoordinatorEvent,
    wantSession: string,
    meshId: string,
): void {
    const queuedAt = typeof pending.queuedAt === 'number' ? pending.queuedAt : Date.now();
    if (Date.now() - queuedAt <= STRICT_SESSION_MATCH_TTL_MS) {
        try {
            queuePendingMeshCoordinatorEvent(pending); // preserves queuedAt → true age retained
            LOG.info('MeshReconcile', `Strict route hold: coordinator session ${wantSession} not live on mesh ${meshId} — re-queued (${pending.event})`);
            // EVTTRACE: event held (re-queued) — its originating coordinator session is not
            // currently deliverable. Held, not dropped; surfaces later or expires past TTL.
            traceMeshEventDrop('strict_route_hold', {
                taskId: pending.metadataEvent?.taskId,
                sessionId: pending.metadataEvent?.targetSessionId ?? wantSession,
                nodeId: pending.nodeId,
                meshId,
                event: pending.event,
            }, `coordinatorSession=${wantSession} not live`);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Strict route re-queue failed for ${pending.event} on mesh ${meshId}: ${e?.message || e}`);
        }
        return;
    }
    const finalSummary = readMeshCompletionSummary(pending.metadataEvent || {});
    try {
        appendLedgerEntry(meshId, {
            kind: 'event_held',
            ...(pending.nodeId ? { nodeId: pending.nodeId } : {}),
            payload: {
                event: pending.event,
                reason: 'strict_route_expired',
                recoverable: true,
                targetCoordinatorSessionId: wantSession,
                targetCoordinatorDaemonId: pending.targetCoordinatorDaemonId ?? null,
                nodeLabel: pending.nodeLabel,
                ...(pending.workspace ? { workspace: pending.workspace } : {}),
                queuedAt,
                ...(finalSummary ? { finalSummary } : {}),
            },
        });
        LOG.warn('MeshReconcile', `Strict route expire: coordinator session ${wantSession} never returned for mesh ${meshId} — recorded to ledger (recoverable), dropped (${pending.event})`);
        // EVTTRACE: event expired past the strict-route TTL — dropped (recoverable, ledgered).
        traceMeshEventDrop('strict_route_expired', {
            taskId: pending.metadataEvent?.taskId,
            sessionId: pending.metadataEvent?.targetSessionId ?? wantSession,
            nodeId: pending.nodeId,
            meshId,
            event: pending.event,
        }, `coordinatorSession=${wantSession} never returned`);
    } catch (e: any) {
        LOG.warn('MeshReconcile', `Failed to ledger-expire strict-unmatched ${pending.event} for mesh ${meshId}: ${e?.message || e}`);
    }
}

// Cloud-only: retry the worker-side unresolved-delegate forward outbox. For each
// durably-queued entry, push it to its coordinator daemon over P2P (mesh_forward_event)
// and ack (mark drained) ONLY on a successful, non-rejected response. A failed or
// rejected push leaves the entry queued for the next tick — at-least-once delivery.
// Stale entries (coordinator unreachable past the max age) are expired first so the
// outbox can't grow without bound. The coordinator dedups duplicate deliveries on its
// own fingerprint, so a retry that races the original immediate push is harmless.
// RECONCILE-MESHID-DROP: per-entry count of consecutive HARD rejections (the coordinator
// returned success:false, e.g. "meshId required"). A rejection means the push was delivered
// and deterministically refused — retrying the identical payload every 4s can never succeed,
// so it would loop until the 30-minute age expiry, spamming the log the whole time. After
// MAX_FORWARD_REJECTIONS such rejections we drop the entry (drain it) with ONE fail-loud
// warning. Transient transport failures (the dispatch throws — coordinator momentarily
// unreachable) do NOT count here; those legitimately retry until the age expiry. In-memory
// (keyed by the durable outbox row id) is sufficient: a daemon restart re-arms the loop, and
// the age expiry remains the durable backstop. Cleared whenever an entry is delivered/drained.
const unresolvedForwardRejectionCounts = new Map<string, number>();
const MAX_FORWARD_REJECTIONS = 5;

export function __resetUnresolvedForwardRejectionCountsForTests(): void {
    unresolvedForwardRejectionCounts.clear();
}

// ── Unresolved-forward reconcile nudge (polling single-model §2.1 (B)) ────────
// forwardUnresolvedDelegateEvent no longer pushes the event itself — it only
// persists to the durable outbox and fires a data-free nudge asking THIS loop to
// run the PHASE 0 retry soon. The nudge is:
//   - coalesced: one pending timer at a time, so a completion burst schedules a
//     single early retry pass instead of one per event;
//   - non-overlapping: skipped while a nudged pass is still in flight (the
//     periodic tick remains the backstop);
//   - loss-tolerant: an unregistered/cleared/failed nudge merely means delivery
//     waits for the next periodic tick (≤ one reconcile interval) — never a loss.
const UNRESOLVED_FORWARD_NUDGE_DELAY_MS = 250;
let unresolvedForwardNudgeTimer: NodeJS.Timeout | undefined;
let unresolvedForwardNudgeRunning = false;

function scheduleUnresolvedForwardNudge(components: DaemonComponents): void {
    if (!components.dispatchMeshCommand) return; // no transport → periodic tick handles/no-ops
    if (unresolvedForwardNudgeTimer) return;     // coalesce a burst into one early pass
    unresolvedForwardNudgeTimer = setTimeout(() => {
        unresolvedForwardNudgeTimer = undefined;
        if (unresolvedForwardNudgeRunning) return; // an earlier pass is in flight — tick covers
        unresolvedForwardNudgeRunning = true;
        void retryUnresolvedDelegateForwards(components)
            .catch((e: any) => LOG.warn('MeshReconcile', `Nudged unresolved-forward retry failed: ${e?.message || e}`))
            .finally(() => { unresolvedForwardNudgeRunning = false; });
    }, UNRESOLVED_FORWARD_NUDGE_DELAY_MS);
    // Never keep the process alive solely for a pending nudge.
    if (typeof unresolvedForwardNudgeTimer.unref === 'function') unresolvedForwardNudgeTimer.unref();
}

function clearUnresolvedForwardNudge(): void {
    if (unresolvedForwardNudgeTimer) {
        clearTimeout(unresolvedForwardNudgeTimer);
        unresolvedForwardNudgeTimer = undefined;
    }
}

async function retryUnresolvedDelegateForwards(components: DaemonComponents): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;

    // Drop entries that have exhausted their retry budget (fail-loud inside).
    expireStaleUnresolvedDelegateForwards();

    const entries = peekUnresolvedDelegateForwards();
    if (entries.length === 0) {
        // Nothing queued — clear any stale per-entry rejection counters so the map can't grow.
        if (unresolvedForwardRejectionCounts.size > 0) unresolvedForwardRejectionCounts.clear();
        return;
    }

    // Every id-form THIS daemon answers to. A self-addressed outbox entry (coordinator
    // == this daemon) must never be cross-dialled — see the self-route branch below.
    const selfIds = resolveCoordinatorDaemonIds(components);
    const isSelfCoordinatorId = (id: string): boolean =>
        selfIds.some(self => daemonIdsEquivalent(self, id));

    for (const entry of entries) {
        // EVTTRACE correlation context for this outbox entry's retry.
        const entryTraceCtx = {
            taskId: (entry.payload as Record<string, unknown>).taskId,
            sessionId: readNonEmptyString(entry.payload.targetSessionId) || readNonEmptyString(entry.payload.sessionId),
            nodeId: readNonEmptyString(entry.payload.nodeId),
            event: readNonEmptyString(entry.payload.event),
        };

        // Self-addressed forward: the coordinator daemon this entry targets IS this
        // daemon (a self-coordinating / single-node mesh, or a delegate whose coordinator
        // anchor resolved to our own id). A cross-daemon mesh_forward_event to our own id
        // is REFUSED by the dispatch self-dial guard ("Refusing to send ... to this
        // daemon's own id; route via the local router instead") on every retry, so the
        // entry can never be acked and loops forever (~every tick), spamming the log and
        // pinning the outbox row permanently undrained. Honour the guard's own advice:
        // route the event straight through the local receiver (handleMeshForwardEvent —
        // the same path the coordinator runs on receiving a remote push), then ack it.
        // We drain regardless of the local result: a cross-daemon dispatch could not have
        // resolved it either (the guard rejects before the receiver ever runs), so leaving
        // it queued only re-spams. handleMeshForwardEvent has the BEST recovery chance —
        // this daemon hosts the mesh, so its workspace/nodeId → meshId recovery applies.
        if (isSelfCoordinatorId(entry.coordinatorDaemonId)) {
            let localResult: any;
            try {
                traceMeshEventStage('forward_send', entryTraceCtx, `self → local router (${entry.coordinatorDaemonId})`);
                localResult = handleMeshForwardEvent(components, entry.payload);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Local route of self-addressed forward to ${entry.coordinatorDaemonId} threw: ${e?.message || e} — draining anyway to break the retry loop`);
            }
            ackUnresolvedDelegateForward(entry.id);
            unresolvedForwardRejectionCounts.delete(entry.id);
            if (localResult && localResult.success === false) {
                LOG.warn('MeshReconcile', `Self-addressed unresolved-delegate ${readNonEmptyString(entry.payload.event)} rejected by local router (${readNonEmptyString(localResult.error) || 'no reason'}) — drained to break the self-forward retry loop`);
                traceMeshEventDrop('self_forward_local_rejected', entryTraceCtx, readNonEmptyString(localResult.error) || 'no reason');
            } else {
                LOG.info('MeshReconcile', `Self-addressed unresolved-delegate ${readNonEmptyString(entry.payload.event)} routed via local router (coordinator ${entry.coordinatorDaemonId} is self) — drained`);
            }
            continue;
        }

        // RECONCILE-MESHID-DROP: the stored forward payload was built when the worker
        // "couldn't resolve" its meshId, so the coordinator rejects it "meshId required"
        // when its own workspace/nodeId recovery misses. The worker can usually resolve it
        // now (member node membership / live-session meshNodeFor) — stamp it on so the
        // coordinator accepts. Covers entries persisted before this fix AND late-bound
        // sessions. No-op when the payload already carries a meshId or none is resolvable.
        let pushPayload = entry.payload;
        if (!readNonEmptyString(pushPayload.meshId)) {
            const recoveredMeshId = resolveForwardEventMeshId(components, pushPayload);
            if (recoveredMeshId) {
                pushPayload = { ...pushPayload, meshId: recoveredMeshId };
                traceMeshEventStage('forward_meshid_recovered', entryTraceCtx, `meshId=${recoveredMeshId}`);
            }
        }

        let result: any;
        try {
            traceMeshEventStage('forward_send', entryTraceCtx, `retry → ${entry.coordinatorDaemonId}`);
            // OFFLINE-NODE-BLOCKING: stamp the status-origin marker so the daemon-cloud relay
            // grants the SHORT connect-wait budget. Without it, a retry to a coordinator whose
            // daemon is powered off sinks into the 90s connect deadline per entry, serializing
            // the whole unresolved-forward outbox behind one dead coordinator. With it, the
            // dispatch throws in ~2s and the entry is left queued for the next tick — the
            // existing retry-backoff and age-expiry below are unchanged. The marker only
            // affects the connect wait and is stripped before mesh_forward_event executes, so
            // delivery semantics are identical.
            result = await dispatchMeshCommand(entry.coordinatorDaemonId, 'mesh_forward_event', withStatusProbeMarker(pushPayload));
        } catch (e: any) {
            // Coordinator unreachable (transport threw) — keep the entry queued and try again
            // next tick. This is NOT a hard rejection, so it does not count toward the cap;
            // the age expiry bounds a permanently-offline coordinator.
            LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} failed: ${e?.message || e} — left queued`);
            traceMeshEventDrop('retry_forward_failed', entryTraceCtx, e?.message || String(e));
            continue;
        }
        if (result && result.success === false) {
            // Hard rejection: the push was delivered and deterministically refused. Retrying
            // the identical payload can never succeed, so bound it — after MAX_FORWARD_REJECTIONS
            // drop (drain) the entry with one fail-loud warning instead of re-spamming every tick.
            const rejections = (unresolvedForwardRejectionCounts.get(entry.id) || 0) + 1;
            unresolvedForwardRejectionCounts.set(entry.id, rejections);
            const reason = readNonEmptyString(result.error) || 'no reason';
            if (rejections >= MAX_FORWARD_REJECTIONS) {
                ackUnresolvedDelegateForward(entry.id);
                unresolvedForwardRejectionCounts.delete(entry.id);
                LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} rejected ${rejections}x (${reason}) — dropping unresolved-delegate ${readNonEmptyString(entry.payload.event)} (sess=${readNonEmptyString(entry.payload.targetSessionId) || readNonEmptyString(entry.payload.sessionId) || '-'}) to stop the retry loop`);
                traceMeshEventDrop('retry_forward_exhausted', entryTraceCtx, `${reason} (${rejections} rejections)`);
            } else {
                LOG.warn('MeshReconcile', `Retry forward to coordinator ${entry.coordinatorDaemonId} rejected (${reason}) — left queued (attempt ${rejections}/${MAX_FORWARD_REJECTIONS})`);
                traceMeshEventDrop('retry_forward_rejected', entryTraceCtx, reason);
            }
            continue;
        }
        // Acked — mark the durable copy delivered.
        ackUnresolvedDelegateForward(entry.id);
        unresolvedForwardRejectionCounts.delete(entry.id);
        LOG.info('MeshReconcile', `Retried+delivered unresolved-delegate ${readNonEmptyString(entry.payload.event)} to coordinator ${entry.coordinatorDaemonId}`);
    }
}

// The remote P2P pull helpers (pullRemoteNodeQueues + payload/envelope utilities)
// live in ./mesh-remote-event-pull.ts, and the PHASE-4 completion-synthesis /
// PHASE-5 auto-prune (reconcileUnterminatedDirectDispatches,
// autoPruneStaleDirectDispatches) live in ./mesh-completion-synthesis.ts
// (A-3 extraction). Both are imported at the top of this file.
interface ReconcileLoopHandle {
    stop(): void;
}

// Start the periodic reconcile loop. Returns a handle with stop() for shutdown.
export function setupMeshReconcileLoop(components: DaemonComponents): ReconcileLoopHandle {
    const intervalMs = resolveReconcileIntervalMs();
    let running = false;
    const timer = setInterval(() => {
        if (running) return; // never overlap ticks
        running = true;
        void runMeshReconcileTick(components)
            .catch((e: any) => LOG.warn('MeshReconcile', `Reconcile tick error: ${e?.message || e}`))
            .finally(() => { running = false; });
    }, intervalMs);
    // Don't keep the process alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
    // Register the unresolved-forward nudge handler: the enqueue site
    // (forwardUnresolvedDelegateEvent) fires it after persisting an outbox row so
    // the PHASE 0 retry runs early instead of waiting for the next periodic tick.
    registerUnresolvedForwardRetryNudge(() => scheduleUnresolvedForwardNudge(components));
    LOG.info('MeshReconcile', `Mesh reconcile loop started (interval ${intervalMs}ms)`);
    return {
        stop() {
            clearInterval(timer);
            registerUnresolvedForwardRetryNudge(undefined);
            clearUnresolvedForwardNudge();
            LOG.info('MeshReconcile', 'Mesh reconcile loop stopped');
        },
    };
}
