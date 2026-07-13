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
import { normalizeInteractivePrompt, normalizeInteractivePromptResponse, type InteractivePrompt } from './types/interactive-prompt.js';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import { shortHash } from '../system/hash.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import { createCliAdapter } from './spec/route.js';
import type { PtyRuntimeMetadata, PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter, isNativeSourceCanonicalHistory, materializeProviderNativeHistory, readChatHistory, readProviderChatHistory } from '../config/chat-history.js';
import { loadPersistedProviderSessionPins } from '../config/state-store.js';
import { LOG } from '../logging/logger.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { shouldCollectTraceCategory } from '../logging/debug-config.js';
import { traceMeshEventStage, traceMeshEventDrop } from '../mesh/mesh-event-trace.js';
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
import { buildChatMessage, buildRuntimeSystemChatMessage, isUserFacingChatMessage, normalizeChatMessages, resolveChatMessageKind, extractFinalSummaryFromMessages, extractFinalSummaryFromMessagesAfter, readChatMessageTimestampMs } from './chat-message-normalization.js';
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
    NATIVE_HISTORY_MESH_IDLE_SETTLE_MS,
    PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS,
    BACKGROUND_TASK_HOLD_MAX_MS,
    USER_INPUT_ACK_DEDUP_WINDOW_MS,
    STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS,
    TERMINAL_MESH_EVENTS,
} from './cli-provider-instance-types.js';
import type {
    CompletedDebouncePending,
    CompletedFinalizationBlock,
    CompletionFinalAssistantEvidence,
    ExternalTranscriptProbe,
} from './cli-provider-instance-types.js';
import { mergeConversationMessages, buildExternalTranscriptProbe } from './cli-provider-transcript-merge.js';
import { getEffectDedupKey, formatApprovalRequestMessage, formatMarkerTimestamp } from './cli-provider-effect-format.js';

// Re-export moved public symbols so existing importers (index.ts, tests) keep
// their `./cli-provider-instance.js` path. Pure move — no behavior change.
export { buildCliStructuredInputPrompt } from './cli-provider-input-prompt.js';
export { buildIncrementalHistoryAppendMessages } from './cli-provider-history-dedup.js';
export {
    computeTurnAnchoredDurationMs,
    getForcedNewSessionScriptName,
    waitForCliAdapterReady,
} from './cli-provider-status-helpers.js';

/**
 * The auto-approve settle-gate identity signature: the modal's question line plus
 * the NORMALIZED affirmative label, no volatile counters or raw button set. Shared
 * by the fire path (maybeAutoApproveStatus) and the mask-stall nudge so both compare
 * the SAME identity the settle clock tracks (AUTOAPPROVE-SETTLE-FLAP).
 */
function approvalModalSignature(message: unknown, affirmativeAnchor: string): string {
    return [typeof message === 'string' ? message.trim() : '', affirmativeAnchor].join('::');
}

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
    private static readonly AUTO_APPROVE_SETTLE_MS = 600;

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
    private static readonly AUTO_APPROVE_GATE_HYSTERESIS_MS = 1500;

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
    private static readonly AUTO_APPROVE_FLAP_CONTINUITY_MS = 6000;

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
    private static readonly AUTO_APPROVE_MASK_STALL_MS = 10500;

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
    private static readonly APPROVAL_STICKY_FLAP_MS = 4000;

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
    private cachedSqliteDb: {
        prepare(sql: string): { get(...values: Array<string | number>): unknown };
        close(): void;
    } | null = null;
    private cachedSqliteDbPath: string | null = null;
    private cachedSqliteDbMissingUntil = 0;
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
        this.adapter = createCliAdapter(provider as CliProviderModule, workingDir, cliArgs, options?.extraEnv || {}, transportFactory) as ProviderCliAdapter;
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
        if (this.cachedSqliteDbMissingUntil > now) return null;
        if (!fs.existsSync(resolvedDbPath)) {
            this.cachedSqliteDbMissingUntil = now + 10_000;
            return null;
        }

        const directories = this.getProbeDirectories();
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
        const placeholders = this.buildSqlPlaceholderList(directories.length);
        const query = probe.query.replace('{dirs}', placeholders);

        try {
            return this.querySqliteText(resolvedDbPath, query, [...directories, timestampParam]);
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

        // Dashboard-tail repair (native-source providers, e.g. antigravity): the
        // assistant answer lives only in native-history, so the PTY-parsed
        // statusMessages end on the user prompt / auto-approve system lines and the
        // snapshot's preview / lastMessageRole / completionMarker never see the
        // answer — the session looks stuck on the user turn. We already cached the
        // real final assistant summary at completion time (lastCompletionSummary),
        // so append it as the trailing assistant bubble when the current tail has no
        // assistant message at/after it. Purely additive to the status view; no
        // per-tick native read, no effect on providers whose PTY carries the
        // assistant (they surface it themselves and the guard below is a no-op).
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
    attachMeshAssignment(assignment: { meshId: string; nodeId?: string; taskId?: string; dispatchNonce?: number; coordinatorDaemonId?: string; coordinatorSessionId?: string }): void {
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
            const { meshActiveTaskId, meshActiveDispatchNonce, ...rest } = this.settings;
            void meshActiveTaskId; void meshActiveDispatchNonce;
            this.settings = rest;
            this.adapter.updateRuntimeSettings?.(this.settings);
            return;
        }
        const { meshNodeFor, meshNodeId, meshActiveTaskId, meshActiveDispatchNonce, ...rest } = this.settings;
        void meshNodeFor; void meshActiveTaskId; void meshActiveDispatchNonce;
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
                const response = normalizeInteractivePromptResponse(data);
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
        this.adapter.shutdown();
        this.monitor.reset();
        // Cancel any armed auto-approve timers so a pending settle re-check
        // can't fire resolveModal/detectStatusTransition against a dead adapter.
        if (this.autoApproveSettleTimer) { clearTimeout(this.autoApproveSettleTimer); this.autoApproveSettleTimer = null; }
        if (this.autoApproveBusyTimer) { clearTimeout(this.autoApproveBusyTimer); this.autoApproveBusyTimer = null; }
        this.appliedEffectKeys.clear();
        try { this.cachedSqliteDb?.close(); } catch { /* noop */ }
        this.cachedSqliteDb = null;
        this.cachedSqliteDbPath = null;
    }

    private completedDebounceTimer: NodeJS.Timeout | null = null;
    private completedDebouncePending: CompletedDebouncePending | null = null;
    private lastExternalCompletionProbe: ExternalTranscriptProbe | null = null;
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
    private lastCompletionSummary: { content: string; receivedAt: number } | null = null;

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

    private completionHasFinalAssistantMessage(messages: unknown, turnStartedAt?: number): boolean {
        const visibleMessages = (Array.isArray(messages) ? messages : [])
            .filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const role = typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : '';
        const content = lastVisible ? flattenContent(lastVisible.content).trim() : '';
        if (role !== 'assistant' || !content) return false;
        // Guard: if the last assistant message looks like an active approval/input prompt,
        // it is not a real completion — the session is still awaiting user input.
        if (looksLikeActiveApprovalPromptText(content)) return false;
        // FALSE-IDLE turn-boundary evidence (Defect 1b): when a producing-turn start is
        // known, the final assistant bubble must POST-DATE it. A STALE mid-turn assistant
        // (predating this turn's start — e.g. the last bubble of a prior sub-turn observed
        // during an inter-approval valley) must NOT satisfy the finalization gate, or a
        // false-idle blip emits a completion carrying that stale summary. A bubble with no
        // parseable timestamp cannot be proven stale, so it is kept (fails open — behaviour
        // identical to before for providers/paths that carry no timestamps).
        if (typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt) && turnStartedAt > 0) {
            // readChatMessageTimestampMs mirrors the summary turn-scoping reader
            // (extractFinalSummaryFromMessagesAfter) — same seconds-vs-ms heuristic and
            // field precedence — so the present-check and the summary-scope agree on which
            // bubbles predate the turn.
            const ts = readChatMessageTimestampMs(lastVisible);
            if (typeof ts === 'number' && ts < turnStartedAt) return false;
        }
        return true;
    }

    private recordPendingTranscriptProbe(pending: CompletedDebouncePending): ExternalTranscriptProbe | null {
        const probe = this.lastExternalCompletionProbe;
        if (!probe) return null;
        const history = pending.transcriptProbeHistory || [];
        const last = history[history.length - 1];
        if (!last || last.readAt !== probe.readAt || last.msgCount !== probe.msgCount || last.lastRole !== probe.lastRole || last.contentLen !== probe.contentLen) {
            history.push(probe);
            pending.transcriptProbeHistory = history.slice(-5);
        }
        return probe;
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

    private readExternalCompletionMessages(): unknown[] | null {
        const adapterOwnsMessagesElsewhere = (this.adapter as any)?.chatMessagesOwnedExternally === true;
        if (!adapterOwnsMessagesElsewhere) return null;
        if (!isNativeSourceCanonicalHistory(this.provider.nativeHistory)) return null;

        // Resolve a CONCRETE native-history handle for this session's OWN
        // conversation. A provider that exposes its session id on the CLI
        // (codex/claude/hermes) sets this.providerSessionId. antigravity takes no
        // --session-id, so this.providerSessionId stays empty — recover the real
        // on-disk conversation id from the read pin persisted across restart
        // (state.json sessionProviderSessionPins, keyed by this session's
        // instanceId — the same map a binding read_chat / mesh_read_chat records
        // the resolved uuid into). The OLD `if (!this.providerSessionId) return
        // null` guard blocked antigravity's completion transcript entirely, so its
        // final-assistant evidence was permanently 'unavailable' and the turn
        // completion never emitted → the mesh reconcile loop reclaimed the
        // "delivered but no completion" task and re-dispatched the same MAGI prompt
        // (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP, completion side).
        //
        // Prefer a concrete handle (providerSessionId, else the persisted pin). When
        // neither exists yet — a fresh antigravity turn whose conversation has not
        // been bound by any read_chat — fall through with an EMPTY handle and let the
        // dispatcher resolve this session's own conversations/<uuid>.db by the
        // spawn-floor + workspace + instanceId claim. This is safe now that the
        // claim owner token is single-form iid:<instanceId> (never collapses to '')
        // and pickUnboundConversationDb picks the oldest store born at/after THIS
        // session's floor: the probe resolves the session's OWN db under its own
        // owner token, so it can never steal a sibling's conversation (the earlier
        // theft required a floor=0 / owner='' collapse that no longer happens). It
        // means the completion summary is available on the FIRST completion — before
        // any read_chat has recorded a pin — which the dashboard tail-repair needs.
        let resolvedHandle = this.providerSessionId || '';
        if (!resolvedHandle) {
            try {
                const pinned = loadPersistedProviderSessionPins()[this.instanceId];
                if (typeof pinned === 'string' && pinned.trim()) resolvedHandle = pinned.trim();
            } catch { /* best-effort pin hydration */ }
        }

        if (this.lastExternalCompletionProbe?.sourcePath) {
            try { fs.statSync(this.lastExternalCompletionProbe.sourcePath); } catch { /* best-effort metadata refresh */ }
        }
        const restoredHistory = readProviderChatHistory(this.type, {
            canonicalHistory: this.provider.nativeHistory,
            historySessionId: resolvedHandle || undefined,
            workspace: this.workingDir,
            offset: 0,
            limit: Number.MAX_SAFE_INTEGER,
            historyBehavior: this.provider.historyBehavior,
            scripts: this.provider.scripts as any,
            sessionStartedAtMs: this.startedAt,
            // The claim owner token must match read_chat's so the exact-bind on our
            // own conversation stays idempotent rather than looking foreign, and so
            // the floor-based resolution above claims THIS session's db under its
            // own owner (never a sibling's).
            instanceId: this.instanceId,
            envOverrides: this.spawnedEnvOverrides(),
            forceRefresh: true,
        });
        if (restoredHistory.source !== 'provider-native') {
            this.lastExternalCompletionProbe = null;
            return null;
        }
        this.lastExternalCompletionProbe = buildExternalTranscriptProbe(
            restoredHistory.messages,
            restoredHistory.sourcePath,
            restoredHistory.sourceMtimeMs,
        );
        return restoredHistory.messages;
    }

    /**
     * The content of the LAST visible assistant bubble in a message list, or ''
     * when the tail is not an assistant reply. Skips trailing system/tool/activity
     * bubbles; stops (returns '') at the first user/human message. Used only for
     * the dashboard tail-repair cache — a display value, not a completion decision.
     */
    private lastVisibleAssistantSummary(messages: unknown): string {
        if (!Array.isArray(messages)) return '';
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i] as { role?: string; kind?: string; content?: unknown };
            const role = typeof m?.role === 'string' ? m.role : '';
            const kind = typeof m?.kind === 'string' ? m.kind : '';
            if (role === 'system') continue;
            if (kind === 'tool' || kind === 'activity') continue;
            if (role === 'user' || role === 'human') return '';
            if (role === 'assistant') return flattenContent(m.content as any).trim();
            return '';
        }
        return '';
    }

    private completionFinalAssistantEvidence(parsedMessages: unknown, turnStartedAt?: number): CompletionFinalAssistantEvidence {
        // (FALSEIDLE FixB) UPPER-BOUND turn-end evidence. completionHasFinalAssistantMessage is a
        // pure message-content check ("does the last visible bubble read as a finalized assistant
        // reply, post-dating the turn start?"). That LOWER bound alone treated the FIRST assistant
        // bubble of a turn that is STILL running — a tool call in flight between two assistant
        // bubbles — as proof the turn ended (RCA cases a & b). Require in ADDITION that the turn is
        // genuinely OVER: hasAdapterPendingResponse() folds the three upper-bound discriminators
        // into one — currentTurnScope closed, no in-flight tool (isProcessing false), and no partial
        // response buffer. So a mid-turn point-sample (short-gen / fast-collapse inline paths that
        // do NOT route through getCompletedFinalizationBlock) yields present=false and is held/settled
        // rather than fired. A genuinely-finished turn (adapter idle, no pending) is unaffected — the
        // gate stays open and the completion fires exactly as before. This mirrors the established
        // `completionHasFinalAssistantMessage(...) && !hasAdapterPendingResponse()` pairing already
        // used by the no-progress monitor reconcile path.
        const turnClosed = !this.hasAdapterPendingResponse();
        if (this.completionHasFinalAssistantMessage(parsedMessages, turnStartedAt)) {
            return {
                present: turnClosed,
                messages: Array.isArray(parsedMessages) ? parsedMessages : [],
                source: 'parsed',
            };
        }

        const externalMessages = this.readExternalCompletionMessages();
        if (externalMessages) {
            // ANTIGRAVITY-PREMATURE-COMPLETION (recur): the external-native transcript is
            // the WHOLE session's native-history, not turn-scoped by the provider. On a
            // reused-idle antigravity session, a completion-gate poll can run AFTER a new
            // task is injected but BEFORE that task's onTurnStarted fires. The transcript
            // then still tails the PRIOR turn's final-assistant bubble; completionHasFinal‑
            // AssistantMessage accepts it (turnStartedAt is 0/undefined pre-onTurnStarted →
            // fails open, or the prior bubble post-dates the prior turn → passes) and a
            // generating_completed fires for the NEW task BEFORE generating_started — the
            // exact live 06:34→06:35 inversion. Gate external-native evidence on the current
            // injected task having genuinely entered generating: if a task is attached but its
            // turn has not started (turnStartedInjectedTask() === false), the tail is stale by
            // construction, so this evidence must NOT satisfy the completion gate. Fail CLOSED
            // (present=false) rather than open. This does NOT regress the rc.480/481 win: once
            // the injected task's onTurnStarted fires, currentTurnStartedAt/currentTurnTaskId
            // bind to it and a real final bubble still fires completion normally.
            const injectedTaskGenerating = this.injectedTaskHasStartedGenerating();
            const present = injectedTaskGenerating
                && turnClosed
                && this.completionHasFinalAssistantMessage(externalMessages, turnStartedAt);
            // Dashboard tail-repair cache: this runs on EVERY completion check
            // (mesh AND non-mesh — the non-mesh path suppresses the
            // generating_completed emit, so completionFinalSummary never runs there
            // and cannot cache). Cache whenever the external transcript's LAST
            // visible bubble is an assistant reply — this is a display value only, so
            // it is intentionally looser than the strict `present` completion gate
            // (which also requires turnClosed and turn-scoping): the dashboard should
            // show the answer as soon as native-history has it, even if the FSM has
            // not yet ratified the turn end. getState() replaces it on the next turn.
            const lastVisibleAssistant = this.lastVisibleAssistantSummary(externalMessages);
            if (lastVisibleAssistant) {
                this.lastCompletionSummary = { content: lastVisibleAssistant, receivedAt: Date.now() };
            }
            return {
                present,
                messages: externalMessages,
                source: 'external-native',
            };
        }

        return {
            present: false,
            messages: Array.isArray(parsedMessages) ? parsedMessages : [],
            source: 'unavailable',
        };
    }

    private completionFinalSummary(parsedMessages: unknown, turnStartedAt?: number): string | undefined {
        // For native-source providers (claude-cli: chatMessagesOwnedExternally), the PTY
        // screen parse is NOT the source of truth for the final summary — the terminal
        // wraps/scrolls/clips text, so a screen-parsed assistant message is often a partial
        // prefix (e.g. 76 chars of a 112-char turn). The append-only native transcript holds
        // the complete turn. Prefer it whenever it yields a longer/complete summary; fall back
        // to the parsed screen only when the transcript is unavailable. This is the real cause
        // of the truncated finalSummary — independent of cloud vs standalone (it surfaces on
        // any short, fast-completing task where screen parse wins the race).
        //
        // NOTIF Defect-B: `turnStartedAt` (the producing turn's start, snapshotted on the
        // completedDebouncePending record) turn-scopes the NATIVE transcript read. The native
        // transcript holds the WHOLE session filtered only by session start, so a debounce that
        // flushes before the producing turn's final assistant bubble has landed would otherwise
        // return the PRIOR task's last bubble (event taskId=B but summary=A). Filtering to bubbles
        // at/after turnStartedAt yields '' in that race instead of the stale tail; the weak/empty
        // summary is later upgraded by the mesh reconcile loop once the real bubble is written.
        const adapterOwnsMessagesElsewhere = (this.adapter as any)?.chatMessagesOwnedExternally === true;
        // FALSE-IDLE Defect 1b: turn-scope the PARSED screen fallback too. Without this a stale
        // mid-turn assistant (predating turnStartedAt) that the turn-boundary gate already
        // rejected as evidence could still leak into the finalSummary via this parsed fallback
        // when the external transcript's turn-scoped read is empty — freezing the very stale text
        // the gate rejected. extractFinalSummaryFromMessagesAfter drops bubbles before the turn
        // start; with no boundary known (turnStartedAt falsy) it is identical to the unscoped read.
        const parsedSummary = extractFinalSummaryFromMessagesAfter(
            (this.completionHasFinalAssistantMessage(parsedMessages, turnStartedAt)
                ? (Array.isArray(parsedMessages) ? parsedMessages : [])
                : []) as any,
            turnStartedAt,
        );
        if (adapterOwnsMessagesElsewhere) {
            const externalMessages = this.readExternalCompletionMessages();
            // Turn-scope the external transcript: never return a bubble produced before this
            // turn started. With no boundary known (turnStartedAt falsy) behaviour is unchanged.
            const externalSummary = externalMessages
                ? extractFinalSummaryFromMessagesAfter(externalMessages as any, turnStartedAt)
                : '';
            // The transcript is authoritative for native-source providers. Use it unless it is
            // empty (not yet written, or no in-turn bubble) — only then fall back to the screen
            // parse, which reflects the LIVE screen (this turn's output), not the stale tail.
            if (externalSummary) {
                // Cache the resolved final assistant for the dashboard tail-repair in
                // getState(). This runs on EVERY completion attempt (including non-mesh
                // sessions whose generating_completed is suppressed, and short-gen
                // settle paths), so the dashboard sees the answer even when no
                // agent:generating_completed is ever emitted. Native read already ran.
                this.lastCompletionSummary = { content: externalSummary, receivedAt: Date.now() };
                return externalSummary;
            }
            return parsedSummary || undefined;
        }
        return parsedSummary || undefined;
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

        const evidence = this.completionFinalAssistantEvidence(parsed?.messages);
        if (evidence.source === 'external-native') {
            this.recordPendingTranscriptProbe(args.pending);
        }
        const visibleMessages = (Array.isArray(evidence.messages) ? evidence.messages : [])
            .filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const lastVisibleRole = typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : null;
        const lastVisibleKind = typeof (lastVisible as any)?.kind === 'string' ? (lastVisible as any).kind : null;
        const lastVisibleContentLength = lastVisible ? flattenContent(lastVisible.content).trim().length : 0;

        return {
            providerType: this.type,
            sessionId: this.instanceId,
            providerSessionId: this.providerSessionId || null,
            workspace: this.workingDir,
            blockReason: args.blockReason,
            emittedAfterFinalizationTimeout: args.emittedAfterFinalizationTimeout,
            waitedMs: args.waitedMs,
            maxWaitMs: COMPLETED_FINALIZATION_MAX_WAIT_MS,
            adapterStatus: typeof args.latestStatus?.status === 'string' ? args.latestStatus.status : null,
            latestVisibleStatus: args.latestVisibleStatus,
            parsedStatus: typeof parsed?.status === 'string' ? parsed.status : (parseError ? 'parse_error' : 'unknown'),
            parseError: parseError || undefined,
            finalAssistantPresent: evidence.present,
            finalAssistantEvidenceSource: evidence.source,
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

    private getCompletedFinalizationBlock(latestVisibleStatus: string, pending: CompletedDebouncePending): CompletedFinalizationBlock | null {
        if (latestVisibleStatus !== 'idle') return { reason: `status:${latestVisibleStatus}`, terminal: true };

        const adapterAny = this.adapter as any;
        const approvalResolvedIdle = pending.previousStatus === 'waiting_approval';
        // (FALSEIDLE-a FixA) The adapter pending-response checks run UNCONDITIONALLY.
        // Previously they were SKIPPED when approvalResolvedIdle, on the assumption that
        // a waiting_approval→idle transition proved the approval's turn was over. But
        // auto-approve RESOLVES the modal and the agent RESUMES the same turn — currentTurnScope
        // / isWaitingForResponse stay set, or a tool runs — so skipping the guard let the FIRST
        // assistant bubble of the still-running turn be mistaken for the last and fired an early
        // completion the coordinator could never correct (RCA case a). Keep the guard live for the
        // approval path too: when the resumed turn genuinely ends these clear and the completion
        // fires. Approval-resolved holds are NON-terminal (bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS)
        // so a provider that never closes its turn-scope still force-fires a weak completion rather
        // than wedging; the non-approval path keeps its terminal hold (a genuinely-busy adapter must
        // never force a completion out).
        if (adapterAny?.isWaitingForResponse === true) return { reason: 'adapter_waiting_for_response', terminal: !approvalResolvedIdle };
        if (adapterAny?.currentTurnScope) return { reason: 'adapter_turn_scope_active', terminal: !approvalResolvedIdle };
        if (this.hasAdapterPendingResponse()) return { reason: 'adapter_pending_response', terminal: !approvalResolvedIdle };

        // (FALSE-IDLE, Fix 1) SETTLE-VALLEY hold extension for the generating→idle valley.
        // The existing SETTLE-VALLEY hold below only covers previousStatus==='waiting_approval'.
        // But when auto-approve RESOLVES a modal the engine flips straight to 'generating'
        // (resolveModal → setStatus('generating')), so the resumed turn's brief inter-approval
        // quiet valley arrives with previousStatus==='generating' and a recorded mid-turn
        // assistant bubble — which satisfies every gate below and fires an early completion
        // mid-turn (RCA: same session re-enters waiting_approval ~13s later). Here we HOLD:
        // by this point the adapter's own pending-response evidence (above) is clean — the
        // engine has torn down currentTurnScope/isWaitingForResponse in the valley — so we
        // rely on the approval-resume recency signal instead. Non-terminal, so the retry loop
        // re-runs the resume guard (busy_reentry / new_pty_output / resumed_status in the
        // flush) and cancels the moment the turn actually resumes; and it clears on its own
        // once the grace window lapses (a turn that genuinely ended right after an approval
        // then emits normally). Bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS as a hard floor
        // against a wedge. Scoped by inApprovalResumeGrace to autonomous auto-approving mesh
        // sessions with a recent resolveModal, so a plain non-approval turn is untouched.
        if (!approvalResolvedIdle && this.inApprovalResumeGrace()) {
            return { reason: 'approval_resume_grace', terminal: false };
        }

        const partial = typeof this.adapter.getPartialResponse === 'function'
            ? this.adapter.getPartialResponse()
            : '';
        if (typeof partial === 'string' && partial.trim()) return { reason: 'partial_response_pending', terminal: true };

        let parsed: any;
        try {
            parsed = this.adapter.getScriptParsedStatus();
        } catch (error: any) {
            return { reason: `parse_error:${error?.message || String(error)}` };
        }

        const parsedStatus = typeof parsed?.status === 'string' ? parsed.status : 'unknown';
        if (parsedStatus !== 'idle') {
            const adapterStatus = this.adapter.getStatus({ allowParse: false });
            if (this.shouldSuppressStaleParsedBusyStatus(parsed, adapterStatus)) return null;
            return { reason: `parsed_status:${parsedStatus}`, terminal: isCliGeneratingLikeStatus(parsedStatus) };
        }
        if (parsed?.activeModal || parsed?.modal) return { reason: 'parsed_modal_active', terminal: true };
        const adapterOwnsMessagesElsewhere = (this.adapter as any)?.chatMessagesOwnedExternally === true;
        // FALSE-IDLE turn-boundary evidence (Defect 1b): turn-scope the present-check so a
        // STALE mid-turn assistant (predating pending.turnStartedAt) cannot satisfy the
        // finalization gate. Only the confirming final-assistant bubble that POST-DATES this
        // turn's start counts as evidence the turn genuinely ended.
        const finalAssistantEvidence = this.completionFinalAssistantEvidence(parsed?.messages, pending.turnStartedAt);
        const allowMissingAssistantTimeout = !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator);
        LOG.debug('CLI', `[${this.type}] finalAssistantEvidence: present=${finalAssistantEvidence.present} source=${finalAssistantEvidence.source} adapterOwnsMessagesElsewhere=${adapterOwnsMessagesElsewhere} parsedStatus=${parsedStatus}`);
        if (!finalAssistantEvidence.present) {
            if (adapterOwnsMessagesElsewhere) {
                if (finalAssistantEvidence.source === 'external-native') {
                    const probe = this.recordPendingTranscriptProbe(pending);
                    if (probe && !pending.loggedTranscriptProbe) {
                        LOG.info('CLI', `[${this.type}] external transcript probe: msgCount=${probe.msgCount} lastRole=${probe.lastRole || 'none'} lastKind=${probe.lastKind || 'none'} contentLen=${probe.contentLen} sourceMtime=${probe.sourceMtimeMs ?? 'unknown'} mtimeAge=${probe.mtimeAgeMs ?? 'unknown'}ms`);
                        pending.loggedTranscriptProbe = true;
                    }
                    LOG.debug('CLI', `[${this.type}] external-native probe result: lastRole=${probe?.lastRole} contentLen=${probe?.contentLen}`);
                    if (probe?.lastRole === 'assistant' && (probe.contentLen ?? 0) > 0) {
                        return null;
                    }
                    // (FALSE-IDLE-MIDTURN antigravity) A native-history session whose
                    // external-native transcript has NO in-turn final assistant bubble yet
                    // (present=false AND the probe's tail is not an assistant reply) is NOT
                    // proven done. antigravity previously returned null here — an IMMEDIATE
                    // clean emit with zero transcript evidence — so a momentary PTY-parser
                    // idle blip MID-TURN (the parser reads idle while the turn is still in
                    // flight and the transcript's answer has not landed) fired an early
                    // agent:generating_completed the coordinator could never correct. Instead
                    // HOLD for the transcript: re-probe each retry (readExternalCompletionMessages
                    // runs forceRefresh every call) and clear the block only once the assistant
                    // turn actually lands (the probe branch above → genuine emit). Non-terminal
                    // and bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS (30s) so a turn that
                    // genuinely produced no assistant bubble (tool-only) still force-emits a weak
                    // completion rather than wedging — preserving the a0fb6b05 "antigravity always
                    // eventually emits" fix while filtering the mid-turn false-idle. Scoped to
                    // autonomous mesh sessions (allowMissingAssistantTimeout) so an interactive
                    // antigravity session, which has no coordinator to misfire at, is untouched.
                    if (this.type === 'antigravity-cli') {
                        if (allowMissingAssistantTimeout) {
                            return { reason: 'missing_final_assistant', terminal: false, holdForTranscript: true };
                        }
                        return null;
                    }
                    // (SETTLE-VALLEY) The inter-approval idle valley: a native-history mesh worker
                    // that resolved an approval and fell briefly idle (waiting_approval→idle) BEFORE
                    // the next approval turn resumes. The live valley (~3s) is mostly covered by the
                    // 4000ms NATIVE_HISTORY_MESH_IDLE_SETTLE_MS settle window, but a longer valley can
                    // still let the flush run while the transcript's final assistant turn is not yet
                    // written (source still the screen parse → finalAssistantPresent=false,
                    // workerResult.source='default'). CANON-C would emit immediately here, freezing a
                    // truncated preamble summary as evidenceLevel=insufficient. Instead HOLD: this
                    // waiting_approval hold complements the settle window. Retry until the transcript finalizes
                    // (block clears → genuine emit) or the worker resumes (resume guard cancels),
                    // bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS. Scoped to the approval-resolved
                    // idle so a genuinely-finished background-child turn keeps the CANON-C immediate
                    // emit (its transcript trails by a write, not by a whole resume).
                    if (allowMissingAssistantTimeout && pending.previousStatus === 'waiting_approval') {
                        return { reason: 'missing_final_assistant', terminal: false, holdForTranscript: true };
                    }
                    return { reason: 'missing_final_assistant', terminal: true, allowTimeout: allowMissingAssistantTimeout };
                }
                if ((this.provider as any).requiresFinalAssistantBeforeIdle === true) {
                    return { reason: 'missing_final_assistant', terminal: true, allowTimeout: allowMissingAssistantTimeout };
                }
            } else {
                LOG.debug('CLI', `[${this.type}] missing_final_assistant (not ownsExternal) requiresFinalAssistant=${!!(this.provider as any).requiresFinalAssistantBeforeIdle}`);
                return {
                    reason: 'missing_final_assistant',
                    terminal: (this.provider as any).requiresFinalAssistantBeforeIdle === true,
                    allowTimeout: allowMissingAssistantTimeout,
                };
            }
        }

        // (FALSEIDLE-a) Structural approval-resolution gate. Runs BEFORE the brittle
        // screen-text heuristic below so it also catches modals whose text does not match
        // looksLikeActiveApprovalPromptText (e.g. claude-cli's cd / "untrusted hooks" prompt).
        const approvalResolutionBlock = this.approvalResolutionFinalizationBlock(pending);
        if (approvalResolutionBlock) return approvalResolutionBlock;

        // Guard: if the screen still shows an approval/choice prompt as the last visible text,
        // the turn is not complete even if the parsed status says idle and there is an assistant
        // message. This catches the case where waiting_approval→idle transitions occur before
        // the modal has been resolved (e.g. the PTY rendered the prompt but no button press fired).
        try {
            const screenText = typeof (this.adapter as any).getScreenText === 'function'
                ? String((this.adapter as any).getScreenText() || '')
                : '';
            if (screenText) {
                const tailLines = screenText.split(/\r?\n/).slice(-16).join('\n');
                if (looksLikeActiveApprovalPromptText(tailLines)) {
                    return { reason: 'screen_shows_approval_prompt', terminal: approvalResolvedIdle };
                }
            }
        } catch { /* defensive: screen text read is best-effort */ }

        // (FALSE-IDLE-MIDTURN codex/PTY) The turn-complete quiet-dwell gate. We only reach
        // here with finalAssistantEvidence.present === true. For a PTY-PARSED provider
        // (codex: !adapterOwnsMessagesElsewhere), that "present" verdict is derived from the
        // on-screen assistant text, which can be a PARTIAL sentence fragment captured mid-stream
        // when the FSM momentarily read idle. completionHasFinalAssistantMessage accepts the
        // fragment and hasAdapterPendingResponse can transiently read clean between chunks, so
        // present flips true mid-turn and this path would clean-emit an early completion. The
        // flush's lastOutputAt continuity guard only cancels when NEW output ARRIVES during the
        // settle — it cannot catch a turn that fell quiet just before the arm. Require instead a
        // minimum QUIET DWELL since the last raw PTY output: a genuinely finished turn's screen
        // has been stable well past this bound, whereas a mid-stream fragment either just received
        // output or is about to. Non-terminal HOLD (bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS),
        // so a real completion re-passes the gate one retry later once the dwell is met; and it
        // force-emits at the 30s cap rather than wedging. Scoped to autonomous mesh sessions
        // (allowMissingAssistantTimeout) and PTY-parsed sources only — native-history providers
        // (antigravity/claude) resolve evidence from the authoritative transcript above, not the
        // screen, so this dwell does not apply to them and interactive sessions are untouched.
        if (allowMissingAssistantTimeout
            && !adapterOwnsMessagesElsewhere
            && finalAssistantEvidence.source === 'parsed') {
            try {
                const outStatus = this.adapter.getStatus({ allowParse: false }) as any;
                const lastOutputAt = typeof outStatus?.lastOutputAt === 'number' && Number.isFinite(outStatus.lastOutputAt)
                    ? outStatus.lastOutputAt as number
                    : undefined;
                if (typeof lastOutputAt === 'number') {
                    const quietMs = Date.now() - lastOutputAt;
                    if (quietMs < PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS) {
                        return { reason: 'parsed_final_assistant_quiet_dwell', terminal: false };
                    }
                }
            } catch { /* defensive: dwell read is best-effort — fall through to emit */ }
        }

        return null;
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
    private autoApproveContinuityWindowMs(): number {
        return this.autoApproveMaskSince > 0 && this.isAutonomousMeshSession()
            ? CliProviderInstance.AUTO_APPROVE_FLAP_CONTINUITY_MS
            : CliProviderInstance.AUTO_APPROVE_GATE_HYSTERESIS_MS;
    }

    /**
     * The settle-gate identity signature for a raw activeModal, or null when the
     * modal is NOT a concrete auto-approvable consent prompt (no captured buttons,
     * a picker/confirm kind, or no reliable affirmative+decline anchor). Mirrors the
     * gates the auto-approve fire path applies before computing modalSignature, so
     * the mask-stall nudge can ask the SAME question the settle gate is tracking —
     * "is THIS frame's modal the identity the settle clock is accruing against?" —
     * without duplicating the button-pick logic. The signature is message +
     * normalized affirmative label only (no volatile counters/button set), matching
     * the fire path exactly (AUTOAPPROVE-SETTLE-FLAP).
     */
    private approvableModalSignature(modal: any): string | null {
        const buttons = Array.isArray(modal?.buttons)
            ? modal.buttons.map((b: any) => String(b || '').trim()).filter(Boolean)
            : [];
        if (!modal || buttons.length === 0) return null;
        const modalKind = typeof modal?.kind === 'string' ? modal.kind : 'approval';
        if (modalKind !== 'approval') return null;
        const { index: buttonIndex, label: buttonLabel } = pickApprovalButton(buttons, this.provider);
        const hasReliableConsentAnchor = hasNegativeApprovalOption(buttons)
            || hasReliableApprovalAffirmative(buttons);
        if (buttonIndex < 0 || !hasReliableConsentAnchor) return null;
        return approvalModalSignature(modal?.message, normalizeApprovalLabel(buttonLabel));
    }

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
        if (!this.isAutonomousMeshSession() || !this.shouldAutoApprove()) return false;
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

    private flushCompletedDebounceIfFinalized(): void {
        const pending = this.completedDebouncePending;
        if (!pending) {
            this.completedDebounceTimer = null;
            return;
        }

        const latestStatus = this.adapter.getStatus({ allowParse: false });
        const latestAutoApproveActive = latestStatus.status === 'waiting_approval' && this.shouldAutoApprove();
        const latestVisibleStatus = latestAutoApproveActive || this.autoApproveBusy ? 'generating' : latestStatus.status;
        LOG.debug('CLI', `[${this.type}] flush attempt: adapterStatus=${latestStatus.status} latestVisible=${latestVisibleStatus} generatingStartedAt=${this.generatingStartedAt} isWaitingForResponse=${!!(this.adapter as any)?.isWaitingForResponse} hasPartial=${!!this.adapter.getPartialResponse?.()}`);
        if (latestVisibleStatus !== 'idle') {
            LOG.info('CLI', `[${this.type}] cancelled pending completed (resumed ${latestVisibleStatus})`);
            if (this.completionTraceOn()) this.recordCompletionGateTrace('cancel', {
                blockReason: 'resumed_status',
                latestVisibleStatus,
                previousStatus: pending.previousStatus,
                busyEpochAtArm: pending.busyEpochAtArm,
                busyEpoch: this.busyEpoch,
            });
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            return;
        }

        // FALSE-IDLE continuity guard (Defect 1a): the point-sample above only proves the
        // session is idle at THIS instant. A momentary busy→idle blip inside an inter-approval
        // valley (auto-approved tool turns) opens AND closes a generating phase entirely within
        // the settle window — so the single sample reads 'idle' even though the turn is still in
        // flight (it re-enters generating ~0.5s later). Require instead that the session stayed
        // CONTINUOUSLY idle since the debounce was armed: (1) no entry into a busy phase
        // (busyEpoch unchanged), and (2) no new raw PTY output (lastOutputAt did not advance).
        // Either signal ⇒ the idle was not continuous ⇒ cancel; the still-live turn re-arms its
        // own completion when it genuinely finishes. This only ever cancels (never emits more),
        // so shared behaviour for claude/codex/antigravity is strictly stricter, never looser.
        if (typeof pending.busyEpochAtArm === 'number' && this.busyEpoch !== pending.busyEpochAtArm) {
            LOG.info('CLI', `[${this.type}] cancelled pending completed (busy re-entry during settle: epoch ${pending.busyEpochAtArm}→${this.busyEpoch})`);
            if (this.completionTraceOn()) this.recordCompletionGateTrace('cancel', {
                blockReason: 'busy_reentry',
                latestVisibleStatus,
                previousStatus: pending.previousStatus,
                busyEpochAtArm: pending.busyEpochAtArm,
                busyEpoch: this.busyEpoch,
                busyEpochDelta: this.busyEpoch - pending.busyEpochAtArm,
            });
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            return;
        }
        const latestOutputAt = typeof (latestStatus as any)?.lastOutputAt === 'number' ? (latestStatus as any).lastOutputAt as number : undefined;
        if (typeof pending.lastOutputAtArm === 'number'
            && typeof latestOutputAt === 'number'
            && latestOutputAt > pending.lastOutputAtArm) {
            LOG.info('CLI', `[${this.type}] cancelled pending completed (new PTY output during settle: ${pending.lastOutputAtArm}→${latestOutputAt})`);
            if (this.completionTraceOn()) this.recordCompletionGateTrace('cancel', {
                blockReason: 'new_pty_output',
                latestVisibleStatus,
                previousStatus: pending.previousStatus,
                lastOutputAtArm: pending.lastOutputAtArm,
                lastOutputAt: latestOutputAt,
                lastOutputAtDelta: latestOutputAt - pending.lastOutputAtArm,
            });
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            return;
        }

        // (FALSE-IDLE-BACKGROUND-CMD) FOURTH hold condition: claude-cli's idle/generating
        // judgment is PTY-screen-derived and has no awareness of its own run_in_background
        // bash jobs. When a background bash is launched and the parent turn returns to a
        // ready prompt, the parent turn is genuinely idle → the point-sample above reads
        // 'idle' → a false agent:generating_completed would fire while the background job
        // is still running. The durable signal is the native-history transcript: a
        // background bash tool_use with NO matching tool_result is an unresolved job.
        // getScriptParsedStatus() reads that transcript at poll time and surfaces
        // backgroundTaskActive. When set, HOLD (re-arm) instead of emitting — the flag
        // clears once the tool_result lands, at which point a later flush proceeds normally.
        //
        // ★Bounded against a permanent wedge: the signal is a MISSING tool_result in an
        // append-only file, so a killed/crashed/never-finishing background job would leave
        // the flag stuck true forever. BACKGROUND_TASK_HOLD_MAX_MS (5min) caps the total
        // hold: once exceeded we stop holding on this signal alone and fall through to the
        // normal finalization path (emit). This guarantees eventual release — a stuck
        // background job can delay, never permanently pin, the completion.
        const bgParsed = (() => {
            try { return this.adapter.getScriptParsedStatus?.() as { backgroundTaskActive?: boolean; backgroundTaskCount?: number } | undefined; }
            catch { return undefined; }
        })();
        if (bgParsed?.backgroundTaskActive === true) {
            if (typeof pending.backgroundTaskHoldSince !== 'number') pending.backgroundTaskHoldSince = Date.now();
            const heldMs = Date.now() - pending.backgroundTaskHoldSince;
            if (heldMs < BACKGROUND_TASK_HOLD_MAX_MS) {
                if (pending.loggedBlockReason !== 'background_task_active') {
                    LOG.info('CLI', `[${this.type}] holding pending completed (background_task_active count=${bgParsed.backgroundTaskCount ?? '?'} heldMs=${heldMs} max=${BACKGROUND_TASK_HOLD_MAX_MS})`);
                    if (this.completionTraceOn()) this.recordCompletionGateTrace('hold', {
                        blockReason: 'background_task_active',
                        latestVisibleStatus,
                        previousStatus: pending.previousStatus,
                        backgroundTaskCount: bgParsed.backgroundTaskCount ?? null,
                        heldMs,
                    });
                    pending.loggedBlockReason = 'background_task_active';
                }
                this.scheduleCompletedDebounceFlush(COMPLETED_FINALIZATION_RETRY_MS);
                return;
            }
            // Hold cap exceeded — stop deferring on the background signal; the background
            // job is not clearing. Fall through to normal finalization so the completion
            // is never pinned indefinitely.
            LOG.warn('CLI', `[${this.type}] background_task_active hold cap exceeded (heldMs=${heldMs} >= ${BACKGROUND_TASK_HOLD_MAX_MS}); releasing to normal finalization`);
        } else if (typeof pending.backgroundTaskHoldSince === 'number') {
            // The background job resolved during the hold — clear the marker so a later
            // re-hold (if a new background job starts) restarts the cap window.
            pending.backgroundTaskHoldSince = undefined;
            if (pending.loggedBlockReason === 'background_task_active') pending.loggedBlockReason = undefined;
        }

        const block = this.getCompletedFinalizationBlock(latestVisibleStatus, pending);
        if (block) {
            const blockReason = block.reason;
            const waitedMs = Date.now() - pending.firstObservedAt;
            // CANON-C (completion-gate decouple): a block carrying `allowTimeout` is the
            // transcript-evidence gate — the worker FSM has ALREADY reached idle and the only
            // thing missing is the append-only transcript's final assistant turn (a native-source
            // race: claude-cli owns its history externally and the file write trails the idle
            // transition). `allowTimeout` is set ONLY on the missing_final_assistant block, and
            // ONLY for mesh worker sessions (meshNodeFor / meshActiveTaskId / launchedByCoordinator).
            // The coordinator's sole path to learn this session is idle is agent:generating_completed,
            // so holding it up to COMPLETED_FINALIZATION_MAX_WAIT_MS (30s) leaves the coordinator
            // false-generating while the worker is done. Decouple the idle NOTIFICATION from the
            // transcript evidence: emit the completion immediately, marked weak
            // (completionDiagnostic.blockReason=missing_final_assistant, finalAssistantPresent=false).
            // The finalSummary is enriched on a SEPARATE path — the mesh reconcile loop reads the
            // transcript once written and re-emits a GENUINE completion (CANON-B weak→genuine
            // upgrade; buildPendingEventFingerprint keeps weak and genuine distinct so the enriched
            // one still surfaces, and isFalseIdleCompletion keeps the direct dispatch active until
            // then). All OTHER blocks (genuinely-busy adapter/partial/parsed states, transient
            // parse_error) keep the existing terminal-hold / 30s-retry behavior unchanged.
            //
            // (SETTLE-VALLEY) Exception: a `holdForTranscript` block is the inter-approval idle
            // valley of a native-history mesh worker (waiting_approval→idle that will resume into
            // the next approval). It deliberately does NOT carry allowTimeout, so it falls into the
            // hold-and-retry path below (terminal:false) rather than the CANON-C immediate emit —
            // the retry loop re-runs the resume guard each cycle, so when the worker resumes the
            // pending completion is cancelled, and when the transcript's final assistant arrives the
            // block clears for a GENUINE emit. This blocks the truncated weak (insufficient) summary
            // from ever being emitted during the valley, without depending on the valley's length.
            const isTranscriptEvidenceGate = block.allowTimeout === true;
            LOG.debug('CLI', `[${this.type}] finalization block: reason=${blockReason} terminal=${block.terminal} allowTimeout=${isTranscriptEvidenceGate} waitedMs=${waitedMs} maxWait=${COMPLETED_FINALIZATION_MAX_WAIT_MS}`);
            if (!isTranscriptEvidenceGate && (block.terminal || waitedMs < COMPLETED_FINALIZATION_MAX_WAIT_MS)) {
                if (pending.loggedBlockReason !== blockReason) {
                    LOG.info('CLI', `[${this.type}] waiting to emit completed until transcript finalizes (${blockReason})`);
                    // EVTTRACE: completion held by the finalization gate (CANON-C). Observation
                    // only — does not change the hold decision above.
                    if (this.isMeshWorkerSession()) {
                        traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `${blockReason} waited=${waitedMs}ms`);
                    }
                    // COMPLETION-EARLYNOTIFY: a hold is the CORRECT outcome when the turn is not
                    // yet proven done (the FixA/FixB gates route here); trace it so an early-notify
                    // investigation can see the gate holding rather than firing.
                    if (this.completionTraceOn()) this.recordCompletionGateTrace('hold', {
                        blockReason,
                        latestVisibleStatus,
                        terminal: block.terminal === true,
                        holdForTranscript: block.holdForTranscript === true,
                        approvalResolvedIdle: pending.previousStatus === 'waiting_approval',
                        waitedMs,
                    });
                    pending.loggedBlockReason = blockReason;
                }
                this.scheduleCompletedDebounceFlush(COMPLETED_FINALIZATION_RETRY_MS);
                return;
            }
            const emittedAfterFinalizationTimeout = waitedMs >= COMPLETED_FINALIZATION_MAX_WAIT_MS;
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
            (completionDiagnostic as Record<string, unknown>).decoupledImmediateEmit = isTranscriptEvidenceGate && !emittedAfterFinalizationTimeout;
            LOG.warn('CLI', `[${this.type}] emitting completed event (${isTranscriptEvidenceGate && !emittedAfterFinalizationTimeout ? 'CANON-C decoupled-immediate, transcript pending' : `after ${waitedMs}ms`}) without finalized assistant turn (${blockReason})`);
            // EVTTRACE: completion fired (forced past the finalization timeout / CANON-C decoupled-immediate).
            if (this.isMeshWorkerSession()) {
                traceMeshEventStage('fired', this.meshTraceCtx(), `forced after ${waitedMs}ms (${blockReason})`);
            }
            if (this.completionTraceOn()) this.recordCompletionGateTrace('fire', {
                path: isTranscriptEvidenceGate && !emittedAfterFinalizationTimeout ? 'canon_c_decoupled' : 'forced_timeout',
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
                // When finalization is forced past the timeout on a `parsed_status:` block
                // (the parser never confirmed a final assistant turn) we previously rode an
                // empty `finalSummary` unconditionally. That empty value propagates to the
                // mesh coordinator's mirror preview (meshSessionLastMessagePreview), leaving a
                // delegated session's inbox preview blank — or, for a LOCAL worktree session,
                // stuck on the dispatched user task. If the parser DID surface assistant text,
                // prefer it; only fall back to '' when no assistant summary can be derived.
                finalSummary: blockReason.startsWith('parsed_status:')
                    ? (this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages, pending.turnStartedAt) ?? '')
                    : this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages, pending.turnStartedAt),
                completionDiagnostic,
            });
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            this.generatingStartedAt = 0;
            this.lastApprovalEventFingerprint = '';
            return;
        }

        LOG.info('CLI', `[${this.type}] completed in ${pending.duration}s`);
        // EVTTRACE: completion fired (transcript finalized cleanly).
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
        this.emitGeneratingCompleted({
            chatTitle: pending.chatTitle,
            duration: pending.duration,
            timestamp: pending.timestamp,
            taskId: pending.taskId,
            finalSummary: this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages, pending.turnStartedAt),
        });
        this.completedDebouncePending = null;
        this.completedDebounceTimer = null;
        this.generatingStartedAt = 0;
        this.lastApprovalEventFingerprint = '';
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
        this.pushEvent({
            event: 'agent:generating_completed',
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
        });
    }

    /**
     * AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval overlay. Returns the adapterStatus a
     * flap-prone claude-cli approval SHOULD present this frame — either the raw status
     * unchanged, or, when the raw status has momentarily flapped OFF a recently-dominant
     * concrete approval, a synthetic `waiting_approval` re-presenting the cached modal.
     *
     * Records the concrete approval whenever the raw status is waiting_approval WITH
     * buttons. On a subsequent non-approval frame (the spec `approval→busy` flap), if that
     * concrete approval was seen within APPROVAL_STICKY_FLAP_MS AND the engine has NOT
     * resolved a modal since (lastApprovalResolvedAt not advanced past the sticky start),
     * overlay the cached modal + waiting_approval so the inbox / auto-approve / mesh_approve
     * all see the stable approval. A genuine resolution (auto-approve or mesh_approve fires
     * resolveModal → lastApprovalResolvedAt advances) clears the sticky immediately, so a
     * legitimate post-approval resume is NEVER masked as a lingering approval. Bounded by the
     * window, and scoped to autonomous mesh sessions (a foreground/attended or non-mesh
     * session, where a human answers the prompt, is returned untouched).
     */
    private stabilizeFlappingApprovalStatus(adapterStatus: any, now = Date.now()): any {
        // Only autonomous auto-approving mesh sessions are subject to the delegated flap;
        // never overlay for attended/foreground/non-mesh sessions.
        if (!this.isAutonomousMeshSession() || !this.shouldAutoApprove()) return adapterStatus;

        const rawStatus = adapterStatus?.status;
        const resolvedAt = typeof (this.adapter as any)?.lastApprovalResolvedAt === 'number'
            ? (this.adapter as any).lastApprovalResolvedAt as number
            : 0;

        if (rawStatus === 'waiting_approval') {
            // A concrete modal this frame refreshes the sticky anchor; an approval frame
            // with buttons momentarily scrolled out is left to the existing settle-gate
            // hysteresis (we do not touch it — status is already waiting_approval).
            if (hasNonEmptyCliModalButtons(adapterStatus?.activeModal)) {
                this.approvalStickyLastConcreteAt = now;
                this.approvalStickyModal = adapterStatus.activeModal;
                this.approvalStickyEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
                    ? adapterStatus.approvalEntrySeq
                    : this.approvalStickyEntrySeq;
            }
            return adapterStatus;
        }

        // Non-approval frame. Overlay only if a concrete approval was dominant within the
        // window AND no resolution has happened since the sticky anchor (a resolveModal
        // advances lastApprovalResolvedAt to at/after the anchor → the flap is really a
        // genuine resume, so drop the sticky and report the raw status).
        if (this.approvalStickyLastConcreteAt > 0 && this.approvalStickyModal) {
            const withinWindow = (now - this.approvalStickyLastConcreteAt) < CliProviderInstance.APPROVAL_STICKY_FLAP_MS;
            const resolvedSinceAnchor = resolvedAt >= this.approvalStickyLastConcreteAt;
            if (withinWindow && !resolvedSinceAnchor) {
                return {
                    ...adapterStatus,
                    status: 'waiting_approval',
                    activeModal: this.approvalStickyModal,
                    ...(this.approvalStickyEntrySeq ? { approvalEntrySeq: this.approvalStickyEntrySeq } : {}),
                    approvalStickyOverlay: true,
                };
            }
            // Window lapsed or a resolution landed — clear the sticky so a later approval
            // re-anchors from scratch and a genuine resume surfaces immediately.
            this.approvalStickyLastConcreteAt = 0;
            this.approvalStickyModal = null;
            this.approvalStickyEntrySeq = 0;
        }
        return adapterStatus;
    }

    private maybeAutoApproveStatus(adapterStatus: any, now = Date.now()): boolean {
        // Manual-attendance suppression (provider-common): when a human is
        // Manual-attendance suppression (provider-common): when a human is
        // actively driving this session from the dashboard, hold auto-approve so
        // the modal stays visible and they can pick a button / use the controlbar
        // themselves. Return false (NOT auto-approving) so getState keeps the
        // modal surfaced. Clear any in-progress settle gate — a genuine fire
        // after the window lapses must re-settle from scratch — and arm a
        // re-check for the lapse moment, because the PTY may have gone silent and
        // would otherwise never re-drive this decision. Background mesh workers
        // are never attended, so their delegated auto-approve is untouched.
        if (adapterStatus?.status === 'waiting_approval'
            && this.shouldAutoApprove()
            && this.manualAttendance.isAttended(now)) {
            this.lastAutoApprovalSignature = '';
            this.pendingAutoApprovalSignature = '';
            this.pendingAutoApprovalSince = 0;
            this.autoApproveInactiveSince = 0;
            // Manual attendance takes over — the modal stays surfaced (maybeAutoApproveStatus
            // returns false), so end the mask episode.
            this.autoApproveMaskSince = 0;
            this.stalledApprovalNudgeEpisode = 0;
            this.autoApproveLastModalSeenAt = 0;
            if (this.autoApproveSettleTimer) clearTimeout(this.autoApproveSettleTimer);
            this.autoApproveSettleTimer = setTimeout(() => {
                this.autoApproveSettleTimer = null;
                this.recheckAutoApproveSettled();
            }, this.manualAttendance.remainingMs(now) + 20);
            return false;
        }
        const autoApproveActive = adapterStatus?.status === 'waiting_approval' && this.shouldAutoApprove();
        // Guard re-entry: onStatusChange/getState can observe the same modal multiple
        // times while the PTY absorbs the approval key. Without this flag, repeated
        // snapshots would write stray keys into the input once the modal dismisses.
        // However, Claude Code can present a second approval immediately after the
        // first. Resolve a changed modal signature even while the previous write is
        // still inside the short busy window.
        if (!autoApproveActive) {
            this.lastAutoApprovalSignature = '';
            // Hysteresis: if a settle gate is mid-progress, a momentary
            // status!=waiting_approval blip (a generating flip while the same
            // modal's button block is still on screen) must NOT wipe the settle
            // clock — otherwise the modal→generating→modal flap restarts the
            // 600ms window every time and auto-approve never fires. Keep the
            // gate warm for AUTO_APPROVE_GATE_HYSTERESIS_MS; re-arm a timer so
            // that if the modal does NOT come back the gate is cleared on the
            // re-check (a genuine resolution → idle frees the gate normally).
            if (this.pendingAutoApprovalSince) {
                if (!this.autoApproveInactiveSince) this.autoApproveInactiveSince = now;
                const goneForMs = now - this.autoApproveInactiveSince;
                // AUTOAPPROVE-FLAP-RECUR (Fix B): a delegated-worker flap cycles the
                // FULL waiting_approval → busy → waiting_approval state on a
                // multi-second period, outrunning the tight default hysteresis and
                // wiping the settle clock before 600ms ever accumulates. For an
                // active worker mask episode the continuity window is widened (still
                // capped by AUTO_APPROVE_MASK_STALL_MS) so the settle clock survives
                // the busy phase and the returning approval keeps accruing settle time.
                const continuityMs = this.autoApproveContinuityWindowMs();
                if (goneForMs < continuityMs) {
                    if (this.autoApproveSettleTimer) clearTimeout(this.autoApproveSettleTimer);
                    this.autoApproveSettleTimer = setTimeout(() => {
                        this.autoApproveSettleTimer = null;
                        this.recheckAutoApproveSettled();
                    }, continuityMs - goneForMs + 20);
                    return autoApproveActive;
                }
            }
            // Clear the settle gate so the next approval starts its own quiet
            // window from scratch (a stale timestamp would let it fire instantly).
            this.pendingAutoApprovalSignature = '';
            this.pendingAutoApprovalSince = 0;
            this.autoApproveInactiveSince = 0;
            // Modal has genuinely been gone past the hysteresis window → the episode ended;
            // end the mask episode too (a later approval starts a fresh stall clock).
            this.autoApproveMaskSince = 0;
            this.stalledApprovalNudgeEpisode = 0;
            this.autoApproveLastModalSeenAt = 0;
            if (this.autoApproveSettleTimer) { clearTimeout(this.autoApproveSettleTimer); this.autoApproveSettleTimer = null; }
            return autoApproveActive;
        }
        // Active approval observed — reset the inactivity tracker so a later
        // blip starts its hysteresis window fresh.
        this.autoApproveInactiveSince = 0;
        // STATUS-MISMATCH: start (or keep) the mask-stall clock for this episode. Set ONLY
        // when zero so it survives modal-signature changes and hysteresis blips — it measures
        // the true age of the unresolved auto-approve, not the per-signature settle window.
        if (!this.autoApproveMaskSince) this.autoApproveMaskSince = now;
        // NOTIF-APPROVAL-MASKED (Q1b): once this episode has stalled past the mask threshold,
        // surface the raw waiting_approval to the mesh coordinator (decoupled from the dashboard
        // mask). Placed on the active-approval path here — the single choke point that owns the
        // mask-stall clock and is re-driven throughout a silent stall (getState heartbeat,
        // detectStatusTransition, recheckAutoApproveSettled). No-op until the stall threshold trips.
        this.maybeEmitStalledApprovalNudge(adapterStatus, now);
        const modal = adapterStatus.activeModal;
        // (fix) Do not auto-approve when no concrete modal/buttons are present.
        // Claude TUI flaps between paints; without this guard adapterStatus
        // could report status=waiting_approval with activeModal=null (or with
        // an empty buttons array briefly) and we'd still call
        // resolveModal(-1) — which used to type "1" into the prompt
        // repeatedly. Skip until a real modal is captured.
        const buttons = Array.isArray(modal?.buttons)
            ? modal.buttons.map((b: any) => String(b || '').trim()).filter(Boolean)
            : [];
        if (!modal || buttons.length === 0) {
            // AUTOAPPROVE-FLAP-RECUR (Fix A): the button block momentarily scrolled
            // out of the captured frame (status is still waiting_approval — we are
            // on the active path). Do NOT tear the settle gate down on this frame:
            // if a concrete modal was captured within the continuity window and a
            // settle gate is in progress, this is a short scroll-out blip — keep the
            // gate warm against the last-captured signature and arm a re-check so a
            // silent PTY still re-drives the decision when the buttons repaint. Only
            // once the modal has stayed empty PAST the continuity window is it a
            // genuine close, and the gate is cleared here so a later approval
            // re-settles from scratch (never fires on a stale timestamp).
            const blipForMs = this.autoApproveLastModalSeenAt ? now - this.autoApproveLastModalSeenAt : Infinity;
            if (this.pendingAutoApprovalSince && blipForMs < this.autoApproveContinuityWindowMs()) {
                if (this.autoApproveSettleTimer) clearTimeout(this.autoApproveSettleTimer);
                this.autoApproveSettleTimer = setTimeout(() => {
                    this.autoApproveSettleTimer = null;
                    this.recheckAutoApproveSettled();
                }, this.autoApproveContinuityWindowMs() - blipForMs + 20);
                return autoApproveActive;
            }
            if (blipForMs >= this.autoApproveContinuityWindowMs()) {
                // Buttons empty continuously past the window → the modal genuinely
                // closed (or never captured). Reset the per-signature settle gate so
                // a later approval re-settles cleanly. The mask-stall clock keeps
                // running underneath so a never-captured worker modal still surfaces
                // to the coordinator within AUTO_APPROVE_MASK_STALL_MS.
                this.pendingAutoApprovalSignature = '';
                this.pendingAutoApprovalSince = 0;
            }
            return autoApproveActive;
        }
        // Concrete modal captured this frame — mark the last-good-modal timestamp so
        // a subsequent scroll-out blip (buttons.length===0) can be told apart from a
        // genuine close by how long it persists (Fix A above).
        this.autoApproveLastModalSeenAt = now;
        // Picker/confirm exclusion (provider-common). A /model or /mode picker is
        // surfaced with status=waiting_approval so the dashboard shows it, but it
        // has no "correct" answer to auto-pick — blindly selecting the first
        // option silently switches the model (the "always Opus, before I even
        // choose" bug). Two independent gates, BOTH must pass to fire:
        //
        //   (1) modal_kind — the spec/FSM tells us this is an 'approval' modal,
        //       not a 'picker'/'confirm'. A modal whose kind is unknown (legacy
        //       adapter, or a spec that predates modal_kind) reads as 'approval'
        //       so genuine approvals keep auto-approving; only an explicit
        //       'picker'/'confirm' is excluded here.
        //   (2) structural anchor — a real approval offers an affirmative AND a
        //       decline option (pickApprovalButton finds a positive that isn't a
        //       decline, and hasNegativeApprovalOption confirms a No/Cancel/Deny
        //       is present). A model picker ("1. Default  2. Opus  3. Sonnet")
        //       has no decline, so even an un-migrated picker is caught here.
        //
        // Mirrors the SDK v1 detect-status approval heuristic (detect-status.ts).
        const modalKind = typeof modal?.kind === 'string' ? modal.kind : 'approval';
        if (modalKind !== 'approval') {
            // Defense-in-depth (APPROVAL-PICKER-MISROUTE): a genuine tool-consent
            // modal ("Do you want to proceed?" + 1. Yes / 3. No) can be MIS-routed
            // to modal_kind='picker' by the spec FSM when a picker matcher wins the
            // priority tie in the wrong state. The spec-level negative guard (Fix A)
            // is the root fix, but a stale/undeployed spec would leave the worker
            // wedged on a modal it could safely have approved. So don't bail on the
            // kind label alone: only bail when this modal is ALSO a genuine SELECTION
            // picker (/model, /mode — "Select a model/mode/option" / "Switch
            // between") with NO consent structure. A modal that carries approval
            // text or a decline/grant anchor is treated as an approval and falls
            // through to the structural gate below, even under kind='picker'.
            const modalText = `${String(modal?.title || '')}\n${String(modal?.message || '')}\n${buttons.join('\n')}`;
            const looksLikeSelectionPicker = /Select (?:a |an )?(?:model|mode|option)\b|Switch between/i.test(modalText);
            const looksLikeConsent = looksLikeActiveApprovalPromptText(modalText)
                || /Do you want to (?:proceed|create|make|edit|apply|run|delete|modify|allow)\b|allow all edits\b|don'?t ask again\b/i.test(modalText)
                || hasNegativeApprovalOption(buttons)
                || hasReliableApprovalAffirmative(buttons);
            if (looksLikeSelectionPicker && !looksLikeConsent) {
                // Genuine /model or /mode selection picker — no safe default to
                // auto-pick. Leave it for the user; keep the modal surfaced.
                return autoApproveActive;
            }
            // Otherwise: mis-routed consent modal (or an ambiguous picker that still
            // carries consent structure) — fall through to the structural approval
            // gate below, which only fires on a real affirmative+decline/grant set.
        }
        const { index: buttonIndex, label: buttonLabel } = pickApprovalButton(buttons, this.provider);
        // Structural decline anchor. A real approval offers BOTH an affirmative
        // and a decline — but on a TALL Write/Edit diff the trailing "3. No"
        // scrolls off the captured frame, leaving only "1. Yes" + "2. Yes, allow
        // … this session" so hasNegativeApprovalOption reads false (#137). A
        // scoped grant-affirmative ("Yes, allow … during this session" / "…don't
        // ask again") ONLY appears in a genuine consent modal (never a picker),
        // so it stands in for the off-frame decline as a reliable second anchor.
        // Conservative by construction: a picker without a grant-scope option
        // still bails here, and the fire below still picks the plain allow-once
        // "Yes" via pickApprovalButton, not the broader grant.
        const hasReliableConsentAnchor = hasNegativeApprovalOption(buttons)
            || hasReliableApprovalAffirmative(buttons);
        if (buttonIndex < 0 || !hasReliableConsentAnchor) {
            // No affirmative matched, or no decline / reliable grant option present
            // (→ not a real consent prompt, e.g. a picker that slipped past the
            // kind gate). Surface the modal so the user decides; never pick blindly.
            return autoApproveActive;
        }
        // Modal *identity* signature — the question plus the STABLE affirmative
        // anchor only, NO volatile counters and NO raw button set. This is what
        // the settle gate tracks: the FSM bumps approvalEntrySeq on every fresh
        // waiting_approval entry, and a modal→generating→modal flap (the question
        // line scrolled out of the captured frame while the button block stays)
        // re-enters and bumps it again. Folding that seq into the settle signature
        // made the 600ms settle clock restart on every flap, so the modal never
        // stayed stable long enough to fire — the gate was never satisfied.
        // Identity excludes the seq so seq flap of the SAME modal keeps one clock.
        //
        // The raw button set is also excluded: on a TALL Write/Edit diff claude's
        // TUI repaints the button block 3↔5↔none between frames (buttons scroll in
        // and out of the captured region), which flipped both buttons.join('|') and
        // the positional buttonIndex every frame → signature flap → the settle
        // clock reset 4–9s and only mask-stalled episodes leaked to the coordinator
        // (AUTOAPPROVE-SETTLE-FLAP). The affirmative the auto-approve will actually
        // press is the invariant across those repaints, so we anchor on its
        // NORMALIZED label (numbers/bullets/punctuation stripped, so "1. Yes" and
        // "3. Yes" collapse to "yes"). Message + affirmative label uniquely
        // identifies the consent question without tracking the volatile button
        // positions.
        const affirmativeAnchor = normalizeApprovalLabel(buttonLabel);
        const modalSignature = approvalModalSignature(modal?.message, affirmativeAnchor);
        // Busy-window re-entry guard still needs the seq: two DISTINCT
        // back-to-back approvals can carry identical message/buttons (common
        // with claude-cli). Without the seq their busy signatures collide and
        // the 5s busy-window guard below would swallow the second auto-approve,
        // leaving it stuck. The seq is bumped by the FSM on every fresh
        // waiting_approval entry, so a new approval always yields a new busy
        // signature and fires through.
        const approvalEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
            ? adapterStatus.approvalEntrySeq
            : 0;
        const busySignature = `${approvalEntrySeq}::${modalSignature}`;
        // Already fired for this exact modal entry and still inside the busy
        // window — nothing to do (re-entry guard for repeated snapshots of one
        // modal).
        if (this.autoApproveBusy && busySignature === this.lastAutoApprovalSignature) {
            return autoApproveActive;
        }

        // Settle gate: only fire once this modal identity has been stable for
        // AUTO_APPROVE_SETTLE_MS. A still-streaming prompt mutates its
        // message/buttons each frame → new identity → clock restarts, so we
        // never approve a half-rendered prompt (the "resolves too fast" bug).
        if (modalSignature !== this.pendingAutoApprovalSignature) {
            this.pendingAutoApprovalSignature = modalSignature;
            this.pendingAutoApprovalSince = now;
        }
        const settledForMs = now - this.pendingAutoApprovalSince;
        if (settledForMs < CliProviderInstance.AUTO_APPROVE_SETTLE_MS) {
            // Not yet settled. Arm a timer to re-check after the remaining quiet
            // window — the PTY may go silent once the prompt finishes painting,
            // so there is no guaranteed status-change frame to re-drive us.
            if (this.autoApproveSettleTimer) clearTimeout(this.autoApproveSettleTimer);
            this.autoApproveSettleTimer = setTimeout(() => {
                this.autoApproveSettleTimer = null;
                this.recheckAutoApproveSettled();
            }, CliProviderInstance.AUTO_APPROVE_SETTLE_MS - settledForMs + 20);
            return autoApproveActive;
        }

        // Settled — fire the approve key.
        if (this.autoApproveSettleTimer) { clearTimeout(this.autoApproveSettleTimer); this.autoApproveSettleTimer = null; }
        this.autoApproveBusy = true;
        this.lastAutoApprovalSignature = busySignature;
        this.pendingAutoApprovalSignature = '';
        this.pendingAutoApprovalSince = 0;
        this.autoApproveInactiveSince = 0;
        // Fired (resolveModal in flight) — the episode resolved; end the mask-stall clock.
        this.autoApproveMaskSince = 0;
        this.stalledApprovalNudgeEpisode = 0;
        this.autoApproveLastModalSeenAt = 0;
        if (this.autoApproveBusyTimer) clearTimeout(this.autoApproveBusyTimer);
        this.autoApproveBusyTimer = setTimeout(() => {
            this.autoApproveBusy = false;
            this.autoApproveBusyTimer = null;
            this.lastAutoApprovalSignature = '';
        }, 5000);
        this.recordAutoApproval(modal?.message, buttonLabel, now);
        setTimeout(() => {
            this.adapter.resolveModal(buttonIndex);
        }, 0);
        return autoApproveActive;
    }

    /**
     * Re-drive the auto-approve check after the settle quiet window elapses.
     * The PTY may have gone silent once the approval prompt finished painting,
     * so no status-change frame is guaranteed to re-enter maybeAutoApproveStatus
     * — this timer-driven re-check picks up the now-settled modal and fires.
     * Deliberately lighter than detectStatusTransition(): it only re-evaluates
     * the approval decision; the next real PTY frame refreshes visible status.
     */
    private recheckAutoApproveSettled(): void {
        try {
            // APPROVAL Defect-C (auto-approve gap): re-probe with a LIVE parse, not the cached
            // engine snapshot. This timer is the ONLY re-drive when the PTY goes silent after the
            // approval prompt finishes painting (its whole reason to exist) — but with
            // allowParse:false it read only engine.activeModal, which the engine's per-frame settle
            // pass can leave null/stale when the modal arrived between writes. The re-check then saw
            // no modal and never fired, so the delegated worker's transient/quiet approval was missed
            // and the coordinator had to step in with a manual mesh_approve. allowParse:true makes
            // getStatus re-run runDetectStatus/runParseApproval on the current screen buffer (the same
            // live re-probe the coordinator's resolveAction path uses), recovering the modal so
            // auto-approve fires on its own. The half-rendered-frame guard (buttons.length===0) and
            // the settle gate in maybeAutoApproveStatus still protect against firing on a partial modal.
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
     * GENERATING-BOUNDARY synthetic emit for a first turn that started AND finished
     * inside the startup-grace window without the FSM ever observing a 'generating'
     * frame (an unobservably-fast turn). Synthesizes the agent:generating_started +
     * agent:generating_completed pair so the mesh coordinator learns the worker went
     * idle. Returns true iff it synthesized.
     *
     * Two callers share this defense line:
     *  - 'startup_grace_fast_collapse' — the starting→idle transition (the FSM whose
     *    spec lacks/hadn't-synced the starting→busy edge collapses starting→idle
     *    directly, with no intervening 'generating' frame).
     *  - 'startup_grace_idle_turn_collapse' — the idle→idle no-status-change poll
     *    (the launch settle already drained starting→idle BEFORE the first turn, so
     *    the turn runs+completes while status stays 'idle' the whole time and
     *    detectStatusTransition never re-enters its change block — the live rc.403
     *    Probe1 miss).
     *
     * False-positive safety (must NOT fire on a benign boot): currentTurnTaskId is
     * set ONLY by onTurnStarted (a real turn STARTED this boot) and persists past
     * completion, so it excludes a true idle boot (null) and a queued-pending first
     * turn that only runs after grace (onTurnStarted not yet called → null).
     * !hasAdapterPendingResponse() excludes a turn still mid-flight. generating
     * never armed (generatingStartedAt===0 && !generatingDebouncePending) means the
     * whole idle→busy→idle never happened for this turn. The once-per-turn guard
     * (fastCollapseSynthesizedTaskId) keeps the re-polled idle-stayed caller from
     * re-emitting every poll.
     */
    private maybeSynthesizeStartupGraceCollapse(
        chatTitle: string,
        now: number,
        reason: 'startup_grace_fast_collapse' | 'startup_grace_idle_turn_collapse',
    ): boolean {
        const startedTurnTaskId = typeof (this.adapter as any)?.currentTurnTaskId === 'string'
            && (this.adapter as any).currentTurnTaskId.trim()
            ? (this.adapter as any).currentTurnTaskId as string
            : undefined;
        const fastCollapsed = !!startedTurnTaskId
            && !this.hasAdapterPendingResponse()
            && !this.generatingStartedAt
            && !this.generatingDebouncePending;
        if (!fastCollapsed) return false;
        // Once-per-turn: the idle-stayed caller re-polls steadily while the session
        // sits idle; without this guard it would re-emit the pair every poll.
        if (this.fastCollapseSynthesizedTaskId === startedTurnTaskId) return false;

        let fcFinalSummary: string | undefined;
        let fcEvidenceSource: CompletionFinalAssistantEvidence['source'] = 'unavailable';
        try {
            const parsedMessages = this.adapter?.getScriptParsedStatus()?.messages;
            const evidence = this.completionFinalAssistantEvidence(parsedMessages);
            fcEvidenceSource = evidence.source;
            fcFinalSummary = extractFinalSummaryFromMessages(evidence.messages as any);
        } catch { /* best-effort */ }
        const missingEvidence = ((this.provider as any).requiresFinalAssistantBeforeIdle === true || fcEvidenceSource === 'external-native') && !fcFinalSummary;
        // Mirror the short-generating idle path's suppression: a provider that
        // requires a final assistant (or external-native history) with NO confirmed
        // summary and NO mesh context emits nothing — the session is idle with no
        // confirmed turn, matching startup-blip semantics. With mesh context we still
        // emit so the coordinator can apply its own timeout/retry logic. Left UNMARKED
        // so a later poll can retry once the transcript's final assistant lands.
        const hasMeshContext = !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator);
        if (missingEvidence && !hasMeshContext) {
            LOG.info('CLI', `[${this.type}] ${reason} suppressed: missing final assistant evidence, no mesh context (source=${fcEvidenceSource})`);
            return false;
        }
        // Mark BEFORE emitting so a re-entrant poll cannot double-fire.
        this.fastCollapseSynthesizedTaskId = startedTurnTaskId;
        LOG.info('CLI', `[${this.type}] ${reason}: synthesizing started+completed (taskId=${startedTurnTaskId} source=${fcEvidenceSource} hadFinalSummary=${!!fcFinalSummary})`);
        // Retroactive started so the started→completed pair (and the chat bubble) is
        // well-formed; pushEvent stamps the per-turn taskId for CANON-B ack.
        this.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now });
        if (this.isMeshWorkerSession()) {
            traceMeshEventStage('fired', this.meshTraceCtx(), `${reason} (source=${fcEvidenceSource})`);
        }
        // EARLYNOTIFY-GATEBYPASS (c): a startup-grace fast-collapse never OBSERVED the turn's
        // generating phase — its evidence is a plain transcript tail, never a self-attributing
        // final_summary_json — so this synth is TENTATIVE by default. Mark it WEAK
        // (evidenceLevel:'weak') so buildPendingEventFingerprint keys it `…::weak` and any later
        // genuine agent:generating_completed for the same task can still surface (CANON-B). The
        // stronger missing_final_assistant marker is preserved when there is also no summary.
        if (this.completionTraceOn()) this.recordCompletionGateTrace('synth-fire', {
            path: 'startup_grace_fast_collapse',
            reason,
            evidenceSource: fcEvidenceSource,
            hadFinalSummary: !!fcFinalSummary,
            missingEvidence,
            evidenceLevel: 'weak',
        });
        this.emitGeneratingCompleted({
            chatTitle,
            duration: 0,
            timestamp: now,
            finalSummary: fcFinalSummary,
            evidenceLevel: 'weak',
            completionDiagnostic: {
                reason,
                finalAssistantEvidenceSource: fcEvidenceSource,
                ...(missingEvidence ? { blockReason: 'missing_final_assistant' } : {}),
            },
        });
        return true;
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
        const autoApproveActive = this.maybeAutoApproveStatus(adapterStatus, now);
        // During the autoApproveBusy window (2s after firing approval key), the PTY
        // can briefly report 'idle' before the next generating phase starts. Treat that
        // transient idle as 'generating' to suppress a spurious agent:generating_completed
        // push notification. The adapter's status is otherwise authoritative — native
        // transcript shape does NOT override the FSM's busy/idle decision.
        const autoApproveHoldIdle = this.autoApproveBusy && rawStatus === 'idle';
        const newStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : rawStatus;
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
            } else if (newStatus === 'waiting_approval') {
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
                    const missingEvidence = ((this.provider as any).requiresFinalAssistantBeforeIdle === true
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
        if (TERMINAL_MESH_EVENTS.has(event.event) && this.settings.meshActiveTaskId) {
            try { this.detachMeshAssignment(); } catch { /* best-effort */ }
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

    private shouldAutoApprove(): boolean {
        if (typeof this.settings.autoApprove === 'boolean') {
            return this.settings.autoApprove;
        }
        const providerDefault = this.provider.settings?.autoApprove?.default;
        if (typeof providerDefault === 'boolean') {
            return providerDefault;
        }
        return false;
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
            && this.shouldAutoApprove()
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
        return this.autoApproveMaskSince > 0
            && now - this.autoApproveMaskSince > CliProviderInstance.AUTO_APPROVE_MASK_STALL_MS;
    }

    /**
     * NOTIF-APPROVAL-MASKED (Q1b): surface a delegated worker's STALLED auto-approve modal
     * to the mesh COORDINATOR, decoupled from the dashboard visible-status mask.
     *
     * When auto-approve is configured but the episode never settles (modal parse miss / the
     * settle gate never satisfied), getState()/detectStatusTransition() fold the raw
     * `waiting_approval` into `generating` to suppress dashboard flicker — so
     * detectStatusTransition()'s `waiting_approval` arm never runs and NO agent:waiting_approval
     * event is emitted. The coordinator's real-time approval-nudge delivery then has no input and
     * the worker's stuck modal is never surfaced (the live ~25s stall). The dashboard mask is
     * intentional and stays; this emits the coordinator nudge exactly ONCE, gated on the SAME
     * raw-waiting_approval + mask-stalled signal resolveModalParkStatus() distinguishes, the
     * instant the mask-stall threshold trips (the same moment getState un-folds the mask).
     *
     * Only delegated worker sessions qualify: a foreground session has no coordinator to notify,
     * and its own dashboard mask already reveals the modal on stall. A normally-resolving
     * auto-approve never reaches AUTO_APPROVE_MASK_STALL_MS, so it emits nothing here; and if a
     * masked approval clears just as this fires, rc.455's isApprovalNudgeResolved stale-drop
     * discards the nudge coordinator-side without noise. Dedup is per-episode (keyed on the
     * mask-clock value) so a modal that flaps between parsed/unparsed states is announced once.
     */
    private maybeEmitStalledApprovalNudge(adapterStatus: any, now: number): void {
        if (!this.isMeshWorkerSession()) return;
        if (adapterStatus?.status !== 'waiting_approval') return;
        if (!this.autoApproveMaskStalled(now)) return;
        // AUTOAPPROVE-FLAP-RECUR (Fix C, redesigned): the mask-stall bound tripped.
        // If auto-approve is genuinely about to fire on its own, defer to that fire —
        // the nudge would race a resolveModal landing milliseconds later, producing
        // the coordinator flap this fix targets.
        //
        // The ORIGINAL guard deferred on `pendingAutoApprovalSince && buttons > 0`
        // alone. That is FALSE-POSITIVE for a FLAPPING modal: a modal whose identity
        // changes every frame (message streaming) keeps pendingAutoApprovalSince
        // nonzero (it is re-stamped to `now` on every signature change) and keeps
        // buttons present, yet its settle clock is wiped back to ~0 each frame and
        // NEVER reaches SETTLE_MS — so auto-approve can never fire and this is exactly
        // the stuck episode the coordinator MUST be paged about. The old guard
        // silenced it permanently (the live rc.466 regression).
        //
        // Discriminator: a settle is genuinely PROGRESSING only if THIS frame's modal
        // carries the SAME identity the settle clock is already accruing against
        // (pendingAutoApprovalSignature). A stable modal keeps its signature across
        // frames → the clock climbs → resolveModal is imminent → defer. A flapping
        // modal presents a DIFFERENT signature this frame (or none — a non-concrete /
        // picker / never-captured modal) → the clock is about to reset (or never
        // engaged) → do NOT defer, page the coordinator. This is evaluated for the
        // CURRENT frame (not a stale prior-frame value), so a stable modal polled only
        // twice — start, then past the stall bound — is still correctly deferred.
        const currentSignature = this.approvableModalSignature(adapterStatus.activeModal);
        const settleProgressing = !!currentSignature
            && this.pendingAutoApprovalSince > 0
            && currentSignature === this.pendingAutoApprovalSignature;
        if (settleProgressing) return;
        // Exactly once per stalled episode (autoApproveMaskSince uniquely identifies it).
        if (this.stalledApprovalNudgeEpisode === this.autoApproveMaskSince) return;
        this.stalledApprovalNudgeEpisode = this.autoApproveMaskSince;
        const modal = adapterStatus.activeModal;
        const dirName = workingDirBasename(this.workingDir);
        const chatTitle = `${this.provider.name} · ${dirName}`;
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
        LOG.info('CLI', `[${this.type}] stalled auto-approve nudge → coordinator (masked ${Math.round((now - this.autoApproveMaskSince) / 1000)}s)`);
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


    private getProbeDirectories(): string[] {
        const dirs = new Set<string>();
        const addDir = (value: string | null | undefined) => {
            const normalized = typeof value === 'string' ? value.trim() : '';
            if (normalized) dirs.add(normalized);
        };

        addDir(this.workingDir);
        try {
            addDir(fs.realpathSync.native(this.workingDir));
        } catch {
            // noop
        }

        return Array.from(dirs);
    }

    private buildSqlPlaceholderList(count: number): string {
        return Array.from({ length: count }, () => '?').join(', ');
    }

    private querySqliteText(dbPath: string, query: string, params: Array<string | number>): string | null {
        try {
            if (this.cachedSqliteDb === null || this.cachedSqliteDbPath !== dbPath) {
                try { this.cachedSqliteDb?.close(); } catch { /* noop */ }
                this.cachedSqliteDb = null;
                this.cachedSqliteDbPath = null;
                const DatabaseSync = getDatabaseSync();
                this.cachedSqliteDb = new DatabaseSync(dbPath, { readOnly: true });
                this.cachedSqliteDbPath = dbPath;
            }
            const row = this.cachedSqliteDb!.prepare(query).get(...params) as { id?: unknown } | undefined;
            const sessionId = typeof row?.id === 'string' ? row.id.trim() : '';
            return sessionId || null;
        } catch {
            // Close cached connection on error so we retry fresh next tick
            try { this.cachedSqliteDb?.close(); } catch { /* noop */ }
            this.cachedSqliteDb = null;
            this.cachedSqliteDbPath = null;
            return null;
        }
    }
}
