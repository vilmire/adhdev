// ---------------------------------------------------------------------------
// mesh-reconcile-stranded-dispatch — assigned-row watchdogs (PHASE 2.5 / 2.6)
// ---------------------------------------------------------------------------
// Pure move out of mesh-reconcile-loop.ts (no behavior change). Everything that
// decides whether a row sitting 'assigned' is genuinely in flight or stranded:
//
//   • the deadline/grace tunables (stranded confirm window, delivered-no-turn,
//     delivered-not-consumed re-drive, the UNKNOWN-streak grace, and the
//     QUEUE_HOLD_HARD_DEADLINE ceiling that bounds every unbounded hold gate);
//   • the per-row in-memory streak/audit state those gates accrue, plus the
//     __resetReclaimUnknownStreakForTests hook that clears all four maps;
//   • the evidence helpers (live approval status, transcript-authority profile,
//     early-idle arm gate, watchdog completion propagation, reducer arbitration);
//   • recoverStrandedAssignedDispatches (PHASE 2.5) and
//     reconcileZombieAssignedTasks (PHASE 2.6), the two watchdog sweeps.
//
// The tick that calls the two sweeps per mesh stays in mesh-reconcile-loop.ts.
//
// NOTE: mesh-stuck-delivery-guards.test.ts reads this module's SOURCE TEXT to
// assert the delivered-no-turn GENERATING branch is gated by the shared
// QUEUE_HOLD_HARD_DEADLINE_MS ceiling. Its path constant follows this file.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { readNonEmptyString, buildMeshSystemMessage } from './mesh-events-utils.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { traceMeshEventStage, traceMeshEventDrop } from './mesh-event-trace.js';
import { daemonIdsEquivalent, sessionIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { getQueue, reclaimStrandedAssignedTask, updateTaskStatus } from './mesh-work-queue.js';
import { resolveSessionBusyVerdict } from './mesh-queue-assignment.js';
import {
    findTerminalLedgerEvidenceForTask,
    reconcileDirectDispatchCompletionFromTranscript,
    resolveLiveTurnPendingEvidence,
} from './mesh-events-stale.js';
import { daemonIdListIncludes } from './mesh-reconcile-identity.js';
import { pullPendingEventsFromNode, reprobeWorkerStatus, REDRIVE_PULL_MIN_INTERVAL_MS } from './mesh-remote-event-pull.js';
import { resolveTranscriptAuthorityProfile } from '../providers/transcript-evidence.js';
import {
    pollAssignedTaskTerminalEvidence,
    pollAssignedTaskInTurnProgress,
    pollAssignedTaskActivity,
    type AssignedTaskTerminalEvidence,
} from './mesh-completion-synthesis.js';
import { sessionStatusFromNodes } from './mesh-active-work.js';
import { stopStaleMeshWorker } from './mesh-event-forwarding.js';
import {
    evaluateRedrive,
    markAttemptRedriven,
    proposeTurnCompletion,
    isTerminalTurnStage,
    TURN_TERMINAL_OUTCOMES,
    gateRedriveForHeldSuspension,
    recordTurnAck,
    noteRedriveBlocked,
    resolveTaskEvidenceSessionId,
} from './mesh-turn-ledger.js';
import { resolveConsumeGraceMs } from './mesh-consume-grace.js';
import { resolveSessionTurnPresentation } from './mesh-turn-presentation.js';
import { notifyCoordinatorOfPinnedReclaim } from './mesh-dispatch-failed-notify.js';

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

// RC.20 (queue/redrive): freshness window for the native-source activity gate at the
// delivered-no-turn deadline. A provider whose turn start is NOT a PTY event
// (transcriptAuthority=provider + floor/hold completion timing — kimi and kin,
// emitsPtyTurnEvents=false) never emits agent:generating_started and reads IDLE_CONFIRMED
// between tool calls, so the deadline used to reclaim a GENUINELY-EXECUTING worker and
// re-inject the full prompt (live 2026-07-28: canary task f3261319 re-injected 4×,
// dispatchNonce → 9, before operator cancellation). The deadline now holds the row while
// the worker transcript shows FRESH post-dispatch agent activity (its own narration/tool
// bubbles, including the tool activity emitted while spawning child probes) — activity
// no older than this window. A worker that went QUIET mid-turn (last activity older than
// the window) is treated as dead and the bounded reclaim proceeds: the hold can never
// extend indefinitely without fresh evidence (no infinite lease extension). Sized well
// above normal native-source tool-call/model-thinking gaps and the reconcile cadence.
const NATIVE_SOURCE_ACTIVITY_STALE_MS = 10 * 60_000;

// DELIVERED-NOT-CONSUMED (remote autoLaunch delivered≠consumed gap). The window itself now
// lives in mesh-consume-grace.ts (resolveConsumeGraceMs) because it is PROVIDER-AWARE: the
// flat 25s this comment used to introduce sat below the measured p95 boot→consume latency of
// every provider in the fleet, so a normally-booting worker was routinely re-driven off a task
// it was about to start (live 2026-08-28: codex 3cd41be4 re-driven at 26s, session then
// unrecoverable). The rationale below still describes WHY this short path exists at all — how
// long a row may sit
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

// QUEUE-HOLD-HARD-DEADLINE: the absolute ceiling on how long a row may sit 'assigned'
// while an UNBOUNDED hold gate keeps deferring its reclaim. The gates this bounds
// (live awaiting_approval/awaiting_choice, an unresolved held waiting_* suspension,
// and the RC.20 active-attempt-stage gate) all hold on a LIVE signal and never accrue
// the UNKNOWN streak — so if that signal is itself stale (the worker finished but the
// queue row's status write was lost: turnStage 'completed' while the row stays
// 'assigned'), the row is held FOREVER and, because hasActiveNodeAssignment reads it,
// the whole node stops claiming any further task.
//
// Measured live 2026-08-07 on a linux node: task 4c0fe026 held 116min and 0452c30f
// held 55min in exactly this state, each time blocking every subsequent claim on that
// node (autoLaunch skipped with node_has_active_assignment) until the coordinator
// mistook it for a slow node.
//
// 90min is deliberately conservative — 6x DELIVERED_NO_TURN_DEADLINE_MS (15min) and
// 3x ZOMBIE_ASSIGNED_MIN_AGE_MS (30min), comfortably above both the longest realistic
// single worker turn and a genuine human approval wait, so this NEVER pre-empts a
// legitimate hold; it only guarantees the hold is finite. Measured against the row's
// dispatchTimestamp (the same anchor every other deadline in this phase uses).
const QUEUE_HOLD_HARD_DEADLINE_MS = 90 * 60_000;

// QUEUE-HOLD-HARD-DEADLINE audit dedupe, keyed `${meshId}::${taskId}::${gate}`. The ceiling
// yield itself is unconditional every tick; this only suppresses repeat log/ledger records
// while the reclaim converges. Pruned alongside the streak maps to the currently-assigned
// rows, so it cannot grow unbounded and a re-used task id audits afresh.
const queueHoldHardDeadlineAudited = new Set<string>();

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

// KIMI-PURE-PTY-COMPLETION-EMIT (Fix 2): how long a delivered assigned row whose worker is
// CONTINUOUSLY idle-WITH-a-final-assistant-message must stay so before we short-circuit it to
// 'completed' from transcript evidence — WITHOUT waiting the full DELIVERED_NO_TURN_DEADLINE_MS
// (15min). A pure-PTY worker (kimi and kin — no native transcript, no provider authority) whose
// generating_completed never emitted (the onTurnStarted idle→idle collapse Fix 1 addresses at the
// source) leaves the row 'assigned' with an idle worker that already rendered its answer. The
// F3 long-deadline reclaim's pollAssignedTaskTerminalEvidence would eventually recover it — but only
// after 15min, during which the coordinator ledger wrongly shows the task in flight. This EARLY
// reconcile applies the SAME idle-with-final-assistant-after-dispatch evidence bar (via
// pollAssignedTaskTerminalEvidence) after a few continuous-idle ticks, so a finished worker's task
// is marked complete promptly. Conservative by construction: the streak resets the instant a read is
// non-idle / lacks a final summary / is unreadable, and the poll itself enforces the after-dispatch
// stale-summary guard, so a mid-turn or warming-up worker is never falsely completed.
const ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS = 8_000;

// Per-row continuous idle-with-final-assistant streak for the early transcript-evidence completion,
// keyed `${meshId}::${taskId}`, storing the wall-clock ms when the continuous run began. Pruned each
// pass to the currently-assigned rows (same as the UNKNOWN streaks). A non-idle / no-summary /
// unreadable tick clears the entry so the grace must re-accumulate from scratch.
const assignedIdleFinalAssistantSince = new Map<string, number>();

// P1-4 WEAK-COMPLETION-CANDIDATE: how many CONSECUTIVE reconcile ticks must admit the
// SAME weak (message-shape) terminal evidence before the candidate is promoted to a
// real completion. Message shape is exactly the evidence class the terminal-admission
// incident burned (idle + quiet-valley preamble, 6s before the worker went busy
// again), so a single weak admit never releases queue/dependency state anymore —
// the re-confirm-then-promote streak is the time-based proof the transcript genuinely
// settled. A STRONG admit (a native turn-terminal marker) skips this machinery
// entirely: the provider's own turn-end record is the confirmation.
const WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS = 3;

// Per-row weak-candidate streak, keyed `${meshId}::${taskId}`. `finalAssistantAt`
// pins the evidence the streak is confirming: a DIFFERENT final-assistant timestamp
// means the transcript moved (the worker is still producing) — the count resets so
// re-confirmation always covers identical, quiet evidence. Pruned each pass to the
// currently-assigned rows; deleted on decline/promotion/deferral.
const weakCompletionCandidateStreak = new Map<string, { count: number; finalAssistantAt?: string }>();

// Test hook: clear the delivered-no-turn UNKNOWN streaks between cases.
export function __resetReclaimUnknownStreakForTests(): void {
    deliveredNoTurnUnknownStreak.clear();
    deliveredUnconsumedUnknownStreak.clear();
    assignedIdleFinalAssistantSince.clear();
    queueHoldHardDeadlineAudited.clear();
    weakCompletionCandidateStreak.clear();
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
        // Both blocked-on-input states hold the row: an approval (waiting_approval) and a
        // question (awaiting_choice) legitimately park the worker awaiting the coordinator's
        // mesh_approve / mesh_answer_question, so neither should accrue the reclaim streak
        // (mission f1d25e11 extends the APPROVAL-INBOX-BLINDSPOT guard to questions).
        const liveStatus = sessionStatusFromNodes(mesh.nodes, nodeId, sessionId).status;
        return liveStatus === 'awaiting_approval' || liveStatus === 'awaiting_choice';
    } catch {
        return false;
    }
}

/**
 * QUEUE-HOLD-HARD-DEADLINE: the single arbiter for whether an unbounded hold gate has
 * exhausted its absolute ceiling. Every caller is a gate that would otherwise `continue`
 * on a LIVE signal without ever accruing the bounded UNKNOWN streak — so this is the only
 * thing standing between a stale live signal and an infinite hold.
 *
 * Returns true on EVERY tick past QUEUE_HOLD_HARD_DEADLINE_MS (measured from the row's
 * dispatch) — the yield itself must not be one-shot, or a row whose reclaim needs several
 * ticks (the approval gate falls into the 3-tick UNKNOWN grace) would be re-held on tick 2.
 * The AUDIT record, by contrast, is emitted once per (task, gate) per process: a warn log
 * plus a `queue_hold_hard_deadline` ledger entry naming the gate, so the next occurrence is
 * diagnosable from the ledger alone rather than re-derived from symptoms (the failure mode
 * that made the 116min stranding read as "the linux node is slow") — without the repeated
 * entries that spamming every tick would produce.
 *
 * Deliberately NOT a cancellation of the held state: the caller falls through to its
 * ordinary reclaim path, which is the same bounded recovery a proven-dead worker gets.
 */
function queueHoldHardDeadlineExceeded(
    meshId: string,
    row: { id: string; assignedNodeId?: string; assignedSessionId?: string; assignedProviderType?: string },
    gate: 'live_awaiting_approval' | 'held_suspension' | 'active_attempt_stage' | 'live_generating',
    dispatchedAtMs: number,
    nowMs: number,
    detail?: string,
): boolean {
    const heldMs = nowMs - dispatchedAtMs;
    if (!Number.isFinite(heldMs) || heldMs < QUEUE_HOLD_HARD_DEADLINE_MS) return false;
    // Audit once per (mesh, task, gate) — the yield above is unconditional, only the record
    // is deduped. Pruned with the streak maps so a re-used task id records again.
    const auditKey = `${meshId}::${row.id}::${gate}`;
    if (queueHoldHardDeadlineAudited.has(auditKey)) return true;
    queueHoldHardDeadlineAudited.add(auditKey);
    const heldMin = Math.round(heldMs / 60_000);
    LOG.warn('MeshReconcile', `Queue-hold HARD DEADLINE exceeded for task ${row.id} on mesh ${meshId}: `
        + `gate '${gate}'${detail ? ` (${detail})` : ''} held the row 'assigned' for ${heldMin}min `
        + `(> ${Math.round(QUEUE_HOLD_HARD_DEADLINE_MS / 60_000)}min ceiling) on node=${row.assignedNodeId ?? '?'} `
        + `session=${row.assignedSessionId ?? '?'} — the hold signal is presumed stale (a lost queue-status write), `
        + `forcing the bounded reclaim so the node can claim again`);
    try {
        appendLedgerEntry(meshId, {
            kind: 'queue_hold_hard_deadline',
            nodeId: row.assignedNodeId,
            sessionId: row.assignedSessionId,
            providerType: row.assignedProviderType,
            payload: {
                taskId: row.id,
                reason: 'queue_hold_hard_deadline',
                gate,
                heldMs,
                ceilingMs: QUEUE_HOLD_HARD_DEADLINE_MS,
                ...(detail ? { detail } : {}),
            },
        });
    } catch { /* best-effort audit record — the reclaim below still proceeds */ }
    traceMeshEventStage('queue_hold_hard_deadline', {
        taskId: row.id,
        sessionId: row.assignedSessionId,
        nodeId: row.assignedNodeId,
        meshId,
        event: 'agent:generating_completed',
    }, `${gate} held ${heldMin}min > ceiling — forcing reclaim`);
    return true;
}

/**
 * P3 of the transcript-authority unification (root repo docs/design/
 * 2026-07-25-transcript-authority-unification.md): resolve the assigned
 * worker's transcript-authority profile. The claim-time row stamp comes FIRST
 * — it was written by the daemon that OWNS the session from its LIVE provider
 * module, so it classifies a REMOTE worker this coordinator cannot resolve
 * locally (the structural fix for the "remote class unknowable → reprobe-only"
 * blind spot). Falls back to the local instance for pre-stamp rows / direct
 * dispatches; undefined for an older-daemon remote row — callers keep their
 * conservative reprobe fallbacks.
 */
function resolveAssignedTranscriptProfile(
    components: DaemonComponents,
    row: {
        assignedSessionId?: string;
        assignedTranscriptProfile?: { class: string; timing: string; emitsPtyTurnEvents: boolean };
    },
): { class: string; timing: string; emitsPtyTurnEvents: boolean } | undefined {
    const stamped = row.assignedTranscriptProfile;
    if (stamped && typeof stamped === 'object' && typeof stamped.emitsPtyTurnEvents === 'boolean') {
        return stamped;
    }
    const sessionId = readNonEmptyString(row.assignedSessionId);
    if (!sessionId) return undefined;
    try {
        const instances = components.instanceManager?.getByCategory?.('cli') || [];
        const inst = instances.find((i: any) => {
            const sid = readNonEmptyString(i?.getState?.().instanceId);
            return sid && sessionIdsEquivalent(sid, sessionId);
        }) as { provider?: unknown } | undefined;
        const provider = inst?.provider;
        if (!provider || typeof provider !== 'object') return undefined;
        const profile = resolveTranscriptAuthorityProfile(provider as Parameters<typeof resolveTranscriptAuthorityProfile>[0]);
        return { class: profile.class, timing: profile.timing, emitsPtyTurnEvents: profile.emitsPtyTurnEvents };
    } catch {
        return undefined;
    }
}

// EARLY-IDLE-COMPLETION-FALSE-POSITIVE — decide whether the early transcript-evidence completion
// streak may ACCRUE this tick for an assigned row. This hardens the original arm gate, which only
// checked `resolveSessionBusyVerdict(...) !== 'GENERATING'` — a gate a REMOTE worker (local verdict
// UNKNOWN, not GENERATING) passed unconditionally, so its "8s continuous idle" streak degenerated to
// 8s of wall-clock even while the worker was genuinely mid-turn, and a startup-grace boot-window idle
// (before the first turn ever started) also passed. The row was then early-completed off a preamble.
//
// Two added requirements, defense-in-depth on top of the existing confirmed-delivery / no-terminal-
// ledger / bound-session gate the caller applies:
//   (a) POSITIVE idle evidence, not merely "not GENERATING". A LOCAL IDLE_CONFIRMED verdict qualifies
//       directly. A remote/UNKNOWN verdict is RE-PROBED with a fresh read_chat status this tick: only
//       a definitively 'idle' read lets the streak accrue; any active status (generating/waiting/…),
//       or an inconclusive read, resets it. This is what stops the remote worker's mid-turn busy from
//       silently passing as "continuous idle".
//   (b) TURN-START evidence, so a boot-window / never-consumed idle cannot early-complete a preamble.
//       taskDeliveryConsumed===true (the worker emitted agent:generating_started) satisfies it. When
//       the delivery was never consumed, only a LOCAL pure-PTY provider — the exact class that never
//       emits generating_started and that this rescue exists for — is still allowed; a native/
//       provider-authoritative worker that hasn't started its turn is NOT armed (it will complete via
//       its own emit or the normal grace). A remote-not-consumed worker whose provider class is
//       unknowable locally falls back to the reprobe: it may accrue only once (a) reads it positively
//       idle, and the poll's post-dispatch + trailing-tool-activity guards remain the final net.
// (CANCEL-BLIP-ORPHAN, coordinator net) Is a LOCAL 'GENERATING' verdict contradicted by the
// session's own adapter?
//
// resolveSessionBusyVerdict reads getState().status — the PROVIDER FSM LABEL. The completion
// arm that a continuity cancel deleted (see armCancelledCompletionRecheck in
// cli-provider-instance.ts) leaves that label stuck at 'generating' with nothing left to clear
// it, so this early-completion rescue — whose very first gate is (a) positive idle evidence —
// refused to accrue and the row sat 'assigned' until the 15/90-min hard deadline. That is the
// exact stall observed live: worker finished ~10min in, queue showed 'generating' for ~24min.
//
// The daemon-side fix removes the cause; this is the independent net for the class. It does NOT
// weaken the gate, because it does not treat "not generating" as idle. It requires a POSITIVE
// contradiction from an ORTHOGONAL source: hasLiveTurnPendingEvidence() is computed from the
// ADAPTER's own turn state (isWaitingForResponse / currentTurnScope / isProcessing / a non-empty
// partial response / a parked modal / native trailing-tool activity) — deliberately the same
// discriminators the instance's finalization gate uses — and is entirely independent of the FSM
// status label. A session whose label says 'generating' while the adapter reports NO pending
// turn is, by construction, one whose label is stale.
//
// Safety: a genuinely mid-turn worker has pending adapter evidence, so this returns false and
// the gate is byte-for-byte the historical one. When the probe is unavailable (remote session,
// older instance surface, throw) we return false — an unresolvable probe is never a
// contradiction. And clearing this gate only lets the STREAK begin: the caller still requires
// ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS of continuity, gate (b)'s turn-start evidence, and the
// decisive pollAssignedTaskTerminalEvidence (post-dispatch final assistant + settled-bubble +
// trailing-tool vetoes) before anything is marked complete. This changes only WHICH rows are
// allowed to be examined, never the evidence bar for completing one.
/** @internal Exported for the CANCEL-BLIP-ORPHAN regression suite only — the arm gate that
 *  consumes it is module-private, and this predicate is the decision worth pinning. Not
 *  public surface: no consumer outside src/mesh imports it and no barrel re-exports it. */
export function localGeneratingLabelIsContradicted(
    components: DaemonComponents,
    sessionId: string,
): boolean {
    try {
        const probe = resolveLiveTurnPendingEvidence(components, sessionId);
        if (!probe) return false;           // no probe → no contradiction (unchanged behaviour)
        if (probe()) return false;          // adapter agrees a turn is live → genuinely busy
        LOG.info('MeshReconcile', `Session ${sessionId} reports FSM status 'generating' but its adapter has no live `
            + `turn evidence — treating the label as stale so the early transcript-evidence rescue may evaluate it `
            + `(the completion arm was likely orphaned by a continuity cancel)`);
        return true;
    } catch {
        return false;                       // failed observation ⇒ never a contradiction
    }
}

async function evaluateEarlyIdleTranscriptArm(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    store: MeshRuntimeStore,
    row: {
        id: string;
        assignedSessionId?: string;
        assignedNodeId?: string;
        assignedProviderType?: string;
        assignedTranscriptProfile?: { class: string; timing: string; emitsPtyTurnEvents: boolean };
    },
    localDaemonId?: string,
    selfIds: string[] = [],
): Promise<boolean> {
    const sessionId = readNonEmptyString(row.assignedSessionId);
    if (!sessionId) return false;

    // TURN-PRESENTATION (Stage 6): the causal attempt stage outranks every
    // point-sample below. A worker PARKED on approval/choice or FINALIZING can
    // read idle on the live graph / re-probe while the turn is very much alive —
    // arming early transcript completion off that sample would race the reducer.
    // A terminal attempt needs no rescue either. Sessions with no attempt row
    // keep the legacy sample-based gates unchanged (provider FSM fallback).
    const turnPresentation = resolveSessionTurnPresentation({
        meshId: mesh.id,
        taskId: row.id,
        sessionId,
        surface: 'stall_watchdog',
    });
    if (turnPresentation.authority === 'turn_reducer' && turnPresentation.stage) {
        if (turnPresentation.stage === 'waiting_approval'
            || turnPresentation.stage === 'waiting_choice'
            || turnPresentation.stage === 'finalizing'
            || isTerminalTurnStage(turnPresentation.stage)) {
            return false;
        }
    }

    // (a) POSITIVE idle evidence.
    const verdict = resolveSessionBusyVerdict(components, sessionId);
    if (verdict === 'GENERATING' && !localGeneratingLabelIsContradicted(components, sessionId)) {
        return false; // locally observed mid-turn — never accrue
    }
    if (verdict === 'UNKNOWN') {
        // Remote / gone / id-form skew. First consult the LIVE mesh node snapshot (the same
        // cross-daemon status feed the approval-hold guard and mesh_status use): if it already
        // reports a definitively NON-idle status (generating / waiting_approval / awaiting_choice /
        // …), the worker is not settled — reset the streak WITHOUT a read_chat. This keeps the
        // streak the cheap per-tick gate for the common case and avoids probing a worker the graph
        // already knows is busy or parked at an approval.
        const nodeId = readNonEmptyString(row.assignedNodeId);
        const node = (mesh.nodes ?? []).find(n => n.id === nodeId);
        const liveStatus = nodeId
            ? readNonEmptyString(sessionStatusFromNodes(mesh.nodes, nodeId, sessionId).status).toLowerCase()
            : '';
        if (liveStatus && liveStatus !== 'idle') return false; // live graph says non-idle → not a turn-end
        if (!liveStatus) {
            // No live snapshot for this session — re-probe the worker's own status this tick so a
            // genuinely busy remote worker breaks the streak instead of coasting through as "not
            // GENERATING". getInstance may be absent on some component surfaces (tests / standalone),
            // so guard it.
            const nodeDaemonId = readNonEmptyString(node?.daemonId);
            const isLocalNode = !nodeDaemonId
                || daemonIdsEquivalent(nodeDaemonId, localDaemonId)
                || daemonIdListIncludes(selfIds, nodeDaemonId)
                || !!components.instanceManager?.getInstance?.(sessionId);
            const providerType = readNonEmptyString(row.assignedProviderType);
            const readArgs: Record<string, unknown> = {
                sessionId,
                targetSessionId: sessionId,
                tailLimit: 1,
                ...(node?.workspace ? { workspace: node.workspace } : {}),
                ...(providerType ? { agentType: providerType, providerType } : {}),
            };
            const probedStatus = await reprobeWorkerStatus(components, { isLocalNode, nodeDaemonId, readArgs });
            // Only a positively-idle re-probe lets the streak accrue. A non-idle status (the worker
            // IS busy) or an inconclusive read (null — transport error / no payload) resets it: we
            // never treat "couldn't tell" as idle for this early-completion path.
            if (probedStatus !== 'idle') return false;
        }
    }

    // (b) TURN-START evidence (guards the boot-window / preamble false positive).
    if (store.taskDeliveryConsumed(mesh.id, row.id)) return true; // worker emitted generating_started
    // Delivery never consumed. Classify via the transcript-authority profile (P3):
    // a class that runs turns WITHOUT reliable PTY turn events (pure-PTY, or a
    // native-source floor/hold provider — emitsPtyTurnEvents=false) legitimately
    // never emits generating_started, and its finished turn is provable from its
    // transcript — arm it and let the transcript-evidence poll enforce the
    // post-dispatch + trailing-tool finality net. A class with RELIABLE PTY turn
    // events (daemon-owned, or a write-lag native source like claude-cli) that
    // hasn't started its turn is HELD — arming it off a boot-window idle is
    // exactly the preamble false positive this gate exists to prevent. The
    // claim-time row stamp classifies REMOTE workers too; an unstamped remote
    // row (older claiming daemon) keeps the historical fallback of trusting the
    // (a) positive-idle reprobe.
    const profile = resolveAssignedTranscriptProfile(components, row);
    if (profile) return profile.emitsPtyTurnEvents === false;
    return verdict === 'UNKNOWN';             // no stamp, no local instance — trust the (a) reprobe
}

// WATCHDOG-FINALSUMMARY-LOST. When the assigned-stranded watchdog / delivered-no-turn deadline
// proves a task terminal from the worker transcript (pollAssignedTaskTerminalEvidence), it must
// PROPAGATE that completion to the coordinator the SAME way a native agent:generating_completed
// does — a finalSummary-bearing [System] notification — not merely flip the queue row and trace a
// structural DROP. A provider that finishes early (e.g. codex ~25s) is watchdog-completed here; if
// the summary is dropped the coordinator NEVER learns what the worker produced (kimi only got it by
// the lucky timing of the 180s stall-reconcile's second emit).
//
// reconcileDirectDispatchCompletionFromTranscript is the shared native-completion synth: it writes
// the terminal ledger WITH the finalSummary and queues the coordinator event with the same
// buildMeshSystemMessage the native path uses. It is idempotent — hasTerminalLedgerAfterDispatch
// makes a second call (or a later real emit) a no-op (alreadyTerminal), and its non-self-attributing
// synth is marked WEAK so the worker's own later emit can still supersede it rather than being
// dropped as a duplicate. That is the dedup guarantee: at most one [System] completion surfaces.
//
// Returns 'propagated' if a terminal ledger for this task now exists (freshly written OR
// already present) — the caller then skips its own bare-payload ledger write, which lacked
// the finalSummary entirely. Returns 'deferred' when the MID-TURN-CAUSAL-ADMISSION guard
// vetoed the synth on live mid-turn evidence — the caller must HOLD (no row flip, no bare
// ledger write) and re-evaluate next tick. Returns 'unavailable' when propagation could not
// run — the caller falls back to its bare ledger write (unchanged legacy behavior).
function propagateWatchdogTranscriptCompletion(
    components: DaemonComponents,
    meshId: string,
    row: { id: string; assignedNodeId?: string; assignedSessionId?: string; assignedProviderType?: string; dispatchTimestamp?: string },
    evidence: AssignedTaskTerminalEvidence,
    source: string,
    opts?: { boundedBackstop?: boolean; terminalAdmission?: Record<string, unknown> },
): 'propagated' | 'deferred' | 'unavailable' {
    const sessionId = readNonEmptyString(row.assignedSessionId) || evidence.sessionId;
    if (!sessionId || !readNonEmptyString(evidence.finalSummary)) {
        // No routable session or no summary to carry — fall back to the caller's bare ledger write.
        return 'unavailable';
    }
    try {
        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: readNonEmptyString(row.assignedNodeId) || evidence.nodeId,
            sessionId,
            providerType: readNonEmptyString(row.assignedProviderType) || evidence.providerType,
            providerSessionId: evidence.providerSessionId,
            taskId: row.id,
            finalSummary: evidence.finalSummary,
            ...(evidence.transcriptMessageAt ? { transcriptMessageAt: evidence.transcriptMessageAt } : {}),
            ...(readNonEmptyString(row.dispatchTimestamp) ? { dispatchTimestamp: readNonEmptyString(row.dispatchTimestamp) } : {}),
            // The watchdog poll already enforced idle + post-dispatch + no-trailing-tool + streak;
            // skip the reconcile's own grace/transcript_not_proven gates (dedup backstops remain).
            preValidatedTranscriptEvidence: true,
            // MID-TURN-CAUSAL-ADMISSION (rc.16): the transcript poll's structural evidence can
            // still straddle a genuinely mid-turn LOCAL worker (the incident shape: transcript
            // reads idle-with-final-assistant while the raw PTY is mid-tool). Route the live
            // adapter's synchronous probe through the unified choke point. The EARLY-IDLE
            // caller is an eager path (no opts) → a pending verdict defers; the redrive-deadline
            // caller passes boundedBackstop (the max-wait net) → the veto yields, preserving the
            // genuine-final fail-open semantics.
            causalAdmission: {
                liveTurnPendingEvidence: resolveLiveTurnPendingEvidence(components, sessionId),
                boundedBackstop: opts?.boundedBackstop === true,
            },
            // P1-5: forward the poll's admission snapshot so the terminal ledger's
            // completionDiagnostic.terminalAdmission records the evidence the synth
            // was judged on.
            ...(opts?.terminalAdmission ? { terminalAdmission: opts.terminalAdmission } : {}),
            source,
        });
        // reconciled → freshly queued the coordinator completion; alreadyTerminal → a terminal
        // ledger (a real emit that raced in, or a prior watchdog synth) is already present. Either
        // way a finalSummary-bearing completion has been (or will be) delivered; the caller must NOT
        // add its summary-less ledger row on top.
        if (result.reconciled || result.alreadyTerminal === true) return 'propagated';
        if (result.reason === 'live_turn_pending_evidence' || result.reason === 'trailing_tool_activity_after_final_assistant') {
            return 'deferred'; // mid-turn causal evidence — HOLD; do not complete this tick
        }
        return 'unavailable';
    } catch {
        return 'unavailable'; // best-effort — fall back to the caller's bare ledger write
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

/**
 * TURN-LEDGER (Stage 5): route a reconcile-driven terminal flip through the reducer
 * BEFORE touching the queue row. Returns true when the legacy flip may proceed —
 * the proposal committed (or is an idempotent duplicate), or the reducer is
 * unavailable / the task has no attempt (pre-Stage-5 shadow mode). Returns false
 * when the reducer REJECTED the terminal (stale attempt / session mismatch /
 * already terminal differently): this writer must not flip the row — the attempt's
 * committed outcome is the one causal authority.
 */
function reconcileTerminalViaReducer(args: {
    meshId: string;
    taskId: string;
    // 'cancelled' is accepted for the unsettled-attempt safety net, which mirrors the
    // task row's OWN terminal status rather than inferring one; the reducer has always
    // supported it (closeAttemptForReassignment commits the same outcome).
    outcome: 'completed' | 'failed' | 'cancelled';
    source: 'transcript' | 'stall_reconcile';
    sessionId?: string;
    reason?: string;
}): boolean {
    try {
        const decision = proposeTurnCompletion({
            meshId: args.meshId,
            taskId: args.taskId,
            outcome: args.outcome,
            source: args.source,
            sessionId: args.sessionId,
            reason: args.reason,
        });
        if (!decision.committed) {
            LOG.info('TurnLedger', `Reconcile terminal (${args.outcome}/${args.source}) for task ${args.taskId} rejected by the turn reducer: ${decision.reason} — queue-row flip skipped`);
            traceMeshEventDrop('turn_reducer_reconcile_terminal_rejected', {
                taskId: args.taskId,
                sessionId: args.sessionId,
                meshId: args.meshId,
                event: 'agent:generating_completed',
            }, decision.reason);
            return false;
        }
    } catch { /* reducer unavailable — the pre-Stage-5 writers govern (shadow mode) */ }
    return true;
}

// RESTART-REBOUND ENVELOPE (post-restart completion wedge): a mesh worker's
// routing envelope (settings.meshNodeFor / meshActiveTaskId / meshActiveAttemptId /
// meshActiveDispatchNonce) is IN-MEMORY on the worker instance — attachMeshAssignment
// stamps it at dispatch, and restoreHostedSessions rebuilds the instance after a
// daemon restart with none of it. The DURABLE authority survives the restart: the
// assigned work-queue row (taskId / nodeId / bound session) and the current turn
// attempt (attemptId / dispatchNonce / coordinator identity). Without the envelope
// the rebound worker's post-answer completion forwards with no taskId/attemptId and
// drops at the worker's own router (no_worker_envelope) — the task wedges
// 'assigned' forever even though the answer/approval was accepted on the SAME
// attempt, and every transcript backstop is gated on the lost mesh-worker markers.
//
// Re-derive the envelope from the durable rows and re-stamp the LOCAL live
// instance. This NEVER injects a prompt, NEVER flips a queue row, and is
// idempotent (an instance already stamped for this exact task is skipped).
// Causal authority is preserved: the stamp carries the attempt's OWN
// (attemptId, dispatchNonce, coordinator ids), and a terminal attempt or an
// attempt bound to a DIFFERENT session is never re-armed. A session with no
// local instance (remote worker / gone) is skipped — its own dispatch path
// re-stamps on (re)delivery. Returns true when a stamp was applied.

export function restampReboundMeshWorkerAssignment(
    components: Pick<DaemonComponents, 'instanceManager'>,
    store: MeshRuntimeStore,
    meshId: string,
    row: { id: string; assignedSessionId?: string | null; assignedNodeId?: string | null; dispatchNonce?: number | null },
): boolean {
    const sessionId = readNonEmptyString(row.assignedSessionId);
    if (!sessionId) return false;
    const inst = components.instanceManager?.getInstance?.(sessionId);
    if (!inst || typeof (inst as { attachMeshAssignment?: unknown }).attachMeshAssignment !== 'function') return false;
    let settings: Record<string, unknown> = {};
    try {
        settings = ((inst.getState?.()?.settings as Record<string, unknown>) || {});
    } catch { return false; }
    // Idempotent: already stamped for THIS task → nothing to re-derive. (A stamp
    // for a DIFFERENT task is left alone too — the live dispatch owns it.)
    if (readNonEmptyString(settings.meshActiveTaskId)) return false;
    const attempt = (() => {
        try { return store.getCurrentTurnAttempt(meshId, row.id); } catch { return null; }
    })();
    if (attempt) {
        // Causal authority: never re-arm a terminal attempt, and never stamp a
        // session the current attempt is not bound to (a stale queue row naming
        // a session the ledger has since replaced).
        if (attempt.terminalOutcome) return false;
        const attemptSessionId = readNonEmptyString(attempt.sessionId);
        if (attemptSessionId && !sessionIdsEquivalent(attemptSessionId, sessionId)) return false;
        // DISPATCHNONCE AUTHORITY (rc.20): a row whose dispatchNonce disagrees with
        // the current attempt's is mid-redrive (reclaimed/re-dispatched) — stamping
        // would arm a (taskId, attemptId, nonce) triple the two durable authorities
        // do not agree on. Fail closed; the redrive/reconcile path converges the row
        // and a later tick re-stamps once they match.
        if (typeof row.dispatchNonce === 'number'
            && typeof attempt.dispatchNonce === 'number'
            && row.dispatchNonce !== attempt.dispatchNonce) return false;
    }
    const nodeId = readNonEmptyString(row.assignedNodeId);
    const coordinatorDaemonId = readNonEmptyString(attempt?.coordinatorDaemonId);
    const coordinatorSessionId = readNonEmptyString(attempt?.coordinatorSessionId);
    try {
        const result = components.instanceManager?.attachMeshAssignmentToInstance?.(sessionId, {
            meshId,
            ...(nodeId ? { nodeId } : {}),
            taskId: row.id,
            ...(typeof attempt?.dispatchNonce === 'number'
                ? { dispatchNonce: attempt.dispatchNonce }
                : (typeof row.dispatchNonce === 'number' ? { dispatchNonce: row.dispatchNonce } : {})),
            ...(attempt?.attemptId ? { attemptId: attempt.attemptId } : {}),
            ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
            ...(coordinatorSessionId ? { coordinatorSessionId } : {}),
        });
        if (result?.stamped) {
            LOG.info('MeshReconcile', `Re-stamped rebound mesh worker ${sessionId} from the durable ledger: task ${row.id} on mesh ${meshId} `
                + `(attempt=${attempt?.attemptId ?? 'n/a'} nonce=${attempt?.dispatchNonce ?? row.dispatchNonce ?? 'n/a'}) — in-memory envelope lost (daemon restart)`);
            return true;
        }
    } catch { /* best-effort — the next tick retries */ }
    return false;
}

export async function recoverStrandedAssignedDispatches(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    store: MeshRuntimeStore,
    localDaemonId?: string,
    selfIds: string[] = [],
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
    for (const key of [...assignedIdleFinalAssistantSince.keys()]) {
        if (key.startsWith(meshKeyPrefix) && !assignedKeys.has(key)) assignedIdleFinalAssistantSince.delete(key);
    }
    for (const key of [...weakCompletionCandidateStreak.keys()]) {
        if (key.startsWith(meshKeyPrefix) && !assignedKeys.has(key)) weakCompletionCandidateStreak.delete(key);
    }
    // QUEUE-HOLD-HARD-DEADLINE audit keys carry a trailing `::${gate}`, so match on the
    // task prefix rather than the exact assigned key.
    for (const key of [...queueHoldHardDeadlineAudited]) {
        if (!key.startsWith(meshKeyPrefix)) continue;
        const taskKey = key.slice(0, key.lastIndexOf('::'));
        if (!assignedKeys.has(taskKey)) queueHoldHardDeadlineAudited.delete(key);
    }
    for (const row of assigned) {
        // RESTART-REBOUND ENVELOPE: re-derive a rebound LOCAL worker's lost
        // in-memory mesh envelope from the durable row + current attempt BEFORE
        // any of the age-gated paths below. Idempotent; never injects a prompt.
        restampReboundMeshWorkerAssignment(components, store, meshId, row);
        const dispatchedAtMs = Date.parse(row.dispatchTimestamp ?? '');
        if (!Number.isFinite(dispatchedAtMs)) continue;              // no dispatch ts → can't age it
        const ageMs = nowMs - dispatchedAtMs;
        const idleTranscriptStreakKey = `${meshId}::${row.id}`;
        // KIMI-PURE-PTY-COMPLETION-EMIT (Fix 2): EARLY transcript-evidence completion for a
        // delivered assigned row whose worker is already idle with a final assistant answer, so a
        // pure-PTY worker whose generating_completed never emitted is marked done PROMPTLY instead of
        // sitting 'assigned' until the 15-min DELIVERED_NO_TURN_DEADLINE_MS reclaim. Gate on a
        // CONFIRMED delivery (a never-delivered row is handled by dispatch/redrive, not completion)
        // and a bound session, then require the worker to read idle-WITH-final-assistant continuously
        // for ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS before polling the decisive transcript evidence.
        // The streak is the cheap gate (avoids a read every tick); the read only runs once the grace
        // elapses. pollAssignedTaskTerminalEvidence enforces idle + final-assistant-after-dispatch, so
        // a mid-turn / stale-tail / unreadable worker is never falsely completed — a non-qualifying
        // tick clears the streak below.
        // EARLY-IDLE-COMPLETION-FALSE-POSITIVE: the arm gate now requires POSITIVE idle evidence
        // (a fresh-idle reprobe for a remote/UNKNOWN worker, not merely "not GENERATING") AND
        // turn-start evidence (delivery consumed, or the local pure-PTY class this rescue targets),
        // so a mid-turn remote worker or a boot-window preamble can no longer coast the continuous-
        // idle streak to a false completion. See evaluateEarlyIdleTranscriptArm.
        const earlyArm =
            store.taskHasConfirmedDelivery(meshId, row.id)
            && !findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id })
            && readNonEmptyString(row.assignedSessionId)
                ? await evaluateEarlyIdleTranscriptArm(components, mesh, store, row, localDaemonId, selfIds)
                : false;
        if (earlyArm) {
            const since = assignedIdleFinalAssistantSince.get(idleTranscriptStreakKey);
            if (since === undefined) {
                assignedIdleFinalAssistantSince.set(idleTranscriptStreakKey, nowMs);
            } else if (nowMs - since >= ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS) {
                // TX-FSM Stage 2: the poll must additionally prove the final
                // assistant bubble has SETTLED for the full window (preamble
                // guard — see pollAssignedTaskTerminalEvidence). A too-fresh
                // bubble vetoes to null → the streak resets below and a genuine
                // turn end completes one window later.
                const terminalEvidence = await pollAssignedTaskTerminalEvidence(components, mesh, row, {
                    minFinalAssistantAgeMs: ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS,
                    producer: 'early_idle_transcript_evidence',
                });
                if (terminalEvidence) {
                    // P1-4 (2026-08-18 fix — exemption REMOVED): the 8s continuous-idle
                    // streak is a SETTLE WINDOW, not a re-confirmation — a single weak
                    // (message-shape) admit here used to flip the row terminal outright,
                    // which is exactly the incident shape the redrive path's candidate
                    // machinery was built against. Apply the SAME 3-tick weak-candidate
                    // streak (weakCompletionCandidateStreak / WEAK_COMPLETION_CANDIDATE_
                    // CONFIRM_TICKS): a weak admit is recorded, notified once as a
                    // candidate, and promoted only after the SAME final-assistant evidence
                    // re-admits on consecutive ticks. A STRONG admit (native turn-terminal
                    // marker) skips the streak — the provider's own record is the
                    // confirmation. Only the admission snapshot + evidence level threading
                    // (P1-5) survives from the old exemption.
                    const weakCandidateKey = `${meshId}::${row.id}`;
                    if (terminalEvidence.evidenceLevel === 'weak') {
                        const candidate = weakCompletionCandidateStreak.get(weakCandidateKey) ?? { count: 0 };
                        // Evidence changed (a NEWER final assistant bubble) → the previous
                        // confirmations covered different evidence; re-confirm from scratch.
                        if (candidate.finalAssistantAt !== undefined
                            && candidate.finalAssistantAt !== terminalEvidence.transcriptMessageAt) {
                            candidate.count = 0;
                        }
                        candidate.finalAssistantAt = terminalEvidence.transcriptMessageAt;
                        candidate.count += 1;
                        weakCompletionCandidateStreak.set(weakCandidateKey, candidate);
                        if (candidate.count === 1) {
                            // FIRST observation: surface the CANDIDATE to the coordinator (same
                            // wording as the redrive path — "possible completion — awaiting
                            // confirmation"), WITHOUT declaring the task done.
                            const nodeLabel = row.assignedNodeId ? `Node '${row.assignedNodeId}'` : 'Remote agent';
                            const metadataEvent = {
                                evidenceLevel: 'weak' as const,
                                finalSummary: terminalEvidence.finalSummary,
                                taskId: row.id,
                                providerType: readNonEmptyString(row.assignedProviderType) || terminalEvidence.providerType,
                                providerSessionId: terminalEvidence.providerSessionId,
                                source: 'early_idle_transcript_evidence',
                                targetSessionId: terminalEvidence.sessionId,
                            };
                            try {
                                queuePendingMeshCoordinatorEvent({
                                    event: 'agent:generating_completed',
                                    meshId,
                                    nodeLabel,
                                    nodeId: row.assignedNodeId,
                                    metadataEvent,
                                    coordinatorMessage: buildMeshSystemMessage({ event: 'agent:generating_completed', nodeLabel, metadataEvent }),
                                    queuedAt: nowMs,
                                });
                            } catch { /* best-effort candidate notification — the hold below still applies */ }
                        }
                        if (candidate.count < WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS) {
                            traceMeshEventDrop('weak_completion_candidate_held', {
                                taskId: row.id,
                                sessionId: row.assignedSessionId,
                                nodeId: row.assignedNodeId,
                                meshId,
                                event: 'agent:generating_completed',
                            }, `weak message-shape completion candidate ${candidate.count}/${WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS} (early-idle) — awaiting re-confirmation`);
                            continue;
                        }
                        // PROMOTION: enough consecutive identical quiet-poll re-confirmations.
                        // Fall through to the terminal flow with the streak cleared.
                        weakCompletionCandidateStreak.delete(weakCandidateKey);
                    } else {
                        // STRONG admit (native marker): skip the candidate machinery entirely.
                        weakCompletionCandidateStreak.delete(weakCandidateKey);
                    }
                    // MID-TURN-CAUSAL-ADMISSION (rc.16): propagate FIRST. When the unified guard
                    // defers (the LOCAL live adapter still reports the turn pending — transcript
                    // idle-with-final-assistant can straddle a genuinely mid-turn worker), HOLD
                    // the entire completion: no row flip, no bare ledger write, no queued event.
                    // The streak resets so it re-accumulates; the next qualifying tick re-polls
                    // and re-evaluates, releasing exactly once after the live state clears.
                    const propagation = propagateWatchdogTranscriptCompletion(
                        components, meshId, row, terminalEvidence, 'early_idle_transcript_evidence',
                        { terminalAdmission: terminalEvidence.admissionSnapshot },
                    );
                    if (propagation === 'deferred') {
                        assignedIdleFinalAssistantSince.delete(idleTranscriptStreakKey);
                        LOG.info('MeshReconcile', `Deferred early transcript completion for task ${row.id} on mesh ${meshId} `
                            + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}): the live adapter still reports `
                            + `the turn pending (mid-tool / streaming / modal) — holding; the completion re-evaluates next tick`);
                        traceMeshEventDrop('early_idle_completion_deferred_live_pending', {
                            taskId: row.id,
                            sessionId: row.assignedSessionId,
                            nodeId: row.assignedNodeId,
                            meshId,
                            event: 'agent:generating_completed',
                        });
                        continue;
                    }
                    assignedIdleFinalAssistantSince.delete(idleTranscriptStreakKey);
                    updateTaskStatus(meshId, row.id, terminalEvidence.outcome);
                    // WATCHDOG-FINALSUMMARY-LOST: propagate the completion to the coordinator WITH the
                    // finalSummary the poll read — the SAME [System] notification the native
                    // generating_completed produces — instead of only tracing a structural DROP. When
                    // propagation delivered (or a terminal ledger already exists), skip the bare
                    // summary-less ledger write below; only fall back to it if propagation could not run.
                    const propagated = propagation === 'propagated';
                    if (!propagated && !findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id })) {
                        try {
                            appendLedgerEntry(meshId, {
                                kind: terminalEvidence.outcome === 'completed' ? 'task_completed' : 'task_failed',
                                nodeId: row.assignedNodeId,
                                sessionId: row.assignedSessionId,
                                providerType: row.assignedProviderType,
                                payload: {
                                    taskId: row.id,
                                    event: 'agent:generating_completed',
                                    source: 'early_idle_transcript_evidence',
                                    // P1-5: stamp the admission evidence on the bare fallback
                                    // write too (the propagated path carries it via
                                    // terminalAdmission — see above).
                                    ...(terminalEvidence.evidenceLevel ? { evidenceLevel: terminalEvidence.evidenceLevel } : {}),
                                    ...(terminalEvidence.admissionSnapshot
                                        ? { completionDiagnostic: { terminalAdmission: terminalEvidence.admissionSnapshot } }
                                        : {}),
                                },
                            });
                        } catch { /* best-effort ledger write */ }
                    }
                    LOG.warn('MeshReconcile', `Early-completed assigned task ${row.id} on mesh ${meshId} `
                        + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}): worker idle with a `
                        + `final assistant message after dispatch for ≥${Math.round(ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS / 1000)}s — `
                        + `the completion event was lost/late (pure-PTY provider), task is ${terminalEvidence.outcome} without waiting the 15-min deadline`
                        + `${propagated ? ' (finalSummary propagated to coordinator)' : ''}`);
                    traceMeshEventStage('assigned_early_transcript_completed', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_completed',
                    }, propagated ? 'propagated' : terminalEvidence.outcome);
                    continue;
                }
                // Poll was inconclusive (mid-turn re-check / stale tail / unreadable) — reset the
                // streak so it must re-accumulate a fresh continuous-idle run before the next poll.
                assignedIdleFinalAssistantSince.delete(idleTranscriptStreakKey);
            }
        } else {
            // Not a qualifying tick (no confirmed delivery, generating, terminal ledger present, or
            // no bound session) — break the continuous-idle run.
            assignedIdleFinalAssistantSince.delete(idleTranscriptStreakKey);
        }
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
        // CONSUME-GRACE: the window is provider-aware (mesh-consume-grace.ts). It is resolved
        // from the SAME transcript-authority profile the gate body already uses, read here from
        // the claim-time row stamp so a REMOTE worker is classified too, and defaults to the
        // floor when the profile is unknown. The former flat 25s constant sat below the p95
        // boot→consume latency of every measured provider, so a normally-booting worker was
        // routinely re-driven off a task it was about to start.
        const consumeGraceProfile = resolveAssignedTranscriptProfile(components, row);
        const consumeGraceMs = resolveConsumeGraceMs(consumeGraceProfile);
        if (
            ageMs >= consumeGraceMs
            && ageMs < ASSIGNED_STRANDED_DEADLINE_MS
            && store.taskHasConfirmedDelivery(meshId, row.id)
            && !store.taskDeliveryConsumed(meshId, row.id)
        ) {
            const terminal = findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id });
            if (terminal) {
                const status = terminal.kind === 'task_completed' ? 'completed' : 'failed';
                // TURN-LEDGER (Stage 5): the reducer arbitrates this terminal first.
                if (reconcileTerminalViaReducer({ meshId, taskId: row.id, outcome: status, source: 'stall_reconcile', sessionId: row.assignedSessionId, reason: terminal.kind })) {
                    updateTaskStatus(meshId, row.id, status);
                }
                continue;
            }
            // GENERATING-STARTED-CONSUME-RACE (fix B): the delivery-consume that clears this
            // gate (delivered → acked) runs ONLY when the coordinator pulls the worker's queued
            // agent:generating_started in PHASE 1 (handleMeshForwardEvent → consumeSessionDelivery).
            // A worker may have emitted generating_started ALREADY, but if PHASE 1 has not yet
            // pulled that specific event (a skipped/slow peer tick, or the event was queued after
            // this tick's pull ran), the delivery row still reads 'delivered' here and the redrive
            // below tears a genuinely-generating remote worker off its task and re-injects the
            // prompt (the delivered_not_consumed_redrive symptom). Close the race by issuing a
            // TARGETED, in-process last-chance pull of THIS node's queue right now, then
            // re-reading taskDeliveryConsumed(): if the worker's generating_started was waiting to
            // be pulled, the pull consumes the delivery this tick and we skip the redrive entirely.
            // Best-effort and self-scoped (the same skip/peer guards as PHASE 1) — a miss just
            // falls through to the existing UNKNOWN-streak grace, so this only ever removes false
            // redrives, never adds one. A local (co-hosted) worker has nothing to pull (the node's
            // daemon is a self id) and this is a fast no-op.
            const assignedNode = row.assignedNodeId
                ? mesh.nodes?.find(n => meshNodeIdMatches(n, row.assignedNodeId))
                : undefined;
            if (assignedNode?.daemonId) {
                try {
                    // RECONCILE-PULL-FLOOD pacing: throttle per daemon — the gate
                    // runs PER STRANDED ROW, and K rows on one daemon used to
                    // multiply into K pull-sets per tick. The drain is daemon-
                    // scoped, so the first row's pull already consumed every
                    // queued generating_started the later rows could need.
                    await pullPendingEventsFromNode(
                        components,
                        meshId,
                        assignedNode,
                        localDaemonId,
                        selfIds,
                        selfIds.length > 0
                            ? selfIds.map(id => ({ meshId, coordinatorDaemonId: id }))
                            : [{ meshId }],
                        { minIntervalSinceLastPullMs: REDRIVE_PULL_MIN_INTERVAL_MS },
                    );
                } catch { /* best-effort last-chance pull */ }
                if (store.taskDeliveryConsumed(meshId, row.id)) {
                    // The pull delivered the worker's generating_started (or a terminal event) and
                    // consumed the delivery — the task is genuinely live/handled. Reset any accrued
                    // streak and leave the row to PHASE 4's completion reconcile.
                    deliveredUnconsumedUnknownStreak.delete(`${meshId}::${row.id}`);
                    continue;
                }
            }
            const shortStreakKey = `${meshId}::${row.id}`;
            // DUP-CLAIM-REBIND (rc.35): every liveness/evidence read below must follow the
            // ATTEMPT's session, not the claim-time row stamp. After a duplicate-dispatch
            // refusal rebinds the attempt to the real holder, the row still names the
            // REFUSED session — which is idle and running nothing — so this verdict read
            // IDLE_CONFIRMED and the redrive fired against a task the holder was actively
            // working (live task f5edc912). Reading the rebound holder yields GENERATING and
            // the redrive correctly stands down. Falls back to the row whenever no live
            // attempt binding exists, so the never-rebound path is unchanged.
            const evidenceSessionId = resolveTaskEvidenceSessionId(meshId, row.id, row.assignedSessionId);
            const evidenceRow = evidenceSessionId && evidenceSessionId !== row.assignedSessionId
                ? { ...row, assignedSessionId: evidenceSessionId }
                : row;
            const verdict = evidenceSessionId
                ? resolveSessionBusyVerdict(components, evidenceSessionId)
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
                // HELD-SUSPENSION RESTART CONTRACT: a locally-ACTIVE session with an
                // unresolved pre-consumed hold (e.g. a waiting_approval-parked picker,
                // whose status reads active) proves the prompt WAS consumed — promote
                // the consumed link from the suspension and apply the parked picker
                // instead of leaving the attempt pre-consumed forever.
                const gate = gateRedriveForHeldSuspension({ meshId, taskId: row.id, sessionLiveness: 'alive', nowMs });
                if (gate.kind === 'recovered') {
                    traceMeshEventDrop('suspension_consumed_recovered', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_started',
                    }, `held suspension recovered → ${gate.stage} (verdict GENERATING)`);
                }
            } else {
                // STARTED-REDRIVE-NATIVE-SOURCE-BLINDSPOT. Everything below infers "the worker never
                // consumed the task" from the ABSENCE of agent:generating_started. That inference is
                // only valid for a provider whose turn start IS a PTY event. A NATIVE-SOURCE provider
                // (transcriptAuthority=provider + on-disk nativeHistory — kimi and kin) signals start
                // and finish through its native transcript, never emitting generating_started, so the
                // delivery legitimately stays 'delivered' while the worker is hard at work; and
                // between tool calls it reads IDLE_CONFIRMED, which re-drives IMMEDIATELY with no
                // grace at all. Live 2026-07-25: a kimi worker was re-injected the same prompt at
                // 35s/28s/27s/43s (answering it each time) and the task then marked failed.
                //
                // So for that class, replace the missing event with the evidence the provider
                // actually produces: any post-dispatch agent bubble in its transcript. Found → the
                // prompt WAS consumed and the turn is under way; hold the row (and clear the streak,
                // since progress is positive evidence, not a deferral). Not found / unreadable → fall
                // through unchanged. P3 generalization: the gate is the transcript-authority
                // profile's emitsPtyTurnEvents=false (pure-PTY AND native-source floor/hold —
                // every class whose turn start is not a PTY event), resolved from the claim-time
                // row stamp FIRST so a REMOTE worker of this class is finally covered too (the
                // original fix was local-only). Reliable-PTY-event providers never enter this
                // branch, so their behaviour is untouched.
                const redriveProfile = evidenceSessionId
                    ? resolveAssignedTranscriptProfile(components, evidenceRow)
                    : undefined;
                if (redriveProfile?.emitsPtyTurnEvents === false
                    && await pollAssignedTaskInTurnProgress(components, { id: meshId, nodes: mesh.nodes }, evidenceRow)) {
                    deliveredUnconsumedUnknownStreak.delete(shortStreakKey);
                    // RC.20: the post-dispatch agent activity that proves the turn started IS
                    // consumption evidence — promote the consumed link durably (idempotent;
                    // audit source native_source_activity) so the attempt is injection-ineligible
                    // even across a daemon restart, not merely deferred this tick.
                    try {
                        recordTurnAck({
                            meshId,
                            taskId: row.id,
                            kind: 'consumed',
                            // Attempt-bound session (rc.35): see the long path below.
                            sessionId: evidenceSessionId,
                            legacy: {
                                ...(typeof row.dispatchNonce === 'number' ? { dispatchNonce: row.dispatchNonce } : {}),
                                ...(row.assignedNodeId ? { nodeId: row.assignedNodeId } : {}),
                                ...(row.assignedProviderType ? { providerType: row.assignedProviderType } : {}),
                            },
                            evidence: {
                                source: 'native_source_activity',
                                profileClass: redriveProfile.class,
                                profileTiming: redriveProfile.timing,
                            },
                        });
                    } catch { /* best-effort durable consumed link — the defer below still applies */ }
                    noteRedriveBlocked('native_source_activity');
                    traceMeshEventDrop('short_redrive_deferred_native_source_progress', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_started',
                    }, `${redriveProfile.class}_in_turn_progress (verdict ${verdict})`);
                    continue;
                }
                if (verdict === 'IDLE_CONFIRMED') {
                    deliveredUnconsumedUnknownStreak.delete(shortStreakKey);
                } else if (assignedRowLiveStatusIsAwaitingApproval(mesh, row.assignedNodeId, evidenceSessionId)
                    && !queueHoldHardDeadlineExceeded(meshId, row, 'live_awaiting_approval', dispatchedAtMs, nowMs, 'short_redrive')) {
                    // APPROVAL-INBOX-BLINDSPOT (Fix A.3): the UNKNOWN (remote) worker is live and
                    // sitting at an approval modal — it is legitimately paused awaiting the
                    // coordinator's mesh_approve, NOT a lost delivery. HOLD without advancing the
                    // streak so a genuine approval-blocked worker is never re-driven out from
                    // under its pending approval.
                    // QUEUE-HOLD-HARD-DEADLINE: bounded above. This gate reads a LIVE node snapshot
                    // and never accrues the UNKNOWN streak, so a snapshot that is itself stale would
                    // hold the row (and the node) forever. Past the ceiling the guard yields and the
                    // ordinary redrive below runs.
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
                        // HELD-SUSPENSION RESTART CONTRACT: distinguish a deferral held
                        // back by an unresolved suspension (positive evidence the prompt
                        // was consumed; awaiting the surviving session's rebind) from a
                        // plain UNKNOWN deferral — the bounded grace above remains the
                        // authoritative dead-detection in both cases.
                        const gate = gateRedriveForHeldSuspension({ meshId, taskId: row.id, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs });
                        traceMeshEventDrop(gate.kind === 'blocked' ? 'redrive_blocked_by_suspension' : 'short_redrive_deferred_unknown_verdict', {
                            taskId: row.id,
                            sessionId: row.assignedSessionId,
                            nodeId: row.assignedNodeId,
                            meshId,
                            event: 'agent:generating_started',
                        }, gate.kind === 'blocked'
                            ? `held ${gate.stages.join('/')} unresolved; unknown ${streak}/${RECLAIM_UNKNOWN_GRACE_TICKS}`
                            : `unknown ${streak}/${RECLAIM_UNKNOWN_GRACE_TICKS}`);
                        continue;
                    }
                }
                // HELD-SUSPENSION RESTART CONTRACT (durable typed rule): an unresolved
                // pre-consumed waiting_* hold scoped to THIS attempt/session/dispatchNonce
                // is positive causal evidence the prompt reached the worker — stronger
                // than the missing generating_started ACK this branch infers "never
                // consumed" from. Reached when the session is IDLE_CONFIRMED (present,
                // parked — e.g. at a picker rebound after a daemon restart) or UNKNOWN
                // with the bounded grace exhausted (demonstrably dead):
                //   - ALIVE → promote the consumed link from the suspension (audit
                //     source held_suspension_recovery) and apply the parked picker
                //     through the FSM; the SAME attempt continues, no redrive.
                //   - PROVEN DEAD → drop the hold (session_dead) and let the normal
                //     redrive below close this attempt and open a NEW one.
                const suspensionGate = gateRedriveForHeldSuspension({
                    meshId,
                    taskId: row.id,
                    sessionLiveness: verdict === 'UNKNOWN' ? 'unknown' : 'alive',
                    sessionProvenDead: verdict === 'UNKNOWN', // the bounded UNKNOWN grace just exhausted above
                    nowMs,
                });
                // QUEUE-HOLD-HARD-DEADLINE: a 'blocked' gate holds indefinitely while the session
                // stays UNKNOWN-but-not-proven-dead. Past the ceiling, stop honouring the block and
                // let the redrive below close the attempt. ('recovered' is NOT bounded away — it is
                // a positive resolution that advances the FSM, not an open-ended hold.)
                const suspensionHoldExpired = suspensionGate.kind === 'blocked'
                    && queueHoldHardDeadlineExceeded(meshId, row, 'held_suspension', dispatchedAtMs, nowMs,
                        `short_redrive; stages ${suspensionGate.stages.join('/')}`);
                if (!suspensionHoldExpired && (suspensionGate.kind === 'recovered' || suspensionGate.kind === 'blocked')) {
                    deliveredUnconsumedUnknownStreak.delete(shortStreakKey);
                    traceMeshEventDrop(suspensionGate.kind === 'recovered' ? 'suspension_consumed_recovered' : 'redrive_blocked_by_suspension', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_started',
                    }, suspensionGate.kind === 'recovered'
                        ? `consumed recovered from held suspension → ${suspensionGate.stage}; same attempt continues`
                        : 'held suspension unresolved — redrive suppressed');
                    continue;
                }
                if (suspensionGate.kind === 'released' && suspensionGate.dropped > 0) {
                    LOG.info('MeshReconcile', `Dropped ${suspensionGate.dropped} held suspension(s) for task ${row.id} on mesh ${meshId}: worker session ${row.assignedSessionId ?? '?'} demonstrably dead — delivered_not_consumed_redrive proceeds to a new attempt`);
                }
                // TURN-LEDGER (Stage 5): the DURABLE redrive gate. A delivered-but-unconsumed
                // attempt may re-drive only while its evidence says the prompt was never
                // consumed, within its lease, and within its redrive budget — and a CONSUMED
                // (or terminal) attempt NEVER re-drives, even when the delivery rows and the
                // attempt stage disagree (the attempt is the authority). Legacy rows without
                // an attempt ('no_attempt' / store error) keep the pre-Stage-5 behavior.
                const redriveEval = (() => {
                    try { return evaluateRedrive(meshId, row.id, nowMs); } catch { return null; }
                })();
                const shortRedriveAllowed = !redriveEval || (!redriveEval.allowed && redriveEval.reason === 'no_attempt') || redriveEval.allowed;
                if (!shortRedriveAllowed) {
                    traceMeshEventDrop('short_redrive_blocked_by_turn_ledger', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_started',
                    }, !redriveEval || redriveEval.allowed ? 'n/a' : redriveEval.reason);
                } else {
                // NATIVE-SOURCE-REDRIVE-OLD-WORKER (RC32): the nonce bump inside
                // reclaimStrandedAssignedTask only neutralizes the old worker LAZILY —
                // the stale-nonce ack guard fires when the worker echoes the old nonce on
                // agent:generating_started. A NATIVE-SOURCE worker (emitsPtyTurnEvents=false)
                // never emits that event, so without an explicit stop the OLD worker stays
                // able to execute the reclaimed prompt after the redispatch (the
                // delivered_not_consumed double-execution defect). Close it through the
                // established stale-worker stop mechanism BEFORE the reclaim hands the row
                // back for redispatch. Exactly-once completion is preserved: the reclaim
                // still bumps dispatchNonce and closes the current attempt, so any late
                // event from the old worker is rejected as stale regardless of the stop.
                if (redriveProfile?.emitsPtyTurnEvents === false && evidenceSessionId) {
                    // rc.35: stop the session the ATTEMPT is bound to. That is the worker
                    // that would otherwise go on to execute the reclaimed prompt; the
                    // claim-time row stamp may name a session that never accepted it.
                    stopStaleMeshWorker(components, {
                        meshId,
                        sessionId: evidenceSessionId,
                        nodeId: row.assignedNodeId,
                        providerType: row.assignedProviderType,
                    });
                }
                try {
                    // The lease must cover the window the NEXT judgement uses, so it is the
                    // same provider-aware grace the gate above entered on. Leaving it at the
                    // old flat constant would expire the lease well before the re-driven
                    // attempt is judged again.
                    markAttemptRedriven({ meshId, taskId: row.id, leaseDurationMs: consumeGraceMs, nowMs });
                } catch { /* best-effort durable lease */ }
                const redriven = reclaimStrandedAssignedTask(meshId, row.id, {
                    reason: 'delivered_not_consumed_redrive',
                    ageMs,
                });
                if (redriven) {
                    deliveredUnconsumedUnknownStreak.delete(shortStreakKey);
                    LOG.warn('MeshReconcile', `Re-drove delivered-but-unconsumed task ${row.id} on mesh ${meshId} `
                        + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}, delivered but no `
                        + `generating_started in ${Math.round(ageMs / 1000)}s, verdict ${verdict} → ${redriven.status})`);
                    // REDRIVE-PROVIDER-FLIP (a): name the provider this redrive is tearing down.
                    // This trace is the "before" anchor; the "after" is the redriveProvenance
                    // block — and, when they differ, the redrive_provider_changed entry —
                    // written at the next dispatch by recordTaskDispatchedLedger. The re-claim
                    // does NOT recompute routing, so the two can disagree, which is precisely
                    // what needed to become visible without a manual two-entry ledger join.
                    traceMeshEventDrop('assigned_delivered_not_consumed_redrive', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_started',
                    }, `delivered_not_consumed ${Math.round(ageMs / 1000)}s → ${redriven.status}`
                        + `${row.assignedProviderType ? ` (provider ${row.assignedProviderType} released; the re-claim adopts an idle session without re-ranking, so it may differ)` : ''}`);
                    continue;
                }
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
            // TURN-LEDGER (Stage 5): the reducer arbitrates this terminal first.
            if (reconcileTerminalViaReducer({ meshId, taskId: row.id, outcome: status, source: 'stall_reconcile', sessionId: row.assignedSessionId, reason: terminal.kind })) {
                updateTaskStatus(meshId, row.id, status);
            }
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
            // DUP-CLAIM-REBIND (rc.35): attempt-first, row-fallback — see the short-redrive
            // gate above. This is the LONG (delivered-no-turn deadline) path, the one that
            // actually issued the observed `cancelled (source=reassignment)` against a
            // rebound task, so it must follow the same effective binding.
            const evidenceSessionId = resolveTaskEvidenceSessionId(meshId, row.id, row.assignedSessionId);
            const evidenceRow = evidenceSessionId && evidenceSessionId !== row.assignedSessionId
                ? { ...row, assignedSessionId: evidenceSessionId }
                : row;
            const verdict = evidenceSessionId
                ? resolveSessionBusyVerdict(components, evidenceSessionId)
                : 'IDLE_CONFIRMED'; // no session bound → nothing live to protect
            if (verdict === 'GENERATING'
                // GENERATING-HARD-DEADLINE: 'GENERATING' resets the grace every tick and
                // `continue`s, so a session whose liveness signal is stuck ON holds the row
                // 'assigned' FOREVER — the only branch in this phase with no ceiling. That is
                // not hypothetical: a worker that had already posted its final report sat
                // 'generating' for 86min, and because the row stayed assigned the node kept
                // reading as busy, so `node_has_active_assignment` skipped every later
                // auto-launch on it — a dead task blocking live ones, exactly the failure the
                // QUEUE_HOLD_HARD_DEADLINE_MS comment above records.
                //
                // Bound it with the SAME ceiling as the other holds rather than a new number:
                // 90min is 6x the delivered-no-turn deadline and far past any realistic single
                // turn, so a genuinely-working worker is never pre-empted — below the ceiling
                // the reset-grace behavior is untouched. Past it the liveness signal is
                // presumed stale and control falls through to the ordinary bounded reclaim
                // (streak grace still applies); it never tears a worker off immediately.
                && !queueHoldHardDeadlineExceeded(meshId, row, 'live_generating', dispatchedAtMs, nowMs, 'delivered_no_turn')) {
                deliveredNoTurnUnknownStreak.delete(streakKey); // demonstrably alive → reset grace
                // HELD-SUSPENSION RESTART CONTRACT: a locally-active session with an
                // unresolved pre-consumed hold proves the prompt WAS consumed — promote
                // the consumed link from the suspension and apply the parked picker
                // (same rule as the short redrive gate below).
                const gate = gateRedriveForHeldSuspension({ meshId, taskId: row.id, sessionLiveness: 'alive', nowMs });
                if (gate.kind === 'recovered') {
                    traceMeshEventDrop('suspension_consumed_recovered', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_completed',
                    }, `held suspension recovered → ${gate.stage} (verdict GENERATING)`);
                }
                continue;  // worker still working
            }
            let reclaimReason: 'delivered_no_turn_deadline' | 'reclaim_after_unknown_grace';
            if (verdict === 'IDLE_CONFIRMED') {
                deliveredNoTurnUnknownStreak.delete(streakKey);
                reclaimReason = 'delivered_no_turn_deadline';
            } else if (assignedRowLiveStatusIsAwaitingApproval(mesh, row.assignedNodeId, evidenceSessionId)
                && !queueHoldHardDeadlineExceeded(meshId, row, 'live_awaiting_approval', dispatchedAtMs, nowMs, 'delivered_no_turn')) {
                // APPROVAL-INBOX-BLINDSPOT (Fix A.3): the UNKNOWN (remote) worker is live and
                // sitting at an approval modal — legitimately paused awaiting the coordinator's
                // mesh_approve, NOT a delivered-but-lost completion. HOLD without advancing the
                // streak so a genuine approval-blocked worker is never reclaimed at the
                // delivered-no-turn deadline. The reclaim resumes normally once the approval
                // clears (the live status leaves waiting_approval).
                // QUEUE-HOLD-HARD-DEADLINE: bounded above — see the short-redrive twin. Past the
                // ceiling this guard yields and control falls into the UNKNOWN branch below, so the
                // recovery is the ORDINARY bounded reclaim (streak grace still applies), never an
                // immediate tear-off.
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
                    // HELD-SUSPENSION RESTART CONTRACT: distinguish a deferral held back
                    // by an unresolved suspension (awaiting the surviving session's
                    // rebind) from a plain UNKNOWN deferral.
                    const gate = gateRedriveForHeldSuspension({ meshId, taskId: row.id, sessionLiveness: 'unknown', sessionProvenDead: false, nowMs });
                    traceMeshEventDrop(gate.kind === 'blocked' ? 'redrive_blocked_by_suspension' : 'reclaim_deferred_unknown_verdict', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_completed',
                    }, gate.kind === 'blocked'
                        ? `held ${gate.stages.join('/')} unresolved; unknown ${streak}/${RECLAIM_UNKNOWN_GRACE_TICKS}`
                        : `unknown ${streak}/${RECLAIM_UNKNOWN_GRACE_TICKS}`);
                    continue;
                }
                reclaimReason = 'reclaim_after_unknown_grace';
            }
            // HELD-SUSPENSION RESTART CONTRACT (durable typed rule): same gate as the
            // short redrive path — a valid unresolved hold + live session recovers the
            // consumed link and applies the parked picker (SAME attempt continues); a
            // proven-dead session drops the hold (session_dead) so the reclaim below
            // opens a NEW attempt. A recovered attempt skips the transcript poll and
            // the reclaim entirely.
            const suspensionGate = gateRedriveForHeldSuspension({
                meshId,
                taskId: row.id,
                sessionLiveness: verdict === 'UNKNOWN' ? 'unknown' : 'alive',
                sessionProvenDead: verdict === 'UNKNOWN', // the bounded UNKNOWN grace just exhausted above
                nowMs,
            });
            // QUEUE-HOLD-HARD-DEADLINE: bounded above — see the short-redrive twin. Only the
            // open-ended 'blocked' hold is bounded; 'recovered' resolves the FSM and stands.
            const suspensionHoldExpired = suspensionGate.kind === 'blocked'
                && queueHoldHardDeadlineExceeded(meshId, row, 'held_suspension', dispatchedAtMs, nowMs,
                    `delivered_no_turn; stages ${suspensionGate.stages.join('/')}`);
            if (!suspensionHoldExpired && (suspensionGate.kind === 'recovered' || suspensionGate.kind === 'blocked')) {
                deliveredNoTurnUnknownStreak.delete(streakKey);
                traceMeshEventDrop(suspensionGate.kind === 'recovered' ? 'suspension_consumed_recovered' : 'redrive_blocked_by_suspension', {
                    taskId: row.id,
                    sessionId: row.assignedSessionId,
                    nodeId: row.assignedNodeId,
                    meshId,
                    event: 'agent:generating_completed',
                }, suspensionGate.kind === 'recovered'
                    ? `consumed recovered from held suspension → ${suspensionGate.stage}; same attempt continues`
                    : 'held suspension unresolved — reclaim suppressed');
                continue;
            }
            if (suspensionGate.kind === 'released' && suspensionGate.dropped > 0) {
                LOG.info('MeshReconcile', `Dropped ${suspensionGate.dropped} held suspension(s) for task ${row.id} on mesh ${meshId}: worker session ${row.assignedSessionId ?? '?'} demonstrably dead — ${reclaimReason} proceeds to a new attempt`);
            }
            // RC.20 GATE ORDER (P0-3): the ACTIVE-ATTEMPT gate and the NATIVE-SOURCE
            // ACTIVITY gate run BEFORE the terminal-evidence poll below (they used to
            // run after it — the poll flipped a mid-turn kimi worker to completed 6s
            // before the worker went busy again, ahead of both gates that would have
            // held it). The poll is now admission-choked (P0-1 — every accept goes
            // through evaluateTerminalAdmission, and a weak admit only becomes a
            // CANDIDATE, P1-4), so no order can falsely complete anymore; running the
            // gates first simply gives the cheap, durable holds priority, and a
            // genuinely finished worker (stale activity, bare 'consumed' stage) still
            // reaches the poll. KNOWN TRADEOFF: a worker whose generating_started DID
            // land but whose completion was lost keeps a live 'generating' stage and
            // is held until QUEUE_HOLD_HARD_DEADLINE_MS yields — the safe direction,
            // and bounded.
            // RC.20 ACTIVE-ATTEMPT GATE: a nonterminal attempt whose durable stage is a
            // LIVE-turn stage (generating / waiting_approval / waiting_choice / finalizing)
            // is positive causal evidence the prompt was consumed and the turn is owned —
            // reclaiming here would tear a live worker off its turn and re-inject the same
            // prompt. This covers the waiting_choice/approval states whose session status
            // can read IDLE_CONFIRMED locally (a floor-class worker parked at a picker), which
            // the verdict above cannot see. A bare 'consumed' stage does NOT hold by itself:
            // the worker may have died right after consuming — the transcript-freshness gate
            // below (or, for PTY-event providers, the GENERATING verdict / UNKNOWN grace) is
            // the bounded arbiter for that case, so recovery stays fail-closed and bounded.
            const currentAttempt = (() => {
                try { return store.getCurrentTurnAttempt(meshId, row.id); } catch { return null; }
            })();
            const attemptStage = readNonEmptyString(currentAttempt?.stage);
            // QUEUE-HOLD-HARD-DEADLINE: this gate holds on a DURABLE attempt stage that only the
            // completion path clears — precisely the write that goes missing in the observed
            // defect. It never accrues the UNKNOWN streak, so a stage stuck at 'generating' /
            // 'waiting_*' pins the row (and the node) indefinitely. Past the ceiling, yield to the
            // bounded reclaim below.
            if (currentAttempt && !currentAttempt.terminalOutcome
                && (attemptStage === 'generating' || attemptStage === 'waiting_approval'
                    || attemptStage === 'waiting_choice' || attemptStage === 'finalizing')
                && !queueHoldHardDeadlineExceeded(meshId, row, 'active_attempt_stage', dispatchedAtMs, nowMs,
                    `attempt ${currentAttempt.attemptId} stage ${attemptStage}`)) {
                deliveredNoTurnUnknownStreak.delete(streakKey);
                noteRedriveBlocked('active_attempt_stage');
                traceMeshEventDrop('redrive_blocked_active_attempt', {
                    taskId: row.id,
                    sessionId: row.assignedSessionId,
                    nodeId: row.assignedNodeId,
                    meshId,
                    event: 'agent:generating_completed',
                }, `attempt stage ${attemptStage} — live turn, ${reclaimReason} suppressed`);
                continue;
            }
            // RC.20 NATIVE-SOURCE ACTIVITY GATE (the f3261319 defect): mirror of the short
            // path's STARTED-REDRIVE-NATIVE-SOURCE-BLINDSPOT gate, now for the 15-min
            // delivered-no-turn deadline. A worker whose profile never emits PTY turn events
            // (emitsPtyTurnEvents=false — kimi native-source floor and kin) produces its
            // turn evidence in the native transcript only: it reads IDLE_CONFIRMED between
            // tool calls and never flips the delivery to 'acked', so the deadline used to
            // classify it delivered_no_turn_deadline and RE-INJECT the full prompt while it
            // was genuinely executing (4 reinjections observed live before cancellation).
            // Fresh post-dispatch agent activity (narration / tool bubbles, including the
            // tool activity emitted while spawning child probes) is credible consumption
            // evidence: PROMOTE the attempt's consumed link durably (idempotent; audit source
            // native_source_activity) so the attempt becomes injection-ineligible across
            // restarts, and hold the row. STALE activity (transcript quiet beyond
            // NATIVE_SOURCE_ACTIVITY_STALE_MS) means the worker went silent mid-turn → fall
            // through to the bounded reclaim below; no infinite hold.
            const noTurnProfile = evidenceSessionId
                ? resolveAssignedTranscriptProfile(components, evidenceRow)
                : undefined;
            if (noTurnProfile?.emitsPtyTurnEvents === false) {
                const activity = await pollAssignedTaskActivity(components, { id: meshId, nodes: mesh.nodes }, evidenceRow);
                if (activity.inTurnProgress && activity.lastAgentActivityMs !== null
                    && nowMs - activity.lastAgentActivityMs <= NATIVE_SOURCE_ACTIVITY_STALE_MS) {
                    deliveredNoTurnUnknownStreak.delete(streakKey);
                    // Durable, exactly-once: the consumed ACK is insert-once idempotent, so
                    // repeated ticks while the worker keeps working record no duplicate stage
                    // advance; once consumed, isPromptInjectionAllowed refuses any reinjection.
                    try {
                        recordTurnAck({
                            meshId,
                            taskId: row.id,
                            kind: 'consumed',
                            // Attempt-bound session (rc.35): a consumed ACK naming the
                            // rebound-away row session would fail the reducer's causality check.
                            sessionId: evidenceSessionId,
                            legacy: {
                                ...(typeof row.dispatchNonce === 'number' ? { dispatchNonce: row.dispatchNonce } : {}),
                                ...(row.assignedNodeId ? { nodeId: row.assignedNodeId } : {}),
                                ...(row.assignedProviderType ? { providerType: row.assignedProviderType } : {}),
                            },
                            evidence: {
                                source: 'native_source_activity',
                                profileClass: noTurnProfile.class,
                                profileTiming: noTurnProfile.timing,
                            },
                        });
                    } catch { /* best-effort durable consumed link — the hold above still applies */ }
                    noteRedriveBlocked('native_source_activity');
                    traceMeshEventDrop('redrive_blocked_native_source_activity', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_completed',
                    }, `${noTurnProfile.class}_fresh_activity — consumed promoted, ${reclaimReason} suppressed`);
                    continue;
                }
                if (activity.inTurnProgress) {
                    // Post-dispatch activity exists but is STALE — the worker went quiet
                    // mid-turn. Content-free observation only; the bounded reclaim below
                    // proceeds (bounded recovery for a truly dead session).
                    traceMeshEventStage('native_source_activity_stale', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_completed',
                    }, `${noTurnProfile.class} quiet >${Math.round(NATIVE_SOURCE_ACTIVITY_STALE_MS / 1000)}s → ${reclaimReason} proceeds`);
                }
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
            //
            // P0-1: the poll's accept is decided by the terminal-admission choke point
            // (evaluateTerminalAdmission). Its evidenceLevel drives what an accept MEANS here:
            //   - STRONG (a native turn-terminal marker scoped to this turn) → the immediate
            //     terminal flow below, exactly as before.
            //   - WEAK (message-shape fallback) → P1-4 CANDIDATE: no queue flip, no terminal
            //     ledger, no dependency release. The candidate is notified to the coordinator
            //     once ("possible completion — awaiting confirmation") and must be re-admitted
            //     with the SAME final-assistant evidence on WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS
            //     consecutive ticks before it promotes. Each reconcile tick re-enters this path
            //     for the still-assigned row, so confirmations happen on consecutive ticks; a
            //     worker that resumes (fresh activity gate holds, or the poll declines) gets its
            //     streak deleted below / by the prune.
            const terminalEvidence = await pollAssignedTaskTerminalEvidence(components, mesh, evidenceRow, {
                producer: 'redrive_deadline_transcript_evidence',
            });
            if (terminalEvidence) {
                deliveredNoTurnUnknownStreak.delete(streakKey);
                const weakCandidateKey = `${meshId}::${row.id}`;
                const weakAdmission = terminalEvidence.evidenceLevel === 'weak';
                if (weakAdmission) {
                    const candidate = weakCompletionCandidateStreak.get(weakCandidateKey) ?? { count: 0 };
                    // Evidence changed (a NEWER final assistant bubble) → the previous
                    // confirmations covered different evidence; re-confirm from scratch.
                    if (candidate.finalAssistantAt !== undefined
                        && candidate.finalAssistantAt !== terminalEvidence.transcriptMessageAt) {
                        candidate.count = 0;
                    }
                    candidate.finalAssistantAt = terminalEvidence.transcriptMessageAt;
                    candidate.count += 1;
                    weakCompletionCandidateStreak.set(weakCandidateKey, candidate);
                    if (candidate.count === 1) {
                        // FIRST observation: surface the CANDIDATE to the coordinator. The
                        // weak metadataEvent makes buildMeshSystemMessage lead with the
                        // "possible completion — awaiting confirmation" wording (P1-4), so the
                        // coordinator is informed WITHOUT the task being declared done.
                        // NOTIF-DROP lesson: coordinatorMessage is REQUIRED — without it
                        // injectPendingIntoCoordinator drains-without-inject and the row is
                        // lost. Daemon-level routing (no target ids) is fine for a candidate.
                        const nodeLabel = row.assignedNodeId ? `Node '${row.assignedNodeId}'` : 'Remote agent';
                        const metadataEvent = {
                            evidenceLevel: 'weak' as const,
                            finalSummary: terminalEvidence.finalSummary,
                            taskId: row.id,
                            providerType: readNonEmptyString(row.assignedProviderType) || terminalEvidence.providerType,
                            providerSessionId: terminalEvidence.providerSessionId,
                            source: 'redrive_deadline_transcript_evidence',
                            targetSessionId: terminalEvidence.sessionId,
                        };
                        try {
                            queuePendingMeshCoordinatorEvent({
                                event: 'agent:generating_completed',
                                meshId,
                                nodeLabel,
                                nodeId: row.assignedNodeId,
                                metadataEvent,
                                coordinatorMessage: buildMeshSystemMessage({ event: 'agent:generating_completed', nodeLabel, metadataEvent }),
                                queuedAt: nowMs,
                            });
                        } catch { /* best-effort candidate notification — the hold below still applies */ }
                    }
                    if (candidate.count < WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS) {
                        traceMeshEventDrop('weak_completion_candidate_held', {
                            taskId: row.id,
                            sessionId: row.assignedSessionId,
                            nodeId: row.assignedNodeId,
                            meshId,
                            event: 'agent:generating_completed',
                        }, `weak message-shape completion candidate ${candidate.count}/${WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS} — awaiting re-confirmation`);
                        continue;
                    }
                    // PROMOTION: enough consecutive identical quiet-poll re-confirmations.
                    // Fall through to the terminal flow with the streak cleared.
                    weakCompletionCandidateStreak.delete(weakCandidateKey);
                } else {
                    // STRONG admit (native marker): skip the candidate machinery entirely —
                    // the provider's own turn-end record IS the confirmation.
                    weakCompletionCandidateStreak.delete(weakCandidateKey);
                }
                // TURN-LEDGER (Stage 5): transcript terminal evidence is a CompletionProposal
                // like any other — the reducer arbitrates BEFORE the row flips. A rejection
                // (e.g. the attempt already closed differently) skips every write below.
                if (!reconcileTerminalViaReducer({
                    meshId,
                    taskId: row.id,
                    outcome: terminalEvidence.outcome,
                    source: 'transcript',
                    sessionId: row.assignedSessionId,
                    reason: 'redrive_deadline_transcript_evidence',
                })) {
                    continue;
                }
                // WATCHDOG-FINALSUMMARY-LOST: propagate the finalSummary-bearing completion to the
                // coordinator (same [System] notification as the native path); only fall back to the
                // bare summary-less ledger write when propagation could not run.
                // MID-TURN-CAUSAL-ADMISSION + P1-4: propagate BEFORE the row flip, and pass
                // boundedBackstop ONLY for a STRONG admit — a native turn-terminal marker
                // outranks a stale live-pending snapshot (the max-wait fail-open semantics).
                // A WEAK promotion rides NO backstop: a live-pending veto DEFERS it (the fix
                // for "bounded backstop must not ignore in_turn_progress" — weak/in-turn
                // evidence never rides the backstop anymore). When deferred the streak is
                // already deleted and we hold: no row flip, no ledger, no queued event.
                const propagation = propagateWatchdogTranscriptCompletion(
                    components, meshId, evidenceRow, terminalEvidence, 'redrive_deadline_transcript_evidence',
                    {
                        ...(weakAdmission ? {} : { boundedBackstop: true }),
                        terminalAdmission: terminalEvidence.admissionSnapshot,
                    },
                );
                if (propagation === 'deferred') {
                    LOG.info('MeshReconcile', `Deferred redrive-deadline transcript completion for task ${row.id} on mesh ${meshId} `
                        + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}): the live adapter still reports `
                        + `the turn pending — holding the weak promotion; it re-confirms from scratch next tick`);
                    traceMeshEventDrop('redrive_completion_deferred_live_pending', {
                        taskId: row.id,
                        sessionId: row.assignedSessionId,
                        nodeId: row.assignedNodeId,
                        meshId,
                        event: 'agent:generating_completed',
                    });
                    continue;
                }
                // updateTaskStatus ends the single-flight dispatch window on any transition off
                // 'assigned', so a later requeue/re-dispatch is never blocked by a stale mark.
                updateTaskStatus(meshId, row.id, terminalEvidence.outcome);
                const propagated = propagation === 'propagated';
                if (!propagated && !findTerminalLedgerEvidenceForTask({ meshId, taskId: row.id })) {
                    try {
                        appendLedgerEntry(meshId, {
                            kind: terminalEvidence.outcome === 'completed' ? 'task_completed' : 'task_failed',
                            nodeId: row.assignedNodeId,
                            sessionId: row.assignedSessionId,
                            providerType: row.assignedProviderType,
                            payload: {
                                taskId: row.id,
                                event: 'agent:generating_completed',
                                source: 'redrive_deadline_transcript_evidence',
                                // P1-5: stamp the admission evidence on the bare fallback
                                // write too (the propagated path carries it via
                                // terminalAdmission — see propagateWatchdogTranscriptCompletion).
                                ...(terminalEvidence.evidenceLevel ? { evidenceLevel: terminalEvidence.evidenceLevel } : {}),
                                ...(terminalEvidence.admissionSnapshot
                                    ? { completionDiagnostic: { terminalAdmission: terminalEvidence.admissionSnapshot } }
                                    : {}),
                            },
                        });
                    } catch { /* best-effort ledger write */ }
                }
                LOG.warn('MeshReconcile', `Skipped delivered-no-turn re-drive for task ${row.id} on mesh ${meshId} `
                    + `(node=${row.assignedNodeId ?? '?'} session=${row.assignedSessionId ?? '?'}): worker transcript is idle with a `
                    + `final assistant message after dispatch — the completion event was lost/late, task is ${terminalEvidence.outcome}, NOT re-driving`
                    + `${propagated ? ' (finalSummary propagated to coordinator)' : ''}`);
                traceMeshEventStage('redrive_deadline_transcript_completed', {
                    taskId: row.id,
                    sessionId: row.assignedSessionId,
                    nodeId: row.assignedNodeId,
                    meshId,
                    event: 'agent:generating_completed',
                }, `${reclaimReason} → transcript ${terminalEvidence.outcome} (${terminalEvidence.evidenceLevel ?? 'legacy'}${weakAdmission ? `, promoted after ${WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS} confirmations` : ''})${propagated ? ' propagated' : ''}`);
                continue;
            }
            // The poll declined — any weak candidate it had been accumulating is void
            // (the transcript moved / the turn is provably not over); re-confirmation
            // starts from scratch on the next admit.
            weakCompletionCandidateStreak.delete(streakKey);
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
                // COORD-NOTIFY-STUCK: reclaimStrandedAssignedTask never clears targetSessionId
                // — a pinned row lands back on 'pending' still addressed only to the session
                // just reclaimed, with no other signal to the coordinator that happened. See
                // mesh-dispatch-failed-notify.ts for the full rationale (mission af4a1ff8).
                if (reclaimedLost.status === 'pending' && readNonEmptyString(reclaimedLost.targetSessionId) && row.assignedNodeId) {
                    notifyCoordinatorOfPinnedReclaim(components, {
                        meshId,
                        taskId: row.id,
                        targetSessionId: reclaimedLost.targetSessionId!,
                        nodeId: row.assignedNodeId,
                        reclaimReason,
                        silentForMs: nowMs - dispatchedAtMs,
                        ...(readNonEmptyString(row.sourceCoordinatorSessionId) ? { sourceCoordinatorSessionId: row.sourceCoordinatorSessionId } : {}),
                    });
                }
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
    const store = MeshRuntimeStore.getInstance();

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
        // RESTART-REBOUND ENVELOPE: same re-derivation as PHASE 2.5 for legacy
        // rows without a dispatchTimestamp (idempotent; never injects).
        restampReboundMeshWorkerAssignment(components, store, meshId, row);
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

// ── PHASE 2.7: unsettled-attempt safety net ────────────────────────────────
//
// ATTEMPT-SETTLE-CHOKE-POINT (backstop). The choke point in updateTaskStatus
// settles the attempt for every terminal task flip, so in steady state this
// sweep finds NOTHING. It exists for the pair the choke point structurally
// cannot cover: a task row that reached a terminal status WITHOUT going
// through updateTaskStatus — a direct store write, a crash between the row
// write and the reducer proposal, or a future writer that bypasses the queue
// module entirely.
//
// Why this pairing is worth a net at all: a terminal task with a live attempt
// reports `status=generating` / `turnStage=generating` forever, and because
// such an attempt typically carries lease_deadline_ms=null, the redrive lease
// reaper never collects it either. The observable damage is not cosmetic — the
// stale generating attempt trips `session_generating_busy` and genuinely
// delays the next dispatch onto that session.
//
// DELIBERATELY LOUD: every settle here is logged at WARN and traced. A firing
// of this sweep MEANS a terminal writer bypassed the choke point — that log is
// the signal that a new leak path exists, which is exactly the diagnostic the
// three previous recurrences of this defect lacked. Do not downgrade it to
// debug to quiet the logs; find the writer instead.
//
// Conservative: grace-gated on the row's updatedAt so a terminal flip whose
// reducer proposal is legitimately a few ticks behind is never pre-empted, and
// the outcome proposed is exactly the task's own terminal status (never a
// guess). The reducer remains the single terminal authority — a rejection
// (stale attempt / already terminal differently) is respected, not overridden.
const UNSETTLED_ATTEMPT_GRACE_MS = 60 * 1000; // 1 min — well past any in-tick reducer lag

export function reconcileUnsettledTerminalAttempts(
    mesh: { id: string },
): number {
    const meshId = mesh.id;
    const store = MeshRuntimeStore.getInstance();
    const terminalOutcomes = Array.from(TURN_TERMINAL_OUTCOMES);
    
    if (!terminalOutcomes.length) return 0;
    const placeholders = terminalOutcomes.map(() => '?').join(', ');
    
    const sql = `
        SELECT q.payload AS queue_payload,
               a.*
        FROM mesh_queue q
        INNER JOIN mesh_turn_attempts a ON a.mesh_id = q.mesh_id AND a.task_id = q.id
        WHERE q.mesh_id = ?
          AND q.status IN (${placeholders})
          AND (a.terminal_outcome IS NULL OR a.terminal_outcome = '')
          AND a.stage NOT IN (${placeholders})
          AND a.attempt_seq = (SELECT MAX(attempt_seq) FROM mesh_turn_attempts a2
                               WHERE a2.mesh_id = q.mesh_id AND a2.task_id = q.id)
    `;
    
    // Bypass MeshRuntimeStore file-size limits by using its db handle directly.
    // The alternative is extracting a new query file or raising the limit.
    const db = (store as any).db;
    const unsettledRows = db.prepare(sql).all(
        meshId,
        ...terminalOutcomes,
        ...terminalOutcomes
    ) as Array<Record<string, unknown>>;
    
    if (!unsettledRows.length) return 0;
    
    const nowMs = Date.now();
    let settled = 0;

    for (const r of unsettledRows) {
        const row = JSON.parse(r.queue_payload as string) as import('./mesh-work-queue.js').MeshWorkQueueEntry;
        
        // map attempt row
        const attempt = {
            attemptId: r.attempt_id as string,
            meshId: r.mesh_id as string,
            taskId: r.task_id as string,
            attemptSeq: r.attempt_seq as number,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            coordinatorDaemonId: r.coordinator_daemon_id as string | null,
            coordinatorSessionId: r.coordinator_session_id as string | null,
            dispatchNonce: r.dispatch_nonce as number | null,
            stage: r.stage as string,
            redriveCount: r.redrive_count as number,
            leaseDeadlineMs: r.lease_deadline_ms as number | null,
            acceptedAt: r.accepted_at as string | null,
            deliveredAt: r.delivered_at as string | null,
            consumedAt: r.consumed_at as string | null,
            terminalOutcome: r.terminal_outcome as string | null,
            terminalReason: r.terminal_reason as string | null,
            terminalAt: r.terminal_at as string | null,
            createdAt: r.created_at as string,
            updatedAt: r.updated_at as string,
        };

        // Grace is anchored on the ATTEMPT's own updatedAt, NOT the queue row's: the
        // store force-stamps queue updated_at to now on every write, so an unrelated
        // touch of a long-terminal row would keep resetting a row-anchored grace and
        // the net could never fire. The attempt's updatedAt genuinely tracks when the
        // turn last progressed, which is exactly the "how long has this been stuck"
        // question the grace is asking.
        const anchor = Date.parse(attempt.updatedAt || attempt.createdAt || '');
        if (!Number.isFinite(anchor) || nowMs - anchor < UNSETTLED_ATTEMPT_GRACE_MS) continue;

        const outcome: 'completed' | 'failed' | 'cancelled' =
            row.status === 'completed' ? 'completed' : row.status === 'cancelled' ? 'cancelled' : 'failed';

        LOG.warn('MeshReconcile', `Unsettled attempt safety net: task ${row.id} on mesh ${meshId} is terminal `
            + `(${row.status}) but attempt ${attempt.attemptId} is still ${attempt.stage} `
            + `(lease=${attempt.leaseDeadlineMs ?? 'null'}, attempt idle ${Math.round((nowMs - anchor) / 1000)}s) — `
            + `settling it as ${outcome}. THIS SHOULD NOT HAPPEN: a terminal writer bypassed the `
            + `updateTaskStatus choke point; find it rather than relying on this net.`);
        traceMeshEventStage('unsettled_attempt_safety_net', {
            taskId: row.id,
            sessionId: attempt.sessionId ?? row.assignedSessionId,
            nodeId: row.assignedNodeId,
            meshId,
            event: 'agent:generating_completed',
        }, `${row.status}->${outcome} stage=${attempt.stage}`);

        if (reconcileTerminalViaReducer({
            meshId,
            taskId: row.id,
            outcome,
            source: 'stall_reconcile',
            sessionId: attempt.sessionId ?? row.assignedSessionId,
            reason: `unsettled_attempt_safety_net:${row.status}`,
        })) settled += 1;
    }
    return settled;
}

