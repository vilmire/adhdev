/**
 * CliProviderInstance — Runtime instance for CLI Provider
 *
 * Lifecycle layer on top of the CLI adapter (SpecCliAdapter via spec/route).
 * collectCliData() + status transition logic from daemon-status.ts moved here.
 */

import * as crypto from 'crypto';
import { type ProviderModule, flattenContent, type InputEnvelope } from './contracts.js';
import type { ProviderSendMessageResult, ProviderInstance, ProviderState, ProviderEvent, InstanceContext, ProviderErrorReason, HotChatSessionState } from './provider-instance.js';
import { normalizeInteractivePrompt, type InteractivePrompt } from './types/interactive-prompt.js';
import {
    applyInteractivePromptAnswer,
    applyInteractivePromptAnswerFireAndForget,
    describeInteractivePrompt,
    type AppliedInteractivePromptAnswer,
    type ActiveInteractivePromptDescription,
} from './interactive-prompt-apply.js';
import { SpecCliAdapter } from './spec/cli-adapter.js';
import { sendMessageEvent } from './cli-provider-send-event.js';

import type { CliProviderModule } from '../cli-adapters/provider-cli-shared.js';
import type { MeshSendKeyItem, MeshSendKeyName } from '../cli-adapters/provider-cli-shared.js';
import {
    type NativeTurnTerminalMarker,
} from '../chat/native-turn-signal.js';
import { TranscriptSignalSource } from './transcript-signal-source.js';
import { resolveBusyLeaseGate } from './busy-lease-gate.js';
import type { SignalSnapshot } from './spec/signal-envelope.js';
import { createCliAdapter } from './spec/route.js';
import type { PtyRuntimeMetadata, PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { shouldCollectTraceCategory } from '../logging/debug-config.js';
import { type MeshTaskAttachment } from './mesh-task-attachment.js';
import type { ChatMessage } from '../types.js';
import { readChatMessageTimestampMs } from './chat-message-normalization.js';
import { ManualAttendanceTracker } from './manual-attendance.js';
import { type PersistableCliHistoryMessage } from './cli-provider-history-dedup.js';
import {
    COMPLETED_FINALIZATION_RETRY_MS,
    COMPLETED_FINALIZATION_MAX_WAIT_MS,
    CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS,
    MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
    PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS,
    ANTIGRAVITY_HOLD_HARD_CAP_MS,
    TERMINAL_BLOCK_HARD_CAP_MS,
    BACKGROUND_TASK_HOLD_MAX_MS,
} from './cli-provider-instance-types.js';
import { evaluateFinalizationBlock, type CompletionArmPatch, type CompletionFlushDecision, type CompletionPolicy, type CompletionSignalReader } from './completion/completion-engine.js';
import { createSqliteProbeCache, probeSessionIdFromConfig } from './completion/transcript-probe.js';
import * as approvalGate from './completion/approval-gate.js';
import * as evidence from './completion/evidence.js';
import { runStatusTransitionTick } from './completion/status-transition.js';
import type { SessionEventPort } from './provider-event-port.js';
import type { TurnEvidencePort } from './turn-evidence-port.js';
import type { TurnAttemptRef } from '@adhdev/mesh-shared';
import type { AdapterChangeCause } from '../cli-adapter-types.js';
import {
    armCancelledCompletionRecheck,
    clearCancelledCompletionRecheck,
    type CancelledCompletionRecheck,
    type CancelledCompletionReason,
} from './completion/cancel-recheck.js';
import type {
    CompletedDebouncePending,
    CompletedFinalizationBlock,
    CompletionFinalAssistantEvidence,
    ExternalTranscriptProbe,
} from './cli-provider-instance-types.js';
import { ParsedIngestTimestampStamper } from './cli-provider-ingest-times.js';
import { formatMarkerTimestamp } from './cli-provider-effect-format.js';
import { resolveProviderAutoApproveMode, type ResolvedAutoApproveMode } from './auto-approve-modes.js';
import * as historySync from './cli-provider-history-sync.js';
import * as completionDiagnostics from './completion/completion-diagnostics.js';
import * as runtimeMessages from './cli-provider-runtime-messages.js';
import * as stateProjection from './cli-provider-state-projection.js';
import * as providerEvents from './cli-provider-events.js';
import * as completionFlush from './completion/completion-flush.js';
import * as meshAssignment from './cli-provider-mesh-assignment.js';
import {
    checkMeshWorkerStall, completingTurnTaskId, getTerminalScreenSnapshot, injectKeys,
    isAutonomousMeshSession, isMeshWorkerSession, meshTraceCtx,
} from './cli-provider-mesh-session.js';
import {
    approvalRecentlyResolvedLocally, autoApproveEffectivelyActive, getDrainStatus, getHotChatSessionState, inApprovalResumeGrace,
    isTransientToolConsent, recordApprovalSelection, recordAutoApproval, resolveModalParkStatus,
} from './cli-provider-modal-park.js';
import {
    antigravityClaimOwner, applyInitialThinkingLevelViaControl, dispose, enforceFreshSessionLaunchIfNeeded, wireAdapterCallbacks,
} from './cli-provider-lifecycle.js';
import {
    finalSummaryProvenanceDiagnostic, hasEmittedGenuineCompletionForCurrentEpoch, nativeTurnTerminalMarker, nativeTurnTerminalSummary, probeNativeTranscriptSignals,
    publishTranscriptSignalObservation, spawnedEnvOverrides,
} from './cli-provider-transcript-signals.js';

export class CliProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'cli' as const;

    // Members without `private` below are part of the typed host views the
    // extracted helper modules receive (`completion/*Host`,
    // cli-provider-*-projection, mesh-assignment, ...). The instance is passed
    // as `this` with NO cast, so the compiler checks structural conformance to
    // every host interface at each call site.
    adapter: SpecCliAdapter;
    context: InstanceContext | null = null;
    lastStatus: string = 'starting';
    // Idempotency guard for the queue-claim agent:ready event. agent:ready is the
    // sole signal the mesh coordinator's tryAssignQueueTask waits on to hand a
    // queued task to this worker. It is emitted in two places: the boot-time
    // starting→idle one-shot, and the readySeen re-arm below. This flag makes the
    // event fire AT MOST ONCE per session so a worker is never claimed twice and a
    // queued task is never double-dispatched/double-injected. Whichever path fires
    // first sets it; the other becomes a no-op.
    agentReadyEmitted = false;
    /** status-transition: a real turn has started on this instance (gates the startup auto-approve mask exemption). */
    turnStartedThisBoot = false;
    generatingStartedAt: number = 0;
    // MESH-STALL-WATCH (feature 1): the lastOutputAt value the stall episode is
    // currently armed against. A stall episode is "the raw PTY output has not
    // advanced past this anchor". When the adapter has never emitted output
    // (lastOutputAt === 0) the anchor is the spawn time (this.startedAt) so a
    // worker that produced NOTHING is still caught. On any new output the anchor
    // re-arms to the fresh lastOutputAt and meshStallEmittedForAnchor resets, so a
    // single continuous stall fires AT MOST ONCE and a later stall re-arms cleanly.
    // -1 = not yet initialised for this session.
    meshStallAnchorAt = -1;
    meshStallEmittedForAnchor = false;
    // FALSE-STALL-WATCHDOG-OVERFIRE (fix B): the turn-active state observed on the
    // PREVIOUS stall tick. When a turn ends (active → inactive: the completion/idle
    // transition), the anchor is force re-armed to `now` so the completed→idle valley
    // does not fire against the pre-completion output clock. The turn-end edge is the
    // signal; updateStatus's own idle transition does not touch the stall anchor, so
    // this watchdog-local edge detector owns the re-arm. undefined = no prior tick.
    meshStallTurnActiveLast: boolean | undefined = undefined;
    // FALSE-STALL-WATCHDOG-OVERFIRE (fix E): wall-clock of the most recent stall
    // emission for this session, or -1 if none. Enforces
    // MESH_WORKER_STALL_REFIRE_COOLDOWN_MS between successive emissions across
    // anchor re-arms (the per-anchor guard only covers a single continuous stall).
    meshStallLastFiredAt = -1;
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
    meshStallTranscriptSignalSampled = false;
    // FALSE-IDLE continuity epoch: monotonically bumped on EVERY entry into a busy
    // phase (→generating or →waiting_approval). The completedDebouncePending snapshots
    // this value at arm time (busyEpochAtArm); the flush guard requires it UNCHANGED
    // — proving the session did not re-enter a busy phase (a momentary busy→idle blip
    // in an inter-approval valley) between arming the debounce and flushing it. A
    // single point-sample of status at flush time cannot see a generating phase that
    // opened AND closed within the settle window; the epoch can. See
    // flushCompletedDebounceIfFinalized.
    busyEpoch: number = 0;
    // Wall-clock when the CURRENT mesh task was injected/attached (attachMeshAssignment):
    // the fallback turn-start anchor for turn-scoped transcript reads. 0 = no task
    // injected since boot.
    meshTaskInjectedAt = 0;
    meshTaskAttachmentHistory: MeshTaskAttachment[] = []; // WORKER-MCP T2 precursor — mesh-task-attachment.ts, flag-gated, byte-identical off. Always read via meshTaskAttachments(this.meshTaskAttachmentHistory), never raw — see that module's "Constructor-bypassed instances".
    settings: Record<string, any> = {};
    monitor: StatusMonitor;
    generatingDebounceTimer: NodeJS.Timeout | null = null;
    generatingDebouncePending: { chatTitle: string; timestamp: number } | null = null;
    lastApprovalEventFingerprint = '';
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
    lastInteractivePromptEventKey = '';
    // Lifecycle port (wiring-unification B2) + the tick's diff state for it.
    lifecyclePort: SessionEventPort | null = null;
    // Turn-evidence port (wiring-unification C5/C-W5). Null until boot wires
    // it (setTurnEvidencePort); every producer site below guards on it the
    // same way the lifecycle port is guarded.
    turnEvidencePort: TurnEvidencePort | null = null;
    lastPromptFingerprint = '';
    lastModalFingerprint = '';
    autoApproveBusy = false;
    autoApproveBusyTimer: NodeJS.Timeout | null = null;
    lastAutoApprovalSignature = '';
    // Settle gate: the approval modal's signature + the wall-clock when this
    // exact signature was first observed. Auto-approve only fires once the
    // SAME signature has been stable for AUTO_APPROVE_SETTLE_MS, so a prompt
    // still streaming into the PTY (its buttons/message changing frame to
    // frame) keeps resetting the timer and is never approved half-rendered.
    pendingAutoApprovalSignature = '';
    pendingAutoApprovalSince = 0;
    autoApproveSettleTimer: NodeJS.Timeout | null = null;
    // Wall-clock when auto-approve first observed status!=waiting_approval while
    // a settle gate was in progress. Drives AUTO_APPROVE_GATE_HYSTERESIS_MS (or,
    // for a delegated-worker flap episode, AUTO_APPROVE_FLAP_CONTINUITY_MS) so a
    // brief generating flip does not immediately wipe the settle clock.
    autoApproveInactiveSince = 0;
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
    autoApproveLastModalSeenAt = 0;
    // APPROVAL-INBOX-BLINDSPOT (Fix A): wall-clock of the last time this session actually
    // FIRED a local auto-approve resolveModal (the settle gate passed → resolveModal
    // dispatched). The mesh event forwarder keys its agent:waiting_approval suppression on
    // this + a cooldown so it only drops the coordinator notification when we can positively
    // confirm the modal was (or is being) resolved LOCALLY. If auto-approve is merely
    // *configured* on but has NOT recently fired for this modal, the raw waiting_approval is
    // forwarded so a task_approval_needed ledger row is created and the coordinator/inbox is
    // told — closing the blind spot where a never-resolving worker approval was silently
    // dropped just because settings.autoApprove===true.
    lastAutoApproveFiredAt = 0;
    // AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval overlay (see APPROVAL_STICKY_FLAP_MS).
    // The wall-clock of the last frame where the RAW adapter reported waiting_approval with
    // a CONCRETE modal (buttons present), the cached modal to re-present across a busy blip,
    // and the approvalEntrySeq at that frame (so a stabilized frame carries the right seq to
    // the emission-dedup fingerprint). All zero/null when no recent concrete approval.
    approvalStickyLastConcreteAt = 0;
    approvalStickyModal: { message?: string; buttons?: unknown[]; kind?: string | null } | null = null;
    approvalStickyEntrySeq = 0;
    // STATUS-MISMATCH: wall-clock when the CURRENT auto-approve episode (waiting_approval
    // + shouldAutoApprove) first began wanting to mask. Unlike pendingAutoApprovalSince it
    // is NOT reset when the modal signature changes (a still-streaming/flapping prompt) and
    // survives the same hysteresis blips the settle gate does, so it measures the TRUE age
    // of an unresolved auto-approve. Once it exceeds AUTO_APPROVE_MASK_STALL_MS the surface
    // mask is dropped so the real waiting_approval surfaces. Cleared when the episode ends
    // (modal genuinely gone, manual attendance takes over, or auto-approve fires).
    autoApproveMaskSince = 0;
    // NOTIF-APPROVAL-MASKED (Q1b): the autoApproveMaskSince episode value for which a
    // stalled-approval coordinator nudge has already been emitted, so the nudge fires
    // exactly once per stalled auto-approve episode (0 = none emitted). Reusing the
    // per-episode mask-clock value as the key makes it provider-agnostic (no reliance on
    // approvalEntrySeq) and self-resetting: each new episode gets a fresh
    // autoApproveMaskSince timestamp, and the episode-end reset zeroes it.
    stalledApprovalNudgeEpisode = 0;
    // Provider-common manual-attendance signal: while a human is actively driving
    // this session from the dashboard, auto-approve holds so they can take manual
    // control. Background mesh workers are never attended → delegated auto-approve
    // is unaffected.
    readonly manualAttendance = new ManualAttendanceTracker();
    controlValues: Record<string, string | number | boolean> = {};
    summaryMetadata: unknown = undefined;
    appliedEffectKeys = new Set<string>();
    historyWriter: ChatHistoryWriter;
    runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];
    // INGEST-TIMESTAMP: stamps untimed provider-parsed messages with their
    // first-observed time so mergeConversationMessages can interleave the
    // timestamped runtime user-input ack by clock instead of pinning it after
    // every parsed message (the "user bubble stuck at the bottom" defect).
    readonly parsedIngestTimestamps = new ParsedIngestTimestampStamper();
    lastPersistedHistoryMessages: PersistableCliHistoryMessage[] = [];
    lastAcknowledgedUserInputAt = 0;
    // TASKBUBBLE-DUP: per-content last-ack timestamps so the same dispatched
    // prompt acked twice in quick succession (the worker buffers the first
    // send during bootstrap/busy, then a redelivery — dispatch-confirm-timeout
    // requeue or a reconcile re-dispatch — fires a SECOND send_chat before the
    // outbound queue drains) collapses to ONE user bubble. Keyed on the trimmed
    // content; an entry older than USER_INPUT_ACK_DEDUP_WINDOW_MS is treated as
    // a fresh, intentional resend and is NOT suppressed.
    recentUserInputAcks = new Map<string, number>();
    lastNativeSourceCanonicalCheckAt = 0;
    lastNativeSourceCanonicalCacheKey: string | undefined = undefined;
    // Session-id SQLite probe state (see completion/transcript-probe.ts).
    readonly sqliteProbeCache = createSqliteProbeCache();
    readonly instanceId: string;
    suppressIdleHistoryReplay = false;
    errorMessage: string | undefined = undefined;
    errorReason: ProviderErrorReason | undefined = undefined;
    activeInteractivePrompt: InteractivePrompt | null = null;

    presentationMode: 'terminal' | 'chat';
    providerSessionId?: string;
    launchMode: 'new' | 'resume' | 'manual';
    initialThinkingLevel?: string;
    readonly startedAt = Date.now();
    onProviderSessionResolved?: (info: {
        instanceId: string;
        providerType: string;
        providerName: string;
        workspace: string;
        providerSessionId: string;
        previousProviderSessionId?: string;
    }) => void;

    constructor(
        public provider: ProviderModule,
        public workingDir: string,
        cliArgs: string[] = [],
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
            /** PERMISSION-MODE-DUPLICATE: the selected auto-approve mode's `removeArgs`.
             *  cli-manager already filtered the provider MANIFEST's spawn.args with these;
             *  the list itself travels on so the spec path can filter the SPEC's spawn_args,
             *  which declare the same flag with a possibly different value. */
            removeSpawnArgs?: string[]; resolvedTrustPlan?: Parameters<typeof createCliAdapter>[7];
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
        this.adapter = createCliAdapter(provider as CliProviderModule, workingDir, cliArgs, options?.extraEnv || {}, transportFactory, this.instanceId, options?.removeSpawnArgs, options?.resolvedTrustPlan);
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
        if (!this.lifecyclePort && context.lifecycle) this.lifecyclePort = context.lifecycle;
        if (!this.turnEvidencePort && context.turnEvidence) this.turnEvidencePort = context.turnEvidence;
        this.applySettingsToRuntime();

        wireAdapterCallbacks(this, context);

 // PTY spawn
        await this.adapter.spawn();
        await enforceFreshSessionLaunchIfNeeded(this);
        await applyInitialThinkingLevelViaControl(this);
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

    /** Push the current settings into the adapter runtime and the status monitor. */
    private applySettingsToRuntime(): void {
        this.adapter.updateRuntimeSettings?.(this.settings);
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            noProgressAlert: (this.settings.noProgressAlert ?? this.settings.longGeneratingAlert) !== false,
            noProgressThresholdSec: this.settings.noProgressThresholdSec ?? this.settings.longGeneratingThresholdSec ?? 180,
        });
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
        return probeSessionIdFromConfig(this, probe);
    }

    getState(): ProviderState {
        return stateProjection.buildProviderState(this);
    }

    setPresentationMode(mode: 'terminal' | 'chat'): void {
        if (this.presentationMode === mode) return;
        this.presentationMode = mode;
    }

    getPresentationMode(): 'terminal' | 'chat' {
        return this.presentationMode;
    }
    getHotChatSessionState(): HotChatSessionState { return getHotChatSessionState(this); }

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
        this.applySettingsToRuntime();
    }

    /**
     * Stamp a direct-dispatch mesh assignment on this instance.
     * setupMeshEventForwarding reads settings.meshNodeFor + meshActiveTaskId to
     * route generating_completed back to the originating coordinator. Without
     * this stamp, mesh_send_task --direct targets a plain CLI session whose
     * completion events silently drop because the forwarder has nothing to
     * match against.
     */
    attachMeshAssignment(assignment: { meshId: string; nodeId?: string; taskId?: string; dispatchNonce?: number; attemptId?: string; attemptGeneration?: number; coordinatorDaemonId?: string; coordinatorSessionId?: string }): void {
        meshAssignment.attachMeshAssignment(this, assignment);
    }

    detachMeshAssignment(): void {
        meshAssignment.detachMeshAssignment(this);
    }
    resolveModalParkStatus(): 'waiting_choice' | 'waiting_approval' | null { return resolveModalParkStatus(this); }
    approvalRecentlyResolvedLocally(now = Date.now()): boolean { return approvalRecentlyResolvedLocally(this, now); }
    isTransientToolConsent(now = Date.now()): boolean { return isTransientToolConsent(this, now); }

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
        return evidence.getLiveTurnPendingEvidence(this);
    }

    /**
     * TERMINAL-ADMISSION-ALL-PATHS: observation bundle for the mesh-side terminal-
     * admission choke point — see completion/evidence.ts (observations only, never a
     * verdict; the ordered rules live in mesh/mesh-terminal-admission.ts).
     */
    getTerminalAdmissionObservations(nowMs?: number): evidence.TerminalAdmissionObservations {
        return evidence.getTerminalAdmissionObservations(this, nowMs ?? Date.now());
    }

    /**
     * MID-TURN-LIVE-STATE-GATE: boolean wrapper over getLiveTurnPendingEvidence above.
     * The rationale for WHICH discriminators make a turn "pending" (adapter-pending /
     * modal-parked / NATIVE-TRAILING-TOOL-GATE) lives with the implementation in
     * completion/evidence.ts, not here.
     */
    hasLiveTurnPendingEvidence(): boolean {
        return this.getLiveTurnPendingEvidence().pending;
    }
    getDrainStatus(): 'idle' | 'generating' | 'modal_parked' | 'other' { return getDrainStatus(this); }

    /**
     * Apply an interactive-prompt answer and REPORT what actually happened —
     * the awaitable counterpart to the fire-and-forget `onEvent` branch below.
     * Throws on every failure so the caller can return a real error instead of
     * the silent `success: true` that left a picker parked for ~5 minutes.
     * See providers/interactive-prompt-apply.ts for the full rationale.
     */
    async applyInteractivePromptResponse(data: unknown): Promise<AppliedInteractivePromptAnswer> {
        const applied = await applyInteractivePromptAnswer({
            held: this.activeInteractivePrompt,
            data,
            adapter: this.adapter,
            providerType: this.type,
        });
        if (this.activeInteractivePrompt?.promptId === applied.promptId) {
            this.activeInteractivePrompt = null;
        }
        return applied;
    }

    /**
     * The option list the session is CURRENTLY holding, for error reporting.
     * When an answer fails to resolve, the caller returns this so the
     * coordinator can retry against the real labels instead of guessing.
     */
    describeActiveInteractivePrompt(): ActiveInteractivePromptDescription | null {
        return describeInteractivePrompt(this.activeInteractivePrompt);
    }

    onEvent(event: string, data?: any): void | Promise<ProviderSendMessageResult> {
        if (event === 'send_message') {
            return sendMessageEvent(this, data);
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
            }
        } else if (event === 'interactive_prompt_response' && data) {
            // LEGACY fire-and-forget answer path (dashboard-local answers and
            // pre-verified callers). Every failure here is log-only by design —
            // there is no caller to return an error to. Callers that need to
            // know whether the answer actually landed must use the awaitable
            // applyInteractivePromptResponse above instead; see
            // providers/interactive-prompt-apply.ts.
            this.activeInteractivePrompt = applyInteractivePromptAnswerFireAndForget({
                held: this.activeInteractivePrompt,
                data,
                adapter: this.adapter,
                providerType: this.type,
            });
        } else if (event === 'provider_state_patch' && data && typeof data === 'object') {
            this.applyProviderResponse(data, { phase: 'immediate' });
        }
    }

    recordAcknowledgedUserInput(input: InputEnvelope | string, sourceMessageId?: string): void {
        runtimeMessages.recordAcknowledgedUserInput(this, input, sourceMessageId);
    }
    antigravityClaimOwner(): string { return antigravityClaimOwner(this); }

    /**
     * DISPOSED-INSTANCE SILENCE. dispose() does not stop the world: the adapter's
     * driver keeps emitting state while the PTY tears down (seconds), the status
     * callback keeps calling detectStatusTransition, and pushEvent's direct path
     * (context.emitProviderEvent) delivers whatever that produces. Standalone live
     * check 2026-09-22: a session stopped MID-TURN logged `status: generating →
     * idle` and "waiting to emit completed until transcript finalizes" 12s AFTER
     * stop_cli — it was one transcript condition away from reporting a killed turn
     * as `agent:generating_completed`. A removed instance may report exactly one
     * thing: its own death. 
     */
    disposed = false;
    dispose(): void { dispose(this); }

    completedDebounceTimer: NodeJS.Timeout | null = null;
    completedDebouncePending: CompletedDebouncePending | null = null;
    /**
     * (CANCEL-BLIP-ORPHAN) Re-verification watch for an arm the continuity cancel just
     * deleted — the cancelled arm's snapshot plus a bounded recheck budget, so a
     * sub-second PTY blip cannot permanently orphan the completion. Full rationale:
     * completion/cancel-recheck.ts.
     */
    cancelledCompletionRecheck: CancelledCompletionRecheck | null = null;
    cancelledCompletionRecheckTimer: NodeJS.Timeout | null = null;
    lastExternalCompletionProbe: ExternalTranscriptProbe | null = null;
    // (NATIVE-TURN-SIGNAL) Terminal markers from the last native transcript read. Refreshed
    // on every completion probe; null when the provider surfaces none.
    lastNativeTurnTerminalMarkers: NativeTurnTerminalMarker[] | null = null;
    /** TX-FSM: lazily-created transcript signal normalizer. Fed ONLY by
     *  transcript reads this instance already performs — it adds zero I/O.
     *  Stage 0: its output was a pure shadow observation for the FSM driver.
     *  Stage 1: the instance's own stall/growth-hold judgments consume the
     *  normalized snapshot too (single source of truth). */
    transcriptSignalSource: TranscriptSignalSource | null = null;
    /** TX-FSM Stage 1: the latest snapshot the source produced (set inside
     *  publishTranscriptSignalObservation). Consumed the same tick by the
     *  stall-path / growth-hold judgments via probeNativeTranscriptSignals —
     *  never treated as fresh across ticks. */
    lastTranscriptSignalSnapshot: SignalSnapshot | null = null;
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
    lastCompletionSummary: { content: string; receivedAt: number; sourceTimestampMs?: number } | null = null;

    /**
     * (SUMMARY-SCRAPE-FALLBACK, part B) Provenance of the finalSummary the completion
     * machinery resolved most recently — written by completionFinalSummary /
     * cleanCompletionFinalSummary (see completion/evidence.ts). The emit paths read it
     * immediately after resolving the summary and stamp it onto completionDiagnostic, so a
     * summary that came from the PTY screen scrape of a native-source provider (and may
     * therefore be clipped mid-sentence) is visibly marked instead of silently trusted.
     */
    lastFinalSummaryProvenance: evidence.FinalSummaryProvenance | null = null;

    // Double-emit guard: the (taskId, wall-clock) of the most recent
    // agent:generating_completed this instance emitted, stamped by
    // emitGeneratingCompleted. taskId '' covers an ad-hoc (no-task) turn. null = none
    // emitted yet.
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
    lastEmittedCompletion:
        | { taskId: string; at: number; evidenceLevel?: string; weak: boolean; emittedAtEpoch: number }
        | null = null;

    /** See completion/evidence.ts — pure message-content check (verbatim move). */
    completionHasFinalAssistantMessage(messages: unknown, turnStartedAt?: number): boolean {
        return evidence.completionHasFinalAssistantMessage(messages, turnStartedAt);
    }

    /** See completion/evidence.ts — probe state stays instance-owned. */
    recordPendingTranscriptProbe(pending: CompletedDebouncePending): ExternalTranscriptProbe | null {
        return evidence.recordPendingTranscriptProbe(this, pending);
    }
    spawnedEnvOverrides(): Record<string, string> | undefined { return spawnedEnvOverrides(this); }

    /**
     * See completion/evidence.ts — session-own native-transcript read (verbatim
     * move; KIMI-RC30 manifest opt-in and the ANTIGRAVITY pin/floor recovery
     * provenance live with the module).
     */
    readExternalCompletionMessages(opts?: { allowManifestNativeSource?: boolean }): unknown[] | null {
        return evidence.readExternalCompletionMessages(this, opts);
    }
    publishTranscriptSignalObservation(messages: unknown[] | null, error = false): void { publishTranscriptSignalObservation(this, messages, error); }

    // Like lastVisibleAssistantSummary but also returns the source bubble's own
    // timestamp (ms), so a cached summary can later be turn-scoped: the display
    // cache is populated from an UNSCOPED tail read (it must show the answer as
    // soon as native-history has it), so it can hold a bubble that predates the
    // current turn. Recording the bubble's timestamp lets the weak-completion
    // fallback reject a turn-stale cached summary instead of re-leaking the exact
    // stale bubble the turn-boundary gate already rejected (FALSE-IDLE Defect 1c).
    lastVisibleAssistantSummaryDetail(messages: unknown): { content: string; timestampMs?: number } {
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

    /** See completion/evidence.ts — FALSE-IDLE Defect 1c turn-scoped cache view. */
    cachedInTurnCompletionSummaryContent(turnStartedAt?: number): string {
        return evidence.cachedInTurnCompletionSummaryContent(this, turnStartedAt);
    }

    /**
     * See completion/evidence.ts — the finalization gate's evidence probe
     * (verbatim move; FALSEIDLE FixB upper bound, TX-FSM Stage 2.1
     * KIMI-PARSED-RACE, ANTIGRAVITY-PREMATURE-COMPLETION provenance live with
     * the module).
     */
    completionFinalAssistantEvidence(parsedMessages: unknown, turnStartedAt?: number): CompletionFinalAssistantEvidence {
        return evidence.completionFinalAssistantEvidence(this, parsedMessages, turnStartedAt);
    }

    /**
     * See completion/evidence.ts — the finalSummary provenance chain (verbatim
     * move; native transcript > parsed screen, NOTIF Defect-B / FALSE-IDLE
     * Defect 1b turn-scoping, KIMI-RC30 manifest native-source preference).
     */
    completionFinalSummary(parsedMessages: unknown, turnStartedAt?: number): string | undefined {
        return evidence.completionFinalSummary(this, parsedMessages, turnStartedAt);
    }

    buildCompletedFinalizationDiagnostic(args: {
        blockReason: string;
        latestStatus?: any;
        latestVisibleStatus: string;
        waitedMs: number;
        pending: CompletedDebouncePending;
        emittedAfterFinalizationTimeout: boolean;
    }): Record<string, unknown> {
        return completionDiagnostics.buildCompletedFinalizationDiagnostic(
            this,
            args,
        );
    }

    hasAdapterPendingResponse(): boolean {
        return completionDiagnostics.hasAdapterPendingResponse(this);
    }

    shouldSuppressStaleParsedBusyStatus(parsedStatus: any, adapterStatus: any): boolean {
        return completionDiagnostics.shouldSuppressStaleParsedBusyStatus(
            this,
            parsedStatus,
            adapterStatus,
        );
    }

    /**
     * A-3/Phase-1 (completion-engine rewrite): thin back-compat delegate. The
     * finalization judgment now lives in completion/completion-engine.ts
     * (evaluateFinalizationBlock). This wrapper keeps the historical private API —
     * the per-incident regression suites drive it directly — and preserves the
     * evidence-stash side effect on `pending` (resolvedFinal*: the TOCTOU-free
     * finalSummary snapshot).
     */
    getCompletedFinalizationBlock(latestVisibleStatus: string, pending: CompletedDebouncePending): CompletedFinalizationBlock | null {
        const reader = this.buildCompletionSignalReader(pending, latestVisibleStatus);
        const { block, evidencePatch } = evaluateFinalizationBlock(pending, reader, this.completionEnginePolicy());
        this.applyCompletionArmPatch(pending, evidencePatch);
        return block as CompletedFinalizationBlock | null;
    }

    scheduleCompletedDebounceFlush(delayMs: number): void {
        if (this.completedDebounceTimer) clearTimeout(this.completedDebounceTimer);
        this.completedDebounceTimer = setTimeout(() => this.flushCompletedDebounceIfFinalized(), delayMs);
    }

    /**
     * (CANCEL-BLIP-ORPHAN) Post-cancel completion re-verification. The judgment and its
     * full rationale live in completion/cancel-recheck.ts; these are the host-dispatched
     * seams, matching the status-transition / evidence / stall-rescue moves.
     */
    armCancelledCompletionRecheck(
        pending: CompletedDebouncePending,
        reason: CancelledCompletionReason,
    ): void {
        armCancelledCompletionRecheck(this, pending, reason);
    }

    clearCancelledCompletionRecheck(): void {
        clearCancelledCompletionRecheck(this);
    }
    isMeshWorkerSession(): boolean { return isMeshWorkerSession(this); }
    getTerminalScreenSnapshot(maxBytes?: number): {
        text: string;
        cursor: { col: number; row: number };
        cols: number;
        rows: number;
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        hash: string;
    } | null { return getTerminalScreenSnapshot(this, maxBytes); }
    injectKeys(items: MeshSendKeyItem[], opts: { allowModalOverride?: boolean } = {}): Promise<
        | { ok: true; keys: MeshSendKeyName[]; hasDestructive: boolean; submits: boolean; bytes: number }
        | { ok: false; refused: 'submit_race' | 'actionable_modal' | 'generating' | 'not_mesh_worker'; keys: MeshSendKeyName[]; hasDestructive: boolean; message?: string }
    > { return injectKeys(this, items, opts); }

    /** MESH-STALL-WATCH — see checkMeshWorkerStall (cli-provider-mesh-session.ts). */
    checkMeshWorkerStall(now: number = Date.now()): void { checkMeshWorkerStall(this, now); }
    probeNativeTranscriptSignals(): { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null { return probeNativeTranscriptSignals(this); }

    /**
     * TX-FSM Stage 2: is the bounded busy lease enabled for THIS provider?
     * This is the canary rollout gate (busy-lease-gate.ts) — a per-provider
     * feature switch, NOT a classification (transcript class/timing still come
     * from resolveTranscriptAuthorityProfile only). Resolved per call so an
     * env-driven rollout change takes effect without rebuilding the instance;
     * any resolver error fails closed (lease disabled → pre-Stage-2 behavior).
     */
    busyLeaseGateEnabled(): boolean {
        try { return resolveBusyLeaseGate(this.type).enabled; } catch { return false; }
    }
    nativeTurnTerminalMarker(turnStartedAt?: number): NativeTurnTerminalMarker | null { return nativeTurnTerminalMarker(this, turnStartedAt); }

    isAutonomousMeshSession(): boolean { return isAutonomousMeshSession(this); }
    inApprovalResumeGrace(now = Date.now()): boolean { return inApprovalResumeGrace(this, now); }
    completingTurnTaskId(): string | undefined { return completingTurnTaskId(this); }
    meshTraceCtx(event = 'agent:generating_completed'): Record<string, unknown> { return meshTraceCtx(this, event); }

    // COMPLETION-EARLYNOTIFY instrumentation. A session-keyed FSM-transition +
    // completion-gate snapshot recorded into the shared debug-trace ring buffer
    // (secret-safe, length/role/pattern-name only — never screen or bubble text).
    // Retrieved via getRecentDebugTrace (chat_debug_bundle). Both categories are a
    // no-op unless collectDebugTrace is on AND the category is selected, so the
    // hot-path guards below (completionTraceOn / fsmTraceOn) keep production cost
    // at a single boolean check.
    completionTraceOn(): boolean {
        return shouldCollectTraceCategory('completion-gate');
    }
    fsmTraceOn(): boolean {
        return shouldCollectTraceCategory('fsm-transition');
    }
    recordCompletionGateTrace(stage: string, payload: Record<string, unknown>): void {
        recordDebugTrace({
            category: 'completion-gate',
            stage,
            level: 'debug',
            sessionId: this.instanceId,
            providerType: this.type,
            payload,
        });
    }
    recordFsmTransitionTrace(payload: Record<string, unknown>): void {
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
    completionEnginePolicy(): CompletionPolicy {
        return {
            finalizationRetryMs: COMPLETED_FINALIZATION_RETRY_MS,
            finalizationMaxWaitMs: COMPLETED_FINALIZATION_MAX_WAIT_MS,
            backgroundTaskHoldMaxMs: BACKGROUND_TASK_HOLD_MAX_MS,
            canonCMinElapsedFloorMs: CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS,
            transcriptGrowthQuietMs: MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
            holdClassHardCapMs: ANTIGRAVITY_HOLD_HARD_CAP_MS,
            ptyParsedFinalAssistantQuietDwellMs: PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS,
            terminalBlockHardCapMs: TERMINAL_BLOCK_HARD_CAP_MS,
            nativeSummaryWriteWaitMaxMs: evidence.NATIVE_SUMMARY_WRITE_WAIT_MAX_MS,
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
    buildCompletionSignalReader(pending: CompletedDebouncePending, visibleStatusOverride?: string): CompletionSignalReader {
        return completionDiagnostics.buildCompletionSignalReader(
            this,
            pending,
            visibleStatusOverride,
        );
    }

    /** Applies an engine decision's pending-record patch (null clears a field). */
    applyCompletionArmPatch(pending: CompletedDebouncePending, patch: CompletionArmPatch): void {
        if ('loggedBlockReason' in patch) pending.loggedBlockReason = patch.loggedBlockReason ?? undefined;
        if ('backgroundTaskHoldSince' in patch) pending.backgroundTaskHoldSince = patch.backgroundTaskHoldSince ?? undefined;
        if ('resolvedFinalMessages' in patch) pending.resolvedFinalMessages = (patch.resolvedFinalMessages ?? undefined) as any;
        if ('resolvedFinalEvidenceSource' in patch) pending.resolvedFinalEvidenceSource = (patch.resolvedFinalEvidenceSource ?? undefined) as any;
        if ('resolvedFinalEvidenceObservedAt' in patch) pending.resolvedFinalEvidenceObservedAt = patch.resolvedFinalEvidenceObservedAt ?? undefined;
    }

    /** Human log + mesh trace for a hold decision — messages preserved verbatim per hold id. */
    logCompletionHold(decision: Extract<CompletionFlushDecision, { kind: 'hold' }>): void {
        completionDiagnostics.logCompletionHold(this, decision);
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
    flushCompletedDebounceIfFinalized(): void {
        completionFlush.flushCompletedDebounceIfFinalized(this);
    }

    /** See completion/evidence.ts — EMPTY-FINAL-CONTENT TOCTOU snapshot preference. */
    cleanCompletionFinalSummary(pending: CompletedDebouncePending): string | undefined {
        return evidence.cleanCompletionFinalSummary(this, pending);
    }
    finalSummaryProvenanceDiagnostic(emittedSummary: string | undefined): Record<string, unknown> { return finalSummaryProvenanceDiagnostic(this, emittedSummary); }
    nativeTurnTerminalSummary(turnStartedAt?: number): string | undefined { return nativeTurnTerminalSummary(this, turnStartedAt); }

    /** See completion/evidence.ts — KIMI-RC30 forced-emit native snapshot seed. */
    snapshotExternalNativeCompletionSummary(pending: CompletedDebouncePending): string | undefined {
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
    emitGeneratingCompleted(opts: {
        chatTitle: string;
        duration: number | undefined;
        timestamp: number;
        taskId?: string;
        finalSummary?: string;
        evidenceLevel?: string;
        completionDiagnostic?: Record<string, unknown>;
    }): void {
        completionFlush.emitGeneratingCompleted(this, opts);
    }
    hasEmittedGenuineCompletionForCurrentEpoch(): boolean { return hasEmittedGenuineCompletionForCurrentEpoch(this); }

    /**
     * AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval projection — see
     * completion/approval-gate.ts (verbatim move; sticky state stays
     * instance-owned for the suites).
     */
    stabilizeFlappingApprovalStatus(adapterStatus: any, now = Date.now()): any {
        return approvalGate.stabilizeFlappingApprovalStatus(this, adapterStatus, now);
    }

    /**
     * PTY auto-approve decision for one status frame — the settle/hysteresis/
     * flap-continuity/mask-stall machinery lives in completion/approval-gate.ts
     * (verbatim move; episode state stays instance-owned for the suites).
     */
    maybeAutoApproveStatus(adapterStatus: any, now = Date.now()): boolean {
        return approvalGate.maybeAutoApproveStatus(this, adapterStatus, now);
    }

    /**
     * Re-drive the auto-approve check after the settle quiet window elapses.
     * APPROVAL Defect-C: re-probe with a LIVE parse (allowParse:true) — the
     * cached engine snapshot can hold a null/stale modal for a between-writes
     * arrival, which made this recheck a silent no-op and stranded quiet
     * approvals. Stays on the instance (not the gate module) so the timer path
     * dispatches through instance-level overrides, exactly as before the move.
     */
    recheckAutoApproveSettled(): void {
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
    emitAgentReadyOnce(chatTitle: string, now: number): void {
        if (this.agentReadyEmitted) return;
        this.agentReadyEmitted = true;
        this.pushEvent({ event: 'agent:ready', chatTitle, timestamp: now });
    }

    detectStatusTransition(cause?: AdapterChangeCause): void {
        runStatusTransitionTick(this, cause);
    }

    /** Attach (or detach with null) the lifecycle port (wiring-unification B2). */
    setSessionEventPort(port: SessionEventPort | null): void {
        this.lifecyclePort = port;
        if (!port) {
            this.lastPromptFingerprint = '';
            this.lastModalFingerprint = '';
        }
    }

    /** Attach (or detach with null) the turn-evidence port (wiring-unification C5). */
    setTurnEvidencePort(port: TurnEvidencePort | null): void {
        this.turnEvidencePort = port;
    }

    /**
     * The live per-turn attempt for THIS session, if the mesh assignment
     * attached one (`cli-provider-mesh-assignment.ts`'s `meshActiveAttemptId`).
     * This is a resolution helper, not a new storage mechanism — the scalar
     * remains the only attempt-id storage on the instance today (per the C-W5
     * brief §2); every producer site below resolves through this ONE function
     * rather than reading `settings.meshActiveAttemptId` directly, so a future
     * per-turn attempt tracker (replacing the scalar) only needs to change
     * this one method. `generation` is `meshActiveAttemptGeneration` (from the
     * dispatch's `meshContext.attemptGeneration`), 0 when absent; the ledger's
     * own `resolveAttempt` treats an absent/0
     * generation as "resolve centrally" when it has better information.
     */
    currentAttemptRef(): TurnAttemptRef | null {
        return meshAssignment.currentMeshAttemptRef(this.settings);
    }

    /** The ledger's `release_attempt_ref` effect for this session (C4/C5). */
    releaseAttemptRef(attemptId: string): boolean {
        return meshAssignment.releaseMeshAttemptRef(this, attemptId);
    }

    pushEvent(event: ProviderEvent): void {
        if (this.disposed && event.event !== 'agent:stopped') {
            LOG.info('CLI', `[${this.type}] dropped ${event.event} from disposed instance ${this.instanceId} — a removed session may only report its own stop`);
            return;
        }
        providerEvents.pushEvent(this, event);
    }

    applyProviderResponse(data: any, options: { phase: 'immediate' | 'turn_completed' }): void {
        providerEvents.applyProviderResponse(this, data, options);
    }
 // ─── Adapter access (backward compat) ──────────────────

    getAdapter(): SpecCliAdapter {
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

    shouldUsePtyAutoApprove(): boolean {
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
    autoApproveEffectivelyActive(status: string | undefined, now = Date.now()): boolean { return autoApproveEffectivelyActive(this, status, now); }

    // STATUS-MISMATCH: true once the current auto-approve episode has been masking
    // waiting_approval behind `generating` for longer than AUTO_APPROVE_MASK_STALL_MS without
    // resolving (the settle gate never fired). When stalled, the surface mask must be dropped
    // so read_chat / mesh_status / the dashboard see the real waiting_approval + modal (and a
    // coordinator can mesh_approve it). autoApproveMaskSince is maintained by
    // maybeAutoApproveStatus (driven by getState + the recheck timer during a waiting episode);
    // this read is side-effect-free so getStatusMetadata can consult it too.
    autoApproveMaskStalled(now = Date.now()): boolean {
        return approvalGate.autoApproveMaskStalled(this, now);
    }
    recordAutoApproval(modalMessage?: string, buttonLabel?: string, now = Date.now()): void { recordAutoApproval(this, modalMessage, buttonLabel, now); }
    recordApprovalSelection(buttonText: string): void { recordApprovalSelection(this, buttonText); }

    maybeAppendRuntimeRecoveryMessage(runtime: PtyRuntimeMetadata | null): void {
        runtimeMessages.maybeAppendRuntimeRecoveryMessage(this, runtime);
    }

    appendRuntimeSystemMessage(content: string, dedupKey: string, receivedAt = Date.now()): void {
        runtimeMessages.appendRuntimeSystemMessage(this, content, dedupKey, receivedAt);
    }

    appendRuntimeMessage(message: ChatMessage, dedupKey: string): void {
        runtimeMessages.appendRuntimeMessage(this, message, dedupKey);
    }

    mergeRuntimeChatMessages(parsedMessages: ChatMessage[]): ChatMessage[] {
        return runtimeMessages.mergeRuntimeChatMessages(this, parsedMessages);
    }

    promoteProviderSessionId(sessionId: string, opts: { authoritative?: boolean } = {}): void {
        historySync.promoteProviderSessionId(this, sessionId, opts);
    }

    shouldHydrateExistingProviderHistory(): boolean {
        return historySync.shouldHydrateExistingProviderHistory(this);
    }

    shouldSuppressFreshLaunchStartupReplay(parsedMessages: unknown[], parsedStatus: any, adapterStatus: any, parsedProviderSessionId = ''): boolean {
        return historySync.shouldSuppressFreshLaunchStartupReplay(
            this,
            parsedMessages,
            parsedStatus,
            adapterStatus,
            parsedProviderSessionId,
        );
    }

    syncCanonicalSavedHistoryIfNeeded(options: { full?: boolean } = {}): boolean {
        return historySync.syncCanonicalSavedHistoryIfNeeded(this, options);
    }

    private restorePersistedHistoryFromCurrentSession(): void {
        historySync.restorePersistedHistoryFromCurrentSession(this);
    }

}
