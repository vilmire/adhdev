/**
 * SpecCliAdapter — bridges SpecDriver into the daemon's CliAdapter
 * interface so an existing CliProviderInstance can drive a spec-backed
 * provider without rewriting the surrounding session machinery.
 *
 * Translation:
 *   spec state.id 'approval' (with modal_buttons that produced a modal)
 *     → CliAdapterStatus.status='waiting_approval', activeModal={...}
 *   spec state.id 'busy' / any non-decision state with a 'busy' label
 *     → status='generating'
 *   spec state.id 'idle' or default
 *     → status='idle'
 *
 * Methods that the round-3 spec model doesn't have an opinion on
 * (transcript reading, slash commands, history, runtime metadata
 * surfacing) are minimal stubs. They satisfy the daemon's call sites
 * without pretending to implement anything.
 */
'use strict';
import { FsmDriver } from './fsm-driver.js';
import type { DashboardEvent, ISpecDriver } from './fsm-driver-types.js';
import type { ClaimedQueuedSend } from './send-submit-engine.js';
import type { QueuedWriteOutcome } from './submit-policy.js';
import { invokeSpecControl } from './picker-controls.js';
import { executeNativeHistory } from './native-history-executor.js';
import type { NativeHistoryInput } from './native-history-types.js';
import { expandToolBlock, type ToolBlockExpandResult } from './tool-block-expand.js';
import { detectBackgroundTaskActive } from './background-task-detector.js';
import {
    buildSpecDebugSnapshot, extractCodexSessionIdFromScreen,
    scrapeScreenAssistantMessages, screenScrapeSupported, type SpecDebugView,
} from './spec-adapter-readouts.js';
import * as fs from 'node:fs';
import type { NativeHistoryConfig, Control } from './types.js';
import { resolveInterruptCapability, type InterruptCapability } from './interrupt-capability.js';
import type { AdapterChangeCause, CliAdapter, CliAdapterStatus } from '../../cli-adapter-types.js';
import type { ChatMessage } from '../../types.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import type { SessionTermination } from '@adhdev/session-host-core';
import type { ResolvedTrustPlan } from '../trust-provenance-ledger.js';
import type { MeshSendKeyItem } from '../../cli-adapters/provider-cli-shared.js';
import {
    injectSpecKeys,
    interruptSpecTurn,
    readTerminalScreenSnapshot,
    type SpecTerminalHost,
    type TerminalScreenSnapshot,
} from './spec-adapter-terminal.js';
import { LOG } from '../../logging/logger.js';
import type { SignalDetection } from './signal-rules.js';
import {
    detectClaudeAskUserQuestionPromptFromJson,
    type InteractivePrompt,
    type InteractivePromptResponse,
} from '../types/interactive-prompt.js';
import { buildKimiInteractiveTuiAnswerSteps } from '../types/interactive-prompt.js';
import {
    detectKimiPendingQuestion, detectKimiIdleSelectorPrompt,
    buildKimiSelectorAnswerSteps, KIMI_TUI_SELECTOR_PROMPT_PREFIX,
} from '../kimi-pending-question.js';
import type { FsmStatus, InteractivePrompts } from './fsm-types.js';
import { projectAdapterStatus } from './adapter-status-projection.js';
import {
    answerClaudeInteractivePrompt,
    detectClaudeNativePendingQuestion,
    hasBoundClaudeAskUserQuestionToolResult,
    maybeCaptureClaudeTuiPrompt,
    maybeClearResolvedClaudeTuiPrompt,
    maybeUpgradeClaudeTuiMultiSelect,
    type ClaudeTuiPromptHost,
} from './claude-tui-prompt.js';

import type { ProviderFailure } from './provider-failure-classifier.js';
import { authBillingLatchLogLine, classifyAuthBillingOutput, createLiveAuthState, exitClassificationAllowed, noteLiveAuthMatch, resolveLiveAuthSuspect, TAIL_BYTES, type LiveAuthContext, type LiveAuthState } from './live-auth-advisory.js';
import { RawTail } from './raw-tail.js';
import { recordSentPrompt } from '../native-history/sent-prompt-registry.js';

/** What the adapter reports on PTY death (replaces the deleted shared/session-termination-sink). */
export interface SpecAdapterExitReport { termination?: SessionTermination; runtimeSettings: Readonly<Record<string, unknown>> }
/** What the adapter reports on a matched signal rule (replaces the deleted shared/provider-signal-sink). */
export interface SpecAdapterSignalReport { providerType: string; workspace: string; runtimeSettings: Readonly<Record<string, unknown>>; signal: SignalDetection }

export class SpecCliAdapter implements CliAdapter {
    readonly cliType: string;
    readonly cliName: string;
    readonly workingDir: string;
    /**
     * Marker the daemon's finalization gate checks: `getStatus()` returns
     * `messages: []` by design here (chat history lives in the daemon's
     * native-history pipeline, not the adapter). Without this flag,
     * cli-provider-instance's `missing_final_assistant` gate would stall
     * every turn until the 30s safety timeout because it expects the
     * adapter to surface the final assistant message.
     */
    readonly chatMessagesOwnedExternally = true as const;

    private driver: ISpecDriver;
    /** Common spec fields the adapter reads, present in both v3 and v4. */
    private spec: {
        id: string;
        name: string;
        control_bar?: Control[];
        native_history?: NativeHistoryConfig;
        interactive_prompts?: InteractivePrompts;
    };
    /** Owning session id (session registry / read-path targetSessionId) —
     *  the sidecar-claim owner token for wire-based prompt detection. */
    private owningSessionId?: string;
    /** Runtime settings are the authoritative in-daemon mesh binding. They are
     *  mirrored here so the PTY exit seam can attribute a host tombstone before
     *  the owning provider instance is disposed. */
    private runtimeSettings: Record<string, unknown> = {};
    private latestState: { id: string; label: string; title: string | null; status: FsmStatus } | null = null;
    private latestModal: { title: string | null; buttons: { index: number; label: string }[]; kind?: 'approval' | 'picker' | 'confirm' | null } | null = null;
    private statusCallback: (() => void) | null = null;
    private changeCallback: ((cause: AdapterChangeCause) => void) | null = null;
    private exitCallback: ((report: SpecAdapterExitReport) => void) | null = null;
    private signalCallback: ((report: SpecAdapterSignalReport) => void) | null = null;
    private approvalResolvedCallback: ((event: { resolvedAt: number; buttonLabel?: string }) => void) | null = null;
    private ptyDataCallback: ((data: string) => void) | null = null;
    private activeInteractivePrompt: InteractivePrompt | null = null;
    private interactivePromptTransport: 'stream-json' | 'tui' | null = null;
    private claudeTuiPromptCaptureInFlight = false;
    /**
     * OWNER-INPUT-WINS latch for the claude TUI capture pass. The multi-question
     * capture injects Tab/Shift-Tab into the PTY to snapshot pages 2..N — the
     * SAME input stream an owner answering in the attached terminal is typing
     * into. A single-question prompt never injects (its page loop is empty),
     * which is exactly the reported "1개일 때는 항상 동작, 2~3개일 때 꼬인다"
     * split. Set by writeRaw() when a keystroke arrives while the picker footer
     * is on screen; while set, no capture starts and any in-flight capture
     * bails before its next injected key. Cleared once the picker footer has
     * stayed off the screen across the repaint-grace window — a single
     * footer-less frame is claude mid-repaint, not a closed picker (the next
     * prompt may capture again after the grace elapses).
     */
    private claudeTuiCaptureSuppressed = false;
    /**
     * Failed-capture bookkeeping, keyed by the nav-line identity of the prompt.
     * A capture that ends without a prompt (page unparsable — e.g. options
     * scrolled out) used to re-arm on EVERY pty_data frame, turning detection
     * into a continuous Tab/Shift-Tab injection storm (the owner-visible
     * "디텍트가 한번 더 되면서 꼬인다"). Attempts are now bounded per prompt;
     * the count resets when the picker leaves the screen.
     */
    private claudeTuiCaptureFailures: { key: string; count: number } | null = null;
    /**
     * Wall clock of the first consecutive frame on which the picker footer was
     * absent. claude-cli repaints the picker across several PTY chunks (see
     * interactivePromptLostAt), so ONE footer-less frame is not proof the
     * picker left — clearing the owner-input latch on such a frame re-armed
     * capture mid-repaint and restarted Tab/Shift-Tab injection while the
     * owner was typing (the residual of the submit-tangle bug with the latch
     * already in place). The latch and the failure budget therefore re-arm
     * only after the footer has stayed absent for
     * INTERACTIVE_PROMPT_LOST_GRACE_MS — the same hysteresis the prompt-lost
     * path already uses.
     */
    private claudeTuiCaptureFooterAbsentAt: number | null = null;
    /**
     * Wall clock of the first frame on which a held interactive prompt was
     * observed to have left the screen. Mirrors the approval FSM's
     * `modalLostAt` hysteresis (see cli-state-engine.ts): claude-cli's TUI
     * repaints the choice picker as several PTY chunks, so a single frame
     * with no "Enter to select" footer is not proof the prompt is gone — it
     * may just be mid-repaint. We only clear the held prompt once it has
     * been absent across a short grace window. Reset to null the moment the
     * prompt footer reappears.
     *
     * Without this, a choice prompt resolved *directly in the terminal* (the
     * user picked an option without going through ADHDev's
     * setInteractivePromptResponse) was never cleared from
     * `activeInteractivePrompt`, so getStatus() re-emitted the same prompt
     * forever — the choice-resolve-stuck bug.
     */
    private interactivePromptLostAt: number | null = null;
    /** ONE raw PTY tail (C6): strippedTail() (auth classifier) / takeCompleteLines()
     *  (JSON-line prompt detector) replace the old failureOutputTail/jsonLineTail
     *  pair — see raw-tail.ts. Lazy like `liveAuth` (Object.create-built suites skip field init). */
    private rawTailBuf?: RawTail;
    private get rawTail(): RawTail { return (this.rawTailBuf ??= new RawTail()); }
    private exited = false;
    private spawned = false;
    private providerFailure: ProviderFailure | null = null;
    /** Live-match suspicion state — policy in live-auth-advisory.ts. Lazy: tests build adapters without the constructor. */
    private liveAuth?: LiveAuthState;
    private lastExitCode: number | null = null;
    private providerSessionId: string | undefined;
    /** Wall clock at the moment spawn() ran. Used as the cutoff for
     *  native-history file selection so a prior session's transcript
     *  can't leak into this session before the agent has written its
     *  own records. */
    private spawnedAtMs = 0;
    /** Env vars the daemon set on the spawned child. Mesh coordinator
     *  points hermes at a per-coordinator HERMES_HOME so the dashboard's
     *  native-history reader needs that override to find the right
     *  state.db; without it the reader sees ~/.hermes/state.db which
     *  the coordinator-launched hermes never writes to. The choice to
     *  redirect HERMES_HOME is a workaround for an unresolved hermes
     *  upstream feature gap (see hermes-agent#23130 — runtime-supplied
     *  MCP config), so this routing keeps the dashboard honest until
     *  hermes ships a runtime MCP override. */
    private spawnedEnv: Record<string, string> = {};
    /** Wall clock at the moment an approval modal was last resolved (auto-approve,
     *  dashboard, or mesh_approve) via a successful button press. Powers
     *  isApprovalRecentlyResolved() — the second suppression signal the mesh event
     *  forwarder uses to drop a duplicate agent:waiting_approval re-emitted across
     *  the approval↔busy TUI flap window (AUTOAPPROVE-FLAP). Mirrors the
     *  cli-state-engine's lastApprovalResolvedAt for the spec-driven adapter path
     *  (claude-cli specs/4.0.json), which previously stubbed the method to false. */
    private lastApprovalResolvedAt = 0;

    constructor(
        specPath: string,
        workingDir: string,
        cliArgs: string[],
        extraEnv: Record<string, string>,
        transportFactory?: PtyTransportFactory,
        /** FSMLOG-SESSION-ATTRIBUTION (D3): owning session id, passed to the driver purely so its
         *  log lines are attributable to a session when several run concurrently. */
        sessionId?: string,
        /** MANIFEST-SEND-DELAY: submit tuning declared by the provider MANIFEST (as opposed to
         *  the spec). Optional so the many test call sites and out-of-tree embedders that build
         *  an adapter without a manifest keep their existing behaviour unchanged. */
        manifestTuning?: {
            sendDelayMs?: number;
            /** PERMISSION-MODE-DUPLICATE: base-arg flags the selected auto-approve mode
             *  replaces, relayed to the driver so they are stripped from the SPEC's
             *  `spawn_args` too — see route.ts's `removeArgs` parameter. */
            removeArgs?: string[];
            /** ★SPAWN-LOG-VERSION: the MANIFEST's provider version, relayed to the
             *  driver purely so the spawn diagnostic can name the bundle. The spec
             *  itself has no version field, which is why that line read `vunknown`. */
            providerVersion?: string;
        },
        resolvedTrustPlan?: ResolvedTrustPlan | null,
    ) {
        const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'));
        this.spec = {
            id: raw.id,
            name: raw.name,
            control_bar: raw.control_bar,
            native_history: raw.native_history,
            interactive_prompts: raw.interactive_prompts,
        };
        this.owningSessionId = sessionId;
        this.cliType = this.spec.id;
        this.cliName = this.spec.name;
        this.workingDir = workingDir;
        this.spawnedEnv = { ...extraEnv };

        // cli-manager.ts allocates providerSessionId per launch and threads
        // it through resume.newSessionArgs as additional cliArgs (e.g.
        // ["--session-id", "<uuid>"]). We must hand those to the driver
        // so the agent uses the daemon's id, otherwise (claude case) the
        // agent generates its own id and the chat-history pipeline can't
        // pair the on-disk transcript with the live session.
        this.driver = new FsmDriver({
            specPath,
            workingDir,
            extraEnv,
            hotReload: true,
            emitTrace: false,
            transportFactory,
            extraCliArgs: cliArgs,
            sessionId,
            manifestSendDelayMs: manifestTuning?.sendDelayMs,
            removeSpawnArgs: manifestTuning?.removeArgs,
            manifestProviderVersion: manifestTuning?.providerVersion,
            resolvedTrustPlan,
        });
        this.driver.subscribe((ev) => this.handleEvent(ev));
    }

    async spawn(): Promise<void> {
        if (this.spawned) return;
        this.driver.start();
        this.spawned = true;
        this.spawnedAtMs = Date.now();
        // SESSION-LIFECYCLE-LOG (defect 1): the START half of the session lifecycle
        // pair. Its END is logged by the mesh termination bridge off the tombstone.
        // Without this line the daemon log has no record that a session ever existed,
        // so an operator grepping for a session id after it dies finds nothing to
        // anchor on — measured 2026-09-11 across 14,715 log lines spanning a
        // coordinator's death: zero session lifecycle lines of either kind.
        //
        // The mesh binding is read from runtimeSettings rather than imported, because
        // `providers/**` must not value-import `mesh/**` (enforced by
        // scripts/check-import-boundaries.mjs) — the same constraint that inverted the
        // termination seam. These are plain string reads of stamps the instance
        // already mirrors here, so no layering arrow is created.
        //
        // ★Content boundary: identifiers and enums only — never prompt or chat text,
        // matching the content-free convention already used by sendMessage below.
        try {
            const settings = this.runtimeSettings as Record<string, unknown>;
            const read = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
            const meshId = read(settings?.meshNodeFor) || read(settings?.meshCoordinatorFor);
            const isCoordinator = !read(settings?.meshNodeFor) && !!read(settings?.meshCoordinatorFor);
            const nodeId = read(settings?.meshNodeId);
            const parts = [
                `session=${this.owningSessionId || 'unknown'}`,
                `provider=${this.cliType}`,
                ...(meshId ? [`mesh=${meshId}`] : []),
                ...(nodeId ? [`node=${nodeId}`] : []),
                `coordinatorSession=${isCoordinator}`,
            ];
            LOG.info('SessionLifecycle', `Session STARTED — ${parts.join(' ')}`);
        } catch {
            // Observability must never break a spawn.
        }
    }

    /**
     * The ordinary send: write now when the FSM is idle, else park in the driver
     * FIFO under `messageId`. Returns the driver's disposition UNMAPPED
     * (wiring-unification D2) — the old `'duplicate' → 'delivered'` fold is gone
     * with the 60 s content gate that produced it; redelivery is absorbed once,
     * by `messageId`, in sessions/session-input-service.ts.
     *
     * FORCE-NO-OP: `opts.force` is accepted for the shared `CliAdapter` contract
     * and deliberately ignored — force-inject-into-generating was retired as a
     * data-loss path (oss 6cca365b); a busy session is reached only through
     * `sendMessageDuringGeneration` (split write) or `interruptTurn`.
     */
    async sendMessage(text: string, opts?: { force?: boolean; bracketedPaste?: boolean; messageId?: string }): Promise<{ status: 'queued'; position: number } | { status: 'delivered' } | void> {
        LOG.info('SpecAdapter', `[${this.cliType}] sendMessage(len=${text.length}${opts?.messageId ? ` id=${opts.messageId}` : ''})`);
        LOG.debug('SpecAdapter', `[${this.cliType}] sendMessage body=${JSON.stringify(text.slice(0, 80))}${text.length > 80 ? '…' : ''}`);
        recordSentPrompt(this.owningSessionId, text);
        if (typeof this.driver.sendMessageWithDisposition !== 'function') {
            this.driver.dispatch({ kind: 'send_message', text, bracketedPaste: opts?.bracketedPaste });
            return;
        }
        const disposition = this.driver.sendMessageWithDisposition(text, opts?.bracketedPaste, opts?.messageId);
        if (disposition.status === 'queued') {
            LOG.info('SpecAdapter', `[${this.cliType}] send QUEUED not submitted — ${disposition.reason} (len=${text.length}, queueDepth=${disposition.queueDepth})`);
            return { status: 'queued', position: disposition.queueDepth };
        }
        return { status: 'delivered' };
    }

    /**
     * SEND-NOW-AGENT-QUEUE: write a body into a GENERATING composer as a split
     * write (text, gap, submit key) so the CLI's own input queue takes it,
     * WITHOUT interrupting the turn in flight. POSIX only.
     *
     * See ISpecDriver.sendMessageDuringGeneration for the live A/B that
     * distinguishes this from the retired force-inject, and for why win32 is
     * refused. A driver that does not implement it (an out-of-tree ISpecDriver,
     * a test double) reports `not_supported` — never a silent success, because
     * the caller's whole contract here is that `accepted: false` means nothing
     * was written and its previous fallback is safe to take.
     */
    sendMessageDuringGeneration(text: string, bracketedPaste?: boolean): QueuedWriteOutcome {
        if (typeof this.driver.sendMessageDuringGeneration !== 'function') {
            return { accepted: false, reason: 'not_supported' };
        }
        LOG.info('SpecAdapter', `[${this.cliType}] sendMessageDuringGeneration(len=${text.length})`);
        const outcome = this.driver.sendMessageDuringGeneration(text, bracketedPaste);
        if (!outcome.accepted) {
            LOG.info('SpecAdapter', `[${this.cliType}] mid-generation send refused — ${outcome.reason} (len=${text.length})`);
        }
        return outcome;
    }

    /**
     * NOTIF-IMMEDIACY: does this session's SPEC opt into mid-turn queued input?
     *
     * Reports the spec's `send_message.mid_generation_queue` declaration only. It
     * deliberately does NOT consider platform or body size — those are the mesh
     * caller's policy and are enforced there — and it does NOT consider the live
     * FSM state, because `sendMessageDuringGeneration` is the single authority on
     * whether a write is admissible right now (a second opinion about session
     * readiness is the class of bug the SEND-OVERLAP work removed).
     *
     * False for any spec that has not been measured against the split write, which
     * is every spec except the ones that explicitly opt in.
     */
    supportsMidGenerationQueue(): boolean {
        if (typeof this.driver.supportsMidGenerationQueue !== 'function') return false;
        return this.driver.supportsMidGenerationQueue() === true;
    }

    /** D2 messageId-keyed FIFO access (see ISpecDriver.claimQueuedSend). */
    hasQueuedSend(messageId: string): boolean { return this.driver.hasQueuedSend?.(messageId) === true; }
    claimQueuedSend(messageId: string): ClaimedQueuedSend | null { return this.driver.claimQueuedSend?.(messageId) ?? null; }
    restoreQueuedSend(claimed: ClaimedQueuedSend): void { this.driver.restoreQueuedSend?.(claimed); }

    /**
     * SEND-NOW-WRONG-ITEM: hold the driver's FIFO drain so this caller owns the
     * next write. See ISpecDriver.reserveDrain for why claiming the pressed body
     * alone lets an entry queued ahead of it win the idle frame.
     */
    reserveDrain(ttlMs: number): void {
        if (typeof this.driver.reserveDrain !== 'function') return;
        this.driver.reserveDrain(ttlMs);
    }

    /** SEND-NOW-WRONG-ITEM: release a reserveDrain() hold. */
    releaseDrain(): void {
        if (typeof this.driver.releaseDrain !== 'function') return;
        this.driver.releaseDrain();
    }

    /** ENTER-LOSS layer ① — see CliAdapter.hasInFlightSubmit. */
    hasInFlightSubmit(): boolean {
        if (typeof this.driver.hasInFlightSubmit !== 'function') return false;
        return this.driver.hasInFlightSubmit();
    }

    /** ENTER-LOSS layer ① — see CliAdapter.whenSubmitDrained. */
    whenSubmitDrained(timeoutMs: number): Promise<boolean> {
        if (typeof this.driver.whenSubmitDrained !== 'function') return Promise.resolve(true);
        return this.driver.whenSubmitDrained(timeoutMs);
    }

    /** ENTER-LOSS layer ③ — scrollback-inclusive screen text for the boot-time
     *  composer-residue sweep. Falls back to the viewport when the driver has no
     *  scrollback surface (test doubles). Same security posture as
     *  getTerminalScreenSnapshot: raw terminal text — callers must never log it. */
    getScrollbackText(): string {
        try {
            if (typeof this.driver.snapshotWithScrollback === 'function') {
                return this.driver.snapshotWithScrollback() || '';
            }
            return this.driver.snapshot() || '';
        } catch { return ''; }
    }

    getStatus(_options?: { allowParse?: boolean }): CliAdapterStatus {
        // Side effects stay here (they touch adapter state / lazily refresh);
        // the DECISION is the pure projection in adapter-status-projection.ts.
        this.maybeConfirmLiveAuthBillingSuspect();
        // kimi_wire prompt hold: refresh on the ROUTINE status poll (not only
        // on chat reads) so a question asked while nobody reads the chat still
        // surfaces promptly — same cadence rationale as the legacy adapter.
        // Guarded by the same spawned/exited preconditions the projection uses,
        // so a dead or unspawned adapter does no work (verbatim ordering from
        // before the extraction: these ran only after those early returns).
        if (!this.providerFailure && !this.exited && this.spawned) {
            this.refreshWirePendingQuestion();
        }
        return projectAdapterStatus({
            providerSessionId: this.providerSessionId,
            providerFailure: this.providerFailure,
            exited: this.exited,
            spawned: this.spawned,
            activeInteractivePrompt: this.activeInteractivePrompt,
            state: this.latestState,
            modal: this.latestModal,
            readySeen: () => this.driver?.hasSeenReady?.(),
            // A5-3: cheap reads of latched driver counters — no snapshot, no
            // re-evaluation — so the watchdog's getStatus({ allowParse: false })
            // poll stays a pure read and cannot itself move the clocks.
            lastOutputAt: this.driver?.getLastOutputAt?.(),
            lastScreenChangeAt: this.driver?.getLastScreenChangeAt?.(),
        });
    }

    /**
     * APPROVE-LATCH-STALE (live defect, 2026-09-23): force ONE FSM re-evaluation
     * against the current screen so `latestModal` stops being whatever the state
     * ENTRY frame happened to parse, then report whether a modal is now latched.
     *
     * Called only from the mesh_approve / resolve_action gate, and only on the
     * failing shape (status says waiting_approval but no modal is latched
     * anywhere). A healthy approve — modal already latched — never reaches here,
     * so the cost is one extra parse on a frame that was about to hard-fail.
     *
     * Deliberately does NOT touch status: the FSM state remains authoritative
     * (adapter-status-projection.ts:81-84). This re-reads the MODAL only.
     *
     * Returns false when the driver exposes no refresh (test doubles, out-of-tree
     * drivers) or when the re-read still finds nothing — the caller distinguishes
     * those from a successful recovery via getStatus().activeModal.
     */
    refreshModalNow(): boolean {
        try {
            if (typeof this.driver.refreshNow !== 'function') return false;
            this.driver.refreshNow();
        } catch (e: any) {
            LOG.warn('SpecAdapter', `[${this.cliType}] refreshModalNow failed: ${e?.message ?? e}`);
            return false;
        }
        return !!this.latestModal && (this.latestModal.buttons?.length ?? 0) > 0;
    }

    getScriptParsedStatus(): { status?: string; messages: unknown[]; title?: string } & Record<string, unknown> {
        const providerSessionId = this.extractProviderSessionIdFromScreen();
        if (providerSessionId) this.providerSessionId = providerSessionId;
        const status = this.getStatus();
        // Background-task passthrough: read the native-history transcript at
        // poll time for causally-owned background tool work (claude-cli
        // run_in_background bash; kimi run_in_background tool.call cells whose
        // launch result returns immediately with `status: running`). This is a
        // NEW signal that rides alongside `status` (it is NOT run through the
        // 5-value FSM normalization). Providers whose transcript the detector
        // cannot authoritatively read report backgroundTaskSupport:'unknown'
        // (an explicit UNKNOWN — never a silent "no background work") and are
        // not gated. Read at each poll — the JSONL trails the live idle
        // transition, so it must be observed BEFORE completion fires, which
        // SUB-B's hold + settle window give us.
        const bg = this.detectBackgroundTask();
        return {
            ...status,
            messages: this.readScreenAssistantMessages(),
            ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
            backgroundTaskSupport: bg.support ?? 'unknown',
            ...(bg.active ? { backgroundTaskActive: true, backgroundTaskCount: bg.count, backgroundTaskIds: bg.ids } : {}),
        };
    }

    private detectBackgroundTask(): { active: boolean; count: number; ids: string[]; support?: 'tracked' | 'unknown' } {
        if (!this.spec.native_history?.source) {
            // antigravity-cli declares no declarative `source` (its authority is
            // the per-session conversations/<uuid>.db, read via the built-in
            // reader) — the detector dispatches on agentType and resolves the
            // store itself. Without this branch antigravity reported
            // support:'unknown' and the background_task_active hold was silently
            // inert (the early-completion defect: a worker ending its turn with
            // an async run_command still running projected completed).
            if (this.cliType === 'antigravity-cli') {
                try {
                    return detectBackgroundTaskActive(undefined, this.nativeHistoryInput({ withOwner: true }));
                } catch {
                    return { active: false, count: 0, ids: [], support: 'unknown' };
                }
            }
            // No transcript source: only the detector can say whether this
            // provider is tracked at all (claude-cli/kimi) or unknown.
            return { active: false, count: 0, ids: [], support: this.cliType === 'claude-cli' || this.cliType === 'kimi' ? 'tracked' : 'unknown' };
        }
        try {
            return detectBackgroundTaskActive(this.spec.native_history, this.nativeHistoryInput({ withOwner: false }));
        } catch {
            return { active: false, count: 0, ids: [], support: 'unknown' };
        }
    }

    shutdown(): void {
        (this.liveAuth ??= createLiveAuthState()).stopRequested = true;
        try { this.driver.dispatch({ kind: 'shutdown' }); } catch { /* ignore */ }
    }

    /** CliManager.detachAll() on daemon shutdown: release the runtime so it
     *  survives the restart (shutdown() would stop it). */
    detach(): void {
        try { this.driver.detach(); } catch { /* ignore */ }
    }

    cancel(): void {
        try { this.driver.dispatch({ kind: 'cancel' }); } catch { /* ignore */ }
    }

    isProcessing(): boolean {
        return this.getStatus().status === 'generating';
    }

    isReady(): boolean {
        return this.spawned && !this.exited;
    }

    // Process liveness for the MESH-STALL-WATCH watchdog (checkMeshWorkerStall).
    // The spec path drives the child through the transport/driver rather than a
    // directly-held ptyProcess handle, so liveness is tracked by the spawned/exited
    // lifecycle flags — the same pair isReady() uses. A spawned, not-yet-exited
    // session is alive. ProviderCliAdapter exposes the equivalent via `ptyProcess !== null`.
    isAlive(): boolean {
        return this.spawned && !this.exited;
    }

    /** Window during which isApprovalRecentlyResolved() reports a just-resolved
     *  approval. Matches CliProviderInstance.APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS
     *  (8000) — the same auto-approve suppression window signal1 uses — so a modal
     *  re-emitted within the approval↔busy flap is suppressed by signal2 too. */
    private static readonly APPROVAL_RESOLVED_COOLDOWN_MS = 8000;

    /** MESH-READ-TERMINAL raw viewport read — see readTerminalScreenSnapshot (SECURITY: never log the text). */
    getTerminalScreenSnapshot(maxBytes?: number): TerminalScreenSnapshot {
        return readTerminalScreenSnapshot(this.driver, maxBytes);
    }

    /**
     * Report whether this provider can have its in-flight turn interrupted,
     * resolved from the spec THIS session actually loaded (never a hardcoded
     * per-provider table — the stop key varies by spec version; hermes-cli
     * ships Ctrl-C in specs/0.14.json and an EMPTY key in specs/4.0.json).
     */
    getInterruptCapability(): InterruptCapability {
        return resolveInterruptCapability(this.cliType, this.spec.control_bar);
    }

    /** Abort the in-flight turn with the provider's own stop key — see interruptSpecTurn. */
    interruptTurn(): ReturnType<typeof interruptSpecTurn> {
        return interruptSpecTurn(this.terminalHost, this.getInterruptCapability());
    }

    /** MESH-SEND-KEYS structured key injection — see injectSpecKeys. */
    injectKeys(items: MeshSendKeyItem[], opts: { allowModalOverride?: boolean } = {}): ReturnType<typeof injectSpecKeys> {
        return injectSpecKeys(this.terminalHost, items, opts);
    }

    private get terminalHost(): SpecTerminalHost {
        return {
            cliType: this.cliType,
            cliName: this.cliName,
            driver: this.driver,
            running: this.spawned && !this.exited,
            latestState: this.latestState,
            latestModal: this.latestModal,
        };
    }

    setOnStatusChange(cb: () => void): void {
        this.statusCallback = cb;
    }

    setOnChange(cb: (cause: AdapterChangeCause) => void): void { this.changeCallback = cb; }

    /** PTY death, reported AFTER the `pty_exit` status tick. The owning instance forwards it to `port.exited` (B4). */
    setOnExit(cb: ((report: SpecAdapterExitReport) => void) | null): void { this.exitCallback = cb; }

    /** A matched spec `signal_rules[]` detection. The owning instance forwards it to `port.signal` (B4). */
    setOnSignal(cb: ((report: SpecAdapterSignalReport) => void) | null): void { this.signalCallback = cb; }

    /** The one poke point (B2): the owner's status-transition tick diffs and emits; this only names the cause. */
    private notifyChange(cause: AdapterChangeCause): void {
        this.changeCallback?.(cause);
        this.statusCallback?.();
    }

    getInteractivePromptTransport(): 'tui' | 'stream-json' | 'wire' | null {
        if (!this.activeInteractivePrompt) return null;
        // kimi_wire holds wire.jsonl / idle-selector prompts without stamping a transport.
        return this.interactivePromptTransport ?? (this.interactivePromptScheme() === 'kimi_wire' ? 'wire' : 'tui');
    }

    setOnPtyData(cb: (data: string) => void): void {
        this.ptyDataCallback = cb;
    }

    writeRaw(data: string): void {
        // Raw pty input — typed characters, escape codes, arrow keys —
        // goes straight to the underlying terminal. send_message would
        // append submit_key after every chunk, which is why typing in
        // the dashboard terminal felt like "enter on every keystroke".
        // OWNER-INPUT WINS: a keystroke while the AskUserQuestion picker is on
        // screen means the owner is answering in the terminal, so suppress the
        // dashboard capture pass (which injects Tab/Shift-Tab into this same
        // stream) for the rest of this picker's lifetime. Best-effort only —
        // a snapshot failure must never block or delay owner input.
        try {
            if (!this.claudeTuiCaptureSuppressed
                && this.interactivePromptScheme() === 'claude_tui'
                && (this.driver.snapshot().includes('Enter to select')
                    // Mid-repaint frames transiently hide the footer (the
                    // picker redraws in chunks), so a held prompt or an
                    // in-flight capture also counts as picker-on-screen
                    // evidence — otherwise a keystroke landing on such a
                    // frame never sets the latch and the next footer frame
                    // starts injecting into the owner's stream.
                    || this.activeInteractivePrompt !== null
                    || this.claudeTuiPromptCaptureInFlight)) {
                this.claudeTuiCaptureSuppressed = true;
            }
        } catch { /* snapshot best-effort */ }
        this.driver.dispatch({ kind: 'pty_write', data });
    }

    resize(cols: number, rows: number): void {
        this.driver.dispatch({ kind: 'resize', cols, rows });
    }

    /** REDRAW-NUDGE: false-busy resize wiggles issued by the FSM driver (read by the mesh stall watchdog). */
    getRedrawNudgeCount(): number {
        return this.driver?.getRedrawNudgeCount?.() ?? 0;
    }

    resolveModal(buttonIndex: number): void {
        this.resolveModalMatched(buttonIndex);
    }

    resolveModalMatched(buttonIndex: number): boolean {
        // BUTTON-INDEX-MISMAP (Fix C): `buttonIndex` is an ARRAY POSITION into the
        // label list this adapter surfaced via getStatus().activeModal.buttons (the
        // same order pickApprovalButton / mesh_approve pick from). The FSM matches a
        // click by the button's DISPLAYED number (evaluator sets button.index =
        // Number(m[1])), which is NOT `arrayPos + 1` for a partial / non-contiguous
        // modal — e.g. a "1. Yes / 3. Always / 4. No" set parses to display indices
        // [1,3,4] at array positions [0,1,2]. Blindly sending `arrayPos + 1` then
        // targets a non-existent display index (2) and handleClickModalButton finds
        // no button → nothing is pressed. Look up the real FSM display index from the
        // same ordered button list instead, and fall back to the legacy +1 only when
        // no modal is captured (defensive; the driver's own guard rejects a miss).
        const buttons = this.latestModal?.buttons ?? [];
        const target = (buttonIndex >= 0 && buttonIndex < buttons.length)
            ? buttons[buttonIndex].index
            : buttonIndex + 1;
        // clickModalButton returns whether the FSM actually found a button for `target`
        // and dispatched its confirm keys — surfaced so mesh_approve can distinguish a
        // real press from a silent miss (the exact false-success the mis-map produced).
        const pressed = this.driver.clickModalButton(target);
        // AUTOAPPROVE-FLAP (signal2): stamp the resolve time ONLY on a real press of an
        // approval-class modal. This is the resolution path for auto-approve, dashboard,
        // and mesh_approve alike, so isApprovalRecentlyResolved() then suppresses a
        // duplicate agent:waiting_approval re-emitted across the approval↔busy flap.
        // Gate on the authoritative FSM status (approval) — a picker/confirm press must
        // NOT arm the approval cooldown. A silent miss (pressed=false) leaves the modal
        // unresolved, so it must not stamp either.
        if (pressed && this.latestState?.status === 'approval') {
            const resolvedAt = Date.now();
            this.lastApprovalResolvedAt = resolvedAt;
            this.approvalResolvedCallback?.({
                resolvedAt,
                buttonLabel: buttons[buttonIndex]?.label,
            });
        }
        return pressed;
    }

    setOnApprovalResolved(callback: ((event: { resolvedAt: number; buttonLabel?: string }) => void) | null): void {
        this.approvalResolvedCallback = callback;
    }

    getLastApprovalResolvedAt(): number {
        return this.lastApprovalResolvedAt;
    }

    async resolveAction(data: unknown): Promise<void> {
        const args = (data && typeof data === 'object') ? (data as any) : {};
        const explicitIndex = typeof args.buttonIndex === 'number' ? args.buttonIndex : -1;
        if (explicitIndex >= 0) { this.resolveModal(explicitIndex); return; }
        const action = typeof args.action === 'string' ? args.action : 'approve';
        const buttons = this.latestModal?.buttons ?? [];
        if (buttons.length === 0) return;
        let target = -1;
        if (action === 'reject' || action === 'deny') {
            target = buttons.findIndex(b => /^(no|deny|reject|cancel)\b/i.test(b.label));
            if (target < 0) target = buttons.length - 1;
        } else {
            target = buttons.findIndex(b => /^(yes|allow|approve|accept|continue|proceed|update)\b/i.test(b.label));
            if (target < 0) target = 0;
        }
        this.resolveModal(target);
    }

    async setInteractivePromptResponse(response: InteractivePromptResponse): Promise<void> {
        const prompt = this.activeInteractivePrompt;
        if (!prompt || prompt.promptId !== response.promptId) throw new Error('Interactive prompt response does not match active prompt');
        const scheme = this.interactivePromptScheme();
        if (scheme === 'kimi_wire') {
            // Measured kimi keystroke protocols: digit/Tab/Enter for the
            // AskUserQuestion picker, arrow keys (cursor re-read live) for the
            // built-in selector — the spec-path port of the legacy adapter's
            // kimi branch, same 180ms inter-key repaint gap.
            const steps = prompt.promptId.startsWith(KIMI_TUI_SELECTOR_PROMPT_PREFIX)
                ? buildKimiSelectorAnswerSteps(prompt, response, this.driver.snapshot())
                : buildKimiInteractiveTuiAnswerSteps(prompt, response);
            for (const step of steps) {
                this.driver.dispatch({ kind: 'pty_write', data: step });
                await new Promise(resolve => setTimeout(resolve, 180));
            }
            this.activeInteractivePrompt = null;
            this.notifyChange('prompt_cleared');
            return;
        }
        // SILENT-SUCCESS DEFECT (2026-08-20): this used to `return` for any
        // other scheme — no keys pressed, prompt left held, and the caller
        // still reported success. A provider whose spec declares no answerable
        // interactive-prompt scheme must FAIL LOUDLY so the coordinator knows
        // the question is still parked.
        if (scheme !== 'claude_tui') {
            throw new Error(`Provider "${this.spec.id}" declares no answerable interactive-prompt scheme${scheme ? ` (scheme: ${scheme})` : ''} — the question was NOT answered.`);
        }
        await answerClaudeInteractivePrompt(this.claudeTuiHost, prompt, response);
    }

    isApprovalRecentlyResolved(): boolean {
        return !!(this.lastApprovalResolvedAt
            && (Date.now() - this.lastApprovalResolvedAt) < SpecCliAdapter.APPROVAL_RESOLVED_COOLDOWN_MS);
    }
    clearHistory(): void { /* no transcript buffer yet */ }
    updateRuntimeSettings(settings?: Record<string, unknown>): void {
        this.runtimeSettings = { ...(settings ?? {}) };
    }
    setServerConn(_conn?: unknown): void { /* server conn unused by SpecDriver */ }
    /** Map an invokeScript(name, args) call onto a control_bar entry — see invokeSpecControl. */
    invokeScript(scriptName: string, args?: Record<string, unknown>): Promise<unknown> {
        return invokeSpecControl(this.driver, this.spec.control_bar ?? [], scriptName, args);
    }

    getDebugSnapshot(): Record<string, any> {
        return buildSpecDebugSnapshot(this.debugView(), this.driver);
    }

    private debugView(): SpecDebugView {
        return {
            cliType: this.cliType,
            cliName: this.cliName,
            specId: this.spec.id,
            workingDir: this.workingDir,
            spawned: this.spawned,
            exited: this.exited,
            exitCode: this.lastExitCode,
            providerFailureKind: this.providerFailure?.failureKind ?? null,
            spawnedAtMs: this.spawnedAtMs,
            providerSessionId: this.providerSessionId,
            latestState: this.latestState,
            latestModal: this.latestModal,
            activeInteractivePrompt: this.activeInteractivePrompt,
            status: this.getStatus().status,
            messages: this.readDebugMessages(),
        };
    }
    getRuntimeMetadata(): import('../../cli-adapters/pty-transport.js').PtyRuntimeMetadata & Record<string, unknown> {
        return {
            runtimeId: this.spec.id,
            runtimeKey: this.spec.id,
            displayName: this.spec.name,
            spawnedAtMs: this.spawnedAtMs,
            spawnedEnv: this.spawnedEnv,
            ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
        };
    }
    updateRuntimeMeta(meta?: Record<string, unknown>): void {
        if (!meta) return;
        if (typeof meta.providerSessionId === 'string') {
            this.providerSessionId = meta.providerSessionId;
        }
        // Forward the FULL meta (meshNodeId / meshNodeFor / workspaceLabel /
        // lifecycle / …) down to the transport so it reaches the session
        // registry. The legacy ProviderCliAdapter.updateRuntimeMeta does the
        // same via ptyProcess.updateMeta; the spec path previously dropped
        // everything but providerSessionId, leaving autoLaunch's meshNodeId
        // stamp unbound on the record — the root of SESSION-ACCUMULATION-LEAK.
        try { this.driver.updateMeta(meta); } catch { /* transport may not support meta */ }
    }
    refreshProviderDefinition(_provider?: unknown): void { /* hot reload handled by SpecDriver fs.watch */ }

    /**
     * (TOOL-EXPAND) Re-read one truncated tool bubble at full length.
     *
     * Tool summaries are capped by the parser and the full text is carried on
     * no transcript payload, so this is the only way a reader can see the whole
     * command or result. The session→transcript binding is resolved from the
     * SAME inputs the routine read path uses, so an expand can never resolve to
     * a different session's file than the bubble came from.
     */
    expandToolBlock(ref: unknown): ToolBlockExpandResult {
        return expandToolBlock(this.spec.native_history, this.nativeHistoryInput({ withOwner: true }), ref);
    }

    /**
     * TX-FSM Stage 0 (shadow): forward the daemon's normalized signal
     * observation into the FSM driver. Observation-only — failures here must
     * never break the adapter, and the driver treats the envelope as a pure
     * injected value (no reads cross the engine boundary).
     */
    setSignalObservation(snapshot: import('./signal-envelope.js').SignalSnapshot | null): void {
        try { this.driver.setSignalObservation?.(snapshot); } catch { /* shadow-only: never break the adapter */ }
    }

    private handleEvent(ev: DashboardEvent): void {
        switch (ev.kind) {
            case 'state_changed':
                this.latestState = ev.state;
                this.latestModal = ev.modal;
                // info-level keeps only spec-defined identifiers (state.id /
                // state.label / button count). The extracted title can carry
                // user data — file paths, command text, ticket titles — so
                // it stays at debug.
                LOG.info('SpecAdapter', `[${this.cliType}] state=${ev.state.id} (${ev.state.label}) modal=${ev.modal ? `${ev.modal.buttons.length}-buttons` : 'none'}`);
                if (ev.state.title) {
                    LOG.debug('SpecAdapter', `[${this.cliType}] state.title=${JSON.stringify(ev.state.title)}`);
                }
                this.maybeClearResolvedClaudeTuiPrompt();
                this.maybeCaptureClaudeTuiPrompt();
                this.maybeUpgradeClaudeTuiMultiSelect();
                this.notifyChange('fsm_state');
                return;
            case 'pty_data':
                // C6: ONE append, before either reader — strippedTail() and
                // takeCompleteLines() below both read the same buffer with
                // independent cursors/views (see the `rawTail` field doc).
                this.rawTail.append(ev.chunk);
                this.observeProviderFailureOutput(ev.chunk);
                this.detectInteractivePromptFromPtyChunk(ev.chunk);
                this.maybeClearResolvedClaudeTuiPrompt();
                this.maybeCaptureClaudeTuiPrompt();
                this.maybeUpgradeClaudeTuiMultiSelect();
                try { this.ptyDataCallback?.(ev.chunk); } catch { /* ignore */ }
                return;
            case 'exit':
                this.exited = true;
                this.lastExitCode = ev.exit_code;
                // Some CLIs repaint the failure off-screen before exit. Re-run the
                // classifier against the retained tail at the exit seam. The observer
                // signals a provider_failure change only when it discovers a new typed failure;
                // otherwise this branch publishes the ordinary stopped transition.
                if (!this.observeProviderFailureOutput('', ev.exit_code ?? undefined, ev)) this.notifyChange('pty_exit');
                // Then report the death (and its session-host tombstone) outward — the
                // only point that sees the tombstone. The status edge above goes first so
                // it still resolves against the registry entry the exit is about to remove;
                // what the death MEANS (mesh ledger row, …) is decided by bus subscribers.
                this.reportExit(ev.termination);
                return;
            case 'signal_detected':
                this.reportSignal(ev.signal);
                return;
            case 'spec_error':
                LOG.warn('SpecAdapter', `[${this.cliType}] spec reload error: ${ev.errors.join('; ')}`);
                return;
            default:
                return;
        }
    }

    /**
     * Report the PTY death to the owning instance. This layer only reports what
     * it saw; `requestedStop` is NOT filtered here — the double-write guard lives
     * with the ledger writer (mesh-termination-bridge). `runtimeSettings` is
     * forwarded opaquely so this side stays mesh-unaware (`providers/**` may not
     * value-import `mesh/**`, scripts/check-import-boundaries.mjs).
     */
    private reportExit(termination?: SessionTermination): void {
        if (!this.owningSessionId) return;
        try {
            this.exitCallback?.({ ...(termination ? { termination } : {}), runtimeSettings: this.runtimeSettings });
        } catch (e: any) {
            LOG.warn('SpecAdapter', `[${this.cliType}] exit observer failed for ${this.owningSessionId}: ${e?.message || e}`);
        }
    }

    /** Report a spec-declared screen signal; same reasoning as `reportExit`. Unattributable signals are dropped. */
    private reportSignal(signal: SignalDetection): void {
        if (!this.owningSessionId) return;
        try {
            this.signalCallback?.({ providerType: this.cliType, workspace: this.workingDir, runtimeSettings: this.runtimeSettings, signal });
        } catch (e: any) {
            LOG.warn('SpecAdapter', `[${this.cliType}] signal observer failed for ${this.owningSessionId} (${signal.ruleId}): ${e?.message || e}`);
        }
    }

    /** Auth/billing classification of PTY output. WHAT the daemon may do about a
     *  match (live = suspicion/advisory, exit = verdict) is live-auth-advisory.ts. */
    private observeProviderFailureOutput(chunk: string, exitCode?: number, exit?: { exit_code: number | null; termination?: SessionTermination }): boolean {
        if (this.providerFailure || (exit && !exitClassificationAllowed(exit.exit_code, exit.termination, this.liveAuth))) return false;
        // `chunk` is already appended into `rawTail` by handleEvent's 'pty_data'
        // case (C6, one append before any reader) — this reads a fresh,
        // ANSI-stripped view, replacing the former appendAuthTail accumulator.
        void chunk;
        const failure = classifyAuthBillingOutput(this.cliType, this.rawTail.strippedTail(TAIL_BYTES), exitCode);
        if (!failure) return false;
        if (exitCode === undefined && !this.exited) {
            noteLiveAuthMatch((this.liveAuth ??= createLiveAuthState()), this.liveAuthContext(), failure);
            return false;
        }
        this.latchAuthBillingFailure(failure, `exitCode=${exitCode ?? 'pending'}`);
        return true;
    }

    private liveAuthContext(): LiveAuthContext {
        const coordinatorFor = this.runtimeSettings?.meshCoordinatorFor;
        const isCoordinator = typeof coordinatorFor === 'string' && !!coordinatorFor.trim();
        return { cliType: this.cliType, sessionLabel: this.owningSessionId || 'unknown', isCoordinator };
    }

    private latchAuthBillingFailure(failure: ProviderFailure, context: string): void {
        this.providerFailure = failure;
        LOG.warn('SpecAdapter', authBillingLatchLogLine(this.cliType, failure, context));
        this.notifyChange('provider_failure');
    }

    /** Resolve a pending live suspicion on the routine status poll (turn boundary). */
    private maybeConfirmLiveAuthBillingSuspect(): void {
        if (!this.liveAuth?.suspect || this.providerFailure || this.exited) return;
        const outcome = resolveLiveAuthSuspect(this.liveAuth, this.liveAuthContext(), {
            // FSM status is idle | generating | approval — anything but idle is mid-turn.
            midTurn: !!this.latestState && this.latestState.status !== 'idle',
            readScreen: () => (typeof this.driver?.snapshot === 'function' ? this.driver.snapshot() : ''),
            tail: this.rawTail.strippedTail(TAIL_BYTES),
        });
        if (outcome.clearTail) this.rawTail.clearStrippedTail();
        if (outcome.advisory) this.reportSignal(outcome.advisory);
        if (outcome.latch) this.latchAuthBillingFailure(outcome.latch, 'exitCode=pending; confirmed on-screen at turn boundary');
    }

    /**
     * Resolve the interactive-prompt protocol for this session — the spec's
     * declared `interactive_prompts.scheme`, with a legacy default: a
     * 'claude-cli' spec that predates the field keeps the claude_tui protocol
     * it always had (retire this fallback once the published claude spec
     * declares the field). Every other spec without the field captures no
     * interactive prompts, exactly as before.
     */
    private interactivePromptScheme(): InteractivePrompts['scheme'] | null {
        const declared = this.spec.interactive_prompts?.scheme;
        if (declared === 'claude_tui' || declared === 'kimi_wire') return declared;
        return this.cliType === 'claude-cli' ? 'claude_tui' : null;
    }

    /**
     * kimi_wire scheme: refresh the held AskUserQuestion / built-in selector
     * prompt on the routine status poll — the spec-path port of the legacy
     * adapter's refreshKimiPendingQuestion (same wire.jsonl authority, same
     * every-poll cadence, same fail-open semantics).
     */
    private refreshWirePendingQuestion(): void {
        if (this.interactivePromptScheme() !== 'kimi_wire') return;
        try {
            let prompt: InteractivePrompt | null = null;
            if (this.spec.native_history?.source) {
                prompt = detectKimiPendingQuestion(this.spec.native_history, this.nativeHistoryInput({ withOwner: true }));
            }
            if (!prompt && this.latestState?.status !== 'generating') {
                // Built-in idle/cache-expired selector: TUI-only, never on the
                // wire; only appears at idle (a quoted snapshot in scrolling
                // output must never parse as the picker).
                prompt = detectKimiIdleSelectorPrompt(this.driver.snapshot());
            }
            if ((prompt?.promptId ?? null) !== (this.activeInteractivePrompt?.promptId ?? null)) {
                this.activeInteractivePrompt = prompt;
                this.notifyChange(prompt ? 'prompt_captured' : 'prompt_cleared');
            }
        } catch { /* fail open — keep the currently-held prompt */ }
    }

    private detectInteractivePromptFromPtyChunk(chunk: string): void {
        if (this.interactivePromptScheme() !== 'claude_tui' || !chunk) return;
        // `chunk` is already appended into `rawTail` by handleEvent's 'pty_data'
        // case (C6, one append before any reader) — this reads complete lines
        // off its OWN cursor, independent of the auth reader's `strippedTail()`
        // view over the same buffer. Replaces the former `jsonLineTail` field.
        const lines = this.rawTail.takeCompleteLines();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{') || !trimmed.includes('AskUserQuestion')) continue;
            try {
                const parsed = JSON.parse(trimmed);
                const prompt = detectClaudeAskUserQuestionPromptFromJson(parsed, this.cliType);
                if (!prompt) continue;
                this.activeInteractivePrompt = prompt;
                this.interactivePromptTransport = 'stream-json';
                this.interactivePromptLostAt = null;
                this.notifyChange('prompt_captured');
            } catch {
                // PTY output is not guaranteed to be machine JSON.
            }
        }
    }

    private readCurrentScreenSections(screenText: string): Record<string, string> {
        try {
            // Resolve against the caller's screen, not a fresh read.
            const sections = this.driver.getSections(screenText) ?? [];
            return Object.fromEntries(sections.map(section => [section.id, section.text]));
        } catch {
            return {};
        }
    }

    private extractProviderSessionIdFromScreen(): string | undefined {
        if (this.cliType !== 'codex-cli') return this.providerSessionId;
        let screenText = '';
        try {
            screenText = this.driver.snapshot();
        } catch {
            return this.providerSessionId;
        }
        return extractCodexSessionIdFromScreen(screenText) || this.providerSessionId;
    }

    /** PTY-scrape assistant bubbles — see scrapeScreenAssistantMessages. */
    private readScreenAssistantMessages(): ChatMessage[] {
        if (!screenScrapeSupported(this.cliType)) return [];
        let screenText = '';
        try {
            screenText = this.driver.snapshot();
        } catch {
            return [];
        }
        const body = this.cliType === 'claude-cli' ? this.readCurrentScreenSections(screenText).body : undefined;
        return scrapeScreenAssistantMessages(this.cliType, screenText, body);
    }

    /**
     * The explicit view claude-tui-prompt.ts reads and writes this adapter's
     * interactive-prompt state through. Built per call from live accessors, so
     * it always reflects the current fields (including adapters assembled
     * without the constructor in tests).
     */
    private get claudeTuiHost(): ClaudeTuiPromptHost {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        return {
            get cliType() { return self.cliType; },
            get driver() { return self.driver; },
            get latestState() { return self.latestState; },
            get activeInteractivePrompt() { return self.activeInteractivePrompt; },
            set activeInteractivePrompt(v) { self.activeInteractivePrompt = v; },
            get interactivePromptTransport() { return self.interactivePromptTransport; },
            set interactivePromptTransport(v) { self.interactivePromptTransport = v; },
            get interactivePromptLostAt() { return self.interactivePromptLostAt; },
            set interactivePromptLostAt(v) { self.interactivePromptLostAt = v; },
            get claudeTuiPromptCaptureInFlight() { return self.claudeTuiPromptCaptureInFlight; },
            set claudeTuiPromptCaptureInFlight(v) { self.claudeTuiPromptCaptureInFlight = v; },
            get claudeTuiCaptureSuppressed() { return self.claudeTuiCaptureSuppressed; },
            set claudeTuiCaptureSuppressed(v) { self.claudeTuiCaptureSuppressed = v; },
            get claudeTuiCaptureFailures() { return self.claudeTuiCaptureFailures; },
            set claudeTuiCaptureFailures(v) { self.claudeTuiCaptureFailures = v; },
            get claudeTuiCaptureFooterAbsentAt() { return self.claudeTuiCaptureFooterAbsentAt; },
            set claudeTuiCaptureFooterAbsentAt(v) { self.claudeTuiCaptureFooterAbsentAt = v; },
            isClaudeTuiScheme: () => self.interactivePromptScheme() === 'claude_tui',
            notifyChange: (cause) => self.notifyChange(cause),
            detectNativePendingQuestion: () => detectClaudeNativePendingQuestion(
                self.spec.native_history, self.nativeHistoryInput({ withOwner: true })),
            hasBoundToolResult: (prompt) => hasBoundClaudeAskUserQuestionToolResult(
                self.cliType, self.spec.native_history, self.nativeHistoryInput({ withOwner: true }), prompt),
        };
    }

    /**
     * The session→transcript binding every native-history read of this
     * session uses. `withOwner` adds the sidecar-claim owner token — without it
     * resolution fails closed on ambiguity (debug/background reads omit it).
     */
    private nativeHistoryInput(opts: { withOwner: boolean }): NativeHistoryInput {
        return {
            agentType: this.cliType,
            providerSessionId: this.providerSessionId || undefined,
            sessionStartedAtMs: this.spawnedAtMs,
            envOverrides: this.spawnedEnv,
            workspace: this.workingDir,
            ...(opts.withOwner ? { instanceId: this.owningSessionId || undefined } : {}),
        };
    }

    // Thin delegators into claude-tui-prompt.ts. Kept as adapter methods because
    // handleEvent calls them per frame and suites stub / drive them directly.
    private maybeClearResolvedClaudeTuiPrompt(options: {
        screenText?: string;
        resolveImmediatelyWhenBusy?: boolean;
        resolvedByBoundToolResult?: boolean;
    } = {}): 'held' | 'missing' | 'cleared' | 'unavailable' {
        return maybeClearResolvedClaudeTuiPrompt(this.claudeTuiHost, options);
    }
    private maybeCaptureClaudeTuiPrompt(): void { maybeCaptureClaudeTuiPrompt(this.claudeTuiHost); }
    private maybeUpgradeClaudeTuiMultiSelect(): void { maybeUpgradeClaudeTuiMultiSelect(this.claudeTuiHost); }

    /** Transcript messages for the debug snapshot/state bundles: native
     *  history when the spec declares a source, else the screen scrape. */
    private readDebugMessages(): unknown[] {
        if (!this.spec.native_history?.source) return this.readScreenAssistantMessages();
        try {
            const result = executeNativeHistory(this.spec.native_history, this.nativeHistoryInput({ withOwner: false }));
            if (result && Array.isArray(result.messages)) return result.messages;
        } catch { /* best-effort */ }
        return [];
    }

    getTraceState(limit = 120): Record<string, any> {
        const history = this.driver.getStateHistory();
        return {
            status: this.getStatus().status,
            stateHistory: history.slice(-limit),
            screenText: this.driver.getScreen?.() ?? '',
        };
    }

    getProviderResolutionMeta(): Record<string, any> {
        return {
            type: this.cliType,
            providerDir: null,
            resolvedVersion: null,
        };
    }
}
