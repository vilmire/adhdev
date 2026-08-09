/**
 * CliProviderInstance — Runtime instance for CLI Provider
 *
 * Lifecycle layer on top of ProviderCliAdapter.
 * collectCliData() + status transition logic from daemon-status.ts moved here.
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { normalizeInputEnvelope, type ProviderModule, flattenContent, type InputEnvelope } from './contracts.js';
import { assertProviderSupportsDeclaredInput, getEffectiveMessageInputSupport } from './provider-input-support.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext, ProviderErrorReason, HotChatSessionState, SessionModalState } from './provider-instance.js';
import { normalizeInteractivePrompt, normalizeInteractivePromptResponse, resolveInteractivePromptResponse, type InteractivePrompt } from './types/interactive-prompt.js';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import { shortHash } from '../system/hash.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import type { MeshSendKeyItem, MeshSendKeyName } from '../cli-adapters/provider-cli-shared.js';
import { resolveTranscriptAuthorityProfile } from './transcript-evidence.js';
import { TranscriptSignalSource } from './transcript-signal-source.js';
import { resolveBusyLeaseGate } from './busy-lease-gate.js';
import type { SignalSnapshot } from './spec/signal-envelope.js';
import { createCliAdapter } from './spec/route.js';
import type { PtyRuntimeMetadata, PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter, isNativeSourceCanonicalHistory, materializeProviderNativeHistory, readChatHistory, readProviderChatHistory } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { shouldCollectTraceCategory } from '../logging/debug-config.js';
import { traceMeshEventStage, traceMeshEventDrop } from '../mesh/mesh-event-trace.js';
import { isWeakCompletionEvidence } from '../mesh/mesh-events-utils.js';
import { resolveSessionTurnPresentation } from '../mesh/mesh-turn-presentation.js';
import { isTerminalTurnStage } from '../mesh/mesh-turn-ledger.js';
import type { ChatMessage } from '../types.js';
import { buildPersistedProviderEffectMessage, normalizeProviderEffects } from './control-effects.js';
import { formatAutoApprovalMessage, pickApprovalButton, hasNegativeApprovalOption, hasReliableApprovalAffirmative, looksLikeActiveApprovalPromptText, normalizeApprovalLabel } from './approval-utils.js';
import { getCliScriptCommand, parseCliScriptResult } from './cli-script-results.js';
import { mergeProviderPatchState, resolveProviderStateSurface } from './provider-patch-state.js';
import { normalizeProviderSessionId } from './provider-session-id.js';
import {
    antigravityOwnerToken,
    claimAntigravityConversation,
    releaseAntigravityOwner,
} from './native-history/antigravity-claim-registry.js';
import {
    releaseTranscriptOwner,
    transcriptClaimOwnerToken,
} from './native-history/transcript-claim-registry.js';
import { buildChatMessage, buildRuntimeSystemChatMessage, isUserFacingChatMessage, normalizeChatMessages, resolveChatMessageKind, extractFinalSummaryFromMessages, readChatMessageTimestampMs } from './chat-message-normalization.js';
import { workingDirBasename } from './working-dir.js';
import { ManualAttendanceTracker } from './manual-attendance.js';
import { buildCliStructuredInputPrompt } from './cli-provider-input-prompt.js';
import { type PersistableCliHistoryMessage, buildIncrementalHistoryAppendMessages } from './cli-provider-history-dedup.js';
import {
    isIdleStatus,
    getMessageTime,
    hasNonEmptyCliModalButtons,
    isCliGeneratingLikeStatus,
    computeTurnAnchoredDurationMs,
    getDatabaseSync,
    getForcedNewSessionScriptName,
    waitForCliAdapterReady,
} from './cli-provider-status-helpers.js';
import {
    STATUS_HYDRATION_TAIL_LIMIT,
    COMPLETED_FINALIZATION_RETRY_MS,
    COMPLETED_FINALIZATION_MAX_WAIT_MS,
    CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS,
    MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
    NATIVE_HISTORY_MESH_IDLE_SETTLE_MS,
    PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS,
    ANTIGRAVITY_HOLD_QUIET_DWELL_MS,
    ANTIGRAVITY_HOLD_HARD_CAP_MS,
    BACKGROUND_TASK_HOLD_MAX_MS,
    USER_INPUT_ACK_DEDUP_WINDOW_MS,
    STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS,
    TERMINAL_MESH_EVENTS,
} from './cli-provider-instance-types.js';
import { decideCompletionPreflight, decideCompletionVerdict, evaluateFinalizationBlock, type CompletionArmPatch, type CompletionFlushDecision, type CompletionPolicy, type CompletionSignalReader, type EvidenceSource } from './completion/completion-engine.js';
import { closeSqliteProbeCache, createSqliteProbeCache, probeDirectoriesFor, querySqliteSessionId, sqlPlaceholderList } from './completion/transcript-probe.js';
import { resetMeshStallEpisode, runMeshStallTick, type MeshStallHost } from './completion/mesh-stall-watchdog.js';
import * as approvalGate from './completion/approval-gate.js';
import type { ApprovalGateHost } from './completion/approval-gate.js';
import * as evidence from './completion/evidence.js';
import type { EvidenceHost } from './completion/evidence.js';
import * as stallRescue from './completion/stall-rescue.js';
import type { StallRescueHost } from './completion/stall-rescue.js';
import type {
    CompletedDebouncePending,
    CompletedFinalizationBlock,
    CompletionFinalAssistantEvidence,
    ExternalTranscriptProbe,
} from './cli-provider-instance-types.js';
import { mergeConversationMessages } from './cli-provider-transcript-merge.js';
import { getEffectDedupKey, formatApprovalRequestMessage, formatMarkerTimestamp } from './cli-provider-effect-format.js';
import { resolveProviderAutoApproveMode, type ResolvedAutoApproveMode } from './auto-approve-modes.js';

// Re-export moved public symbols so existing importers (index.ts, tests) keep
// their `./cli-provider-instance.js` path. Pure move — no behavior change.
export { buildCliStructuredInputPrompt } from './cli-provider-input-prompt.js';
export { buildIncrementalHistoryAppendMessages } from './cli-provider-history-dedup.js';
export {
    computeTurnAnchoredDurationMs,
    getForcedNewSessionScriptName,
    waitForCliAdapterReady,
} from './cli-provider-status-helpers.js';


export class CliProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'cli' as const;

    /**
     * Quiet period an approval modal's signature must be stable before
     * auto-approve sends the approve key. Guards against firing on a prompt
     * that is still streaming into the PTY (the "resolves too fast" symptom):
     * while the modal text/buttons are still changing, every frame yields a
     * new signature and the settle clock restarts. Once the prompt finishes
     * rendering the signature holds and the key is sent after this window.
     * Bounded + small so genuine approvals stay timely. The FSM is already
     * authoritative over the `waiting_approval` state; this only delays the
     * keystroke until the modal *content* has settled.
     */
    private static readonly AUTO_APPROVE_SETTLE_MS = approvalGate.APPROVAL_SETTLE_MS;

    /**
     * APPROVAL-INBOX-BLINDSPOT (Fix A): how long after a LOCAL auto-approve fire the mesh
     * event forwarder still treats the modal as "being resolved locally" and suppresses the
     * coordinator notification. Chosen to comfortably cover the resolveModal → PTY absorb →
     * status-leaves-approval round trip (incl. the win32 CR-resend loop) while staying short
     * enough that a modal which auto-approve fired at but did NOT resolve re-surfaces to the
     * coordinator on the next event. Aligned with the adapter's own approval cooldown scale.
     */
    private static readonly APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS = 8000;

    /**
     * Busy-side hysteresis for the settle gate. A momentary `generating` flip
     * while the SAME approval modal's button block is still on screen (its
     * question line scrolled out of the captured frame, only the buttons + a
     * residual `esc to interrupt` spinner remain) briefly reports
     * status!=waiting_approval. Without hysteresis that flip wipes the settle
     * clock, and the modal→generating→modal flap restarts the 600ms window
     * every time so auto-approve never fires. We keep the in-progress settle
     * gate warm across an inactive blip up to this bound; only once the modal
     * has genuinely stayed gone this long (a real resolution → idle) is the
     * gate cleared. Bounded so a genuinely new, later approval still re-settles
     * from scratch rather than firing on a stale timestamp.
     */
    private static readonly AUTO_APPROVE_GATE_HYSTERESIS_MS = approvalGate.APPROVAL_GATE_HYSTERESIS_MS;

    /**
     * AUTOAPPROVE-FLAP-RECUR (Fix B): extended busy-side continuity window for a
     * DELEGATED-WORKER auto-approve episode that is genuinely still cycling.
     *
     * The default AUTO_APPROVE_GATE_HYSTERESIS_MS (1500) absorbs a *momentary*
     * `generating` blip. But a delegated worker running a Bash approval observed
     * the FSM cycle the FULL state waiting_approval → busy → waiting_approval on a
     * 2–5s period (the button set scrolls in/out AND the modal question repaints,
     * so the adapter genuinely reports status=generating for whole seconds between
     * approval frames). Each busy phase outran the 1500ms hysteresis, so the
     * settle clock was WIPED (the genuine-resolution branch), the 600ms settle
     * window never accumulated across the flap, resolveModal never fired
     * (resolveModal count 0), and the mask-stall clock instead tripped at 4500ms →
     * coordinator nudge → the flap the coordinator observed.
     *
     * A genuine resolution and a flap both start with a busy phase; they diverge
     * only in whether waiting_approval RETURNS. So we cannot simply lengthen the
     * blanket hysteresis (that would make every real resolution hold the gate
     * open for seconds). Instead this longer window applies ONLY while an active
     * mask episode is alive (autoApproveMaskSince > 0) AND the session is a
     * delegated worker — i.e. exactly the never-resolving-flap case. A foreground
     * / attended session keeps the tight 1500ms window unchanged. The mask-stall
     * bound below still caps the episode, so a worker whose approval truly never
     * returns is surfaced to the coordinator within AUTO_APPROVE_MASK_STALL_MS
     * rather than held forever.
     *
     * INVARIANT (do not regress the ordering): this window must fully BRIDGE a
     * single busy phase, and the mask-stall bound below must in turn exceed it —
     * AUTO_APPROVE_MASK_STALL_MS > AUTO_APPROVE_FLAP_CONTINUITY_MS + max_busy_phase
     * + AUTO_APPROVE_SETTLE_MS. Observed flap geometry (delegated-worker Bash
     * approval): approval frames last ~1.5s, busy phases (modal=none) last
     * ~4.3–4.5s. With the old 4000ms this window was SHORTER than a busy phase, so
     * the settle clock was torn down every cycle and never accrued 600ms while the
     * 4500ms mask-stall tripped INSIDE the first busy phase → a stalled-approval
     * nudge leaked to the coordinator. 6000ms bridges the ~4.5s busy phase with
     * margin so the returning approval frame survives to resume its settle clock.
     */
    private static readonly AUTO_APPROVE_FLAP_CONTINUITY_MS = approvalGate.APPROVAL_FLAP_CONTINUITY_MS;

    /**
     * STATUS-MISMATCH: upper bound on how long the auto-approve→`generating` SURFACE
     * mask may hide a worker's `waiting_approval` (status + activeModal) before we give
     * up and surface the real prompt. The mask exists because auto-approve is expected
     * to resolve the modal momentarily; but if it STALLS without ever calling
     * resolveModal — the modal signature never settles for AUTO_APPROVE_SETTLE_MS (a
     * perpetually-flapping/streaming prompt), no concrete modal is ever captured, or the
     * modal is a picker/non-affirmative we never auto-pick — the mask would persist
     * forever and read_chat / mesh_status / the dashboard would NEVER see the pending
     * approval (the coordinator cannot mesh_approve what it cannot see). Once an episode
     * exceeds this bound we stop masking. Generously larger than
     * AUTO_APPROVE_SETTLE_MS (600) + AUTO_APPROVE_GATE_HYSTERESIS_MS (1500) so a
     * legitimately slow-settling / blip-flapping prompt is never unmasked early; a
     * genuine never-resolving stall surfaces within this window. The settle gate keeps
     * running underneath, so a prompt that finally stabilises still auto-approves, and
     * mesh_approve (raw FSM, unmasked) works throughout.
     *
     * INVARIANT (do not regress): must be STRICTLY GREATER than
     * AUTO_APPROVE_FLAP_CONTINUITY_MS + max_busy_phase + AUTO_APPROVE_SETTLE_MS so
     * that during a flap the settle clock (which FLAP_CONTINUITY keeps alive across
     * each busy phase) gets to accrue its 600ms on the RETURNING approval frame
     * before this stall bound can trip. Observed geometry — worker: approval ~1.5s,
     * busy ~4.3–4.5s; coordinator self-session: approval ~1.5s, busy ~2.85s. Both
     * now use the extended window (isAutonomousMeshSession covers worker +
     * meshCoordinatorFor). Worst case: CONTINUITY(6000) + busy(~4.5s) + SETTLE(600)
     * = ~11100ms, so the stall bound must exceed that. 10500ms satisfies the invariant
     * for coordinator (6000 + 2850 + 600 = 9450 < 10500) and was previously 9000ms
     * (which failed for a worker busy phase of 4.5s: 6000+4500+600=11100 > 9000).
     * the old 4500ms tripped inside the very first busy phase (while modal=none, so
     * the nudge was NOT deferred) and leaked to the coordinator.
     */
    private static readonly AUTO_APPROVE_MASK_STALL_MS = approvalGate.APPROVAL_AUTO_MASK_STALL_MS;

    /**
     * AUTOAPPROVE-FLAP-INBOX-MISSING: sticky-approval overlay window. Same time-tick
     * hold idea as the FALSE-IDLE completion gate — an approval signal that was
     * DOMINANT within this recent window is re-presented across a momentary busy blip
     * instead of collapsing.
     *
     * RCA (live 2026-07-13): a claude-cli worker sitting at a Bash approval modal
     * ("Do you want to proceed? ❯1.Yes") flaps waiting_approval↔busy on a ~2-3s period.
     * The spec `approval→busy` transition fires whenever the footer/modal approval
     * markers momentarily drop out of their parsed sections while the PRIOR command's
     * residual spinner text ("✳ Checking vendor drift…") still matches the busy regex.
     * On the busy frame the adapter reports status='generating', activeModal=null. That
     * corrupts THREE consumers at once: (1) mesh_active_work samples 'generating' →
     * collectPendingApprovals never sees 'awaiting_approval' → mesh_list_pending_approvals
     * count:0 (inbox miss); (2) the auto-approve settle gate is torn down each busy phase
     * so the 600ms settle never accrues → auto-approve never fires; (3) a mesh_approve
     * landing on a busy frame hits "Not in approval state". The existing FLAP machinery
     * (AUTO_APPROVE_FLAP_CONTINUITY_MS) only keeps the settle gate warm while status is
     * STILL waiting_approval (buttons scrolled out) — it does nothing once the FSM fully
     * commits to 'busy', and it never stabilises the status the inbox samples.
     *
     * Fix: when the raw adapter status flaps to generating/busy/idle but a
     * waiting_approval WITH a concrete modal was observed within this window, overlay
     * the cached modal and report status='waiting_approval'. This stabilized status
     * feeds getState (→ inbox), detectStatusTransition (→ event emission), and
     * maybeAutoApproveStatus (→ settle gate) uniformly, so the approval both registers
     * in the inbox and settles for auto-approve across the flap. Bounded (a genuine
     * resume that never returns to approval unmasks after this window) and scoped at the
     * call site to autonomous mesh sessions. 4000ms bridges the observed ~2-3s flap with
     * margin while staying well under AUTO_APPROVE_MASK_STALL_MS (a truly stalled/absent
     * approval still surfaces).
     */
    private static readonly APPROVAL_STICKY_FLAP_MS = approvalGate.APPROVAL_STICKY_FLAP_MS;

    /**
     * FALSE-IDLE (inter-approval quiet valley): grace window after an auto-approve
     * (or mesh_approve) RESOLVES a modal during which a subsequent generating→idle
     * quiet valley must NOT be treated as turn completion.
     *
     * The RCA: auto-approve resolves a modal → the agent resumes the same turn →
     * between resolving that approval and preparing the next tool/approval the agent
     * falls briefly silent. The FSM sees idle + a recorded mid-turn assistant bubble
     * and fires an early agent:generating_completed even though the turn is still in
     * flight. Live evidence showed the same session resuming waiting_approval ~13s
     * after a "clean" completion emit.
     *
     * The window must be comfortably larger than the observed resume gap (~13s) so
     * the valley is bridged, but not so large that a turn that genuinely ended right
     * after an approval is held for an annoying stretch. 18s clears 13s with margin
     * while capping the worst-case extra hold on a truly-finished turn at 18s (still
     * well under COMPLETED_FINALIZATION_MAX_WAIT_MS's 30s hard bound). The recency is
     * measured from the engine's lastApprovalResolvedAt, which is stamped ONLY by
     * resolveModal (auto-approve fire / dashboard / mesh_approve) — so a plain turn
     * with no approval never carries recency and is never held (no regression).
     */
    private static readonly APPROVAL_RESUME_GRACE_MS = 18_000;

    // MESH-STALL-WATCH (feature 1: STALL detection): how long a coordinator-spawned
    // mesh worker's raw PTY output (lastOutputAt) may stay unchanged before the
    // status-agnostic stall watchdog fires ONE informational monitor:no_progress
    // event. Unlike the StatusMonitor no-progress watchdog (which only runs while a
    // turn is generating), this observes pure screen stasis regardless of the
    // reported status — a worker parked idle, wedged mid-turn, or spawned with no
    // output at all.
    //
    // FALSE-STALL-WATCHDOG-OVERFIRE (fix C): the threshold is now turn-scoped. When
    // an explicit turn is in flight (hasAdapterPendingResponse() — the adapter's
    // currentTurnScope / isWaitingForResponse / isProcessing / partial buffer), a
    // long silent thinking gap (claude-cli opus/high can go minutes between visible
    // tokens) is normal, so the bar is raised to MESH_WORKER_STALL_TURN_THRESHOLD_MS.
    // Outside a turn (idle) the tighter MESH_WORKER_STALL_IDLE_THRESHOLD_MS applies.
    // This is a THRESHOLD RAISE, not a suppression: a genuine mid-turn wedge still
    // fires (late, at the turn bound) rather than being hidden behind a sticky
    // generating status. 180s matches DEFAULT_MONITOR_CONFIG.noProgressThresholdSec
    // so the idle bound agrees with the StatusMonitor watchdog's "long interval".
    private static readonly MESH_WORKER_STALL_IDLE_THRESHOLD_MS = 180_000;
    private static readonly MESH_WORKER_STALL_TURN_THRESHOLD_MS = 360_000;
    // FALSE-STALL-WATCHDOG-OVERFIRE (fix E): minimum spacing between two stall
    // notifications for the SAME session, even across anchor re-arms. The
    // per-anchor meshStallEmittedForAnchor guard already stops a single continuous
    // stall from re-firing; this cooldown additionally throttles the churn where a
    // worker dribbles one byte every few minutes (each re-arming the anchor and then
    // re-crossing the bar), which would otherwise page the coordinator repeatedly.
    // The stall is still fired for observability — just not more than once per
    // window per session. Set larger than the stall thresholds so consecutive
    // re-armed stalls a few minutes apart collapse into a single notification.
    private static readonly MESH_WORKER_STALL_REFIRE_COOLDOWN_MS = 600_000;

    private adapter: ProviderCliAdapter;
    private context: InstanceContext | null = null;
    private events: ProviderEvent[] = [];
    private lastStatus: string = 'starting';
    // Idempotency guard for the queue-claim agent:ready event. agent:ready is the
    // sole signal the mesh coordinator's tryAssignQueueTask waits on to hand a
    // queued task to this worker. It is emitted in two places: the boot-time
    // starting→idle one-shot, and the readySeen re-arm below. This flag makes the
    // event fire AT MOST ONCE per session so a worker is never claimed twice and a
    // queued task is never double-dispatched/double-injected. Whichever path fires
    // first sets it; the other becomes a no-op.
    private agentReadyEmitted = false;
    private generatingStartedAt: number = 0;
    // MESH-STALL-WATCH (feature 1): the lastOutputAt value the stall episode is
    // currently armed against. A stall episode is "the raw PTY output has not
    // advanced past this anchor". When the adapter has never emitted output
    // (lastOutputAt === 0) the anchor is the spawn time (this.startedAt) so a
    // worker that produced NOTHING is still caught. On any new output the anchor
    // re-arms to the fresh lastOutputAt and meshStallEmittedForAnchor resets, so a
    // single continuous stall fires AT MOST ONCE and a later stall re-arms cleanly.
    // -1 = not yet initialised for this session.
    private meshStallAnchorAt = -1;
    private meshStallEmittedForAnchor = false;
    // FALSE-STALL-WATCHDOG-OVERFIRE (fix B): the turn-active state observed on the
    // PREVIOUS stall tick. When a turn ends (active → inactive: the completion/idle
    // transition), the anchor is force re-armed to `now` so the completed→idle valley
    // does not fire against the pre-completion output clock. The turn-end edge is the
    // signal; updateStatus's own idle transition does not touch the stall anchor, so
    // this watchdog-local edge detector owns the re-arm. undefined = no prior tick.
    private meshStallTurnActiveLast: boolean | undefined = undefined;
    // FALSE-STALL-WATCHDOG-OVERFIRE (fix E): wall-clock of the most recent stall
    // emission for this session, or -1 if none. Enforces
    // MESH_WORKER_STALL_REFIRE_COOLDOWN_MS between successive emissions across
    // anchor re-arms (the per-anchor guard only covers a single continuous stall).
    private meshStallLastFiredAt = -1;
    // KIMI-MESH-COMPLETION-EMIT (axis 1) — TX-FSM Stage 1: whether the stall
    // watchdog has consumed a usable native-transcript SIGNAL SNAPSHOT for the
    // current stall episode. A pure-PTY native-source worker running a long,
    // screen-quiet tool (no viewport bytes for minutes) looks stalled by the
    // lastOutputAt clock even though its transcript file is still growing.
    // Before firing the stall, the watchdog consults the shared
    // TranscriptSignalSource's in_turn_progress signal; if the transcript is
    // advancing, the "stall" is a false positive of PTY-render stasis, so we
    // re-arm the anchor instead of paging the coordinator (whose no_progress
    // handling can lead to the worker being stopped mid-work → completion
    // never emitted). The FIRST usable sample of an episode still re-arms
    // unconditionally (no episode-scoped baseline exists yet to prove stasis
    // against) — the historical `!prev → advanced` semantics, preserved.
    private meshStallTranscriptSignalSampled = false;
    // FALSE-IDLE continuity epoch: monotonically bumped on EVERY entry into a busy
    // phase (→generating or →waiting_approval). The completedDebouncePending snapshots
    // this value at arm time (busyEpochAtArm); the flush guard requires it UNCHANGED
    // — proving the session did not re-enter a busy phase (a momentary busy→idle blip
    // in an inter-approval valley) between arming the debounce and flushing it. A
    // single point-sample of status at flush time cannot see a generating phase that
    // opened AND closed within the settle window; the epoch can. See
    // flushCompletedDebounceIfFinalized.
    private busyEpoch: number = 0;
    // GENERATING-BOUNDARY (R4b): the per-turn taskId for which a startup-grace
    // started+completed pair was already synthesized. Both fast-collapse callers
    // (starting→idle transition AND the idle-stayed no-status-change poll) route
    // through maybeSynthesizeStartupGraceCollapse; the idle-stayed caller re-polls
    // steadily while the session sits idle, so this guard makes the synthesis fire
    // AT MOST ONCE per collapsed turn.
    private fastCollapseSynthesizedTaskId: string | null = null;
    // GENERATING-BOUNDARY (R4c): the wall-clock moment the FSM's starting→idle
    // startup-grace collapse was observed (set ONCE, on the first starting→idle
    // transition this boot). The idle-stayed collapse window is anchored on THIS,
    // not on instance/boot time (this.startedAt): the FSM spends the full 8s
    // startup-grace sitting in 'starting' before collapsing, and a turn can be
    // dispatched a few seconds AFTER the collapse — measuring the window from boot
    // would have it already closed by the time that turn lands+completes (the live
    // R4b miss: collapse at boot+8s, dispatch at boot+12.4s > the 12s boot window).
    // Anchoring on the collapse moment makes the window cover dispatch-delay+turn.
    private startupGraceCollapseAt: number | null = null;
    // ANTIGRAVITY-PREMATURE-COMPLETION gate: wall-clock when the CURRENT mesh task
    // was injected/attached (attachMeshAssignment). The injected task counts as having
    // genuinely entered generating only once a turn STARTS after this moment
    // (currentTurnStartedAt > meshTaskInjectedAt) — because currentTurnStartedAt
    // persists from the PRIOR turn and forceSendMessage pre-binds currentTurnTaskId at
    // inject time, so neither alone distinguishes "injected but not yet generating"
    // from "genuinely generating". This timestamp is that discriminator. 0 = no task
    // injected since boot (ad-hoc/non-mesh turns fall back to the plain turn-started check).
    private meshTaskInjectedAt = 0;
    private settings: Record<string, any> = {};
    private monitor: StatusMonitor;
    private generatingDebounceTimer: NodeJS.Timeout | null = null;
    private generatingDebouncePending: { chatTitle: string; timestamp: number } | null = null;
    private lastApprovalEventFingerprint = '';
    // INTERACTIVE-PROMPT-PUSH: edge-trigger key for the AskUserQuestion / waiting_choice
    // notification. An AskUserQuestion prompt is surfaced only as a display-only
    // `waiting_choice` overlay in getState(); the raw adapter status stays idle/generating,
    // so detectStatusTransition()'s status-keyed arms never fire and no push-worthy
    // agent:* event is emitted — the owner misses the "ACTION REQUIRED" prompt when the
    // app is backgrounded. We emit one agent:waiting_choice on ENTRY into the prompt
    // state (its own coordinator event, NOT the approval channel — a multi-choice
    // question is answered with mesh_answer_question, never mesh_approve) carrying the
    // FULL InteractivePrompt payload, and dedupe on this key so repeated status ticks
    // with the same prompt do not re-fire. '' means no prompt is currently active
    // (cleared when the prompt is answered/gone).
    private lastInteractivePromptEventKey = '';
    private autoApproveBusy = false;
    private autoApproveBusyTimer: NodeJS.Timeout | null = null;
    private lastAutoApprovalSignature = '';
    // Settle gate: the approval modal's signature + the wall-clock when this
    // exact signature was first observed. Auto-approve only fires once the
    // SAME signature has been stable for AUTO_APPROVE_SETTLE_MS, so a prompt
    // still streaming into the PTY (its buttons/message changing frame to
    // frame) keeps resetting the timer and is never approved half-rendered.
    private pendingAutoApprovalSignature = '';
    private pendingAutoApprovalSince = 0;
    private autoApproveSettleTimer: NodeJS.Timeout | null = null;
    // Wall-clock when auto-approve first observed status!=waiting_approval while
    // a settle gate was in progress. Drives AUTO_APPROVE_GATE_HYSTERESIS_MS (or,
    // for a delegated-worker flap episode, AUTO_APPROVE_FLAP_CONTINUITY_MS) so a
    // brief generating flip does not immediately wipe the settle clock.
    private autoApproveInactiveSince = 0;
    // AUTOAPPROVE-FLAP-RECUR (Fix A): wall-clock when the CURRENT waiting_approval
    // episode last presented a concrete, captured modal (buttons.length > 0). The
    // Claude TUI momentarily reports status=waiting_approval with activeModal=null
    // / an empty button block while the button block scrolls out of the captured
    // frame; the raw guard below (buttons.length===0) used to bail on that frame,
    // never advancing the settle gate and leaving no re-check armed — so a modal
    // that flapped modal=none ↔ N-buttons around the settle boundary never
    // accumulated its 600ms. This tracks the last GOOD-modal frame so a short
    // scroll-out blip is absorbed (settle keeps running against the last captured
    // signature) while a genuinely closed modal — buttons empty continuously past
    // the continuity window — is still recognised and resets the gate.
    private autoApproveLastModalSeenAt = 0;
    // APPROVAL-INBOX-BLINDSPOT (Fix A): wall-clock of the last time this session actually
    // FIRED a local auto-approve resolveModal (the settle gate passed → resolveModal
    // dispatched). The mesh event forwarder keys its agent:waiting_approval suppression on
    // this + a cooldown so it only drops the coordinator notification when we can positively
    // confirm the modal was (or is being) resolved LOCALLY. If auto-approve is merely
    // *configured* on but has NOT recently fired for this modal, the raw waiting_approval is
    // forwarded so a task_approval_needed ledger row is created and the coordinator/inbox is
    // told — closing the blind spot where a never-resolving worker approval was silently
    // dropped just because settings.autoApprove===true.
    private lastAutoApproveFiredAt = 0;
    // AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval overlay (see APPROVAL_STICKY_FLAP_MS).
    // The wall-clock of the last frame where the RAW adapter reported waiting_approval with
    // a CONCRETE modal (buttons present), the cached modal to re-present across a busy blip,
    // and the approvalEntrySeq at that frame (so a stabilized frame carries the right seq to
    // the emission-dedup fingerprint). All zero/null when no recent concrete approval.
    private approvalStickyLastConcreteAt = 0;
    private approvalStickyModal: { message?: string; buttons?: unknown[]; kind?: string | null } | null = null;
    private approvalStickyEntrySeq = 0;
    // STATUS-MISMATCH: wall-clock when the CURRENT auto-approve episode (waiting_approval
    // + shouldAutoApprove) first began wanting to mask. Unlike pendingAutoApprovalSince it
    // is NOT reset when the modal signature changes (a still-streaming/flapping prompt) and
    // survives the same hysteresis blips the settle gate does, so it measures the TRUE age
    // of an unresolved auto-approve. Once it exceeds AUTO_APPROVE_MASK_STALL_MS the surface
    // mask is dropped so the real waiting_approval surfaces. Cleared when the episode ends
    // (modal genuinely gone, manual attendance takes over, or auto-approve fires).
    private autoApproveMaskSince = 0;
    // NOTIF-APPROVAL-MASKED (Q1b): the autoApproveMaskSince episode value for which a
    // stalled-approval coordinator nudge has already been emitted, so the nudge fires
    // exactly once per stalled auto-approve episode (0 = none emitted). Reusing the
    // per-episode mask-clock value as the key makes it provider-agnostic (no reliance on
    // approvalEntrySeq) and self-resetting: each new episode gets a fresh
    // autoApproveMaskSince timestamp, and the episode-end reset zeroes it.
    private stalledApprovalNudgeEpisode = 0;
    // Provider-common manual-attendance signal: while a human is actively driving
    // this session from the dashboard, auto-approve holds so they can take manual
    // control. Background mesh workers are never attended → delegated auto-approve
    // is unaffected.
    private readonly manualAttendance = new ManualAttendanceTracker();
    private controlValues: Record<string, string | number | boolean> = {};
    private summaryMetadata: unknown = undefined;
    private appliedEffectKeys = new Set<string>();
    private historyWriter: ChatHistoryWriter;
    private runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];
    private lastPersistedHistoryMessages: PersistableCliHistoryMessage[] = [];
    private lastAcknowledgedUserInputAt = 0;
    // TASKBUBBLE-DUP: per-content last-ack timestamps so the same dispatched
    // prompt acked twice in quick succession (the worker buffers the first
    // send during bootstrap/busy, then a redelivery — dispatch-confirm-timeout
    // requeue or a reconcile re-dispatch — fires a SECOND send_chat before the
    // outbound queue drains) collapses to ONE user bubble. Keyed on the trimmed
    // content; an entry older than USER_INPUT_ACK_DEDUP_WINDOW_MS is treated as
    // a fresh, intentional resend and is NOT suppressed.
    private recentUserInputAcks = new Map<string, number>();
    private lastNativeSourceCanonicalCheckAt = 0;
    private lastNativeSourceCanonicalCacheKey: string | undefined = undefined;
    // Session-id SQLite probe state (see completion/transcript-probe.ts).
    private readonly sqliteProbeCache = createSqliteProbeCache();
    readonly instanceId: string;
    private suppressIdleHistoryReplay = false;
    private errorMessage: string | undefined = undefined;
    private errorReason: ProviderErrorReason | undefined = undefined;
    private activeInteractivePrompt: InteractivePrompt | null = null;

    private presentationMode: 'terminal' | 'chat';
    private providerSessionId?: string;
    private launchMode: 'new' | 'resume' | 'manual';
    private initialThinkingLevel?: string;
    private readonly startedAt = Date.now();
    private onProviderSessionResolved?: (info: {
        instanceId: string;
        providerType: string;
        providerName: string;
        workspace: string;
        providerSessionId: string;
        previousProviderSessionId?: string;
    }) => void;

    constructor(
        private provider: ProviderModule,
        private workingDir: string,
        private cliArgs: string[] = [],
        instanceId?: string,
        transportFactory?: PtyTransportFactory,
        options?: {
            providerSessionId?: string;
            launchMode?: 'new' | 'resume' | 'manual';
            extraEnv?: Record<string, string>;
            /** BRAIN-ROUTING: standard thinking level to apply post-launch via the
             *  provider's thinkingControlId (runtime-control providers like hermes).
             *  Providers using thinkingLaunchArgs get it at spawn instead and ignore this. */
            initialThinkingLevel?: string;
            onProviderSessionResolved?: (info: {
                instanceId: string;
                providerType: string;
                providerName: string;
                workspace: string;
                providerSessionId: string;
                previousProviderSessionId?: string;
            }) => void;
        },
    ) {
        this.type = provider.type;
        this.instanceId = instanceId || crypto.randomUUID();
        this.presentationMode = 'chat';
        this.providerSessionId = options?.providerSessionId;
        this.launchMode = options?.launchMode || 'new';
        this.initialThinkingLevel = options?.initialThinkingLevel;
        this.onProviderSessionResolved = options?.onProviderSessionResolved;
        // FSMLOG-SESSION-ATTRIBUTION (D3): hand the resolved session id (assigned just above) to
        // the adapter so a spec-driven FSM tags its log lines with the owning session.
        this.adapter = createCliAdapter(provider as CliProviderModule, workingDir, cliArgs, options?.extraEnv || {}, transportFactory, this.instanceId) as ProviderCliAdapter;
        if (this.providerSessionId) {
            this.adapter.updateRuntimeMeta({ providerSessionId: this.providerSessionId });
        }
        this.monitor = new StatusMonitor();
        this.historyWriter = new ChatHistoryWriter();
    }

    refreshProviderDefinition(provider: ProviderModule): void {
        if (provider.type !== this.type || provider.category !== 'cli') return;
        this.provider = provider;
        this.adapter.refreshProviderDefinition(provider as CliProviderModule);
    }

 // ─── Lifecycle ─────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.context = context;
        this.settings = context.settings || {};
        this.adapter.updateRuntimeSettings?.(this.settings);
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            noProgressAlert: (this.settings.noProgressAlert ?? this.settings.longGeneratingAlert) !== false,
            noProgressThresholdSec: this.settings.noProgressThresholdSec ?? this.settings.longGeneratingThresholdSec ?? 180,
        });

 // Server connection
        if (context.serverConn) {
            this.adapter.setServerConn(context.serverConn);
        }

 // PTY output callback
        if (context.onPtyData) {
            this.adapter.setOnPtyData(context.onPtyData);
        }

 // Emit event on status change
        this.adapter.setOnStatusChange(() => {
            this.detectStatusTransition();
        });

 // FALSE-IDLE (Fix 2): let the engine's applyIdle hysteresis consult THIS instance's
 // auto-approve/mesh-scoped resume-grace judgment (the same one Fix 1 uses).
        if (typeof this.adapter.setInApprovalResumeGraceProbe === 'function') {
            this.adapter.setInApprovalResumeGraceProbe(() => this.inApprovalResumeGrace());
        }

 // FLOOR-CLASS-TRANSCRIPT-DEFER-CAP: let the engine's bounded transcript-finish
 // defer-cap escape consult THIS instance's native-transcript final-assistant
 // judgment (the same read the completion gate uses).
        if (typeof this.adapter.setNativeFinalAssistantProbe === 'function') {
            this.adapter.setNativeFinalAssistantProbe(() => this.hasFreshNativeFinalAssistantForCurrentTurn());
        }

 // PTY spawn
        await this.adapter.spawn();
        await this.enforceFreshSessionLaunchIfNeeded();
        await this.applyInitialThinkingLevelViaControl();
        this.maybeAppendRuntimeRecoveryMessage(this.adapter.getRuntimeMetadata());
        if (this.providerSessionId && this.shouldHydrateExistingProviderHistory()) {
            this.restorePersistedHistoryFromCurrentSession();
        }
        if (this.providerSessionId && this.launchMode === 'resume') {
            const resumedAt = Date.now();
            this.historyWriter.appendSystemMarker(
                this.type,
                `Resumed saved session at ${formatMarkerTimestamp(resumedAt)}`,
                {
                    instanceId: this.instanceId,
                    historySessionId: this.providerSessionId,
                    dedupKey: `resume:${this.providerSessionId}:${resumedAt}`,
                    receivedAt: resumedAt,
                },
            );
        }
    }

    async onTick(): Promise<void> {
        if (this.providerSessionId) return;
        if (this.provider.resume?.skipProbeOnNewSession && this.launchMode === 'new') return;

        const probeConfig = this.provider.sessionProbe;
        if (!probeConfig) return;

        const probedSessionId = this.probeSessionIdFromConfig(probeConfig);
        if (probedSessionId) {
            this.promoteProviderSessionId(probedSessionId);
        }
    }

    /**
     * Generic session ID probe using declarative ProviderSessionProbe config.
     * Replaces the previously duplicated probeOpenCode/Codex/Goose functions.
     */
    private probeSessionIdFromConfig(probe: {
        dbPath: string;
        query: string;
        timestampFormat?: 'unix_ms' | 'unix_s' | 'iso';
    }): string | null {
        const resolvedDbPath = probe.dbPath.replace(/^~/, os.homedir());
        // Skip existsSync if we already confirmed DB is missing (cache for 10s)
        const now = Date.now();
        if (this.sqliteProbeCache.missingUntil > now) return null;
        if (!fs.existsSync(resolvedDbPath)) {
            this.sqliteProbeCache.missingUntil = now + 10_000;
            return null;
        }

        const directories = probeDirectoriesFor(this.workingDir);
        const minCreatedAt = Math.max(0, this.startedAt - 60_000);
        const tsFormat = probe.timestampFormat || 'unix_ms';

        let timestampParam: string | number;
        if (tsFormat === 'unix_s') {
            timestampParam = Math.floor(minCreatedAt / 1000);
        } else if (tsFormat === 'iso') {
            timestampParam = new Date(minCreatedAt).toISOString().slice(0, 19).replace('T', ' ');
        } else {
            timestampParam = minCreatedAt;
        }

        // Build query: replace {dirs} with SQL placeholder list
        const placeholders = sqlPlaceholderList(directories.length);
        const query = probe.query.replace('{dirs}', placeholders);

        try {
            return querySqliteSessionId(this.sqliteProbeCache, resolvedDbPath, query, [...directories, timestampParam]);
        } catch {
            return null;
        }
    }

    getState(): ProviderState {
        // TODO(phase5-sandbox): JS override scripts (detectStatus, parseApproval,
        // parseSession) are currently invoked by CliScriptRunner.invoke() via direct
        // function calls — the scripts run in the daemon process with full Node.js
        // access and no resource limits.
        //
        // When Phase 5 lands, CliScriptRunner should route these calls through a
        // SandboxedScriptRunner (see providers/sdk/v1/sandbox/script-runner.ts) so
        // that each call gets a fresh isolated-vm context with a 50 ms CPU limit and
        // a 32 MB memory cap.  The execution path to change is:
        //   CliScriptRunner.invoke() → SandboxedScriptRunner.run(scriptSource, context)
        //
        // This getState() call-site is NOT where the change goes — the wiring belongs
        // in cli-script-runner.ts (CliScriptRunner.detectStatus / parseApproval /
        // parseSession), with provider-loader.ts updated to store script source strings
        // alongside the loaded function references for extended-legacy providers.
        // AUTOAPPROVE-FLAP-INBOX-MISSING: apply the same sticky-approval overlay the
        // FSM path uses so the status this getState() surfaces to the mesh probe (and
        // thus mesh_active_work → the pending-approval inbox) stays waiting_approval
        // across a busy flap frame, instead of momentarily reading generating (count:0).
        const adapterStatus = this.stabilizeFlappingApprovalStatus(this.adapter.getStatus());
        if (Object.prototype.hasOwnProperty.call(adapterStatus, 'activeInteractivePrompt')) {
            this.activeInteractivePrompt = adapterStatus.activeInteractivePrompt ?? null;
        }
        let parsedStatus: any = null;
        let parseErrorMessage: string | undefined;
        if (typeof this.adapter.getScriptParsedStatus === 'function') {
            try {
                parsedStatus = this.adapter.getScriptParsedStatus() || null;
                const parsedErrorMessage = typeof parsedStatus?.errorMessage === 'string' && parsedStatus.errorMessage.trim()
                    ? parsedStatus.errorMessage.trim()
                    : undefined;
                const parsedErrorReason = typeof parsedStatus?.errorReason === 'string' && parsedStatus.errorReason.trim()
                    ? parsedStatus.errorReason.trim() as ProviderErrorReason
                    : undefined;
                this.errorMessage = parsedErrorMessage;
                this.errorReason = parsedErrorReason;
            } catch (error: any) {
                parseErrorMessage = error?.message || String(error);
                this.errorMessage = parseErrorMessage;
                this.errorReason = 'parse_error';
            }
        } else {
            this.errorMessage = undefined;
            this.errorReason = undefined;
        }
        const adapterProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof adapterStatus?.providerSessionId === 'string' ? adapterStatus.providerSessionId : '',
        );
        const nowMs = Date.now();
        // STATUS-MISMATCH: maybeAutoApproveStatus still runs for its side effects (settle gate,
        // resolveModal fire), but the SURFACE mask is dropped once the episode has stalled past
        // AUTO_APPROVE_MASK_STALL_MS — otherwise a never-settling auto-approve hides the worker's
        // waiting_approval + modal from read_chat/mesh_status/dashboard forever.
        const autoApproveActive = this.maybeAutoApproveStatus(adapterStatus, nowMs)
            && !this.autoApproveMaskStalled(nowMs);
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        let visibleStatus = parseErrorMessage || parsedStatus?.status === 'error'
            ? 'error'
            : (autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status);
        // getState() must agree with the status the FSM-driven detectStatusTransition()
        // already committed to lastStatus. The adapter's own status is authoritative; we do
        // not second-guess it with native-transcript shape. Only reconcile a generating-like
        // read down to idle when our own lastStatus has already flipped idle (avoids a
        // perpetual dashboard spinner during the brief window before the next getStatus()).
        if (isCliGeneratingLikeStatus(visibleStatus) && this.lastStatus === 'idle') {
            visibleStatus = 'idle';
        }
        const runtime = this.adapter.getRuntimeMetadata();
        this.maybeAppendRuntimeRecoveryMessage(runtime);
        let parsedMessages = Array.isArray(parsedStatus?.messages)
            ? parsedStatus.messages
            : [];
        const parsedProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof parsedStatus?.providerSessionId === 'string' ? parsedStatus.providerSessionId : '',
        );
        const suppressFreshLaunchStartupReplay = this.shouldSuppressFreshLaunchStartupReplay(
            parsedMessages,
            parsedStatus,
            adapterStatus,
            parsedProviderSessionId,
        );
        if (adapterProviderSessionId && !suppressFreshLaunchStartupReplay) {
            this.promoteProviderSessionId(adapterProviderSessionId);
        }
        if (parsedProviderSessionId && !suppressFreshLaunchStartupReplay) {
            this.promoteProviderSessionId(parsedProviderSessionId);
        }
        if (suppressFreshLaunchStartupReplay) {
            parsedMessages = [];
        }
        // Adapter runtime metadata is transport-owned and is not guaranteed to
        // identify this conversation. Spec adapters historically exposed the
        // provider spec id (for example "codex-cli") as runtimeId, which made
        // concurrent sessions share one activeChat identity until their native
        // provider session ids were discovered.
        const activeChatId = this.providerSessionId || this.instanceId;
        const historyMessageCount = Number.isFinite(parsedStatus?.historyMessageCount)
            ? Math.max(0, Number(parsedStatus.historyMessageCount))
            : null;
        if (historyMessageCount !== null) {
            parsedMessages = historyMessageCount > 0
                ? parsedMessages.slice(-historyMessageCount)
                : [];
        }
        const mergedMessages = mergeConversationMessages(this.runtimeMessages, parsedMessages);
        const canonicalBackedHistory = this.shouldHydrateExistingProviderHistory()
            ? this.syncCanonicalSavedHistoryIfNeeded()
            : false;
        const statusMessages: any[] = canonicalBackedHistory && this.lastPersistedHistoryMessages.length > 0
            ? this.lastPersistedHistoryMessages.map((message) => ({
                role: message.role,
                content: message.content,
                kind: message.kind,
                senderName: message.senderName,
                receivedAt: message.receivedAt,
            }))
            : mergedMessages;

        // purpose: 'display-tail' (zero-read) — Dashboard-tail repair (native-source
        // providers, e.g. antigravity): the assistant answer lives only in native-history,
        // so the PTY-parsed statusMessages end on the user prompt / auto-approve system
        // lines and the snapshot's preview / lastMessageRole / completionMarker never see
        // the answer — the session looks stuck on the user turn. We already cached the
        // real final assistant summary at completion time (lastCompletionSummary), so
        // append it as the trailing assistant bubble when the current tail has no
        // assistant message at/after it. Purely additive to the status view; no per-tick
        // native read, no effect on providers whose PTY carries the assistant (they
        // surface it themselves and the guard below is a no-op).
        //
        // authority-ok: this is a DISPLAY-ONLY tail repair, never a completion/stall/
        // redrive verdict — it reads the pre-cached summary (zero native read) and only
        // paints the status view. It keys off the adapter's runtime chatMessagesOwnedExternally
        // capability (not a class predicate); a completion decision is never taken here.
        const adapterOwnsMessagesElsewhereForTail = (this.adapter as any)?.chatMessagesOwnedExternally === true;
        if (adapterOwnsMessagesElsewhereForTail && this.lastCompletionSummary) {
            const summary = this.lastCompletionSummary;
            let hasTrailingAssistant = false;
            for (let i = statusMessages.length - 1; i >= 0; i -= 1) {
                const m = statusMessages[i] as { role?: string; kind?: string; receivedAt?: number };
                const role = typeof m?.role === 'string' ? m.role : '';
                if (role === 'system') continue;
                if (typeof m?.kind === 'string' && m.kind === 'tool') continue;
                // First non-system/non-tool message from the tail: if it's already an
                // assistant reply not older than our cached summary, the tail is fine.
                hasTrailingAssistant = role === 'assistant'
                    && typeof m?.receivedAt === 'number'
                    && m.receivedAt >= summary.receivedAt - 1000;
                break;
            }
            if (!hasTrailingAssistant) {
                statusMessages.push({
                    role: 'assistant',
                    content: summary.content,
                    kind: 'standard',
                    receivedAt: summary.receivedAt,
                });
            }
        }

        const dirName = workingDirBasename(this.workingDir);
        const parsedChatStatus = typeof parsedStatus?.status === 'string' && parsedStatus.status.trim()
            ? parsedStatus.status.trim()
            : undefined;
        const suppressStaleParsedBusyStatus = this.shouldSuppressStaleParsedBusyStatus(parsedStatus, adapterStatus);

        if (parsedMessages.length > 0) {
            const shouldSkipReplayPersist =
                this.suppressIdleHistoryReplay
                && adapterStatus.status === 'idle'
                && parsedStatus?.status === 'idle';
            let messagesToSave = parsedMessages;
            if (!suppressStaleParsedBusyStatus && (parsedChatStatus === 'generating' || parsedChatStatus === 'no_progress' || parsedChatStatus === 'long_generating')) {
                const lastIdx = messagesToSave.length - 1;
                if (lastIdx >= 0 && messagesToSave[lastIdx]?.role === 'assistant') {
                    messagesToSave = messagesToSave.slice(0, lastIdx);
                }
            }
            const normalizedMessagesToSave = messagesToSave.map((message: PersistableCliHistoryMessage & { timestamp?: number }) => ({
                role: message.role,
                content: flattenContent(message.content),
                kind: typeof message.kind === 'string' ? message.kind : undefined,
                senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
                receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : message.timestamp,
            }));
            if (!canonicalBackedHistory && !shouldSkipReplayPersist && normalizedMessagesToSave.length > 0) {
                const incrementalMessages = buildIncrementalHistoryAppendMessages(this.lastPersistedHistoryMessages, normalizedMessagesToSave);
                if (incrementalMessages.length > 0) {
                    this.historyWriter.appendNewMessages(
                        this.type,
                        incrementalMessages,
                        parsedStatus?.title || dirName,
                        this.instanceId,
                        this.providerSessionId,
                    );
                }
            }
            if (!canonicalBackedHistory) {
                this.lastPersistedHistoryMessages = normalizedMessagesToSave;
            }
        }

        this.applyProviderResponse(
            suppressFreshLaunchStartupReplay && parsedStatus && typeof parsedStatus === 'object'
                ? { ...parsedStatus, providerSessionId: undefined }
                : parsedStatus,
            { phase: 'immediate' },
        );
        const surface = resolveProviderStateSurface({
            summaryMetadata: this.summaryMetadata as any,
            controlValues: this.controlValues,
        });
        const activeChatStatus = parseErrorMessage
            ? 'error'
            : (autoApproveActive && parsedStatus?.status === 'waiting_approval') || autoApproveHoldIdle
            ? 'generating'
            : (adapterStatus.status !== 'idle'
                ? visibleStatus
                : (suppressStaleParsedBusyStatus ? visibleStatus : (parsedChatStatus || visibleStatus)));

        // If an AskUserQuestion prompt is awaiting user input, overlay status as
        // waiting_choice. This is distinct from waiting_approval (tool-use consent)
        // — the engine's isWaitingForResponse state is unchanged, so completion
        // tracking continues normally once the user responds.
        const hasInteractivePrompt = !!this.activeInteractivePrompt;
        const finalStatus = hasInteractivePrompt ? 'waiting_choice' : visibleStatus;
        const finalChatStatus = hasInteractivePrompt ? 'waiting_choice' : activeChatStatus;

        return {
            type: this.type,
            name: this.provider.name,
            category: 'cli',
            status: finalStatus,
            mode: this.presentationMode,
            activeChat: {
                id: activeChatId,
                title: parsedStatus?.title || dirName,
                status: finalChatStatus,
                messages: statusMessages,
                activeModal: (autoApproveActive || autoApproveHoldIdle) ? null : (parsedStatus?.activeModal ?? adapterStatus.activeModal),
                activeInteractivePrompt: this.activeInteractivePrompt,
                inputContent: '',
            },
            activeInteractivePrompt: this.activeInteractivePrompt,
            workspace: this.workingDir,
            instanceId: this.instanceId,
            providerSessionId: this.providerSessionId,
            lastUpdated: Date.now(),
            settings: this.settings,
            pendingEvents: this.flushEvents(),
            runtime: runtime ? {
                runtimeId: runtime.runtimeId,
                runtimeKey: runtime.runtimeKey,
                displayName: runtime.displayName,
                workspaceLabel: runtime.workspaceLabel,
                lifecycle: runtime.lifecycle ?? null,
                surfaceKind: runtime.surfaceKind,
                writeOwner: runtime.writeOwner || null,
                attachedClients: runtime.attachedClients || [],
                restoredFromStorage: runtime.restoredFromStorage === true,
                recoveryState: runtime.recoveryState ?? null,
            } : undefined,
            resume: this.provider.resume,
            controlValues: surface.controlValues,
            providerControls: this.provider.controls,
            messageInput: getEffectiveMessageInputSupport(this.provider),
            summaryMetadata: surface.summaryMetadata as any,
            errorMessage: this.errorMessage,
            errorReason: this.errorReason,
            // Restart idle-gate (mesh-restart collectBlockingSessions): a queued
            // outbound coordinator message is restart-blocking, so the count must
            // reach the daemon-wide state collection.
            pendingOutboundCount: typeof adapterStatus.pendingOutboundCount === 'number'
                ? adapterStatus.pendingOutboundCount
                : undefined,
        };
    }

    setPresentationMode(mode: 'terminal' | 'chat'): void {
        if (this.presentationMode === mode) return;
        this.presentationMode = mode;
    }

    getPresentationMode(): 'terminal' | 'chat' {
        return this.presentationMode;
    }

    getHotChatSessionState(): HotChatSessionState {
        const adapterStatus = this.adapter.getStatus({ allowParse: false });
        const nowMs = Date.now();
        // STATUS-MISMATCH: drop the mask once the auto-approve episode has stalled (see getState).
        const autoApproveActive = this.autoApproveEffectivelyActive(adapterStatus.status, nowMs)
            && !this.autoApproveMaskStalled(nowMs);
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        const visibleStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status;
        const runtime = this.adapter.getRuntimeMetadata();
        return {
            id: this.instanceId,
            status: visibleStatus,
            runtimeLifecycle: runtime?.lifecycle ?? null,
            runtimeSurfaceKind: runtime?.surfaceKind,
            runtimeRestoredFromStorage: runtime?.restoredFromStorage === true,
            runtimeRecoveryState: runtime?.recoveryState ?? null,
        };
    }

    getSessionModalState(sessionId?: string): SessionModalState {
        const adapterStatus = this.adapter.getStatus({ allowParse: true });
        const nowMs = Date.now();
        // STATUS-MISMATCH: drop the mask once the auto-approve episode has stalled (see getState).
        const autoApproveActive = this.autoApproveEffectivelyActive(adapterStatus.status, nowMs)
            && !this.autoApproveMaskStalled(nowMs);
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        const visibleStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status;
        const dirName = workingDirBasename(this.workingDir);
        return {
            // Honor the caller-supplied sessionId — InstanceMgr rejects the
            // projection when projected.id !== requested sessionId, and
            // this.instanceId is the manager's internal key, not the public
            // sessionId the dashboard subscribes by.
            id: sessionId ?? this.instanceId,
            status: visibleStatus,
            title: dirName,
            activeModal: (autoApproveActive || autoApproveHoldIdle) ? null : adapterStatus.activeModal,
        };
    }

    updateSettings(newSettings: Record<string, any>): void {
        // Merge semantics: a key omitted from newSettings preserves its existing
        // value, a key present in newSettings (even as false) overrides it.
        //
        // This is required because updateSettings has two callers with opposite
        // intent:
        //   1. Full re-injection — the dashboard toggle path (handleSetProviderSetting
        //      → getSettings → updateInstanceSettings) sends the COMPLETE settings
        //      object, so an explicit autoApprove:false must win.
        //   2. Partial stamp — the mesh relay-safety stamp (router.ts agent_command,
        //      buildMeshWorkerRelayStamp) sends ONLY {meshNodeFor, meshNodeId,
        //      meshCoordinatorDaemonId, launchedByCoordinator} on every coordinator
        //      re-dispatch. It carries no autoApprove, so a full replacement would
        //      wipe the launch-time autoApprove:true the worker was started with,
        //      silently dropping every later approval to a manual gate until the
        //      machine-page toggle re-injected the full settings.
        //
        // A plain merge satisfies both: undefined keys fall through to the existing
        // value (preserving launch-stamp settings like autoApprove + the mesh routing
        // keys), explicit keys override. This subsumes the previous mesh-key preserve
        // list, which only protected the routing keys and not autoApprove.
        this.settings = { ...this.settings, ...newSettings };
        this.adapter.updateRuntimeSettings?.(this.settings);
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            noProgressAlert: (this.settings.noProgressAlert ?? this.settings.longGeneratingAlert) !== false,
            noProgressThresholdSec: this.settings.noProgressThresholdSec ?? this.settings.longGeneratingThresholdSec ?? 180,
        });
    }

    /**
     * Stamp a direct-dispatch mesh assignment on this instance.
     * setupMeshEventForwarding reads settings.meshNodeFor + meshActiveTaskId to
     * route generating_completed back to the originating coordinator. Without
     * this stamp, mesh_send_task --direct targets a plain CLI session whose
     * completion events silently drop because the forwarder has nothing to
     * match against.
     */
    attachMeshAssignment(assignment: { meshId: string; nodeId?: string; taskId?: string; dispatchNonce?: number; attemptId?: string; coordinatorDaemonId?: string; coordinatorSessionId?: string }): void {
        if (!assignment?.meshId) return;
        // ANTIGRAVITY-PREMATURE-COMPLETION gate: stamp the injection moment for a task
        // attach so injectedTaskHasStartedGenerating() can require the producing turn to
        // START after this point (rejecting the prior turn's stale native-history tail
        // that would otherwise fire generating_completed before generating_started).
        if (assignment.taskId && assignment.taskId.trim()) {
            this.meshTaskInjectedAt = Date.now();
        }
        this.settings = {
            ...this.settings,
            meshNodeFor: assignment.meshId,
            // WTCLAIM (A): track the bound node id under BOTH the active marker
            // (meshNodeId, cleared on detach) and a sticky marker (meshLastNodeId,
            // preserved across detach). The sticky marker lets a detached but still
            // coordinator-owned session be re-picked ONLY for the SAME node it served
            // — never auto-adopted for a sibling node (e.g. a cloned worktree) that
            // shares this daemon. See isMeshOwnedDelegateSession's post-detach gate.
            ...(assignment.nodeId ? { meshNodeId: assignment.nodeId, meshLastNodeId: assignment.nodeId } : {}),
            ...(assignment.taskId ? { meshActiveTaskId: assignment.taskId } : {}),
            // REDRIVE-DUP: task-level dispatch nonce, echoed on generating_started so the
            // coordinator can reject a stale (reclaimed) dispatch. Cleared with meshActiveTaskId
            // on detach so a subsequent unrelated turn never re-echoes a prior task's nonce.
            ...(typeof assignment.dispatchNonce === 'number' ? { meshActiveDispatchNonce: assignment.dispatchNonce } : {}),
            // TURN-LEDGER (Stage 5): the opaque attempt identity for this dispatch, echoed
            // on lifecycle events so the coordinator's reducer correlates ACKs/completion
            // proposals to (taskId, attemptId, session). Cleared with meshActiveTaskId on
            // detach so a later unrelated turn never re-echoes a prior attempt.
            ...(assignment.attemptId ? { meshActiveAttemptId: assignment.attemptId } : {}),
            ...(assignment.coordinatorDaemonId ? { meshCoordinatorDaemonId: assignment.coordinatorDaemonId } : {}),
            // Session-level routing anchor: the originating coordinator session, so this
            // worker's completion events route back to the exact session that dispatched it.
            ...(assignment.coordinatorSessionId ? { meshCoordinatorSessionId: assignment.coordinatorSessionId } : {}),
        };
        this.adapter.updateRuntimeSettings?.(this.settings);
    }

    /**
     * Clear a previously-attached mesh assignment after the task reaches a
     * terminal state. Leaving meshNodeFor pinned would route this session's
     * subsequent unrelated turns (e.g. ad-hoc dashboard chats) to the
     * coordinator as if they were task completions.
     *
     * MESHID-DROP-ON-DETACH (Fix C): a coordinator-LAUNCHED worker session
     * (launchedByCoordinator) holds its mesh membership (meshNodeFor / meshNodeId /
     * meshCoordinatorDaemonId) at the SESSION level — set once at launch
     * (mesh_launch_session / queue auto-launch), independent of any single task.
     * The original detach wiped meshNodeFor + meshNodeId together with the
     * task-level meshActiveTaskId, so the FIRST task completion stripped the
     * membership and EVERY subsequent completion forwarded with meshId absent —
     * resolveWorkerDelegateRouting fell to mesh_unresolved and the coordinator
     * rejected the forward "meshId required". For a launched member we therefore
     * clear ONLY the task-level marker (meshActiveTaskId) and preserve the
     * session-level membership so its next task's completion still resolves.
     * A task-less ad-hoc turn on a preserved-membership session is NOT misrouted:
     * its completion carries no taskId and the session holds no active assignment,
     * so the forwarder's WARMUPGAP guard skips the dispatch-row flip (it only
     * injects a benign task-less notification). A NON-launched session (a plain CLI
     * session adopted by mesh_send_task --direct, launchedByCoordinator falsy)
     * keeps the original full clear so an ad-hoc session is never left pinned.
     */
    detachMeshAssignment(): void {
        if (!this.settings.meshNodeFor && !this.settings.meshActiveTaskId && !this.settings.meshNodeId) return;
        // Session-level member: keep membership, drop only the task-level markers.
        if (this.settings.launchedByCoordinator === true) {
            if (!this.settings.meshActiveTaskId) return;
            // REDRIVE-DUP: clear the task-level dispatch nonce with the task marker.
            const { meshActiveTaskId, meshActiveDispatchNonce, meshActiveAttemptId, ...rest } = this.settings;
            void meshActiveTaskId; void meshActiveDispatchNonce; void meshActiveAttemptId;
            this.settings = rest;
            this.adapter.updateRuntimeSettings?.(this.settings);
            return;
        }
        const { meshNodeFor, meshNodeId, meshActiveTaskId, meshActiveDispatchNonce, meshActiveAttemptId, ...rest } = this.settings;
        void meshNodeFor; void meshActiveTaskId; void meshActiveDispatchNonce; void meshActiveAttemptId;
        // WTCLAIM (A): clear the active binding but PRESERVE the last bound node id
        // (meshLastNodeId) so a later sessionless dispatch can re-adopt this idle
        // session ONLY for the node it last served. Carry the id being cleared, or
        // keep an already-present sticky marker if meshNodeId was absent.
        const lastNodeId = (typeof meshNodeId === 'string' && meshNodeId.trim())
            ? meshNodeId.trim()
            : (typeof rest.meshLastNodeId === 'string' && rest.meshLastNodeId.trim() ? rest.meshLastNodeId.trim() : undefined);
        this.settings = lastNodeId ? { ...rest, meshLastNodeId: lastNodeId } : rest;
        this.adapter.updateRuntimeSettings?.(this.settings);
    }

    /**
     * The resolved modal-park status of this session, or null when it is not
     * parked on a modal awaiting a human answer. Mirrors the overlay logic in
     * getState(): an active AskUserQuestion interactive prompt resolves to
     * waiting_choice; otherwise the adapter's waiting_approval (tool consent)
     * counts — UNLESS auto-approve will dismiss it, in which case the session is
     * effectively generating and is NOT modal-parked. This is the single signal
     * the mesh force-inject guard consults, and the same status string the
     * reconcile loop reads off get_status_metadata. Lowercase literals only —
     * the SessionStatus enum is forked across modules and waiting_choice is
     * absent from some of them.
     */
    resolveModalParkStatus(): 'waiting_choice' | 'waiting_approval' | null {
        if (this.activeInteractivePrompt) return 'waiting_choice';
        let adapterStatus: { status?: string };
        try {
            adapterStatus = this.adapter.getStatus({ allowParse: false });
        } catch {
            return null;
        }
        // A session whose auto-approve is held by manual attendance IS parked on a
        // modal awaiting the human — autoApproveEffectivelyActive folds that in, so
        // the mesh force-inject guard correctly treats it as modal-parked. STATUS-MISMATCH:
        // a STALLED auto-approve (never resolving) is likewise effectively parked — treat it
        // as modal-parked so its events are held/surfaced rather than masked behind generating.
        if (adapterStatus.status === 'waiting_approval'
            && (!this.autoApproveEffectivelyActive(adapterStatus.status) || this.autoApproveMaskStalled())) {
            // NOTIF-HELD-DRAIN (Fix 1): an autonomous mesh session (coordinator or worker)
            // that is actively progressing a turn — a tool call is in flight
            // (hasAdapterPendingResponse) and NO human is attending it by hand — surfaces a
            // routine tool-consent `waiting_approval` on EVERY tool call when auto-approve is
            // off. That transient consent is part of the turn the harness/operator drives to
            // completion, NOT a session genuinely wedged awaiting a human's modal answer.
            // Classifying it modal-parked makes findLiveCoordinators hold the mesh's pending
            // completion events under `modal_parked` across a busy coordinator's whole work
            // batch, which is the multi-minute notification stall. Treat such a transient
            // consent as NOT modal-parked so it is held as ordinary "generating" (released on
            // the next idle) instead. A manually-attended session, a stalled auto-approve, or a
            // non-progressing session (no turn in flight) still parks — those are the genuine
            // human-await cases the guard must keep holding.
            if (this.isTransientToolConsent()) {
                return null;
            }
            return 'waiting_approval';
        }
        return null;
    }

    /**
     * APPROVAL-INBOX-BLINDSPOT (Fix A): true when this session's approval modal was — or is
     * being — resolved LOCALLY within the recent cooldown. Two independent positive signals:
     *   (1) auto-approve fired its resolveModal within APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS
     *       (lastAutoApproveFiredAt), or
     *   (2) the underlying adapter reports isApprovalRecentlyResolved() — its own resolve
     *       cooldown, which also covers a dashboard / mesh_approve resolution.
     * The mesh event forwarder uses this to decide whether an agent:waiting_approval from an
     * auto-approving worker can be safely SUPPRESSED (a local resolution is in flight) or must
     * be FORWARDED (auto-approve is configured but has NOT actually resolved this modal, so the
     * coordinator/inbox must be told). Keying suppression on real resolution — not just the
     * autoApprove *intent* — is the blind-spot fix: a never-resolving worker approval is no
     * longer silently dropped.
     */
    approvalRecentlyResolvedLocally(now = Date.now()): boolean {
        if (this.lastAutoApproveFiredAt
            && now - this.lastAutoApproveFiredAt < CliProviderInstance.APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS) {
            return true;
        }
        try {
            const adapter = this.adapter as { isApprovalRecentlyResolved?: () => boolean };
            if (typeof adapter.isApprovalRecentlyResolved === 'function') {
                return adapter.isApprovalRecentlyResolved() === true;
            }
        } catch { /* adapter gone / transient */ }
        return false;
    }

    /**
     * NOTIF-HELD-DRAIN: true when this `waiting_approval` is a routine, transient tool-consent
     * of an autonomously-progressing mesh session rather than a genuine human-await modal —
     * i.e. it is a mesh coordinator/worker session, a turn is actively in flight
     * (hasAdapterPendingResponse), and no human is attending it by hand. Such a consent is
     * driven to resolution by the harness/operator as part of the in-flight turn, so holding
     * the mesh's completion events behind it (modal_parked) is the false-positive that stalls
     * delivery. Narrow by design: manual attendance or a non-progressing session falls through
     * to the genuine-modal classification.
     */
    private isTransientToolConsent(now = Date.now()): boolean {
        return this.isAutonomousMeshSession()
            && this.hasAdapterPendingResponse()
            && !this.manualAttendance.isAttended(now);
    }

    /** True when this session is parked on a modal awaiting a human answer. */
    isModalParked(): boolean {
        return this.resolveModalParkStatus() !== null;
    }

    /**
     * Provider-agnostic live-state observation for the mesh completion gate —
     * see completion/evidence.ts (verbatim move; the private discriminators it
     * consults stay instance methods via the host interface).
     */
    getLiveTurnPendingEvidence(): {
        pending: boolean;
        kind?: 'adapter' | 'modal' | 'transcript_tool';
        observedAt?: number;
    } {
        return evidence.getLiveTurnPendingEvidence(this as unknown as EvidenceHost);
    }

    /**
     * MID-TURN-LIVE-STATE-GATE (broader false-idle RCA, mid-turn follow-up): a live,
     * synchronous re-check of whether this session's CURRENT turn genuinely still has
     * unresolved work. Public wrapper so the coordinator (mesh-event-forwarding) can
     * independently re-verify an incoming agent:generating_completed for a LOCAL session
     * before trusting it — defense-in-depth against a race where the completion emit and the
     * coordinator's receipt straddle a state change (screen-redraw parse artifact, decoupled-
     * immediate emit). Reuses the EXACT same discriminators this instance's own finalization
     * gate (getCompletedFinalizationBlock) uses — hasAdapterPendingResponse() (adapter
     * isWaitingForResponse / currentTurnScope / isProcessing() / a non-empty partial response)
     * OR isModalParked() (a live approval/choice modal) — so a session this method reports
     * pending is, by construction, one the local finalization gate would also refuse to
     * finalize right now.
     *
     * NATIVE-TRAILING-TOOL-GATE (rc.16 follow-up): the three adapter-state discriminators
     * above are blind to a background shell tool that keeps a turn alive without the adapter
     * reporting a pending response — e.g. a backgrounded `sleep 40 &` between narration
     * bubbles on a write-lag native-source provider (claude-cli), which is deliberately
     * un-floored (noExternalTranscriptSource omitted, mission f2f6da1b owner decision) so its
     * transcript write-lag emits promptly. That un-flooring is correct for the ordinary
     * fraction-of-a-second trail, but it also means the growth-hold / busy-lease protections
     * in getCompletedFinalizationBlock never engage for claude-cli, so an interim final-
     * LOOKING bubble followed by continuing tool calls can still finalize as a completion
     * while the transcript demonstrably shows the turn still executing. Close that gap here,
     * narrowly: for a native-source provider only, reuse the SAME bounded transcript read the
     * class's own completion judgment already performs (probeNativeTranscriptSignals) and
     * apply the SAME trailing-tool-activity veto the transcript-synth admission choke point
     * uses (hasTrailingToolActivityAfterFinalAssistant) — the latest final-looking assistant
     * bubble followed by tool/terminal activity is interim narration, not a turn end. Fail-open
     * by construction: a non-native-source class (probe returns null), an unresolved
     * transcript, or a read error never reaches the veto, so a missing/unavailable transcript
     * can never wedge a session as "pending" forever.
     */
    hasLiveTurnPendingEvidence(): boolean {
        return this.getLiveTurnPendingEvidence().pending;
    }

    /**
     * PTY-OVERTRUST-DRAIN (Defect B). The deliverability/drain status the mesh
     * reconcile loop must consult — the RAW adapter turn-state, with the
     * auto-approve "hold-idle" visual mask STRIPPED.
     *
     * getState().status overlays `autoApproveHoldIdle`/`autoApproveActive` to paint a
     * genuinely-idle adapter as `generating` (a UI-flicker suppression while an
     * auto-approve key-press settles — see getState() ~:800). That mask is correct
     * for the dashboard, but the reconcile loop trusts it as "the coordinator is
     * busy" and therefore HOLDS a worker's completion under
     * `generating_no_idle_coordinator` even though the coordinator's PTY is at a real
     * turn end and would accept the inject as a turn — the completion is stranded.
     *
     * This accessor reports the drain truth instead:
     *   - 'modal_parked' — a GENUINE human-await modal (AskUserQuestion / a non-
     *     transient tool-consent). Still excluded from drain (a force-inject here
     *     writes raw keystrokes the modal eats → data corruption). Mirrors
     *     isModalParked(), evaluated first so a parked session never reads idle.
     *   - 'idle' — the RAW adapter is at a turn end (adapter.getStatus(allowParse:false)
     *     === 'idle') and the session is not modal-parked. Drain-eligible REGARDLESS
     *     of the auto-approve mask. This is the case the mask used to hide.
     *   - 'generating' — the raw adapter is genuinely mid-turn. Held (a raw PTY write
     *     into a generating claude-cli is not consumed as a turn → data loss). The
     *     intentional removal of force-inject-into-generating is preserved.
     *   - 'other' — any other raw status (error / starting / waiting_choice handled by
     *     modal-park above). Not a drain target.
     *
     * Uses allowParse:false (engine.activeModal only, side-effect-free) so it never
     * mutates the very auto-approve mask state the diagnostics read.
     */
    getDrainStatus(): 'idle' | 'generating' | 'modal_parked' | 'other' {
        if (this.isModalParked()) return 'modal_parked';
        let rawStatus: string;
        try {
            const raw = this.adapter.getStatus({ allowParse: false })?.status;
            rawStatus = typeof raw === 'string' ? raw.trim() : '';
        } catch {
            return 'other';
        }
        if (rawStatus === 'idle') return 'idle';
        if (isCliGeneratingLikeStatus(rawStatus)) return 'generating';
        return 'other';
    }

    onEvent(event: string, data?: any): void {
        if (event === 'send_message') {
            const input = normalizeInputEnvelope(data);
            assertProviderSupportsDeclaredInput(this.provider, input);
            const promptText = buildCliStructuredInputPrompt(input);
            if (promptText) {
                // force:true bypasses the busy/generating send guard so terminal mesh
                // events (completion/failure/bootstrap) land in a coordinator session that
                // is itself parked in `generating` while awaiting that very event.
                // Without it the message is queued and only flushed on the coordinator's
                // own idle transition — which never happens until it receives the message.
                const force = data?.force === true;
                // Modal guard: a force-inject still writes raw keystrokes into the PTY,
                // bypassing the busy send-guard. If the coordinator is parked on a
                // harness modal (claude-cli AskUserQuestion → waiting_choice, or a
                // tool-consent waiting_approval), those keystrokes are consumed by the
                // modal's key handler and silently select a choice the user never made
                // (data corruption). Hold the force-inject in that narrow window —
                // the event stays queued and the reconcile loop redelivers it on the
                // next tick once the modal is resolved. We ONLY hold for the two modal
                // states; generating is still force-injected (that is the deadlock the
                // force path exists to break — see mesh-events-coordinator).
                if (force && this.isModalParked()) {
                    LOG.info('CLI', `[${this.type}] force send_message held — coordinator parked on modal (${this.resolveModalParkStatus()})`);
                    return;
                }
                void this.adapter.sendMessage(promptText, force ? { force: true } : {}).catch((e: any) => {
                    LOG.warn('CLI', `[${this.type}] send_message failed: ${e?.message || e}`);
                });
            }
        } else if (event === 'server_connected' && data?.serverConn) {
            this.adapter.setServerConn(data.serverConn);
        } else if (event === 'resolve_action' && data) {
            void this.adapter.resolveAction(data).catch((e: any) => {
                LOG.warn('CLI', `[${this.type}] resolve_action failed: ${e?.message || e}`);
            });
        } else if (event === 'interactive_prompt' && data) {
            const prompt = normalizeInteractivePrompt(data);
            if (prompt) {
                this.activeInteractivePrompt = prompt;
                this.events.push({
                    event: 'interactive_prompt',
                    timestamp: Date.now(),
                    promptId: prompt.promptId,
                });
            }
        } else if (event === 'interactive_prompt_response' && data) {
            try {
                // STALE-PROMPT-ANSWER guard (rc.20 rebind option fidelity): an answer
                // naming a promptId OTHER than the currently held prompt is rejected
                // outright — it is NEVER resolved against (or defaulted into) the
                // active prompt's options and NEVER forwarded to the TUI/transport.
                // Post-restart the coordinator can still hold the pre-restart
                // promptId; silently dropping it (the old log-only path) left the
                // session parked, and resolving it anyway could bind an index to the
                // wrong option row. Rejection here is fail-closed: the picker stays
                // parked and the caller is told to re-answer against the active id.
                const heldPromptId = typeof this.activeInteractivePrompt?.promptId === 'string'
                    && this.activeInteractivePrompt.promptId
                    ? this.activeInteractivePrompt.promptId
                    : '';
                const incomingPromptId = typeof (data as { promptId?: unknown })?.promptId === 'string'
                    ? ((data as { promptId: string }).promptId).trim()
                    : '';
                if (heldPromptId && incomingPromptId && incomingPromptId !== heldPromptId) {
                    LOG.warn('CLI', `[${this.type}] interactive_prompt_response REJECTED: stale promptId "${incomingPromptId}" does not match active prompt "${heldPromptId}" — answer not applied (no index/default fallback); re-answer against the active promptId`);
                    return;
                }
                // mesh_answer_question (mission f1d25e11) sends a coordinator-friendly answer
                // form (per-question select by label/index) that must be resolved against the
                // AUTHORITATIVE active prompt held here. When the active prompt is present and
                // the promptId matches, resolve it; otherwise fall back to the strict keyed
                // form (dashboard local answers already send that shape).
                const response = (this.activeInteractivePrompt
                    && this.activeInteractivePrompt.promptId === (data as { promptId?: unknown })?.promptId
                    && Array.isArray((data as { answers?: unknown })?.answers))
                    ? resolveInteractivePromptResponse(this.activeInteractivePrompt, data)
                    : normalizeInteractivePromptResponse(data);
                if (this.activeInteractivePrompt?.promptId === response.promptId) {
                    this.activeInteractivePrompt = null;
                }
                if (typeof this.adapter.setInteractivePromptResponse !== 'function') {
                    LOG.warn('CLI', `[${this.type}] interactive_prompt_response ignored: adapter does not support interactive prompts`);
                    return;
                }
                void this.adapter.setInteractivePromptResponse(response).catch((e: any) => {
                    LOG.warn('CLI', `[${this.type}] interactive_prompt_response failed: ${e?.message || e}`);
                });
            } catch (e: any) {
                LOG.warn('CLI', `[${this.type}] invalid interactive_prompt_response: ${e?.message || e}`);
            }
        } else if (event === 'provider_state_patch' && data && typeof data === 'object') {
            this.applyProviderResponse(data, { phase: 'immediate' });
        }
    }

    recordAcknowledgedUserInput(input: InputEnvelope | string): void {
        const content = typeof input === 'string'
            ? input.trim()
            : buildCliStructuredInputPrompt(input).trim();
        if (!content) return;

        const receivedAt = Date.now();

        // TASKBUBBLE-DUP: collapse a redelivered dispatch to one bubble. A single
        // mesh_send_task can reach this instance as TWO send_chat calls when the
        // first injection is buffered during bootstrap/busy and a retry (dispatch-
        // confirm-timeout requeue, or a reconcile re-dispatch) fires before the
        // outbound queue drains. The previous dedupKey hashed receivedAt, so the
        // two acks produced different keys and BOTH bubbled. Suppress an identical
        // content ack seen within USER_INPUT_ACK_DEDUP_WINDOW_MS; a later resend of
        // the same text (beyond the window) is a genuine new turn and still shows.
        const ackContentKey = shortHash(`${this.instanceId}:${content}`, 24);
        const lastAckAt = this.recentUserInputAcks.get(ackContentKey);
        if (lastAckAt !== undefined && receivedAt - lastAckAt <= USER_INPUT_ACK_DEDUP_WINDOW_MS) {
            // Refresh the timestamp so a steady stream of redeliveries keeps
            // collapsing, and prune stale entries to bound the map size.
            this.recentUserInputAcks.set(ackContentKey, receivedAt);
            this.pruneRecentUserInputAcks(receivedAt);
            return;
        }
        this.recentUserInputAcks.set(ackContentKey, receivedAt);
        this.pruneRecentUserInputAcks(receivedAt);

        this.lastAcknowledgedUserInputAt = receivedAt;
        // The runtimeMessages dedupKey stays per-call unique (includes receivedAt)
        // so a genuine resend of the same text after the window appends a fresh
        // bubble; redelivery within the window is already suppressed above.
        const dedupKey = `user_input_ack:${shortHash(`${this.instanceId}:${content}:${receivedAt}`, 24)}`;
        this.appendRuntimeMessage(buildChatMessage({
            role: 'user',
            senderName: 'User',
            kind: 'standard',
            content,
            receivedAt,
            timestamp: receivedAt,
            source: 'runtime_input_ack',
            meta: {
                runtimeInputAck: true,
                provider: this.type,
                workspace: this.workingDir,
            },
        } as ChatMessage), dedupKey);
    }

    /** Drop user-input ack entries older than the dedup window so the map can't grow unbounded. */
    private pruneRecentUserInputAcks(now: number): void {
        if (this.recentUserInputAcks.size <= 1) return;
        for (const [key, at] of this.recentUserInputAcks) {
            if (now - at > USER_INPUT_ACK_DEDUP_WINDOW_MS) this.recentUserInputAcks.delete(key);
        }
    }

    /**
     * Owner token for this session in the antigravity conversation-claim
     * registry. Keyed on the daemon instance id — the SAME value the session
     * registry stores as this session's `sessionId` (see cli-manager
     * `sessionRegistry.register({ sessionId: cliInstance.instanceId })`) and the
     * read side hands the dispatcher as `instanceId`. Both sides therefore
     * derive the identical `iid:<instanceId>` token, so the claims the
     * dispatcher records under this session are exactly the ones dispose()
     * releases.
     *
     * This must NOT be derived from a spawn timestamp: the instance's
     * `startedAt`, the adapter's `spawnedAtMs`, and the session registry's
     * `spawnedAtMs` are three INDEPENDENT `Date.now()` samples for the one
     * session, so a workspace+spawn-time token computed here would never equal
     * the read side's — the claim isolation then silently collapses and two
     * concurrent antigravity sessions cross-bind each other's conversation .db
     * (coordinator+worker chat crosswire).
     */
    private antigravityClaimOwner(): string {
        return antigravityOwnerToken(this.workingDir, this.startedAt, this.instanceId);
    }

    dispose(): void {
        // Release this session's antigravity conversation claims so the store
        // becomes available again (e.g. a later resume) and the registry doesn't
        // leak entries for dead sessions.
        if (this.type === 'antigravity-cli') {
            const owner = this.antigravityClaimOwner();
            if (owner) releaseAntigravityOwner(owner);
        }
        // Same for kimi's transcript claims (Stage 4): the generalized
        // transcript-claim registry is keyed on the identical iid:<instanceId>
        // owner token, so this session's wire.jsonl claims are released here
        // and a later same-cwd session can claim them immediately instead of
        // waiting on the stale-claim safety net.
        if (this.type === 'kimi') {
            const owner = transcriptClaimOwnerToken(this.instanceId);
            if (owner) releaseTranscriptOwner(owner);
        }
        this.adapter.shutdown();
        this.monitor.reset();
        // Cancel any armed auto-approve timers so a pending settle re-check
        // can't fire resolveModal/detectStatusTransition against a dead adapter.
        if (this.autoApproveSettleTimer) { clearTimeout(this.autoApproveSettleTimer); this.autoApproveSettleTimer = null; }
        if (this.autoApproveBusyTimer) { clearTimeout(this.autoApproveBusyTimer); this.autoApproveBusyTimer = null; }
        this.appliedEffectKeys.clear();
        closeSqliteProbeCache(this.sqliteProbeCache);
    }

    private completedDebounceTimer: NodeJS.Timeout | null = null;
    private completedDebouncePending: CompletedDebouncePending | null = null;
    private lastExternalCompletionProbe: ExternalTranscriptProbe | null = null;
    /** TX-FSM: lazily-created transcript signal normalizer. Fed ONLY by
     *  transcript reads this instance already performs — it adds zero I/O.
     *  Stage 0: its output was a pure shadow observation for the FSM driver.
     *  Stage 1: the instance's own stall/growth-hold judgments consume the
     *  normalized snapshot too (single source of truth). */
    private transcriptSignalSource: TranscriptSignalSource | null = null;
    /** TX-FSM Stage 1: the latest snapshot the source produced (set inside
     *  publishTranscriptSignalObservation). Consumed the same tick by the
     *  stall-path / growth-hold judgments via probeNativeTranscriptSignals —
     *  never treated as fresh across ticks. */
    private lastTranscriptSignalSnapshot: SignalSnapshot | null = null;
    /**
     * The final assistant summary of the last completed turn, cached at
     * completion-emit time. For a native-source provider (antigravity) whose
     * assistant answer lives only in native-history — never in the PTY parse that
     * feeds activeChat.messages — the dashboard's preview / lastMessageRole /
     * completionMarker would otherwise never see the answer and show the session
     * stuck on the user prompt. getState() appends this cached assistant bubble to
     * the status messages when the PTY tail has none, so those fields reflect the
     * real last answer with ZERO per-tick native reads (the native read already ran
     * once at completion). Reset on the next turn's start.
     */
    private lastCompletionSummary: { content: string; receivedAt: number; sourceTimestampMs?: number } | null = null;

    // KIMI-MESH-COMPLETION-EMIT (axis 2, double-emit guard): the (taskId, wall-clock)
    // of the most recent agent:generating_completed this instance emitted, stamped by
    // emitGeneratingCompleted. The pre-cleanup completion flush
    // (flushMeshCompletionBeforeCleanup, driven by cli-manager's exit monitor) reads
    // this to refuse a SECOND completion for a turn whose completion already fired —
    // so a worker that finished cleanly and is simply being auto-cleaned never emits a
    // duplicate. taskId '' covers an ad-hoc (no-task) turn. null = none emitted yet.
    //
    // COMPLETION-WEAK-REARM (fix1): the latch now carries the EVIDENCE STRENGTH of the
    // recorded emit. `weak` mirrors isWeakCompletionEvidence() over the exact event that
    // was pushed (evidenceLevel ∈ {weak,insufficient}, reviewRecommended, or a
    // missing_final_assistant diagnostic — the CANON-C decoupled-immediate emit and the
    // startup-grace fast-collapse synth are the two weak producers). `emittedAtEpoch`
    // snapshots busyEpoch at emit time so the transcript re-emit paths can require a real
    // generating→idle transition (busyEpoch advanced past this) before re-arming — a
    // static idle screen can never re-fire the same weak frame. A weak latch is a
    // ONE-SHOT re-arm: the genuine re-emit overwrites this with weak=false, so a
    // subsequent idle tick hits the non-weak latch and stops (never a third emit).
    private lastEmittedCompletion:
        | { taskId: string; at: number; evidenceLevel?: string; weak: boolean; emittedAtEpoch: number }
        | null = null;

    private async enforceFreshSessionLaunchIfNeeded(): Promise<void> {
        const scriptName = getForcedNewSessionScriptName(this.provider, this.launchMode);
        if (!scriptName) return;

        LOG.info('CLI', `[${this.type}] forcing fresh session launch via script: ${scriptName}`);
        await waitForCliAdapterReady(this.adapter);
        const raw = await this.adapter.invokeScript(scriptName, {});
        const parsed = parseCliScriptResult(raw);
        if (!parsed.success) {
            throw new Error(parsed.payload?.error || `Failed to invoke fresh-session script '${scriptName}'`);
        }

        const cliCommand = getCliScriptCommand(parsed.payload);
        if (cliCommand?.type === 'send_message' && cliCommand.text) {
            await this.adapter.sendMessage(cliCommand.text);
        } else if (cliCommand?.type === 'pty_write' && cliCommand.text) {
            const enterCount = cliCommand.enterCount || 1;
            await this.adapter.writeRaw(cliCommand.text + '\r');
            for (let i = 1; i < enterCount; i += 1) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await this.adapter.writeRaw('\r');
            }
        }

        this.applyProviderResponse(parsed.payload, { phase: 'immediate' });
    }

    /**
     * BRAIN-ROUTING (runtime-control thinking axis): for a provider that selects
     * reasoning effort via a runtime control instead of a launch arg (e.g. hermes
     * `reasoning`), apply the requested initialThinkingLevel after spawn by invoking
     * that control's setScript. The provider names the control via thinkingControlId.
     * The standard level is mapped through thinkingLevelMap first (same as the
     * launch-arg path). Best-effort: any failure logs and never blocks launch.
     */
    private async applyInitialThinkingLevelViaControl(): Promise<void> {
        const level = typeof this.initialThinkingLevel === 'string' ? this.initialThinkingLevel.trim() : '';
        if (!level) return;
        const controlId = (this.provider as any).thinkingControlId;
        if (!controlId) return; // provider uses thinkingLaunchArgs (or has no support)
        const controls: any[] = Array.isArray((this.provider as any).controls) ? (this.provider as any).controls : [];
        const control = controls.find(c => c && c.id === controlId);
        if (!control || !control.setScript) return;
        // Map the standard level to the provider's own vocabulary (unchanged if absent).
        const map = (this.provider as any).thinkingLevelMap as Record<string, string> | undefined;
        const mapped = (map && typeof map[level] === 'string' && map[level].trim()) ? map[level].trim() : level;
        try {
            await waitForCliAdapterReady(this.adapter);
            const raw = await this.adapter.invokeScript(control.setScript, { value: mapped });
            const parsed = parseCliScriptResult(raw);
            if (!parsed.success) {
                LOG.warn('CLI', `[${this.type}] thinking control '${controlId}' set to '${mapped}' failed: ${parsed.payload?.error || 'unknown'}`);
                return;
            }
            const cliCommand = getCliScriptCommand(parsed.payload);
            if (cliCommand?.type === 'send_message' && cliCommand.text) {
                await this.adapter.sendMessage(cliCommand.text);
            } else if (cliCommand?.type === 'pty_write' && cliCommand.text) {
                await this.adapter.writeRaw(cliCommand.text + '\r');
            }
            LOG.info('CLI', `[${this.type}] applied thinking level '${mapped}' via control '${controlId}'`);
        } catch (e: any) {
            LOG.warn('CLI', `[${this.type}] thinking control apply threw: ${e?.message || e}`);
        }
    }

    /** See completion/evidence.ts — pure message-content check (verbatim move). */
    private completionHasFinalAssistantMessage(messages: unknown, turnStartedAt?: number): boolean {
        return evidence.completionHasFinalAssistantMessage(messages, turnStartedAt);
    }

    /**
     * FLOOR-CLASS-TRANSCRIPT-DEFER-CAP: the engine's bounded defer-cap escape
     * probe (registered via adapter.setNativeFinalAssistantProbe). True only when
     * BOTH hold:
     *  (a) this provider's transcript authority profile class is native-source —
     *      its authoritative history is an on-disk transcript (JSONL) that keeps
     *      the final assistant even after it scrolls outside the PTY
     *      live-frame-tail. Class goes through resolveTranscriptAuthorityProfile
     *      ONLY, never the raw flags.
     *  (b) that native transcript holds a final assistant message causally
     *      attributable to the CURRENT turn — completionHasFinalAssistantMessage
     *      anchored on the engine's currentTurnStartedAt, so a PRIOR turn's final
     *      assistant never satisfies the escape.
     * Deliberately does NOT reuse completionFinalAssistantEvidence: its
     * hasAdapterPendingResponse() upper bound is always true while the engine
     * still holds the turn open, which would deadlock the very escape this probe
     * exists to release. Best-effort: any read error ⇒ false (fail closed — the
     * defer cap simply never escapes and the mesh rescue nets own the session).
     */
    private hasFreshNativeFinalAssistantForCurrentTurn(): boolean {
        try {
            if (resolveTranscriptAuthorityProfile(this.provider).class !== 'native-source') return false;
            // Same read probeNativeTranscriptSignals performs — one
            // readExternalCompletionMessages() per call, resolving this session's
            // OWN native-source conversation (providerSessionId / persisted pin /
            // floor claim).
            const messages = this.readExternalCompletionMessages();
            if (!messages) return false;
            const turnStartedAt = typeof (this.adapter as any)?.currentTurnStartedAt === 'number'
                ? (this.adapter as any).currentTurnStartedAt as number
                : undefined;
            return this.completionHasFinalAssistantMessage(messages, turnStartedAt);
        } catch {
            return false; // best-effort: fail closed
        }
    }

    /** See completion/evidence.ts — probe state stays instance-owned. */
    private recordPendingTranscriptProbe(pending: CompletedDebouncePending): ExternalTranscriptProbe | null {
        return evidence.recordPendingTranscriptProbe(this as unknown as EvidenceHost, pending);
    }

    /**
     * The spawned CLI's env overrides (e.g. the mesh coordinator points hermes
     * at a per-coordinator HERMES_HOME so its state.db lives in a tmpdir instead
     * of ~/.hermes). The native-history executor expands `${HERMES_HOME:-~/.hermes}`
     * from this map, so the completion gate MUST pass it through — otherwise the
     * gate reads ~/.hermes, finds no coordinator-session transcript, and
     * false-fires missing_final_assistant on every coordinator turn.
     */
    private spawnedEnvOverrides(): Record<string, string> | undefined {
        const meta = typeof (this.adapter as any)?.getRuntimeMetadata === 'function'
            ? (this.adapter as any).getRuntimeMetadata()
            : undefined;
        const env = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).spawnedEnv : undefined;
        return env && typeof env === 'object' ? env as Record<string, string> : undefined;
    }

    /**
     * See completion/evidence.ts — session-own native-transcript read (verbatim
     * move; KIMI-RC30 manifest opt-in and the ANTIGRAVITY pin/floor recovery
     * provenance live with the module).
     */
    private readExternalCompletionMessages(opts?: { allowManifestNativeSource?: boolean }): unknown[] | null {
        return evidence.readExternalCompletionMessages(this as unknown as EvidenceHost, opts);
    }

    /**
     * TX-FSM: normalize the transcript read that JUST happened into a
     * SignalSnapshot. Stage 0 injected it into the FSM driver as a pure
     * shadow observation (daemon → SpecCliAdapter → FsmDriver); Stage 1
     * additionally caches it (lastTranscriptSignalSnapshot) so the instance's
     * OWN stall/growth-hold judgments consume the SAME normalized snapshot
     * instead of re-running private transcript scans. Fed ONLY by reads this
     * method's caller already performs — it adds zero I/O, so the getState()
     * zero-native-read invariant and the stall-path read cadence are
     * untouched. The source update runs regardless of the adapter hook so a
     * non-spec provider still produces the instance-side snapshot (the FSM
     * injection is simply skipped there). Fail-open end to end — an
     * unresolved transcript or any throw degrades to "no observation", never
     * to a wedge.
     */
    private publishTranscriptSignalObservation(messages: unknown[] | null, error = false): void {
        try {
            if (!this.transcriptSignalSource) {
                this.transcriptSignalSource = new TranscriptSignalSource({
                    label: this.type,
                    // Choke point: class/timing come from the P0 profile
                    // resolver, never from raw predicates or provider names.
                    profile: resolveTranscriptAuthorityProfile(this.provider),
                    turnStartedAt: () => {
                        const t = (this.adapter as any)?.currentTurnStartedAt;
                        if (typeof t === 'number' && Number.isFinite(t)) return t;
                        // Mesh fallback: for an emitsPtyTurnEvents=false worker
                        // (idle→idle collapse) currentTurnStartedAt may never
                        // bind; scope to the task injection instead — the SAME
                        // boundary the stall-path rescue uses, so the signal and
                        // the rescue's payload extraction agree on the turn.
                        return this.meshTaskInjectedAt > 0 ? this.meshTaskInjectedAt : undefined;
                    },
                    // Reuse the exact completion machinery (I1) for the
                    // final_assistant_present signal rather than duplicating
                    // the message scan.
                    finalAssistantPresent: (msgs, ts) => this.completionHasFinalAssistantMessage(msgs, ts),
                    growthQuietMs: MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
                    // TX-FSM Stage 2: the lease bound follows the rollout gate's
                    // (possibly env-overridden) value; the gate's enabled flag is
                    // consulted per judgment, not here.
                    leaseBoundMs: resolveBusyLeaseGate(this.type).boundMs,
                });
            }
            const snapshot = this.transcriptSignalSource.update(
                { messages, probe: this.lastExternalCompletionProbe, error },
            );
            this.lastTranscriptSignalSnapshot = snapshot;
            const adapter = this.adapter as { setSignalObservation?: (snapshot: unknown) => void } | null | undefined;
            if (typeof adapter?.setSignalObservation === 'function') {
                adapter.setSignalObservation(snapshot);
            }
        } catch { /* signal collection must never break the read path */ }
    }

    /**
     * The content of the LAST visible assistant bubble in a message list, or ''
     * when the tail is not an assistant reply. Skips trailing system/tool/activity
     * bubbles; stops (returns '') at the first user/human message. Used only for
     * the dashboard tail-repair cache — a display value, not a completion decision.
     */
    private lastVisibleAssistantSummary(messages: unknown): string {
        return this.lastVisibleAssistantSummaryDetail(messages).content;
    }

    // Like lastVisibleAssistantSummary but also returns the source bubble's own
    // timestamp (ms), so a cached summary can later be turn-scoped: the display
    // cache is populated from an UNSCOPED tail read (it must show the answer as
    // soon as native-history has it), so it can hold a bubble that predates the
    // current turn. Recording the bubble's timestamp lets the weak-completion
    // fallback reject a turn-stale cached summary instead of re-leaking the exact
    // stale bubble the turn-boundary gate already rejected (FALSE-IDLE Defect 1c).
    private lastVisibleAssistantSummaryDetail(messages: unknown): { content: string; timestampMs?: number } {
        if (!Array.isArray(messages)) return { content: '' };
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i] as { role?: string; kind?: string; content?: unknown };
            const role = typeof m?.role === 'string' ? m.role : '';
            const kind = typeof m?.kind === 'string' ? m.kind : '';
            if (role === 'system') continue;
            if (kind === 'tool' || kind === 'activity') continue;
            if (role === 'user' || role === 'human') return { content: '' };
            if (role === 'assistant') {
                return { content: flattenContent(m.content as any).trim(), timestampMs: readChatMessageTimestampMs(m as any) };
            }
            return { content: '' };
        }
        return { content: '' };
    }

    /**
     * NOTIF Defect-B: the final assistant summary this instance ALREADY parsed and
     * cached for the current turn (lastCompletionSummary), if any. The evidence
     * probe (completionFinalAssistantEvidence) is a POINT-SAMPLE: on a native-source
     * provider (antigravity) the parsed screen and the native transcript can both
     * momentarily yield no in-turn final assistant at the exact instant the
     * completion gate fires — source='unavailable', missingEvidence=true — even
     * though a prior poll already read the real answer off native-history and cached
     * it here (the same value mesh_read_chat.summary shows). Consulting the cache at
     * emit time lets that already-secured summary count as evidence, so the completion
     * notification carries the answer instead of completion_diagnostic=missing_final_assistant
     * with an empty summary. Returns '' when the cache is empty or was reset by the
     * next turn (see lastCompletionSummary = null on onTurnStarted).
     */
    private cachedCompletionSummaryContent(): string {
        const cached = this.lastCompletionSummary;
        const content = typeof cached?.content === 'string' ? cached.content.trim() : '';
        return content;
    }

    /** See completion/evidence.ts — FALSE-IDLE Defect 1c turn-scoped cache view. */
    private cachedInTurnCompletionSummaryContent(turnStartedAt?: number): string {
        return evidence.cachedInTurnCompletionSummaryContent(this as unknown as EvidenceHost, turnStartedAt);
    }

    /**
     * See completion/evidence.ts — the finalization gate's evidence probe
     * (verbatim move; FALSEIDLE FixB upper bound, TX-FSM Stage 2.1
     * KIMI-PARSED-RACE, ANTIGRAVITY-PREMATURE-COMPLETION provenance live with
     * the module).
     */
    private completionFinalAssistantEvidence(parsedMessages: unknown, turnStartedAt?: number): CompletionFinalAssistantEvidence {
        return evidence.completionFinalAssistantEvidence(this as unknown as EvidenceHost, parsedMessages, turnStartedAt);
    }

    /**
     * See completion/evidence.ts — the finalSummary provenance chain (verbatim
     * move; native transcript > parsed screen, NOTIF Defect-B / FALSE-IDLE
     * Defect 1b turn-scoping, KIMI-RC30 manifest native-source preference).
     */
    private completionFinalSummary(parsedMessages: unknown, turnStartedAt?: number): string | undefined {
        return evidence.completionFinalSummary(this as unknown as EvidenceHost, parsedMessages, turnStartedAt);
    }

    private buildCompletedFinalizationDiagnostic(args: {
        blockReason: string;
        latestStatus?: any;
        latestVisibleStatus: string;
        waitedMs: number;
        pending: CompletedDebouncePending;
        emittedAfterFinalizationTimeout: boolean;
    }): Record<string, unknown> {
        let parsed: any = null;
        let parseError: string | undefined;
        try {
            parsed = this.adapter.getScriptParsedStatus();
        } catch (error: any) {
            parseError = error?.message || String(error);
        }

        // FALSE-IDLE Defect 1c: turn-scope the diagnostic's evidence probe too. Passing
        // pending.turnStartedAt makes completionHasFinalAssistantMessage reject a stale
        // mid-turn bubble (predating the turn) just as the finalization gate did, so the
        // diagnostic cannot credit finalAssistantPresent (or clear missing_final_assistant)
        // off a bubble the gate already rejected. With no boundary this is unchanged.
        const evidence = this.completionFinalAssistantEvidence(parsed?.messages, args.pending.turnStartedAt);
        if (evidence.source === 'external-native') {
            this.recordPendingTranscriptProbe(args.pending);
        }
        const visibleMessages = (Array.isArray(evidence.messages) ? evidence.messages : [])
            .filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const lastVisibleRole = typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : null;
        const lastVisibleKind = typeof (lastVisible as any)?.kind === 'string' ? (lastVisible as any).kind : null;
        const lastVisibleContentLength = lastVisible ? flattenContent(lastVisible.content).trim().length : 0;

        // NOTIF Defect-B: when the live evidence probe momentarily yields no in-turn
        // final assistant (source='unavailable'/external-native with present=false) but
        // a prior poll already parsed and CACHED the real answer for this turn
        // (lastCompletionSummary — the same value mesh_read_chat.summary surfaces),
        // credit the cache as evidence. This flips finalAssistantPresent to true and
        // records the cached source so the completion notification carries
        // completion_diagnostic=present with the summary, instead of
        // missing_final_assistant with an empty payload. Only ever UPGRADES a
        // point-sample miss — a genuine present=true is unchanged, and an empty cache
        // leaves the missing-evidence diagnostic exactly as before.
        const cachedSummary = evidence.present ? '' : this.cachedInTurnCompletionSummaryContent(args.pending.turnStartedAt);
        const creditedFromCache = !evidence.present && cachedSummary.length > 0;
        const finalAssistantPresent = evidence.present || creditedFromCache;
        const finalAssistantEvidenceSource = evidence.present
            ? evidence.source
            : (creditedFromCache ? 'cached-summary' : evidence.source);
        // When the cached summary rescues the evidence, the turn is no longer
        // "missing final assistant" — clear that blockReason so isMissingFinalAssistant‑
        // Diagnostic()/isWeakCompletionEvidence() no longer flag it (both key off
        // blockReason='missing_final_assistant' independently of finalAssistantPresent)
        // and the coordinator log's formatCompletionMetadata reads
        // completion_diagnostic=present (empty blockReason → 'present'). The ORIGINAL
        // reason is preserved under originalBlockReason for diagnostics.
        const clearMissingBlock = creditedFromCache && args.blockReason === 'missing_final_assistant';
        const effectiveBlockReason = clearMissingBlock ? undefined : args.blockReason;

        return {
            providerType: this.type,
            sessionId: this.instanceId,
            providerSessionId: this.providerSessionId || null,
            workspace: this.workingDir,
            ...(effectiveBlockReason ? { blockReason: effectiveBlockReason } : {}),
            ...(clearMissingBlock ? { originalBlockReason: args.blockReason } : {}),
            emittedAfterFinalizationTimeout: args.emittedAfterFinalizationTimeout,
            waitedMs: args.waitedMs,
            maxWaitMs: COMPLETED_FINALIZATION_MAX_WAIT_MS,
            adapterStatus: typeof args.latestStatus?.status === 'string' ? args.latestStatus.status : null,
            latestVisibleStatus: args.latestVisibleStatus,
            parsedStatus: typeof parsed?.status === 'string' ? parsed.status : (parseError ? 'parse_error' : 'unknown'),
            parseError: parseError || undefined,
            finalAssistantPresent,
            finalAssistantFromCachedSummary: !evidence.present && cachedSummary.length > 0,
            finalAssistantEvidenceSource,
            visibleMessageCount: visibleMessages.length,
            lastVisibleRole,
            lastVisibleKind,
            lastVisibleContentLength,
            pendingStartedAt: this.generatingStartedAt || null,
            pendingFirstObservedAt: args.pending.firstObservedAt,
            pendingTimestamp: args.pending.timestamp,
            pendingDurationSec: args.pending.duration,
            previousBlockReason: args.pending.loggedBlockReason || null,
            transcriptProbeHistory: args.pending.transcriptProbeHistory || [],
        };
    }

    private hasAdapterPendingResponse(): boolean {
        const adapterAny = this.adapter as any;
        if (adapterAny?.isWaitingForResponse === true) return true;
        if (adapterAny?.currentTurnScope) return true;
        try {
            if (typeof this.adapter.isProcessing === 'function' && this.adapter.isProcessing()) return true;
        } catch { /* defensive: status rendering must not fail because of adapter diagnostics */ }
        try {
            const partial = typeof this.adapter.getPartialResponse === 'function'
                ? this.adapter.getPartialResponse()
                : '';
            if (typeof partial === 'string' && partial.trim()) return true;
        } catch { /* defensive: missing partial means no pending response evidence */ }
        return false;
    }

    // (ANTIGRAVITY-30S-CAP-PREMATURE) Discriminator gating the 30s-cap release of an antigravity
    // `holdForTranscript` block. Antigravity's idle verdict is PTY-screen-derived but its assistant
    // answer lands in native-history, which can legitimately lag past COMPLETED_FINALIZATION_MAX_WAIT_MS
    // (30s) on a long turn. The cap releases on elapsed time, not proof-of-idle, so it force-emitted a
    // premature weak completion WHILE THE PTY WAS STILL GENERATING. Returns true when the PTY is still
    // active — i.e. the adapter reports a pending response OR raw PTY output arrived within the last
    // ANTIGRAVITY_HOLD_QUIET_DWELL_MS — meaning the 30s cap must KEEP HOLDING (the turn is not proven
    // over). Returns false when the PTY is genuinely quiescent (no pending response AND no recent
    // output), so a real tool-only turn with no assistant bubble still force-emits a weak completion
    // rather than wedging. The absolute ANTIGRAVITY_HOLD_HARD_CAP_MS bound is enforced at the call site
    // so a runaway PTY that never falls quiet still eventually releases. Fails OPEN (returns false =
    // allow release) when lastOutputAt is unreadable, so the gate can never wedge a session.
    private antigravityHoldPtyStillActive(): boolean {
        if (this.hasAdapterPendingResponse()) return true;
        try {
            const outStatus = this.adapter.getStatus({ allowParse: false }) as any;
            const lastOutputAt = typeof outStatus?.lastOutputAt === 'number' && Number.isFinite(outStatus.lastOutputAt)
                ? outStatus.lastOutputAt as number
                : undefined;
            if (typeof lastOutputAt === 'number') {
                const quietMs = Date.now() - lastOutputAt;
                if (quietMs < ANTIGRAVITY_HOLD_QUIET_DWELL_MS) return true;
            }
        } catch { /* defensive: dwell read is best-effort — fall through to allow release */ }
        return false;
    }

    private shouldSuppressStaleParsedBusyStatus(parsedStatus: any, adapterStatus: any): boolean {
        const parsedRawStatus = typeof parsedStatus?.status === 'string' ? parsedStatus.status.trim() : '';
        const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
        if (!isCliGeneratingLikeStatus(parsedRawStatus)) return false;
        if (adapterRawStatus !== 'idle') return false;
        if (hasNonEmptyCliModalButtons(parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
        if (this.hasAdapterPendingResponse()) return false;
        // Do not suppress when the adapter's raw response buffer is still non-empty.
        // This catches the case where isWaitingForResponse has already flipped to false
        // (so getPartialResponse() returns '') but the provider's native parser still
        // reports generating because it's parsing buffered content. Suppressing the
        // finalization block here would emit a false completion event while the provider
        // session is still actively processing its response stream.
        const adapterAny = this.adapter as any;
        if (typeof adapterAny?.responseBuffer === 'string' && adapterAny.responseBuffer.trim()) return false;
        return true;
    }

    /**
     * A-3/Phase-1 (completion-engine rewrite): thin back-compat delegate. The
     * finalization judgment now lives in completion/completion-engine.ts
     * (evaluateFinalizationBlock). This wrapper keeps the historical private API —
     * the per-incident regression suites drive it directly — and preserves the
     * evidence-stash side effect on `pending` (resolvedFinal*: the TOCTOU-free
     * finalSummary snapshot).
     */
    private getCompletedFinalizationBlock(latestVisibleStatus: string, pending: CompletedDebouncePending): CompletedFinalizationBlock | null {
        const reader = this.buildCompletionSignalReader(pending, latestVisibleStatus);
        const { block, evidencePatch } = evaluateFinalizationBlock(pending, reader, this.completionEnginePolicy());
        this.applyCompletionArmPatch(pending, evidencePatch);
        return block as CompletedFinalizationBlock | null;
    }

    // (FALSEIDLE-a) Positive, structural proof that the latest approval entry was resolved
    // through ADHDev. resolveModal() — driven by auto-approve, dashboard/mesh_approve, and
    // dev-cli-debug alike — advances the engine's lastResolvedEntrySeq to the current
    // approvalEntrySeq. So `lastResolvedEntrySeq >= approvalEntrySeq` (with a real entry,
    // approvalEntrySeq > 0) means the modal we last saw was actually answered. Absence of this
    // evidence after a waiting_approval→idle transition means the idle is suspect: the spec's
    // text-based approval→idle rule false-tripped while the modal is still unresolved.
    // Fails OPEN (returns true) when the seq fields are unavailable, so the gate can never wedge
    // a session on a provider/adapter that does not surface the counters.
    private hasApprovalResolutionEvidence(): boolean {
        try {
            const status = this.adapter.getStatus({ allowParse: false }) as any;
            const entrySeq = typeof status?.approvalEntrySeq === 'number' ? status.approvalEntrySeq : 0;
            if (entrySeq <= 0) return true;
            const resolvedSeq = typeof status?.lastResolvedEntrySeq === 'number' ? status.lastResolvedEntrySeq : undefined;
            if (resolvedSeq === undefined) return true;
            return resolvedSeq >= entrySeq;
        } catch {
            return true;
        }
    }

    // (FALSEIDLE-a) Hold a completion that is the anomalous DIRECT waiting_approval→idle
    // transition with no positive resolution evidence. A genuinely resolved approval routes
    // through resolveModal → setStatus('generating'), so its completion's previousStatus is
    // 'generating' (not 'waiting_approval') and this gate never fires for it. Scoped to
    // delegated mesh/coordinator sessions — whose only modal-resolution path is auto-approve /
    // mesh_approve (both advance lastResolvedEntrySeq) — so an interactive local session, where
    // a human may answer the PTY prompt directly and leave no resolveModal record, is untouched.
    // Non-terminal: the hold is bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS (30s), giving a
    // settling auto-approve time to fire and advance the seq, and guaranteeing no permanent wedge
    // if resolution ever happens via a path that does not record evidence.
    private approvalResolutionFinalizationBlock(pending: CompletedDebouncePending): CompletedFinalizationBlock | null {
        if (pending.previousStatus !== 'waiting_approval') return null;
        const meshContext = !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator);
        if (!meshContext) return null;
        if (this.hasApprovalResolutionEvidence()) return null;
        return { reason: 'approval_resolution_unconfirmed', terminal: false };
    }

    private scheduleCompletedDebounceFlush(delayMs: number): void {
        if (this.completedDebounceTimer) clearTimeout(this.completedDebounceTimer);
        this.completedDebounceTimer = setTimeout(() => this.flushCompletedDebounceIfFinalized(), delayMs);
    }

    // EVTTRACE (observation-only): is this a mesh worker session whose completion
    // events must route to a coordinator? Used purely to gate trace logging so a
    // non-mesh CLI session's completions don't add EvtTrace noise. No decision logic.
    private isMeshWorkerSession(): boolean {
        return !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId
            || this.settings.meshNodeId || this.settings.launchedByCoordinator);
    }

    /**
     * MESH-READ-TERMINAL (feature 2: RAW terminal read). Public read of the
     * CURRENT rendered PTY viewport for the mesh_read_terminal tool, delegating to
     * the adapter's narrow getTerminalScreenSnapshot() (viewport + cursor + size
     * only; no debug buffers / parser state / history; byte-bounded, bottom-tail
     * preserved).
     *
     * Gated on isMeshWorkerSession(): this raw viewport can expose tokens /
     * command args / env / user data, so only a coordinator-spawned worker session
     * is readable. The MCP layer ALSO cross-checks mesh/session/node ownership
     * (isMeshOwnedDelegateSession) — isMeshWorkerSession alone is a broad
     * "delegated" gate, so the two together block cross-mesh access. Returns null
     * for a non-mesh session so the daemon command surfaces a clean refusal.
     */
    getTerminalScreenSnapshot(maxBytes?: number): {
        text: string;
        cursor: { col: number; row: number };
        cols: number;
        rows: number;
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        hash: string;
    } | null {
        if (!this.isMeshWorkerSession()) return null;
        // Defensive: not every CliAdapter implementation exposes the raw-terminal
        // read (the surface is declared optional on CliAdapter). Returning null
        // for an adapter that lacks it surfaces a clean unsupported refusal at
        // the daemon command instead of "getTerminalScreenSnapshot is not a
        // function" — the failure mode that broke mesh_read_terminal on the
        // spec-driven path before SpecCliAdapter implemented it.
        if (typeof this.adapter.getTerminalScreenSnapshot !== 'function') return null;
        return this.adapter.getTerminalScreenSnapshot(maxBytes);
    }

    /**
     * MESH-SEND-KEYS (feature 3: key injection). Public entry for the
     * mesh_send_keys tool, delegating to the adapter's injectKeys() (structured
     * key encoding + atomic write + submit-race recheck + modal fail-closed).
     *
     * Gated on isMeshWorkerSession(): PTY input into a worker is a
     * coordinator-only capability. The MCP layer ALSO cross-checks mesh/session/
     * node ownership (isMeshOwnedDelegateSession) and owns the destructive-key
     * double gate (confirm_destructive + policy) and the audit ledger. Returns a
     * refusal object for a non-mesh session so the daemon command surfaces a clean
     * error (never silently writes to a non-worker PTY).
     */
    async injectKeys(
        items: MeshSendKeyItem[],
        opts: { allowModalOverride?: boolean } = {},
    ): Promise<
        | { ok: true; keys: MeshSendKeyName[]; hasDestructive: boolean; submits: boolean; bytes: number }
        | { ok: false; refused: 'submit_race' | 'actionable_modal' | 'not_mesh_worker' | 'unsupported'; keys: MeshSendKeyName[]; hasDestructive: boolean }
    > {
        if (!this.isMeshWorkerSession()) {
            return { ok: false, refused: 'not_mesh_worker', keys: [], hasDestructive: false };
        }
        // Defensive: injectKeys is optional on CliAdapter. An adapter without it
        // yields a clean 'unsupported' refusal instead of throwing
        // "injectKeys is not a function" — the failure that broke mesh_send_keys
        // on the spec-driven path before SpecCliAdapter implemented it.
        if (typeof this.adapter.injectKeys !== 'function') {
            return { ok: false, refused: 'unsupported', keys: [], hasDestructive: false };
        }
        return this.adapter.injectKeys(items, opts);
    }

    /**
     * MESH-STALL-WATCH (feature 1: STALL detection). Status-agnostic stall
     * watchdog for coordinator-spawned mesh worker sessions. Driven by the
     * ProviderInstanceManager's existing 5s onTick loop (NO new timer) — see
     * ProviderInstanceManager.startTicking. Reuses the adapter's raw-PTY-output
     * clock (lastOutputAt, bumped on every output chunk) as the sole signal: if a
     * live worker's screen has been byte-for-byte unchanged past the turn-scoped
     * threshold (below), fire ONE informational monitor:no_progress event down the
     * existing task_stalled ledger + pendingCoordinatorEvent path.
     *
     * The reported status is read for TWO bounded purposes only — it does NOT
     * suppress the fire (sticky-status blindness would hide a real wedge):
     *   • Fix B (anchor re-arm on turn end): the FSM's completion/idle transition
     *     never touches the stall anchor, so a completed worker that goes idle would
     *     otherwise keep counting from its LAST pre-completion output and false-fire
     *     in the quiet valley right after finishing. We detect the turn-active edge
     *     (hasAdapterPendingResponse()) and, on active → inactive, re-arm the anchor
     *     to `now` so the post-completion idle valley starts a fresh clock.
     *   • Fix C (turn-scoped threshold): while a turn is genuinely in flight the bar
     *     is raised (MESH_WORKER_STALL_TURN_THRESHOLD_MS) to absorb long normal
     *     thinking gaps; outside a turn the tighter idle bound applies. This is a
     *     RAISE, not a skip — a real mid-turn wedge still fires late at the turn bound.
     *
     * Anchoring: the episode arms against the current lastOutputAt; a worker that
     * has emitted nothing yet (lastOutputAt === 0) anchors on this.startedAt (spawn
     * time) so a silent spawn is still caught. Any new output re-arms the anchor
     * and clears the emitted flag, so one continuous stall emits at most once and a
     * later stall re-arms cleanly. Fix E adds a per-session refire cooldown so a
     * dribble of one-byte-per-few-minutes output cannot page the coordinator on
     * every re-arm.
     */
    checkMeshWorkerStall(now: number = Date.now()): void {
        // Private members satisfy MeshStallHost structurally; the cast only
        // bridges TS's nominal privacy check at this single seam.
        runMeshStallTick(this as unknown as MeshStallHost, now);
    }

    /** See completion/mesh-stall-watchdog.ts — episode state stays instance-owned. */
    private resetMeshStallEpisode(): void {
        resetMeshStallEpisode(this as unknown as MeshStallHost);
    }

    /** The result of one native-transcript signal probe: the normalized
     *  snapshot the shared TranscriptSignalSource produced from the read, and
     *  the very messages it was normalized from (so a judgment site can pull
     *  a payload — e.g. the final summary — from the SAME read with zero
     *  added I/O). */
    /**
     * TX-FSM Stage 1 — the single native-transcript signal probe (replaces
     * the Stage-0 sampleNativeTranscriptProgress fingerprint sampler). For a
     * native-source provider (its authoritative history is an on-disk
     * transcript file, e.g. kimi's wire.jsonl), perform the read this
     * judgment point already owns — SAME cadence as before, one
     * readExternalCompletionMessages() per call, never more — and return the
     * NORMALIZED SignalSnapshot the shared TranscriptSignalSource produced
     * from it (publishTranscriptSignalObservation runs inside the read), plus
     * the messages that read returned. Judgment sites (the stall watchdog's
     * transcript-advancing axis, the completion growth-hold, the stall-path
     * completion rescue) consume the snapshot's SIGNALS instead of running
     * their own fingerprint/freshness/final-assistant scans — one source of
     * truth for "what does the transcript say right now".
     *
     * Class gating goes through resolveTranscriptAuthorityProfile ONLY.
     * Returns null for a non-native-source class (nothing to signal from) and
     * a null snapshot when the read threw — callers keep their fail-open
     * fallbacks ("couldn't tell" never blocks an idle verdict and never
     * fabricates a completion). Cheap enough for the stall path: it runs
     * only at the stall threshold (≥180s of PTY stasis) or during an armed
     * completion-debounce retry, never on the routine 5s tick.
     */
    private probeNativeTranscriptSignals(): { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null {
        if (resolveTranscriptAuthorityProfile(this.provider).class !== 'native-source') return null;
        // readExternalCompletionMessages resolves this session's OWN native-source
        // conversation (providerSessionId / persisted pin / floor claim) and, as a
        // side effect, feeds the shared TranscriptSignalSource (which refreshes
        // this.lastTranscriptSignalSnapshot). Reusing it keeps the resolution
        // logic in one place and immune to the antigravity-style session-id quirks.
        let messages: unknown[] | null = null;
        try {
            messages = this.readExternalCompletionMessages();
        } catch {
            return { snapshot: null, messages: null }; // best-effort: fail-open
        }
        return { snapshot: this.lastTranscriptSignalSnapshot, messages };
    }

    /**
     * TX-FSM Stage 2: is the bounded busy lease enabled for THIS provider?
     * This is the canary rollout gate (busy-lease-gate.ts) — a per-provider
     * feature switch, NOT a classification (transcript class/timing still come
     * from resolveTranscriptAuthorityProfile only). Resolved per call so an
     * env-driven rollout change takes effect without rebuilding the instance;
     * any resolver error fails closed (lease disabled → pre-Stage-2 behavior).
     */
    private busyLeaseGateEnabled(): boolean {
        try { return resolveBusyLeaseGate(this.type).enabled; } catch { return false; }
    }

    /**
     * See completion/stall-rescue.ts — pre-cleanup mesh completion flush
     * (verbatim move; KIMI-MESH-COMPLETION-EMIT axis 2 provenance lives with
     * the module). Turn state stays instance-owned.
     */
    flushMeshCompletionBeforeCleanup(): boolean {
        return stallRescue.flushMeshCompletionBeforeCleanup(this as unknown as StallRescueHost);
    }

    /**
     * See completion/stall-rescue.ts — TRANSCRIPT-COMPLETION-STALL-RESCUE
     * (verbatim move; the TX-FSM Stage 1 probe-delegation provenance lives
     * with the module). Consulted by the mesh stall watchdog via MeshStallHost.
     */
    private tryReconcileTranscriptCompletionForStall(
        observedStatus: string,
        transcriptSignals?: { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null,
    ): boolean {
        return stallRescue.tryReconcileTranscriptCompletionForStall(this as unknown as StallRescueHost, observedStatus, transcriptSignals);
    }

    /**
     * AUTOAPPROVE-FLAP-RECUR (Fix A+B): how long a busy blip / modal scroll-out may
     * persist before the in-progress settle gate is torn down. For a delegated
     * worker whose auto-approve episode is genuinely still cycling (mask clock
     * alive), the FSM's full waiting_approval → busy → waiting_approval flap runs
     * on a multi-second period, so the settle continuity window is extended to
     * AUTO_APPROVE_FLAP_CONTINUITY_MS to bridge it (still bounded, and still capped
     * by AUTO_APPROVE_MASK_STALL_MS). Every other case — foreground/attended
     * session, or no active mask episode — keeps the tight default hysteresis so a
     * genuine resolution frees the gate promptly.
     */

    // FALSE-IDLE (self-coordinator settle): an autonomously-progressing mesh session
    // is either a delegated worker (isMeshWorkerSession) OR the coordinator's OWN
    // claude-cli session (meshCoordinatorFor). Both run auto-approved tool turns whose
    // inter-approval valley (busy→idle blip→generating re-entry ~0.5s later) must be
    // absorbed by the completedDebounce settle window, not flushed on the first idle
    // sample. The worker branch already gets NATIVE_HISTORY_MESH_IDLE_SETTLE_MS; the
    // self-coordinator session (worker markers absent, meshCoordinatorFor present) was
    // taking flushDelay=0 — no settle window — so its busyEpoch/lastOutputAt continuity
    // guard had no window to observe the valley and fired mid-turn "next-step" previews
    // as a finalSummary. Mirrors the isAutonomousMeshSession notion in isTransientToolConsent.
    private isAutonomousMeshSession(): boolean {
        return this.isMeshWorkerSession() || !!this.settings.meshCoordinatorFor;
    }

    /**
     * FALSE-IDLE: are we inside the post-approval resume grace window? True when this
     * is an autonomous auto-approving mesh session AND the engine resolved a modal
     * (auto-approve / mesh_approve) within APPROVAL_RESUME_GRACE_MS. This is the single
     * "auto-approve recency" judgment shared by Fix 1 (the SETTLE-VALLEY completion
     * hold below) and Fix 2 (the FSM-level applyIdle hysteresis in cli-state-engine).
     *
     * Scoped to autonomous auto-approving sessions so a foreground/attended session,
     * or a session with auto-approve off (whose approvals a human answers), is never
     * held. The recency clock (adapter.lastApprovalResolvedAt) is 0 until the first
     * resolveModal, so a plain turn that never saw an approval always returns false.
     */
    private inApprovalResumeGrace(now = Date.now()): boolean {
        if (!this.isAutonomousMeshSession() || !this.shouldUsePtyAutoApprove()) return false;
        const resolvedAt = typeof (this.adapter as any)?.lastApprovalResolvedAt === 'number'
            ? (this.adapter as any).lastApprovalResolvedAt as number
            : 0;
        if (resolvedAt <= 0) return false;
        return (now - resolvedAt) < CliProviderInstance.APPROVAL_RESUME_GRACE_MS;
    }

    /**
     * ARCH-REFACTOR R1: the taskId to attribute the CURRENTLY-completing turn to.
     * Prefers the per-turn binding (engine.currentTurnTaskId, set when the turn was
     * submitted and surviving until the next turn starts) over the last-write-wins
     * session scalar (settings.meshActiveTaskId). The scalar is retained only as a
     * backward-compat alias for the "current/last assignment" and is the source of the
     * NOTIF-MISDELIVER / TASK-MSG-MISROUTE race: a second task attaching before this
     * turn completes overwrites it. Returns undefined for a non-task ad-hoc turn.
     */
    private completingTurnTaskId(): string | undefined {
        const turnTaskId = this.adapter?.currentTurnTaskId;
        if (typeof turnTaskId === 'string' && turnTaskId.trim()) return turnTaskId;
        const scalar = this.settings.meshActiveTaskId;
        return typeof scalar === 'string' && scalar.trim() ? scalar : undefined;
    }

    /**
     * ANTIGRAVITY-PREMATURE-COMPLETION gate: has the CURRENTLY-injected task actually
     * entered generating (a real onTurnStarted for it)? Used to reject stale external-
     * native completion evidence that predates the injected task's turn.
     *
     * The injected task's id is the session scalar `meshActiveTaskId`, stamped by
     * attachMeshAssignment BEFORE the PTY turn starts. That stamp also records
     * `meshTaskInjectedAt`. The turn that has genuinely started is marked by
     * `adapter.currentTurnStartedAt` (set ONLY by onTurnStarted). Two naive signals both
     * FAIL for a reused-idle session:
     *  - `currentTurnStartedAt > 0` alone: it persists from the PRIOR turn, so it is
     *    already > 0 the instant a new task is injected (pre-onTurnStarted).
     *  - `currentTurnTaskId === meshActiveTaskId` alone: forceSendMessage (the mesh
     *    inject path) pre-binds currentTurnTaskId to the new taskId at inject time,
     *    BEFORE the turn starts, so this matches prematurely too.
     * The robust discriminator is TEMPORAL: the producing turn must have STARTED AFTER
     * the injection — `currentTurnStartedAt > meshTaskInjectedAt`. Only then has the
     * injected task's own onTurnStarted fired.
     *  - No injected task since boot (meshTaskInjectedAt === 0, e.g. an ad-hoc/dashboard
     *    turn or a non-mesh session): fall back to the plain "a turn has started" check
     *    so non-mesh completion is unaffected.
     * Fails CLOSED for the injected-but-not-started window; open once the injected turn is
     * genuinely underway (preserving the rc.480/481 completion-fires win).
     */
    private injectedTaskHasStartedGenerating(): boolean {
        const turnStartedAt = typeof (this.adapter as any)?.currentTurnStartedAt === 'number'
            ? (this.adapter as any).currentTurnStartedAt as number
            : 0;
        const turnStarted = Number.isFinite(turnStartedAt) && turnStartedAt > 0;
        if (this.meshTaskInjectedAt <= 0) {
            // No mesh task injected since boot — plain "a turn has started" suffices.
            return turnStarted;
        }
        // A task was injected: the producing turn must have STARTED after that injection.
        return turnStarted && turnStartedAt > this.meshTaskInjectedAt;
    }

    // EVTTRACE correlation context for this session's completion lifecycle. taskId is
    // the primary grep anchor; instanceId is the session fallback.
    private meshTraceCtx(event = 'agent:generating_completed'): Record<string, unknown> {
        return {
            // ARCH-REFACTOR R1: trace the per-turn taskId (falling back to the scalar) so
            // EvtTrace anchors on the same id the completion event actually carries.
            taskId: this.completingTurnTaskId(),
            sessionId: this.instanceId,
            nodeId: this.settings.meshNodeId,
            meshId: this.settings.meshNodeFor,
            event,
        };
    }

    // COMPLETION-EARLYNOTIFY instrumentation. A session-keyed FSM-transition +
    // completion-gate snapshot recorded into the shared debug-trace ring buffer
    // (secret-safe, length/role/pattern-name only — never screen or bubble text).
    // Retrieved via getRecentDebugTrace (chat_debug_bundle). Both categories are a
    // no-op unless collectDebugTrace is on AND the category is selected, so the
    // hot-path guards below (completionTraceOn / fsmTraceOn) keep production cost
    // at a single boolean check.
    private completionTraceOn(): boolean {
        return shouldCollectTraceCategory('completion-gate');
    }
    private fsmTraceOn(): boolean {
        return shouldCollectTraceCategory('fsm-transition');
    }
    private recordCompletionGateTrace(stage: string, payload: Record<string, unknown>): void {
        recordDebugTrace({
            category: 'completion-gate',
            stage,
            level: 'debug',
            sessionId: this.instanceId,
            providerType: this.type,
            payload,
        });
    }
    private recordFsmTransitionTrace(payload: Record<string, unknown>): void {
        recordDebugTrace({
            category: 'fsm-transition',
            stage: 'transition',
            level: 'debug',
            sessionId: this.instanceId,
            providerType: this.type,
            payload,
        });
    }

    /** Engine policy — the historical tunables, threaded explicitly so tests can compress time. */
    private completionEnginePolicy(): CompletionPolicy {
        return {
            finalizationRetryMs: COMPLETED_FINALIZATION_RETRY_MS,
            finalizationMaxWaitMs: COMPLETED_FINALIZATION_MAX_WAIT_MS,
            backgroundTaskHoldMaxMs: BACKGROUND_TASK_HOLD_MAX_MS,
            canonCMinElapsedFloorMs: CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS,
            transcriptGrowthQuietMs: MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
            holdClassHardCapMs: ANTIGRAVITY_HOLD_HARD_CAP_MS,
            ptyParsedFinalAssistantQuietDwellMs: PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS,
        };
    }

    /**
     * A-3/Phase-1 (completion-engine rewrite): one memoized signal reader per
     * flush attempt. Memoization guarantees the engine decides against a single
     * coherent sample AND that expensive probes (native transcript reads) run at
     * most once per attempt regardless of how many rules consult them.
     * `visibleStatusOverride` serves the back-compat getCompletedFinalizationBlock
     * delegate, whose historical signature receives the status pre-computed.
     */
    private buildCompletionSignalReader(pending: CompletedDebouncePending, visibleStatusOverride?: string): CompletionSignalReader {
        const memo = new Map<string, unknown>();
        const once = <T,>(key: string, compute: () => T): T => {
            if (!memo.has(key)) memo.set(key, compute());
            return memo.get(key) as T;
        };
        const adapterStatus = () => once('adapterStatus', () => this.adapter.getStatus({ allowParse: false }) as any);
        const rawParsed = () => once('rawParsed', () => {
            try { return { ok: true as const, value: this.adapter.getScriptParsedStatus() as any }; }
            catch (error: any) { return { ok: false as const, error: error?.message || String(error) }; }
        });
        return {
            now: () => Date.now(),
            visibleStatus: () => once('visibleStatus', () => {
                if (typeof visibleStatusOverride === 'string') return visibleStatusOverride;
                const latest = adapterStatus();
                const latestAutoApproveActive = latest?.status === 'waiting_approval' && this.shouldUsePtyAutoApprove();
                return latestAutoApproveActive || this.autoApproveBusy ? 'generating' : String(latest?.status ?? 'unknown');
            }),
            busyEpoch: () => this.busyEpoch,
            lastOutputAt: () => {
                const v = adapterStatus()?.lastOutputAt;
                return typeof v === 'number' && Number.isFinite(v) ? v as number : undefined;
            },
            adapterWaitingForResponse: () => (this.adapter as any)?.isWaitingForResponse === true,
            adapterTurnScopeActive: () => !!(this.adapter as any)?.currentTurnScope,
            adapterAnyPending: () => this.hasAdapterPendingResponse(),
            partialResponsePending: () => {
                const partial = typeof this.adapter.getPartialResponse === 'function'
                    ? this.adapter.getPartialResponse()
                    : '';
                return typeof partial === 'string' && !!partial.trim();
            },
            parsedStatus: () => once('parsedStatus', () => {
                const rp = rawParsed();
                if (!rp.ok) return { ok: false as const, error: rp.error };
                const parsed = rp.value;
                return {
                    ok: true as const,
                    status: typeof parsed?.status === 'string' ? parsed.status : 'unknown',
                    modalActive: !!(parsed?.activeModal || parsed?.modal),
                    messages: parsed?.messages,
                };
            }),
            staleParsedBusySuppressed: () => once('staleParsedBusySuppressed', () => {
                const rp = rawParsed();
                return rp.ok ? this.shouldSuppressStaleParsedBusyStatus(rp.value, adapterStatus()) : false;
            }),
            backgroundTask: () => once('backgroundTask', () => {
                const rp = rawParsed();
                const parsed = rp.ok ? rp.value as { backgroundTaskActive?: boolean; backgroundTaskCount?: number } : undefined;
                return { active: parsed?.backgroundTaskActive === true, count: parsed?.backgroundTaskCount };
            }),
            finalAssistantEvidence: () => once('finalAssistantEvidence', () => {
                const rp = rawParsed();
                const evidence = this.completionFinalAssistantEvidence(rp.ok ? rp.value?.messages : undefined, pending.turnStartedAt);
                LOG.debug('CLI', `[${this.type}] finalAssistantEvidence: present=${evidence.present} source=${evidence.source}`);
                return {
                    present: evidence.present,
                    source: evidence.source as EvidenceSource,
                    messages: Array.isArray(evidence.messages) ? evidence.messages : [],
                };
            }),
            externalNativeTailProbe: () => once('externalNativeTailProbe', () => {
                const probe = this.recordPendingTranscriptProbe(pending);
                if (probe && !pending.loggedTranscriptProbe) {
                    LOG.info('CLI', `[${this.type}] external transcript probe: msgCount=${probe.msgCount} lastRole=${probe.lastRole || 'none'} lastKind=${probe.lastKind || 'none'} contentLen=${probe.contentLen} sourceMtime=${probe.sourceMtimeMs ?? 'unknown'} mtimeAge=${probe.mtimeAgeMs ?? 'unknown'}ms`);
                    pending.loggedTranscriptProbe = true;
                }
                LOG.debug('CLI', `[${this.type}] external-native probe result: lastRole=${probe?.lastRole} contentLen=${probe?.contentLen}`);
                return probe ? { lastRole: probe.lastRole ?? undefined, contentLen: probe.contentLen } : null;
            }),
            transcriptGrowth: () => once('transcriptGrowth', () => {
                let snapshot: SignalSnapshot | null = null;
                try { snapshot = this.probeNativeTranscriptSignals()?.snapshot ?? null; } catch { snapshot = null; }
                if (!snapshot) return null;
                const available = snapshot.available === true;
                return {
                    available,
                    growing: available && (snapshot as any).signals?.transcript_growing === true,
                    msgCount: (snapshot as any).detail?.msgCount as number | undefined,
                    mtimeAgeMs: ((snapshot as any).detail?.ageMs ?? 0) as number,
                };
            }),
            busyLeaseGateEnabled: () => this.busyLeaseGateEnabled(),
            busyLease: () => {
                const lease = this.transcriptSignalSource?.busyLease() ?? null;
                if (!lease) return null;
                return {
                    active: (lease as any).active === true,
                    lastLiveAt: (lease as any).lastLiveAt as number | undefined,
                    expiresAt: (lease as any).expiresAt as number | undefined,
                    remainingMs: (lease as any).remainingMs as number | undefined,
                };
            },
            transcriptAgeMs: () => {
                try {
                    const snapshot = this.lastTranscriptSignalSnapshot;
                    return snapshot?.available === true
                        && typeof (snapshot as any).detail?.ageMs === 'number'
                        && Number.isFinite((snapshot as any).detail.ageMs)
                        ? (snapshot as any).detail.ageMs as number
                        : undefined;
                } catch { return undefined; }
            },
            inApprovalResumeGrace: () => this.inApprovalResumeGrace(),
            hasApprovalResolutionEvidence: () => this.hasApprovalResolutionEvidence(),
            screenTailShowsApprovalPrompt: () => once('screenTailShowsApprovalPrompt', () => {
                try {
                    const screenText = typeof (this.adapter as any).getScreenText === 'function'
                        ? String((this.adapter as any).getScreenText() || '')
                        : '';
                    if (!screenText) return false;
                    const tailLines = screenText.split(/\r?\n/).slice(-16).join('\n');
                    return looksLikeActiveApprovalPromptText(tailLines);
                } catch { return false; }
            }),
            holdClassPtyStillActive: () => this.antigravityHoldPtyStillActive(),
            ownsExternalHistory: () => (this.adapter as any)?.chatMessagesOwnedExternally === true,
            authorityTiming: () => resolveTranscriptAuthorityProfile(this.provider).timing,
            allowMissingAssistantTimeout: () => !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator),
        };
    }

    /** Applies an engine decision's pending-record patch (null clears a field). */
    private applyCompletionArmPatch(pending: CompletedDebouncePending, patch: CompletionArmPatch): void {
        if ('loggedBlockReason' in patch) pending.loggedBlockReason = patch.loggedBlockReason ?? undefined;
        if ('backgroundTaskHoldSince' in patch) pending.backgroundTaskHoldSince = patch.backgroundTaskHoldSince ?? undefined;
        if ('resolvedFinalMessages' in patch) pending.resolvedFinalMessages = (patch.resolvedFinalMessages ?? undefined) as any;
        if ('resolvedFinalEvidenceSource' in patch) pending.resolvedFinalEvidenceSource = (patch.resolvedFinalEvidenceSource ?? undefined) as any;
        if ('resolvedFinalEvidenceObservedAt' in patch) pending.resolvedFinalEvidenceObservedAt = patch.resolvedFinalEvidenceObservedAt ?? undefined;
    }

    /** Human log + mesh trace for a hold decision — messages preserved verbatim per hold id. */
    private logCompletionHold(decision: Extract<CompletionFlushDecision, { kind: 'hold' }>): void {
        if (!decision.firstOfReason) return;
        const t = decision.trace as Record<string, any>;
        switch (decision.reason) {
            case 'background_task_active':
                LOG.info('CLI', `[${this.type}] holding pending completed (background_task_active count=${t.backgroundTaskCount ?? '?'} heldMs=${t.heldMs} max=${BACKGROUND_TASK_HOLD_MAX_MS})`);
                if (this.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `background_task_active heldMs=${t.heldMs}`);
                break;
            case 'native_transcript_advancing':
                LOG.info('CLI', `[${this.type}] holding pending completed (native_transcript_advancing: msgCount=${t.msgCount} mtimeAge=${t.sourceMtimeAgeMs}ms < ${MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS}ms) — transcript still growing, screen-idle verdict not trusted`);
                if (this.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `native_transcript_advancing msgCount=${t.msgCount} mtimeAge=${t.sourceMtimeAgeMs}ms`);
                break;
            case 'busy_lease_active':
                LOG.info('CLI', `[${this.type}] holding pending completed (busy_lease_active: lastLiveAt=${t.leaseLastLiveAt} expiresIn=${t.leaseRemainingMs}ms) — transcript live within the lease bound, screen-idle verdict not trusted`);
                if (this.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `busy_lease_active lastLiveAt=${t.leaseLastLiveAt} expiresIn=${t.leaseRemainingMs}ms`);
                break;
            case 'canon_c_min_elapsed_floor':
                LOG.info('CLI', `[${this.type}] holding CANON-C decoupled emit until min-elapsed floor (waitedMs=${t.waitedMs} floor=${CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS}); no final assistant yet (${t.blockReason})`);
                if (this.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `canon_c_min_elapsed_floor waited=${t.waitedMs}ms`);
                break;
            case 'antigravity_hold_pty_active':
                LOG.info('CLI', `[${this.type}] 30s cap reached but PTY still generating; holding antigravity completion past cap (waitedMs=${t.waitedMs} hardCap=${ANTIGRAVITY_HOLD_HARD_CAP_MS}) (${t.blockReason})`);
                if (this.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `antigravity_hold_pty_active waited=${t.waitedMs}ms`);
                break;
            default:
                LOG.info('CLI', `[${this.type}] waiting to emit completed until transcript finalizes (${decision.reason})`);
                if (this.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `${decision.reason} waited=${t.waitedMs}ms`);
                break;
        }
    }

    /**
     * A-3/Phase-1 (completion-engine rewrite): the flush is now an INTERPRETER.
     * decideCompletionFlush (completion/completion-engine.ts) owns the WHETHER/WHEN
     * judgment — cancels, every hold class and its bound, the weak/genuine emit
     * split — as one pure, ordered rule pipeline. This method only translates the
     * returned decision into effects: logging/tracing, the pending-record patch,
     * retry scheduling, and the single emit call. Rule semantics and their
     * provenance (FALSE-IDLE / CANON-C / SETTLE-VALLEY / TX-FSM / …) are documented
     * on the engine; do not re-inline judgment here.
     */
    private flushCompletedDebounceIfFinalized(): void {
        const pending = this.completedDebouncePending;
        if (!pending) {
            this.completedDebounceTimer = null;
            return;
        }

        const reader = this.buildCompletionSignalReader(pending);
        const policy = this.completionEnginePolicy();
        const latestVisibleStatus = reader.visibleStatus();
        const pre = decideCompletionPreflight(pending, reader, policy);
        let decision: CompletionFlushDecision;
        if (pre.kind !== 'proceed') {
            decision = pre;
        } else {
            this.applyCompletionArmPatch(pending, pre.armPatch);
            // Historical seam: the finalization block is obtained through the instance
            // method (not the engine directly) so the per-incident regression suites can
            // pin it. The delegate also applies the evidence-stash patch to `pending`.
            const block = this.getCompletedFinalizationBlock(latestVisibleStatus, pending);
            decision = decideCompletionVerdict(pending, reader, policy, block);
        }
        LOG.debug('CLI', `[${this.type}] flush attempt: latestVisible=${latestVisibleStatus} decision=${decision.kind} generatingStartedAt=${this.generatingStartedAt}`);

        if (decision.kind === 'cancel') {
            const label = decision.reason === 'resumed_status'
                ? `resumed ${latestVisibleStatus}`
                : decision.reason === 'busy_reentry'
                    ? `busy re-entry during settle: epoch ${pending.busyEpochAtArm}→${this.busyEpoch}`
                    : `new PTY output during settle: ${pending.lastOutputAtArm}→${(decision.trace as any).lastOutputAt}`;
            LOG.info('CLI', `[${this.type}] cancelled pending completed (${label})`);
            if (this.completionTraceOn()) this.recordCompletionGateTrace('cancel', { blockReason: decision.reason, ...decision.trace });
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            return;
        }

        this.applyCompletionArmPatch(pending, decision.armPatch);

        if (decision.kind === 'hold') {
            this.logCompletionHold(decision);
            if (this.completionTraceOn()) this.recordCompletionGateTrace('hold', {
                blockReason: (decision.trace as any).blockReason ?? decision.reason,
                ...decision.trace,
            });
            this.scheduleCompletedDebounceFlush(decision.retryInMs);
            return;
        }

        if (decision.kind === 'emit-weak') {
            const blockReason = decision.block.reason;
            const waitedMs = decision.waitedMs;
            const emittedAfterFinalizationTimeout = decision.emittedAfterFinalizationTimeout;
            const latestStatus = this.adapter.getStatus({ allowParse: false });
            const completionDiagnostic = this.buildCompletedFinalizationDiagnostic({
                blockReason,
                latestStatus,
                latestVisibleStatus,
                waitedMs,
                pending,
                emittedAfterFinalizationTimeout,
            });
            // Surface the CANON-C immediate-emit path distinctly so a delegated worker's idle
            // notification (transcript still pending) is not mistaken for a 30s-timeout fallback.
            (completionDiagnostic as Record<string, unknown>).decoupledImmediateEmit = decision.decoupledImmediateEmit;
            LOG.warn('CLI', `[${this.type}] emitting completed event (${decision.decoupledImmediateEmit ? 'CANON-C decoupled-immediate, transcript pending' : `after ${waitedMs}ms`}) without finalized assistant turn (${blockReason})`);
            if (this.isMeshWorkerSession()) {
                traceMeshEventStage('fired', this.meshTraceCtx(), `forced after ${waitedMs}ms (${blockReason})`);
            }
            if (this.completionTraceOn()) this.recordCompletionGateTrace('fire', {
                path: decision.decoupledImmediateEmit ? 'canon_c_decoupled' : 'forced_timeout',
                blockReason,
                latestVisibleStatus,
                approvalResolvedIdle: pending.previousStatus === 'waiting_approval',
                finalAssistantPresent: (completionDiagnostic as any).finalAssistantPresent === true,
                evidenceSource: (completionDiagnostic as any).finalAssistantEvidenceSource ?? null,
                lastVisibleRole: (completionDiagnostic as any).lastVisibleRole ?? null,
                lastVisibleContentLen: (completionDiagnostic as any).lastVisibleContentLength ?? null,
                emittedAfterFinalizationTimeout,
                waitedMs,
                busyEpoch: this.busyEpoch,
            });
            this.emitGeneratingCompleted({
                chatTitle: pending.chatTitle,
                duration: pending.duration,
                timestamp: pending.timestamp,
                taskId: pending.taskId,
                // finalSummary provenance chain unchanged (see snapshotExternalNativeCompletionSummary /
                // completionFinalSummary / cachedInTurnCompletionSummaryContent docs above).
                finalSummary: (this.snapshotExternalNativeCompletionSummary(pending)
                    || this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages, pending.turnStartedAt)
                    || this.cachedInTurnCompletionSummaryContent(pending.turnStartedAt)
                    || (blockReason.startsWith('parsed_status:') ? '' : undefined)),
                completionDiagnostic,
            });
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            this.generatingStartedAt = 0;
            this.lastApprovalEventFingerprint = '';
            this.markCurrentTurnStartupGraceCollapseSatisfied();
            return;
        }

        // emit-genuine: the clean path — transcript finalized, evidence stashed on pending.
        LOG.info('CLI', `[${this.type}] completed in ${pending.duration}s`);
        if (this.isMeshWorkerSession()) {
            traceMeshEventStage('fired', this.meshTraceCtx(), `duration=${pending.duration}s`);
        }
        if (this.completionTraceOn()) this.recordCompletionGateTrace('fire', {
            path: 'clean',
            latestVisibleStatus,
            approvalResolvedIdle: pending.previousStatus === 'waiting_approval',
            finalAssistantPresent: true,
            duration: pending.duration,
            busyEpoch: this.busyEpoch,
        });
        const finalSummary = this.cleanCompletionFinalSummary(pending);
        const transcriptProfile = resolveTranscriptAuthorityProfile(this.provider);
        const finalContentLength = typeof finalSummary === 'string' ? finalSummary.trim().length : 0;
        this.emitGeneratingCompleted({
            chatTitle: pending.chatTitle,
            duration: pending.duration,
            timestamp: pending.timestamp,
            taskId: pending.taskId,
            finalSummary,
            evidenceLevel: 'transcript',
            completionDiagnostic: {
                source: 'clean_final_assistant',
                cleanPath: true,
                evidenceWeak: false,
                finalAssistantPresent: true,
                finalAssistantEvidenceSource: pending.resolvedFinalEvidenceSource ?? 'parsed',
                finalAssistantContentLength: finalContentLength,
                transcriptEvidence: {
                    version: 1,
                    kind: 'final_assistant',
                    cleanPath: true,
                    weak: false,
                    authorityClass: transcriptProfile.class,
                    timing: transcriptProfile.timing,
                    providerOwnsTranscript: transcriptProfile.providerOwnsTranscript,
                    observedAt: pending.resolvedFinalEvidenceObservedAt ?? Date.now(),
                    turnStartedAt: pending.turnStartedAt ?? null,
                    finalContentLength,
                    taskId: pending.taskId ?? null,
                    attemptId: typeof this.settings.meshActiveAttemptId === 'string'
                        ? this.settings.meshActiveAttemptId : null,
                    dispatchNonce: typeof this.settings.meshActiveDispatchNonce === 'number'
                        ? this.settings.meshActiveDispatchNonce : null,
                    sessionId: this.instanceId,
                },
            },
        });
        this.completedDebouncePending = null;
        this.completedDebounceTimer = null;
        this.generatingStartedAt = 0;
        this.lastApprovalEventFingerprint = '';
        this.markCurrentTurnStartupGraceCollapseSatisfied();
    }

    /**
     * COMPLETED-TURN GUARD for the startup-grace collapse synth (the standalone
     * status generating-reflash). A genuine completion was just emitted for the
     * current turn on the normal flush path, which also resets
     * generatingStartedAt to 0. adapter.currentTurnTaskId PERSISTS past
     * completion, so without this stamp the NEXT idle-stayed poll inside the
     * 12s startup-grace window satisfies every fastCollapsed predicate in
     * maybeSynthesizeStartupGraceCollapse (turn bound, nothing pending,
     * generating "never armed" — the arm was consumed by the genuine
     * completion) and re-synthesizes a back-to-back WEAK
     * agent:generating_started + agent:generating_completed pair for an
     * ALREADY-COMPLETED turn: one ~120-130ms surface generating blip. Stamping
     * the turn closes the once-per-turn guard for it, while leaving the rescue
     * intact for a turn that truly completed WITHOUT ever arming generating —
     * that turn's currentTurnTaskId differs, so its synth still fires.
     */
    private markCurrentTurnStartupGraceCollapseSatisfied(): void {
        const turnTaskId = typeof (this.adapter as any)?.currentTurnTaskId === 'string'
            && (this.adapter as any).currentTurnTaskId.trim()
            ? (this.adapter as any).currentTurnTaskId as string
            : null;
        if (turnTaskId) this.fastCollapseSynthesizedTaskId = turnTaskId;
    }

    /** See completion/evidence.ts — EMPTY-FINAL-CONTENT TOCTOU snapshot preference. */
    private cleanCompletionFinalSummary(pending: CompletedDebouncePending): string | undefined {
        return evidence.cleanCompletionFinalSummary(this as unknown as EvidenceHost, pending);
    }

    /** See completion/evidence.ts — KIMI-RC30 forced-emit native snapshot seed. */
    private snapshotExternalNativeCompletionSummary(pending: CompletedDebouncePending): string | undefined {
        return evidence.snapshotExternalNativeCompletionSummary(pending);
    }

    /**
     * A-3 (CLI 완료판정 통합): single authoritative emit for a CLI turn's
     * `agent:generating_completed` event. The completion JUDGMENT — WHETHER and
     * WHEN a turn is done (settle windows, continuity guards, the finalization
     * gate, the short-gen / startup-grace / no-progress-monitor discriminators) —
     * stays at each call site, where it is legitimately path-specific. What used
     * to be duplicated across all five completion paths was the EVENT-SHAPE
     * assembly: the `event` name, the conditional `taskId` spread, and the
     * optional `finalSummary` / `evidenceLevel` / `completionDiagnostic` fields.
     * Folding that assembly here removes the divergence (e.g. one site spreading
     * taskId, others omitting it) without touching any judgment. Callers pass the
     * values they have already computed; omitted optionals are simply absent from
     * the emitted event, exactly as each inline builder produced before.
     */
    private emitGeneratingCompleted(opts: {
        chatTitle: string;
        duration: number | undefined;
        timestamp: number;
        taskId?: string;
        finalSummary?: string;
        evidenceLevel?: string;
        completionDiagnostic?: Record<string, unknown>;
    }): void {
        // Cache the final assistant summary so the dashboard snapshot can surface it
        // for native-source providers whose assistant answer is absent from the PTY
        // parse (antigravity). completionFinalSummary already read native-history to
        // produce this, so nothing extra is read here.
        const summary = typeof opts.finalSummary === 'string' ? opts.finalSummary.trim() : '';
        if (summary) {
            this.lastCompletionSummary = { content: summary, receivedAt: opts.timestamp };
        }
        const completionEvent = {
            event: 'agent:generating_completed' as const,
            chatTitle: opts.chatTitle,
            duration: opts.duration,
            timestamp: opts.timestamp,
            // ARCH-REFACTOR R1: attribute to the turn captured at idle-transition.
            ...(opts.taskId ? { taskId: opts.taskId } : {}),
            // finalSummary is always carried (value may be undefined) — every prior
            // inline builder included the key, so downstream consumers see the same shape.
            finalSummary: opts.finalSummary,
            ...(opts.evidenceLevel !== undefined ? { evidenceLevel: opts.evidenceLevel } : {}),
            ...(opts.completionDiagnostic !== undefined ? { completionDiagnostic: opts.completionDiagnostic } : {}),
        };
        // KIMI-MESH-COMPLETION-EMIT (axis 2, double-emit guard): record that THIS turn's
        // completion has now been emitted, keyed by its taskId, so the pre-cleanup
        // completion flush never fires a duplicate for the same turn.
        //
        // COMPLETION-WEAK-REARM (fix1): stamp the emit's evidence STRENGTH so the three
        // transcript re-emit guards can distinguish a weak first emit (which must be
        // re-armable once a genuine idle lands) from a genuine one (single-shot). The
        // weakness is read from the exact event being pushed — evidenceLevel plus the
        // completionDiagnostic (missing_final_assistant blockReason) — via the same
        // isWeakCompletionEvidence() the coordinator/ledger paths share, so the worker's
        // notion of "weak" cannot drift from theirs. emittedAtEpoch snapshots busyEpoch so
        // a re-arm requires a real generating→idle transition after this emit.
        this.lastEmittedCompletion = {
            taskId: typeof opts.taskId === 'string' ? opts.taskId : '',
            at: Date.now(),
            evidenceLevel: opts.evidenceLevel,
            weak: isWeakCompletionEvidence(completionEvent as Record<string, unknown>),
            emittedAtEpoch: this.busyEpoch,
        };
        this.pushEvent(completionEvent);
        // COORDINATOR-SILENT-IDLE one-shot consume: this completion's snapshot rides the
        // armed mute (resolveMuted honors settings.silentNextIdlePush for the idle status
        // above), so the routine idle push is suppressed for THIS completion only. Clear
        // the arm now — AFTER the completion event was pushed — so the NEXT turn notifies
        // normally. Redundant with the TTL leak-guard, but the deterministic clear is the
        // primary one-shot mechanism; the TTL only covers a worker that never completes.
        if (this.settings?.silentNextIdlePush === true) {
            this.updateSettings({ silentNextIdlePush: undefined, silentNextIdlePushArmedAt: undefined });
        }
    }

    /**
     * COMPLETION-WEAK-REARM (fix1): the double-emit guard shared by the transcript
     * re-emit paths (flushMeshCompletionBeforeCleanup,
     * tryReconcileTranscriptCompletionForStall). Returns true when a re-emit for `taskId`
     * must be SUPPRESSED because this turn's completion already fired with strong evidence.
     *
     * The defect this replaces: the old guard short-circuited on ANY prior emit for the
     * taskId, regardless of its evidence. After a WEAK completion (CANON-C decoupled-immediate
     * missing_final_assistant, or a startup-grace fast-collapse synth), the same session
     * reaching a GENUINE idle later (final assistant present) was silently swallowed — the
     * worker never emitted the genuine completion and the coordinator held on the acked-death
     * deadline (8 min).
     *
     * New behavior:
     *   • no latch / taskId mismatch → NOT suppressed (the caller's own evidence gate runs).
     *   • prior emit was GENUINE (not weak) → SUPPRESSED (single-shot; a clean completion is
     *     never re-emitted).
     *   • prior emit was WEAK → re-arm ONE-SHOT, but only across a real generating→idle
     *     transition: require busyEpoch to have advanced past the weak emit's epoch, so a
     *     static idle screen cannot re-fire the same weak frame. The genuine re-emit passes
     *     evidenceLevel:'transcript' (non-weak), overwriting the latch → any subsequent idle
     *     tick hits the now-genuine latch and is suppressed. Never a third emit.
     */
    private shouldSuppressCompletionReEmit(taskId: string | undefined): boolean {
        const latch = this.lastEmittedCompletion;
        if (!latch || latch.taskId !== (taskId ?? '')) return false;
        // Prior emit was genuine → single-shot, never re-emit.
        if (!latch.weak) return true;
        // Prior emit was weak → allow the genuine re-emit ONLY once a real generating phase
        // opened after the weak emit (busyEpoch advanced). Otherwise a static idle frame would
        // re-fire the same weak completion. Bounded to a single re-arm by the latch overwrite
        // the genuine re-emit performs (weak=false), so the next tick is suppressed above.
        if (this.busyEpoch <= latch.emittedAtEpoch) return true;
        return false;
    }

    /**
     * TERMINAL-STALE-APPROVAL (provider side): true once a GENUINE (non-weak) completion
     * has been emitted for the CURRENT busy epoch — the turn is over and no new generating
     * phase has opened since the emit (busyEpoch has not advanced past the latch). A stale
     * cached/sticky modal frame must not re-synthesize waiting_approval for such an
     * already-completed turn. A weak/false-idle emit does NOT count (the turn may
     * genuinely still be in flight), and any new busy phase (busyEpoch advanced past the
     * emit) re-enables approval surfacing for the new turn.
     */
    private hasEmittedGenuineCompletionForCurrentEpoch(): boolean {
        const latch = this.lastEmittedCompletion;
        if (!latch || latch.weak) return false;
        return this.busyEpoch <= latch.emittedAtEpoch;
    }

    /**
     * AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval projection — see
     * completion/approval-gate.ts (verbatim move; sticky state stays
     * instance-owned for the suites).
     */
    private stabilizeFlappingApprovalStatus(adapterStatus: any, now = Date.now()): any {
        return approvalGate.stabilizeFlappingApprovalStatus(this as unknown as ApprovalGateHost, adapterStatus, now);
    }

    /**
     * PTY auto-approve decision for one status frame — the settle/hysteresis/
     * flap-continuity/mask-stall machinery lives in completion/approval-gate.ts
     * (verbatim move; episode state stays instance-owned for the suites).
     */
    private maybeAutoApproveStatus(adapterStatus: any, now = Date.now()): boolean {
        return approvalGate.maybeAutoApproveStatus(this as unknown as ApprovalGateHost, adapterStatus, now);
    }

    /**
     * Re-drive the auto-approve check after the settle quiet window elapses.
     * APPROVAL Defect-C: re-probe with a LIVE parse (allowParse:true) — the
     * cached engine snapshot can hold a null/stale modal for a between-writes
     * arrival, which made this recheck a silent no-op and stranded quiet
     * approvals. Stays on the instance (not the gate module) so the timer path
     * dispatches through instance-level overrides, exactly as before the move.
     */
    private recheckAutoApproveSettled(): void {
        try {
            const adapterStatus = this.adapter.getStatus({ allowParse: true });
            this.maybeAutoApproveStatus(adapterStatus, Date.now());
        } catch { /* adapter gone / transient — next frame retries */ }
    }

    /**
     * Emit the queue-claim agent:ready event at most once per session. Both the
     * boot-time starting→idle one-shot and the fsmReadySeen re-arm call this; the
     * agentReadyEmitted guard ensures the second caller is a no-op so a worker is
     * never claimed twice and a queued task is never double-dispatched.
     */
    private emitAgentReadyOnce(chatTitle: string, now: number): void {
        if (this.agentReadyEmitted) return;
        this.agentReadyEmitted = true;
        this.pushEvent({ event: 'agent:ready', chatTitle, timestamp: now });
    }

    /**
     * See completion/stall-rescue.ts — startup-grace fast-collapse synth
     * (verbatim move; GENERATING-BOUNDARY R4b/R4c, AGY-BOOT-PHANTOM hold-class
     * and EARLYNOTIFY-GATEBYPASS (c) provenance live with the module). The
     * once-per-turn guard state (fastCollapseSynthesizedTaskId) stays
     * instance-owned, incl. the markCurrentTurnStartupGraceCollapseSatisfied
     * stamp below.
     */
    private maybeSynthesizeStartupGraceCollapse(
        chatTitle: string,
        now: number,
        reason: 'startup_grace_fast_collapse' | 'startup_grace_idle_turn_collapse',
    ): boolean {
        return stallRescue.maybeSynthesizeStartupGraceCollapse(this as unknown as StallRescueHost, chatTitle, now, reason);
    }

    private detectStatusTransition(): void {
        const now = Date.now();
        // Status-change handling is a hot path: PTY output can fire it many times
        // during long-running CLI sessions. Keep this path on adapter-owned light
        // state only; rich provider parsing is reserved for getState/read_chat.
        // AUTOAPPROVE-FLAP-INBOX-MISSING: stabilize a flap-prone approval BEFORE it feeds
        // maybeAutoApproveStatus / newStatus / the waiting_approval emission branch below,
        // so a momentary busy blip during the flap re-presents the cached modal + status
        // rather than emitting generating (which would corrupt the inbox and tear down the
        // settle gate). No-op for non-mesh/foreground/non-approval frames.
        const adapterStatus = this.stabilizeFlappingApprovalStatus(this.adapter.getStatus({ allowParse: false }), now);
        const adapterProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof adapterStatus?.providerSessionId === 'string' ? adapterStatus.providerSessionId : '',
        );
        if (adapterProviderSessionId) {
            this.promoteProviderSessionId(adapterProviderSessionId);
        }
        const parsedStatus = null;
        const rawStatus = adapterStatus.status;
        // ASKUSERQUESTION-NOT-APPROVAL (rc.19 live defect): an AskUserQuestion
        // picker is a modal the claude FSM reports with status 'approval'
        // (statusForState maps ANY modal state to 'approval'), carrying
        // kind='picker'. Left as waiting_approval it emits agent:waiting_approval
        // and lands in the mesh_approve inbox, which cannot answer a multi-choice
        // question (the live rc.19 misroute: mesh_approve "approved" Continue).
        // When the prompt for it was captured (activeInteractivePrompt — the same
        // signal getState() overlays as waiting_choice), this is a QUESTION, not a
        // consent: classify it waiting_choice at the authoritative transition layer
        // so the interactive-prompt arm below emits agent:waiting_choice (promptId +
        // structured options → mesh_answer_question) and the approval arm never
        // fires. A genuine consent modal (kind 'approval' or a kind-less modal from
        // a legacy adapter) keeps waiting_approval even while a prompt is held —
        // approval wins and the two stay mutually exclusive, unchanged. A
        // modal-less waiting_approval frame (FSM approval_resolving right after an
        // answer, while the prompt is still held) also reads as the question — it
        // is the picker draining, not a fresh consent.
        const interactivePrompt = adapterStatus.activeInteractivePrompt ?? null;
        const activeModal = adapterStatus.activeModal ?? null;
        const activeModalKind = activeModal && typeof activeModal.kind === 'string'
            ? activeModal.kind
            : null;
        const isQuestionPicker = rawStatus === 'waiting_approval'
            && !!interactivePrompt
            && (!activeModal || activeModalKind === 'picker');
        const autoApproveActive = this.maybeAutoApproveStatus(adapterStatus, now);
        // During the autoApproveBusy window (2s after firing approval key), the PTY
        // can briefly report 'idle' before the next generating phase starts. Treat that
        // transient idle as 'generating' to suppress a spurious agent:generating_completed
        // push notification. The adapter's status is otherwise authoritative — native
        // transcript shape does NOT override the FSM's busy/idle decision.
        const autoApproveHoldIdle = this.autoApproveBusy && rawStatus === 'idle';
        const newStatus = isQuestionPicker
            ? 'waiting_choice'
            : autoApproveActive || autoApproveHoldIdle ? 'generating' : rawStatus;
        const dirName = workingDirBasename(this.workingDir);
        const chatTitle = `${this.provider.name} · ${dirName}`;
        const partial = this.adapter.getPartialResponse();
        // Liveness fingerprint for the no-progress watchdog. The parsed
        // assistant buffer (`partial`) alone goes static while a tool/build runs
        // — the assistant emits no tokens even though the PTY is actively
        // printing tool output — which made the watchdog false-fire a "stuck"
        // alert mid-turn. Fold in the adapter's raw-activity timestamps so any
        // visible terminal progress (lastScreenChangeAt) or raw PTY byte
        // (lastOutputAt) keeps the fingerprint moving. The watchdog then only
        // survives a genuine stall where nothing at all is happening.
        const progressFingerprint = newStatus === 'generating'
            ? `${`${partial || ''}`.slice(-2000)}::scr=${adapterStatus.lastScreenChangeAt ?? 0}::out=${adapterStatus.lastOutputAt ?? 0}`
            : undefined;

        const previousStatus = this.lastStatus;
        if (newStatus !== this.lastStatus) {
            LOG.info('CLI', `[${this.type}] status: ${this.lastStatus} → ${newStatus}`);
            // COMPLETION-EARLYNOTIFY: snapshot every FSM status transition (the arm/fire/cancel
            // decisions downstream all hang off these edges). Guarded so production pays only a
            // boolean check; payload carries the visibility/auto-approve flags and the continuity
            // clocks (busyEpoch / lastOutputAt / lastScreenChangeAt) that the completion gate reads.
            if (this.fsmTraceOn()) this.recordFsmTransitionTrace({
                from: this.lastStatus,
                to: newStatus,
                rawStatus,
                autoApproveActive,
                autoApproveHoldIdle,
                autoApproveBusy: this.autoApproveBusy,
                hasPending: this.hasAdapterPendingResponse(),
                busyEpoch: this.busyEpoch,
                lastOutputAt: typeof adapterStatus?.lastOutputAt === 'number' ? adapterStatus.lastOutputAt : null,
                lastScreenChangeAt: typeof adapterStatus?.lastScreenChangeAt === 'number' ? adapterStatus.lastScreenChangeAt : null,
            });
            // GENERATING-MISSING (win32 fresh-worktree first-turn): a freshly-launched session
            // is in 'starting' until its startup-grace settles to idle. When the FIRST inject
            // lands inside that grace window, the adapter can report status DIRECTLY
            // starting → generating without an intervening 'idle' frame for
            // detectStatusTransition() to observe. Previously only the idle→generating arm
            // armed the bookkeeping, so a starting→generating frame fell straight through to the
            // bare `this.lastStatus = newStatus` update: generatingStartedAt stayed 0 and no
            // generating_started was queued. The fast turn's generating→idle completion was then
            // suppressed by the startup-blip guard below (generatingStartedAt===0 &&
            // !generatingDebouncePending) — so NO generating_started AND NO generating_completed
            // ever fired and the mesh coordinator never learned the worker went idle.
            //
            // We extend the idle→generating arm to also fire on starting→generating, BUT ONLY
            // when a real turn is in flight. The adapter script can also report 'generating' from
            // pure startup PTY noise (no task dispatched) — antigravity/codex/hermes-cli all
            // exercise that benign starting→generating→idle blip, which must NOT emit a
            // completion (see "startup-phase spurious completion suppression" tests).
            // hasAdapterPendingResponse() is the discriminator: a genuine inject sets the
            // adapter's isWaitingForResponse / currentTurnScope (or leaves a partial response),
            // whereas startup repaint noise leaves all of them empty. So an armed
            // starting→generating means "the worker actually started its first turn", and a
            // bare one stays a suppressed blip via the existing fall-through.
            const startingToGeneratingWithActiveTurn = this.lastStatus === 'starting'
                && newStatus === 'generating'
                && this.hasAdapterPendingResponse();
            if (((this.lastStatus === 'idle' && newStatus === 'generating') || startingToGeneratingWithActiveTurn)) {
                // If a completion event is already pending and the turn has ended
                // (generatingStartedAt===0), the PTY is painting its prompt area
                // after completing. Ignore this blip — do not cancel the pending
                // completion and do not advance lastStatus to generating. (On a true
                // starting→generating the session is fresh: completedDebouncePending is
                // null, so this blip guard is a no-op and we arm normally below.)
                if (this.completedDebouncePending && this.generatingStartedAt === 0) {
                    LOG.debug('CLI', `[${this.type}] ignoring post-completion PTY generating blip (generatingStartedAt=0)`);
                    return;
                }
                this.suppressIdleHistoryReplay = false;
                // Cancel any pending completed event (multi-step: idle→generating resume)
                if (this.completedDebouncePending) {
                    LOG.info('CLI', `[${this.type}] cancelled pending completed (resumed generating) generatingStartedAt=${this.generatingStartedAt} isWaitingForResponse=${!!(this.adapter as any)?.isWaitingForResponse}`);
                    if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                    this.completedDebouncePending = null;
                }

                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                // A genuinely new turn is underway — drop the previous turn's cached
                // final-summary so the dashboard does not keep showing the old answer
                // as "done" while the new turn generates. Re-populated when this turn
                // completes.
                this.lastCompletionSummary = null;
                // FALSE-IDLE continuity: entering a busy phase invalidates any
                // completedDebouncePending armed earlier in this settle window.
                this.busyEpoch++;
                // Defer the generating_started event — if idle comes back within 3s,
                // the whole started→completed pair was a false positive from PTY noise
                if (this.generatingDebounceTimer) clearTimeout(this.generatingDebounceTimer);
                this.generatingDebouncePending = { chatTitle, timestamp: now };
                this.generatingDebounceTimer = setTimeout(() => {
                    if (this.generatingDebouncePending) {
                        this.pushEvent({ event: 'agent:generating_started', ...this.generatingDebouncePending });
                        this.generatingDebouncePending = null;
                    }
                    this.generatingDebounceTimer = null;
                }, 3000);
            } else if (newStatus === 'waiting_approval'
                && !(previousStatus === 'waiting_choice' && !adapterStatus.activeModal)) {
                // The !(waiting_choice → modal-less waiting_approval) guard: right after an
                // AskUserQuestion answer the FSM drains through approval_resolving (status
                // 'approval', NO modal extract) while the held prompt clears on its own
                // grace. That transient is the picker resolving, NOT a fresh consent — running
                // the approval arm here would emit a spurious agent:waiting_approval with an
                // empty modal and cancel any pending completion. Skip the arm; lastStatus
                // still advances below so the subsequent →generating resume reads normally.
                this.suppressIdleHistoryReplay = false;
                // Flush pending generating_started if debounce still pending
                if (this.generatingDebouncePending) {
                    if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                    this.pushEvent({ event: 'agent:generating_started', ...this.generatingDebouncePending });
                    this.generatingDebouncePending = null;
                }
                // Cancel any pending completed
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;

                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                // FALSE-IDLE continuity: waiting_approval is a busy phase (the agent
                // resumes into it), so bump the epoch too — the completedDebouncePending
                // cancel above covers the currently-armed pending, and the epoch covers
                // a pending that re-arms and flushes across this same valley.
                this.busyEpoch++;
                const modal = adapterStatus.activeModal;
                LOG.info('CLI', `[${this.type}] approval modal: "${modal?.message?.slice(0, 80) ?? 'none'}"`);
                // Include the FSM's approval entry seq, mirroring the auto-approve
                // path (maybeAutoApproveStatus) and resolveModal's sameEntryReResolve
                // guard. Two distinct back-to-back approvals can carry identical
                // message/buttons (very common with claude-cli's "Allow Bash
                // command?"). Without the seq their fingerprints collide and the dedup
                // below silently drops the second waiting_approval event — it is never
                // emitted, so it cannot even land in the pending inbox for a later
                // read_chat reconcile to recover. The seq is bumped by the FSM on every
                // fresh waiting_approval entry, so a new approval always yields a new
                // fingerprint and emits.
                const approvalEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
                    ? adapterStatus.approvalEntrySeq
                    : 0;
                const approvalFingerprint = JSON.stringify({
                    message: typeof modal?.message === 'string' ? modal.message.trim() : '',
                    buttons: Array.isArray(modal?.buttons) ? modal.buttons.map((button: unknown) => String(button).trim()) : [],
                    seq: approvalEntrySeq,
                });
                // PTY redraws repeat the same modal content; fingerprint dedup prevents duplicate events.
                // Do NOT also gate on lastStatus: consecutive approvals can arrive waiting_approval→waiting_approval
                // (e.g. antigravity-cli resolves one prompt and immediately shows the next) and would be silently dropped.
                if (approvalFingerprint !== this.lastApprovalEventFingerprint) {
                    this.lastApprovalEventFingerprint = approvalFingerprint;
                    this.appendRuntimeSystemMessage(
                        formatApprovalRequestMessage(modal?.message, modal?.buttons),
                        `approval_request:${now}`,
                        now,
                    );
                    this.pushEvent({
                        event: 'agent:waiting_approval', chatTitle, timestamp: now,
                        modalMessage: modal?.message,
                        modalButtons: modal?.buttons,
                    });
                }
            } else if (newStatus === 'waiting_choice') {
                // SUSPENDED-TURN-IS-A-TURN (post-restart completion wedge): entering
                // waiting_choice means the turn is PARKED on an AskUserQuestion picker
                // mid-flight — the same busy phase the waiting_approval arm above treats
                // a consent modal as. Arm the turn bookkeeping identically so the answer's
                // resume (waiting_choice → generating → idle) completes through the normal
                // completion path below. Without this arm a session that entered
                // waiting_choice WITHOUT a prior idle→generating arm this boot — the
                // post-daemon-restart rebound, where the FSM folds starting→waiting_choice
                // on the still-parked picker — keeps generatingStartedAt===0, so the
                // resume's generating→idle falls into the "startup-phase blip" suppression
                // below and NO completion ever emits: the task wedges 'assigned' forever.
                this.suppressIdleHistoryReplay = false;
                // Flush pending generating_started if debounce still pending
                if (this.generatingDebouncePending) {
                    if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                    this.pushEvent({ event: 'agent:generating_started', ...this.generatingDebouncePending });
                    this.generatingDebouncePending = null;
                }
                // Cancel any pending completed
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;

                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                // FALSE-IDLE continuity: waiting_choice is a busy phase (the agent is
                // parked inside its turn), so bump the epoch exactly like the
                // waiting_approval arm does.
                this.busyEpoch++;
            } else if (newStatus === 'generating' && this.lastStatus === 'waiting_approval') {
                // Approval resolved and the agent resumed work. Defense-in-depth:
                // clear the approval emit fingerprint here too (not only on
                // completion at scheduleCompletedDebounceFlush). A subsequent
                // waiting_approval with the same modal content as the one just
                // resolved would otherwise collide with the stale fingerprint and be
                // dropped. The seq in the fingerprint already separates entries; this
                // reset is a belt-and-suspenders guard for the re-entry case.
                this.lastApprovalEventFingerprint = '';
            } else if (newStatus === 'idle' && (this.lastStatus === 'generating' || this.lastStatus === 'waiting_approval')) {
                const duration = this.generatingStartedAt ? Math.round((now - this.generatingStartedAt) / 1000) : 0;
                // Guard: if generatingStartedAt===0 and no debounce pending, the generating phase
                // was entered from 'starting' state (startup PTY noise), not from a real idle→generating
                // task dispatch. The idle→generating handler is the only code path that sets
                // generatingStartedAt and generatingDebouncePending, so both being absent means no
                // task was ever dispatched. Suppress the spurious completion event and fall through
                // to a simple lastStatus update.
                if (!this.generatingStartedAt && !this.generatingDebouncePending) {
                    LOG.debug('CLI', `[${this.type}] suppressed startup-phase generating→idle blip (generatingStartedAt=0, no debounce pending)`);
                } else
                // If debounce still pending (generating lasted < 1s), cancel both UI events.
                // Still emit agent:generating_completed so mesh orchestration can record
                // task_completed for direct dispatches that complete faster than the debounce.
                if (this.generatingDebouncePending) {
                    // NOTIF Defect-2a: shortDurationMs is the REPORTED turn duration, so it must be
                    // measured from the IMMUTABLE turn start — not generatingStartedAt, which is
                    // reset to 0 on every mid-turn waiting_approval/idle blip (see :1864/1885/2397/
                    // 2503/2521) and re-armed on the next →generating, so a long turn that blipped
                    // would measure only the final 1.5-2.5s sliver. engine.currentTurnStartedAt is
                    // stamped once at onTurnStarted and persists past mid-turn blips until the next
                    // turn starts, so it captures the true turn length. generatingStartedAt remains
                    // the fallback (and the debounce itself stays a pure UI-suppression signal,
                    // decoupled from the reported duration).
                    const { durationMs: shortDurationMs, anchor: durationAnchor } = computeTurnAnchoredDurationMs(
                        (this.adapter as any)?.currentTurnStartedAt,
                        this.generatingStartedAt,
                        now,
                    );
                    LOG.info('CLI', `[${this.type}] suppressed short generating (${shortDurationMs}ms, anchor=${durationAnchor})`);
                    if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                    // Emit completion for mesh task association even though the UI generating
                    // started/completed pair is suppressed (too short for visible UI update).
                    let shortFinalSummary: string | undefined;
                    let shortEvidenceSource: CompletionFinalAssistantEvidence['source'] = 'unavailable';
                    try {
                        const parsedMessages = this.adapter?.getScriptParsedStatus()?.messages;
                        const evidence = this.completionFinalAssistantEvidence(parsedMessages);
                        shortEvidenceSource = evidence.source;
                        shortFinalSummary = extractFinalSummaryFromMessages(evidence.messages as any);
                    } catch { /* best-effort */ }
                    // If a real response is confirmed, retroactively emit started so the chat
                    // bubble appears even though the debounce suppressed the original event.
                    if (shortFinalSummary) {
                        this.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now - shortDurationMs });
                    }
                    // FALSE-IDLE short-gen settle: snapshot the producing turn's start + taskId NOW,
                    // before `generatingStartedAt` is reset below — the settle-arm path (mesh sessions,
                    // see the mesh branch further down) needs the same turn anchor the normal
                    // completedDebounce branch captures, and generatingStartedAt is the fallback for it.
                    const shortEngineTurnStart = typeof (this.adapter as any)?.currentTurnStartedAt === 'number'
                        && Number.isFinite((this.adapter as any).currentTurnStartedAt)
                        ? (this.adapter as any).currentTurnStartedAt as number
                        : 0;
                    const shortTurnStartedAt = shortEngineTurnStart || this.generatingStartedAt || 0;
                    const shortTaskId = this.completingTurnTaskId();
                    this.generatingDebouncePending = null;
                    this.generatingStartedAt = 0;
                    // FALSE-IDLE short-gen: a short-generating completion with NO transcript
                    // backing at all (shortEvidenceSource === 'unavailable': both the screen parse
                    // AND the external-native transcript failed to yield a final assistant) is just
                    // as unproven as an 'external-native' source that returned no final assistant.
                    // Fold 'unavailable' into the missing-evidence predicate so a zero-evidence dip
                    // (the mid-turn point-sample that triggered this whole false-idle bug) is treated
                    // as weak/held, not fired as a genuine completion. A real shortFinalSummary being
                    // present still clears the gate (the !shortFinalSummary guard is unchanged).
                    const missingEvidence = (resolveTranscriptAuthorityProfile(this.provider).timing === 'floor'
                        || shortEvidenceSource === 'external-native'
                        || shortEvidenceSource === 'unavailable') && !shortFinalSummary;
                    if (missingEvidence) {
                        LOG.warn('CLI', `[${this.type}] short completion missing final assistant evidence (source=${shortEvidenceSource})`);
                    }
                    if (this.isAutonomousMeshSession()) {
                        // FALSE-IDLE short-gen settle (the core fix): for an autonomously-progressing
                        // mesh session (delegated worker OR self-coordinator), the short-generating
                        // branch was a POINT-SAMPLE — a single idle read from getStatus({allowParse:false})
                        // that fires the completion INLINE with zero continuity backing. When the worker
                        // is merely mid-turn (a sub-3s dip between two tool calls), this synchronously
                        // emitted a false agent:generating_completed the coordinator can never correct.
                        //
                        // Route it through the SAME settle + continuity machinery as the normal
                        // completedDebounce branch: arm completedDebouncePending capturing busyEpochAtArm
                        // and lastOutputAtArm, then scheduleCompletedDebounceFlush(NATIVE_HISTORY_MESH_IDLE_SETTLE_MS)
                        // so flushCompletedDebounceIfFinalized() re-verifies CONTINUOUS idle before emitting.
                        // A busy re-entry (busyEpoch bump) or new PTY output within the settle window —
                        // exactly what happens when the worker resumes its next tool call — CANCELS the
                        // false completion. Genuine completions (real final assistant) still emit at the
                        // end of the (short, 4s) settle window; missingEvidence flows through the
                        // finalization block (missing_final_assistant → CANON-C weak/held) rather than
                        // being frozen as a genuine inline fire.
                        this.completedDebouncePending = {
                            chatTitle,
                            duration: Math.round(shortDurationMs / 1000),
                            timestamp: now,
                            firstObservedAt: now,
                            // Short-gen enters from generating→idle (or waiting_approval→idle); the
                            // completedDebounce finalization gate treats previousStatus for its
                            // approval-resolution / inter-approval-valley handling. lastStatus is the
                            // status we transitioned FROM here.
                            previousStatus: this.lastStatus,
                            ...(shortTaskId ? { taskId: shortTaskId } : {}),
                            ...(shortTurnStartedAt ? { turnStartedAt: shortTurnStartedAt } : {}),
                            // FALSE-IDLE continuity: same arm-time snapshots as the normal branch so the
                            // flush guard can prove continuous idle across the settle window.
                            busyEpochAtArm: this.busyEpoch,
                            ...(typeof adapterStatus?.lastOutputAt === 'number' && Number.isFinite(adapterStatus.lastOutputAt)
                                ? { lastOutputAtArm: adapterStatus.lastOutputAt as number }
                                : {}),
                        };
                        LOG.info('CLI', `[${this.type}] short-generating routed through settle window (${shortDurationMs}ms, source=${shortEvidenceSource}, missingEvidence=${missingEvidence}) — arming completedDebouncePending instead of inline fire`);
                        // EVTTRACE: now traces the settle ARM (not an inline fire) for mesh sessions,
                        // so logs show the short-gen path deferring to continuity re-check.
                        if (this.isMeshWorkerSession()) {
                            traceMeshEventStage('arm', this.meshTraceCtx(), `short-generating settle-arm (source=${shortEvidenceSource}, missingEvidence=${missingEvidence})`);
                        }
                        if (this.completionTraceOn()) this.recordCompletionGateTrace('arm', {
                            branch: 'short_generating',
                            previousStatus: this.lastStatus,
                            turnStartedAt: shortTurnStartedAt || null,
                            busyEpochAtArm: this.busyEpoch,
                            lastOutputAtArm: typeof adapterStatus?.lastOutputAt === 'number' ? adapterStatus.lastOutputAt : null,
                            flushDelay: NATIVE_HISTORY_MESH_IDLE_SETTLE_MS,
                            evidenceSource: shortEvidenceSource,
                            missingEvidence,
                            hasFinalSummary: !!shortFinalSummary,
                        });
                        this.scheduleCompletedDebounceFlush(NATIVE_HISTORY_MESH_IDLE_SETTLE_MS);
                    } else if (missingEvidence) {
                        // NON-MESH, missing evidence: suppress the completion event entirely (the
                        // original !hasMeshContext suppression). A genuinely non-mesh session has no
                        // coordinator to notify, and firing a completion with no confirmed final
                        // assistant would just surface an empty/unconfirmed turn. Leave
                        // completedDebouncePending null — the session is now idle with no confirmed
                        // turn, matching the startup-blip suppression semantics. (No EvtTrace: not a
                        // mesh session, so nothing routes to a coordinator.)
                        LOG.info('CLI', `[${this.type}] short completion suppressed: missing final assistant evidence, non-mesh session (source=${shortEvidenceSource})`);
                    } else {
                        // NON-MESH interactive fast-path with a CONFIRMED summary: keep the existing
                        // inline fire. The dashboard UX reason for the short path (a fast turn should
                        // surface its completion promptly without a 4s settle) still holds, and a
                        // non-mesh session has no coordinator to be falsely notified — the false-idle
                        // bug being fixed is specifically the mesh worker/coordinator misfire above.
                        this.emitGeneratingCompleted({
                            chatTitle,
                            duration: 0,
                            timestamp: now,
                            finalSummary: shortFinalSummary,
                            completionDiagnostic: {
                                reason: 'short_generating_suppressed',
                                shortDurationMs,
                                finalAssistantEvidenceSource: shortEvidenceSource,
                            },
                        });
                        // A genuine completion was emitted for this turn (and
                        // generatingStartedAt was reset above) — stamp it as
                        // satisfied for the startup-grace collapse synth so a
                        // late idle-stayed poll cannot re-synthesize a weak pair.
                        this.markCurrentTurnStartupGraceCollapseSatisfied();
                    }
                } else {
                    // Debounce completed, then require the rich transcript path that read_chat
                    // uses to show an idle turn whose last user-facing message is assistant.
                    this.completedDebouncePending = {
                        chatTitle,
                        duration,
                        timestamp: now,
                        firstObservedAt: now,
                        previousStatus: this.lastStatus,
                        // ARCH-REFACTOR R1: snapshot the completing turn's taskId NOW (sync),
                        // before any follow-up task's flush can start a new turn and move
                        // engine.currentTurnTaskId.
                        ...(this.completingTurnTaskId() ? { taskId: this.completingTurnTaskId() } : {}),
                        // NOTIF Defect-B: snapshot the producing turn's START instant NOW, for the
                        // same reason as taskId — a follow-up turn moves engine.currentTurnStartedAt.
                        // Prefer the engine's per-turn start (set at onTurnStarted, earliest reliable
                        // anchor) and fall back to generatingStartedAt (when generating was observed).
                        ...((() => {
                            const engineTurnStart = typeof (this.adapter as any)?.currentTurnStartedAt === 'number'
                                && Number.isFinite((this.adapter as any).currentTurnStartedAt)
                                ? (this.adapter as any).currentTurnStartedAt as number
                                : 0;
                            const turnStartedAt = engineTurnStart || this.generatingStartedAt || 0;
                            return turnStartedAt ? { turnStartedAt } : {};
                        })()),
                        // FALSE-IDLE continuity: snapshot the busy epoch + raw PTY output
                        // clock at arm time so the flush guard can prove the session stayed
                        // continuously idle (no busy re-entry, no new PTY output) through the
                        // settle window rather than merely reading 'idle' once at flush.
                        busyEpochAtArm: this.busyEpoch,
                        ...(typeof adapterStatus?.lastOutputAt === 'number' && Number.isFinite(adapterStatus.lastOutputAt)
                            ? { lastOutputAtArm: adapterStatus.lastOutputAt as number }
                            : {}),
                    };
                    const ownsExternalHistory = !!(this.adapter as any)?.chatMessagesOwnedExternally;
                    // (FALSEIDLE-BGCHILD-a) Native-history providers flush immediately (the
                    // transcript is authoritative). For autonomously-progressing mesh sessions,
                    // give the generating→idle transition a short settle window so a background-child
                    // false idle (quiet after a backgrounded test/command while the parent turn
                    // continues) or an inter-approval auto-approve valley gets caught by the resume
                    // guard in flushCompletedDebounceIfFinalized instead of firing an early completion
                    // the coordinator can never correct.
                    //
                    // (FALSE-IDLE self-coordinator settle) The settle window now covers BOTH mesh
                    // worker sessions AND the coordinator's own claude-cli session (meshCoordinatorFor):
                    // isAutonomousMeshSession(). Previously only isMeshWorkerSession() qualified, so a
                    // self-coordinating daemon (worker + coordinator on the same daemon) ran the
                    // coordinator's own turn at flushDelay=0 — no settle window at all — and the
                    // busyEpoch/lastOutputAt continuity guard, being a flush-time point-check, had no
                    // window in which to observe the ~0.5s auto-approve valley. Its mid-turn
                    // "next-step" sentence was flushed as finalSummary. A genuinely non-mesh session
                    // (neither worker nor self-coordinator) still flushes immediately (delay=0), so
                    // no non-mesh behaviour changes; this only ADDS a settle window (strictly
                    // stricter — the guard can only ever CANCEL a pending flush, never emit more).
                    const meshSettleSession = this.isAutonomousMeshSession();
                    const flushDelay = ownsExternalHistory
                        ? (meshSettleSession ? NATIVE_HISTORY_MESH_IDLE_SETTLE_MS : 0)
                        : 3000;
                    LOG.debug('CLI', `[${this.type}] set completedDebouncePending duration=${duration}s ownsExternalHistory=${ownsExternalHistory} meshSettle=${meshSettleSession} flushDelay=${flushDelay}ms generatingStartedAt=${this.generatingStartedAt}`);
                    if (this.completionTraceOn()) this.recordCompletionGateTrace('arm', {
                        branch: 'normal',
                        previousStatus: this.completedDebouncePending.previousStatus,
                        turnStartedAt: this.completedDebouncePending.turnStartedAt ?? null,
                        busyEpochAtArm: this.completedDebouncePending.busyEpochAtArm ?? null,
                        lastOutputAtArm: this.completedDebouncePending.lastOutputAtArm ?? null,
                        flushDelay,
                        ownsExternalHistory,
                        meshSettle: meshSettleSession,
                    });
                    this.scheduleCompletedDebounceFlush(flushDelay);
                }
            } else if (newStatus === 'idle' && this.lastStatus === 'starting') {
                this.emitAgentReadyOnce(chatTitle, now);
                // GENERATING-BOUNDARY (R4c): stamp the collapse moment ONCE so the
                // idle-stayed window below is anchored on the startup-grace collapse,
                // not on boot. Set only the first time so a later starting re-entry
                // cannot slide the window forward.
                if (this.startupGraceCollapseAt === null) this.startupGraceCollapseAt = now;
                // GENERATING-BOUNDARY fast-collapse (R4, win32 startup-grace first turn):
                // a turn dispatched into the startup-grace window can START and FINISH while
                // the FSM is still in 'starting'. On a daemon whose claude-cli spec has NOT yet
                // synced the starting→busy edge (the primary cure lives in the spec's
                // idle→busy.from), the FSM never reaches 'busy'/generating, so
                // detectStatusTransition observes starting→idle DIRECTLY with no intervening
                // 'generating' frame. The idle→generating arm — the only path that sets
                // generatingStartedAt and arms the completion — never fired, so the completing
                // turn's agent:generating_completed is never emitted and the mesh coordinator
                // never learns the worker went idle. Synthesize the started+completed pair here.
                //
                // Discriminator (false-positive safe — must NOT fire on a benign boot):
                //   adapter.currentTurnTaskId is set ONLY by onTurnStarted (a real turn STARTED
                //   this boot) and persists past completion, so it cleanly separates the three
                //   non-firing cases — a true idle boot (no turn → null), a queued-pending
                //   first turn that only runs AFTER startup-grace drains the composer (onTurnStarted
                //   not yet called → null; it completes normally later via idle→busy→idle), and a
                //   turn STILL running at the 8s mark (hasAdapterPendingResponse() still true →
                //   excluded so we don't fire a premature mid-turn completion; idle→busy self-
                //   corrects once the FSM reaches idle). We fire only when a turn started AND has
                //   already finished: started-this-boot && !still-in-flight.
                this.maybeSynthesizeStartupGraceCollapse(chatTitle, now, 'startup_grace_fast_collapse');
            } else if (newStatus === 'error') {
                if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                this.generatingDebouncePending = null;
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;
                this.errorMessage = adapterStatus.errorMessage || this.errorMessage;
                this.errorReason = (adapterStatus.errorReason as ProviderErrorReason) || this.errorReason;
                this.pushEvent({
                    event: 'agent:stopped',
                    chatTitle,
                    timestamp: now,
                    finalSummary: adapterStatus.errorMessage || adapterStatus.errorReason || 'Provider reported an error',
                    completionDiagnostic: {
                        reason: adapterStatus.errorReason || 'provider_error',
                        errorMessage: adapterStatus.errorMessage || undefined,
                    },
                });
            } else if (newStatus === 'stopped') {
                // Cancel any pending debounce
                if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                this.generatingDebouncePending = null;
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;
                this.pushEvent({ event: 'agent:stopped', chatTitle, timestamp: now });
            }
            this.lastStatus = newStatus;
        }

        // INTERACTIVE-QUESTION-EMIT: fire a coordinator/push-worthy notification when the
        // session ENTERS an AskUserQuestion / waiting_choice state. This is orthogonal to
        // the status-change block above: an AskUserQuestion prompt is surfaced only as a
        // display-only `waiting_choice` overlay in getState() (mirrored here off
        // adapterStatus.activeInteractivePrompt, the exact signal getState uses), while
        // the raw adapter status stays idle/generating — so none of the status-keyed
        // arms above ever emit an agent:* event for it and the owner gets no web-push.
        //
        // MESH-QUESTION-ANSWER-PATH (mission f1d25e11): this used to REUSE
        // agent:waiting_approval (question as modalMessage, choice labels as modalButtons).
        // That mis-classified a multi-choice QUESTION as an approval — the coordinator saw
        // a task_approval_needed ledger row and tried mesh_approve, which cannot answer a
        // question (it resolves a yes/no modal). We now emit a DISTINCT
        // agent:waiting_choice event carrying the FULL InteractivePrompt payload
        // (promptId + every question's header/question/multiSelect and each option's
        // label/description) so the coordinator can render the choices and answer with the
        // dedicated mesh_answer_question tool. The rich payload survives the cross-machine
        // relay (see buildRelayMetadataEvent) so a REMOTE worker's question reaches the
        // coordinator with its options intact.
        //
        // We keep modalMessage/modalButtons on the event too so the existing server
        // web-push path (which reads those two fields) still fires with no cloud change —
        // but the payload's `interactivePrompt` is the authoritative, structured signal.
        //
        // Edge-triggered: emit exactly once on entry, keyed on promptId + question text,
        // and reset the key when the prompt clears so a fresh prompt re-fires and a later
        // real completion still flows through the idle arm normally. We do NOT emit when
        // the session is in a genuine approval state (newStatus === 'waiting_approval'):
        // that arm already emits agent:waiting_approval. A question (waiting_choice) and a
        // real approval (waiting_approval) therefore NEVER both fire for the same tick —
        // the approval arm wins and this arm yields (owner requirement: the two are
        // mutually exclusive). Note an AskUserQuestion picker no longer reaches this arm
        // as waiting_approval: the isQuestionPicker classification above folds it to
        // waiting_choice, so a picker ALWAYS lands here and a consent NEVER does.
        if (interactivePrompt && newStatus !== 'waiting_approval') {
            const firstQuestion = interactivePrompt.questions?.[0];
            const promptKey = `${interactivePrompt.promptId}::${firstQuestion?.question ?? ''}`;
            if (promptKey !== this.lastInteractivePromptEventKey) {
                this.lastInteractivePromptEventKey = promptKey;
                const modalMessage = firstQuestion
                    ? (firstQuestion.header
                        ? `${firstQuestion.header}: ${firstQuestion.question}`
                        : firstQuestion.question)
                    : undefined;
                const modalButtons = firstQuestion?.options?.map((option: { label: string }) => option.label);
                this.pushEvent({
                    event: 'agent:waiting_choice', chatTitle, timestamp: now,
                    // Structured, authoritative payload — the coordinator renders these and
                    // answers via mesh_answer_question. Carried whole (all questions, all
                    // options) so multi-question / multi-select prompts round-trip fully.
                    interactivePrompt,
                    promptId: interactivePrompt.promptId,
                    multiSelect: firstQuestion?.multiSelect === true,
                    // Push-notification-friendly projection (server push path reads these).
                    modalMessage,
                    modalButtons,
                });
            }
        } else if (!interactivePrompt && this.lastInteractivePromptEventKey) {
            // Prompt answered / gone — reset so the next AskUserQuestion re-fires.
            this.lastInteractivePromptEventKey = '';
        }

        // GENERATING-BOUNDARY idle-stayed collapse (R4b): the starting→idle
        // fast-collapse arm above only fires when the FIRST turn itself drives the
        // starting→idle transition. When the launch settle already drained
        // starting→idle BEFORE the first turn arrives, the session is already 'idle'
        // and a turn that runs+completes inside the startup-grace window — too fast
        // for any poll to observe a 'generating' frame — produces NO status change
        // at all (idle→idle). detectStatusTransition's change block above is skipped
        // entirely, so neither the idle→generating arm nor the starting→idle
        // fast-collapse arm ever runs, and the mesh coordinator never learns the
        // worker went idle (the live rc.403 Probe1 miss). Catch it here: an
        // already-idle poll (no status change), still inside the startup-grace
        // window, where a turn started this boot and has already finished without
        // ever arming generating. The same false-positive-safe discriminators apply
        // (currentTurnTaskId set && !pending && generating never armed), plus a
        // once-per-turn guard since this branch is re-polled while the session sits
        // idle. Normal turns that DO reach 'busy' set generatingStartedAt and are
        // excluded; a queued-pending first turn that only runs after grace falls
        // outside the window and completes normally via idle→busy→idle.
        //
        // R4d (the live rc.405 Probe2 miss): R4c anchored the window on the collapse
        // moment but still measured its END against `now` (the poll/completion time). The
        // helper only fires once the turn has FINISHED (!hasAdapterPendingResponse()), so
        // the first eligible poll happens at completion. When the first turn is dispatched
        // a few seconds after the collapse AND runs for a non-trivial duration, that
        // completion lands PAST the 12s now-anchored window even though the turn was a
        // genuine startup-grace first turn (live: collapse→dispatch +5.2s, turn ~11s →
        // completion at collapse+16.2s > 12s). Anchor the window on when the first turn
        // STARTED (engine.currentTurnStartedAt, set by onTurnStarted) instead: a turn that
        // STARTED within the collapse window is a startup-grace first turn no matter how
        // long it then ran. The now-anchored check is retained as a union so a fast turn
        // (dispatched+completed quickly within 12s of collapse) keeps firing too; both
        // close for a much-later turn, preserving the "don't mislabel a late fast turn"
        // honesty the window exists for.
        const firstTurnStartedAt = typeof (this.adapter as any)?.currentTurnStartedAt === 'number'
            ? (this.adapter as any).currentTurnStartedAt as number
            : 0;
        const collapsedAt = this.startupGraceCollapseAt;
        const turnStartedWithinCollapseWindow = collapsedAt !== null
            && firstTurnStartedAt > 0
            && firstTurnStartedAt >= collapsedAt
            && (firstTurnStartedAt - collapsedAt) < STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS;
        const nowWithinCollapseWindow = collapsedAt !== null
            && (now - collapsedAt) < STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS;
        if (
            newStatus === 'idle'
            && previousStatus === 'idle'
            && (turnStartedWithinCollapseWindow || nowWithinCollapseWindow)
        ) {
            this.maybeSynthesizeStartupGraceCollapse(chatTitle, now, 'startup_grace_idle_turn_collapse');
        }

        // Re-arm the queue-claim agent:ready on the FSM's first GENUINE ready.
        //
        // The boot-time starting→idle one-shot above is the historical claim
        // trigger, but it is consumed too early for FSM-spec providers whose
        // INITIAL state already reports status 'idle' (e.g. antigravity-cli): the
        // adapter reports idle before maybeMarkReady has fired, so lastStatus
        // advances starting→idle while the prompt is not yet drawn and the worker
        // cannot yet claim. Subsequent state-driven idle frames are idle→idle (no
        // status change), so the one-shot never re-fires and the worker strands its
        // queued task — the coordinator then relaunch-loops every ~90s.
        //
        // The adapter surfaces fsmReadySeen=true exactly when the FSM reaches its
        // first non-initial idle (the prompt is genuinely up). On that signal we
        // emit agent:ready once more. emitAgentReadyOnce is idempotent (guarded by
        // agentReadyEmitted), so providers whose boot one-shot already landed on a
        // real ready (claude-cli / codex-cli / hermes-cli, which use a startup
        // grace and whose initial state is not idle) treat this as a no-op — no
        // double claim, no double task injection.
        if (newStatus === 'idle' && adapterStatus.fsmReadySeen === true && !this.agentReadyEmitted) {
            this.emitAgentReadyOnce(chatTitle, now);
        }

        this.applyProviderResponse(parsedStatus, {
            phase: (newStatus === 'idle' && (previousStatus === 'generating' || previousStatus === 'waiting_approval'))
                ? 'turn_completed'
                : 'immediate',
        });

 // Monitor check (cooldown based notification, IDE/CLI common)
        const agentKey = `${this.type}:cli`;
        // Approval pending is detected from the raw adapter status, not `newStatus`:
        // auto-approve synthesizes `waiting_approval` → 'generating', which would
        // otherwise let the no-progress watchdog accumulate the approval wait.
        const approvalPending = rawStatus === 'waiting_approval';
        const monitorEvents = this.monitor.check(agentKey, newStatus, now, progressFingerprint, approvalPending);
        const monitorParsedStatus: any = parsedStatus;
        for (const me of monitorEvents) {
            if (
                me.type === 'monitor:no_progress'
                && this.completionHasFinalAssistantMessage(monitorParsedStatus?.messages)
                && !this.hasAdapterPendingResponse()
                && !hasNonEmptyCliModalButtons(monitorParsedStatus?.activeModal ?? monitorParsedStatus?.modal)
            ) {
                // EVTTRACE: completion fired (no-progress monitor reconciled to completion).
                if (this.isMeshWorkerSession()) {
                    traceMeshEventStage('fired', this.meshTraceCtx(), 'no_progress_monitor_final_summary');
                }
                this.emitGeneratingCompleted({
                    chatTitle,
                    duration: this.generatingStartedAt ? Math.round((now - this.generatingStartedAt) / 1000) : undefined,
                    timestamp: me.timestamp,
                    finalSummary: extractFinalSummaryFromMessages(monitorParsedStatus?.messages),
                    completionDiagnostic: {
                        providerType: this.type,
                        sessionId: this.instanceId,
                        providerSessionId: this.providerSessionId || null,
                        reconciliationReason: 'no_progress_monitor_final_summary',
                        finalAssistantPresent: true,
                    },
                });
                this.generatingStartedAt = 0;
                // Cancel any pending debounce flush — monitor already fired completion.
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;
                continue;
            }
            // MESH-STALL-WATCH dedupe: for a coordinator-spawned mesh worker the
            // status-agnostic stall watchdog (checkMeshWorkerStall) owns the
            // monitor:no_progress alert. The StatusMonitor here fires its OWN
            // generating-only no-progress on the SAME 180s bound, which would
            // double-emit into the task_stalled ledger + coordinator inbox for the
            // one stall. Suppress the StatusMonitor's copy for mesh workers only —
            // the completion-reconciliation branch above (which turns a no-progress
            // WITH final-assistant into a real completion) still runs, so genuine
            // idle-reconciled completions are unaffected. Non-mesh sessions keep the
            // original StatusMonitor behavior untouched.
            if (me.type === 'monitor:no_progress' && this.isMeshWorkerSession()) {
                traceMeshEventDrop('mesh_worker_stall_watchdog_owns_no_progress', this.meshTraceCtx('monitor:no_progress'));
                continue;
            }
            this.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
        }
    }

    private pushEvent(event: ProviderEvent): void {
        const enrichedEvent: ProviderEvent = {
            ...event,
            instanceId: typeof event.instanceId === 'string' && event.instanceId.trim()
                ? event.instanceId
                : this.instanceId,
            targetSessionId: typeof event.targetSessionId === 'string' && event.targetSessionId.trim()
                ? event.targetSessionId
                : this.instanceId,
            providerType: typeof event.providerType === 'string' && event.providerType.trim()
                ? event.providerType
                : this.type,
            workspaceName: typeof event.workspaceName === 'string' && event.workspaceName.trim()
                ? event.workspaceName
                : this.workingDir,
            // Carry the workspace under BOTH `workspace` and `workspaceName` so the
            // downstream mesh forward/merge path — which reads `workspace` — can
            // propagate it to the coordinator snapshot. Without `workspace` the live
            // event path delivers an empty workspace and the dashboard falls back to
            // the generic "Terminal (Mesh Node)" title.
            workspace: typeof event.workspace === 'string' && event.workspace.trim()
                ? event.workspace
                : this.workingDir,
            providerSessionId: typeof event.providerSessionId === 'string' && event.providerSessionId.trim()
                ? event.providerSessionId
                : this.providerSessionId,
        };
        // TASKIDLESS: stamp the mesh task primary key on lifecycle events emitted by
        // a mesh worker session. The consumer (updateDirectDispatchStatus) was switched
        // to key on task_id (CANON-B), but the producer never carried it — so every
        // forwarded metadataEvent.taskId arrived undefined and the coordinator fell back
        // to a session_id match, which can flip a sibling dispatch row. Surface it here so
        // updateDirectDispatchStatus hits the exact PK row and the session_id fallback is
        // never exercised. Non-mesh sessions get no taskId (regression guard) —
        // isMeshWorkerSession() gates the injection.
        //
        // ARCH-REFACTOR R1 (per-turn identity): resolution order is
        //   (1) an explicit taskId already on the event — the debounce-flush completion
        //       path stamps the taskId captured at the generating→idle transition (the
        //       turn that actually produced this completion);
        //   (2) the per-turn binding (engine.currentTurnTaskId) for synchronously-emitted
        //       events whose turn is still the current one;
        //   (3) the legacy session scalar (settings.meshActiveTaskId) as a last-resort
        //       backward-compat alias.
        // The scalar is last because it is last-write-wins: a second task attaching while
        // this turn was still running overwrites it, which is the exact NOTIF-MISDELIVER /
        // TASK-MSG-MISROUTE race this refactor removes.
        if (this.isMeshWorkerSession()) {
            const existingTaskId = typeof enrichedEvent.taskId === 'string' && enrichedEvent.taskId.trim()
                ? enrichedEvent.taskId
                : undefined;
            if (!existingTaskId) {
                const resolved = this.completingTurnTaskId();
                if (resolved) enrichedEvent.taskId = resolved;
            }
            // REDRIVE-DUP: echo the dispatch nonce this session's active task was stamped with
            // so the coordinator's generating_started handler can reject a stale (reclaimed)
            // dispatch and stop this worker before it double-executes the reclaimed task.
            if (enrichedEvent.dispatchNonce === undefined && typeof this.settings.meshActiveDispatchNonce === 'number') {
                enrichedEvent.dispatchNonce = this.settings.meshActiveDispatchNonce;
            }
            // TURN-LEDGER (Stage 5): echo the attempt identity alongside the nonce so the
            // coordinator's reducer correlates this event to (taskId, attemptId, session).
            if (enrichedEvent.attemptId === undefined && typeof this.settings.meshActiveAttemptId === 'string' && this.settings.meshActiveAttemptId) {
                enrichedEvent.attemptId = this.settings.meshActiveAttemptId;
            }
        }
        if (this.context?.emitProviderEvent) {
            this.context.emitProviderEvent(enrichedEvent);
        } else {
            this.events.push(enrichedEvent);
        }
        // Auto-detach a direct-dispatch mesh assignment once the dispatched
        // task reaches a terminal state. Leaving meshNodeFor pinned would
        // route this session's next unrelated turn (a dashboard chat) into
        // the coordinator as if it were the completion of another task.
        // We schedule after the emit so the originating coordinator still
        // observes the completion event with its routing marker intact.
        //
        // RESTART-REBOUND agent:ready guard (post-restart completion wedge):
        // agent:ready is a queue-CLAIM signal, not task-terminal evidence — and
        // it re-fires after a daemon restart (agentReadyEmitted is per-process),
        // potentially on the SAME first-idle frame that just armed this task's
        // debounced completion. Detaching here would strip meshActiveTaskId /
        // meshActiveAttemptId / meshActiveDispatchNonce before the completion
        // flush emits, dropping the completion envelope-less. So agent:ready
        // may only detach when NO turn is in flight and NO completion is
        // pending; generating_completed / agent:stopped stay unconditional —
        // they ARE the terminal evidence. A genuine agent:ready with no active
        // task is unaffected (meshActiveTaskId falsy → no detach either way).
        if (TERMINAL_MESH_EVENTS.has(event.event) && this.settings.meshActiveTaskId) {
            const readyWithTurnInFlight = event.event === 'agent:ready'
                && (this.generatingStartedAt !== 0
                    || this.completedDebouncePending !== null
                    || this.generatingDebouncePending !== null);
            if (!readyWithTurnInFlight) {
                try { this.detachMeshAssignment(); } catch { /* best-effort */ }
            }
        }
    }

    private flushEvents(): ProviderEvent[] {
        const events = [...this.events];
        this.events = [];
        return events;
    }

    private applyProviderResponse(data: any, options: { phase: 'immediate' | 'turn_completed' }): void {
        if (!data || typeof data !== 'object') return;

        const patchedProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof data.providerSessionId === 'string' ? data.providerSessionId : '',
        );
        if (patchedProviderSessionId) {
            // A provider-response id is authoritative when it carries an
            // explicit `new_session` marker (the CLI genuinely started a new
            // conversation). Without that marker it's just an observed id and
            // must not hijack an existing binding (see promoteProviderSessionId).
            this.promoteProviderSessionId(patchedProviderSessionId, {
                authoritative: data.sessionEvent === 'new_session',
            });
        }

        if (data.sessionEvent === 'new_session') {
            this.runtimeMessages = [];
            this.lastPersistedHistoryMessages = [];
            this.suppressIdleHistoryReplay = false;
            this.adapter.clearHistory();
        }

        const patchedState = mergeProviderPatchState({
            providerControls: this.provider.controls,
            data,
            currentControlValues: this.controlValues,
            currentSummaryMetadata: this.summaryMetadata,
        });
        this.controlValues = patchedState.controlValues;
        this.summaryMetadata = patchedState.summaryMetadata;

        const effects = normalizeProviderEffects(data);
        for (const effect of effects) {
            const effectWhen = effect.when || 'immediate';
            if (effectWhen === 'turn_completed' && options.phase !== 'turn_completed') continue;
            if (effectWhen === 'immediate' && options.phase === 'turn_completed') continue;

            const effectKey = getEffectDedupKey(effect);
            if (this.appliedEffectKeys.has(effectKey)) continue;
            this.appliedEffectKeys.add(effectKey);

            if (effect.persist !== false) {
                const persistedMessage = buildPersistedProviderEffectMessage(effect);
                if (persistedMessage) this.appendRuntimeMessage(persistedMessage, effectKey);
            }

            if (effect.type === 'message' && effect.message) {
                const content = typeof effect.message.content === 'string'
                    ? effect.message.content
                    : JSON.stringify(effect.message.content);
                this.pushEvent({
                    event: 'provider:message',
                    timestamp: Date.now(),
                    content,
                    role: effect.message.role || 'system',
                    kind: effect.message.kind,
                    senderName: effect.message.senderName,
                });
            } else if (effect.type === 'toast' && effect.toast) {
                this.pushEvent({
                    event: 'provider:toast',
                    effectId: effect.id || effectKey,
                    timestamp: Date.now(),
                    message: effect.toast.message,
                    level: effect.toast.level || 'info',
                });
            } else if (effect.type === 'notification' && effect.notification) {
                this.pushEvent({
                    event: 'provider:notification',
                    effectId: effect.id || effectKey,
                    timestamp: Date.now(),
                    title: effect.notification.title,
                    message: effect.notification.body,
                    content: typeof effect.notification.bubbleContent === 'string'
                        ? effect.notification.bubbleContent
                        : effect.notification.body,
                    level: effect.notification.level || 'info',
                    channels: effect.notification.channels || ['toast'],
                    preferenceKey: effect.notification.preferenceKey,
                });
            }
        }

        if (this.appliedEffectKeys.size > 200) {
            this.appliedEffectKeys = new Set(Array.from(this.appliedEffectKeys).slice(-100));
        }
    }
 // ─── Adapter access (backward compat) ──────────────────

    getAdapter(): ProviderCliAdapter {
        return this.adapter;
    }

    get cliType(): string { return this.type; }
    get cliName(): string { return this.provider.name; }

    private resolveAutoApproveMode(): ResolvedAutoApproveMode {
        return resolveProviderAutoApproveMode(this.provider, this.settings);
    }

    /** Legacy boolean view retained for internal/test compatibility. */
    private shouldAutoApprove(): boolean {
        return this.resolveAutoApproveMode().active;
    }

    private shouldUsePtyAutoApprove(): boolean {
        const resolved = this.resolveAutoApproveMode();
        return this.shouldAutoApprove() && resolved.strategy === 'pty-parse-default';
    }

    /** @see ProviderInstance.noteManualInteraction */
    noteManualInteraction(now = Date.now(), opts?: { passive?: boolean }): void {
        // P1b (#137 secondary): a DELEGATED worker session must not treat a
        // passive dashboard view (foreground tab selection / panel open) as
        // manual attendance. A coordinator merely peeking at a worker's panel
        // would otherwise suppress that worker's delegated auto-approve for the
        // whole 60s window. Only explicit input/intervention (controlbar,
        // resolve_action, pty_input) attends a worker. Non-worker (foreground)
        // sessions keep noting on passive views so a user foregrounding their own
        // session still holds auto-approve to act on the modal themselves.
        if (opts?.passive && this.isMeshWorkerSession()) return;
        this.manualAttendance.note(now);
    }

    /**
     * Whether auto-approve should be treated as active *right now* for display
     * and firing decisions: the configured intent AND the user is not currently
     * attending this session by hand. When a human is attending, auto-approve is
     * held so the modal stays visible and they can drive it via the controlbar.
     * Provider-agnostic — the attendance signal is the command set, never any
     * CLI-specific modal text.
     */
    private autoApproveEffectivelyActive(status: string | undefined, now = Date.now()): boolean {
        return status === 'waiting_approval'
            && this.shouldUsePtyAutoApprove()
            && !this.manualAttendance.isAttended(now);
    }

    // STATUS-MISMATCH: true once the current auto-approve episode has been masking
    // waiting_approval behind `generating` for longer than AUTO_APPROVE_MASK_STALL_MS without
    // resolving (the settle gate never fired). When stalled, the surface mask must be dropped
    // so read_chat / mesh_status / the dashboard see the real waiting_approval + modal (and a
    // coordinator can mesh_approve it). autoApproveMaskSince is maintained by
    // maybeAutoApproveStatus (driven by getState + the recheck timer during a waiting episode);
    // this read is side-effect-free so getStatusMetadata can consult it too.
    private autoApproveMaskStalled(now = Date.now()): boolean {
        return approvalGate.autoApproveMaskStalled(this as unknown as ApprovalGateHost, now);
    }


    private recordAutoApproval(modalMessage?: string, buttonLabel?: string, now = Date.now()): void {
        this.appendRuntimeSystemMessage(
            formatAutoApprovalMessage(modalMessage, buttonLabel),
            `auto_approval:${now}:${buttonLabel || 'approve'}`,
            now,
        );
    }

    recordApprovalSelection(buttonText: string): void {
        const cleanButton = String(buttonText || '').trim();
        if (!cleanButton) return;
        const now = Date.now();
        this.appendRuntimeSystemMessage(
            `Approval selected: ${cleanButton}`,
            `approval_selection:${now}:${cleanButton}`,
            now,
        );
    }

    private maybeAppendRuntimeRecoveryMessage(runtime: PtyRuntimeMetadata | null): void {
        if (!runtime?.restoredFromStorage || !runtime.runtimeId) return;

        const recoveryState = String(runtime.recoveryState || '').trim();
        if (!recoveryState) return;

        let content = '';
        if (recoveryState === 'auto_resumed') {
            content = 'Session host restored this CLI after restart and reattached it from a saved snapshot.';
        } else if (recoveryState === 'resume_failed') {
            const errorSuffix = runtime.recoveryError ? ` Resume failed: ${runtime.recoveryError}` : '';
            content = `Session host found this CLI after restart, but automatic resume failed.${errorSuffix}`;
        } else if (recoveryState === 'host_restart_interrupted') {
            content = 'Session host found this CLI in interrupted state after restart and is attempting to resume it.';
        } else if (recoveryState === 'orphan_snapshot') {
            content = 'Session host restored the last snapshot for this CLI, but the original runtime was not resumed automatically.';
        } else {
            content = `Session host restored this CLI after restart (${recoveryState}).`;
        }

        this.appendRuntimeSystemMessage(
            content,
            `runtime_recovery:${runtime.runtimeId}:${recoveryState}`,
        );
    }

    private appendRuntimeSystemMessage(content: string, dedupKey: string, receivedAt = Date.now()): void {
        this.appendRuntimeMessage(buildRuntimeSystemChatMessage({
            content,
            receivedAt,
            timestamp: receivedAt,
        }), dedupKey);
    }

    private appendRuntimeMessage(message: ChatMessage, dedupKey: string): void {
        const normalizedMessage = buildChatMessage({
            ...message,
            receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : (message.timestamp || Date.now()),
            timestamp: typeof message.timestamp === 'number' ? message.timestamp : (message.receivedAt || Date.now()),
        } as ChatMessage);
        const normalizedContent = typeof normalizedMessage.content === 'string'
            ? normalizedMessage.content.trim()
            : flattenContent(normalizedMessage.content).trim();
        if (!normalizedContent && (!Array.isArray(normalizedMessage.content) || normalizedMessage.content.length === 0)) return;
        if (this.runtimeMessages.some((entry) => entry.key === dedupKey)) return;

        this.runtimeMessages.push({
            key: dedupKey,
            message: normalizedMessage,
        });

        if (normalizedContent) {
            this.historyWriter.appendNewMessages(
                this.type,
                [{
                    role: normalizedMessage.role,
                    senderName: normalizedMessage.senderName,
                    kind: normalizedMessage.kind,
                    content: normalizedContent,
                    receivedAt: normalizedMessage.receivedAt || normalizedMessage.timestamp,
                    historyDedupKey: dedupKey,
                }],
                this.adapter.getScriptParsedStatus?.()?.title || workingDirBasename(this.workingDir),
                this.instanceId,
                this.providerSessionId,
            );
        }
    }

    mergeRuntimeChatMessages(parsedMessages: ChatMessage[]): ChatMessage[] {
        return mergeConversationMessages(this.runtimeMessages, parsedMessages);
    }

    private promoteProviderSessionId(sessionId: string, opts: { authoritative?: boolean } = {}): void {
        const nextSessionId = String(sessionId || '').trim();
        if (!nextSessionId || nextSessionId === this.providerSessionId) return;

        // Sticky binding: once this instance is bound to a provider session,
        // an *observed* id (one discovered from a status parse or the native
        // history reader) must NOT hijack the live binding. hermes ≥0.14
        // spawns a fresh `sessions` row per internal sub-session, so a
        // newest-wins native read surfaces a different id mid-turn on every
        // poll; accepting it would re-bind the instance, re-hydrate unbounded
        // history (daemon saturation) and reset completion detection so the
        // turn never finalizes. Only an *authoritative* change — the first
        // bind (no id yet) or an explicit provider `new_session`/resume — may
        // replace an existing binding. Legitimate resume/new-session paths
        // pass authoritative:true and are unaffected.
        if (this.providerSessionId && !opts.authoritative) {
            LOG.debug('CLI', `[${this.type}] ignoring non-authoritative session id ${nextSessionId} (bound to ${this.providerSessionId})`);
            return;
        }

        const previousHistorySessionId = this.providerSessionId || this.instanceId;
        const previousProviderSessionId = this.providerSessionId;
        this.providerSessionId = nextSessionId;
        // Conversation-binding lock (antigravity): the moment this session is
        // authoritatively bound to a conversation uuid, claim it so a concurrent
        // sibling session's newest-on-disk discovery can never resolve to the
        // same .db (RCA: two antigravity sessions ~94ms apart shared one store
        // and cross-routed completions). Released on dispose().
        if (this.type === 'antigravity-cli') {
            const owner = this.antigravityClaimOwner();
            if (owner) claimAntigravityConversation(nextSessionId, owner);
        }
        this.historyWriter.promoteHistorySession(this.type, previousHistorySessionId, nextSessionId);
        this.historyWriter.writeSessionStart(this.type, nextSessionId, this.workingDir, this.instanceId);
        if (this.shouldHydrateExistingProviderHistory()) {
            this.restorePersistedHistoryFromCurrentSession();
        }
        this.adapter.updateRuntimeMeta({ providerSessionId: nextSessionId });
        this.onProviderSessionResolved?.({
            instanceId: this.instanceId,
            providerType: this.type,
            providerName: this.provider.name,
            workspace: this.workingDir,
            providerSessionId: nextSessionId,
            previousProviderSessionId,
        });
        LOG.info('CLI', `[${this.type}] discovered provider session id: ${nextSessionId}`);
    }

    private shouldHydrateExistingProviderHistory(): boolean {
        return this.launchMode === 'resume' || this.launchMode === 'manual';
    }

    private shouldSuppressFreshLaunchStartupReplay(parsedMessages: unknown[], parsedStatus: any, adapterStatus: any, parsedProviderSessionId = ''): boolean {
        if (this.launchMode !== 'new') return false;
        if (this.providerSessionId) return false;
        if (!Array.isArray(parsedMessages) || parsedMessages.length === 0) return false;
        if (!isIdleStatus(adapterStatus?.status) || !isIdleStatus(parsedStatus?.status)) return false;
        if (parsedProviderSessionId) return true;

        const newestMessageAt = parsedMessages.reduce<number>((newest, message) => Math.max(newest, getMessageTime(message)), 0);

        // Untimestamped idle parser output during a fresh launch is usually the
        // provider's last workspace transcript before a new turn exists.
        return newestMessageAt === 0;
    }

    private syncCanonicalSavedHistoryIfNeeded(options: { full?: boolean } = {}): boolean {
        if (!this.providerSessionId) return false;
        const canonicalHistory = this.provider.nativeHistory;
        if (!canonicalHistory) return false;

        // Per-status-report hydration reads only a bounded tail (snapshot needs at
        // most the newest 60). The once-per-resume restore path passes full:true
        // because seedSessionHistory needs the COMPLETE transcript to seed dedup
        // state. The read-cache key encodes the window so the bounded and full
        // reads don't share/clobber each other's 2s cache entry.
        const limit = options.full ? Number.MAX_SAFE_INTEGER : STATUS_HYDRATION_TAIL_LIMIT;
        const windowTag = options.full ? 'full' : `tail:${STATUS_HYDRATION_TAIL_LIMIT}`;

        // authority-ok: history-hydration READ routing, not a completion verdict. Selects
        // the on-disk native transcript vs the materialized-mirror read path; no
        // completion/stall/redrive decision is taken here.
        if (isNativeSourceCanonicalHistory(canonicalHistory)) {
            const cacheKey = [this.type, this.providerSessionId, this.workingDir, windowTag].join('\0');
            const now = Date.now();
            if (cacheKey === this.lastNativeSourceCanonicalCacheKey && now - this.lastNativeSourceCanonicalCheckAt < 2_000) {
                return true;
            }
            this.lastNativeSourceCanonicalCacheKey = cacheKey;
            this.lastNativeSourceCanonicalCheckAt = now;

            const restoredHistory = readProviderChatHistory(this.type, {
                canonicalHistory,
                historySessionId: this.providerSessionId,
                workspace: this.workingDir,
                offset: 0,
                limit,
                historyBehavior: this.provider.historyBehavior,
                scripts: this.provider.scripts as any,
            });
            if (restoredHistory.source === 'provider-native') {
                this.lastPersistedHistoryMessages = restoredHistory.messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                    kind: message.kind,
                    senderName: message.senderName,
                    receivedAt: message.receivedAt,
                }));
            }
            return true;
        }

        try {
            const cacheKey = [this.type, this.providerSessionId, this.workingDir, canonicalHistory.mode || 'materialized-mirror', windowTag].join('\0');
            const now = Date.now();
            if (cacheKey === this.lastNativeSourceCanonicalCacheKey && now - this.lastNativeSourceCanonicalCheckAt < 2_000) {
                return true;
            }
            this.lastNativeSourceCanonicalCacheKey = cacheKey;
            this.lastNativeSourceCanonicalCheckAt = now;

            if (!materializeProviderNativeHistory(this.type, canonicalHistory, this.providerSessionId, this.workingDir, this.provider.scripts as any)) {
                return false;
            }
            // Bounded by default: the per-status-report path only needs the newest
            // STATUS_HYDRATION_TAIL_LIMIT messages because the snapshot caps
            // activeChat.messages to the last 60 (status/normalize.ts) and loads
            // the rest lazily via read_chat on subscribe. The once-per-resume
            // restore path passes full:true so seedSessionHistory still sees the
            // COMPLETE transcript for prefix-dedup seeding. readChatHistory serves
            // a bounded limit as an O(tail) read.
            const restoredHistory = readChatHistory(this.type, 0, limit, this.providerSessionId, 0, this.provider.historyBehavior);
            this.lastPersistedHistoryMessages = restoredHistory.messages.map((message) => ({
                role: message.role,
                content: message.content,
                kind: message.kind,
                senderName: message.senderName,
                receivedAt: message.receivedAt,
            }));
            return true;
        } catch {
            return false;
        }
    }

    private restorePersistedHistoryFromCurrentSession(): void {
        if (!this.providerSessionId) return;
        // Restore is the once-per-resume seeding path: it needs the COMPLETE
        // transcript so seedSessionHistory can prime dedup state. Pass full so the
        // hydration read is unbounded here (and only here).
        this.syncCanonicalSavedHistoryIfNeeded({ full: true });
        // authority-ok: history-restore READ routing, not a completion verdict — picks the
        // native transcript read vs the legacy chat-history read for seeding dedup state.
        const restoredHistory = isNativeSourceCanonicalHistory(this.provider.nativeHistory)
            ? readProviderChatHistory(this.type, {
                canonicalHistory: this.provider.nativeHistory,
                historySessionId: this.providerSessionId,
                workspace: this.workingDir,
                offset: 0,
                limit: Number.MAX_SAFE_INTEGER,
                historyBehavior: this.provider.historyBehavior,
                scripts: this.provider.scripts as any,
            })
            : (() => {
                this.historyWriter.compactHistorySession(this.type, this.providerSessionId!, this.provider.historyBehavior);
                return readChatHistory(this.type, 0, Number.MAX_SAFE_INTEGER, this.providerSessionId, 0, this.provider.historyBehavior);
            })();
        this.historyWriter.seedSessionHistory(
            this.type,
            restoredHistory.messages,
            this.providerSessionId,
            this.instanceId,
        );
        this.lastPersistedHistoryMessages = restoredHistory.messages.map((message) => ({
            role: message.role,
            content: message.content,
            kind: message.kind,
            senderName: message.senderName,
            receivedAt: message.receivedAt,
        }));
        this.suppressIdleHistoryReplay = restoredHistory.messages.length > 0;
    }


}
