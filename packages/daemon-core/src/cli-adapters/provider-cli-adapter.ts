/**
 * ProviderCliAdapter — Script-based CLI Adapter
 *
 * All CLI providers use versioned scripts (like IDE providers).
 * Scripts are Node.js functions that receive PTY buffer data and return structured results.
 *
 * Required scripts in scripts/{version}/scripts.js:
 *   - detectStatus(input)  → AgentStatus string ('idle' | 'generating' | 'waiting_approval')
 *   - parseOutput(input)   → ReadChatResult { messages, status, activeModal, ... }
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
    getLastUserPromptText,
    listCliScriptNames,
    normalizePromptText,
    normalizeScreenSnapshot,
    promptLikelyVisible,
    sanitizeTerminalText,
    trimPromptEchoPrefix,
    type CliChatMessage,
    type CliProviderModule,
    type CliScriptInput,
    type CliScripts,
    type CliSessionStatus,
    type CliTraceEntry,
} from './provider-cli-shared.js';
import { buildChatMessage } from '../providers/chat-message-normalization.js';
import { validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import {
    buildCliParseInput,
    buildCliTraceParseSnapshot,
    hydrateCliParsedMessages,
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

type SeedCliChatMessage = Omit<Partial<CliChatMessage>, 'role'> & {
    role?: string;
    content?: string;
};

interface IdleFinishCandidate {
    armedAt: number;
    lastOutputAt: number;
    lastScreenChangeAt: number;
    responseEpoch: number;
    assistantLength: number;
}

interface SettledEvalContext {
    now: number;
    screenText: string;
    modal: any;
    scriptStatus: string;
    parsedTranscript: any;
    parsedMessages: CliChatMessage[];
    lastParsedAssistant: CliChatMessage | undefined;
    parsedShowsLiveAssistantProgress: boolean;
    prevStatus: string;
}

function normalizeComparableTranscriptText(value: unknown): string {
    return sanitizeTerminalText(String(value || ''))
        .replace(/\s+/g, ' ')
        .trim();
}

function hasVisibleInterruptPrompt(text: string): boolean {
    const interruptCopyPattern = /\bEnter\s+to\s+interrupt\b(?:\s*,?\s*Ctrl\s*(?:\+|-)?\s*C\s+to\s+cancel)?/i;
    return sanitizeTerminalText(text || '')
        .split(/\r?\n/g)
        .some((line) => {
            const trimmed = line.trim();
            if (!interruptCopyPattern.test(trimmed)) return false;
            return /^(?:[^A-Za-z0-9\s]{1,8}\s+)?[❯›>]\s+/.test(trimmed);
        });
}

function parsedTranscriptIsRicherThanCommitted(
    parsedMessages: Array<{ role?: string; content?: unknown; id?: string; index?: number }> | null | undefined,
    committedMessages: Array<{ role?: string; content?: unknown; id?: string; index?: number }> | null | undefined,
): boolean {
    if (!Array.isArray(parsedMessages) || !Array.isArray(committedMessages)) return false;
    if (parsedMessages.length > committedMessages.length) return true;
    if (parsedMessages.length !== committedMessages.length) return false;

    for (let index = 0; index < parsedMessages.length; index += 1) {
        const parsed = parsedMessages[index];
        const committed = committedMessages[index];
        if (!parsed || !committed) return false;
        if ((parsed.role || '') !== (committed.role || '')) return false;
        if (parsed.id && committed.id && String(parsed.id) !== String(committed.id)) return false;
        if (typeof parsed.index === 'number' && typeof committed.index === 'number' && parsed.index !== committed.index) return false;

        const parsedText = normalizeComparableTranscriptText(parsed.content);
        const committedText = normalizeComparableTranscriptText(committed.content);
        if (!parsedText || !committedText || parsedText === committedText) continue;
        if (parsedText.length > committedText.length && parsedText.startsWith(committedText)) return true;
        return false;
    }

    return false;
}

// ─── Adapter ────────────────────────────────────────

export class ProviderCliAdapter implements CliAdapter {
    readonly cliType: string;
    readonly cliName: string;
    public workingDir: string;

    private provider: CliProviderModule;
    private ptyProcess: PtyRuntimeTransport | null = null;
    private transportFactory: PtyTransportFactory;
    private messages: CliChatMessage[] = [];
    private committedMessages: CliChatMessage[] = [];
    private structuredMessages: CliChatMessage[] = [];
    private currentStatus: CliSessionStatus['status'] = 'starting';
    private onStatusChange: (() => void) | null = null;

    private responseBuffer = '';
    private recentOutputBuffer = '';
    private isWaitingForResponse = false;
    private activeModal: { message: string; buttons: string[] } | null = null;
    private parseErrorMessage: string | null = null;
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
    private pendingOutputParseBuffer = '';
    private pendingOutputParseTimer: NodeJS.Timeout | null = null;
    private ptyOutputBuffer = '';
    private ptyOutputFlushTimer: NodeJS.Timeout | null = null;
    private pendingTerminalQueryTail = '';
    private lastOutputAt = 0;
    private lastNonEmptyOutputAt = 0;
    private lastScreenChangeAt = 0;
    private lastScreenSnapshot = '';

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

 // Resize redraw suppression
    private resizeSuppressUntil: number = 0;

 // Debug: status transition history
    private statusHistory: { status: string; at: number; trigger?: string }[] = [];

    // ─── CLI Scripts (script-based parsing) ───
    private cliScripts: CliScripts;
    private runtimeSettings: Record<string, any> = {};
    /** Full accumulated ANSI-stripped PTY output */
    private accumulatedBuffer: string = '';
    /** Full accumulated raw PTY output (with ANSI) */
    private accumulatedRawBuffer: string = '';
    /** Current visible terminal screen snapshot */
    private terminalScreen = new TerminalScreen(24, 80);
    /** Max accumulated buffer size. Sized to comfortably hold a single long
     *  Hermes turn (tool calls + reasoning + final bubble) without the
     *  rolling window pushing the turn's ╭─ opening line out of view. */
    private static readonly MAX_ACCUMULATED_BUFFER = 262144;
    private currentTurnScope: TurnParseScope | null = null;
    private traceEntries: CliTraceEntry[] = [];
    private traceSeq = 0;
    private traceSessionId = '';
    private parsedStatusCache: {
        committedMessagesRef: CliChatMessage[];
        responseBuffer: string;
        currentTurnScope: TurnParseScope | null;
        recentOutputBuffer: string;
        accumulatedBuffer: string;
        accumulatedRawBuffer: string;
        screenText: string;
        currentStatus: CliSessionStatus['status'];
        activeModal: { message: string; buttons: string[] } | null;
        cliName: string;
        lastOutputAt: number;
        result: any;
    } | null = null;
    private static readonly MAX_TRACE_ENTRIES = 250;

    private readonly providerResolutionMeta: ProviderResolutionMeta;
    private static readonly FINISH_RETRY_DELAY_MS = 300;
    private static readonly MAX_FINISH_RETRIES = 2;

    private syncMessageViews(): void {
        this.messages = [...this.committedMessages];
        this.structuredMessages = [...this.committedMessages];
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
    private static readonly SCRIPT_STATUS_DEBOUNCE_MS = 3000;

    constructor(
        provider: CliProviderModule,
        workingDir: string,
        private extraArgs: string[] = [],
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
        this.providerResolutionMeta = resolvedConfig.providerResolutionMeta;

        // Scripts are required — loaded by ProviderLoader via compatibility array
        this.cliScripts = provider.scripts || {};
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
        const scriptNames = listCliScriptNames(scripts);
        LOG.info('CLI', `[${this.cliType}] CLI scripts injected: [${scriptNames.join(', ')}]`);
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
        if (!this.pendingOutputParseBuffer) return;
        const rawData = this.pendingOutputParseBuffer;
        this.pendingOutputParseBuffer = '';
        this.handleOutput(rawData);
    }

    async spawn(): Promise<void> {
        if (this.ptyProcess) return;

        const spawnPlan = resolveCliSpawnPlan({
            provider: this.provider,
            runtimeSettings: this.runtimeSettings,
            workingDir: this.workingDir,
            extraArgs: this.extraArgs,
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

            this.pendingOutputParseBuffer += data;
            if (!this.pendingOutputParseTimer) {
                this.pendingOutputParseTimer = setTimeout(() => {
                    this.pendingOutputParseTimer = null;
                    this.flushPendingOutputParse();
                }, this.timeouts.ptyFlush);
            }

            if (this.onPtyDataCallback) {
                this.ptyOutputBuffer += data;
                if (!this.ptyOutputFlushTimer) {
                    this.ptyOutputFlushTimer = setTimeout(() => {
                        if (this.ptyOutputBuffer && this.onPtyDataCallback) {
                            this.onPtyDataCallback(this.ptyOutputBuffer);
                        }
                        this.ptyOutputBuffer = '';
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
            this.onStatusChange?.();
        });

        this.spawnAt = Date.now();
        this.startupParseGate = true;
        this.startupBuffer = '';
        this.startupFirstOutputAt = 0;
        if (this.startupSettleTimer) { clearTimeout(this.startupSettleTimer); this.startupSettleTimer = null; }
        this.terminalScreen.reset(24, 80);
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
        const now = Date.now();
        const screenText = this.terminalScreen.getText();
        const normalizedScreenSnapshot = normalizeScreenSnapshot(screenText);
        this.lastOutputAt = now;
        if (cleanData.trim()) this.lastNonEmptyOutputAt = now;
        if (normalizedScreenSnapshot !== this.lastScreenSnapshot) {
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
            this.responseBuffer = (this.responseBuffer + cleanData).slice(-8000);
        }

        // Server log forwarding
        if (cleanData.trim()) {
            if (this.serverConn) {
                this.serverConn.sendMessage('log', { message: cleanData.trim(), level: 'info' });
            } else {
                this.logBuffer.push({ message: cleanData.trim(), level: 'info' });
            }
        }

        // Rolling buffers
        this.recentOutputBuffer = (this.recentOutputBuffer + cleanData).slice(-1000);
        const prevAccumulatedLen = this.accumulatedBuffer.length;
        const prevAccumulatedRawLen = this.accumulatedRawBuffer.length;
        this.accumulatedBuffer = (this.accumulatedBuffer + cleanData).slice(-ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);
        this.accumulatedRawBuffer = (this.accumulatedRawBuffer + rawData).slice(-ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);
        // Keep turn-scope offsets aligned with the truncated buffer so scoped
        // parses don't lose the beginning of a long turn (e.g. the Hermes
        // ╭─ opening line) when the rolling window sheds bytes.
        if (this.currentTurnScope) {
            const droppedClean = (prevAccumulatedLen + cleanData.length) - this.accumulatedBuffer.length;
            const droppedRaw = (prevAccumulatedRawLen + rawData.length) - this.accumulatedRawBuffer.length;
            if (droppedClean > 0) {
                this.currentTurnScope.bufferStart = Math.max(0, this.currentTurnScope.bufferStart - droppedClean);
            }
            if (droppedRaw > 0) {
                this.currentTurnScope.rawBufferStart = Math.max(0, this.currentTurnScope.rawBufferStart - droppedRaw);
            }
        }

        this.resolveStartupState('output');

        // ─── Script-based status detection
        this.scheduleSettle();
    }

    private resolveStartupState(trigger: string): void {
        if (!this.startupParseGate) return;

        const now = Date.now();
        const screenText = this.terminalScreen.getText() || '';
        const normalizedScreen = normalizeScreenSnapshot(screenText);
        const hasStartupOutput = !!this.startupFirstOutputAt || !!normalizedScreen.trim();
        if (!hasStartupOutput) return;

        const stableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : 0;
        if (stableMs < 2000) return;

        const startupModal = this.runParseApproval(this.recentOutputBuffer);
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
            if (this.currentStatus !== 'waiting_approval') return;
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
        if (this.currentStatus === 'waiting_approval' || this.activeModal) return false;
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
        if (!this.isWaitingForResponse || this.currentStatus === 'waiting_approval') {
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

    private trimLastAssistantEcho(messages: CliChatMessage[], prompt: string | undefined): void {
        if (!prompt) return;
        const last = [...messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string');
        if (last) last.content = trimPromptEchoPrefix(last.content, prompt);
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
        const tail = this.settledBuffer;
        const screenText = this.terminalScreen.getText() || '';
        this.resolveStartupState('settled');
        if (this.startupParseGate) {
            return;
        }
        const parsedTranscript = this.parseCurrentTranscript(
            this.committedMessages,
            this.responseBuffer,
            this.currentTurnScope,
        );
        const parsedModal = parsedTranscript?.activeModal && Array.isArray(parsedTranscript.activeModal.buttons) && parsedTranscript.activeModal.buttons.some((button: any) => typeof button === 'string' && button.trim())
            ? parsedTranscript.activeModal
            : null;
        const modal = this.runParseApproval(tail) || parsedModal;
        const rawScriptStatus = this.runDetectStatus(tail);
        const scriptStatus = parsedTranscript?.status === 'waiting_approval' && modal
            ? 'waiting_approval'
            : rawScriptStatus;
        const parsedMessages = Array.isArray(parsedTranscript?.messages)
            ? normalizeCliParsedMessages(parsedTranscript.messages, {
                committedMessages: this.committedMessages,
                scope: this.currentTurnScope,
                lastOutputAt: this.lastOutputAt,
            })
            : [];
        if (this.maybeCommitVisibleIdleTranscript(parsedTranscript)) {
            return;
        }
        const lastParsedAssistant = [...parsedMessages].reverse().find((message) => message.role === 'assistant');
        const parsedShowsLiveAssistantProgress = parsedTranscript?.status === 'generating'
            && !!lastParsedAssistant
            && parsedMessages.length > this.committedMessages.length;
        const normalizedPromptSnippet = normalizePromptText(this.submitRetryPromptSnippet || this.currentTurnScope?.prompt || '');
        this.recordTrace('settled', {
            tail: summarizeCliTraceText(tail, 500),
            screenText: summarizeCliTraceText(screenText, 1200),
            detectStatus: scriptStatus,
            parsedStatus: parsedTranscript?.status || null,
            parsedMessageCount: parsedMessages.length,
            parsedLastAssistant: lastParsedAssistant ? summarizeCliTraceText(lastParsedAssistant.content, 280) : '',
            parsedActiveModal: parsedTranscript?.activeModal ?? null,
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
            && this.currentStatus !== 'waiting_approval'
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
            LOG.info(
                'CLI',
                `[${this.cliType}] Settled without assistant: prompt=${JSON.stringify(this.currentTurnScope.prompt).slice(0, 140)} responseBuffer=${JSON.stringify(summarizeCliTraceText(this.responseBuffer, 220)).slice(0, 260)} screen=${JSON.stringify(summarizeCliTraceText(screenText, 220)).slice(0, 260)} providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'}`
            );
        }
        if (!scriptStatus) return;

        const prevStatus = this.currentStatus;
        const ctx: SettledEvalContext = { now, screenText, modal, scriptStatus, parsedTranscript, parsedMessages, lastParsedAssistant, parsedShowsLiveAssistantProgress, prevStatus };

        if (!this.applyPendingScriptStatusDebounce(ctx)) return;

        const recentInteractiveActivity = this.hasRecentInteractiveActivity(now);
        LOG.info(
            'CLI',
            `[${this.cliType}] settled diagnostics prompt=${JSON.stringify(this.currentTurnScope?.prompt || '').slice(0, 140)} scriptStatus=${String(scriptStatus || '')} parsedStatus=${String(parsedTranscript?.status || '')} parsedMsgCount=${parsedMessages.length} lastParsedAssistant=${JSON.stringify(summarizeCliTraceText(lastParsedAssistant?.content || '', 120)).slice(0, 160)} responseBuffer=${JSON.stringify(summarizeCliTraceText(this.responseBuffer, 160)).slice(0, 220)} screen=${JSON.stringify(summarizeCliTraceText(screenText, 160)).slice(0, 220)}`
        );

        const shouldHoldGenerating =
            scriptStatus === 'idle'
            && this.isWaitingForResponse
            && !modal
            && recentInteractiveActivity
            && !(parsedTranscript?.status === 'idle' && !!lastParsedAssistant);

        if (shouldHoldGenerating) {
            this.applyHoldGenerating(ctx, recentInteractiveActivity);
            return;
        }

        if (scriptStatus === 'waiting_approval') {
            this.applyWaitingApproval(ctx);
            return;
        }

        if (scriptStatus === 'generating') {
            this.applyGenerating(ctx);
            return;
        }

        if (scriptStatus === 'idle') {
            this.applyIdle(ctx, now);
        }
    }

    // Returns false if the caller should bail out (debounce pending).
    private applyPendingScriptStatusDebounce(ctx: SettledEvalContext): boolean {
        const { now, scriptStatus, prevStatus } = ctx;
        const shouldDebounce =
            prevStatus === 'idle'
            && !this.isWaitingForResponse
            && !this.currentTurnScope
            && (scriptStatus === 'generating' || scriptStatus === 'waiting_approval');

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

        if (this.pendingScriptStatus !== scriptStatus) {
            this.pendingScriptStatus = scriptStatus as 'generating' | 'waiting_approval';
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
        const { scriptStatus } = ctx;
        this.clearIdleFinishCandidate('hold_generating_recent_activity');
        this.setStatus('generating', 'recent_activity_hold');
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.isWaitingForResponse && this.currentStatus !== 'waiting_approval') {
                if (this.shouldDeferIdleTimeoutFinish()) return;
                this.finishResponse();
            }
        }, this.timeouts.generatingIdle);
        this.recordTrace('hold_generating_recent_activity', {
            scriptStatus,
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
                this.setStatus('generating', inCooldown ? 'approval_cooldown_ignore' : 'approval_prompt_gone');
                if (this.idleTimeout) clearTimeout(this.idleTimeout);
                this.idleTimeout = setTimeout(() => {
                    if (this.isWaitingForResponse && this.currentStatus !== 'waiting_approval') {
                        if (this.shouldDeferIdleTimeoutFinish()) return;
                        this.finishResponse();
                    }
                }, this.timeouts.generatingIdle);
            } else {
                this.setStatus('idle', inCooldown ? 'approval_cooldown_ignore' : 'approval_prompt_gone');
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
        const { screenText, modal, parsedShowsLiveAssistantProgress, prevStatus } = ctx;
        this.clearIdleFinishCandidate('generating');
        const effectiveScreenText = screenText || this.accumulatedBuffer;
        const noActiveTurn = !this.currentTurnScope;
        const looksIdleChrome = /(^|\n)\s*[❯›>]\s*(?:\n|$)/m.test(effectiveScreenText)
            || (/accept edits on/i.test(effectiveScreenText)
                && (/Update available!/i.test(screenText)
                    || /\/effort/i.test(screenText)
                    || /^.*➜\s+\S+/m.test(effectiveScreenText)));
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

    private applyIdle(ctx: SettledEvalContext, now: number): void {
        const { screenText, modal, lastParsedAssistant, prevStatus } = ctx;
        if (prevStatus === 'waiting_approval') {
            if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
            this.activeModal = null;
            this.lastApprovalResolvedAt = Date.now();
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
            if (this.isWaitingForResponse && this.currentStatus !== 'waiting_approval') {
                if (this.shouldDeferIdleTimeoutFinish()) return;
                this.clearIdleFinishCandidate('idle_timeout_finish');
                this.finishResponse();
            }
        }, this.timeouts.idleFinish);
    }

    private finishResponse(): void {
        if (this.submitPendingUntil > Date.now()) return;
        if (this.responseSettleIgnoreUntil > Date.now()) return;
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
                if (this.isWaitingForResponse && this.currentStatus !== 'waiting_approval') {
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
    }

    private maybeCommitVisibleIdleTranscript(parsed: any): boolean {
        const allowImmediateScriptIdleCommit = this.provider.allowInputDuringGeneration === true;
        if (!allowImmediateScriptIdleCommit) return false;
        if (
            !parsed
            || !Array.isArray(parsed.messages)
            || parsed.status !== 'idle'
            || !this.isWaitingForResponse
            || !this.currentTurnScope
            || this.activeModal
            || parsed.activeModal
        ) {
            return false;
        }

        const hydratedForIdleCommit = normalizeCliParsedMessages(parsed.messages, {
            committedMessages: this.committedMessages,
            scope: this.currentTurnScope,
            lastOutputAt: this.lastOutputAt,
        });
        const visibleAssistant = [...hydratedForIdleCommit].reverse().find((message) => message.role === 'assistant' && message.content.trim());
        if (!visibleAssistant) return false;

        this.committedMessages = hydratedForIdleCommit;
        this.trimLastAssistantEcho(this.committedMessages, this.currentTurnScope?.prompt || getLastUserPromptText(this.committedMessages));
        this.clearAllTimers();
        this.syncMessageViews();
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
        this.recordTrace('script_idle_commit', {
            messageCount: this.committedMessages.length,
            lastAssistant: summarizeCliTraceText(visibleAssistant.content, 320),
        });
        return true;
    }

    private commitCurrentTranscript(): { hasAssistant: boolean; assistantContent: string } {
        const parsed = this.parseCurrentTranscript(
            this.committedMessages,
            this.responseBuffer,
            this.currentTurnScope,
        );
        if (parsed && Array.isArray(parsed.messages)) {
            this.committedMessages = normalizeCliParsedMessages(parsed.messages, {
                committedMessages: this.committedMessages,
                scope: this.currentTurnScope,
                lastOutputAt: this.lastOutputAt,
            });
            this.trimLastAssistantEcho(this.committedMessages, this.currentTurnScope?.prompt || getLastUserPromptText(this.committedMessages));
            this.syncMessageViews();
            const lastAssistant = [...this.committedMessages].reverse().find((message) => message.role === 'assistant');
            if (this.currentTurnScope) {
                LOG.info(
                    'CLI',
                    `[${this.cliType}] commitCurrentTranscript committedMessages=${this.committedMessages.length} finalLastAssistant=${JSON.stringify(summarizeCliTraceText(lastAssistant?.content || '', 220)).slice(0, 260)}`
                );
            }
            this.recordTrace('commit_transcript', {
                parsedStatus: parsed.status || null,
                messageCount: this.committedMessages.length,
                lastAssistant: lastAssistant ? summarizeCliTraceText(lastAssistant.content, 320) : '',
                messages: summarizeCliTraceMessages(this.committedMessages),
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

    private runDetectStatus(text: string): string | null {
        if (!this.cliScripts?.detectStatus) return null;
        try {
            const screenText = this.terminalScreen.getText();
            const status = this.cliScripts.detectStatus({
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
            return this.cliScripts.parseApproval({
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

    private projectEffectiveStatus(startupModal: { message: string; buttons: string[] } | null = null): CliSessionStatus['status'] {
        if (this.parseErrorMessage) return 'error';
        if (startupModal || this.activeModal) return 'waiting_approval';
        if (this.isWaitingForResponse && this.currentTurnScope && this.currentStatus === 'idle') return 'generating';
        return this.currentStatus;
    }

    private suppressStaleParsedApproval(
        parsed: any,
        recentBuffer: string,
        screenText: string,
    ): any {
        const actionableParsedModal = parsed?.activeModal && Array.isArray(parsed.activeModal.buttons)
            && parsed.activeModal.buttons.some((button: any) => typeof button === 'string' && button.trim())
            ? parsed.activeModal
            : null;
        if (!parsed || parsed?.status !== 'waiting_approval' || !actionableParsedModal) {
            return parsed;
        }

        const inApprovalCooldown = this.lastApprovalResolvedAt > 0
            && (Date.now() - this.lastApprovalResolvedAt) < this.timeouts.approvalCooldown;
        if (!inApprovalCooldown) {
            return parsed;
        }

        const visibleModal = this.runParseApproval(recentBuffer);
        if (visibleModal) {
            return parsed;
        }

        const detectedStatus = this.runDetectStatus(recentBuffer);
        const resolvedStatus = detectedStatus && detectedStatus !== 'waiting_approval'
            ? detectedStatus
            : ((this.isWaitingForResponse || this.currentTurnScope) ? 'generating' : (this.currentStatus === 'waiting_approval' ? 'idle' : this.currentStatus));
        return {
            ...parsed,
            status: resolvedStatus,
            activeModal: null,
        };
    }

 // ─── Public API (CliAdapter) ───────────────────

    getStatus(): CliSessionStatus {
        const startupModal = this.startupParseGate ? this.runParseApproval(this.recentOutputBuffer) : null;
        let effectiveStatus = this.projectEffectiveStatus(startupModal);
        let effectiveModal = startupModal || this.activeModal;
        if (!startupModal && !effectiveModal && typeof this.cliScripts?.parseOutput === 'function') {
            try {
                const parsed = this.getScriptParsedStatus();
                const parsedModal = parsed?.activeModal && Array.isArray(parsed.activeModal.buttons)
                    && parsed.activeModal.buttons.some((button: any) => typeof button === 'string' && button.trim())
                    ? parsed.activeModal
                    : null;
                if (parsed?.status === 'waiting_approval' && parsedModal) {
                    effectiveStatus = 'waiting_approval';
                    effectiveModal = parsedModal;
                }
            } catch {
                // Ignore parse errors here; getScriptParsedStatus surfaces them on richer callers.
            }
        }
        return {
            status: effectiveStatus,
            messages: [...this.committedMessages],
            workingDir: this.workingDir,
            activeModal: effectiveModal,
            errorMessage: this.parseErrorMessage || undefined,
            errorReason: this.parseErrorMessage ? 'parse_error' : undefined,
        };
    }

    seedCommittedMessages(messages: SeedCliChatMessage[]): void {
        const normalized = (Array.isArray(messages) ? messages : [])
            .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
            .map((message) => ({
                role: message.role as 'user' | 'assistant',
                content: typeof message.content === 'string' ? message.content : String(message.content || ''),
                timestamp: typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
                    ? message.timestamp
                    : undefined,
                receivedAt: typeof message.receivedAt === 'number' && Number.isFinite(message.receivedAt)
                    ? message.receivedAt
                    : undefined,
                kind: typeof message.kind === 'string' ? message.kind : undefined,
                id: typeof message.id === 'string' ? message.id : undefined,
                index: typeof message.index === 'number' ? message.index : undefined,
                meta: message.meta && typeof message.meta === 'object' ? { ...(message.meta as Record<string, any>) } : undefined,
                senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
            }));
        this.committedMessages = normalized;
        this.syncMessageViews();
    }

    /**
     * Script-based full parse — returns ReadChatResult.
     * Called by command handler / dashboard for rich content rendering.
     */
    getScriptParsedStatus(): any {
        const screenText = this.terminalScreen.getText();
        const cached = this.parsedStatusCache;
        if (
            cached
            && cached.committedMessagesRef === this.committedMessages
            && cached.responseBuffer === this.responseBuffer
            && cached.currentTurnScope === this.currentTurnScope
            && cached.recentOutputBuffer === this.recentOutputBuffer
            && cached.accumulatedBuffer === this.accumulatedBuffer
            && cached.accumulatedRawBuffer === this.accumulatedRawBuffer
            && cached.screenText === screenText
            && cached.currentStatus === this.currentStatus
            && cached.activeModal === this.activeModal
            && cached.cliName === this.cliName
            && cached.lastOutputAt === this.lastOutputAt
        ) {
            return cached.result;
        }

        const parsed = this.parseCurrentTranscript(
            this.committedMessages,
            this.responseBuffer,
            this.currentTurnScope,
            screenText,
        );
        const parsedModal = parsed?.activeModal && Array.isArray(parsed.activeModal.buttons)
            && parsed.activeModal.buttons.some((button: any) => typeof button === 'string' && button.trim())
            ? parsed.activeModal
            : null;
        if (parsedModal && parsed?.status === 'waiting_approval') {
            this.activeModal = parsedModal;
            this.isWaitingForResponse = true;
            if (this.currentStatus !== 'waiting_approval') {
                this.setStatus('waiting_approval', 'parsed_waiting_approval');
                this.onStatusChange?.();
            }
        }
        if (this.maybeCommitVisibleIdleTranscript(parsed)) {
            return this.getScriptParsedStatus();
        }
        const shouldPreferCommittedMessages =
            !this.currentTurnScope
            && !this.activeModal
            && this.currentStatus === 'idle';
        let result: any;
        if (parsed && Array.isArray(parsed.messages)) {
            const parsedHydratedMessages = hydrateCliParsedMessages(parsed.messages, {
                committedMessages: this.committedMessages,
                scope: this.currentTurnScope,
                lastOutputAt: this.lastOutputAt,
            });
            const committedHydratedMessages = this.committedMessages.map((message, index) => buildChatMessage({
                ...message,
                id: message.id || `msg_${index}`,
                index: typeof message.index === 'number' ? message.index : index,
                receivedAt: typeof message.receivedAt === 'number'
                    ? message.receivedAt
                    : message.timestamp,
            }));
            const parsedLastAssistant = [...parsedHydratedMessages].reverse().find((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim());
            const shouldAdoptParsedIdleReplay =
                !this.currentTurnScope
                && !this.activeModal
                && !!parsedLastAssistant
                && parsedTranscriptIsRicherThanCommitted(parsedHydratedMessages, committedHydratedMessages)
                && (
                    this.currentStatus === 'idle'
                    || (
                        this.currentStatus === 'generating'
                        && this.isWaitingForResponse
                        && parsed.status === 'idle'
                        && this.runDetectStatus(this.recentOutputBuffer) === 'idle'
                    )
                );
            if (shouldAdoptParsedIdleReplay) {
                this.committedMessages = normalizeCliParsedMessages(parsed.messages, {
                    committedMessages: this.committedMessages,
                    scope: this.currentTurnScope,
                    lastOutputAt: this.lastOutputAt,
                });
                this.syncMessageViews();
                if (this.currentStatus !== 'idle' || this.isWaitingForResponse) {
                    this.responseBuffer = '';
                    this.isWaitingForResponse = false;
                    this.responseSettleIgnoreUntil = 0;
                    this.submitRetryUsed = false;
                    this.submitRetryPromptSnippet = '';
                    this.finishRetryCount = 0;
                    this.currentTurnScope = null;
                    this.activeModal = null;
                    this.setStatus('idle', 'parsed_idle_replay_commit');
                    this.onStatusChange?.();
                }
            }
            const effectiveCommittedHydratedMessages = shouldAdoptParsedIdleReplay
                ? this.committedMessages.map((message, index) => buildChatMessage({
                    ...message,
                    id: message.id || `msg_${index}`,
                    index: typeof message.index === 'number' ? message.index : index,
                    receivedAt: typeof message.receivedAt === 'number'
                        ? message.receivedAt
                        : message.timestamp,
                }))
                : committedHydratedMessages;
            const shouldPreferCommittedHistoryReplay =
                !this.currentTurnScope
                && !this.activeModal
                && effectiveCommittedHydratedMessages.length > parsedHydratedMessages.length;
            const shouldPreferCommittedIdleReplay =
                shouldPreferCommittedMessages
                && !shouldAdoptParsedIdleReplay;
            const hydratedMessages = (shouldPreferCommittedIdleReplay || shouldPreferCommittedHistoryReplay)
                ? effectiveCommittedHydratedMessages
                : parsedHydratedMessages;
            result = {
                id: parsed.id || 'cli_session',
                status: parsed.status || this.currentStatus,
                title: parsed.title || this.cliName,
                messages: hydratedMessages,
                activeModal: parsed.activeModal ?? this.activeModal,
                providerSessionId: typeof parsed.providerSessionId === 'string' ? parsed.providerSessionId : undefined,
            };
        } else {
            const messages = [...this.committedMessages];
            result = {
                id: 'cli_session',
                status: this.currentStatus,
                title: this.cliName,
                messages: messages.map((message, index) => buildChatMessage({
                    ...message,
                    id: message.id || `msg_${index}`,
                    index: typeof message.index === 'number' ? message.index : index,
                    receivedAt: typeof message.receivedAt === 'number'
                        ? message.receivedAt
                        : message.timestamp,
                })),
                activeModal: this.activeModal,
            };
        }

        const hasVisibleAssistantMessage = Array.isArray(result?.messages)
            && result.messages.some((message: any) => message?.role === 'assistant' && typeof message?.content === 'string' && message.content.trim());
        const shouldClampStaleGeneratingToIdle =
            result?.status === 'generating'
            && this.currentStatus === 'idle'
            && !this.currentTurnScope
            && !result?.activeModal
            && hasVisibleAssistantMessage
            && !hasVisibleInterruptPrompt(screenText);
        if (shouldClampStaleGeneratingToIdle) {
            result = {
                ...result,
                status: 'idle',
                messages: Array.isArray(result.messages)
                    ? result.messages.map((message: any) => {
                        if (message?.role !== 'assistant' || !message?.meta?.streaming) return message;
                        const nextMeta = { ...(message.meta || {}) };
                        delete nextMeta.streaming;
                        return {
                            ...message,
                            ...(Object.keys(nextMeta).length > 0 ? { meta: nextMeta } : { meta: undefined }),
                        };
                    })
                    : result.messages,
            };
        }

        this.parsedStatusCache = {
            committedMessagesRef: this.committedMessages,
            responseBuffer: this.responseBuffer,
            currentTurnScope: this.currentTurnScope,
            recentOutputBuffer: this.recentOutputBuffer,
            accumulatedBuffer: this.accumulatedBuffer,
            accumulatedRawBuffer: this.accumulatedRawBuffer,
            screenText,
            currentStatus: this.currentStatus,
            activeModal: this.activeModal,
            cliName: this.cliName,
            lastOutputAt: this.lastOutputAt,
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
            terminalScreenText: this.terminalScreen.getText(),
            baseMessages: this.committedMessages,
            partialResponse: this.responseBuffer,
            isWaitingForResponse: this.isWaitingForResponse,
            scope: this.currentTurnScope,
            runtimeSettings: this.runtimeSettings,
        });
        return await Promise.resolve(fn({
            ...input,
            args: args && typeof args === 'object' ? { ...args } : {},
        }));
    }

    private parseCurrentTranscript(baseMessages: CliChatMessage[], partialResponse: string, scope?: TurnParseScope | null, screenTextOverride?: string): any {
        if (!this.cliScripts?.parseOutput) {
            this.parseErrorMessage = null;
            return null;
        }
        try {
            const screenText = typeof screenTextOverride === 'string' ? screenTextOverride : this.terminalScreen.getText();
            const input = buildCliParseInput({
                accumulatedBuffer: this.accumulatedBuffer,
                accumulatedRawBuffer: this.accumulatedRawBuffer,
                recentOutputBuffer: this.recentOutputBuffer,
                terminalScreenText: screenText,
                baseMessages,
                partialResponse,
                isWaitingForResponse: this.isWaitingForResponse,
                scope,
                runtimeSettings: this.runtimeSettings,
            });
            const parsed = this.cliScripts.parseOutput(input);
            if (parsed && typeof parsed === 'object') {
                Object.assign(parsed, validateReadChatResultPayload(parsed, `${this.cliType} parseOutput`));
            }
            const normalizedParsed = this.suppressStaleParsedApproval(parsed, input.recentBuffer, input.screenText);
            if (normalizedParsed && Array.isArray(normalizedParsed.messages)) {
                this.trimLastAssistantEcho(normalizedParsed.messages, scope?.prompt || getLastUserPromptText(baseMessages));
            }
            this.parseErrorMessage = null;
            return normalizedParsed;
        } catch (e: any) {
            const message = e?.message || String(e);
            this.parseErrorMessage = message;
            LOG.warn('CLI', `[${this.cliType}] parseOutput error: ${message}`);
            throw e;
        }
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

    async sendMessage(text: string): Promise<void> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        const allowInputDuringGeneration = this.provider.allowInputDuringGeneration === true;
        const allowInterventionPrompt = allowInputDuringGeneration
            && this.isWaitingForResponse
            && this.currentStatus !== 'waiting_approval';
        if (this.startupParseGate) {
            const deadline = Date.now() + 10000;
            while (this.startupParseGate && Date.now() < deadline) {
                this.resolveStartupState('send_wait');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        if (!allowInterventionPrompt) {
            await this.waitForInteractivePrompt();
        }
        if (!this.ready) {
            this.resolveStartupState('send_precheck');
            if (this.runDetectStatus(this.recentOutputBuffer) === 'idle' && this.currentStatus === 'idle') {
                this.ready = true;
                this.startupParseGate = false;
                LOG.info('CLI', `[${this.cliType}] sendMessage recovered idle prompt readiness`);
            }
        }
        if (!this.ready) throw new Error(`${this.cliName} not ready (status: ${this.currentStatus})`);
        const parsedStatusBeforeSend = !allowInputDuringGeneration
            ? (() => {
                try {
                    return this.getScriptParsedStatus?.() || null;
                } catch {
                    return null;
                }
            })()
            : null;
        const parsedSessionStatus = typeof parsedStatusBeforeSend?.status === 'string'
            ? String(parsedStatusBeforeSend.status)
            : '';
        const parsedMessagesBeforeSend = Array.isArray(parsedStatusBeforeSend?.messages)
            ? parsedStatusBeforeSend.messages.filter((message: any) => message && (message.role === 'user' || message.role === 'assistant'))
            : [];
        const shouldCommitParsedIdleBeforeSend = !allowInputDuringGeneration
            && parsedSessionStatus === 'idle'
            && parsedMessagesBeforeSend.length > this.committedMessages.length
            && parsedMessagesBeforeSend.some((message: any) => message?.role === 'assistant' && typeof message?.content === 'string' && message.content.trim());
        if (shouldCommitParsedIdleBeforeSend) {
            this.commitCurrentTranscript();
        }
        if (!allowInputDuringGeneration && (parsedSessionStatus === 'generating' || parsedSessionStatus === 'long_generating')) {
            throw new Error(`${this.cliName} is still processing the previous prompt`);
        }
        if (this.isWaitingForResponse && !allowInputDuringGeneration) {
            if (!this.clearStaleIdleResponseGuard('send_message_guard')) {
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
        let didCommitUserTurn = false;
        const commitUserTurn = () => {
            if (didCommitUserTurn) return;
            didCommitUserTurn = true;
            this.committedMessages.push({ role: 'user', content: text, timestamp: Date.now() });
            this.syncMessageViews();
        };
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = null;
        }
        this.responseEpoch += 1;
        this.responseSettleIgnoreUntil = Date.now() + submitDelayMs + this.timeouts.outputSettle + 250;
        const startResponseTimeout = () => {
            if (this.responseTimeout) clearTimeout(this.responseTimeout);
            this.responseTimeout = setTimeout(() => {
                if (this.isWaitingForResponse) this.finishResponse();
            }, this.timeouts.maxResponse);
        };
        await new Promise<void>((resolve, reject) => {
            let resolved = false;
            const resolveOnce = () => {
                if (resolved) return;
                resolved = true;
                resolve();
            };
            const rejectOnce = (error: unknown) => {
                if (resolved) return;
                this.resetPendingSendState('send_write_failed');
                resolved = true;
                reject(error);
            };
            const writeRetryKey = (mode: string) => {
                void this.writeToPty(this.sendKey).catch((error) => {
                    LOG.warn('CLI', `[${this.cliType}] ${mode} write failed: ${error?.message || error}`);
                });
            };

            const submit = () => {
                if (!this.ptyProcess) {
                    resolveOnce();
                    return;
                }
                this.submitPendingUntil = 0;
                const screenText = this.terminalScreen.getText();
                this.recordTrace('submit_write', {
                    mode: 'submit_key',
                    sendKey: this.sendKey,
                    screenText: summarizeCliTraceText(screenText, 500),
                });
                const retrySubmitIfStuck = (attempt: number) => {
                    this.submitRetryTimer = null;
                    if (!this.ptyProcess || !this.isWaitingForResponse || this.submitRetryUsed) return;
                    if (this.currentStatus === 'waiting_approval') return;
                    if (this.hasMeaningfulResponseBuffer(normalizedPromptSnippet)) return;
                    const screenText = this.terminalScreen.getText();
                    if (!promptLikelyVisible(screenText, normalizedPromptSnippet)) return;
                    const liveApproval = this.runParseApproval(screenText) || this.runParseApproval(this.recentOutputBuffer);
                    if (liveApproval) return;
                    const liveStatus = this.runDetectStatus(screenText) || this.runDetectStatus(this.recentOutputBuffer);
                    if (liveStatus === 'generating' || liveStatus === 'waiting_approval') return;
                    this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
                    LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt ${attempt})`);
                    this.recordTrace('submit_write', {
                        mode: 'submit_retry',
                        attempt,
                        sendKey: this.sendKey,
                        screenText: summarizeCliTraceText(screenText, 500),
                    });
                    writeRetryKey('submit_retry');
                    if (attempt >= 3) {
                        this.submitRetryUsed = true;
                        return;
                    }
                    this.submitRetryTimer = setTimeout(() => retrySubmitIfStuck(attempt + 1), retryDelayMs);
                };
                void this.writeToPty(this.sendKey).then(() => {
                    commitUserTurn();
                    this.submitRetryTimer = setTimeout(() => retrySubmitIfStuck(1), retryDelayMs);
                    startResponseTimeout();
                    resolveOnce();
                }, rejectOnce);
            };

            if (this.submitStrategy === 'immediate') {
                this.submitPendingUntil = 0;
                this.recordTrace('submit_write', {
                    mode: 'immediate',
                    text: summarizeCliTraceText(text, 500),
                    sendKey: this.sendKey,
                    screenText: summarizeCliTraceText(this.terminalScreen.getText(), 500),
                });
                void this.writeToPty(text + this.sendKey).then(() => {
                    commitUserTurn();
                    this.submitRetryTimer = setTimeout(() => {
                        this.submitRetryTimer = null;
                        if (!this.ptyProcess || !this.isWaitingForResponse || this.submitRetryUsed) return;
                        if (this.currentStatus === 'waiting_approval') return;
                        if (this.hasMeaningfulResponseBuffer(normalizedPromptSnippet)) return;
                        const screenText = this.terminalScreen.getText();
                        if (!promptLikelyVisible(screenText, normalizedPromptSnippet)) return;
                        const liveApproval = this.runParseApproval(screenText) || this.runParseApproval(this.recentOutputBuffer);
                        if (liveApproval) return;
                        const liveStatus = this.runDetectStatus(screenText) || this.runDetectStatus(this.recentOutputBuffer);
                        if (liveStatus === 'generating' || liveStatus === 'waiting_approval') return;
                        LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt 1)`);
                        this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
                        this.recordTrace('submit_write', {
                            mode: 'immediate_retry',
                            attempt: 1,
                            sendKey: this.sendKey,
                            screenText: summarizeCliTraceText(screenText, 500),
                        });
                        writeRetryKey('immediate_retry');
                        this.submitRetryUsed = true;
                    }, retryDelayMs);
                    startResponseTimeout();
                    resolveOnce();
                }, rejectOnce);
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
            let lastNormalizedScreen = '';
            let lastScreenChangeAt = submitStartedAt;
            const waitForEchoAndSubmit = () => {
                if (!this.ptyProcess) {
                    resolveOnce();
                    return;
                }
                const now = Date.now();
                const elapsed = now - submitStartedAt;
                const screenText = this.terminalScreen.getText();
                const normalizedScreen = normalizePromptText(screenText);
                if (normalizedScreen !== lastNormalizedScreen) {
                    lastNormalizedScreen = normalizedScreen;
                    lastScreenChangeAt = now;
                }
                const echoVisible = !normalizedPromptSnippet || promptLikelyVisible(screenText, normalizedPromptSnippet);

                if (echoVisible) {
                    const screenSettled = (now - lastScreenChangeAt) >= 500;
                    if (elapsed >= submitDelayMs && screenSettled) {
                        submit();
                        return;
                    }
                }

                if (elapsed >= maxEchoWaitMs) {
                    submit();
                    return;
                }

                setTimeout(waitForEchoAndSubmit, 50);
            };
            void this.writeToPty(text).then(() => waitForEchoAndSubmit(), rejectOnce);
        });
    }

    getPartialResponse(): string {
        if (!this.isWaitingForResponse) return '';
        return this.responseBuffer;
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
        this.pendingOutputParseBuffer = '';
        this.pendingTerminalQueryTail = '';
        this.ptyOutputBuffer = '';
        this.finishRetryCount = 0;
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
        this.pendingOutputParseBuffer = '';
        this.pendingTerminalQueryTail = '';
        this.ptyOutputBuffer = '';
        this.finishRetryCount = 0;
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
        this.committedMessages = [];
        this.syncMessageViews();
        this.accumulatedBuffer = '';
        this.accumulatedRawBuffer = '';
        this.currentTurnScope = null;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        if (this.pendingOutputParseTimer) { clearTimeout(this.pendingOutputParseTimer); this.pendingOutputParseTimer = null; }
        this.pendingOutputParseBuffer = '';
        this.pendingTerminalQueryTail = '';
        if (this.ptyOutputFlushTimer) { clearTimeout(this.ptyOutputFlushTimer); this.ptyOutputFlushTimer = null; }
        this.ptyOutputBuffer = '';
        if (this.finishRetryTimer) { clearTimeout(this.finishRetryTimer); this.finishRetryTimer = null; }
        this.finishRetryCount = 0;
        this.terminalScreen.reset();
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
        if (!modal && typeof this.cliScripts?.parseOutput === 'function') {
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
            const DOWN = '\x1B[B';
            const keys = DOWN.repeat(Math.max(0, buttonIndex)) + '\r';
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

    getDebugState(): Record<string, any> {
        const screenText = sanitizeTerminalText(this.terminalScreen.getText());
        const startupModal = this.startupParseGate ? this.runParseApproval(this.recentOutputBuffer) : null;
        const effectiveStatus = this.projectEffectiveStatus(startupModal);
        const effectiveReady = this.ready || !!startupModal;
        return {
            type: this.cliType,
            name: this.cliName,
            providerResolution: this.providerResolutionMeta,
            status: effectiveStatus,
            ready: effectiveReady,
            startupParseGate: this.startupParseGate,
            spawnAt: this.spawnAt,
            workingDir: this.workingDir,
            messages: this.messages,
            committedMessages: this.committedMessages,
            structuredMessages: this.structuredMessages,
            messageCount: this.committedMessages.length,
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
            submitPendingUntil: this.submitPendingUntil,
            responseSettleIgnoreUntil: this.responseSettleIgnoreUntil,
            resizeSuppressUntil: this.resizeSuppressUntil,
            hasCliScripts: this.hasCliScripts(),
            scriptNames: listCliScriptNames(this.cliScripts),
            traceSessionId: this.traceSessionId,
            traceEntryCount: this.traceEntries.length,
            statusHistory: this.statusHistory.slice(-30),
            timeouts: this.timeouts,
            pendingOutputParseBufferLength: this.pendingOutputParseBuffer.length,
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
            status: this.currentStatus,
            activeModal: this.activeModal,
            currentTurnScope: this.currentTurnScope,
            messages: summarizeCliTraceMessages(this.committedMessages, 5),
        };
    }

    getProviderResolutionMeta(): ProviderResolutionMeta {
        return { ...this.providerResolutionMeta };
    }
}
