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
import type { CliAdapter } from '../cli-adapter-types.js';
import { LOG } from '../logging/logger.js';
import { getDebugRuntimeConfig } from '../logging/debug-config.js';
import { TerminalScreen } from './terminal-screen.js';
import {
    NodePtyTransportFactory,
    type PtyRuntimeMetadata,
    type PtyRuntimeTransport,
    type PtyTransportFactory,
} from './pty-transport.js';
import {
    buildCliScreenSnapshot,
    compactPromptText,
    estimatePromptDisplayLines,
    extractPromptRetrySnippet,
    listCliScriptNames,
    normalizePromptText,
    normalizeScreenSnapshot,
    promptLikelyVisible,
    sanitizeTerminalText,
    TerminalTranscriptAccumulator,
    type CliChatMessage,
    type CliProviderModule,
    type CliScriptInput,
    type CliScripts,
    type CliSessionStatus,
    type CliTraceEntry,
    type ParsedSession,
} from './provider-cli-shared.js';
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


interface IdleFinishCandidate {
    armedAt: number;
    lastOutputAt: number;
    lastScreenChangeAt: number;
    responseEpoch: number;
    assistantLength: number;
}

interface SettledEvalContext {
    now: number;
    modal: any;
    status: string;
    parsedMessages: CliChatMessage[];
    lastParsedAssistant: CliChatMessage | undefined;
    parsedStatus: string | null;
    prevStatus: string;
}

interface SendMessageState {
    text: string;
    normalizedPromptSnippet: string;
    submitDelayMs: number;
    maxEchoWaitMs: number;
    retryDelayMs: number;
    didCommitUserTurn: boolean;
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
}

export function appendBoundedText(current: string, chunk: string, maxChars: number): string {
    if (!chunk) return current.length <= maxChars ? current : current.slice(-maxChars);
    if (maxChars <= 0) return '';
    if (chunk.length >= maxChars) return chunk.slice(-maxChars);
    const keepFromCurrent = maxChars - chunk.length;
    if (current.length <= keepFromCurrent) return current + chunk;
    return current.slice(-keepFromCurrent) + chunk;
}

// ─── Adapter ────────────────────────────────────────

export class ProviderCliAdapter implements CliAdapter {
    readonly cliType: string;
    readonly cliName: string;
    public workingDir: string;

    private provider: CliProviderModule;
    private ptyProcess: PtyRuntimeTransport | null = null;
    private transportFactory: PtyTransportFactory;
    private currentStatus: CliSessionStatus['status'] = 'starting';
    private onStatusChange: (() => void) | null = null;

    private responseBuffer = '';
    private recentOutputBuffer = '';
    private isWaitingForResponse = false;
    private activeModal: { message: string; buttons: string[] } | null = null;
    private parseErrorMessage: string | null = null;
    private providerSessionId: string | null = null;
    private providerErrorMessage: string | null = null;
    private providerErrorReason: string | null = null;
    private responseTimeout: NodeJS.Timeout | null = null;
    private idleTimeout: NodeJS.Timeout | null = null;
    private ready = false;
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

 // Server log forwarding
    private serverConn: any = null;
    private logBuffer: { message: string; level: string }[] = [];

 // Approval cooldown
    private lastApprovalResolvedAt: number = 0;

 // Approval state machine
    private approvalTransitionBuffer: string = '';
    private approvalExitTimeout: NodeJS.Timeout | null = null;
    private pendingScriptStatus: 'generating' | 'waiting_approval' | null = null;
    private pendingScriptStatusSince = 0;
    private pendingScriptStatusTimer: NodeJS.Timeout | null = null;

 // Output settle debounce — fires after PTY output goes quiet
    private settleTimer: NodeJS.Timeout | null = null;
    private settledBuffer: string = '';
    private submitPendingUntil = 0;
    private responseSettleIgnoreUntil = 0;
    private responseEpoch = 0;
    private submitRetryTimer: NodeJS.Timeout | null = null;
    private submitRetryUsed = false;
    private submitRetryPromptSnippet = '';
    private idleFinishCandidate: IdleFinishCandidate | null = null;
    private finishRetryTimer: NodeJS.Timeout | null = null;
    private finishRetryCount = 0;
    private pendingOutboundQueue: PendingOutboundMessage[] = [];
    private pendingOutboundFlushTimer: NodeJS.Timeout | null = null;
    private pendingOutboundFlushInFlight = false;
    private providerErrorRetryTimer: NodeJS.Timeout | null = null;
    private providerErrorRetryKey = '';

 // Resize redraw suppression
    private resizeSuppressUntil: number = 0;

 // Debug: status transition history
    private statusHistory: { status: string; at: number; trigger?: string }[] = [];

    // ─── CLI Scripts (script-based parsing) ───
    private cliScripts: CliScripts;
    /** Per-session opaque state object created by cliScripts.createState(), reset on stop. */
    private scriptState: unknown = null;
    private runtimeSettings: Record<string, any> = {};
    /** Full accumulated rendered PTY transcript for parser/readback use */
    private accumulatedBuffer: string = '';
    /** Stateful rendered transcript accumulator; raw debug remains in accumulatedRawBuffer. */
    private transcriptAccumulator = new TerminalTranscriptAccumulator();
    /** Full accumulated raw PTY output (with ANSI) */
    private accumulatedRawBuffer: string = '';
    /** Current visible terminal screen snapshot */
    private terminalScreen = new TerminalScreen(24, 80);
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
    private currentTurnScope: TurnParseScope | null = null;
    private traceEntries: CliTraceEntry[] = [];
    private traceSeq = 0;
    private traceSessionId = '';
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
    private static readonly MAX_TRACE_ENTRIES = 250;

    private readonly providerResolutionMeta: ProviderResolutionMeta;
    private static readonly FINISH_RETRY_DELAY_MS = 300;
    private static readonly MAX_FINISH_RETRIES = 2;

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
            && cached.currentTurnScope === this.currentTurnScope
            && cached.recentOutputBuffer === this.recentOutputBuffer
            && cached.accumulatedBuffer === this.accumulatedBuffer
            && cached.accumulatedRawBufferKey === accumulatedRawBufferKey
            && cached.screenText === this.lastScreenText
            && cached.currentStatus === this.currentStatus
            && cached.activeModal === this.activeModal
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

    private getIdleFinishConfirmMs(): number {
        return this.timeouts.idleFinishConfirm;
    }

    private getStatusActivityHoldMs(): number {
        return this.timeouts.statusActivityHold;
    }

    private setStatus(status: CliSessionStatus['status'], trigger?: string): void {
        const prev = this.currentStatus;
        if (prev === status) return;
        this.currentStatus = status;
        this.statusHistory.push({ status, at: Date.now(), trigger });
        if (this.statusHistory.length > 50) this.statusHistory.shift();
        this.recordTrace('status', {
            previousStatus: prev,
            trigger: trigger || null,
        });
        LOG.info('CLI', `[${this.cliType}] status: ${prev} → ${status}${trigger ? ` (${trigger})` : ''}`);
    }

    private clearIdleFinishCandidate(reason: string): void {
        if (!this.idleFinishCandidate) return;
        this.recordTrace('idle_candidate_reset', {
            reason,
            candidate: this.idleFinishCandidate,
        });
        this.idleFinishCandidate = null;
    }

    private armIdleFinishCandidate(assistantLength: number): void {
        const now = Date.now();
        const idleFinishConfirmMs = this.getIdleFinishConfirmMs();
        this.idleFinishCandidate = {
            armedAt: now,
            lastOutputAt: this.lastOutputAt,
            lastScreenChangeAt: this.lastScreenChangeAt,
            responseEpoch: this.responseEpoch,
            assistantLength,
        };
        this.recordTrace('idle_candidate_armed', {
            confirmMs: idleFinishConfirmMs,
            candidate: this.idleFinishCandidate,
            ...buildCliTraceParseSnapshot({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                responseBuffer: this.responseBuffer,
                partialResponse: this.responseBuffer,
                scope: this.currentTurnScope,
            }),
        });
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            this.settledBuffer = this.recentOutputBuffer;
            this.evaluateSettled();
        }, idleFinishConfirmMs);
    }


    private recordTrace(type: string, payload: Record<string, any> = {}): void {
        const entry: CliTraceEntry = {
            id: ++this.traceSeq,
            at: Date.now(),
            type,
            status: this.currentStatus,
            isWaitingForResponse: this.isWaitingForResponse,
            activeModal: this.activeModal
                ? { message: this.activeModal.message, buttons: [...this.activeModal.buttons] }
                : null,
            payload,
        };
        this.traceEntries.push(entry);
        if (this.traceEntries.length > ProviderCliAdapter.MAX_TRACE_ENTRIES) {
            this.traceEntries.splice(0, this.traceEntries.length - ProviderCliAdapter.MAX_TRACE_ENTRIES);
        }
    }

    private resetTraceSession(): void {
        this.traceEntries = [];
        this.traceSeq = 0;
        this.traceSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        this.recordTrace('session_start', {
            providerType: this.cliType,
            workingDir: this.workingDir,
        });
    }

 // Resolved timeouts
    private readonly timeouts: Required<NonNullable<CliProviderModule['timeouts']>>;

 // Provider approval key mapping
    private readonly approvalKeys: Record<number, string>;
    private readonly sendDelayMs: number;
    private readonly sendKey: string;
    private readonly submitStrategy: 'wait_for_echo' | 'immediate';
    private readonly requirePromptEchoBeforeSubmit: boolean;
    private static readonly SCRIPT_STATUS_DEBOUNCE_MS = 3000;

    constructor(
        provider: CliProviderModule,
        workingDir: string,
        private extraArgs: string[] = [],
        private extraEnv: Record<string, string> = {},
        transportFactory: PtyTransportFactory = new NodePtyTransportFactory(),
    ) {
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

        // Scripts are required — loaded by ProviderLoader via compatibility array
        this.cliScripts = provider.scripts || {};
        this.scriptState = typeof this.cliScripts.createState === 'function' ? (this.cliScripts.createState() ?? null) : null;
        const scriptNames = listCliScriptNames(this.cliScripts);
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
        this.cliScripts = scripts;
        this.parsedStatusCache = null;
        this.parseErrorMessage = null;
        // Initialize per-session state: createState() is called once here and on script reload.
        // The returned object lives until the PTY exits (scriptState = null on exit).
        this.scriptState = typeof scripts.createState === 'function' ? (scripts.createState() ?? null) : null;
        const scriptNames = listCliScriptNames(scripts);
        LOG.info('CLI', `[${this.cliType}] CLI scripts injected: [${scriptNames.join(', ')}]`);
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
        this.resetTraceSession();
        this.recordTrace('spawn', {
            shellCommand: spawnPlan.shellCmd,
            shellArgs: spawnPlan.shellArgs,
            cwd: spawnPlan.ptyOptions.cwd,
            cols: spawnPlan.ptyOptions.cols,
            rows: spawnPlan.ptyOptions.rows,
            providerResolution: this.providerResolutionMeta,
        });

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

        this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
            LOG.info('CLI', `[${this.cliType}] Exit code ${exitCode}`);
            this.flushPendingOutputParse();
            this.recordTrace('exit', { exitCode });
            this.ptyProcess = null;
            this.setStatus('stopped', 'pty_exit');
            this.ready = false;
            this.startupParseGate = false;
            this.spawnAt = 0;
            this.scriptState = null;
            this.onStatusChange?.();
        });

        this.spawnAt = Date.now();
        this.startupParseGate = true;
        this.startupBuffer = '';
        this.startupFirstOutputAt = 0;
        if (this.startupSettleTimer) { clearTimeout(this.startupSettleTimer); this.startupSettleTimer = null; }
        this.resetTerminalScreen(24, 80);
        this.pendingTerminalQueryTail = '';
        this.currentTurnScope = null;
        this.finishRetryCount = 0;
        if (this.finishRetryTimer) { clearTimeout(this.finishRetryTimer); this.finishRetryTimer = null; }
        this.ready = false;
        await this.ptyProcess.ready;
        this.recordTrace('ready', {
            runtimeMeta: this.getRuntimeMetadata(),
        });
        this.setStatus('starting', 'pty_ready');
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
        if (this.idleFinishCandidate && (rawData.length > 0 || cleanData.length > 0)) {
            this.clearIdleFinishCandidate('new_output');
        }
        if (getDebugRuntimeConfig().collectDebugTrace) {
            this.recordTrace('output', {
                rawLength: rawData.length,
                cleanLength: cleanData.length,
                rawPreview: summarizeCliTraceText(rawData, 300),
                cleanPreview: summarizeCliTraceText(cleanData, 300),
            });
        }

        if (this.startupParseGate) {
            this.scheduleStartupSettleCheck();
        }

        if (this.isWaitingForResponse && cleanData) {
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
        if (this.currentTurnScope) {
            if (droppedClean > 0) {
                this.currentTurnScope.bufferStart = Math.max(0, this.currentTurnScope.bufferStart - droppedClean);
            }
            if (droppedRaw > 0) {
                this.currentTurnScope.rawBufferStart = Math.max(0, this.currentTurnScope.rawBufferStart - droppedRaw);
            }
        }

        this.resolveStartupState('output', screenText, normalizedScreenSnapshot, now);

        // ─── Script-based status detection
        this.scheduleSettle();
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
        const startupStatus = this.runDetectStatus(screenText || this.recentOutputBuffer);
        if (!startupModal && startupStatus !== 'idle') {
            this.recordTrace('startup_settle_deferred', {
                trigger,
                startupStatus,
                stableMs,
                screenText: summarizeCliTraceText(screenText, 500),
            });
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
            this.activeModal = startupModal;
            this.setStatus('waiting_approval', `startup_ready:${trigger}`);
        } else {
            if (this.currentStatus === 'waiting_approval' || this.activeModal) {
                this.lastApprovalResolvedAt = Date.now();
            }
            this.activeModal = null;
            this.setStatus('idle', `startup_ready:${trigger}`);
        }
        LOG.info(
            'CLI',
            `[${this.cliType}] Startup settled (${trigger}, stableMs=${stableMs}, modal=${!!startupModal}) providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'}`
        );
        this.onStatusChange?.();
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

    private scheduleSettle(): void {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        const settleEpoch = this.responseEpoch;
        const delay = Math.max(
            this.timeouts.outputSettle,
            this.submitPendingUntil > Date.now()
                ? (this.submitPendingUntil - Date.now()) + this.timeouts.outputSettle
                : 0,
        );
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            if (settleEpoch !== this.responseEpoch) return;
            this.settledBuffer = this.recentOutputBuffer;
            this.evaluateSettled();
        }, delay);
    }

    private armApprovalExitTimeout(): void {
        if (this.approvalExitTimeout) clearTimeout(this.approvalExitTimeout);
        this.approvalExitTimeout = setTimeout(() => {
            if (!this.hasActionableApproval()) return;
            const tail = this.recentOutputBuffer;
            const screenText = this.terminalScreen.getText() || '';
            const modal = this.runParseApproval(tail);
            const stillWaiting = this.runDetectStatus(tail) === 'waiting_approval' || !!modal;
            if (stillWaiting) {
                if (!modal) {
                    LOG.warn('CLI', `[${this.cliType}] approval timeout check found no actionable modal; keeping approval state fail-closed`);
                    this.activeModal = null;
                    this.onStatusChange?.();
                    this.armApprovalExitTimeout();
                    return;
                }
                this.activeModal = modal;
                this.onStatusChange?.();
                this.armApprovalExitTimeout();
                return;
            }
            LOG.warn('CLI', `[${this.cliType}] Approval timeout — auto-clearing`);
            this.activeModal = null;
            this.lastApprovalResolvedAt = Date.now();
            this.setStatus('idle', 'approval_timeout');
            this.onStatusChange?.();
        }, 60000);
    }

    private shouldRetryFinishResponse(commitResult: { hasAssistant: boolean; assistantContent: string }): boolean {
        if (!this.currentTurnScope) return false;
        if (this.hasActionableApproval()) return false;
        if (this.finishRetryCount >= ProviderCliAdapter.MAX_FINISH_RETRIES) return false;
        if (commitResult.hasAssistant && commitResult.assistantContent.trim()) return false;

        if (this.runDetectStatus(this.recentOutputBuffer) !== 'idle') return false;

        const now = Date.now();
        const quietForMs = this.lastNonEmptyOutputAt ? (now - this.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
        const screenStableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : 0;
        return quietForMs < 1200 || screenStableMs < 1200 || !commitResult.hasAssistant;
    }

    private hasRecentInteractiveActivity(now: number): boolean {
        const quietForMs = this.lastNonEmptyOutputAt ? (now - this.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
        const screenStableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : Number.MAX_SAFE_INTEGER;
        const holdMs = this.getStatusActivityHoldMs();
        return quietForMs < holdMs
            || screenStableMs < holdMs;
    }

    private shouldDeferIdleTimeoutFinish(): boolean {
        if (!this.isWaitingForResponse || this.hasActionableApproval()) {
            return false;
        }
        const latestStatus = this.runDetectStatus(this.recentOutputBuffer) || this.currentStatus;
        if (latestStatus === 'generating') {
            this.settledBuffer = this.recentOutputBuffer;
            this.evaluateSettled();
            return true;
        }
        return false;
    }


    private async waitForInteractivePrompt(maxWaitMs = 5000): Promise<void> {
        const startedAt = Date.now();
        let loggedWait = false;

        while (Date.now() - startedAt < maxWaitMs) {
            this.resolveStartupState('interactive_wait');
            const screenText = this.terminalScreen.getText() || '';
            const stableMs = this.lastScreenChangeAt ? (Date.now() - this.lastScreenChangeAt) : 0;
            const recentlyOutput = this.lastNonEmptyOutputAt ? (Date.now() - this.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
            const status = this.runDetectStatus(this.recentOutputBuffer) || this.currentStatus;
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
        if (this.idleTimeout) { clearTimeout(this.idleTimeout); this.idleTimeout = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        if (this.submitRetryTimer) { clearTimeout(this.submitRetryTimer); this.submitRetryTimer = null; }
        if (this.finishRetryTimer) { clearTimeout(this.finishRetryTimer); this.finishRetryTimer = null; }
        if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
        if (this.pendingScriptStatusTimer) { clearTimeout(this.pendingScriptStatusTimer); this.pendingScriptStatusTimer = null; }
        if (this.pendingOutputParseTimer) { clearTimeout(this.pendingOutputParseTimer); this.pendingOutputParseTimer = null; }
        if (this.ptyOutputFlushTimer) { clearTimeout(this.ptyOutputFlushTimer); this.ptyOutputFlushTimer = null; }
        if (this.providerErrorRetryTimer) { clearTimeout(this.providerErrorRetryTimer); this.providerErrorRetryTimer = null; }
        this.providerErrorRetryKey = '';
    }

    private clearStaleIdleResponseGuard(reason: string): boolean {
        const blockingModal = this.activeModal || this.runParseApproval(this.recentOutputBuffer);
        const isIdle = this.runDetectStatus(this.recentOutputBuffer) === 'idle';
        if (!this.isWaitingForResponse || this.currentStatus !== 'idle' || !isIdle || !!blockingModal) {
            return false;
        }
        this.clearAllTimers();
        this.clearIdleFinishCandidate(reason);
        this.responseBuffer = '';
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.recordTrace('stale_idle_response_cleared', { reason });
        return true;
    }

    private clearParsedIdleResponseGuard(reason: string, parsedStatus: any): boolean {
        const parsedRawStatus = typeof parsedStatus?.status === 'string' ? parsedStatus.status.trim() : '';
        const parsedModal = parsedStatus?.activeModal ?? parsedStatus?.modal ?? null;
        const blockingModal = this.activeModal || this.runParseApproval(this.recentOutputBuffer);
        if (
            !this.isWaitingForResponse
            || parsedRawStatus !== 'idle'
            || !!parsedModal
            || !!blockingModal
            || !this.parsedStatusHasFinalAssistantMessage(parsedStatus)
        ) {
            return false;
        }
        this.clearAllTimers();
        this.clearIdleFinishCandidate(reason);
        this.responseBuffer = '';
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.setStatus('idle', reason);
        this.recordTrace('parsed_idle_response_cleared', {
            reason,
            parsedStatus: parsedRawStatus,
            parsedMessageCount: Array.isArray(parsedStatus?.messages) ? parsedStatus.messages.length : 0,
        });
        return true;
    }

    private hasMeaningfulResponseBuffer(promptSnippet: string): boolean {
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

    private evaluateSettled(): void {
        const now = Date.now();
        if (this.submitPendingUntil > now || this.responseSettleIgnoreUntil > now) {
            const delayTime = Math.max(this.submitPendingUntil - now, this.responseSettleIgnoreUntil - now) + 50;
            if (this.settleTimer) clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                this.settledBuffer = this.recentOutputBuffer;
                this.evaluateSettled();
            }, delayTime);
            return;
        }

        this.resolveStartupState('settled');
        if (this.startupParseGate) return;

        if (!this.isWaitingForResponse && !this.currentTurnScope && !this.activeModal && !this.parseErrorMessage) {
            const tail = this.settledBuffer || this.recentOutputBuffer;
            const modal = this.runParseApproval(tail);
            const lightweightStatus = this.cliScripts?.detectStatus
                ? this.runDetectStatus(tail)
                : null;
            if (!modal && lightweightStatus === 'idle' && this.currentStatus === 'idle') {
                return;
            }
        }

        const session = this.runParseSession();
        if (!session) return;

        const { status, messages, parsedStatus } = session;
        const modal = (session as any).activeModal ?? session.modal ?? null;
        const parsedMessages = normalizeCliParsedMessages(messages, {
            scope: null,
            lastOutputAt: this.lastOutputAt,
        });

        if (this.maybeCommitVisibleIdleTranscript(session, parsedMessages)) return;

        const lastParsedAssistant = [...parsedMessages].reverse().find((m) => m.role === 'assistant');
        const normalizedPromptSnippet = normalizePromptText(this.submitRetryPromptSnippet || this.currentTurnScope?.prompt || '');
        const screenText = this.terminalScreen.getText() || '';

        this.recordTrace('settled', {
            tail: summarizeCliTraceText(this.settledBuffer, 500),
            screenText: summarizeCliTraceText(screenText, 1200),
            detectStatus: status,
            parsedStatus: parsedStatus || null,
            parsedMessageCount: parsedMessages.length,
            parsedLastAssistant: lastParsedAssistant ? summarizeCliTraceText(lastParsedAssistant.content, 280) : '',
            parsedActiveModal: modal,
            approval: modal,
            ...buildCliTraceParseSnapshot({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                responseBuffer: this.responseBuffer,
                partialResponse: this.responseBuffer,
                scope: this.currentTurnScope,
            }),
        });

        if (
            this.currentTurnScope
            && !lastParsedAssistant
            && !this.submitRetryUsed
            && this.ptyProcess
            && !this.hasActionableApproval()
            && promptLikelyVisible(screenText, normalizedPromptSnippet)
            && !this.hasMeaningfulResponseBuffer(normalizedPromptSnippet)
        ) {
            this.submitRetryUsed = true;
            this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
            LOG.info('CLI', `[${this.cliType}] Retrying submit key from settled parser (no assistant yet)`);
            this.recordTrace('submit_write', {
                mode: 'settled_retry',
                sendKey: this.sendKey,
                screenText: summarizeCliTraceText(screenText, 500),
            });
            this.ptyProcess.write(this.sendKey);
            if (this.settleTimer) clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                this.settledBuffer = this.recentOutputBuffer;
                this.evaluateSettled();
            }, this.timeouts.outputSettle + 150);
            return;
        }

        if (this.currentTurnScope && !lastParsedAssistant) {
            LOG.debug(
                'CLI',
                `[${this.cliType}] Settled without assistant: prompt=${JSON.stringify(this.currentTurnScope.prompt).slice(0, 140)} responseBuffer=${JSON.stringify(summarizeCliTraceText(this.responseBuffer, 220)).slice(0, 260)} screen=${JSON.stringify(summarizeCliTraceText(screenText, 220)).slice(0, 260)} providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'}`
            );
        }

        if (!status) return;

        const prevStatus = this.currentStatus;
        const ctx: SettledEvalContext = { now, modal, status, parsedMessages, lastParsedAssistant, parsedStatus: parsedStatus || null, prevStatus };

        if (!this.applyPendingScriptStatusDebounce(ctx)) return;

        const recentInteractiveActivity = this.hasRecentInteractiveActivity(now);
        LOG.debug(
            'CLI',
            `[${this.cliType}] settled diagnostics prompt=${JSON.stringify(this.currentTurnScope?.prompt || '').slice(0, 140)} status=${String(status || '')} parsedStatus=${String(parsedStatus || '')} parsedMsgCount=${parsedMessages.length} lastParsedAssistant=${JSON.stringify(summarizeCliTraceText(lastParsedAssistant?.content || '', 120)).slice(0, 160)} responseBuffer=${JSON.stringify(summarizeCliTraceText(this.responseBuffer, 160)).slice(0, 220)} screen=${JSON.stringify(summarizeCliTraceText(screenText, 160)).slice(0, 220)}`
        );

        const shouldHoldGenerating =
            status === 'idle'
            && this.isWaitingForResponse
            && !modal
            && recentInteractiveActivity
            && !(parsedStatus === 'idle' && !!lastParsedAssistant);

        if (shouldHoldGenerating) { this.applyHoldGenerating(ctx, recentInteractiveActivity); return; }
        if (status === 'error') {
            if (this.maybeScheduleProviderErrorRetry(ctx, session)) return;
            this.applyError(ctx, session);
            return;
        }
        if (status === 'waiting_approval') { this.applyWaitingApproval(ctx); return; }
        if (status === 'generating') { this.applyGenerating(ctx); return; }
        if (status === 'idle') { this.applyIdle(ctx, now); }
    }

    // Returns false if the caller should bail out (debounce pending).
    private applyPendingScriptStatusDebounce(ctx: SettledEvalContext): boolean {
        const { now, status, prevStatus } = ctx;
        const shouldDebounce =
            prevStatus === 'idle'
            && !this.isWaitingForResponse
            && !this.currentTurnScope
            && (status === 'generating' || status === 'waiting_approval');

        if (!shouldDebounce) {
            this.pendingScriptStatus = null;
            this.pendingScriptStatusSince = 0;
            if (this.pendingScriptStatusTimer) { clearTimeout(this.pendingScriptStatusTimer); this.pendingScriptStatusTimer = null; }
            return true;
        }

        const armPending = (delayMs: number) => {
            if (this.pendingScriptStatusTimer) clearTimeout(this.pendingScriptStatusTimer);
            this.pendingScriptStatusTimer = setTimeout(() => {
                this.pendingScriptStatusTimer = null;
                this.settledBuffer = this.recentOutputBuffer;
                this.evaluateSettled();
            }, delayMs);
        };

        if (this.pendingScriptStatus !== status) {
            this.pendingScriptStatus = status as 'generating' | 'waiting_approval';
            this.pendingScriptStatusSince = now;
            armPending(ProviderCliAdapter.SCRIPT_STATUS_DEBOUNCE_MS);
            return false;
        }
        const elapsed = now - this.pendingScriptStatusSince;
        if (elapsed < ProviderCliAdapter.SCRIPT_STATUS_DEBOUNCE_MS) {
            armPending(ProviderCliAdapter.SCRIPT_STATUS_DEBOUNCE_MS - elapsed);
            return false;
        }
        return true;
    }

    private applyHoldGenerating(ctx: SettledEvalContext, recentInteractiveActivity: boolean): void {
        const { status } = ctx;
        this.clearIdleFinishCandidate('hold_generating_recent_activity');
        this.setStatus('generating', 'recent_activity_hold');
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                if (this.shouldDeferIdleTimeoutFinish()) return;
                this.finishResponse();
            }
        }, this.timeouts.generatingIdle);
        this.recordTrace('hold_generating_recent_activity', {
            scriptStatus: status,
            recentInteractiveActivity,
            lastNonEmptyOutputAt: this.lastNonEmptyOutputAt,
            lastScreenChangeAt: this.lastScreenChangeAt,
            holdMs: this.getStatusActivityHoldMs(),
            ...buildCliTraceParseSnapshot({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                responseBuffer: this.responseBuffer,
                partialResponse: this.responseBuffer,
                scope: this.currentTurnScope,
            }),
        });
        this.onStatusChange?.();
    }

    private applyWaitingApproval(ctx: SettledEvalContext): void {
        const { modal } = ctx;
        this.clearIdleFinishCandidate('waiting_approval');
        const inCooldown = this.lastApprovalResolvedAt && (Date.now() - this.lastApprovalResolvedAt) < this.timeouts.approvalCooldown;
        if (inCooldown && !modal) {
            if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
            this.activeModal = null;
            if (this.isWaitingForResponse) {
                this.setStatus('idle', inCooldown ? 'approval_cooldown_non_actionable' : 'approval_prompt_gone_non_actionable');
                if (this.idleTimeout) clearTimeout(this.idleTimeout);
                this.idleTimeout = setTimeout(() => {
                    if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                        if (this.shouldDeferIdleTimeoutFinish()) return;
                        this.finishResponse();
                    }
                }, this.timeouts.generatingIdle);
            } else {
                this.setStatus('idle', inCooldown ? 'approval_cooldown_non_actionable' : 'approval_prompt_gone_non_actionable');
            }
            this.onStatusChange?.();
            return;
        }
        if (!inCooldown) {
            if (!modal) {
                LOG.warn('CLI', `[${this.cliType}] detectStatus reported waiting_approval without parseApproval modal; ignoring non-actionable approval state`);
                return;
            }
            this.isWaitingForResponse = true;
            this.setStatus('waiting_approval', 'script_detect');
            this.activeModal = modal;
            if (this.idleTimeout) clearTimeout(this.idleTimeout);
            this.armApprovalExitTimeout();
            this.onStatusChange?.();
        }
    }

    private applyGenerating(ctx: SettledEvalContext): void {
        const { modal, parsedMessages, lastParsedAssistant, parsedStatus, prevStatus } = ctx;
        this.clearIdleFinishCandidate('generating');
        const screenText = this.terminalScreen.getText() || '';
        const effectiveScreenText = screenText || this.accumulatedBuffer;
        const noActiveTurn = !this.currentTurnScope;
        const looksIdleChrome = /(^|\n)\s*[❯›>]\s*(?:\n|$)/m.test(effectiveScreenText);
        const parsedShowsLiveAssistantProgress = parsedStatus === 'generating'
            && !!lastParsedAssistant
;
        if (prevStatus === 'idle' && !this.isWaitingForResponse && noActiveTurn && !modal && looksIdleChrome && !parsedShowsLiveAssistantProgress) {
            return;
        }
        if (prevStatus === 'waiting_approval') {
            // Transitioned out of approval → generating
            if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
            this.activeModal = null;
            this.lastApprovalResolvedAt = Date.now();
        }
        if (!this.isWaitingForResponse) {
            this.isWaitingForResponse = true;
            this.responseBuffer = '';
        }
        this.setStatus('generating', 'script_detect');
        // Reset idle timeout
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.isWaitingForResponse) {
                if (this.shouldDeferIdleTimeoutFinish()) return;
                this.finishResponse();
            }
        }, this.timeouts.generatingIdle);
        this.onStatusChange?.();
    }

    private applyError(ctx: SettledEvalContext, session: ParsedSession): void {
        this.clearIdleFinishCandidate('provider_error');
        if (this.responseTimeout) { clearTimeout(this.responseTimeout); this.responseTimeout = null; }
        if (this.idleTimeout) { clearTimeout(this.idleTimeout); this.idleTimeout = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.providerErrorMessage = typeof session.errorMessage === 'string' && session.errorMessage.trim()
            ? session.errorMessage.trim()
            : 'Provider reported an error';
        this.providerErrorReason = typeof session.errorReason === 'string' && session.errorReason.trim()
            ? session.errorReason.trim()
            : 'provider_error';
        this.setStatus('error', this.providerErrorReason);
        this.recordTrace('provider_error', {
            errorMessage: this.providerErrorMessage,
            errorReason: this.providerErrorReason,
            parsedStatus: ctx.parsedStatus || ctx.status,
            messageCount: ctx.parsedMessages.length,
            ...buildCliTraceParseSnapshot({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                responseBuffer: this.responseBuffer,
                partialResponse: this.responseBuffer,
                scope: this.currentTurnScope,
            }),
        });
        this.onStatusChange?.();
    }

    private maybeScheduleProviderErrorRetry(ctx: SettledEvalContext, session: ParsedSession): boolean {
        const retryPrompt = typeof (session as any).retryPrompt === 'string'
            ? String((session as any).retryPrompt).trim()
            : '';
        const retryDelayMs = typeof (session as any).retryDelayMs === 'number'
            ? Number((session as any).retryDelayMs)
            : NaN;
        if (!retryPrompt || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) return false;
        if (!this.ptyProcess) return false;

        const retryAttempt = typeof (session as any).retryAttempt === 'number'
            ? Number((session as any).retryAttempt)
            : 0;
        const retryMaxAttempts = typeof (session as any).retryMaxAttempts === 'number'
            ? Number((session as any).retryMaxAttempts)
            : 0;
        const errorReason = typeof session.errorReason === 'string' && session.errorReason.trim()
            ? session.errorReason.trim()
            : 'provider_error';
        const retryKey = `${errorReason}:${retryAttempt}:${retryPrompt}`;
        if (this.providerErrorRetryTimer && this.providerErrorRetryKey === retryKey) return true;

        if (this.providerErrorRetryTimer) clearTimeout(this.providerErrorRetryTimer);
        this.providerErrorRetryKey = retryKey;
        this.clearIdleFinishCandidate('provider_error_retry');
        if (this.idleTimeout) { clearTimeout(this.idleTimeout); this.idleTimeout = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        this.providerErrorMessage = typeof session.errorMessage === 'string' && session.errorMessage.trim()
            ? session.errorMessage.trim()
            : 'Provider reported an error';
        this.providerErrorReason = errorReason;
        this.activeModal = null;
        this.responseSettleIgnoreUntil = Date.now() + retryDelayMs + this.timeouts.outputSettle + 400;
        this.setStatus('generating', 'provider_error_retry_scheduled');
        this.recordTrace('provider_error_retry_scheduled', {
            retryPrompt,
            retryDelayMs,
            retryAttempt,
            retryMaxAttempts,
            errorReason,
            parsedStatus: ctx.parsedStatus || ctx.status,
        });
        this.onStatusChange?.();
        this.providerErrorRetryTimer = setTimeout(() => {
            this.providerErrorRetryTimer = null;
            this.providerErrorRetryKey = '';
            if (!this.ptyProcess) return;
            this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
            this.submitRetryUsed = false;
            this.recordTrace('provider_error_retry_write', {
                retryPrompt,
                retryAttempt,
                retryMaxAttempts,
                errorReason,
            });
            this.ptyProcess.write(`${retryPrompt}\r`);
            if (this.settleTimer) clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                this.settledBuffer = this.recentOutputBuffer;
                this.evaluateSettled();
            }, this.timeouts.outputSettle + 150);
        }, retryDelayMs);
        return true;
    }

    private applyIdle(ctx: SettledEvalContext, now: number): void {
        const { modal, lastParsedAssistant, prevStatus } = ctx;
        if (prevStatus === 'waiting_approval') {
            if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
            this.activeModal = null;
            this.lastApprovalResolvedAt = Date.now();
            this.setStatus('idle', 'approval_prompt_gone_script_idle');
        }
        if (!this.isWaitingForResponse) {
            if (prevStatus !== 'idle') {
                this.clearIdleFinishCandidate('idle_without_response');
                this.setStatus('idle', 'script_detect');
                this.onStatusChange?.();
            }
            return;
        }
        const quietForMs = this.lastNonEmptyOutputAt ? (now - this.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
        const screenStableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : 0;
        const hasAssistantTurn = !!lastParsedAssistant;
        const assistantLength = lastParsedAssistant?.content?.length || 0;
        const idleFinishConfirmMs = this.getIdleFinishConfirmMs();
        const idleQuietThresholdMs = Math.max(idleFinishConfirmMs, this.timeouts.outputSettle);
        const idleReady = !modal
            && hasAssistantTurn
            && quietForMs >= idleQuietThresholdMs
            && screenStableMs >= idleFinishConfirmMs;
        const candidate = this.idleFinishCandidate;
        const candidateQuiet = !!candidate
            && candidate.responseEpoch === this.responseEpoch
            && candidate.lastOutputAt === this.lastOutputAt
            && candidate.lastScreenChangeAt === this.lastScreenChangeAt
            && assistantLength >= candidate.assistantLength
            && (now - candidate.armedAt) >= idleFinishConfirmMs;

        this.recordTrace('idle_decision', {
            quietForMs,
            screenStableMs,
            hasAssistantTurn,
            assistantLength,
            hasModal: !!modal,
            idleQuietThresholdMs,
            idleStableThresholdMs: idleFinishConfirmMs,
            idleReady,
            idleFinishConfirmMs,
            idleFinishCandidate: candidate,
            candidateQuiet,
            canFinishImmediately: idleReady && candidateQuiet,
            submitPendingUntil: this.submitPendingUntil,
            responseSettleIgnoreUntil: this.responseSettleIgnoreUntil,
            ...buildCliTraceParseSnapshot({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                responseBuffer: this.responseBuffer,
                partialResponse: this.responseBuffer,
                scope: this.currentTurnScope,
            }),
        });

        if (idleReady && candidateQuiet) {
            this.clearIdleFinishCandidate('finish_response');
            if (this.idleTimeout) clearTimeout(this.idleTimeout);
            this.finishResponse();
            return;
        }

        if (idleReady) {
            if (!candidate) {
                this.armIdleFinishCandidate(assistantLength);
                return;
            }
        } else {
            this.clearIdleFinishCandidate('idle_not_ready');
        }

        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                if (this.shouldDeferIdleTimeoutFinish()) return;
                const parsed = this.runParseSession();
                if (this.shouldKeepCodexTurnOpenForFinish(parsed)) {
                    this.rescheduleCodexFinishCheck('codex_idle_timeout_not_final');
                    return;
                }
                this.clearIdleFinishCandidate('idle_timeout_finish');
                this.finishResponse();
            }
        }, this.timeouts.idleFinish);
    }

    private finishResponse(): void {
        if (this.submitPendingUntil > Date.now()) return;
        if (this.responseSettleIgnoreUntil > Date.now()) return;
        const parsedBeforeFinish = this.runParseSession();
        if (this.shouldKeepCodexTurnOpenForFinish(parsedBeforeFinish)) {
            this.rescheduleCodexFinishCheck('codex_finish_not_final');
            return;
        }
        this.clearIdleFinishCandidate('finish_response_enter');
        this.recordTrace('finish_response', {
            ...buildCliTraceParseSnapshot({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                responseBuffer: this.responseBuffer,
                partialResponse: this.responseBuffer,
                scope: this.currentTurnScope,
            }),
        });
        const commitResult = this.commitCurrentTranscript();
        if (this.shouldRetryFinishResponse(commitResult)) {
            this.finishRetryCount += 1;
            this.recordTrace('finish_response_retry', {
                retryCount: this.finishRetryCount,
                retryDelayMs: ProviderCliAdapter.FINISH_RETRY_DELAY_MS,
                assistantContent: summarizeCliTraceText(commitResult.assistantContent, 220),
                ...buildCliTraceParseSnapshot({
                    accumulatedBuffer: this.accumulatedBuffer,
                    accumulatedRawBuffer: this.accumulatedRawBuffer,
                    responseBuffer: this.responseBuffer,
                    partialResponse: this.responseBuffer,
                    scope: this.currentTurnScope,
                }),
            });
            if (this.finishRetryTimer) clearTimeout(this.finishRetryTimer);
            this.finishRetryTimer = setTimeout(() => {
                this.finishRetryTimer = null;
                if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                    this.finishResponse();
                }
            }, ProviderCliAdapter.FINISH_RETRY_DELAY_MS);
            return;
        }
        this.clearAllTimers();
        this.responseBuffer = '';
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.setStatus('idle', 'response_finished');
        this.onStatusChange?.();
        this.schedulePendingOutboundFlush();
    }

    private maybeCommitVisibleIdleTranscript(session: ParsedSession, parsedMessages: CliChatMessage[]): boolean {
        const allowImmediateScriptIdleCommit = this.provider.allowInputDuringGeneration === true;
        if (!allowImmediateScriptIdleCommit) return false;
        if (
            !session
            || session.status !== 'idle'
            || !this.isWaitingForResponse
            || !this.currentTurnScope
            || this.activeModal
            || session.modal
        ) {
            return false;
        }

        const visibleAssistant = [...parsedMessages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
        if (!visibleAssistant) return false;

        this.clearAllTimers();
        this.responseBuffer = '';
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.finishRetryCount = 0;
        this.currentTurnScope = null;
        this.activeModal = null;
        this.setStatus('idle', 'script_idle_commit');
        this.onStatusChange?.();
        this.schedulePendingOutboundFlush();
        this.recordTrace('script_idle_commit', {
            messageCount: parsedMessages.length,
            lastAssistant: summarizeCliTraceText(visibleAssistant.content, 320),
        });
        return true;
    }

    private commitCurrentTranscript(): { hasAssistant: boolean; assistantContent: string } {
        const parsed = this.parseCurrentTranscript(
            [],
            this.responseBuffer,
            this.currentTurnScope,
        );
        if (parsed && Array.isArray(parsed.messages)) {
            const parsedMessages = normalizeCliParsedMessages(parsed.messages, {
                    scope: null,
                lastOutputAt: this.lastOutputAt,
            });
            const lastAssistant = [...parsedMessages].reverse().find((message) => message.role === 'assistant');
            if (this.currentTurnScope) {
                LOG.info(
                    'CLI',
                    `[${this.cliType}] commitCurrentTranscript parserMessages=${parsedMessages.length} finalLastAssistant=${JSON.stringify(summarizeCliTraceText(lastAssistant?.content || '', 220)).slice(0, 260)}`
                );
            }
            this.recordTrace('commit_transcript', {
                parsedStatus: parsed.status || null,
                messageCount: parsedMessages.length,
                lastAssistant: lastAssistant ? summarizeCliTraceText(lastAssistant.content, 320) : '',
                messages: summarizeCliTraceMessages(parsedMessages),
                ...buildCliTraceParseSnapshot({
                    accumulatedBuffer: this.accumulatedBuffer,
                    accumulatedRawBuffer: this.accumulatedRawBuffer,
                    responseBuffer: this.responseBuffer,
                    partialResponse: this.responseBuffer,
                    scope: this.currentTurnScope,
                }),
            });
            if (!lastAssistant && this.currentTurnScope) {
                LOG.warn(
                    'CLI',
                    `[${this.cliType}] Commit without assistant turn: prompt=${JSON.stringify(this.currentTurnScope.prompt).slice(0, 140)} responseBuffer=${JSON.stringify(summarizeCliTraceText(this.responseBuffer, 220)).slice(0, 260)} providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'}`
                );
            }
            const hasAssistant = !!lastAssistant;
            return {
                hasAssistant,
                assistantContent: lastAssistant?.content || '',
            };
        }
        if (this.currentTurnScope) {
            LOG.info(
                'CLI',
                `[${this.cliType}] commitCurrentTranscript parsed.messages=none responseBufferLen=${this.responseBuffer.length} accumulatedBufferLen=${this.accumulatedBuffer.length} parsedStatus=${parsed?.status || '-'} providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'}`
            );
        }
        return {
            hasAssistant: false,
            assistantContent: '',
        };
    }


 // ─── Script Execution ──────────────────────────

    private invokeCliScript<T>(script: Function, input: any): T {
        const hasStateFactory = typeof this.cliScripts?.createState === 'function';
        const expectsStateArgument = hasStateFactory || this.scriptState !== null || script.length >= 2;
        return expectsStateArgument
            ? script(this.scriptState, input)
            : script(input);
    }

    private runParseSession(): ParsedSession | null {
        if (typeof this.cliScripts?.parseSession !== 'function') {
            this.parseErrorMessage = `${this.cliType} parseSession unavailable`;
            return null;
        }
        try {
            const screenText = this.terminalScreen.getText();
            const parseScreenText = this.getParseScreenText(screenText);
            const tail = this.recentOutputBuffer.slice(-500);
            const input = buildCliParseInput({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                recentOutputBuffer: this.recentOutputBuffer,
                terminalScreenText: parseScreenText,
                workingDir: this.workingDir,
                baseMessages: [],
                partialResponse: this.responseBuffer,
                isWaitingForResponse: this.isWaitingForResponse,
                scope: this.currentTurnScope,
                runtimeSettings: this.runtimeSettings,
            });
            const session = this.invokeCliScript<ParsedSession | null>(
                this.cliScripts.parseSession,
                { ...input, tail, tailScreen: buildCliScreenSnapshot(tail) },
            );
            this.parseErrorMessage = null;
            if (session && typeof session === 'object') this.applyParsedSessionMetadata(session);
            return session && typeof session === 'object' ? session : null;
        } catch (e: any) {
            const message = e?.message || String(e);
            this.parseErrorMessage = message;
            LOG.warn('CLI', `[${this.cliType}] parseSession error: ${message}`);
            return null;
        }
    }

    private runDetectStatus(text: string): string | null {
        if (!this.cliScripts?.detectStatus) return null;
        try {
            const screenText = this.terminalScreen.getText();
            const status = this.invokeCliScript<string | null>(this.cliScripts.detectStatus, {
                tail: text.slice(-500),
                screenText,
                rawBuffer: this.accumulatedRawBuffer,
                isWaitingForResponse: this.isWaitingForResponse,
                screen: buildCliScreenSnapshot(screenText),
                tailScreen: buildCliScreenSnapshot(text.slice(-500)),
            });
            return status;
        } catch (e: any) {
            LOG.warn('CLI', `[${this.cliType}] detectStatus error: ${e.message}`);
            return null;
        }
    }

    private runParseApproval(tail: string): { message: string; buttons: string[] } | null {
        if (!this.cliScripts?.parseApproval) return null;
        try {
            const screenText = this.terminalScreen.getText();
            const buffer = screenText || this.accumulatedBuffer;
            return this.invokeCliScript<{ message: string; buttons: string[] } | null>(this.cliScripts.parseApproval, {
                buffer,
                screenText,
                rawBuffer: this.accumulatedRawBuffer,
                tail,
                screen: buildCliScreenSnapshot(screenText),
                bufferScreen: buildCliScreenSnapshot(buffer),
                tailScreen: buildCliScreenSnapshot(tail),
            });
        } catch (e: any) {
            LOG.warn('CLI', `[${this.cliType}] parseApproval error: ${e.message}`);
            return null;
        }
    }

    private hasActionableApproval(startupModal: { message: string; buttons: string[] } | null = null): boolean {
        return !!(startupModal || this.activeModal);
    }

    private parsedStatusHasFinalAssistantMessage(parsed: any): boolean {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const lastAssistant = [...messages].reverse().find((message: any) => {
            if (!message || message.role !== 'assistant') return false;
            return typeof message.content === 'string' && message.content.trim().length > 0;
        });
        return !!lastAssistant;
    }

    private applyParsedSessionMetadata(parsed: any): void {
        const providerSessionId = typeof parsed?.providerSessionId === 'string' && parsed.providerSessionId.trim()
            ? parsed.providerSessionId.trim()
            : '';
        if (providerSessionId) {
            this.providerSessionId = providerSessionId;
            this.updateRuntimeMeta({ providerSessionId });
        }
        this.providerErrorMessage = typeof parsed?.errorMessage === 'string' && parsed.errorMessage.trim()
            ? parsed.errorMessage.trim()
            : null;
        this.providerErrorReason = typeof parsed?.errorReason === 'string' && parsed.errorReason.trim()
            ? parsed.errorReason.trim()
            : null;
    }

    private parsedStatusHasFinalStandardAssistantMessage(parsed: any): boolean {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const lastAssistant = [...messages].reverse().find((message: any) => {
            if (!message || message.role !== 'assistant') return false;
            return typeof message.content === 'string' && message.content.trim().length > 0;
        });
        if (!lastAssistant) return false;
        const kind = typeof lastAssistant.kind === 'string' && lastAssistant.kind.trim()
            ? lastAssistant.kind.trim()
            : 'standard';
        return kind === 'standard' && lastAssistant.meta?.streaming !== true;
    }

    private shouldKeepCodexTurnOpenForFinish(parsed: any): boolean {
        if (this.cliType !== 'codex-cli') return false;
        if (!this.isWaitingForResponse || !this.currentTurnScope || this.hasActionableApproval()) return false;
        const parsedStatus = typeof parsed?.status === 'string' ? parsed.status.trim() : '';
        if (parsedStatus !== 'idle') return true;
        if (parsed?.activeModal || parsed?.modal) return true;
        return !this.parsedStatusHasFinalStandardAssistantMessage(parsed);
    }

    private rescheduleCodexFinishCheck(reason: string): void {
        this.clearIdleFinishCandidate(reason);
        this.setStatus('generating', reason);
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (!this.isWaitingForResponse || this.hasActionableApproval()) return;
            this.settledBuffer = this.recentOutputBuffer;
            this.evaluateSettled();
        }, this.getIdleFinishConfirmMs());
        this.recordTrace('codex_finish_deferred', {
            reason,
            ...buildCliTraceParseSnapshot({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                responseBuffer: this.responseBuffer,
                partialResponse: this.responseBuffer,
                scope: this.currentTurnScope,
            }),
        });
    }

    private projectEffectiveStatus(startupModal: { message: string; buttons: string[] } | null = null): CliSessionStatus['status'] {
        if (this.parseErrorMessage) return 'error';
        if (this.hasActionableApproval(startupModal)) return 'waiting_approval';
        if (this.isWaitingForResponse && this.currentTurnScope && this.currentStatus !== 'stopped') return 'generating';
        return this.currentStatus;
    }

 // ─── Public API (CliAdapter) ───────────────────

    getStatus(options: { allowParse?: boolean } = {}): CliSessionStatus {
        const allowParse = options.allowParse !== false;
        const startupModal = allowParse && this.startupParseGate ? this.runParseApproval(this.recentOutputBuffer) : null;
        const startupDetectedStatus = allowParse && this.startupParseGate && !startupModal
            ? this.runDetectStatus(this.recentOutputBuffer || this.terminalScreen.getText())
            : null;
        let effectiveStatus = this.projectEffectiveStatus(startupModal);
        let effectiveModal = startupModal || this.activeModal;
        if (startupDetectedStatus === 'waiting_approval') {
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
            if (parsed?.status === 'waiting_approval' && parsedModal) {
                effectiveStatus = 'waiting_approval';
                effectiveModal = parsedModal;
            } else if (
                effectiveStatus === 'idle'
                && parsed?.status === 'generating'
                && !this.parsedStatusHasFinalAssistantMessage(parsed)
            ) {
                effectiveStatus = 'generating';
            } else if (
                effectiveStatus === 'generating'
                && parsed?.status === 'idle'
                && this.parsedStatusHasFinalAssistantMessage(parsed)
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
            pendingOutboundCount: this.pendingOutboundQueue.length,
            pendingOutboundMessages: this.pendingOutboundQueue.map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                queuedAt: message.queuedAt,
                source: message.source,
            })),
            errorMessage: this.parseErrorMessage || this.providerErrorMessage || undefined,
            errorReason: this.parseErrorMessage ? 'parse_error' : (this.providerErrorReason || undefined),
            providerSessionId: this.providerSessionId || undefined,
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
            && cached.currentTurnScope === this.currentTurnScope
            && cached.recentOutputBuffer === this.recentOutputBuffer
            && cached.accumulatedBuffer === this.accumulatedBuffer
            && cached.accumulatedRawBufferKey === accumulatedRawBufferKey
            && cached.screenText === parseScreenText
            && cached.currentStatus === this.currentStatus
            && cached.activeModal === this.activeModal
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
            status: parsed.status || this.currentStatus,
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
            currentTurnScope: this.currentTurnScope,
            recentOutputBuffer: this.recentOutputBuffer,
            accumulatedBuffer: this.accumulatedBuffer,
            accumulatedRawBufferKey,
            screenText: parseScreenText,
            currentStatus: this.currentStatus,
            activeModal: this.activeModal,
            cliName: this.cliName,
            result,
        };
        return result;
    }

    async invokeScript(scriptName: string, args?: Record<string, any>): Promise<any> {
        const fn = this.cliScripts?.[scriptName];
        if (typeof fn !== 'function') {
            throw new Error(`CLI script '${scriptName}' not available`);
        }
        const input = buildCliParseInput({
            accumulatedBuffer: this.accumulatedBuffer,
            accumulatedRawBuffer: this.accumulatedRawBuffer,
            recentOutputBuffer: this.recentOutputBuffer,
            terminalScreenText: this.getParseScreenText(this.terminalScreen.getText()),
            workingDir: this.workingDir,
            baseMessages: [],
            partialResponse: this.responseBuffer,
            isWaitingForResponse: this.isWaitingForResponse,
            scope: this.currentTurnScope,
            runtimeSettings: this.runtimeSettings,
        });
        return await Promise.resolve(this.invokeCliScript(fn, {
            ...input,
            args: args && typeof args === 'object' ? { ...args } : {},
        }));
    }

    private parseCurrentTranscript(_baseMessages: CliChatMessage[], _partialResponse: string, _scope?: TurnParseScope | null, _screenTextOverride?: string): any {
        return this.runParseSession();
    }

    /** Whether this adapter has CLI scripts loaded */
    hasCliScripts(): boolean {
        return typeof this.cliScripts?.detectStatus === 'function';
    }

    /**
     * Resolves an action (like 'fix' lint error) from the dashboard.
     * Uses resolveAction script if available, otherwise falls back to standard text.
     */
    async resolveAction(data: any): Promise<void> {
        let promptText = '';
        if (this.cliScripts && typeof this.cliScripts.resolveAction === 'function') {
            try {
                promptText = this.cliScripts.resolveAction(data);
            } catch (e: any) {
                LOG.warn('CLI', `[${this.cliType}] resolveAction error: ${e.message}`);
            }
        }
        if (!promptText) {
            LOG.warn('CLI', `[${this.cliType}] resolveAction skipped: provider script did not supply a prompt`);
            return;
        }
        await this.sendMessage(promptText);
    }

    private isSubmitStuck(normalizedPromptSnippet: string): boolean {
        if (!this.ptyProcess || !this.isWaitingForResponse || this.submitRetryUsed) return false;
        if (this.hasActionableApproval()) return false;
        if (this.hasMeaningfulResponseBuffer(normalizedPromptSnippet)) return false;
        const screenText = this.terminalScreen.getText();
        if (!promptLikelyVisible(screenText, normalizedPromptSnippet)) return false;
        const liveApproval = this.runParseApproval(screenText) || this.runParseApproval(this.recentOutputBuffer);
        if (liveApproval) return false;
        const liveStatus = this.runDetectStatus(screenText) || this.runDetectStatus(this.recentOutputBuffer);
        return liveStatus !== 'generating' && liveStatus !== 'waiting_approval';
    }

    private async writeToPty(data: string): Promise<void> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        await this.ptyProcess.write(data);
    }

    private resetPendingSendState(reason: string): void {
        this.isWaitingForResponse = false;
        this.responseBuffer = '';
        this.currentTurnScope = null;
        this.submitPendingUntil = 0;
        this.clearIdleFinishCandidate(reason);
        if (this.responseTimeout) { clearTimeout(this.responseTimeout); this.responseTimeout = null; }
        if (this.submitRetryTimer) { clearTimeout(this.submitRetryTimer); this.submitRetryTimer = null; }
        if (this.finishRetryTimer) { clearTimeout(this.finishRetryTimer); this.finishRetryTimer = null; }
    }

    private commitSendUserTurn(state: SendMessageState): void {
        if (state.didCommitUserTurn) return;
        state.didCommitUserTurn = true;
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
            if (!this.isWaitingForResponse) return;

            const detectedStatusBeforeEval = this.runDetectStatus(this.recentOutputBuffer);
            this.recordTrace('response_timeout_check', {
                timeoutMs,
                detectedStatus: detectedStatusBeforeEval,
                currentStatus: this.currentStatus,
                isWaitingForResponse: this.isWaitingForResponse,
                hasActionableApproval: this.hasActionableApproval(),
                ...buildCliTraceParseSnapshot({
                    accumulatedBuffer: this.accumulatedBuffer,
                    accumulatedRawBuffer: this.accumulatedRawBuffer,
                    responseBuffer: this.responseBuffer,
                    partialResponse: this.responseBuffer,
                    scope: this.currentTurnScope,
                }),
            });

            // maxResponse is a watchdog/checkpoint, not a completion signal. The old
            // behavior called finishResponse() unconditionally at the default 300s,
            // which fabricated idle transitions and downstream generating_completed
            // notifications while long-running CLIs were still generating. Re-run the
            // normal settled parser instead and keep the turn open unless the provider
            // actually reports an idle, commit-ready state.
            this.settledBuffer = this.recentOutputBuffer;
            this.evaluateSettled();

            if (this.isWaitingForResponse && !this.hasActionableApproval()) {
                const detectedStatusAfterEval = this.runDetectStatus(this.recentOutputBuffer);
                this.recordTrace('response_timeout_kept_open', {
                    timeoutMs,
                    detectedStatusBeforeEval,
                    detectedStatusAfterEval,
                    currentStatus: this.currentStatus,
                    isWaitingForResponse: this.isWaitingForResponse,
                });
                this.armResponseTimeout();
            }
        }, timeoutMs);
    }

    private writeSubmitKeyForRetry(mode: string): void {
        void this.writeToPty(this.sendKey).catch((error) => {
            LOG.warn('CLI', `[${this.cliType}] ${mode} write failed: ${error?.message || error}`);
        });
    }

    private retrySubmitIfStuck(state: SendMessageState, attempt: number): void {
        this.submitRetryTimer = null;
        if (!this.isSubmitStuck(state.normalizedPromptSnippet)) return;
        const screenText = this.terminalScreen.getText();
        this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
        LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt ${attempt})`);
        this.recordTrace('submit_write', {
            mode: 'submit_retry',
            attempt,
            sendKey: this.sendKey,
            screenText: summarizeCliTraceText(screenText, 500),
        });
        this.writeSubmitKeyForRetry('submit_retry');
        if (attempt >= 3) { this.submitRetryUsed = true; return; }
        this.submitRetryTimer = setTimeout(() => this.retrySubmitIfStuck(state, attempt + 1), state.retryDelayMs);
    }

    private retryImmediateSubmitIfStuck(state: SendMessageState): void {
        this.submitRetryTimer = null;
        if (!this.isSubmitStuck(state.normalizedPromptSnippet)) return;
        const screenText = this.terminalScreen.getText();
        this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
        LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt 1)`);
        this.recordTrace('submit_write', {
            mode: 'immediate_retry',
            attempt: 1,
            sendKey: this.sendKey,
            screenText: summarizeCliTraceText(screenText, 500),
        });
        this.writeSubmitKeyForRetry('immediate_retry');
        this.submitRetryUsed = true;
    }

    private submitSendKey(state: SendMessageState, completion: SendMessageCompletion): void {
        if (!this.ptyProcess) {
            completion.resolveOnce();
            return;
        }
        this.submitPendingUntil = 0;
        const screenText = this.terminalScreen.getText();
        this.recordTrace('submit_write', {
            mode: 'submit_key',
            sendKey: this.sendKey,
            screenText: summarizeCliTraceText(screenText, 500),
        });
        void this.writeToPty(this.sendKey).then(() => {
            this.commitSendUserTurn(state);
            this.submitRetryTimer = setTimeout(() => this.retrySubmitIfStuck(state, 1), state.retryDelayMs);
            this.armResponseTimeout();
            completion.resolveOnce();
        }, completion.rejectOnce);
    }

    private submitImmediatePrompt(state: SendMessageState, completion: SendMessageCompletion): void {
        this.submitPendingUntil = 0;
        this.recordTrace('submit_write', {
            mode: 'immediate',
            text: summarizeCliTraceText(state.text, 500),
            sendKey: this.sendKey,
            screenText: summarizeCliTraceText(this.terminalScreen.getText(), 500),
        });
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
            this.recordTrace('submit_echo_missing', diagnostic);
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

    async sendMessage(text: string, options: { force?: boolean } = {}): Promise<void> {
        if (options.force === true) {
            await this.forceSendMessage(text);
            return;
        }
        await this.sendMessageNow(text, true);
    }

    async forceSendMessage(text: string): Promise<void> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        const content = String(text || '');
        if (!content.trim()) return;
        this.recordTrace('force_send_message', {
            text: summarizeCliTraceText(content, 500),
            status: this.currentStatus,
            isWaitingForResponse: this.isWaitingForResponse,
            queueLength: this.pendingOutboundQueue.length,
        });
        LOG.info('CLI', `[${this.cliType}] force-sending prompt while status=${this.currentStatus}`);
        await this.writeToPty(content + this.sendKey);
        this.onStatusChange?.();
    }

    private enqueuePendingOutboundMessage(text: string, reason: string): void {
        const content = String(text || '');
        const duplicate = this.pendingOutboundQueue.some((message) => message.content === content);
        if (duplicate) {
            this.recordTrace('send_message_queued_duplicate_suppressed', {
                reason,
                queueLength: this.pendingOutboundQueue.length,
                text: summarizeCliTraceText(content, 500),
            });
            return;
        }
        const queuedAt = Date.now();
        const message: PendingOutboundMessage = {
            id: `${queuedAt}:${this.pendingOutboundQueue.length}:${Math.random().toString(36).slice(2, 10)}`,
            role: 'user',
            content,
            queuedAt,
            source: 'sendMessage',
        };
        this.pendingOutboundQueue.push(message);
        this.recordTrace('send_message_queued', {
            reason,
            queueLength: this.pendingOutboundQueue.length,
            queuedAt,
            text: summarizeCliTraceText(content, 500),
        });
        LOG.info('CLI', `[${this.cliType}] queued outbound message while busy (${reason}); queue=${this.pendingOutboundQueue.length}`);
        this.onStatusChange?.();
    }

    private shouldQueuePendingOutboundMessage(parsedStatusBeforeSend: any | null = null): string | null {
        if (this.provider.allowInputDuringGeneration === true) return null;
        if (this.hasActionableApproval()) return null;
        const parsedSessionStatus = typeof parsedStatusBeforeSend?.status === 'string'
            ? String(parsedStatusBeforeSend.status)
            : '';
        if (parsedSessionStatus === 'idle' && this.parsedStatusHasFinalAssistantMessage(parsedStatusBeforeSend)) return null;
        if (this.currentStatus === 'generating') return 'current_status_generating';
        if (parsedSessionStatus === 'generating' || parsedSessionStatus === 'long_generating') {
            const parsedModal = parsedStatusBeforeSend?.activeModal ?? parsedStatusBeforeSend?.modal ?? null;
            const parsedHasActionableModal = Boolean(
                parsedModal
                && Array.isArray(parsedModal.buttons)
                && parsedModal.buttons.some((candidate: unknown) => typeof candidate === 'string' && candidate.trim()),
            );
            const terminalLooksIdle = this.currentStatus === 'idle'
                && this.runDetectStatus(this.recentOutputBuffer) === 'idle'
                && !this.isWaitingForResponse
                && !this.currentTurnScope
                && !this.hasActionableApproval()
                && !parsedHasActionableModal;
            return terminalLooksIdle ? null : `parsed_status_${parsedSessionStatus}`;
        }
        if (this.isWaitingForResponse && this.currentTurnScope) return 'active_turn_in_progress';
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
        if (this.currentStatus !== 'idle' || this.isWaitingForResponse || this.hasActionableApproval()) return;
        this.pendingOutboundFlushInFlight = true;
        try {
            while (this.pendingOutboundQueue.length > 0) {
                if (this.currentStatus !== 'idle' || this.isWaitingForResponse || this.hasActionableApproval()) break;
                const next = this.pendingOutboundQueue[0];
                this.recordTrace('send_message_queue_flush', {
                    id: next.id,
                    queuedAt: next.queuedAt,
                    queueLength: this.pendingOutboundQueue.length,
                    text: summarizeCliTraceText(next.content, 500),
                });
                try {
                    await this.sendMessageNow(next.content, false);
                    this.pendingOutboundQueue.shift();
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

    private async sendMessageNow(text: string, allowQueue: boolean): Promise<void> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        const allowInputDuringGeneration = this.provider.allowInputDuringGeneration === true;
        const allowInterventionPrompt = allowInputDuringGeneration
            && this.isWaitingForResponse
            && !this.hasActionableApproval();
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
            this.enqueuePendingOutboundMessage(text, queueReason);
            return;
        }
        if (!allowInterventionPrompt) {
            await this.waitForInteractivePrompt();
        }
        if (!this.ready) {
            this.resolveStartupState('send_precheck');
            if (this.runDetectStatus(this.recentOutputBuffer) === 'idle') {
                this.ready = true;
                this.startupParseGate = false;
                this.setStatus('idle', 'send_message_idle_prompt_recovery');
                LOG.info('CLI', `[${this.cliType}] sendMessage recovered idle prompt readiness`);
            }
        }
        if (!this.ready) throw new Error(`${this.cliName} not ready (status: ${this.currentStatus})`);
        const parsedSessionStatus = typeof parsedStatusBeforeSend?.status === 'string'
            ? String(parsedStatusBeforeSend.status)
            : '';
        if (!allowInputDuringGeneration && (parsedSessionStatus === 'generating' || parsedSessionStatus === 'long_generating')) {
            const parsedModal = parsedStatusBeforeSend?.activeModal ?? parsedStatusBeforeSend?.modal ?? null;
            const parsedHasActionableModal = Boolean(
                parsedModal
                && Array.isArray(parsedModal.buttons)
                && parsedModal.buttons.some((candidate: unknown) => typeof candidate === 'string' && candidate.trim()),
            );
            const terminalLooksIdle = this.currentStatus === 'idle'
                && this.runDetectStatus(this.recentOutputBuffer) === 'idle'
                && !this.isWaitingForResponse
                && !this.currentTurnScope
                && !this.hasActionableApproval()
                && !parsedHasActionableModal;
            if (!terminalLooksIdle) {
                if (allowQueue) {
                    this.enqueuePendingOutboundMessage(text, `parsed_status_${parsedSessionStatus}`);
                    return;
                }
                throw new Error(`${this.cliName} is still processing the previous prompt`);
            }
        }
        if (this.isWaitingForResponse && !allowInputDuringGeneration) {
            if (
                !this.clearStaleIdleResponseGuard('send_message_guard')
                && !this.clearParsedIdleResponseGuard('send_message_parsed_idle_guard', parsedStatusBeforeSend)
            ) {
                if (allowQueue) {
                    this.enqueuePendingOutboundMessage(text, 'waiting_for_response');
                    return;
                }
                throw new Error(`${this.cliName} is still processing the previous prompt`);
            }
        }
        this.isWaitingForResponse = true;
        this.responseBuffer = '';
        this.finishRetryCount = 0;
        if (this.finishRetryTimer) { clearTimeout(this.finishRetryTimer); this.finishRetryTimer = null; }
        this.clearIdleFinishCandidate('send_message');
        this.currentTurnScope = {
            prompt: text,
            startedAt: Date.now(),
            bufferStart: this.accumulatedBuffer.length,
            rawBufferStart: this.accumulatedRawBuffer.length,
        };
        this.recordTrace('send_message', {
            text: summarizeCliTraceText(text, 500),
            estimatedLines: estimatePromptDisplayLines(text),
            turnScope: this.currentTurnScope,
        });
        LOG.info('CLI', `[${this.cliType}] sendMessage turn scope buffer=${this.currentTurnScope.bufferStart} raw=${this.currentTurnScope.rawBufferStart} prompt=${JSON.stringify(text).slice(0, 120)}`);
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = extractPromptRetrySnippet(text);
        const normalizedPromptSnippet = normalizePromptText(this.submitRetryPromptSnippet);
        if (this.submitRetryTimer) {
            clearTimeout(this.submitRetryTimer);
            this.submitRetryTimer = null;
        }
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
        };
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = null;
        }
        this.responseEpoch += 1;
        this.responseSettleIgnoreUntil = Date.now() + submitDelayMs + this.timeouts.outputSettle + 250;
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

            if (this.submitStrategy === 'immediate') {
                this.submitImmediatePrompt(sendState, completion);
                return;
            }

            if (submitDelayMs > 0) {
                this.submitPendingUntil = Date.now() + submitDelayMs;
            }
            this.recordTrace('submit_write', {
                mode: 'type_then_submit',
                text: summarizeCliTraceText(text, 500),
                sendKey: this.sendKey,
                screenText: summarizeCliTraceText(this.terminalScreen.getText(), 500),
            });
            const submitStartedAt = Date.now();
            void this.writeToPty(text).then(
                () => this.waitForEchoAndSubmit(sendState, completion, submitStartedAt),
                completion.rejectOnce,
            );
        });
    }

    getPartialResponse(): string {
        if (!this.isWaitingForResponse) return '';
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
            currentStatus: this.currentStatus,
            ready: this.ready,
            isWaitingForResponse: this.isWaitingForResponse,
            activeModal: this.activeModal,
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
                scriptNames: listCliScriptNames(this.cliScripts),
                traceSessionId: this.traceSessionId,
                traceSeq: this.traceSeq,
                currentTurnScope: this.currentTurnScope,
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
                pendingScriptStatus: this.pendingScriptStatus,
                pendingScriptStatusSince: this.pendingScriptStatusSince,
            },
            runtimeMetadata: this.getRuntimeMetadata(),
            statusHistory: this.statusHistory.slice(-80),
            traceEntries: this.traceEntries.slice(-120),
            timing: {
                spawnAt: this.spawnAt,
                startupFirstOutputAt: this.startupFirstOutputAt,
                submitPendingUntil: this.submitPendingUntil,
                responseSettleIgnoreUntil: this.responseSettleIgnoreUntil,
                responseEpoch: this.responseEpoch,
                resizeSuppressUntil: this.resizeSuppressUntil,
                lastApprovalResolvedAt: this.lastApprovalResolvedAt,
            },
            finish: {
                idleFinishCandidate: this.idleFinishCandidate,
                finishRetryCount: this.finishRetryCount,
                submitRetryUsed: this.submitRetryUsed,
                submitRetryPromptSnippet: this.submitRetryPromptSnippet,
            },
        };
    }

    getRuntimeMetadata(): PtyRuntimeMetadata | null {
        if (!this.ptyProcess || typeof this.ptyProcess.getMetadata !== 'function') return null;
        return this.ptyProcess.getMetadata();
    }

    updateRuntimeMeta(meta: Record<string, unknown>, replace = false): void {
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
        const wasProcessing = this.currentStatus === 'generating' || this.currentStatus === 'waiting_approval';

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
                if (!this.ptyProcess || this.currentStatus === 'stopped') {
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
        this.clearIdleFinishCandidate('shutdown');
        this.clearAllTimers();
        this.pendingOutputParseChunks = [];
        this.pendingTerminalQueryTail = '';
        this.ptyOutputChunks = [];
        this.finishRetryCount = 0;
        if (this.pendingOutboundFlushTimer) { clearTimeout(this.pendingOutboundFlushTimer); this.pendingOutboundFlushTimer = null; }
        this.pendingOutboundQueue = [];
        this.pendingOutboundFlushInFlight = false;
        if (this.ptyProcess) {
            this.ptyProcess.write('\x03');
            setTimeout(() => {
                try { this.ptyProcess?.kill(); } catch { }
                this.ptyProcess = null;
                this.setStatus('stopped', 'stop_cmd');
                this.ready = false;
                this.startupParseGate = false;
                this.spawnAt = 0;
                this.onStatusChange?.();
            }, this.timeouts.shutdownGrace);
        }
    }

    detach(): void {
        this.clearIdleFinishCandidate('detach');
        this.clearAllTimers();
        this.pendingOutputParseChunks = [];
        this.pendingTerminalQueryTail = '';
        this.ptyOutputChunks = [];
        this.finishRetryCount = 0;
        if (this.pendingOutboundFlushTimer) { clearTimeout(this.pendingOutboundFlushTimer); this.pendingOutboundFlushTimer = null; }
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
        this.clearIdleFinishCandidate('clear_history');
        this.accumulatedBuffer = '';
        this.accumulatedRawBuffer = '';
        this.currentTurnScope = null;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        if (this.pendingOutputParseTimer) { clearTimeout(this.pendingOutputParseTimer); this.pendingOutputParseTimer = null; }
        this.pendingOutputParseChunks = [];
        this.pendingTerminalQueryTail = '';
        if (this.ptyOutputFlushTimer) { clearTimeout(this.ptyOutputFlushTimer); this.ptyOutputFlushTimer = null; }
        this.ptyOutputChunks = [];
        if (this.finishRetryTimer) { clearTimeout(this.finishRetryTimer); this.finishRetryTimer = null; }
        this.finishRetryCount = 0;
        if (this.pendingOutboundFlushTimer) { clearTimeout(this.pendingOutboundFlushTimer); this.pendingOutboundFlushTimer = null; }
        this.pendingOutboundQueue = [];
        this.pendingOutboundFlushInFlight = false;
        this.resetTerminalScreen();
        this.ptyProcess?.clearBuffer?.();
        this.onStatusChange?.();
    }

    isProcessing(): boolean { return this.isWaitingForResponse; }
    isReady(): boolean { return this.ready; }

    async writeRaw(data: string): Promise<void> {
        this.recordTrace('write_raw', {
            keys: JSON.stringify(data),
            length: data.length,
        });
        await this.writeToPty(data);
    }

    resolveModal(buttonIndex: number): void {
        let modal = this.activeModal || this.runParseApproval(this.recentOutputBuffer);
        if (!modal && typeof this.cliScripts?.parseSession === 'function') {
            try {
                const parsed = this.getScriptParsedStatus();
                const parsedModal = parsed?.activeModal && Array.isArray(parsed.activeModal.buttons)
                    && parsed.activeModal.buttons.some((button: any) => typeof button === 'string' && button.trim())
                    ? parsed.activeModal
                    : null;
                if (parsed?.status === 'waiting_approval' && parsedModal) {
                    modal = parsedModal;
                    this.activeModal = parsedModal;
                    if (this.currentStatus !== 'waiting_approval') {
                        this.setStatus('waiting_approval', 'resolve_modal_parse');
                        this.onStatusChange?.();
                    }
                }
            } catch {
                // Ignore parse failures here; resolveModal falls back to current state.
            }
        }
        if (!this.ptyProcess || ((this.currentStatus !== 'waiting_approval') && !modal)) return;
        this.clearIdleFinishCandidate('resolve_modal');
        this.recordTrace('resolve_modal', {
            buttonIndex,
            activeModal: modal,
        });
        this.activeModal = null;
        this.lastApprovalResolvedAt = Date.now();
        this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
        if (this.approvalExitTimeout) {
            clearTimeout(this.approvalExitTimeout);
            this.approvalExitTimeout = null;
        }
        this.setStatus('generating', 'approval_resolved');
        this.onStatusChange?.();
        if (buttonIndex in this.approvalKeys) {
            this.ptyProcess.write(this.approvalKeys[buttonIndex]);
        } else {
            const buttonCount = Array.isArray(modal?.buttons) ? modal.buttons.length : 0;
            const clampedIndex = buttonCount > 0
                ? Math.min(Math.max(0, buttonIndex), buttonCount - 1)
                : Math.max(0, buttonIndex);
            const DOWN = '\x1B[B';
            const keys = DOWN.repeat(clampedIndex) + '\r';
            this.ptyProcess.write(keys);
        }
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
        if (this.startupParseGate || typeof this.cliScripts?.parseSession !== 'function') return null;
        try {
            const parsed = this.getScriptParsedStatus();
            return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
        } catch {
            return null;
        }
    }

    getDebugState(): Record<string, any> {
        const screenText = sanitizeTerminalText(this.terminalScreen.getText());
        const startupModal = this.startupParseGate ? this.runParseApproval(this.recentOutputBuffer) : null;
        const startupDetectedStatus = this.startupParseGate && !startupModal
            ? this.runDetectStatus(this.recentOutputBuffer || screenText)
            : null;
        const effectiveReady = this.ready || !!startupModal || startupDetectedStatus === 'waiting_approval';
        const parsedDebugState = this.getParsedDebugState();
        const parsedMessages = Array.isArray(parsedDebugState?.messages) ? parsedDebugState.messages : [];
        let effectiveStatus = this.projectEffectiveStatus(startupModal);
        if (parsedDebugState?.status === 'error') {
            effectiveStatus = 'error';
        }
        if (startupDetectedStatus === 'waiting_approval') {
            effectiveStatus = 'waiting_approval';
        }
        if (
            effectiveStatus === 'idle'
            && parsedDebugState?.status === 'generating'
            && !this.parsedStatusHasFinalAssistantMessage(parsedDebugState)
        ) {
            effectiveStatus = 'generating';
        }
        return {
            type: this.cliType,
            name: this.cliName,
            providerResolution: this.providerResolutionMeta,
            status: effectiveStatus,
            projectedStatus: effectiveStatus,
            rawStatus: this.currentStatus,
            lifecycleStatus: this.isWaitingForResponse ? 'awaiting_response' : 'idle',
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
            currentTurnScope: this.currentTurnScope,
            startupBuffer: this.startupBuffer.slice(-4000),
            recentOutputBuffer: this.recentOutputBuffer.slice(-500),
            settledBuffer: this.settledBuffer.slice(-500),
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
            isWaitingForResponse: this.isWaitingForResponse,
            activeModal: startupModal || this.activeModal,
            lastApprovalResolvedAt: this.lastApprovalResolvedAt,
            sendDelayMs: this.sendDelayMs,
            sendKey: this.sendKey,
            submitStrategy: this.submitStrategy,
            requirePromptEchoBeforeSubmit: this.requirePromptEchoBeforeSubmit,
            submitPendingUntil: this.submitPendingUntil,
            responseSettleIgnoreUntil: this.responseSettleIgnoreUntil,
            resizeSuppressUntil: this.resizeSuppressUntil,
            hasCliScripts: this.hasCliScripts(),
            scriptNames: listCliScriptNames(this.cliScripts),
            traceSessionId: this.traceSessionId,
            traceEntryCount: this.traceEntries.length,
            statusHistory: this.statusHistory.slice(-30),
            timeouts: this.timeouts,
            pendingOutputParseBufferLength: this.pendingOutputParseChunks.reduce((total, chunk) => total + chunk.length, 0),
            pendingOutputParseScheduled: !!this.pendingOutputParseTimer,
            ptyAlive: !!this.ptyProcess,
        };
    }

    getTraceState(limit = 120): Record<string, any> {
        const cappedLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 120));
        return {
            sessionId: this.traceSessionId,
            providerResolution: this.providerResolutionMeta,
            entryCount: this.traceEntries.length,
            entries: this.traceEntries.slice(-cappedLimit),
            screenText: summarizeCliTraceText(this.terminalScreen.getText(), 4000),
            recentOutputBuffer: summarizeCliTraceText(this.recentOutputBuffer, 1000),
            responseBuffer: summarizeCliTraceText(this.responseBuffer, 1200),
            status: this.projectEffectiveStatus(),
            projectedStatus: this.projectEffectiveStatus(),
            rawStatus: this.currentStatus,
            lifecycleStatus: this.isWaitingForResponse ? 'awaiting_response' : 'idle',
            activeModal: this.activeModal,
            currentTurnScope: this.currentTurnScope,
            messages: [],
        };
    }

    getProviderResolutionMeta(): ProviderResolutionMeta {
        return { ...this.providerResolutionMeta };
    }
}
