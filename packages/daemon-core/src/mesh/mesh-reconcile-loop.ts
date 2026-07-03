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
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { loadConfig } from '../config/config.js';
import { listMeshes } from '../config/mesh-config.js';
import { LOG, getLogLevel } from '../logging/logger.js';
import { drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, buildPendingEventFingerprint, queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { handleMeshForwardEvent, shouldForceInjectMeshEvent, triggerMeshQueue, resolveForwardEventMeshId } from './mesh-events-coordinator.js';
import {
    peekUnresolvedDelegateForwards,
    ackUnresolvedDelegateForward,
    expireStaleUnresolvedDelegateForwards,
} from './mesh-unresolved-forward-outbox.js';
import { readNonEmptyString, readMeshCompletionSummary, buildMeshSystemMessage } from './mesh-events-utils.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { expandDaemonIdForms, daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getActiveDirectDispatches, getQueue, reclaimStrandedAssignedTask, updateTaskStatus } from './mesh-work-queue.js';
import { readLedgerEntries } from './mesh-ledger.js';
import { pruneStaleDirectDispatches } from './mesh-active-work.js';
import { findTerminalLedgerEvidenceForTask, reconcileDirectDispatchCompletionFromTranscript } from './mesh-events-stale.js';
import { extractFinalAssistantSummaryEvidence } from '../providers/chat-message-normalization.js';
import type { ChatMessage } from '../types.js';

// Default reconcile cadence. approval/completion notifications to a live CLI
// coordinator land within at most one interval. Overridable via env for tuning.
const DEFAULT_RECONCILE_INTERVAL_MS = 4_000;

// PHASE 5 (auto-prune) conservative age gate. A direct dispatch whose node/session is
// orphaned (no longer in the live mesh) is only auto-pruned once it is at least this old,
// measured from its dispatch time. This protects against a node/session that is only
// *transiently* invisible (a momentary probe failure, a daemon restart) being pruned the
// instant it disappears. The MANUAL prune (mesh_prune_stale_direct) has no age gate — an
// operator pruning explicitly wants the orphan gone now. Overridable via env for tuning.
const DEFAULT_AUTO_PRUNE_MIN_AGE_MS = 24 * 60 * 60_000; // 24h

function resolveAutoPruneMinAgeMs(): number {
    const raw = readNonEmptyString(process.env.MESH_AUTO_PRUNE_MIN_AGE_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        // Clamp to [1h, 30d] so a mis-set env can't make the gate pathologically aggressive
        // (prune the moment something blinks) or effectively disable it forever.
        if (Number.isFinite(parsed) && parsed >= 60 * 60_000 && parsed <= 30 * 24 * 60 * 60_000) return parsed;
    }
    return DEFAULT_AUTO_PRUNE_MIN_AGE_MS;
}

// PTY-OVERTRUST-DRAIN (Defect B, fix B). Age-based escape for the
// `generating_no_idle_coordinator` hold. Fix A makes the drain predicate read the RAW
// adapter (mask-stripped), so the common mask-driven false-busy is gone. But a hold can
// still arise from a genuine status-source desync that fix A does not reach (e.g. the
// adapter raw itself momentarily reads generating while the coordinator is actually at a
// turn end). This is a TIME-BASED BACKSTOP: when a mesh's pending terminal events have
// been held this long, re-confirm the coordinator's RAW adapter idle on the tick and, if
// it is genuinely idle, drain ONCE. It NEVER injects into a genuinely-generating PTY —
// the re-confirmation gates on raw adapter idle, so the intentional removal of
// force-inject-into-generating (data-loss) is preserved. Default 12s = 3 reconcile ticks
// at the 4s cadence: long enough that a normal mid-turn settle is not pre-empted, short
// enough that a desync-stranded completion is not held for minutes. Env-tunable.
const DEFAULT_PENDING_HELD_DRAIN_ESCALATE_MS = 12_000;

function resolvePendingHeldDrainEscalateMs(): number {
    // Floor 4s (one tick) so a mis-set env cannot make the escape race a normal settle;
    // ceiling 5min so it cannot be disabled into a permanent strand.
    return resolveTunedReconcileMs('MESH_PENDING_HELD_DRAIN_ESCALATE_MS', DEFAULT_PENDING_HELD_DRAIN_ESCALATE_MS, 4_000, 5 * 60_000);
}

function resolveReconcileIntervalMs(): number {
    const raw = readNonEmptyString(process.env.MESH_RECONCILE_INTERVAL_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 60_000) return parsed;
    }
    return DEFAULT_RECONCILE_INTERVAL_MS;
}

// R4f (GENERATING-BOUNDARY, acked-hold redesign). PHASE 4 only synthesizes a missing completion
// when the worker session reads `idle`. But a worker that is GENUINELY generating (it emitted
// agent:generating_started — the dispatch row is 'acked' — and has not yet completed) can
// momentarily read `idle` mid-turn (a CLI PTY inter-tool-call settle, or the final assistant text
// already rendered while the turn's generating_completed lifecycle close still lags). A premature
// synth writes a terminal that then masks the worker's REAL completion when it lands seconds later
// (drop:duplicate_completion_terminal_ledger; the observed 71s task a250fb44 lost its [System]
// notification this way; the R4e 53s task synth fired 16s BEFORE the worker's real emit).
//
// R4 → R4e used FINITE timers (consecutive ticks / MIN_IDLE_SETTLE / ACKED_TURN_SETTLE) to delay the
// synth. That class of fix is fundamentally a RACE: the worker's real emit latency is variable and
// unbounded (win32 idle reads can flip before the emit arrives), so ANY finite timer eventually
// loses to a slow-enough turn — and the synth pre-empts the real completion. R4e live-FAILED for
// exactly this reason.
//
// R4f redesign (direction B). An `acked` task means the worker ECHOED generating_started (the
// taskId flip) — it is alive and mid-turn, so it WILL eventually emit a real terminal. We therefore
// HOLD the synth INDEFINITELY for an acked task. This is safe against the emit actually arriving:
// when the worker's real generating_completed lands, it writes a terminal ledger, and
// reconcileDirectDispatchCompletionFromTranscript's hasTerminalLedgerAfterDispatch check makes any
// later synth an idempotent no-op (alreadyTerminal). So the hold never costs a missed notification —
// the real emit always wins, no matter how late.
//
// The indefinite hold is released ONLY by a genuine-DEATH / emit-loss BACKSTOP — never a finite
// timer that races normal lag:
//   (a) liveness failure — read_chat reports the session is gone, OR N consecutive read failures
//       accumulate (a transport/session-gone signal, counted as death rather than swallowed via
//       `continue`). A worker that died mid-turn will never emit, so the synth must eventually fire.
//   (b) an absolute LONG death-deadline — time since the generating_started ack exceeds
//       ACKED_DEATH_DEADLINE_MS, a backstop set FAR above any observed emit latency (default 8 min)
//       so it does not race a normal slow turn; it only catches a worker that is genuinely wedged or
//       whose emit was permanently lost. This is a notification-loss net, not a completion timer.
//
// A dispatch that was never acked (worker never started) is NOT held here: there is no in-flight
// generation to protect, so it keeps the existing first-idle-tick synth behavior (its lost-dispatch
// case is covered by the downstream grace + stale-summary guards). The map is pruned each PHASE-4
// pass to the set of currently active dispatches, so a completed/pruned task's state is dropped (no
// unbounded growth). Keyed by `${meshId}::${taskId}`.

// R4f backstop (a): how many CONSECUTIVE read_chat failures (transport error / success:false /
// no payload) for an acked task are treated as a death signal that releases the indefinite hold.
// A single failed read is a transient probe blip; a session that genuinely died reads-fail every
// tick, so a small streak distinguishes the two without racing a live-but-slow worker.
const ACKED_DEATH_CONSECUTIVE_READ_FAILURES = 3;

// R4f backstop (b): the absolute death-deadline. An acked task is held indefinitely until this much
// time has elapsed since its generating_started ack (dispatch.updatedAt); past it, a persistently
// idle session is synthesized as a notification-loss net. This is set FAR above any observed emit
// latency (R4e's worst case was ~16s) so it does NOT race a normal slow turn — it only catches a
// genuinely wedged worker or a permanently-lost emit. Read at call time so tests can tune it.
function resolveTunedReconcileMs(envName: string, def: number, min: number, max: number): number {
    const raw = readNonEmptyString(process.env[envName]);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
    }
    return def;
}
function resolveAckedDeathDeadlineMs(): number {
    // Default 8 min — FAR above the variable emit latency the finite R4..R4e timers raced (R4e's
    // worst case was ~16s); by the time this fires a live worker would long since have emitted its
    // real terminal. The env-override floor is 0 so tests can force the deadline (production never
    // sets it that low); the ceiling is 60min so a mis-set env cannot disable the loss-net forever.
    return resolveTunedReconcileMs('MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS', 8 * 60_000, 0, 60 * 60_000);
}

// ACKED-HOLD-IDLE-OVERTRUST (transcript-completion fast-track). The indefinite acked-hold above is
// safe but SLOW: when the worker's real generating_completed emit is dropped/lost, the only thing
// that promotes the missing completion is the 8-min death backstop — even though the answer has been
// FULLY rendered in the transcript for minutes (read_chat reports idle WITH a final visible assistant
// message every ~4s). Observed live: completions surfaced 144s / 492s late, both incompatible with the
// provider's own emit ceiling (COMPLETED_FINALIZATION_MAX_WAIT_MS 30s + NATIVE_HISTORY_MESH_IDLE_SETTLE
// 4s ≈ 34s). That gap = a worker that finished, whose PTY generating→idle edge / real emit was lost,
// held hostage to the 8-min net.
//
// Fast-track: when an acked task reads idle AND a final visible assistant message is present (the same
// transcript-completion evidence PHASE 4 already requires to synth), and that idle-with-final-assistant
// state has PERSISTED for a short continuous grace, promote the synth EARLY — ahead of the 8-min
// backstop. The grace is the correctness gate: a SINGLE idle read could be a mid-turn blip (PTY
// inter-tool-call settle, or final text rendered while the next tool call is about to start), so we
// require the idle-with-final-assistant signal to hold continuously for the grace window before
// trusting it as a genuine turn-end. Any non-idle read (generating / waiting_approval), a read
// failure, or the disappearance of the final assistant message RESETS the streak — so an actively
// streaming worker that momentarily reads idle never crosses the grace.
//
// Safety: this only changes WHEN an acked synth fires (earlier), never WHETHER it is correct —
// reconcileDirectDispatchCompletionFromTranscript's hasTerminalLedgerAfterDispatch makes a real
// emit that lands later an idempotent no-op, exactly as the death-backstop synth relies on. The
// death backstop (8 min) is PRESERVED unchanged as the final net; the fast-track is a faster path in
// front of it. The grace is set ABOVE the provider's own emit ceiling (~34s) so a worker still inside
// its normal finalization window is never pre-empted — we only fast-track once enough continuous idle
// has elapsed that a live emit would already have arrived.
function resolveAckedTranscriptFastTrackGraceMs(): number {
    // Default 40s — above the provider emit ceiling (30s COMPLETED_FINALIZATION_MAX_WAIT_MS + 4s
    // NATIVE_HISTORY_MESH_IDLE_SETTLE ≈ 34s): a genuinely-live worker would have emitted its real
    // terminal within that window, so 40s of CONTINUOUS idle-with-final-assistant means the emit was
    // lost, not late. Far below the 8-min death backstop, so the fast-track is the dominant path for a
    // lost emit while the backstop remains the last-resort net. Floor 0 lets tests force an immediate
    // fast-track; ceiling 5min keeps a mis-set env from collapsing it into the death backstop.
    return resolveTunedReconcileMs('MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS', 40_000, 0, 5 * 60_000);
}

// Per-task in-flight hold state for an acked dispatch:
//   - liveConfirmedSinceAck: we have seen at least one conclusive read (idle OR generating) since
//     the ack — proves the session is reachable, so a later read FAILURE is a genuine liveness loss
//     rather than a node that was never reachable.
//   - consecutiveReadFailures: streak of inconclusive read_chat results (death backstop (a)).
//   - transcriptIdleSinceMs: the timestamp of the FIRST tick in the current continuous run of
//     idle-with-final-assistant reads (ACKED-HOLD-IDLE-OVERTRUST fast-track). Cleared to undefined
//     whenever the signal breaks (non-idle read, read failure, or no final assistant message), so a
//     mid-turn idle blip never accumulates grace. When `now - transcriptIdleSinceMs` exceeds the
//     fast-track grace the synth is promoted ahead of the death backstop.
interface AckedHoldState {
    liveConfirmedSinceAck: boolean;
    consecutiveReadFailures: number;
    transcriptIdleSinceMs?: number;
}
const inFlightAckedHoldState = new Map<string, AckedHoldState>();

function inFlightSynthKey(meshId: string, taskId: string): string {
    return `${meshId}::${taskId}`;
}

// Test hook: clear the in-flight acked-hold state between cases.
export function __resetReconcileInFlightSynthDebounceForTests(): void {
    inFlightAckedHoldState.clear();
}

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

// The set of coordinator-daemon ids THIS daemon answers to when draining the
// pending-events queue. A unicast completion event is stamped with the worker's
// meshCoordinatorDaemonId, which can be either:
//   - the daemon's canonical status id (`standalone_<machineId>` / `daemon_<machineId>`),
//     stamped by the MCP layer via ctx.localDaemonId (= getStatus().status.instanceId), or
//   - the bare machineId, stamped by the local queue-assignment path (loadConfig().machineId).
//   - the config-form node daemonId (`daemon_<machineId>`), which the MCP layer's
//     resolveCoordinatorDaemonId prefers and stamps onto direct-dispatch workers.
// Draining with only one of these silently misses events stamped with the other —
// the exact reason a generating coordinator never self-received local completions,
// and the base-node completion-surface bug (base completions land full-form
// `daemon_<machineId>` while a coordinator that only knows itself as bare
// `<machineId>` never matches them). We expand to EVERY equivalent form so the
// scope match (host gate, self-node detection, and the drain IN-filter downstream)
// succeeds regardless of which path stamped the event.
function resolveCoordinatorDaemonIds(components: DaemonComponents): string[] {
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const machineId = readNonEmptyString(loadConfig().machineId);
    return expandDaemonIdForms([statusInstanceId, machineId]);
}

// Whether THIS daemon is the coordinator/host for a mesh — i.e. the daemon that
// owns coordinator ownership and must collect every worker node's completion
// events into its local queue. This is true regardless of whether a *live CLI*
// coordinator session currently exists: the coordinator is frequently a pure
// stdio MCP LLM (no live CLI session to inject into), and that LLM only sees the
// queue when it next calls a mesh tool. For it to see remote worker completions
// at all, the daemon must have already pulled them into the local queue on the
// timer — which is exactly what this predicate gates.
//
// Rule: this daemon hosts the mesh when meshHost.role is 'host' (the default for
// standalone-compat meshes with no host metadata) AND, when a hostDaemonId is
// pinned, it resolves to one of this daemon's ids. Member-only daemons return
// false — their own queue is pulled BY the host, not the other way around.
//
// `daemonIds` here is the EXPANDED self-identity set (runtime drain ids ∪ this
// daemon's mesh-config node id forms) — see resolveCoordinatorSelfIds. The
// pinned hostDaemonId is itself a config-form id and frequently does NOT equal a
// runtime id (bare machineId / status id), so gating on the runtime ids alone
// would wrongly classify the real host as a non-host and skip the remote pull
// entirely.
function daemonHostsMesh(mesh: LocalMeshEntry, daemonIds: string[]): boolean {
    const host = mesh.meshHost;
    // No metadata → default host (standalone compatibility, see createDefaultMeshHostMetadata).
    if (!host) return true;
    if (host.role && host.role !== 'host') return false;
    const hostDaemonId = readNonEmptyString(host.hostDaemonId);
    // Host role but no pinned hostDaemonId → treat as host (single-daemon / legacy).
    if (!hostDaemonId) return true;
    return daemonIdListIncludes(daemonIds, hostDaemonId);
}

function daemonIdListIncludes(ids: readonly string[], id: string | undefined): boolean {
    if (!id) return false;
    return ids.some(candidate => candidate === id || daemonIdsEquivalent(candidate, id));
}

// Resolve EVERY id-form this daemon answers to FOR A GIVEN MESH: the runtime drain
// ids (status id + bare machineId) unioned with this daemon's mesh-config identity
// forms — the self node's daemonId/machineId (the node whose daemonId/machineId
// matches a runtime id) and the pinned meshHost.hostDaemonId WHEN it is provably
// ours. This is the single source of truth for "is this id me?" across both the
// host gate and the remote pull filter; the worker's meshCoordinatorDaemonId stamp
// is guaranteed to be one of these forms (it comes from resolveCoordinatorDaemonId,
// which prefers the coordinator node's config-form daemonId over the runtime status id).
function resolveCoordinatorSelfIds(mesh: LocalMeshEntry, drainDaemonIds: string[]): string[] {
    const ids = new Set<string>(drainDaemonIds);
    // Expand with the config-form id(s) of the self node — the mesh node whose
    // daemonId/machineId matches a runtime id. Its config-form daemonId is exactly
    // what resolveCoordinatorNode()→resolveCoordinatorDaemonId() stamps onto a worker.
    for (const node of mesh.nodes) {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        const nodeMachineId = readNonEmptyString(node.machineId);
        const isSelf = (nodeDaemonId && daemonIdListIncludes(drainDaemonIds, nodeDaemonId))
            || (nodeMachineId && daemonIdListIncludes(drainDaemonIds, nodeMachineId));
        if (!isSelf) continue;
        if (nodeDaemonId) ids.add(nodeDaemonId);
        if (nodeMachineId) ids.add(nodeMachineId);
    }
    // The pinned host id is included ONLY when it is provably one of THIS daemon's ids
    // (it already matches a runtime id or a resolved self-node id). A hostDaemonId that
    // names a DIFFERENT daemon must NOT be claimed — that would make a member-only
    // daemon believe it is the host and pull queues it does not own. Having a node on
    // this daemon does not make this daemon the host; daemonHostsMesh still honours a
    // foreign hostDaemonId and rejects ownership.
    const hostDaemonId = readNonEmptyString(mesh.meshHost?.hostDaemonId);
    if (hostDaemonId && daemonIdListIncludes([...ids], hostDaemonId)) ids.add(hostDaemonId);
    return [...ids];
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
    const force = shouldForceInjectMeshEvent(pending.event);
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
function recoverStrandedAssignedDispatches(meshId: string, store: MeshRuntimeStore): void {
    const assigned = getQueue(meshId, { status: ['assigned'] });
    if (!assigned.length) return;
    const nowMs = Date.now();
    for (const row of assigned) {
        const dispatchedAtMs = Date.parse(row.dispatchTimestamp ?? '');
        if (!Number.isFinite(dispatchedAtMs)) continue;              // no dispatch ts → can't age it
        if (nowMs - dispatchedAtMs < ASSIGNED_STRANDED_DEADLINE_MS) continue;  // still in confirm window
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
        if (store.taskHasConfirmedDelivery(meshId, row.id)) continue;          // dispatched → PHASE 4's job
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
    // any push that has not yet been acked. See mesh-unresolved-forward-outbox.ts.
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
                recoverStrandedAssignedDispatches(mesh.id, store);
            } catch (e: any) {
                LOG.warn('MeshReconcile', `Assigned-stranded watchdog failed for mesh ${mesh.id}: ${e?.message || e}`);
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
    for (const mesh of listMeshes()) {
        const selfIds = resolveCoordinatorSelfIds(mesh, drainDaemonIds);
        if (!daemonHostsMesh(mesh, selfIds)) continue;
        if (store) {
            try {
                if (store.pendingQueueTaskCount(mesh.id) === 0) continue;
            } catch { /* fall through and let triggerMeshQueue decide */ }
        }
        try {
            await triggerMeshQueue(components, mesh.id);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Pending-claim recovery trigger failed for mesh ${mesh.id}: ${e?.message || e}`);
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
                if (store.pendingEventCount(meshId) === 0) continue;
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
            result = await dispatchMeshCommand(entry.coordinatorDaemonId, 'mesh_forward_event', pushPayload);
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

// Cloud-only: poll each remote worker node daemon for pending coordinator events
// and re-inject them locally via handleMeshForwardEvent (which re-queues +
// surfaces to the live coordinator on the next tick / immediately if idle).
//
// Scoping: the remote handler (get_pending_mesh_events) drains its queue filtered
// by coordinatorDaemonId — returning events targeted at that id OR unscoped, and
// leaving events targeted at a *different* coordinator. A remote worker stamps the
// coordinator id in one of SEVERAL forms (the canonical status id `standalone_`/
// `daemon_<machineId>` stamped by the MCP layer, the bare machineId stamped by the
// local queue path, OR — most commonly for remote launches — the coordinator mesh
// node's config-form `daemonId`, which resolveCoordinatorDaemonId prefers and which
// is NOT canonicalised). `candidateDaemonIds` is the already-expanded self-identity
// set (resolveCoordinatorSelfIds: runtime drain ids ∪ this daemon's mesh-config node/
// host id forms), so we pull ONCE PER candidate id and a completion stamped with any
// of them is recovered. The remote drain is atomic (drained=1), so issuing multiple
// pulls cannot double-deliver — the first pull that matches consumes the event; the
// rest see nothing. When no ids resolve we fall back to a single unscoped pull.
async function pullRemoteNodeQueues(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    localDaemonId: string | undefined,
    candidateDaemonIds: string[],
): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;
    const meshId = mesh.id;

    // One args object per candidate coordinator-id form, or a single unscoped pull
    // when none resolve.
    const pulls: Array<Record<string, unknown>> = candidateDaemonIds.length > 0
        ? candidateDaemonIds.map(id => ({ meshId, coordinatorDaemonId: id }))
        : [{ meshId }];

    for (const node of mesh.nodes) {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        // Skip nodes without a daemon, and nodes on THIS daemon (their events are
        // already in the local queue drained in PHASE 2). "This daemon" is matched
        // against the full self-identity set (candidateDaemonIds), not just the bare
        // localDaemonId — a self node can be registered under the config-form daemonId
        // (`daemon_<machineId>`) which would NOT equal bare localDaemonId, and pulling
        // from ourselves over P2P is both wasteful and a self-dispatch hazard.
        if (!nodeDaemonId) continue;
        if (daemonIdsEquivalent(nodeDaemonId, localDaemonId)) continue;
        if (daemonIdListIncludes(candidateDaemonIds, nodeDaemonId)) continue;

        for (const pendingEventArgs of pulls) {
            let events: unknown;
            try {
                events = await dispatchMeshCommand(nodeDaemonId, 'get_pending_mesh_events', pendingEventArgs);
            } catch {
                // Remote pull is best-effort; the node may be offline. Retry next tick.
                break; // node unreachable — don't bother with the other id form this tick.
            }
            const list = extractPendingEvents(events).filter(e => readNonEmptyString(e?.meshId) === meshId);
            for (const event of list) {
                const payload = buildForwardPayloadFromPending(event);
                if (!payload.event || !payload.meshId) continue;
                try {
                    handleMeshForwardEvent(components, payload);
                } catch { /* best-effort re-inject */ }
            }
        }
    }
}

// Pull the read_chat payload out of whatever envelope the transport returned.
// A local commandHandler.handle() returns the CommandResult directly; a remote
// dispatchMeshCommand returns it possibly wrapped in { payload } / { result }.
function unwrapReadChatPayload(raw: unknown): Record<string, unknown> | null {
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        const record = cursor as Record<string, unknown>;
        if (Array.isArray(record.messages)) return record;
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.data && typeof record.data === 'object') { cursor = record.data; continue; }
        break;
    }
    return cursor && typeof cursor === 'object' ? cursor as Record<string, unknown> : null;
}

function readChatPayloadStatus(payload: Record<string, unknown> | null): string {
    return readNonEmptyString(payload?.status).toLowerCase();
}

// R4e fix (3): peek the pending-events queue for a REAL (worker-emitted) terminal completion
// already queued for a task — used to yield the in-flight synth to the worker's own emit. Broad
// peek (no daemon-id scoping) matched precisely by taskId, so a worker stamp in any daemon-id form
// is still recognized. Best-effort: a peek failure returns false (proceed to synth — never block
// delivery). A prior SYNTH's still-queued pending event also names this taskId, but a synth always
// writes its terminal ledger atomically, so hasTerminalLedgerAfterDispatch downstream already
// no-ops that case — this guard is specifically for an as-yet-unledgered worker emit in flight.
function realTerminalEmitPendingForTask(meshId: string, taskId: string): boolean {
    let pending: readonly PendingMeshCoordinatorEvent[];
    try {
        pending = getPendingMeshCoordinatorEvents(meshId);
    } catch {
        return false;
    }
    return pending.some(e =>
        readNonEmptyString(e.metadataEvent?.taskId) === taskId
        && (e.event === 'agent:generating_completed' || e.event === 'agent:stopped'));
}

// R4e fix (2): one fresh read_chat status read for the worker session, via the same local/remote
// transport PHASE 4 uses. Returns the lowercased status, or null when the read is inconclusive
// (transport error, success:false, no payload) — callers treat null as "no new evidence, proceed".
async function reprobeWorkerStatus(
    components: DaemonComponents,
    args: { isLocalNode: boolean; nodeDaemonId: string; readArgs: Record<string, unknown> },
): Promise<string | null> {
    try {
        if (args.isLocalNode) {
            const r = await components.commandHandler.handle('read_chat', args.readArgs);
            if (r && (r as { success?: boolean }).success === false) return null;
            return readChatPayloadStatus(unwrapReadChatPayload(r));
        }
        if (components.dispatchMeshCommand) {
            const r = await components.dispatchMeshCommand(args.nodeDaemonId, 'read_chat', args.readArgs);
            const p = unwrapReadChatPayload(r);
            if (p && (p as { success?: boolean }).success === false) return null;
            return readChatPayloadStatus(p);
        }
    } catch {
        return null;
    }
    return null;
}

// PHASE 4 helper. For every active (non-terminal) direct dispatch this daemon
// hosts, confirm the worker session is idle via a read_chat and — if a final
// assistant summary is present but no terminal ledger exists for that dispatch —
// synthesize the missing completion through reconcileDirectDispatchCompletionFromTranscript.
//
// read_chat is resolved against the target node: a node on THIS daemon is read
// through the local commandHandler; a remote node is read over P2P via
// dispatchMeshCommand. Both yield the same { messages, status, providerSessionId }
// shape. We only synthesize when the session reports idle AND a final assistant
// message exists — the same evidence bar the MCP poll path uses — so an actively
// generating worker is never falsely completed. The reconcile itself is idempotent.
async function reconcileUnterminatedDirectDispatches(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
): Promise<void> {
    const dispatches = getActiveDirectDispatches(mesh.id);
    if (dispatches.length === 0) return; // cheap exit — nothing dispatched, nothing to reconcile

    // Prune the in-flight acked-hold map to the tasks still active in THIS mesh, so a
    // completed/pruned task's state is dropped (the map never grows without bound).
    const activeTaskKeys = new Set(
        dispatches
            .map(d => readNonEmptyString(d.taskId))
            .filter(Boolean)
            .map(taskId => inFlightSynthKey(mesh.id, taskId)),
    );
    for (const key of inFlightAckedHoldState.keys()) {
        if (key.startsWith(`${mesh.id}::`) && !activeTaskKeys.has(key)) {
            inFlightAckedHoldState.delete(key);
        }
    }

    const dispatchMeshCommand = components.dispatchMeshCommand;
    const nodeById = new Map(mesh.nodes.map(n => [n.id, n] as const));

    for (const dispatch of dispatches) {
        const sessionId = readNonEmptyString(dispatch.sessionId);
        const nodeId = readNonEmptyString(dispatch.nodeId);
        const taskId = readNonEmptyString(dispatch.taskId);
        if (!sessionId || !nodeId || !taskId) continue;

        const node = nodeById.get(nodeId);
        const nodeDaemonId = readNonEmptyString(node?.daemonId);
        // A node is local when it has no daemonId, names this daemon, or actually
        // has a live instance here. Anything else is reached over P2P.
        const isLocalNode = !nodeDaemonId
            || daemonIdListIncludes(selfIds, nodeDaemonId)
            || daemonIdsEquivalent(nodeDaemonId, localDaemonId)
            || !!components.instanceManager.getInstance(sessionId);

        const providerType = readNonEmptyString(dispatch.providerType);
        const readArgs: Record<string, unknown> = {
            sessionId,
            targetSessionId: sessionId,
            tailLimit: 10,
            ...(node?.workspace ? { workspace: node.workspace } : {}),
            ...(providerType ? { agentType: providerType, providerType } : {}),
        };

        const synthKey = inFlightSynthKey(mesh.id, taskId);
        const isAcked = dispatch.status === 'acked';

        // R4f: read the worker session. A FAILED read (transport error / success:false / no payload)
        // is no longer silently swallowed for an acked task — it is the liveness side of the
        // death backstop (a). We classify the read result and route an acked failure into the
        // failure counter; a never-acked (or non-acked) failure keeps the old best-effort `continue`.
        let payload: Record<string, unknown> | null = null;
        let readFailed = false;
        try {
            if (isLocalNode) {
                const result = await components.commandHandler.handle('read_chat', readArgs);
                if (result && (result as { success?: boolean }).success === false) {
                    readFailed = true;
                } else {
                    payload = unwrapReadChatPayload(result);
                }
            } else if (dispatchMeshCommand) {
                const result = await dispatchMeshCommand(nodeDaemonId, 'read_chat', readArgs);
                payload = unwrapReadChatPayload(result);
                if (payload && (payload as { success?: boolean }).success === false) { payload = null; readFailed = true; }
            } else {
                continue; // remote node but no P2P transport — can't read; retry next tick (not a death signal)
            }
        } catch {
            readFailed = true; // session may be gone or node offline
        }
        if (!payload && !readFailed) continue; // null payload that wasn't a hard failure — retry next tick

        if (readFailed || !payload) {
            // R4f backstop (a) — liveness failure. For a never-acked dispatch there is no in-flight
            // turn to protect, so a read failure is a transient probe blip → retry next tick (old
            // behavior). For an ACKED dispatch that we had previously confirmed live, a streak of
            // consecutive read failures means the worker session genuinely went away mid-turn and
            // will never emit its real completion — count it. The actual terminal cleanup of a
            // gone session is owned by PHASE 2.5 (stranded reclaim) / PHASE 5 (orphan prune); here
            // we only record the death observation and STOP holding so those nets can take over,
            // rather than pinning the row on an indefinite hold for a session that is already gone.
            if (isAcked) {
                const prior = inFlightAckedHoldState.get(synthKey);
                const failures = (prior?.consecutiveReadFailures ?? 0) + 1;
                const liveConfirmedSinceAck = prior?.liveConfirmedSinceAck ?? false;
                // A read failure breaks the idle-with-final-assistant run → reset the fast-track streak
                // (transcriptIdleSinceMs cleared by omission) so it must re-accumulate from scratch.
                inFlightAckedHoldState.set(synthKey, { liveConfirmedSinceAck, consecutiveReadFailures: failures });
                if (liveConfirmedSinceAck && failures >= ACKED_DEATH_CONSECUTIVE_READ_FAILURES) {
                    LOG.warn('MeshReconcile', `Acked-hold death signal: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read_chat failed ${failures}x consecutively after a live-confirmed ack — worker session presumed gone mid-turn; releasing the indefinite synth hold to the stranded-reclaim / orphan-prune nets`);
                }
            }
            continue; // no readable transcript this tick → cannot synth here; retry / let backstops act
        }

        // Read succeeded (a conclusive idle/generating status) → the session is reachable: reset the
        // failure streak and mark it live-confirmed-since-ack, so a LATER read failure is recognized
        // as a genuine liveness loss (backstop a) rather than a node that was never reachable. The
        // fast-track idle streak (transcriptIdleSinceMs) is PRESERVED across this reset — it is
        // managed below where the idle + final-assistant signal is actually evaluated.
        const priorHoldState = inFlightAckedHoldState.get(synthKey);
        inFlightAckedHoldState.set(synthKey, {
            liveConfirmedSinceAck: true,
            consecutiveReadFailures: 0,
            ...(priorHoldState?.transcriptIdleSinceMs !== undefined ? { transcriptIdleSinceMs: priorHoldState.transcriptIdleSinceMs } : {}),
        });

        // Only act on a session that has actually settled to idle. A generating /
        // waiting_approval session is mid-turn — synthesizing a completion now would
        // be wrong. (idle is the only status the MCP poll path reconciles too.)
        const nowMs = Date.now();
        if (readChatPayloadStatus(payload) !== 'idle') {
            // Not idle → the worker is genuinely mid-turn (a clear live signal). Keep the
            // live-confirmed flag set (above) but RESET the fast-track idle streak: a turn that
            // resumed generating proves the prior idle was a mid-turn blip, not a settled turn-end.
            inFlightAckedHoldState.set(synthKey, { liveConfirmedSinceAck: true, consecutiveReadFailures: 0 });
            continue;
        }

        // R4f GENERATING-BOUNDARY (acked-hold): a dispatch whose worker was OBSERVED to start
        // generating (the agent:generating_started ack flipped the row to 'acked') is ALIVE and
        // mid-turn — it WILL eventually emit a real terminal. An `idle` read here is therefore
        // presumed a TRANSIENT mid-turn window (a PTY inter-tool-call settle, or final text already
        // rendered while the lifecycle close lags), NOT a settled completion. We HOLD the synth
        // INDEFINITELY rather than racing the worker's (variable, unbounded) emit latency with a
        // finite timer — the failure mode of R4..R4e. This is safe: when the worker's real emit
        // lands it writes a terminal ledger, and reconcileDirectDispatchCompletionFromTranscript's
        // hasTerminalLedgerAfterDispatch makes any later synth an idempotent no-op, so the real emit
        // always wins no matter how late. The hold is released ONLY by the death backstops:
        //   (a) consecutive read failures after a live-confirmed ack (handled above), or
        //   (b) the absolute ACKED_DEATH_DEADLINE_MS since the ack — a notification-loss net set FAR
        //       above any observed emit latency, so it catches a genuinely-wedged worker / lost emit
        //       without racing a normal slow turn.
        // A never-acked dispatch (worker never started) is exempt — no in-flight generation to
        // pre-empt; it keeps the first-idle-tick synth, with the downstream grace + stale-summary
        // guards as its backstops.
        //
        // ACKED-HOLD-IDLE-OVERTRUST: the read is idle. Extract the final-assistant evidence NOW (the
        // same signal the synth below requires) so the fast-track can gate on idle-WITH-final-assistant
        // rather than bare idle. Only when a final visible assistant message is present do we treat
        // this tick as a candidate turn-end and accumulate the fast-track grace streak; a bare idle
        // with no assistant result is the worker still warming up and resets the streak.
        const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
        const evidence = extractFinalAssistantSummaryEvidence(messages);

        if (isAcked) {
            const ackedAtMs = Date.parse(readNonEmptyString(dispatch.updatedAt));
            const sinceAckMs = Number.isFinite(ackedAtMs) ? nowMs - ackedAtMs : Number.POSITIVE_INFINITY;
            const deathDeadlineMs = resolveAckedDeathDeadlineMs();

            // ACKED-HOLD-IDLE-OVERTRUST fast-track. Maintain the continuous idle-with-final-assistant
            // streak. The streak starts (or continues) only while a final visible assistant message is
            // present; a tick with idle-but-no-assistant breaks it (the answer is not yet rendered).
            const holdState = inFlightAckedHoldState.get(synthKey);
            let fastTrackReady = false;
            if (evidence.finalSummary) {
                const idleSinceMs = holdState?.transcriptIdleSinceMs ?? nowMs;
                if (holdState && holdState.transcriptIdleSinceMs === undefined) {
                    inFlightAckedHoldState.set(synthKey, { ...holdState, transcriptIdleSinceMs: idleSinceMs });
                }
                const fastTrackGraceMs = resolveAckedTranscriptFastTrackGraceMs();
                const idleHeldMs = nowMs - idleSinceMs;
                if (idleHeldMs >= fastTrackGraceMs) {
                    fastTrackReady = true;
                    LOG.info('MeshReconcile', `Acked-hold transcript fast-track: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read idle WITH a final assistant message for ${Math.round(idleHeldMs / 1000)}s continuous (grace ${Math.round(fastTrackGraceMs / 1000)}s) — promoting the synth ahead of the ${Math.round(deathDeadlineMs / 1000)}s death backstop; the worker's real emit was lost/late and a later one no-ops idempotently.`);
                }
            } else if (holdState?.transcriptIdleSinceMs !== undefined) {
                // Idle but no final assistant yet → not a turn-end; reset the streak.
                inFlightAckedHoldState.set(synthKey, { ...holdState, transcriptIdleSinceMs: undefined });
            }

            // Hold indefinitely UNLESS the fast-track grace was met OR the absolute death deadline is
            // reached. The fast-track is the new fast path in front of the (preserved) 8-min backstop.
            if (!fastTrackReady && sinceAckMs < deathDeadlineMs) {
                LOG.info('MeshReconcile', `Acked-hold: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read idle ${Number.isFinite(sinceAckMs) ? Math.round(sinceAckMs / 1000) + 's' : '∞'} since the generating_started ack — HOLDING synth (worker presumed alive; a later real emit is idempotent). Transcript fast-track promotes at ${Math.round(resolveAckedTranscriptFastTrackGraceMs() / 1000)}s continuous idle-with-final-assistant; death backstop at ${Math.round(deathDeadlineMs / 1000)}s or on consecutive read failures.`);
                continue;
            }
            if (!fastTrackReady) {
                LOG.warn('MeshReconcile', `Acked-hold death deadline reached: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) still idle ${Math.round(sinceAckMs / 1000)}s after the ack (deadline ${Math.round(deathDeadlineMs / 1000)}s) — synthesizing the missing completion as a notification-loss net (a real emit, if it ever lands, no-ops idempotently).`);
            }
        }

        // R4f (auxiliary, was R4e fix 3) — worker-emit priority. Secondary check: if the worker's
        // REAL terminal emit for this task has already arrived in the pending-events queue (queued
        // for delivery to the coordinator) but not yet written a terminal ledger, YIELD — let the
        // genuine emit surface rather than racing it with a synth that would win the taskId-anchored
        // fingerprint dedup and mask it. Under the R4f acked-hold this is now an auxiliary belt-and-
        // suspenders check (the indefinite hold already defers an acked synth); it still guards the
        // never-acked path and the post-death-deadline acked synth from racing an emit caught in
        // flight at synth-commit time.
        if (realTerminalEmitPendingForTask(mesh.id, taskId)) {
            inFlightAckedHoldState.delete(synthKey);
            LOG.info('MeshReconcile', `Worker-emit priority: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) has a real terminal completion already queued — yielding synth to the worker's own emit`);
            continue;
        }

        if (!evidence.finalSummary) continue; // no assistant result yet — nothing to attribute

        // STALE-SUMMARY guard (modal-parked / reused-session misattribution): a direct
        // dispatch frequently reuses a session that already ran a PRIOR task. read_chat
        // returns the tail of the WHOLE session, so extractFinalAssistantSummaryEvidence
        // picks the latest user-facing assistant message — which, for a task that has
        // barely started (the session momentarily reads idle between turns), is the prior
        // task's final summary. The downstream reconcile proves the summary is after the
        // LEDGER task_dispatched entry; here we additionally have the AUTHORITATIVE per-task
        // dispatchedAt (the dispatch-store row, immune to ledger-ordering quirks), so when
        // the selected transcript message is provably BEFORE this task's own dispatch we
        // refuse it outright — it is a prior task's summary, not this task's output (the
        // 2843ms-duration stale-summary bug where task 2e3f501e copy-pasted 4eca2d9d's
        // summary). When the message carries no usable timestamp we do NOT block here: the
        // downstream reconcile already rejects a non-JSON summary it cannot prove is
        // post-dispatch (transcript_not_proven_after_dispatch), and a structured
        // final_summary_json is self-attributing — so a timeless provider is not
        // over-blocked while the provable-stale case is still caught.
        const dispatchedAtMs = Date.parse(readNonEmptyString(dispatch.dispatchedAt));
        const transcriptAtMs = Date.parse(evidence.transcriptMessageAt ?? '');
        if (Number.isFinite(dispatchedAtMs) && Number.isFinite(transcriptAtMs) && transcriptAtMs < dispatchedAtMs) {
            LOG.info('MeshReconcile', `Stale-summary guard: skipping transcript reconcile for task ${taskId} on node ${nodeId} (mesh ${mesh.id}) — final assistant message (${evidence.transcriptMessageAt}) predates this task's dispatch (${dispatch.dispatchedAt}); it is a prior task's summary`);
            traceMeshEventDrop('reconcile_stale_summary_before_dispatch', {
                taskId, sessionId, nodeId, meshId: mesh.id, event: 'agent:generating_completed',
            }, `transcriptAt=${evidence.transcriptMessageAt} < dispatchedAt=${dispatch.dispatchedAt}`);
            continue;
        }

        // R4f (auxiliary, was R4e fix 2) — live re-probe immediately before committing the synth. A
        // fresh read right now catches a worker that resumed generating since this tick's first read
        // so it is never falsely completed off a stale snapshot. Best-effort: an inconclusive
        // re-probe (transport error/null) falls through to the synth — we already hold a valid idle
        // read from the top of THIS tick, so a re-probe failure must not re-introduce a
        // notification-miss. Under the R4f acked-hold this matters mainly for the never-acked path
        // and the post-death-deadline acked synth (the indefinite hold already deferred a live acked
        // turn); it stays as a final live-state guard at synth-commit time.
        const reprobeStatus = await reprobeWorkerStatus(components, { isLocalNode, nodeDaemonId, readArgs });
        if (reprobeStatus && reprobeStatus !== 'idle') {
            inFlightAckedHoldState.delete(synthKey);
            LOG.info('MeshReconcile', `Live re-probe defer: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read '${reprobeStatus}' at synth-commit time — worker resumed generating; deferring synth to a later tick`);
            continue;
        }

        const providerSessionId = readNonEmptyString(payload.providerSessionId);
        const coordinatorDaemonId = selfIds.find(id => !!id);
        try {
            const result = reconcileDirectDispatchCompletionFromTranscript({
                meshId: mesh.id,
                nodeId,
                sessionId,
                providerType: providerType || undefined,
                providerSessionId: providerSessionId || undefined,
                taskId,
                finalSummary: evidence.finalSummary,
                ...(evidence.transcriptMessageAt ? { transcriptMessageAt: evidence.transcriptMessageAt } : {}),
                ...(coordinatorDaemonId ? { targetCoordinatorDaemonId: coordinatorDaemonId } : {}),
                source: 'daemon_reconcile_transcript_completion',
            });
            if (result.reconciled) {
                LOG.info('MeshReconcile', `Synthesized missing completion (${result.kind}) for task ${taskId} on node ${nodeId} (mesh ${mesh.id})`);
            }
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Transcript completion reconcile threw for task ${taskId}: ${e?.message || e}`);
        }
    }
}

// PHASE 5 helper. Build the live-node view (mesh.nodes decorated with each node's live
// session list) and run the shared prune core in execute mode with the conservative age gate.
//
// Orphan detection needs the SAME live-session evidence the manual MCP prune uses: a node still
// in mesh.nodes whose session list no longer contains the dispatched sessionId is "session not
// present" (prunable); a node missing from mesh.nodes entirely is "node no longer in live mesh"
// (prunable). We obtain live sessions per node via get_status_metadata — local nodes through the
// local commandHandler, remote nodes over P2P (dispatchMeshCommand) — exactly the transports
// PHASE 4 already uses. A node we cannot probe (offline) keeps an empty session list; combined
// with the age gate that only matters once the orphan is genuinely old.
//
// O(1) fast exit: when there are no active direct dispatches at all there is nothing to prune,
// so we skip the (per-node) status probes entirely — an idle mesh costs one indexed query.
async function autoPruneStaleDirectDispatches(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
    minAgeMs: number,
): Promise<void> {
    const directDispatches = getActiveDirectDispatches(mesh.id);
    if (directDispatches.length === 0) return; // nothing dispatched → nothing to prune

    const liveNodes = await collectLiveNodesWithSessions(components, mesh, selfIds, localDaemonId);

    const result = pruneStaleDirectDispatches({
        meshId: mesh.id,
        queue: getQueue(mesh.id),
        ledgerEntries: readLedgerEntries(mesh.id, { tail: 500 }),
        directDispatches,
        nodes: liveNodes,
        execute: true,
        minAgeMs,
        source: 'daemon_reconcile_auto_prune',
    });

    // Log only when something was actually pruned — silence on the common no-op tick.
    if (result.prunedCount > 0) {
        LOG.info('MeshReconcile', `Auto-pruned ${result.prunedCount} orphaned direct dispatch record(s) for mesh ${mesh.id}`);
    }
}

// Probe each node for its live session list (get_status_metadata) and return mesh.nodes
// decorated with a `sessions` array — the shape buildMeshActiveWork / sessionStatusFromNodes
// consume to decide whether a dispatched session is still present. Best-effort: an unreachable
// node yields an empty session list rather than throwing.
async function collectLiveNodesWithSessions(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
): Promise<any[]> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    return Promise.all(mesh.nodes.map(async (node) => {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        const isLocalNode = !nodeDaemonId
            || daemonIdListIncludes(selfIds, nodeDaemonId)
            || daemonIdsEquivalent(nodeDaemonId, localDaemonId);
        let statusResult: unknown;
        try {
            if (isLocalNode) {
                statusResult = await components.commandHandler.handle('get_status_metadata', {});
            } else if (dispatchMeshCommand) {
                statusResult = await dispatchMeshCommand(nodeDaemonId, 'get_status_metadata', {});
            } else {
                return node; // remote node, no P2P transport — leave undecorated
            }
        } catch {
            return node; // unreachable — leave undecorated (empty session list)
        }
        const sessions = extractStatusMetadataSessions(statusResult);
        return sessions.length > 0 ? { ...node, sessions } : node;
    }));
}

// Pull the live session list out of a get_status_metadata result, tolerating the same
// envelope shapes unwrapReadChatPayload handles (direct CommandResult or { payload }/{ result }).
function extractStatusMetadataSessions(raw: unknown): any[] {
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        const record = cursor as Record<string, unknown>;
        const status = record.status && typeof record.status === 'object' ? record.status as Record<string, unknown> : undefined;
        if (status && Array.isArray(status.sessions)) return status.sessions;
        if (Array.isArray(record.sessions)) return record.sessions;
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.data && typeof record.data === 'object') { cursor = record.data; continue; }
        break;
    }
    return [];
}

function extractPendingEvents(raw: unknown): any[] {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
        const events = (raw as Record<string, unknown>).events;
        if (Array.isArray(events)) return events;
    }
    return [];
}

// Flatten a queued PendingMeshCoordinatorEvent into the flat payload shape
// handleMeshForwardEvent expects (mirrors the MCP buildMeshForwardPayloadFromPendingEvent).
function buildForwardPayloadFromPending(event: any): Record<string, unknown> {
    const metadata = event?.metadataEvent && typeof event.metadataEvent === 'object'
        ? event.metadataEvent as Record<string, unknown>
        : {};
    return {
        event: readNonEmptyString(event?.event),
        meshId: readNonEmptyString(event?.meshId),
        nodeId: readNonEmptyString(event?.nodeId) || readNonEmptyString(metadata.meshNodeId),
        workspace: readNonEmptyString(event?.workspace) || readNonEmptyString(metadata.workspace),
        // Preserve the originating coordinator session id across the relay. It is normally
        // carried inside metadataEvent.meshCoordinatorSessionId (spread below), but pass the
        // top-level field through explicitly too so the handleMeshForwardEvent whitelist
        // recovers it regardless of which carrier the producing daemon used.
        ...(readNonEmptyString(event?.targetCoordinatorSessionId)
            ? { targetCoordinatorSessionId: readNonEmptyString(event.targetCoordinatorSessionId) }
            : {}),
        ...metadata,
        // NOTIF-MISS (FIX 3): surface the dispatch task id at the TOP LEVEL so the relay's
        // received-stage trace (and buildRelayMetadataEvent) recovers it regardless of which
        // carrier the producing daemon used. The metadata spread above may carry the id only as
        // `meshActiveTaskId` (a worker provider event), leaving top-level `taskId` unset and the
        // received stage rendering `task=-`. Resolve both carriers into an explicit `taskId` so
        // dedup stays task-scoped end-to-end. Only set when a non-empty id exists (no clobber to
        // undefined when neither is present).
        ...((): Record<string, unknown> => {
            const tid = readNonEmptyString(metadata.taskId) || readNonEmptyString(metadata.meshActiveTaskId);
            return tid ? { taskId: tid } : {};
        })(),
    };
}

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
    LOG.info('MeshReconcile', `Mesh reconcile loop started (interval ${intervalMs}ms)`);
    return {
        stop() {
            clearInterval(timer);
            LOG.info('MeshReconcile', 'Mesh reconcile loop stopped');
        },
    };
}
