// ---------------------------------------------------------------------------
// mesh-reconcile-coordinator-drain — live CLI coordinator discovery + delivery
// ---------------------------------------------------------------------------
// Pure move out of mesh-reconcile-loop.ts (no behavior change). This is the
// coordinator-facing half of the reconcile loop: finding the live CLI
// coordinator sessions on THIS daemon, classifying their drain eligibility
// (idle / generating / modal-parked), and the delivery primitives PHASE 2 uses
// to get queued events into them — the full idle drain, the approval-nudge
// level delivery, the strict session-routing hold/expire, and the held-event
// ledger audit.
//
// The orchestration deciding WHICH of these runs on a given tick stays in
// mesh-reconcile-loop.ts (runMeshReconcileTick PHASE 2).
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { LOG, getLogLevel } from '../logging/logger.js';
import {
    drainPendingMeshCoordinatorEvents,
    getPendingMeshCoordinatorEvents,
    buildPendingEventFingerprint,
    requeueDrainedPendingMeshCoordinatorEvent,
} from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { appendLedgerEntry, readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerEntry } from './mesh-ledger.js';
import { shouldForceInjectMeshEvent } from './mesh-events-coordinator.js';
import { isMeshApprovalEvent, MESH_APPROVAL_EVENTS } from './mesh-event-classify.js';
import { readNonEmptyString, readMeshCompletionSummary, buildMeshSystemMessage } from './mesh-events-utils.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { expandDaemonIdForms, daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';

export interface LiveCoordinator {
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

// Disk/worktree retention throttle. The reconcile tick runs every ~4s, but the
// retention sweep (fs walks + git worktree list) is far too heavy for that cadence
// and its artifacts age in days, so it runs at most once per hour. `undefined`
// means "never run yet" → runs on the first tick after daemon start so a long-lived
// backlog is reclaimed promptly rather than an hour later. Per-process; a restart
// re-runs it immediately, which is the desired behavior (a restart is exactly when
// stale artifacts from the previous run should be swept).
const DISK_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1h
let lastDiskRetentionRunAt: number | undefined;

// Find live CLI coordinator instances on THIS daemon, keyed by mesh.

export function findLiveCoordinators(components: DaemonComponents): LiveCoordinator[] {
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

export function injectPendingIntoCoordinator(
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

export function recordHeldTerminalEventsToLedger(
    meshId: string,
    drainDaemonIds: string[],
    reason: string,
    heldForCoordinatorCount: number,
    /**
     * Fingerprints already routed through the strict-route hold this tick. Those events
     * are NOT held for the reason being audited here — strict-route owns their lifecycle
     * (it re-queues them and ledgers `strict_route_expired` past the TTL), so auditing
     * them again under `modal_parked`/`generating_no_idle_coordinator` would attribute
     * the hold to the wrong cause. Before the hold became durable this was masked: the
     * re-queue silently wrote nothing, so the peek below found no row to double-audit.
     */
    strictRoutedFingerprints?: ReadonlySet<string>,
): void {
    let pending: readonly PendingMeshCoordinatorEvent[];
    try {
        pending = getPendingMeshCoordinatorEvents(meshId, drainDaemonIds.length > 0 ? drainDaemonIds : undefined);
    } catch {
        return; // best-effort audit — never let a peek failure break the tick
    }
    for (const event of pending) {
        if (strictRoutedFingerprints?.has(buildPendingEventFingerprint(event))) continue;
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

export function oldestHeldTerminalEventAgeMs(meshId: string, drainDaemonIds: string[]): number {
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

export function reconfirmGenuinelyIdleCoordinators(generating: LiveCoordinator[]): LiveCoordinator[] {
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

export function drainAndInjectIntoTargets(
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
            {
                // AMBIGUOUS-UNICAST guard (REFINE-EVENT-SESSION-SCOPED-UNICAST): observability
                // only — it warns when a session-less unicast event is delivered while several
                // coordinator sessions are live and racing for it. Never changes delivery, so
                // an event can't be stranded by it. targetCoordinators is this daemon's live
                // coordinator set for the mesh, which is exactly the racing population.
                countLiveCoordinatorSessions: () =>
                    new Set(targetCoordinators.map(c => c.sessionId).filter(Boolean)).size,
            },
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

export function drainAndDeliverApprovalNudges(
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

// Strict-routing TTL: how long a drained completion whose originating coordinator session
// is not currently deliverable is held (re-queued for re-drain) before it is ledger-
// expired. Bounded so a coordinator session that never returns cannot wedge the event
// forever; broad enough to ride out a transient modal-park / brief restart.
const STRICT_SESSION_MATCH_TTL_MS = 60_000;

// Re-queue (hold) a strict-routed event whose coordinator session is not live, or — once it
// has aged past STRICT_SESSION_MATCH_TTL_MS — ledger-expire it (recoverable) and drop it.
// We deliberately do NOT broadcast an aged-out event to sibling coordinators: that is the
// very misroute strict routing exists to prevent.
//
// STRICT-ROUTE-HOLD-DURABILITY (rc.33): the hold MUST go through
// requeueDrainedPendingMeshCoordinatorEvent, not queuePendingMeshCoordinatorEvent. The drain
// already marked this row drained=1, and the normal persist path cannot re-queue a drained
// row: the UNIQUE (mesh_id, fingerprint) index carries no `drained` qualifier, so
// INSERT OR IGNORE silently discarded the "fresh undrained copy" while the drained=0 dedup
// probe reported no duplicate — the hold looked successful but wrote nothing durable. It only
// appeared to work because the in-memory loop re-read the event, so a restart inside the 60s
// TTL lost the completion for good (task ec6c901a: one row, drained=1, zero JSONL lines →
// 911s later the delivered-no-turn deadline reclaimed and re-dispatched it). Flipping the
// existing row back to drained=0 makes the hold survive a restart. queuedAt is preserved so
// the TTL still measures the event's true age across holds.

export function holdOrExpireStrictUnmatchedEvent(
    pending: PendingMeshCoordinatorEvent,
    wantSession: string,
    meshId: string,
): void {
    const queuedAt = typeof pending.queuedAt === 'number' ? pending.queuedAt : Date.now();
    if (Date.now() - queuedAt <= STRICT_SESSION_MATCH_TTL_MS) {
        try {
            const requeued = requeueDrainedPendingMeshCoordinatorEvent(pending); // preserves queuedAt → true age retained
            LOG.info('MeshReconcile', `Strict route hold: coordinator session ${wantSession} not live on mesh ${meshId} — re-queued (${pending.event})${requeued ? '' : ' [WARN: not durably re-queued]'}`);
            // EVTTRACE: event held (re-queued) — its originating coordinator session is not
            // currently deliverable. Held, not dropped; surfaces later or expires past TTL.
            // `durable` names whether the hold actually survives a restart: a false here is the
            // exact silent-loss signature this fix removes, so it must be visible in the trace.
            traceMeshEventDrop('strict_route_hold', {
                taskId: pending.metadataEvent?.taskId,
                sessionId: pending.metadataEvent?.targetSessionId ?? wantSession,
                nodeId: pending.nodeId,
                meshId,
                event: pending.event,
            }, `coordinatorSession=${wantSession} not live durable=${requeued}`);
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

