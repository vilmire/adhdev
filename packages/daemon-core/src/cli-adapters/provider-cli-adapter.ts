/**
 * ProviderCliAdapter — Script-based CLI Adapter
 *
 * All CLI providers use versioned scripts (like IDE providers).
 * Scripts are Node.js functions that receive PTY buffer data and return structured results.
 *
 * Required scripts in scripts/{version}/scripts.js:
 *   - detectStatus(input)  → AgentStatus string ('idle' | 'generating' | 'waiting_approval')
 *   - parseSession(input)  → ReadChatResult { messages, status, activeModal, ... }
 *   - parseApproval(input) → ModalInfo | null
 *
 * provider.json contract:
 *   type, name, category: 'cli', binary, spawn, approvalKeys
 *   compatibility: [{ ideVersion, scriptDir }]  ← versioned scripts
 */

import * as os from 'os';
import { createHash } from 'crypto';
import type { CliAdapter, CliLaunchInfo } from '../cli-adapter-types.js';
import type { InteractivePromptResponse } from '../providers/types/interactive-prompt.js';
import { LOG } from '../logging/logger.js';
import { getDebugRuntimeConfig } from '../logging/debug-config.js';
import { TerminalScreen } from './terminal-screen.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import {
    NodePtyTransportFactory,
    type PtyRuntimeMetadata,
    type PtyRuntimeTransport,
    type PtyTransportFactory,
} from './pty-transport.js';
import {
    WIN32_PTY_WRITE_CHUNK_CHARS,
    WIN32_PTY_WRITE_CHUNK_GAP_MS,
    chunkPreservingSurrogates,
    shouldChunkWin32Write,
} from './pty-write-chunking.js';
import {
    buildCliScreenSnapshot,
    compactPromptText,
    estimatePromptDisplayLines,
    extractPromptRetrySnippet,
    isPurePtyTranscriptProvider,
    listCliScriptNames,
    normalizePromptText,
    normalizeScreenSnapshot,
    promptLikelyVisible,
    sanitizeTerminalText,
    truncateToByteTailByLine,
    encodeMeshSendKeys,
    TerminalTranscriptAccumulator,
    type MeshSendKeyItem,
    type MeshSendKeyName,
    type CliChatMessage,
    type CliProviderModule,
    type CliScriptInput,
    type CliScripts,
    type CliSessionStatus,
    type CliTraceEntry,
    type ParsedSession,
} from './provider-cli-shared.js';
import { CliScriptRunner } from './cli-script-runner.js';
import {
    CliStateEngine,
    type CliBufferSnapshot,
    type CliTransportAccess,
    type CliStateEngineCallbacks,
} from './cli-state-engine.js';
import {
    buildCliParseInput,
    buildCliTraceParseSnapshot,
    normalizeCliParsedMessages,
    summarizeCliTraceMessages,
    summarizeCliTraceText,
    type TurnParseScope,
} from './provider-cli-parse.js';
import {
    resolveCliAdapterConfig,
    type ProviderResolutionMeta,
} from './provider-cli-config.js';
import {
    buildCliLoginShellRetry,
    getCliSpawnErrorHint,
    resolveCliSpawnPlan,
    respondToCliTerminalQueries,
} from './provider-cli-runtime.js';

export {
    normalizeCliProviderForRuntime,
    type CliApprovalInput,
    type CliChatMessage,
    type CliProviderModule,
    type CliScreenLine,
    type CliScreenSnapshot,
    type CliScriptInput,
    type CliScripts,
    type CliSessionStatus,
    type CliStatusInput,
    type CliTraceEntry,
} from './provider-cli-shared.js';


interface SendMessageState {
    text: string;
    normalizedPromptSnippet: string;
    submitDelayMs: number;
    maxEchoWaitMs: number;
    retryDelayMs: number;
    didCommitUserTurn: boolean;
    // Whether this was the session's first turn at the moment of dispatch — captured
    // before commitSendUserTurn flips this.firstTurnSent, so a later stuck-retry still
    // knows it is recovering the win32 premature-ready first-turn swallow.
    isFirstTurn: boolean;
}

interface SendMessageCompletion {
    resolveOnce: () => void;
    rejectOnce: (error: unknown) => void;
}

interface PendingOutboundMessage {
    id: string;
    role: 'user';
    content: string;
    queuedAt: number;
    source: 'sendMessage';
    // ARCH-REFACTOR R1: the mesh taskId this queued message belongs to. Carried so that
    // when the queue is flushed (once the prior turn settles) the new turn is bound to
    // its OWN task, not whatever scalar the session happens to hold at flush time.
    meshTaskId?: string;
}

export function appendBoundedText(current: string, chunk: string, maxChars: number): string {
    if (!chunk) return current.length <= maxChars ? current : current.slice(-maxChars);
    if (maxChars <= 0) return '';
    if (chunk.length >= maxChars) return chunk.slice(-maxChars);
    const keepFromCurrent = maxChars - chunk.length;
    if (current.length <= keepFromCurrent) return current + chunk;
    return current.slice(-keepFromCurrent) + chunk;
}

// Force-send (mesh coordinator dispatch / reconcile redelivery) writes raw
// keystrokes straight into the PTY, bypassing the normal echo-wait submit
// pipeline.
//
// History of this path's failure modes:
//   1. Originally it wrote `text + sendKey` in a single PTY write with zero
//      settle time. Injected into an idle TUI input box that was still entering
//      its input-accepting state, the trailing submit key could be swallowed —
//      prompt typed but never submitted ("text injected, Enter not pressed").
//   2. The first fix split inject from submit: write(text) → echo-gated settle →
//      write(sendKey) as a *separate* PTY write. That broke win32: ConPTY/TUI
//      does not recognize a lone '\r' that arrives in its own PTY chunk
//      150ms+ after the text as a submit key, and the win32 echo gate never
//      matched (ConPTY echo/parsing differences), so the cap was burned and the
//      same detached lone CR was emitted — adding latency while the Enter still
//      got swallowed.
//
// Current behavior: keep a fixed settle gap so the input handler is in its
// input-accepting state, then write `content + sendKey` as a SINGLE atomic PTY
// write — the same verified mechanism the normal `immediate` submit strategy
// uses (submitImmediatePrompt). With the Enter in the same write unit as the
// text, win32 ConPTY always sees it as a submit and the race that the split was
// trying to solve cannot happen (the Enter can never be separated from the
// text). FORCE_SUBMIT_SETTLE_MS is that minimum pre-submit gap.
const FORCE_SUBMIT_SETTLE_MS = 150;

// ─── Adapter ────────────────────────────────────────

export class ProviderCliAdapter implements CliAdapter {
    cliType: string;
    readonly cliName: string;
    public workingDir: string;

    private provider: CliProviderModule;
    private ptyProcess: PtyRuntimeTransport | null = null;
    private transportFactory: PtyTransportFactory;
    private onStatusChange: (() => void) | null = null;
    // FALSE-IDLE (Fix 2): probe the owning instance for the post-approval resume grace.
    // Null until the instance registers it; the engine treats absence as "not in grace".
    private inApprovalResumeGraceProbe: (() => boolean) | null = null;
    // FLOOR-CLASS-TRANSCRIPT-DEFER-CAP: probe the owning instance for proof that the
    // authoritative native transcript already holds a FRESH current-turn final
    // assistant. Null until the instance registers it; the engine treats absence as
    // "cannot prove" and the transcript-finish defer cap fails closed.
    private nativeFinalAssistantProbe: (() => boolean) | null = null;

    // ─── State machine engine ─────────────────────────
    readonly engine: CliStateEngine;

    private responseBuffer = '';
    private recentOutputBuffer = '';
    private get parseErrorMessage(): string | null { return this.runner.parseErrorMessage; }
    private providerSessionId: string | null = null;
    private responseTimeout: NodeJS.Timeout | null = null;
    private ready = false;
    // WIN32-READY-HOLD: the ready barrier can release on screen/spec-FSM grace
    // before win32 ConPTY's input layer is live. The first split write (text, then a
    // separate trailing CR via waitForEchoAndSubmit) then has its submit CR swallowed,
    // and every CR-only retry re-sends a bare CR the input layer keeps dropping — the
    // first message is typed-but-never-submitted and lost. Routing only the FIRST turn
    // through the atomic content+sendKey single write (submitImmediatePrompt) keeps the
    // Enter in the same PTY write unit as the text, the invariant win32 ConPTY needs to
    // recognize a submit, so the swallow is bypassed. Subsequent turns (input layer now
    // proven live) keep the normal echo-gated path. Flips true on first committed turn.
    private firstTurnSent = false;
    private startupBuffer = '';
    private startupParseGate = false;
    private startupSettleTimer: NodeJS.Timeout | null = null;
    private spawnAt = 0;
    private startupFirstOutputAt = 0;

 // PTY I/O
    private onPtyDataCallback: ((data: string) => void) | null = null;
    private pendingOutputParseChunks: string[] = [];
    private pendingOutputParseTimer: NodeJS.Timeout | null = null;
    private ptyOutputChunks: string[] = [];
    private ptyOutputFlushTimer: NodeJS.Timeout | null = null;
    private pendingTerminalQueryTail = '';
    private lastOutputAt = 0;
    private lastNonEmptyOutputAt = 0;
    private lastScreenChangeAt = 0;
    private lastScreenSnapshot = '';
    private lastScreenText = '';
    private lastScreenSnapshotReadAt = Number.NEGATIVE_INFINITY;
    // (FALSEIDLE Path-C) Count of CONSECUTIVE getStatus polls that observed a
    // gate-eligible static-idle screen (detect=idle, no modal, quiet, empty
    // partial buffer). For a mesh/autonomous worker we require several such
    // polls in a row before confirming static-idle (see getStatus), so a
    // single momentarily-silent point-sample of a still-live turn cannot flip
    // it. Reset to 0 the instant any poll is ineligible.
    private staticIdlePollStreak = 0;

 // Server log forwarding
    private serverConn: any = null;
    private logBuffer: { message: string; level: string }[] = [];

    private pendingOutboundQueue: PendingOutboundMessage[] = [];
    private pendingOutboundFlushTimer: NodeJS.Timeout | null = null;
    private pendingOutboundFlushInFlight = false;
    // Stale-queue watchdog: fires STALE_QUEUE_WARN_MS after the oldest queued
    // message was enqueued if nothing has been flushed yet.
    private pendingOutboundStaleTimer: NodeJS.Timeout | null = null;
    // Submit retry timer — PTY-level, not state machine
    private submitRetryTimer: NodeJS.Timeout | null = null;

    // PTY-WRITE-SERIALIZE: a single per-session tail promise that serializes every
    // PTY write. Each writeToPty() call chains its actual write after the previous
    // one and returns a promise that resolves only after ITS write completes, so
    // two consecutive sends (e.g. mesh force-dispatch burst → forceSendMessage, or
    // a retry-timer's bare CR interleaving a fresh body) can never write into the
    // same input line: message A's (body + sendKey/CR) is fully written to the PTY
    // before message B's body write starts. The chain is kept alive across errors
    // (each link swallows/logs its own failure) so one failed write never wedges
    // all later writes behind a permanently-rejected tail.
    private ptyWriteChain: Promise<void> = Promise.resolve();

 // Resize redraw suppression
    private resizeSuppressUntil: number = 0;

    // (A2.2) Native transcript anchor moved to CHAT_SOURCE_REGISTRY.
    // ChatSourceMachine holds the lock by state, not by a mutable field on
    // the adapter. Removed entirely; no callers remain after the readChat
    // ladder was replaced.

    // ─── Script runner (parsing isolated here, adapter stays as transport) ───
    private readonly runner: CliScriptRunner;
    /** @deprecated use runner.cliScripts for direct script access */
    get cliScripts(): CliScripts { return this.runner.cliScripts; }

    /**
     * Recent script invocations (oldest → newest). Exposed via the
     * `get_chat_debug_bundle` daemon command so anyone debugging a
     * stuck-status regression can read what each detectStatus /
     * parseSession call actually saw and returned, instead of having
     * to instrument the daemon.
     */
    getScriptInvocationTrace() {
        return this.runner.getInvocationTrace();
    }

    /**
     * Returns the full raw PTY byte stream captured since adapter start.
     * Used by the `record_provider_pty` IPC command to produce fixtures.
     * Bounded by MAX_ACCUMULATED_BUFFER; older bytes may have been dropped.
     */
    getAccumulatedRawBuffer(): { text: string; droppedChars: number } {
        return {
            text: this.accumulatedRawBuffer,
            droppedChars: this.accumulatedRawBufferDroppedChars,
        };
    }
    set cliScripts(scripts: CliScripts) { this.setCliScripts(scripts); }
    private runtimeSettings: Record<string, any> = {};
    /** Full accumulated rendered PTY transcript for parser/readback use */
    private accumulatedBuffer: string = '';
    /** Stateful rendered transcript accumulator; raw debug remains in accumulatedRawBuffer. */
    private transcriptAccumulator = new TerminalTranscriptAccumulator();
    /** Full accumulated raw PTY output (with ANSI) */
    private accumulatedRawBuffer: string = '';
    /** Current visible terminal screen snapshot */
    private terminalScreen = new TerminalScreen(DEFAULT_SESSION_HOST_ROWS, DEFAULT_SESSION_HOST_COLS);
    private static readonly MAX_RESPONSE_BUFFER = 8000;
    private static readonly MAX_RECENT_OUTPUT_BUFFER = 1000;
    private responseBufferDroppedChars = 0;
    private recentOutputDroppedChars = 0;
    private accumulatedBufferDroppedChars = 0;
    private accumulatedRawBufferDroppedChars = 0;
    /** Max accumulated buffer size. Sized to comfortably hold a single long
     *  Hermes turn (tool calls + reasoning + final bubble) without the
     *  rolling window pushing the turn's ╭─ opening line out of view. */
    private static readonly MAX_ACCUMULATED_BUFFER = 262144;
    private parsedStatusCache: {
        responseBuffer: string;
        currentTurnScope: TurnParseScope | null;
        recentOutputBuffer: string;
        accumulatedBuffer: string;
        accumulatedRawBufferKey: string;
        screenText: string;
        currentStatus: CliSessionStatus['status'];
        activeModal: { message: string; buttons: string[] } | null;
        cliName: string;
        result: any;
    } | null = null;
    private static readonly SCREEN_SNAPSHOT_MIN_INTERVAL_MS = 250;
    // MESH-READ-TERMINAL (feature 2): byte caps for getTerminalScreenSnapshot.
    // Byte, not char — a multi-byte-glyph screen can exceed an MCP payload cap
    // while the char count still looks safe. 32KiB default, 64KiB absolute hard cap.
    private static readonly TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES = 32 * 1024;
    private static readonly TERMINAL_SNAPSHOT_ABSOLUTE_MAX_BYTES = 64 * 1024;
    // (FALSEIDLE Path-C) Consecutive gate-eligible getStatus polls a mesh/autonomous
    // session must show before the poll-static-idle confirm fires. 2 = one extra
    // status tick of hysteresis: enough to reject a single momentary-silence
    // point-sample of a still-live turn, cheap enough not to materially delay a
    // genuine boot-wedge release (the wedge screen is stably static, so it clears
    // every consecutive poll and confirms on the 2nd).
    private static readonly STATIC_IDLE_POLL_CONFIRM_COUNT = 2;

    private readonly providerResolutionMeta: ProviderResolutionMeta;

    private getBufferState(): NonNullable<CliSessionStatus['bufferState']> | undefined {
        const build = (droppedChars: number, maxChars: number) => droppedChars > 0
            ? { truncated: true, droppedChars, maxChars }
            : undefined;
        const responseBuffer = build(this.responseBufferDroppedChars, ProviderCliAdapter.MAX_RESPONSE_BUFFER);
        const recentOutputBuffer = build(this.recentOutputDroppedChars, ProviderCliAdapter.MAX_RECENT_OUTPUT_BUFFER);
        const accumulatedBuffer = build(this.accumulatedBufferDroppedChars, ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);
        const accumulatedRawBuffer = build(this.accumulatedRawBufferDroppedChars, ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);
        if (!responseBuffer && !recentOutputBuffer && !accumulatedBuffer && !accumulatedRawBuffer) return undefined;
        return {
            ...(responseBuffer ? { responseBuffer } : {}),
            ...(recentOutputBuffer ? { recentOutputBuffer } : {}),
            ...(accumulatedBuffer ? { accumulatedBuffer } : {}),
            ...(accumulatedRawBuffer ? { accumulatedRawBuffer } : {}),
        };
    }

    private recordBoundedAppendDrop(previousLength: number, appendedLength: number, nextLength: number): number {
        return Math.max(0, (previousLength + appendedLength) - nextLength);
    }


    private readTerminalScreenText(now = Date.now()): string {
        const screenText = this.terminalScreen.getText() || '';
        this.lastScreenText = screenText;
        this.lastScreenSnapshotReadAt = now;
        return screenText;
    }

    private getParseScreenText(screenText: string): string {
        const currentSnapshot = normalizeScreenSnapshot(screenText);
        const lastSnapshot = this.lastScreenSnapshot;
        if (!lastSnapshot || lastSnapshot === currentSnapshot) return screenText;
        const activeScreenPattern = /\besc to (?:interrupt|stop)\b|Enter to interrupt, Ctrl\+C to cancel|Enter to confirm\s*[·•-]\s*Esc to cancel|\b(?:MCP servers?|tool calls?)\b[^\n\r]{0,160}\brequire approval\b/i;
        const staleSnapshotLooksActive = activeScreenPattern.test(lastSnapshot);
        const currentScreenLooksIdle = /(?:^|\n|\r)\s*[❯›>]\s*(?:Try\s+["“][^\n\r"”]+["”])?\s*(?:\n|\r|$)/.test(screenText)
            && !activeScreenPattern.test(screenText);
        if (staleSnapshotLooksActive && currentScreenLooksIdle) return screenText;
        // When the current frame already resolves to a settled/idle prompt via the
        // provider's own detector, do NOT graft an older snapshot onto it: the
        // older frame can carry a dead modal box (e.g. cursor-agent's leftover
        // "Workspace Trust Required" rows) that re-fires `waiting_approval` at the
        // appended tail and wedges the turn in `generating`. A truly idle current
        // screen needs no historical supplement.
        if (this.runDetectStatus(screenText) === 'idle') return screenText;
        if (currentSnapshot.length >= lastSnapshot.length) return screenText;
        // Terminal screen reads can miss a just-rendered completed Hermes box while
        // the normalized snapshot captured during output still has it. Feed both
        // views to provider parsers so flattened snapshot-only final bubbles do
        // not disappear from read_chat/chat_tail, but only when the older snapshot
        // carries extra content instead of stale status chrome.
        return `${screenText}\n${lastSnapshot}`;
    }

    private shouldReadTerminalScreenSnapshot(now: number): boolean {
        if (!this.lastScreenText) return true;
        return (now - this.lastScreenSnapshotReadAt) >= ProviderCliAdapter.SCREEN_SNAPSHOT_MIN_INTERVAL_MS;
    }

    private resetTerminalScreen(rows?: number, cols?: number): void {
        this.terminalScreen.reset(rows, cols);
        this.transcriptAccumulator.reset();
        this.lastScreenText = '';
        this.lastScreenSnapshot = '';
        this.lastScreenChangeAt = 0;
        this.lastScreenSnapshotReadAt = Number.NEGATIVE_INFINITY;
    }

    private getAccumulatedRawBufferCacheKey(): string {
        return this.accumulatedRawBuffer
            .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
            .replace(/\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g, '')
            .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
    }

    private getFreshParsedStatusCache(): any | null {
        const cached = this.parsedStatusCache;
        const accumulatedRawBufferKey = this.getAccumulatedRawBufferCacheKey();
        if (
            cached
            && cached.responseBuffer === this.responseBuffer
            && cached.currentTurnScope === this.engine.currentTurnScope
            && cached.recentOutputBuffer === this.recentOutputBuffer
            && cached.accumulatedBuffer === this.accumulatedBuffer
            && cached.accumulatedRawBufferKey === accumulatedRawBufferKey
            && cached.screenText === this.lastScreenText
            && cached.currentStatus === this.engine.currentStatus
            && cached.activeModal === this.engine.activeModal
            && cached.cliName === this.cliName
        ) {
            return cached.result;
        }
        return null;
    }

    private providerOwnsTranscript(): boolean {
        return this.provider.transcriptAuthority === 'provider';
    }

    private shouldUseFullProviderTranscriptContext(): boolean {
        return this.providerOwnsTranscript() && this.provider.transcriptContext === 'full';
    }

    /**
     * MULTI-TURN TRANSCRIPT FLICKER (kimi): whether this provider reconstructs
     * its ENTIRE transcript from the rendered PTY buffer on every read and so
     * must be fed the full accumulated buffer rather than the current-turn slice.
     *
     * The turn-scope slice (buildCliParseInput → sliceFromOffset(accumulatedBuffer,
     * scope.bufferStart)) exists so a mid-turn parse only sees the fresh output of
     * the CURRENT turn — correct for status/streaming detection and for providers
     * that reassemble prior history elsewhere (native-history on disk, or a
     * provider-owned full-context parser). But a pure-PTY provider with NO native
     * history and NO provider transcript authority, whose tui parser walks the
     * whole buffer for its per-turn bubble markers (kimi's `●`/`✨` bullets),
     * loses every prior turn's bubbles the instant a new turn starts: bufferStart
     * jumps to the new turn's offset, the slice drops turns 1..n-1, and until the
     * new turn emits its first bullet parseSession returns zero messages — so
     * read_chat momentarily goes EMPTY and the dashboard clears every bubble,
     * then restores them once output arrives (the observed flicker).
     *
     * accumulatedBuffer is the terminal-EMULATED rendered scrollback (overwritten
     * cells collapsed), not raw PTY append, so parsing it in full yields the clean
     * cumulative transcript with no repaint duplication. Scope to exactly this
     * class (tui transcriptPty scope 'buffer' + no native history + not
     * provider-owned) so no other provider's turn-scoped parse changes.
     */
    private parsesFullPtyTranscriptFromBuffer(): boolean {
        return isPurePtyTranscriptProvider(this.provider);
    }

    /**
     * The turn scope to feed the transcript parser. Normally the live turn scope
     * (so a mid-turn parse is current-turn-only), but null (= full accumulated
     * buffer) for pure-PTY full-transcript providers so prior turns never drop.
     * See {@link parsesFullPtyTranscriptFromBuffer}.
     */
    private transcriptParseScope(): TurnParseScope | null {
        return this.parsesFullPtyTranscriptFromBuffer() ? null : this.engine.currentTurnScope;
    }

    private getIdleFinishConfirmMs(): number {
        return this.timeouts.idleFinishConfirm;
    }

    private getStatusActivityHoldMs(): number {
        return this.timeouts.statusActivityHold;
    }

    // (FALSEIDLE Path-C) Whether this session is a mesh worker or coordinator's
    // own autonomous session. Mirrors CliProviderInstance.isAutonomousMeshSession
    // over the runtimeSettings the instance mirrors down via updateRuntimeSettings
    // (meshNodeFor / meshActiveTaskId / meshNodeId / launchedByCoordinator =
    // isMeshWorkerSession, plus meshCoordinatorFor for the coordinator's own turn).
    // Such a session has no human at the keyboard to correct a premature idle, so
    // the poll-static-idle confirm is debounced for it (multiple consecutive idle
    // polls) rather than fired on a single point-sample.
    private isAutonomousMeshSession(): boolean {
        const s = this.runtimeSettings;
        return !!(s?.meshNodeFor || s?.meshActiveTaskId || s?.meshNodeId
            || s?.launchedByCoordinator || s?.meshCoordinatorFor);
    }

 // Resolved timeouts
    private readonly timeouts: Required<NonNullable<CliProviderModule['timeouts']>>;

 // Provider approval key mapping
    private readonly approvalKeys: Record<number, string>;
    private readonly sendDelayMs: number;
    private readonly sendKey: string;
    private readonly submitStrategy: 'wait_for_echo' | 'immediate';
    private readonly requirePromptEchoBeforeSubmit: boolean;

    constructor(
        provider: CliProviderModule,
        workingDir: string,
        private extraArgs: string[] = [],
        private extraEnv: Record<string, string> = {},
        transportFactory: PtyTransportFactory = new NodePtyTransportFactory(),
    ) {
        this.runner = new CliScriptRunner(provider.type);
        this.provider = provider;
        this.transportFactory = transportFactory;
        this.cliType = provider.type;
        this.cliName = provider.name;
        this.workingDir = workingDir.startsWith('~')
            ? workingDir.replace(/^~/, os.homedir())
            : workingDir;

        const resolvedConfig = resolveCliAdapterConfig(provider);
        this.timeouts = resolvedConfig.timeouts;
        this.approvalKeys = resolvedConfig.approvalKeys;
        this.sendDelayMs = resolvedConfig.sendDelayMs;
        this.sendKey = resolvedConfig.sendKey;
        this.submitStrategy = resolvedConfig.submitStrategy;
        this.requirePromptEchoBeforeSubmit = resolvedConfig.requirePromptEchoBeforeSubmit;
        this.providerResolutionMeta = resolvedConfig.providerResolutionMeta;

        // State machine engine — owns all status transitions
        this.engine = new CliStateEngine(
            provider,
            this.runner,
            this as unknown as CliTransportAccess,
            {
                onStatusChange: () => { this.onStatusChange?.(); },
                onApplyParsedSession: (session) => { this.applyParsedSessionMetadata(session); },
                onTurnCompleted: () => { this.responseBuffer = ''; },
                isInApprovalResumeGrace: () => this.inApprovalResumeGraceProbe?.() === true,
                hasFreshNativeFinalAssistantForCurrentTurn: () => this.nativeFinalAssistantProbe?.() === true,
            } satisfies CliStateEngineCallbacks,
            resolvedConfig.timeouts,
        );

        // Scripts delegated to CliScriptRunner — adapter stays as transport.
        // Pass the manifest tui block so the runner can build the
        // declarativeDetectStatus / declarativeParseApproval SDK functions
        // that v1 extended-tier overrides depend on (without these, scripts
        // like codex-cli's detect_status v1 fail-closed with return 'idle'
        // and the session sticks in `generating` forever).
        this.runner.setScripts(provider.scripts || {}, provider.tui);
        // Per-invocation wall-clock budget for provider scripts. Manifests may
        // raise this for genuinely slow parsers, but the default (50ms) is the
        // settle-loop safety net — any script that exceeds it gets flagged in
        // the invocation trace and surfaced via the debug bundle so we can
        // identify the offender instead of guessing why the settle loop hangs.
        this.runner.setScriptCallBudget(provider.scriptCallBudgetMs ?? 50);
        const scriptNames = this.runner.getScriptNames();
        if (scriptNames.length > 0) {
            LOG.info('CLI', `[${this.cliType}] CLI scripts: [${scriptNames.join(', ')}]`);
            LOG.info(
                'CLI',
                `[${this.cliType}] Provider resolution: providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'} source=${this.providerResolutionMeta.scriptsSource || '-'} version=${this.providerResolutionMeta.resolvedVersion || '-'}`
            );
        } else {
            const resolutionSummary = `providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'} source=${this.providerResolutionMeta.scriptsSource || '-'} version=${this.providerResolutionMeta.resolvedVersion || '-'}`;
            const hasResolvedProviderScripts = Boolean(
                this.providerResolutionMeta.providerDir
                || this.providerResolutionMeta.scriptDir
                || this.providerResolutionMeta.scriptsPath
                || this.providerResolutionMeta.scriptsSource
                || this.providerResolutionMeta.resolvedVersion,
            );
            if (hasResolvedProviderScripts) {
                LOG.warn('CLI', `[${this.cliType}] ⚠ No CLI scripts loaded! Provider needs scripts/{version}/scripts.js (${resolutionSummary})`);
            } else {
                LOG.info('CLI', `[${this.cliType}] CLI scripts not yet resolved (${resolutionSummary})`);
            }
        }
    }

    /** Inject CLI scripts after construction (e.g. when resolved by ProviderLoader) */
    setCliScripts(scripts: CliScripts): void {
        this.runner.setScripts(scripts);
        this.parsedStatusCache = null;
        LOG.info('CLI', `[${this.cliType}] CLI scripts injected: [${this.runner.getScriptNames().join(', ')}]`);
    }

    /** Refresh provider scripts/config used by this adapter without restarting the PTY runtime. */
    refreshProviderDefinition(provider: CliProviderModule): void {
        this.provider = provider;
        this.setCliScripts(provider.scripts || {});
    }

    updateRuntimeSettings(settings: Record<string, any>): void {
        this.runtimeSettings = { ...settings };
    }

 // ─── Lifecycle ─────────────────────────────────

    setServerConn(serverConn: any): void {
        this.serverConn = serverConn;
        if (this.serverConn && this.logBuffer.length > 0) {
            this.logBuffer.forEach(log => this.serverConn.sendMessage('log', log));
            this.logBuffer = [];
        }
    }

    setOnStatusChange(callback: () => void): void {
        this.onStatusChange = callback;
    }

    // FALSE-IDLE (Fix 2): the instance registers its inApprovalResumeGrace judgment so the
    // engine's applyIdle hysteresis can scope itself to autonomous auto-approving sessions
    // without the engine needing any mesh/auto-approve awareness of its own.
    setInApprovalResumeGraceProbe(probe: () => boolean): void {
        this.inApprovalResumeGraceProbe = probe;
    }

    // FLOOR-CLASS-TRANSCRIPT-DEFER-CAP: the instance registers its native-transcript
    // final-assistant judgment (same read its own completion gate uses) so the
    // engine's bounded defer-cap escape can finish a floor-class turn whose PTY
    // parse lost the final assistant, without the engine needing any native-history
    // awareness of its own.
    setNativeFinalAssistantProbe(probe: () => boolean): void {
        this.nativeFinalAssistantProbe = probe;
    }

    setOnPtyData(callback: (data: string) => void): void {
        this.onPtyDataCallback = callback;
    }

    private flushPendingOutputParse(): void {
        if (this.pendingOutputParseTimer) {
            clearTimeout(this.pendingOutputParseTimer);
            this.pendingOutputParseTimer = null;
        }
        if (this.pendingOutputParseChunks.length === 0) return;
        const rawData = this.pendingOutputParseChunks.join('');
        this.pendingOutputParseChunks = [];
        this.handleOutput(rawData);
    }

    async spawn(): Promise<void> {
        if (this.ptyProcess) return;

        const spawnPlan = resolveCliSpawnPlan({
            provider: this.provider,
            runtimeSettings: this.runtimeSettings,
            workingDir: this.workingDir,
            extraArgs: this.extraArgs,
            extraEnv: this.extraEnv,
        });

        LOG.info('CLI', `[${this.cliType}] Spawning in ${this.workingDir}`);

        try {
            this.ptyProcess = this.transportFactory.spawn(
                spawnPlan.shellCmd,
                spawnPlan.shellArgs,
                spawnPlan.ptyOptions,
            );
        } catch (err: any) {
            const msg = err?.message || String(err);
            if (!spawnPlan.isWin && !spawnPlan.useShell && /posix_spawn|spawn/i.test(msg)) {
                LOG.warn('CLI', `[${this.cliType}] Direct spawn failed (${msg}), retrying via login shell`);
                const retryPlan = buildCliLoginShellRetry(spawnPlan);
                this.ptyProcess = this.transportFactory.spawn(
                    retryPlan.shellCmd,
                    retryPlan.shellArgs,
                    spawnPlan.ptyOptions,
                );
            } else {
                const hint = getCliSpawnErrorHint(msg, spawnPlan.shellCmd, spawnPlan.isWin);
                if (hint) {
                    throw new Error(`Failed to spawn CLI${hint}: ${msg}`);
                }
                throw err;
            }
        }

        this.ptyProcess.onData((data: string) => {
            if (Date.now() < this.resizeSuppressUntil) return;

            if (!this.ptyProcess?.terminalQueriesHandled) {
                this.pendingTerminalQueryTail = respondToCliTerminalQueries({
                    ptyProcess: this.ptyProcess,
                    pendingTail: this.pendingTerminalQueryTail,
                    data,
                    terminalScreen: this.terminalScreen,
                });
            }

            this.pendingOutputParseChunks.push(data);
            if (!this.pendingOutputParseTimer) {
                this.pendingOutputParseTimer = setTimeout(() => {
                    this.pendingOutputParseTimer = null;
                    this.flushPendingOutputParse();
                }, this.timeouts.ptyFlush);
            }

            if (this.onPtyDataCallback) {
                this.ptyOutputChunks.push(data);
                if (!this.ptyOutputFlushTimer) {
                    this.ptyOutputFlushTimer = setTimeout(() => {
                        if (this.ptyOutputChunks.length > 0 && this.onPtyDataCallback) {
                            this.onPtyDataCallback(this.ptyOutputChunks.join(''));
                        }
                        this.ptyOutputChunks = [];
                        this.ptyOutputFlushTimer = null;
                    }, this.timeouts.ptyFlush);
                }
            }
        });

        this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number | null; signal?: number | null }) => {
            // Preserve the unknown case: a null exitCode (signal-terminated or
            // otherwise unreported) is logged as "unknown", never as exit 0.
            LOG.info('CLI', `[${this.cliType}] Exit code ${exitCode === null || exitCode === undefined ? 'unknown' : exitCode}${signal ? ` (signal ${signal})` : ''}`);
            this.flushPendingOutputParse();
            this.ptyProcess = null;
            this.engine.onPtyExit();
            this.ready = false;
            this.startupParseGate = false;
            this.spawnAt = 0;
            this.runner.resetSessionState();
            this.onStatusChange?.();
        });

        this.spawnAt = Date.now();
        this.startupParseGate = true;
        this.startupBuffer = '';
        this.startupFirstOutputAt = 0;
        if (this.startupSettleTimer) { clearTimeout(this.startupSettleTimer); this.startupSettleTimer = null; }
        this.resetTerminalScreen(DEFAULT_SESSION_HOST_ROWS, DEFAULT_SESSION_HOST_COLS);
        this.pendingTerminalQueryTail = '';
        this.ready = false;
        // Each fresh spawn re-enters the premature-ready swallow window — the next
        // turn is again a "first turn" and must use the win32-safe atomic send path.
        this.firstTurnSent = false;
        await this.ptyProcess.ready;
        this.engine.onSpawnReady();
        this.scheduleStartupSettleCheck();
        this.onStatusChange?.();
    }

 // ─── Output Handling ────────────────────────────

    private handleOutput(rawData: string): void {
        this.terminalScreen.write(rawData);
        const cleanData = sanitizeTerminalText(rawData);
        const renderedTranscript = this.transcriptAccumulator.append(rawData);
        const now = Date.now();
        const shouldReadScreen = this.shouldReadTerminalScreenSnapshot(now);
        const screenText = shouldReadScreen ? this.readTerminalScreenText(now) : this.lastScreenText;
        const normalizedScreenSnapshot = shouldReadScreen
            ? normalizeScreenSnapshot(screenText)
            : this.lastScreenSnapshot;
        this.lastOutputAt = now;
        if (cleanData.trim()) this.lastNonEmptyOutputAt = now;
        if (shouldReadScreen && normalizedScreenSnapshot !== this.lastScreenSnapshot) {
            this.lastScreenSnapshot = normalizedScreenSnapshot;
            this.lastScreenChangeAt = now;
        }
        if (this.startupParseGate && !this.startupFirstOutputAt && (cleanData.trim() || normalizedScreenSnapshot.trim())) {
            this.startupFirstOutputAt = now;
        }
        if (rawData.length > 0 || cleanData.length > 0) {
            this.engine.clearIdleFinishCandidate('new_output');
        }
        if (getDebugRuntimeConfig().collectDebugTrace) {
            this.engine.recordExternalTrace('output', {
                rawLength: rawData.length,
                cleanLength: cleanData.length,
                rawPreview: summarizeCliTraceText(rawData, 300),
                cleanPreview: summarizeCliTraceText(cleanData, 300),
            });
        }

        if (this.startupParseGate) {
            this.scheduleStartupSettleCheck();
        }

        if (this.engine.isWaitingForResponse && cleanData) {
            const previousResponseLen = this.responseBuffer.length;
            this.responseBuffer = appendBoundedText(this.responseBuffer, cleanData, ProviderCliAdapter.MAX_RESPONSE_BUFFER);
            this.responseBufferDroppedChars += this.recordBoundedAppendDrop(previousResponseLen, cleanData.length, this.responseBuffer.length);
        }

        // Server log forwarding
        if (cleanData.trim()) {
            if (this.serverConn) {
                this.serverConn.sendMessage('log', { message: cleanData.trim(), level: 'info' });
            } else {
                this.logBuffer.push({ message: cleanData.trim(), level: 'info' });
            }
        }

        // Rolling parser/readback buffers. `accumulatedBuffer` and
        // `recentOutputBuffer` intentionally use the rendered transcript state,
        // not raw PTY append text, so overwritten CLI status/tool lines do not
        // leak stale cells into read_chat / mesh_read_chat compact summaries.
        const prevRecentLen = this.recentOutputBuffer.length;
        const prevAccumulatedRawLen = this.accumulatedRawBuffer.length;
        const nextAccumulatedBuffer = renderedTranscript.length <= ProviderCliAdapter.MAX_ACCUMULATED_BUFFER
            ? renderedTranscript
            : renderedTranscript.slice(-ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);
        const nextRecentOutputBuffer = nextAccumulatedBuffer.slice(-ProviderCliAdapter.MAX_RECENT_OUTPUT_BUFFER);
        this.recentOutputBuffer = nextRecentOutputBuffer;
        this.accumulatedBuffer = nextAccumulatedBuffer;
        this.accumulatedRawBuffer = appendBoundedText(this.accumulatedRawBuffer, rawData, ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);
        // recentOutputBuffer is a 1000-char sliding window over accumulatedBuffer.
        // Anything that doesn't fit in the window is considered dropped.
        const droppedRecent = Math.max(0, renderedTranscript.length - ProviderCliAdapter.MAX_RECENT_OUTPUT_BUFFER);
        const droppedClean = Math.max(0, renderedTranscript.length - this.accumulatedBuffer.length);
        const droppedRaw = this.recordBoundedAppendDrop(prevAccumulatedRawLen, rawData.length, this.accumulatedRawBuffer.length);
        this.recentOutputDroppedChars += droppedRecent;
        this.accumulatedBufferDroppedChars += droppedClean;
        this.accumulatedRawBufferDroppedChars += droppedRaw;
        // Keep turn-scope offsets aligned with the truncated buffer so scoped
        // parses don't lose the beginning of a long turn (e.g. the Hermes
        // ╭─ opening line) when the rolling window sheds bytes.
        if (this.engine.currentTurnScope) {
            if (droppedClean > 0) {
                this.engine.currentTurnScope.bufferStart = Math.max(0, this.engine.currentTurnScope.bufferStart - droppedClean);
            }
            if (droppedRaw > 0) {
                this.engine.currentTurnScope.rawBufferStart = Math.max(0, this.engine.currentTurnScope.rawBufferStart - droppedRaw);
            }
        }

        this.resolveStartupState('output', screenText, normalizedScreenSnapshot, now);

        // ─── Script-based status detection
        this.engine.scheduleSettle();
    }

    private resolveStartupState(
        trigger: string,
        screenTextOverride?: string,
        normalizedScreenOverride?: string,
        nowOverride?: number,
    ): void {
        if (!this.startupParseGate) return;

        const now = typeof nowOverride === 'number' ? nowOverride : Date.now();
        const screenText = typeof screenTextOverride === 'string' ? screenTextOverride : this.readTerminalScreenText();
        const normalizedScreen = typeof normalizedScreenOverride === 'string'
            ? normalizedScreenOverride
            : normalizeScreenSnapshot(screenText);
        const hasStartupOutput = !!this.startupFirstOutputAt || !!normalizedScreen.trim();
        if (!hasStartupOutput) return;

        const stableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : 0;
        if (stableMs < 2000) return;

        const startupModal = this.runParseApproval(this.recentOutputBuffer);
        const startupIdle = this.detectIdleHonoringOnNoMatch(screenText || this.recentOutputBuffer);
        if (!startupModal && !startupIdle) {
            this.scheduleStartupSettleCheck();
            return;
        }
        this.startupParseGate = false;
        if (this.startupSettleTimer) {
            clearTimeout(this.startupSettleTimer);
            this.startupSettleTimer = null;
        }
        this.ready = true;
        if (startupModal) {
            this.engine.activeModal = startupModal;
            this.engine.setStatus('waiting_approval', `startup_ready:${trigger}`);
        } else {
            if (this.engine.currentStatus === 'waiting_approval' || this.engine.activeModal) {
                this.engine.lastApprovalResolvedAt = Date.now();
            }
            this.engine.activeModal = null;
            // Clear the in-flight turn flag at the same time we declare
            // startup-idle. Otherwise the next settled evaluation sees
            // isWaitingForResponse=true + recent CLI welcome-screen paints
            // and flips us right back to generating via the hold path
            // (the "startup → generating → idle → generating → idle"
            // flicker the user observed on claude-cli launch).
            this.engine.isWaitingForResponse = false;
            this.engine.currentTurnScope = null;
            this.engine.setStatus('idle', `startup_ready:${trigger}`);
        }
        LOG.info(
            'CLI',
            `[${this.cliType}] Startup settled (${trigger}, stableMs=${stableMs}, modal=${!!startupModal}) providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'}`
        );
        this.onStatusChange?.();
        // Readiness barrier flush: a message queued because the session was not yet
        // ready (sendMessageNow's not_ready_pending_prompt path) has no turn-completion
        // event to trigger its flush. Now that the interactive prompt is up and we are
        // idle, drain it. No-op when the queue is empty or we settled to a modal.
        if (!startupModal) this.schedulePendingOutboundFlush();
    }

    private scheduleStartupSettleCheck(): void {
        if (!this.startupParseGate) return;
        if (this.startupSettleTimer) clearTimeout(this.startupSettleTimer);

        const now = Date.now();
        const stableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : 0;
        const delayMs = Math.max(250, 2050 - stableMs);

        this.startupSettleTimer = setTimeout(() => {
            this.startupSettleTimer = null;
            this.resolveStartupState('startup_timer');
            if (this.startupParseGate && (Date.now() - this.spawnAt) < 10000) {
                this.scheduleStartupSettleCheck();
            }
        }, delayMs);
    }

    private async waitForInteractivePrompt(maxWaitMs = 5000): Promise<void> {
        const startedAt = Date.now();
        let loggedWait = false;

        while (Date.now() - startedAt < maxWaitMs) {
            this.resolveStartupState('interactive_wait');
            const screenText = this.terminalScreen.getText() || '';
            const stableMs = this.lastScreenChangeAt ? (Date.now() - this.lastScreenChangeAt) : 0;
            const recentlyOutput = this.lastNonEmptyOutputAt ? (Date.now() - this.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
            const status = this.runDetectStatus(this.recentOutputBuffer) || this.engine.currentStatus;
            const interactiveReady = status === 'idle'
                && stableMs >= 700
                && recentlyOutput >= 350;

            if (interactiveReady) {
                if (loggedWait) {
                    LOG.info(
                        'CLI',
                        `[${this.cliType}] Interactive prompt ready after ${Date.now() - startedAt}ms (stableMs=${stableMs}, recentOutputMs=${recentlyOutput})`
                    );
                }
                return;
            }

            if (!loggedWait && (Date.now() - startedAt) >= 400) {
                loggedWait = true;
                LOG.info(
                    'CLI',
                    `[${this.cliType}] Waiting for interactive prompt: status=${status} stableMs=${stableMs} recentOutputMs=${recentlyOutput} screen=${JSON.stringify(summarizeCliTraceText(screenText, 220)).slice(0, 260)}`
                );
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const finalScreenText = this.terminalScreen.getText() || '';
        LOG.warn(
            'CLI',
            `[${this.cliType}] Interactive prompt wait timed out after ${maxWaitMs}ms; proceeding with screen=${JSON.stringify(summarizeCliTraceText(finalScreenText, 240)).slice(0, 280)}`
        );
    }

    private clearAllTimers(): void {
        if (this.responseTimeout) { clearTimeout(this.responseTimeout); this.responseTimeout = null; }
        if (this.submitRetryTimer) { clearTimeout(this.submitRetryTimer); this.submitRetryTimer = null; }
        if (this.pendingOutputParseTimer) { clearTimeout(this.pendingOutputParseTimer); this.pendingOutputParseTimer = null; }
        if (this.ptyOutputFlushTimer) { clearTimeout(this.ptyOutputFlushTimer); this.ptyOutputFlushTimer = null; }
        this.engine.clearAllTimers();
    }

 // ─── Script dispatch — builds inputs for CliScriptRunner ──────────────────

    runParseSession(): ParsedSession | null {
        const screenText = this.terminalScreen.getText();
        const parseScreenText = this.getParseScreenText(screenText);
        const tail = this.recentOutputBuffer.slice(-500);
        const input = buildCliParseInput({
            accumulatedBuffer: this.accumulatedBuffer,
            accumulatedRawBuffer: this.accumulatedRawBuffer,
            recentOutputBuffer: this.recentOutputBuffer,
            terminalScreenText: parseScreenText,
            workingDir: this.workingDir,
            providerSessionId: this.providerSessionId || undefined,
            historySessionId: this.providerSessionId || undefined,
            baseMessages: [],
            partialResponse: this.responseBuffer,
            isWaitingForResponse: this.engine.isWaitingForResponse,
            // Full accumulated buffer (scope null) for pure-PTY full-transcript
            // providers so prior turns' bubbles never drop when a new turn starts;
            // the current-turn slice otherwise. See parsesFullPtyTranscriptFromBuffer.
            scope: this.transcriptParseScope(),
            runtimeSettings: this.runtimeSettings,
            spawnAt: this.spawnAt,
        });
        const session = this.runner.parseSession({
            ...input,
            tail,
            tailScreen: buildCliScreenSnapshot(tail),
        });
        if (session && typeof session === 'object') this.applyParsedSessionMetadata(session);
        return session;
    }

    runDetectStatus(text: string): string | null {
        const screenText = this.terminalScreen.getText();
        const tail = text.slice(-500);
        return this.runner.detectStatus({
            tail,
            screenText,
            rawBuffer: this.accumulatedRawBuffer,
            isWaitingForResponse: this.engine.isWaitingForResponse,
            screen: buildCliScreenSnapshot(screenText),
            tailScreen: buildCliScreenSnapshot(tail),
        });
    }

    /**
     * WRITE-READINESS ONNOMATCH (opencode): resolve whether the session is
     * genuinely idle *for the purpose of opening the PTY write gate*, honoring
     * the manifest's `dispatchOrder.onNoMatch` policy.
     *
     * The split-brain this closes: the engine's settled evaluation runs
     * detectStatus through parseSession, whose builder collapses a null verdict
     * to `'idle'` (buildParseSessionFromTui: `detectStatus(input) ?? 'idle'`),
     * so the dashboard status flips to idle via `script_detect`. But the
     * write-readiness gates (resolveStartupState / sendMessage recovery) call
     * `runDetectStatus` *directly* and require the literal `=== 'idle'` return —
     * they never apply the `onNoMatch` policy. opencode's only idle cue is the
     * `Ask anything` composer placeholder in the last-8-lines scope with
     * `onNoMatch: preserve-last`; when that placeholder is momentarily out of
     * frame the raw detector returns null, the gate stays shut, `this.ready`
     * never flips, and the first queued prompt sits in `not_ready_pending_prompt`
     * forever (no turn ever starts, so no turn-completion drain fires).
     *
     * The fix keeps the raw detector as the primary signal (unchanged behavior
     * for providers whose detector returns a literal idle) and only falls back
     * when BOTH (a) the manifest policy is idle-preserving (`preserve-last` or
     * `idle`) AND (b) the engine has *durably* settled to idle (no in-flight
     * turn, no modal, no parse error). That guard makes the fallback safe: it
     * cannot open the gate mid-turn or while a modal is up.
     */
    private detectIdleHonoringOnNoMatch(text: string): boolean {
        if (this.runDetectStatus(text) === 'idle') return true;
        const dispatchOrder = (this.provider.tui as { dispatchOrder?: { onNoMatch?: unknown } } | undefined)?.dispatchOrder;
        const onNoMatch = dispatchOrder?.onNoMatch;
        if (onNoMatch !== 'preserve-last' && onNoMatch !== 'idle') return false;
        return this.engine.currentStatus === 'idle'
            && !this.engine.isWaitingForResponse
            && !this.engine.currentTurnScope
            && !this.engine.activeModal
            && !this.parseErrorMessage;
    }

    runParseApproval(tail: string): { message: string; buttons: string[] } | null {
        const screenText = this.terminalScreen.getText();
        const buffer = screenText || this.accumulatedBuffer;
        return this.runner.parseApproval({
            buffer,
            screenText,
            rawBuffer: this.accumulatedRawBuffer,
            tail,
            screen: buildCliScreenSnapshot(screenText),
            bufferScreen: buildCliScreenSnapshot(buffer),
            tailScreen: buildCliScreenSnapshot(tail),
        });
    }

    private applyParsedSessionMetadata(parsed: any): void {
        const providerSessionId = typeof parsed?.providerSessionId === 'string' && parsed.providerSessionId.trim()
            ? parsed.providerSessionId.trim()
            : '';
        if (providerSessionId && providerSessionId !== this.providerSessionId) {
            this.providerSessionId = providerSessionId;
            this.updateRuntimeMeta({ providerSessionId });
        }
    }

    private projectEffectiveStatus(startupModal: { message: string; buttons: string[] } | null = null): CliSessionStatus['status'] {
        if (this.parseErrorMessage) return 'error';
        if (!!(startupModal || this.engine.activeModal)) return 'waiting_approval';
        if (this.engine.isWaitingForResponse && this.engine.currentTurnScope && this.engine.currentStatus !== 'stopped') return 'generating';
        return this.engine.currentStatus;
    }

 // ─── Public API (CliAdapter) ───────────────────

    getStatus(options: { allowParse?: boolean } = {}): CliSessionStatus {
        const allowParse = options.allowParse !== false;
        let startupModal = allowParse && this.startupParseGate ? this.runParseApproval(this.recentOutputBuffer) : null;
        // (fix: kimi startup-gate stale-approval bypass) startupParseGate can
        // still be open by the time a real approval is requested AND resolved
        // — this ad-hoc parse of recentOutputBuffer runs independently of the
        // settled-eval loop and previously had no staleness protection at all,
        // so it kept re-surfacing the identical already-resolved modal for as
        // long as its text remained anywhere in the rolling buffer, bypassing
        // engine.activeModal (which resolveModal() had already correctly
        // cleared). Reuse the SAME discriminator the settle loop uses instead
        // of inventing a second one here.
        if (startupModal && this.engine.isStaleResolvedApproval(startupModal, { screenText: this.terminalScreen.getText(), accumulatedBuffer: this.accumulatedBuffer })) {
            startupModal = null;
        }
        const startupDetectedStatus = allowParse && this.startupParseGate && !startupModal
            ? this.runDetectStatus(this.recentOutputBuffer || this.terminalScreen.getText())
            : null;
        // (D4) Poll-driven static-idle confirm. A hosted CLI session whose boot
        // banner drove the FSM to 'generating' can then sit at a STATIC ready
        // prompt emitting NO further PTY output — every output-driven busy→idle
        // re-eval is starved and the startup-settle loop has hard-stopped past
        // spawnAt+10s, so currentStatus stays frozen at generating and the
        // dashboard disables Send. This read-path poll is the only place that can
        // release the wedge. Gate PRECISELY (reuse resolveStartupState's proven
        // predicates so a real generating turn is NEVER mis-flipped):
        //   (a) no recent output for >= statusActivityHold (the 2000ms stable
        //       window resolveStartupState uses),
        //   (b) runDetectStatus(current screen) === 'idle' (same detector),
        //   (c) no active/parsed modal — an approval/choice screen is never
        //       flipped to idle.
        // A real generating turn keeps producing output (fresh
        // lastNonEmptyOutputAt) and/or shows 'esc to cancel' (detects busy) → it
        // fails (a) or (b). confirmPollStaticIdle adds the final structural guard
        // (currentStatus==='generating' AND no currentTurnScope/activeModal), so
        // this only releases the boot-banner wedge and the post-turn static-idle
        // case. Direct-spawn sessions already settle idle in the startup window
        // → this is a no-op for them.
        if (
            allowParse
            && this.engine.currentStatus === 'generating'
            && !this.engine.currentTurnScope
            && !this.engine.activeModal
        ) {
            const now = Date.now();
            const quietForMs = this.lastNonEmptyOutputAt
                ? (now - this.lastNonEmptyOutputAt)
                : Number.MAX_SAFE_INTEGER;
            let eligible = false;
            if (quietForMs >= this.getStatusActivityHoldMs()) {
                const screenText = this.terminalScreen.getText();
                const pollDetect = this.runDetectStatus(screenText || this.recentOutputBuffer);
                const pollModal = this.runParseApproval(screenText)
                    || this.runParseApproval(this.recentOutputBuffer);
                // (FALSEIDLE Path-C) Final-assistant / pending-response discriminator.
                // Paths A and B refuse to finalize a turn whose partial-response buffer
                // is still non-empty (getCompletedFinalizationBlock 'partial_response_pending'
                // / completionFinalAssistantEvidence turnClosed at cli-provider-instance.ts).
                // Path C (this poll) previously OMITTED it, so a genuinely-live but
                // momentarily-silent turn — silent thinking, a backgrounded/long tool child,
                // the gap between two assistant bubbles — whose currentTurnScope anchor was
                // lost still satisfied the weaker gate and flipped to idle prematurely.
                // Require an EMPTY partial buffer here too. getPartialResponse() returns the
                // accumulated assistant stream while isWaitingForResponse (which
                // applyGenerating leaves set on the boot-banner wedge too), so this does NOT
                // reintroduce the D4b wedge: the attach/boot-banner seeds only the static
                // ready screen — no assistant turn ever streamed — so its partial buffer is
                // empty and the gate still releases it. A mid-turn quiet gap holds a
                // non-empty buffer and is deferred.
                const partial = this.getPartialResponse();
                const partialPending = typeof partial === 'string' && partial.trim().length > 0;
                eligible = pollDetect === 'idle' && !pollModal && !partialPending;
            }
            if (eligible) {
                // (FALSEIDLE Path-C) Debounce for autonomous mesh sessions. A worker /
                // coordinator has no human to correct a premature idle, and a single
                // runDetectStatus point-sample can land in a live turn's momentary silence.
                // Require STATIC_IDLE_POLL_CONFIRM_COUNT consecutive eligible polls before
                // confirming, so the FSM must observe a sustained static-idle screen — a
                // turn that resumes (fresh output, or a re-armed turn scope) resets the
                // streak. The status poll runs on the 30s-idle / 5s-generating heartbeat and
                // this getStatus gate is re-hit each dashboard status tick, so 2 confirms is
                // ~one extra tick of hysteresis — enough to reject a one-sample silence gap
                // without materially delaying a genuine boot-wedge release. Foreground /
                // attended sessions keep the single-poll confirm (a human is watching Send).
                const requiredStreak = this.isAutonomousMeshSession()
                    ? ProviderCliAdapter.STATIC_IDLE_POLL_CONFIRM_COUNT
                    : 1;
                this.staticIdlePollStreak += 1;
                if (this.staticIdlePollStreak >= requiredStreak) {
                    if (this.engine.confirmPollStaticIdle('poll_static_idle')) {
                        // This transition originates from the read-only status poll rather
                        // than PTY output. Propagate it through the same instance callback as
                        // output-driven FSM transitions so completion bookkeeping observes
                        // generating→idle and can arm/finalize the pending completion.
                        this.onStatusChange?.();
                    }
                    this.staticIdlePollStreak = 0;
                }
            } else {
                this.staticIdlePollStreak = 0;
            }
        } else {
            this.staticIdlePollStreak = 0;
        }
        let effectiveStatus = this.projectEffectiveStatus(startupModal);
        let effectiveModal = startupModal || this.engine.activeModal;
        // (fix) When we have no captured modal yet, take one more live attempt
        // with the current screen text — the engine's settle pass can miss
        // the modal when it happens to fire exactly between writes, and
        // without a modal here the dashboard could never show the buttons.
        // We deliberately do NOT overwrite an existing engine.activeModal so
        // a stable matched modal wins. This runs even outside the startup
        // gate because Claude's approval frames can appear long after launch.
        if (allowParse && !effectiveModal && this.engine.isWaitingForResponse) {
            const liveDetect = this.runDetectStatus(this.recentOutputBuffer || this.terminalScreen.getText());
            if (liveDetect === 'waiting_approval') {
                const liveModal = this.runParseApproval(this.terminalScreen.getText())
                    || this.runParseApproval(this.recentOutputBuffer);
                // (fix) Only surface modals that have at least one non-empty
                // button. Half-rendered approval frames produced
                // { message, buttons: [] } briefly — auto-approve would then
                // pick buttonIndex=-1 and resolveModal would write the
                // provider's index-0 key into the prompt. Skip those frames
                // and let a later evaluate find the complete modal.
                const buttonsOk = liveModal && Array.isArray(liveModal.buttons)
                    && liveModal.buttons.some((b: any) => typeof b === 'string' && b.trim());
                // (fix: kimi live-detect stale-approval bypass) This fallback is
                // NOT gated by startupParseGate — it runs on every getStatus()
                // call (including the periodic background status heartbeat)
                // for as long as isWaitingForResponse stays true, which for a
                // provider that keeps "thinking" after the approved tool call
                // can be the whole rest of the turn. Its own unguarded re-parse
                // of recentOutputBuffer/terminalScreen previously kept
                // re-writing engine.activeModal directly — bypassing setStatus
                // (so rawStatus never even flipped) and bypassing
                // applyWaitingApproval's staleness guard entirely, silently
                // re-corrupting the engine's own state moments after
                // resolveModal() had correctly cleared it. Reuse the same
                // engine-owned discriminator here too.
                if (liveModal && buttonsOk && !this.engine.isStaleResolvedApproval(liveModal, { screenText: this.terminalScreen.getText(), accumulatedBuffer: this.accumulatedBuffer })) {
                    effectiveModal = liveModal;
                    if (!this.engine.activeModal) this.engine.activeModal = liveModal;
                }
            }
        }
        // Only surface waiting_approval when we ALSO have a concrete modal
        // (message + buttons). detectStatus alone can fire while parseApproval
        // is still null — the engine logs "detectStatus=waiting_approval but
        // parseApproval returned null; ignoring". Without this guard getStatus
        // was shipping a bare waiting_approval with activeModal=null and the
        // user perceived the flow as broken.
        if (startupDetectedStatus === 'waiting_approval' && effectiveModal) {
            effectiveStatus = 'waiting_approval';
        } else if (startupDetectedStatus === 'idle' && !startupModal && !effectiveModal) {
            effectiveStatus = 'idle';
        }
        if (allowParse && !startupModal && !effectiveModal) {
            const parsed = this.getFreshParsedStatusCache();
            const parsedModal = parsed?.activeModal && Array.isArray(parsed.activeModal.buttons)
                && parsed.activeModal.buttons.some((button: any) => typeof button === 'string' && button.trim())
                ? parsed.activeModal
                : null;
            const hasFinalAssistant = (p: any) => {
                const msgs = Array.isArray(p?.messages) ? p.messages : [];
                return msgs.some((m: any) => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
            };
            if (parsed?.status === 'waiting_approval' && parsedModal) {
                effectiveStatus = 'waiting_approval';
                effectiveModal = parsedModal;
            } else if (
                effectiveStatus === 'idle'
                && parsed?.status === 'generating'
                && !hasFinalAssistant(parsed)
            ) {
                effectiveStatus = 'generating';
            } else if (
                effectiveStatus === 'generating'
                && parsed?.status === 'idle'
                && hasFinalAssistant(parsed)
            ) {
                effectiveStatus = 'idle';
            }
        }
        const bufferState = this.getBufferState();
        return {
            status: effectiveStatus,
            messages: [],
            workingDir: this.workingDir,
            activeModal: effectiveModal,
            approvalEntrySeq: this.engine.approvalEntrySeq,
            lastResolvedEntrySeq: this.engine.lastResolvedEntrySeq,
            pendingOutboundCount: this.pendingOutboundQueue.length,
            pendingOutboundMessages: this.pendingOutboundQueue.map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                queuedAt: message.queuedAt,
                source: message.source,
            })),
            errorMessage: this.parseErrorMessage || this.engine.providerErrorMessage || undefined,
            errorReason: this.parseErrorMessage ? 'parse_error' : (this.engine.providerErrorReason || undefined),
            providerSessionId: this.providerSessionId || undefined,
            lastOutputAt: this.lastOutputAt,
            lastScreenChangeAt: this.lastScreenChangeAt,
            ...(bufferState ? { bufferState } : {}),
        };
    }


    /**
     * Script-based full parse — returns ReadChatResult.
     * Called by command handler / dashboard for rich content rendering.
     */
    getScriptParsedStatus(): any {
        const screenText = this.readTerminalScreenText();
        const parseScreenText = this.getParseScreenText(screenText);
        const cached = this.parsedStatusCache;
        const accumulatedRawBufferKey = this.getAccumulatedRawBufferCacheKey();
        if (
            !this.providerOwnsTranscript()
            && cached
            && cached.responseBuffer === this.responseBuffer
            && cached.currentTurnScope === this.engine.currentTurnScope
            && cached.recentOutputBuffer === this.recentOutputBuffer
            && cached.accumulatedBuffer === this.accumulatedBuffer
            && cached.accumulatedRawBufferKey === accumulatedRawBufferKey
            && cached.screenText === parseScreenText
            && cached.currentStatus === this.engine.currentStatus
            && cached.activeModal === this.engine.activeModal
            && cached.cliName === this.cliName
        ) {
            return cached.result;
        }

        const parsed = this.runParseSession();
        if (!parsed || !Array.isArray(parsed.messages)) {
            throw new Error(this.parseErrorMessage || `${this.cliType} parseSession did not return messages`);
        }

        const activeModal = (parsed as any).activeModal ?? parsed.modal ?? null;
        const bufferState = this.getBufferState();
        const result = {
            id: (parsed as any).id || 'cli_session',
            status: parsed.status || this.engine.currentStatus,
            title: (parsed as any).title || this.cliName,
            messages: normalizeCliParsedMessages(parsed.messages, {
                    scope: null,
                lastOutputAt: this.lastOutputAt,
            }),
            activeModal,
            providerSessionId: this.providerSessionId || (typeof (parsed as any).providerSessionId === 'string' ? (parsed as any).providerSessionId : undefined),
            errorMessage: typeof (parsed as any).errorMessage === 'string' && (parsed as any).errorMessage.trim()
                ? (parsed as any).errorMessage.trim()
                : undefined,
            errorReason: typeof (parsed as any).errorReason === 'string' && (parsed as any).errorReason.trim()
                ? (parsed as any).errorReason.trim()
                : undefined,
            ...(bufferState ? { bufferState } : {}),
            ...((parsed as any).transcriptAuthority === 'provider' || (parsed as any).transcriptAuthority === 'daemon'
                ? { transcriptAuthority: (parsed as any).transcriptAuthority }
                : this.providerOwnsTranscript() ? { transcriptAuthority: 'provider' } : {}),
            ...((parsed as any).coverage === 'full' || (parsed as any).coverage === 'tail' || (parsed as any).coverage === 'current-turn'
                ? { coverage: (parsed as any).coverage }
                : this.providerOwnsTranscript() ? { coverage: this.shouldUseFullProviderTranscriptContext() ? 'full' : 'tail' } : {}),
        };

        this.parsedStatusCache = {
            responseBuffer: this.responseBuffer,
            currentTurnScope: this.engine.currentTurnScope,
            recentOutputBuffer: this.recentOutputBuffer,
            accumulatedBuffer: this.accumulatedBuffer,
            accumulatedRawBufferKey,
            screenText: parseScreenText,
            currentStatus: this.engine.currentStatus,
            activeModal: this.engine.activeModal,
            cliName: this.cliName,
            result,
        };
        return result;
    }

    async invokeScript(scriptName: string, args?: Record<string, any>): Promise<any> {
        const input = buildCliParseInput({
            accumulatedBuffer: this.accumulatedBuffer,
            accumulatedRawBuffer: this.accumulatedRawBuffer,
            recentOutputBuffer: this.recentOutputBuffer,
            terminalScreenText: this.getParseScreenText(this.terminalScreen.getText()),
            workingDir: this.workingDir,
            providerSessionId: this.providerSessionId || undefined,
            historySessionId: this.providerSessionId || undefined,
            baseMessages: [],
            partialResponse: this.responseBuffer,
            isWaitingForResponse: this.engine.isWaitingForResponse,
            scope: this.engine.currentTurnScope,
            runtimeSettings: this.runtimeSettings,
            spawnAt: this.spawnAt,
        });
        return await Promise.resolve(this.runner.invokeByName(scriptName, {
            ...input,
            args: args && typeof args === 'object' ? { ...args } : {},
        }));
    }

    private parseCurrentTranscript(_baseMessages: CliChatMessage[], _partialResponse: string, _scope?: TurnParseScope | null, _screenTextOverride?: string): any {
        return this.runParseSession();
    }

    /** Whether this adapter has CLI scripts loaded */
    hasCliScripts(): boolean {
        return this.runner.hasDetectStatus();
    }

    /**
     * Resolves an action (like 'fix' lint error) from the dashboard.
     * Uses resolveAction script if available, otherwise falls back to standard text.
     */
    async resolveAction(data: any): Promise<void> {
        let promptText = '';
        try {
            promptText = this.runner.invokeByName('resolveAction', data);
        } catch {
            LOG.warn('CLI', `[${this.cliType}] resolveAction skipped: provider script not available`);
            return;
        }
        if (!promptText) {
            LOG.warn('CLI', `[${this.cliType}] resolveAction skipped: provider script did not return a prompt`);
            return;
        }
        await this.sendMessage(promptText);
    }

    async setInteractivePromptResponse(_response: InteractivePromptResponse): Promise<void> {
        // Legacy TUI providers do not currently expose an interactive prompt
        // protocol. Spec-backed claude-cli implements the first real wiring.
    }

    private isSubmitStuck(normalizedPromptSnippet: string): boolean {
        if (!this.ptyProcess || !this.engine.isWaitingForResponse || this.engine.submitRetryUsed) return false;
        if (this.engine.hasActionableApproval()) return false;
        // If there's already meaningful response content beyond the echoed prompt, not stuck
        if (this.hasMeaningfulResponseBufferLocal(normalizedPromptSnippet)) return false;
        const screenText = this.terminalScreen.getText();
        if (!promptLikelyVisible(screenText, normalizedPromptSnippet)) return false;
        const liveApproval = this.runParseApproval(screenText) || this.runParseApproval(this.recentOutputBuffer);
        if (liveApproval) return false;
        const liveStatus = this.runDetectStatus(screenText) || this.runDetectStatus(this.recentOutputBuffer);
        return liveStatus !== 'generating' && liveStatus !== 'waiting_approval';
    }

    private hasMeaningfulResponseBufferLocal(promptSnippet: string): boolean {
        const raw = String(this.responseBuffer || '').trim();
        if (!raw) return false;
        const normalizedPrompt = compactPromptText(promptSnippet);
        if (!normalizedPrompt) return true;
        const normalizedBuffer = compactPromptText(raw);
        if (!normalizedBuffer) return false;
        if (normalizedBuffer === normalizedPrompt) return false;
        if (normalizedBuffer.startsWith(normalizedPrompt)) {
            const remainder = normalizedBuffer
                .slice(normalizedPrompt.length)
                .replace(/[─═\-]+/g, '')
                .replace(/⏵⏵accepteditson\([^)]*\)/gi, '')
                .replace(/accepteditson\([^)]*\)/gi, '')
                .replace(/(?:◐|◑|◒|◓|◔|◕|◉|●|·)?(?:x?high|medium|low|max)·?\/effort/gi, '')
                .replace(/updateavailable!run:[a-z0-9:._\-/]+/gi, '')
                .replace(/esctointerrupt/gi, '')
                .replace(/❯/g, '')
                .replace(/^[\s\-–—:;,.!/?]+/, '')
                .trim();
            return remainder.length > 0;
        }
        return true;
    }

    /** Serialize `data` onto the per-session PTY write chain. Returns a promise
     *  that resolves (or rejects) with THIS write's own outcome, so callers keep
     *  their existing "await my write completion" semantics. The underlying chain
     *  link swallows its own error before releasing the next write, so a failed
     *  write surfaces to its caller but never wedges subsequent writes behind a
     *  permanently-rejected tail (FIFO order preserved). */
    private writeToPty(data: string): Promise<void> {
        const run = this.ptyWriteChain.then(() => this.doWriteToPty(data));
        // Keep the tail resolved so the next writeToPty() always chains onto a
        // settled promise (never a rejected one). The caller still sees run's
        // rejection; only the shared chain is insulated from it.
        this.ptyWriteChain = run.catch(() => {});
        return run;
    }

    private async doWriteToPty(data: string): Promise<void> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        // win32 ConPTY paced write: a single unbounded write beyond ~1KB overflows
        // the console input pipe and drops LEADING bytes (the "long message gets
        // truncated, head lost / tail kept" failure). Split a large payload into
        // bounded, surrogate-safe chunks written with a short gap so the console
        // reader keeps up. Small payloads (the common case — short prompts, lone
        // submit keys) still go out in a single write.
        //
        // The submit key, when present, is the TAIL of `data` (callers pass
        // `body + sendKey` for the atomic-submit paths). Because we chunk the
        // combined string, the submit key always rides in the SAME final write as
        // the body's tail — the win32 invariant that ConPTY recognizes it as a
        // submit — and is never emitted before the whole body has been written
        // (no partial-body submit). Body-only writes (wait_for_echo strategy) have
        // their submit key sent separately by the caller afterwards, unchanged.
        if (process.platform === 'win32' && shouldChunkWin32Write(data.length)) {
            await this.writeWin32Chunked(data);
            return;
        }
        await this.ptyProcess.write(data);
    }

    /** Write `data` to the PTY in bounded, surrogate-safe chunks with a short
     *  inter-chunk gap (win32 paced write). Awaits each chunk's write and the gap
     *  so the returned promise resolves only after the FINAL chunk (carrying any
     *  trailing submit key) has been written. */
    private async writeWin32Chunked(data: string): Promise<void> {
        const chunks = chunkPreservingSurrogates(data, WIN32_PTY_WRITE_CHUNK_CHARS);
        for (let i = 0; i < chunks.length; i += 1) {
            if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
            await this.ptyProcess.write(chunks[i]);
            if (i + 1 < chunks.length) {
                await new Promise<void>(resolve => setTimeout(resolve, WIN32_PTY_WRITE_CHUNK_GAP_MS));
            }
        }
    }

    private resetPendingSendState(reason: string): void {
        this.responseBuffer = '';
        if (this.responseTimeout) { clearTimeout(this.responseTimeout); this.responseTimeout = null; }
        this.engine.resetActiveTurnState();
        this.engine.clearIdleFinishCandidate(reason);
    }

    private commitSendUserTurn(state: SendMessageState): void {
        if (state.didCommitUserTurn) return;
        state.didCommitUserTurn = true;
        // The first turn has now been written atomically (win32-safe); later turns
        // can use the normal echo-gated path now that the input layer is proven live.
        this.firstTurnSent = true;
    }

    private armResponseTimeout(): void {
        if (this.responseTimeout) clearTimeout(this.responseTimeout);
        const timeoutMs = this.timeouts.maxResponse;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            this.responseTimeout = null;
            return;
        }
        this.responseTimeout = setTimeout(() => {
            this.responseTimeout = null;
            if (!this.engine.isWaitingForResponse) return;

            // maxResponse is a watchdog/checkpoint, not a completion signal. Re-run the
            // normal settled parser instead and keep the turn open unless the provider
            // actually reports an idle, commit-ready state.
            this.engine.evaluateSettled(this.getSnapshot());

            if (this.engine.isWaitingForResponse && !this.engine.hasActionableApproval()) {
                this.armResponseTimeout();
            }
        }, timeoutMs);
    }

    private writeSubmitKeyForRetry(mode: string): void {
        void this.writeToPty(this.sendKey).catch((error) => {
            LOG.warn('CLI', `[${this.cliType}] ${mode} write failed: ${error?.message || error}`);
        });
    }

    // WIN32-READY-HOLD: choose the retry write for a stuck prompt. When the FIRST turn
    // is stuck on win32 — the premature-ready swallow window — the prompt text itself
    // may have been partially eaten by a not-yet-live ConPTY input layer, so re-sending
    // a bare CR keeps hitting nothing. Re-type the whole `text + sendKey` atomically
    // once so the input layer (now live) receives a self-contained, submit-coupled
    // write. All other cases keep the cheap bare-CR retry (the prompt is fully echoed
    // and only the Enter is missing).
    private writeStuckRetry(state: SendMessageState, mode: string): void {
        const retypeFirstTurn = process.platform === 'win32' && state.isFirstTurn;
        if (retypeFirstTurn) {
            LOG.info('CLI', `[${this.cliType}] ${mode}: re-typing full prompt atomically (win32 first-turn swallow recovery)`);
            void this.writeToPty(state.text + this.sendKey).catch((error) => {
                LOG.warn('CLI', `[${this.cliType}] ${mode} re-type write failed: ${error?.message || error}`);
            });
            return;
        }
        this.writeSubmitKeyForRetry(mode);
    }

    private retrySubmitIfStuck(state: SendMessageState, attempt: number): void {
        this.submitRetryTimer = null;
        if (!this.isSubmitStuck(state.normalizedPromptSnippet)) return;
        this.engine.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
        LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt ${attempt})`);
        this.writeStuckRetry(state, 'submit_retry');
        if (attempt >= 3) { this.engine.submitRetryUsed = true; return; }
        this.submitRetryTimer = setTimeout(() => this.retrySubmitIfStuck(state, attempt + 1), state.retryDelayMs);
    }

    private retryImmediateSubmitIfStuck(state: SendMessageState): void {
        this.submitRetryTimer = null;
        if (!this.isSubmitStuck(state.normalizedPromptSnippet)) return;
        this.engine.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
        LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt 1)`);
        this.writeStuckRetry(state, 'immediate_retry');
        this.engine.submitRetryUsed = true;
    }

    private submitSendKey(state: SendMessageState, completion: SendMessageCompletion): void {
        if (!this.ptyProcess) {
            completion.resolveOnce();
            return;
        }
        this.engine.submitPendingUntil = 0;
        void this.writeToPty(this.sendKey).then(() => {
            this.commitSendUserTurn(state);
            this.submitRetryTimer = setTimeout(() => this.retrySubmitIfStuck(state, 1), state.retryDelayMs);
            this.armResponseTimeout();
            completion.resolveOnce();
        }, completion.rejectOnce);
    }

    private submitImmediatePrompt(state: SendMessageState, completion: SendMessageCompletion): void {
        this.engine.submitPendingUntil = 0;
        void this.writeToPty(state.text + this.sendKey).then(() => {
            this.commitSendUserTurn(state);
            this.submitRetryTimer = setTimeout(() => this.retryImmediateSubmitIfStuck(state), state.retryDelayMs);
            this.armResponseTimeout();
            completion.resolveOnce();
        }, completion.rejectOnce);
    }

    private waitForEchoAndSubmit(
        state: SendMessageState,
        completion: SendMessageCompletion,
        submitStartedAt: number,
        lastNormalizedScreen = '',
        lastScreenChangeAt = submitStartedAt,
    ): void {
        if (!this.ptyProcess) {
            completion.resolveOnce();
            return;
        }
        const now = Date.now();
        const elapsed = now - submitStartedAt;
        const screenText = this.terminalScreen.getText();
        const normalizedScreen = normalizePromptText(screenText);
        const nextScreenChangeAt = normalizedScreen !== lastNormalizedScreen ? now : lastScreenChangeAt;
        const echoVisible = !state.normalizedPromptSnippet || promptLikelyVisible(screenText, state.normalizedPromptSnippet);

        if (echoVisible) {
            const screenSettled = (now - nextScreenChangeAt) >= 500;
            if (elapsed >= state.submitDelayMs && screenSettled) {
                this.submitSendKey(state, completion);
                return;
            }
        }

        if (elapsed >= state.maxEchoWaitMs) {
            const diagnostic = {
                elapsed,
                maxEchoWaitMs: state.maxEchoWaitMs,
                submitDelayMs: state.submitDelayMs,
                promptSnippet: state.normalizedPromptSnippet,
                requirePromptEchoBeforeSubmit: this.requirePromptEchoBeforeSubmit,
                screenText: summarizeCliTraceText(screenText, 1000),
            };
            LOG.warn('CLI', `[${this.cliType}] submit_echo_missing: ${JSON.stringify(diagnostic)}`);

            if (this.requirePromptEchoBeforeSubmit) {
                // At this point the prompt text write already completed. Rejecting without
                // a submit key can leave the delegated CLI with an unsent prompt sitting at
                // the input line, which makes later coordinator sends appear stuck. Prefer a
                // guarded submit after the full echo wait; the existing stuck-submit retry
                // will send a delayed follow-up Enter if the prompt remains visible.
                LOG.warn('CLI', `[${this.cliType}] prompt echo was not observed before submit; sending guarded submit key anyway elapsed=${elapsed}ms maxEchoWaitMs=${state.maxEchoWaitMs} screen=${JSON.stringify(diagnostic.screenText).slice(0, 240)}`);
                this.submitSendKey(state, completion);
                return;
            }
            LOG.warn('CLI', `[${this.cliType}] prompt echo was not observed before submit; sending submit key anyway elapsed=${elapsed}ms maxEchoWaitMs=${state.maxEchoWaitMs}`);
            this.submitSendKey(state, completion);
            return;
        }

        setTimeout(() => this.waitForEchoAndSubmit(
            state,
            completion,
            submitStartedAt,
            normalizedScreen,
            nextScreenChangeAt,
        ), 50);
    }

    async sendMessage(text: string, options: { force?: boolean; meshTaskId?: string } = {}): Promise<{ status: 'queued' | 'delivered' }> {
        if (options.force === true) {
            return await this.forceSendMessage(text, options.meshTaskId);
        }
        return await this.sendMessageNow(text, true, options.meshTaskId);
    }

    async forceSendMessage(text: string, meshTaskId?: string): Promise<{ status: 'queued' | 'delivered' }> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        const content = String(text || '');
        if (!content.trim()) return { status: 'delivered' };
        // ARCH-REFACTOR R1: a force-send (mesh coordinator dispatch / reconcile
        // redelivery) bypasses the normal turnScope pipeline (raw PTY write), so there is
        // no turnScope to carry the taskId. Bind it directly on the engine so the
        // resulting turn's completion is still attributed to the right task.
        if (typeof meshTaskId === 'string' && meshTaskId.trim()) {
            this.engine.currentTurnTaskId = meshTaskId;
        }
        // Modal-park guard (defense-in-depth — the primary guard is at the
        // cli-provider-instance force-forward chokepoint). A force-write writes raw
        // keystrokes into the PTY, bypassing the busy send-guard. If the session is
        // parked on a tool-consent modal, the modal's key handler eats those bytes
        // and silently resolves an approval the user never made. Hold the write and
        // let the mesh reconcile loop redeliver once the modal is resolved. We only
        // hold for an actionable approval modal; plain generating is still force-written
        // (that is the deadlock the force path exists to break).
        if (this.engine.currentStatus === 'waiting_approval' || this.engine.hasActionableApproval()) {
            LOG.info('CLI', `[${this.cliType}] force-send held — session parked on approval modal (status=${this.engine.currentStatus})`);
            return { status: 'queued' };
        }
        LOG.info('CLI', `[${this.cliType}] force-sending prompt while status=${this.engine.currentStatus}`);
        // Settle, then submit atomically. The previous split-write fix
        // (write text → settle → write a separate '\r') regressed win32:
        // ConPTY does not treat a lone CR arriving in its own PTY chunk after a
        // delay as a submit key, so the Enter was swallowed and the prompt sat
        // typed-but-unsent. Instead, honor a fixed settle gap so the TUI input
        // handler is in its input-accepting state, then write `content + sendKey`
        // as ONE PTY write — the same atomic submit the normal `immediate`
        // strategy uses. Keeping the Enter in the same write unit as the text is
        // the invariant that makes win32 ConPTY recognize the submit, and it
        // also makes the original inject↔submit race impossible (the Enter can
        // never be separated from the text it submits). The settle still guards
        // the original concern — that a force-dispatch injected into a freshly
        // idle session lands before the TUI is ready to accept input.
        await this.waitForForceSubmitSettle();
        await this.writeToPty(content + this.sendKey);
        this.onStatusChange?.();
        return { status: 'delivered' };
    }

    private async waitForForceSubmitSettle(): Promise<void> {
        // A fixed minimum gap so the input handler is ready to accept the paste.
        // We deliberately do NOT echo-gate here: the submit key is written in the
        // same atomic PTY write as the text (forceSendMessage), so there is no
        // separate Enter that could race the echo, and on win32 the echo gate
        // never reliably matched anyway.
        await new Promise<void>(resolve => setTimeout(resolve, FORCE_SUBMIT_SETTLE_MS));
    }

    // Stale-queue threshold: warn if a queued message has not been flushed
    // within this many milliseconds (instrumentation only, no behavior change).
    private static readonly STALE_QUEUE_WARN_MS = 15000;

    private enqueuePendingOutboundMessage(text: string, reason: string, meshTaskId?: string): void {
        const content = String(text || '');
        const duplicate = this.pendingOutboundQueue.some((message) => message.content === content);
        if (duplicate) {
            return;
        }
        const queuedAt = Date.now();
        const stableMs = this.lastScreenChangeAt ? (queuedAt - this.lastScreenChangeAt) : -1;
        // Diagnostic context: which gate caused the silent-queue and the full
        // session readiness snapshot at the moment of enqueue.
        const gateContext = {
            reason,
            startupParseGate: this.startupParseGate,
            ready: this.ready,
            engineStatus: this.engine.currentStatus,
            isWaitingForResponse: this.engine.isWaitingForResponse,
            stableMs,
            sessionId: this.engine.getTraceSessionId(),
        };
        const message: PendingOutboundMessage = {
            id: `${queuedAt}:${this.pendingOutboundQueue.length}:${Math.random().toString(36).slice(2, 10)}`,
            role: 'user',
            content,
            queuedAt,
            source: 'sendMessage',
            ...(typeof meshTaskId === 'string' && meshTaskId.trim() ? { meshTaskId } : {}),
        };
        this.pendingOutboundQueue.push(message);
        LOG.info('CLI', `[${this.cliType}] queued outbound message; gate=${JSON.stringify(gateContext)}; queue=${this.pendingOutboundQueue.length}`);
        this.onStatusChange?.();
        // Stale-queue watchdog: emit a warn-level log if the enqueued message
        // has not been flushed after STALE_QUEUE_WARN_MS. This fires once per
        // enqueue event (not once per message still in queue) so it does not
        // spam on a persistently stuck queue; it simply surfaces that the queue
        // is stuck and records the current gate state at warn time.
        if (!this.pendingOutboundStaleTimer) {
            this.pendingOutboundStaleTimer = setTimeout(() => {
                this.pendingOutboundStaleTimer = null;
                if (this.pendingOutboundQueue.length === 0) return;
                const oldest = this.pendingOutboundQueue[0];
                const staleSec = ((Date.now() - oldest.queuedAt) / 1000).toFixed(1);
                const nowStableMs = this.lastScreenChangeAt ? (Date.now() - this.lastScreenChangeAt) : -1;
                LOG.warn('CLI', `[${this.cliType}] STALE QUEUE: ${this.pendingOutboundQueue.length} message(s) undelivered for ${staleSec}s; gate=startupParseGate:${this.startupParseGate} ready:${this.ready} engineStatus:${this.engine.currentStatus} isWaitingForResponse:${this.engine.isWaitingForResponse} stableMs:${nowStableMs} sessionId:${this.engine.getTraceSessionId()} enqueueReason:${oldest.id}`);
            }, ProviderCliAdapter.STALE_QUEUE_WARN_MS);
        }
    }

    private shouldQueuePendingOutboundMessage(parsedStatusBeforeSend: any | null = null): string | null {
        if (this.provider.allowInputDuringGeneration === true) return null;
        if (this.engine.hasActionableApproval()) return null;
        const parsedSessionStatus = typeof parsedStatusBeforeSend?.status === 'string'
            ? String(parsedStatusBeforeSend.status)
            : '';
        const hasFinalAssistant = (p: any) => {
            const msgs = Array.isArray(p?.messages) ? p.messages : [];
            return msgs.some((m: any) => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
        };
        if (parsedSessionStatus === 'idle' && hasFinalAssistant(parsedStatusBeforeSend)) return null;
        if (this.engine.currentStatus === 'generating') return 'current_status_generating';
        if (parsedSessionStatus === 'generating' || parsedSessionStatus === 'no_progress' || parsedSessionStatus === 'long_generating') {
            const parsedModal = parsedStatusBeforeSend?.activeModal ?? parsedStatusBeforeSend?.modal ?? null;
            const parsedHasActionableModal = Boolean(
                parsedModal
                && Array.isArray(parsedModal.buttons)
                && parsedModal.buttons.some((candidate: unknown) => typeof candidate === 'string' && candidate.trim()),
            );
            const terminalLooksIdle = this.engine.currentStatus === 'idle'
                && this.runDetectStatus(this.recentOutputBuffer) === 'idle'
                && !this.engine.isWaitingForResponse
                && !this.engine.currentTurnScope
                && !this.engine.hasActionableApproval()
                && !parsedHasActionableModal;
            return terminalLooksIdle ? null : `parsed_status_${parsedSessionStatus}`;
        }
        if (this.engine.isWaitingForResponse && this.engine.currentTurnScope) return 'active_turn_in_progress';
        return null;
    }

    private schedulePendingOutboundFlush(delayMs = 0): void {
        if (this.pendingOutboundFlushTimer) clearTimeout(this.pendingOutboundFlushTimer);
        this.pendingOutboundFlushTimer = setTimeout(() => {
            this.pendingOutboundFlushTimer = null;
            void this.flushPendingOutboundQueue();
        }, Math.max(0, delayMs));
    }

    private async flushPendingOutboundQueue(): Promise<void> {
        if (this.pendingOutboundFlushInFlight || this.pendingOutboundQueue.length === 0) return;
        if (this.engine.currentStatus !== 'idle' || this.engine.isWaitingForResponse || this.engine.hasActionableApproval()) return;
        this.pendingOutboundFlushInFlight = true;
        try {
            while (this.pendingOutboundQueue.length > 0) {
                if (this.engine.currentStatus !== 'idle' || this.engine.isWaitingForResponse || this.engine.hasActionableApproval()) break;
                const next = this.pendingOutboundQueue[0];
                try {
                    await this.sendMessageNow(next.content, false, next.meshTaskId);
                    this.pendingOutboundQueue.shift();
                    // Clear stale watchdog once the queue drains.
                    if (this.pendingOutboundQueue.length === 0 && this.pendingOutboundStaleTimer) {
                        clearTimeout(this.pendingOutboundStaleTimer);
                        this.pendingOutboundStaleTimer = null;
                    }
                    this.onStatusChange?.();
                } catch (error: any) {
                    LOG.warn('CLI', `[${this.cliType}] queued outbound flush failed: ${error?.message || error}`);
                    this.schedulePendingOutboundFlush(1000);
                    break;
                }
            }
        } finally {
            this.pendingOutboundFlushInFlight = false;
        }
    }

    private async sendMessageNow(text: string, allowQueue: boolean, meshTaskId?: string): Promise<{ status: 'queued' | 'delivered' }> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        const allowInputDuringGeneration = this.provider.allowInputDuringGeneration === true;
        const allowInterventionPrompt = allowInputDuringGeneration
            && this.engine.isWaitingForResponse
            && !this.engine.hasActionableApproval();
        if (this.startupParseGate) {
            const deadline = Date.now() + 10000;
            while (this.startupParseGate && Date.now() < deadline) {
                this.resolveStartupState('send_wait');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        const parsedStatusBeforeSend = !allowInputDuringGeneration
            ? (() => {
                try {
                    return this.getScriptParsedStatus?.() || null;
                } catch {
                    return null;
                }
            })()
            : null;
        const queueReason = this.shouldQueuePendingOutboundMessage(parsedStatusBeforeSend);
        if (allowQueue && queueReason) {
            this.enqueuePendingOutboundMessage(text, queueReason, meshTaskId);
            return { status: 'queued' };
        }
        if (!allowInterventionPrompt) {
            await this.waitForInteractivePrompt();
        }
        if (!this.ready) {
            this.resolveStartupState('send_precheck');
            if (!this.ready && this.detectIdleHonoringOnNoMatch(this.recentOutputBuffer)) {
                this.ready = true;
                this.startupParseGate = false;
                this.engine.setStatus('idle', 'send_message_idle_prompt_recovery');
                LOG.info('CLI', `[${this.cliType}] sendMessage recovered idle prompt readiness`);
            }
        }
        if (!this.ready) {
            // Readiness barrier (queue-until-ready). A task dispatched the instant a
            // freshly-spawned session is launched can arrive BEFORE the PTY prints its
            // interactive prompt (this.ready flips ~2-6s later). Previously this threw
            // "not ready" and the delegated-task delivery promise requeued the task,
            // which on win32 raced the auto-launch cooldown and could strand the worker
            // idle with no work (the "first big message lost" failure). Instead, when the
            // caller allows queueing, BUFFER the message in the pending-outbound queue and
            // return — the startup-settle path flips this.ready and flushes the queue once
            // the prompt is actually up (see resolveStartupState → flushPendingOutboundQueue),
            // so the message is delivered late rather than dropped. A non-queueable caller
            // (e.g. an internal flush) still throws so it isn't silently swallowed.
            if (allowQueue) {
                this.enqueuePendingOutboundMessage(text, 'not_ready_pending_prompt', meshTaskId);
                return { status: 'queued' };
            }
            throw new Error(`${this.cliName} not ready (status: ${this.engine.currentStatus})`);
        }
        const parsedSessionStatus = typeof parsedStatusBeforeSend?.status === 'string'
            ? String(parsedStatusBeforeSend.status)
            : '';
        if (!allowInputDuringGeneration && (parsedSessionStatus === 'generating' || parsedSessionStatus === 'no_progress' || parsedSessionStatus === 'long_generating')) {
            const parsedModal = parsedStatusBeforeSend?.activeModal ?? parsedStatusBeforeSend?.modal ?? null;
            const parsedHasActionableModal = Boolean(
                parsedModal
                && Array.isArray(parsedModal.buttons)
                && parsedModal.buttons.some((candidate: unknown) => typeof candidate === 'string' && candidate.trim()),
            );
            const terminalLooksIdle = this.engine.currentStatus === 'idle'
                && this.runDetectStatus(this.recentOutputBuffer) === 'idle'
                && !this.engine.isWaitingForResponse
                && !this.engine.currentTurnScope
                && !this.engine.hasActionableApproval()
                && !parsedHasActionableModal;
            if (!terminalLooksIdle) {
                if (allowQueue) {
                    this.enqueuePendingOutboundMessage(text, `parsed_status_${parsedSessionStatus}`, meshTaskId);
                    return { status: 'queued' };
                }
                throw new Error(`${this.cliName} is still processing the previous prompt`);
            }
        }
        if (this.engine.isWaitingForResponse && !allowInputDuringGeneration) {
            const snap = this.getSnapshot();
            if (
                !this.engine.clearStaleIdleResponseGuard('send_message_guard', snap)
                && !this.engine.clearParsedIdleResponseGuard('send_message_parsed_idle_guard', parsedStatusBeforeSend, snap)
            ) {
                if (allowQueue) {
                    this.enqueuePendingOutboundMessage(text, 'waiting_for_response', meshTaskId);
                    return { status: 'queued' };
                }
                throw new Error(`${this.cliName} is still processing the previous prompt`);
            }
        }
        this.responseBuffer = '';
        const turnScope: TurnParseScope = {
            prompt: text,
            startedAt: Date.now(),
            bufferStart: this.accumulatedBuffer.length,
            rawBufferStart: this.accumulatedRawBuffer.length,
            // ARCH-REFACTOR R1: bind this turn to its mesh task. engine.onTurnStarted
            // copies this into currentTurnTaskId so the turn's completion event carries
            // the right id even if a later task overwrites the session scalar meanwhile.
            ...(typeof meshTaskId === 'string' && meshTaskId.trim() ? { taskId: meshTaskId } : {}),
        };
        LOG.info('CLI', `[${this.cliType}] sendMessage turn scope buffer=${turnScope.bufferStart} raw=${turnScope.rawBufferStart} prompt=${JSON.stringify(text).slice(0, 120)}`);
        if (this.submitRetryTimer) {
            clearTimeout(this.submitRetryTimer);
            this.submitRetryTimer = null;
        }
        this.engine.onTurnStarted(turnScope);
        this.engine.submitRetryPromptSnippet = extractPromptRetrySnippet(text);
        const normalizedPromptSnippet = normalizePromptText(this.engine.submitRetryPromptSnippet);
        const estimatedLines = estimatePromptDisplayLines(text);
        const submitDelayMs = this.sendDelayMs + Math.min(2000, Math.max(0, estimatedLines - 1) * 350);
        const maxEchoWaitMs = submitDelayMs + Math.max(1500, Math.min(5000, estimatedLines * 500));
        const retryDelayMs = Math.max(350, Math.min(1500, Math.max(this.sendDelayMs, submitDelayMs)));
        const sendState: SendMessageState = {
            text,
            normalizedPromptSnippet,
            submitDelayMs,
            maxEchoWaitMs,
            retryDelayMs,
            didCommitUserTurn: false,
            // Capture BEFORE the send commits — commitSendUserTurn flips firstTurnSent.
            isFirstTurn: !this.firstTurnSent,
        };
        this.engine.responseSettleIgnoreUntil = Date.now() + submitDelayMs + this.timeouts.outputSettle + 250;
        await new Promise<void>((resolve, reject) => {
            let resolved = false;
            const completion: SendMessageCompletion = {
                resolveOnce: () => {
                    if (resolved) return;
                    resolved = true;
                    resolve();
                },
                rejectOnce: (error: unknown) => {
                    if (resolved) return;
                    this.resetPendingSendState('send_write_failed');
                    resolved = true;
                    reject(error);
                },
            };

            // WIN32-READY-HOLD: the very first turn after startup is the one exposed to
            // the premature-ready swallow (ready released before win32 ConPTY input is
            // live). Force it through the atomic content+sendKey single write so the
            // submit CR can never be separated from the text it submits — the same path
            // the `immediate` strategy already uses. Restricted to win32 + the first
            // turn so Mac/linux echo-gated behavior and all later turns are unchanged.
            const useAtomicFirstTurn = this.submitStrategy === 'immediate'
                || (process.platform === 'win32' && sendState.isFirstTurn);
            if (useAtomicFirstTurn) {
                this.submitImmediatePrompt(sendState, completion);
                return;
            }

            if (submitDelayMs > 0) {
                this.engine.submitPendingUntil = Date.now() + submitDelayMs;
            }
            const submitStartedAt = Date.now();
            void this.writeToPty(text).then(
                () => this.waitForEchoAndSubmit(sendState, completion, submitStartedAt),
                completion.rejectOnce,
            );
        });
        // Schedule settle after successful send
        this.engine.scheduleSettle();
        return { status: 'delivered' };
    }

    getPartialResponse(): string {
        if (!this.engine.isWaitingForResponse) return '';
        return this.responseBuffer;
    }

    getDebugSnapshot(): Record<string, unknown> {
        const screenText = this.readTerminalScreenText();
        const parsedResult = this.parsedStatusCache?.result && typeof this.parsedStatusCache.result === 'object'
            ? this.parsedStatusCache.result as Record<string, any>
            : null;
        return {
            cliType: this.cliType,
            cliName: this.cliName,
            workingDir: this.workingDir,
            currentStatus: this.engine.currentStatus,
            ready: this.ready,
            isWaitingForResponse: this.engine.isWaitingForResponse,
            activeModal: this.engine.activeModal,
            parseErrorMessage: this.parseErrorMessage,
            messageCounts: {
                parsedCache: Array.isArray(parsedResult?.messages) ? parsedResult.messages.length : undefined,
            },
            buffers: {
                accumulatedLength: this.accumulatedBuffer.length,
                accumulatedRawLength: this.accumulatedRawBuffer.length,
                recentOutputLength: this.recentOutputBuffer.length,
                responseLength: this.responseBuffer.length,
                startupLength: this.startupBuffer.length,
                accumulatedTail: this.accumulatedBuffer.slice(-24_000),
                accumulatedRawTail: this.accumulatedRawBuffer.slice(-24_000),
                recentOutputTail: this.recentOutputBuffer.slice(-12_000),
                responseTail: this.responseBuffer.slice(-12_000),
            },
            terminal: {
                screenText,
                lastScreenSnapshot: this.lastScreenSnapshot,
                lastScreenText: this.lastScreenText,
                lastOutputAt: this.lastOutputAt,
                lastNonEmptyOutputAt: this.lastNonEmptyOutputAt,
                lastScreenChangeAt: this.lastScreenChangeAt,
                lastScreenSnapshotReadAt: this.lastScreenSnapshotReadAt,
            },
            parser: {
                scriptNames: this.runner.getScriptNames(),
                traceSessionId: this.engine.getTraceSessionId(),
                traceSeq: this.engine.getTraceEntries().length,
                currentTurnScope: this.engine.currentTurnScope,
                parsedStatusCache: parsedResult
                    ? {
                        id: parsedResult.id,
                        status: parsedResult.status,
                        title: parsedResult.title,
                        providerSessionId: parsedResult.providerSessionId,
                        transcriptAuthority: parsedResult.transcriptAuthority,
                        coverage: parsedResult.coverage,
                        messageCount: Array.isArray(parsedResult.messages) ? parsedResult.messages.length : undefined,
                        activeModal: parsedResult.activeModal,
                    }
                    : null,
                pendingScriptStatus: this.engine.pendingScriptStatus,
                pendingScriptStatusSince: this.engine.pendingScriptStatusSince,
            },
            runtimeMetadata: this.getRuntimeMetadata(),
            statusHistory: this.engine.getStatusHistory().slice(-80),
            traceEntries: this.engine.getTraceEntries().slice(-120),
            timing: {
                spawnAt: this.spawnAt,
                startupFirstOutputAt: this.startupFirstOutputAt,
                submitPendingUntil: this.engine.submitPendingUntil,
                responseSettleIgnoreUntil: this.engine.responseSettleIgnoreUntil,
                responseEpoch: this.engine.responseEpoch,
                resizeSuppressUntil: this.resizeSuppressUntil,
                lastApprovalResolvedAt: this.engine.lastApprovalResolvedAt,
            },
            finish: {
                finishRetryCount: this.engine.finishRetryCount,
                submitRetryUsed: this.engine.submitRetryUsed,
                submitRetryPromptSnippet: this.engine.submitRetryPromptSnippet,
            },
        };
    }

    getRuntimeMetadata(): PtyRuntimeMetadata | null {
        if (!this.ptyProcess || typeof this.ptyProcess.getMetadata !== 'function') return null;
        return this.ptyProcess.getMetadata();
    }

    /**
     * Launch metadata for the dashboard Session info panel. Re-derives the spawn plan
     * (pure — same inputs the live PTY was spawned with) so the dashboard sees the
     * resolved binary, full arg vector, and cwd without us having to persist it.
     * extraEnv values are intentionally dropped (keys only) so secrets passed at
     * launch time never reach the dashboard.
     */
    getLaunchInfo(): CliLaunchInfo {
        let command: string | undefined;
        let args: string[] = [...this.extraArgs];
        try {
            const plan = resolveCliSpawnPlan({
                provider: this.provider,
                runtimeSettings: this.runtimeSettings,
                workingDir: this.workingDir,
                extraArgs: this.extraArgs,
                extraEnv: this.extraEnv,
            });
            command = plan.binaryPath;
            args = plan.allArgs;
        } catch {
            // Spawn plan resolution can throw before the binary is resolvable
            // (e.g. CLI not installed). Fall back to the raw extra args so the
            // panel still shows what it can rather than failing the whole call.
        }
        return {
            command,
            args,
            extraArgs: [...this.extraArgs],
            cwd: this.workingDir,
            extraEnvKeys: Object.keys(this.extraEnv || {}),
            providerSessionId: this.providerSessionId || undefined,
        };
    }

    updateRuntimeMeta(meta: Record<string, unknown>, replace = false): void {
        const nextProviderSessionId = typeof meta?.providerSessionId === 'string'
            ? meta.providerSessionId.trim()
            : '';
        if (nextProviderSessionId) {
            this.providerSessionId = nextProviderSessionId;
        }
        if (!this.ptyProcess || typeof this.ptyProcess.updateMeta !== 'function') return;
        this.ptyProcess.updateMeta(meta, replace);
    }

    cancel(): void { this.shutdown(); }

    async saveAndStop(): Promise<void> {
        if (!this.ptyProcess) return;
        const resume = this.provider.resume;
        if (!resume?.supported) {
            this.shutdown();
            return;
        }

        const stopStrategy = resume.stopStrategy || 'command';
        const stopCommand = typeof resume.stopCommand === 'string' ? resume.stopCommand.trim() : '';
        const shutdownGraceMs = Math.max(
            this.timeouts.shutdownGrace,
            typeof resume.shutdownGraceMs === 'number' ? resume.shutdownGraceMs : 3000,
        );
        const wasProcessing = this.engine.currentStatus === 'generating' || this.engine.currentStatus === 'waiting_approval';

        try {
            if (wasProcessing) {
                this.ptyProcess.write('\x03');
            }
            if (stopStrategy === 'command' && stopCommand) {
                const writeCommand = () => {
                    if (!this.ptyProcess) return;
                    const payload = stopCommand.endsWith('\r') || stopCommand.endsWith('\n')
                        ? stopCommand
                        : `${stopCommand}${this.sendKey}`;
                    this.ptyProcess.write(payload);
                };
                const interruptGraceMs = typeof resume.interruptGraceMs === 'number'
                    ? Math.max(100, resume.interruptGraceMs)
                    : 500;
                if (wasProcessing) setTimeout(writeCommand, interruptGraceMs);
                else writeCommand();
            } else {
                this.ptyProcess.write('\x03');
            }
        } catch (error: any) {
            LOG.warn('CLI', `[${this.cliType}] saveAndStop signal failed: ${error?.message || error}`);
        }

        const stopped = await this.waitForStopped(shutdownGraceMs);
        if (!stopped) {
            LOG.warn('CLI', `[${this.cliType}] graceful stop timed out, forcing shutdown`);
            this.shutdown();
            await this.waitForStopped(this.timeouts.shutdownGrace + 500);
        }
    }

    private waitForStopped(timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            const startedAt = Date.now();
            const timer = setInterval(() => {
                if (!this.ptyProcess || this.engine.currentStatus === 'stopped') {
                    clearInterval(timer);
                    resolve(true);
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, 100);
        });
    }

    shutdown(): void {
        this.engine.clearIdleFinishCandidate('shutdown');
        this.clearAllTimers();
        this.pendingOutputParseChunks = [];
        this.pendingTerminalQueryTail = '';
        this.ptyOutputChunks = [];
        if (this.pendingOutboundFlushTimer) { clearTimeout(this.pendingOutboundFlushTimer); this.pendingOutboundFlushTimer = null; }
        if (this.pendingOutboundStaleTimer) { clearTimeout(this.pendingOutboundStaleTimer); this.pendingOutboundStaleTimer = null; }
        this.pendingOutboundQueue = [];
        this.pendingOutboundFlushInFlight = false;
        if (this.ptyProcess) {
            this.ptyProcess.write('\x03');
            setTimeout(() => {
                try { this.ptyProcess?.kill(); } catch { }
                this.ptyProcess = null;
                this.engine.setStatus('stopped', 'stop_cmd');
                this.ready = false;
                this.startupParseGate = false;
                this.spawnAt = 0;
                this.onStatusChange?.();
            }, this.timeouts.shutdownGrace);
        }
    }

    detach(): void {
        this.engine.clearIdleFinishCandidate('detach');
        this.clearAllTimers();
        this.pendingOutputParseChunks = [];
        this.pendingTerminalQueryTail = '';
        this.ptyOutputChunks = [];
        if (this.pendingOutboundFlushTimer) { clearTimeout(this.pendingOutboundFlushTimer); this.pendingOutboundFlushTimer = null; }
        if (this.pendingOutboundStaleTimer) { clearTimeout(this.pendingOutboundStaleTimer); this.pendingOutboundStaleTimer = null; }
        this.pendingOutboundQueue = [];
        this.pendingOutboundFlushInFlight = false;
        if (this.ptyProcess) {
            try {
                if (typeof this.ptyProcess.detach === 'function') {
                    this.ptyProcess.detach();
                } else {
                    this.ptyProcess.kill();
                }
            } catch { /* noop */ }
            this.ptyProcess = null;
        }
        this.ready = false;
        this.startupParseGate = false;
        this.spawnAt = 0;
        this.onStatusChange?.();
    }

    clearHistory(): void {
        this.engine.clearIdleFinishCandidate('clear_history');
        this.accumulatedBuffer = '';
        this.accumulatedRawBuffer = '';
        this.engine.currentTurnScope = null;
        this.engine.submitRetryUsed = false;
        this.engine.submitRetryPromptSnippet = '';
        if (this.pendingOutputParseTimer) { clearTimeout(this.pendingOutputParseTimer); this.pendingOutputParseTimer = null; }
        this.pendingOutputParseChunks = [];
        this.pendingTerminalQueryTail = '';
        if (this.ptyOutputFlushTimer) { clearTimeout(this.ptyOutputFlushTimer); this.ptyOutputFlushTimer = null; }
        this.ptyOutputChunks = [];
        if (this.pendingOutboundFlushTimer) { clearTimeout(this.pendingOutboundFlushTimer); this.pendingOutboundFlushTimer = null; }
        this.pendingOutboundQueue = [];
        this.pendingOutboundFlushInFlight = false;
        this.resetTerminalScreen();
        this.ptyProcess?.clearBuffer?.();
        this.onStatusChange?.();
    }

    isProcessing(): boolean { return this.engine.isWaitingForResponse; }
    isReady(): boolean { return this.ready; }

    // ─── State machine property accessors (delegate to engine) ──────────────
    // These expose engine state for external callers (tests, debug tools, etc.)

    get currentStatus(): CliSessionStatus['status'] { return this.engine.currentStatus; }
    set currentStatus(v: CliSessionStatus['status']) { this.engine.setStatus(v); }

    get isWaitingForResponse(): boolean { return this.engine.isWaitingForResponse; }
    set isWaitingForResponse(v: boolean) { this.engine.isWaitingForResponse = v; }

    get activeModal(): { message: string; buttons: string[] } | null { return this.engine.activeModal; }
    set activeModal(v: { message: string; buttons: string[] } | null) { this.engine.activeModal = v; }

    get currentTurnScope(): TurnParseScope | null { return this.engine.currentTurnScope; }
    set currentTurnScope(v: TurnParseScope | null) { this.engine.currentTurnScope = v; }
    // ARCH-REFACTOR R1: the mesh taskId bound to the most recently started turn,
    // surviving past turn settle until the next turn starts. The provider instance
    // reads this when stamping completion events so they carry the completing turn's
    // task rather than the racy last-write-wins session scalar.
    get currentTurnTaskId(): string | null { return this.engine.currentTurnTaskId; }
    // R4d: wall-clock when the most recently started turn began (persists past settle).
    // The provider instance's startup-grace idle-stayed synthesis anchors its window on
    // this so a delayed-dispatch first turn whose duration overruns the now-anchored
    // window is still attributed to the startup collapse.
    get currentTurnStartedAt(): number { return this.engine.currentTurnStartedAt; }

    get responseEpoch(): number { return this.engine.responseEpoch; }
    set responseEpoch(v: number) { this.engine.responseEpoch = v; }

    get submitRetryUsed(): boolean { return this.engine.submitRetryUsed; }
    set submitRetryUsed(v: boolean) { this.engine.submitRetryUsed = v; }

    get submitRetryPromptSnippet(): string { return this.engine.submitRetryPromptSnippet; }
    set submitRetryPromptSnippet(v: string) { this.engine.submitRetryPromptSnippet = v; }

    get responseSettleIgnoreUntil(): number { return this.engine.responseSettleIgnoreUntil; }
    set responseSettleIgnoreUntil(v: number) { this.engine.responseSettleIgnoreUntil = v; }

    get submitPendingUntil(): number { return this.engine.submitPendingUntil; }
    set submitPendingUntil(v: number) { this.engine.submitPendingUntil = v; }

    get lastApprovalResolvedAt(): number { return this.engine.lastApprovalResolvedAt; }
    set lastApprovalResolvedAt(v: number) { this.engine.lastApprovalResolvedAt = v; }

    get providerErrorMessage(): string | null { return this.engine.providerErrorMessage; }
    get providerErrorReason(): string | null { return this.engine.providerErrorReason; }

    get pendingScriptStatus(): 'generating' | 'waiting_approval' | null { return this.engine.pendingScriptStatus; }
    get pendingScriptStatusSince(): number { return this.engine.pendingScriptStatusSince; }

    get finishRetryCount(): number { return this.engine.finishRetryCount; }
    set finishRetryCount(v: number) { this.engine.finishRetryCount = v; }

    get traceSessionId(): string { return this.engine.getTraceSessionId(); }
    get traceEntries(): CliTraceEntry[] { return this.engine.getTraceEntries(); }
    get statusHistory(): { status: string; at: number; trigger?: string }[] { return this.engine.getStatusHistory(); }
    get traceSeq(): number { return this.engine.getTraceEntries().length; }

    /** Expose engine's evaluateSettled for test access */
    evaluateSettled(): void {
        LOG.debug(
            'CLI',
            `[${this.cliType}] settled diagnostics delegated to state engine`);
        this.engine.evaluateSettled(this.getSnapshot());
    }
    /** Expose engine's scheduleSettle for test access */
    scheduleSettle(): void { this.engine.scheduleSettle(); }
    /** Expose engine's clearIdleFinishCandidate for test access */
    clearIdleFinishCandidate(reason: string): void { this.engine.clearIdleFinishCandidate(reason); }
    /** Expose engine's finishResponse for test access */
    finishResponse(): void { this.engine.finishResponse(); }
    /** Returns a point-in-time snapshot of all buffer/screen state for external consumers (e.g. CliStateEngine). */
    getSnapshot(): CliBufferSnapshot {
        const screenText = this.terminalScreen.getText() || '';
        return {
            accumulatedBuffer: this.accumulatedBuffer,
            accumulatedRawBuffer: this.accumulatedRawBuffer,
            recentOutputBuffer: this.recentOutputBuffer,
            responseBuffer: this.responseBuffer,
            screenText,
            parseScreenText: this.getParseScreenText(screenText),
            workingDir: this.workingDir,
            providerSessionId: this.providerSessionId,
            runtimeSettings: this.runtimeSettings,
            isWaitingForResponse: this.engine.isWaitingForResponse,
            currentTurnScope: this.engine.currentTurnScope,
            lastOutputAt: this.lastOutputAt,
            lastNonEmptyOutputAt: this.lastNonEmptyOutputAt,
            lastScreenChangeAt: this.lastScreenChangeAt,
            lastScreenSnapshot: this.lastScreenSnapshot,
        };
    }
    isAlive(): boolean { return this.ptyProcess !== null; }

    /**
     * MESH-READ-TERMINAL (feature 2: RAW terminal read). Narrow, least-privilege
     * read of the CURRENT rendered viewport for mesh_read_terminal. Deliberately
     * NARROWER than getSnapshot()/getDebugSnapshot():
     *  - It returns ONLY the terminal's current rendered viewport (what a human
     *    would see on screen right now), the cursor position and the viewport
     *    size. NO debug buffers, NO parser/FSM state, NO scrollback/history.
     *  - It does NOT call getParseScreenText() (which may graft an older snapshot
     *    onto the current frame for parse accuracy) — the caller asked for the
     *    live viewport, not a parse-optimized composite.
     *  - The payload is bounded in BYTES (UTF-8) with bottom-tail preservation so
     *    a screen of multi-byte glyphs can never exceed the MCP payload cap. See
     *    truncateToByteTailByLine.
     *
     * SECURITY NOTE: the raw viewport can contain tokens / command args / env
     * values / user data. Callers MUST gate this on mesh ownership and MUST NOT
     * log the returned text. Opt-in redaction is intentionally out of scope for
     * this feature and left as a future enhancement.
     *
     * `maxBytes` is clamped to [1KiB, ABSOLUTE_MAX] (default 32KiB, hard cap 64KiB).
     */
    getTerminalScreenSnapshot(maxBytes = ProviderCliAdapter.TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES): {
        text: string;
        cursor: { col: number; row: number };
        cols: number;
        rows: number;
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        hash: string;
    } {
        const cap = Math.min(
            ProviderCliAdapter.TERMINAL_SNAPSHOT_ABSOLUTE_MAX_BYTES,
            Math.max(1024, Math.floor(maxBytes) || ProviderCliAdapter.TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES),
        );
        // Current rendered viewport only — no scrollback, no parse composite.
        const rawViewport = this.terminalScreen.getText() || '';
        const size = this.terminalScreen.getSize();
        const cursor = this.terminalScreen.getCursorPosition();
        const truncation = truncateToByteTailByLine(rawViewport, cap);
        const hash = createHash('sha256').update(rawViewport, 'utf8').digest('hex').slice(0, 16);
        return {
            text: truncation.text,
            cursor,
            cols: size.cols,
            rows: size.rows,
            truncated: truncation.truncated,
            originalBytes: truncation.originalBytes,
            returnedBytes: truncation.returnedBytes,
            hash,
        };
    }

    /**
     * MESH-SEND-KEYS (feature 3: key injection). Inject a STRUCTURED key sequence
     * into the PTY for the mesh_send_keys tool. Reuses the same serialized write
     * path as sends (writeToPty via writeRaw semantics) so the injection FIFO-
     * orders behind any in-flight write.
     *
     * Two guards run INSIDE this method, immediately before the write, so they see
     * a consistent snapshot of the adapter's submit/echo/queue state (no async gap
     * between check and write — the encode is synchronous and the write is chained
     * atomically after it):
     *
     *  1. submit-race recheck (echo-gate): even though writeToPty is FIFO, an
     *     already-SCHEDULED echo-gated Enter (engine.submitPendingUntil in the
     *     future), an armed stuck-submit retry (submitRetryTimer), or an in-flight
     *     pending-outbound flush can submit at a DIFFERENT tick than our write —
     *     so an injected literal could be submitted by a pending Enter, or our
     *     ENTER could submit a half-typed pending body. When any of those is live
     *     we REFUSE the injection rather than interleave.
     *
     *  2. modal fail-closed: if the session is parked on an actionable approval
     *     modal, refuse a NON-destructive injection (ENTER/text/arrows) and direct
     *     the caller to mesh_approve — so a modal choice can't be confirmed via
     *     send_keys to bypass the approval policy. (A destructive ESC/CTRL_C, which
     *     dismisses rather than confirms, is allowed to proceed past this gate; it
     *     is separately gated by confirm_destructive + policy at the tool layer.)
     *
     * The caller (tool layer) owns the destructive-key double gate and the audit
     * ledger. This method NEVER logs the literal text (only key enums / byte len).
     */
    async injectKeys(
        items: MeshSendKeyItem[],
        opts: { allowModalOverride?: boolean } = {},
    ): Promise<
        | { ok: true; keys: MeshSendKeyName[]; hasDestructive: boolean; submits: boolean; bytes: number }
        | { ok: false; refused: 'submit_race' | 'actionable_modal'; keys: MeshSendKeyName[]; hasDestructive: boolean }
    > {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        const encoded = encodeMeshSendKeys(items);

        // (1) submit-race recheck — atomic w.r.t. the write below (no await between).
        const now = Date.now();
        const submitPending = this.engine.submitPendingUntil > now;
        const submitRetryArmed = this.submitRetryTimer !== null;
        const outboundBusy = this.pendingOutboundFlushInFlight || this.pendingOutboundQueue.length > 0;
        if (submitPending || submitRetryArmed || outboundBusy) {
            LOG.warn('CLI', `[${this.cliType}] send_keys refused (submit_race): submitPending=${submitPending} submitRetry=${submitRetryArmed} outboundBusy=${outboundBusy} keys=${encoded.keys.join(',')}`);
            return { ok: false, refused: 'submit_race', keys: encoded.keys, hasDestructive: encoded.hasDestructive };
        }

        // (2) modal fail-closed — a NON-destructive injection into an actionable
        //     modal is refused unless explicitly overridden.
        const modalActive = this.engine.hasActionableApproval();
        if (modalActive && !encoded.hasDestructive && !opts.allowModalOverride) {
            LOG.warn('CLI', `[${this.cliType}] send_keys refused (actionable_modal): keys=${encoded.keys.join(',')} — use mesh_approve`);
            return { ok: false, refused: 'actionable_modal', keys: encoded.keys, hasDestructive: encoded.hasDestructive };
        }

        // Atomic write: the full encoded sequence goes out in ONE writeToPty (which
        // chains onto the write FIFO). text+ENTER is already one contiguous string,
        // so the submit key can never be separated from the text it submits.
        await this.writeToPty(encoded.sequence);
        LOG.info('CLI', `[${this.cliType}] send_keys injected keys=${encoded.keys.join(',') || '(text-only)'} bytes=${Buffer.byteLength(encoded.sequence, 'utf8')} destructive=${encoded.hasDestructive}`);
        return {
            ok: true,
            keys: encoded.keys,
            hasDestructive: encoded.hasDestructive,
            submits: encoded.submits,
            bytes: Buffer.byteLength(encoded.sequence, 'utf8'),
        };
    }

    flushOutboundQueue(): void { this.schedulePendingOutboundFlush(); }

    async writeRaw(data: string | Buffer): Promise<void> {
        const str = Buffer.isBuffer(data) ? data.toString('utf8') : data;
        await this.writeToPty(str);
    }

    resolveModal(buttonIndex: number): void {
        this.engine.resolveModal(buttonIndex);
    }

    getApprovalKeyForIndex(buttonIndex: number): string | undefined {
        return buttonIndex in this.approvalKeys ? this.approvalKeys[buttonIndex] : undefined;
    }

    /** Returns true if an approval was resolved within the adapter's cooldown window. */
    isApprovalRecentlyResolved(): boolean {
        return this.engine.isApprovalRecentlyResolved();
    }

    resize(cols: number, rows: number): void {
        if (this.ptyProcess) {
            try {
                this.ptyProcess.resize(cols, rows);
                this.terminalScreen.resize(rows, cols);
                this.resizeSuppressUntil = Date.now() + 300;
            } catch { }
        }
    }

    private getParsedDebugState(): Record<string, any> | null {
        if (this.startupParseGate || !this.runner.hasParseSession()) return null;
        try {
            const parsed = this.getScriptParsedStatus();
            return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
        } catch {
            return null;
        }
    }

    getDebugState(): Record<string, any> {
        const screenText = sanitizeTerminalText(this.terminalScreen.getText());
        let startupModal = this.startupParseGate ? this.runParseApproval(this.recentOutputBuffer) : null;
        // (fix: kimi startup-gate stale-approval bypass) See the matching
        // comment in getStatus() — this ad-hoc startup-gate parse bypassed
        // engine.activeModal's staleness protection entirely. Reuse the same
        // engine-owned discriminator rather than duplicating it here.
        if (startupModal && this.engine.isStaleResolvedApproval(startupModal, { screenText: this.terminalScreen.getText(), accumulatedBuffer: this.accumulatedBuffer })) {
            startupModal = null;
        }
        const startupDetectedStatus = this.startupParseGate && !startupModal
            ? this.runDetectStatus(this.recentOutputBuffer || screenText)
            : null;
        const effectiveReady = this.ready || !!startupModal || startupDetectedStatus === 'waiting_approval';
        const parsedDebugState = this.getParsedDebugState();
        const parsedMessages = Array.isArray(parsedDebugState?.messages) ? parsedDebugState.messages : [];
        const hasFinalAssistant = (p: any) => {
            const msgs = Array.isArray(p?.messages) ? p.messages : [];
            return msgs.some((m: any) => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
        };
        let effectiveStatus = this.projectEffectiveStatus(startupModal);
        if (parsedDebugState?.status === 'error') {
            effectiveStatus = 'error';
        }
        // (fix) Mirror the getStatus contract: never surface waiting_approval
        // without a concrete modal. detectStatus alone can fire while
        // parseApproval is still null, and a bare debugState waiting_approval
        // confused dashboards reading the debug payload.
        const debugEffectiveModal = startupModal || this.engine.activeModal;
        if (startupDetectedStatus === 'waiting_approval' && debugEffectiveModal) {
            effectiveStatus = 'waiting_approval';
        }
        if (
            effectiveStatus === 'idle'
            && parsedDebugState?.status === 'generating'
            && !hasFinalAssistant(parsedDebugState)
        ) {
            effectiveStatus = 'generating';
        }
        return {
            type: this.cliType,
            name: this.cliName,
            providerResolution: this.providerResolutionMeta,
            status: effectiveStatus,
            projectedStatus: effectiveStatus,
            rawStatus: this.engine.currentStatus,
            lifecycleStatus: this.engine.isWaitingForResponse ? 'awaiting_response' : 'idle',
            ready: effectiveReady,
            startupParseGate: this.startupParseGate,
            spawnAt: this.spawnAt,
            workingDir: this.workingDir,
            messages: parsedMessages,
            messageCount: parsedMessages.length,
            parsedStatus: parsedDebugState ? {
                id: parsedDebugState.id,
                status: parsedDebugState.status,
                title: parsedDebugState.title,
                providerSessionId: parsedDebugState.providerSessionId,
                transcriptAuthority: parsedDebugState.transcriptAuthority,
                coverage: parsedDebugState.coverage,
                errorMessage: parsedDebugState.errorMessage,
                errorReason: parsedDebugState.errorReason,
                activeModal: parsedDebugState.activeModal,
                messageCount: parsedMessages.length,
            } : null,
            screenText: screenText.slice(-4000),
            currentTurnScope: this.engine.currentTurnScope,
            startupBuffer: this.startupBuffer.slice(-4000),
            recentOutputBuffer: this.recentOutputBuffer.slice(-500),
            accumulatedBufferLength: this.accumulatedBuffer.length,
            accumulatedRawBufferLength: this.accumulatedRawBuffer.length,
            rawBufferPreview: this.accumulatedRawBuffer.slice(-1000),
            sanitizedRawPreview: sanitizeTerminalText(this.accumulatedRawBuffer).slice(-1000),
            responseBuffer: this.responseBuffer.slice(-1000),
            pendingOutboundQueue: this.pendingOutboundQueue.map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                queuedAt: message.queuedAt,
                source: message.source,
            })),
            pendingOutboundCount: this.pendingOutboundQueue.length,
            lastOutputAt: this.lastOutputAt,
            lastNonEmptyOutputAt: this.lastNonEmptyOutputAt,
            lastScreenChangeAt: this.lastScreenChangeAt,
            lastScreenSnapshot: this.lastScreenSnapshot.slice(-500),
            isWaitingForResponse: this.engine.isWaitingForResponse,
            activeModal: startupModal || this.engine.activeModal,
            lastApprovalResolvedAt: this.engine.lastApprovalResolvedAt,
            sendDelayMs: this.sendDelayMs,
            sendKey: this.sendKey,
            submitStrategy: this.submitStrategy,
            requirePromptEchoBeforeSubmit: this.requirePromptEchoBeforeSubmit,
            submitPendingUntil: this.engine.submitPendingUntil,
            responseSettleIgnoreUntil: this.engine.responseSettleIgnoreUntil,
            resizeSuppressUntil: this.resizeSuppressUntil,
            hasCliScripts: this.hasCliScripts(),
            scriptNames: this.runner.getScriptNames(),
            traceSessionId: this.engine.getTraceSessionId(),
            traceEntryCount: this.engine.getTraceEntries().length,
            statusHistory: this.engine.getStatusHistory().slice(-30),
            timeouts: this.timeouts,
            pendingOutputParseBufferLength: this.pendingOutputParseChunks.reduce((total, chunk) => total + chunk.length, 0),
            pendingOutputParseScheduled: !!this.pendingOutputParseTimer,
            ptyAlive: !!this.ptyProcess,
        };
    }

    getTraceState(limit = 120): Record<string, any> {
        const cappedLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 120));
        const traceEntries = this.engine.getTraceEntries();
        return {
            sessionId: this.engine.getTraceSessionId(),
            providerResolution: this.providerResolutionMeta,
            entryCount: traceEntries.length,
            entries: traceEntries.slice(-cappedLimit),
            screenText: summarizeCliTraceText(this.terminalScreen.getText(), 4000),
            recentOutputBuffer: summarizeCliTraceText(this.recentOutputBuffer, 1000),
            responseBuffer: summarizeCliTraceText(this.responseBuffer, 1200),
            status: this.projectEffectiveStatus(),
            projectedStatus: this.projectEffectiveStatus(),
            rawStatus: this.engine.currentStatus,
            lifecycleStatus: this.engine.isWaitingForResponse ? 'awaiting_response' : 'idle',
            activeModal: this.engine.activeModal,
            currentTurnScope: this.engine.currentTurnScope,
            messages: [],
        };
    }

    getProviderResolutionMeta(): ProviderResolutionMeta {
        return { ...this.providerResolutionMeta };
    }
}
