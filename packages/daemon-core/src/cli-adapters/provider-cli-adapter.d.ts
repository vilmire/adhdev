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
import type { CliAdapter } from '../cli-adapter-types.js';
import { type PtyRuntimeMetadata, type PtyTransportFactory } from './pty-transport.js';
import { type CliChatMessage, type CliProviderModule, type CliScripts, type CliSessionStatus } from './provider-cli-shared.js';
import { type ProviderResolutionMeta } from './provider-cli-config.js';
export { normalizeCliProviderForRuntime, type CliApprovalInput, type CliChatMessage, type CliProviderModule, type CliScreenLine, type CliScreenSnapshot, type CliScriptInput, type CliScripts, type CliSessionStatus, type CliStatusInput, type CliTraceEntry, } from './provider-cli-shared.js';
type SeedCliChatMessage = Omit<Partial<CliChatMessage>, 'role'> & {
    role?: string;
    content?: string;
};
export declare class ProviderCliAdapter implements CliAdapter {
    private extraArgs;
    readonly cliType: string;
    readonly cliName: string;
    workingDir: string;
    private provider;
    private ptyProcess;
    private transportFactory;
    private messages;
    private committedMessages;
    private structuredMessages;
    private currentStatus;
    private onStatusChange;
    private responseBuffer;
    private recentOutputBuffer;
    private isWaitingForResponse;
    private activeModal;
    private responseTimeout;
    private idleTimeout;
    private ready;
    private startupBuffer;
    private startupParseGate;
    private startupSettleTimer;
    private spawnAt;
    private startupFirstOutputAt;
    private onPtyDataCallback;
    private pendingOutputParseBuffer;
    private pendingOutputParseTimer;
    private ptyOutputBuffer;
    private ptyOutputFlushTimer;
    private pendingTerminalQueryTail;
    private lastOutputAt;
    private lastNonEmptyOutputAt;
    private lastScreenChangeAt;
    private lastScreenSnapshot;
    private serverConn;
    private logBuffer;
    private lastApprovalResolvedAt;
    private approvalTransitionBuffer;
    private approvalExitTimeout;
    private pendingScriptStatus;
    private pendingScriptStatusSince;
    private pendingScriptStatusTimer;
    private settleTimer;
    private settledBuffer;
    private submitPendingUntil;
    private responseSettleIgnoreUntil;
    private responseEpoch;
    private submitRetryTimer;
    private submitRetryUsed;
    private submitRetryPromptSnippet;
    private idleFinishCandidate;
    private finishRetryTimer;
    private finishRetryCount;
    private resizeSuppressUntil;
    private statusHistory;
    private cliScripts;
    private runtimeSettings;
    /** Full accumulated ANSI-stripped PTY output */
    private accumulatedBuffer;
    /** Full accumulated raw PTY output (with ANSI) */
    private accumulatedRawBuffer;
    /** Current visible terminal screen snapshot */
    private terminalScreen;
    /** Max accumulated buffer size (last 50KB) */
    private static readonly MAX_ACCUMULATED_BUFFER;
    private currentTurnScope;
    private traceEntries;
    private traceSeq;
    private traceSessionId;
    private static readonly MAX_TRACE_ENTRIES;
    private readonly providerResolutionMeta;
    private static readonly IDLE_FINISH_CONFIRM_MS;
    private static readonly STATUS_ACTIVITY_HOLD_MS;
    private static readonly FINISH_RETRY_DELAY_MS;
    private static readonly MAX_FINISH_RETRIES;
    private syncMessageViews;
    private setStatus;
    private clearIdleFinishCandidate;
    private armIdleFinishCandidate;
    private recordTrace;
    private resetTraceSession;
    private readonly timeouts;
    private readonly approvalKeys;
    private readonly sendDelayMs;
    private readonly sendKey;
    private readonly submitStrategy;
    private static readonly SCRIPT_STATUS_DEBOUNCE_MS;
    constructor(provider: CliProviderModule, workingDir: string, extraArgs?: string[], transportFactory?: PtyTransportFactory);
    /** Inject CLI scripts after construction (e.g. when resolved by ProviderLoader) */
    setCliScripts(scripts: CliScripts): void;
    updateRuntimeSettings(settings: Record<string, any>): void;
    setServerConn(serverConn: any): void;
    setOnStatusChange(callback: () => void): void;
    setOnPtyData(callback: (data: string) => void): void;
    private flushPendingOutputParse;
    spawn(): Promise<void>;
    private handleOutput;
    private resolveStartupState;
    private scheduleStartupSettleCheck;
    private scheduleSettle;
    private armApprovalExitTimeout;
    private looksLikeVisibleIdlePrompt;
    private findLastMatchingLineIndex;
    private looksLikeClaudeGeneratingLine;
    private detectClaudeGeneratingOverride;
    private refineDetectedStatus;
    private looksLikeVisibleAssistantCandidate;
    private shouldRetryFinishResponse;
    private hasRecentInteractiveActivity;
    private getStartupConfirmationModal;
    private shouldResolveModalWithEnter;
    private waitForInteractivePrompt;
    private evaluateSettled;
    private finishResponse;
    private commitCurrentTranscript;
    private runDetectStatus;
    private runParseApproval;
    getStatus(): CliSessionStatus;
    seedCommittedMessages(messages: SeedCliChatMessage[]): void;
    /**
     * Script-based full parse — returns ReadChatResult.
     * Called by command handler / dashboard for rich content rendering.
     */
    getScriptParsedStatus(): any;
    invokeScript(scriptName: string, args?: Record<string, any>): Promise<any>;
    private parseCurrentTranscript;
    /** Whether this adapter has CLI scripts loaded */
    hasCliScripts(): boolean;
    /**
     * Resolves an action (like 'fix' lint error) from the dashboard.
     * Uses resolveAction script if available, otherwise falls back to standard text.
     */
    resolveAction(data: any): Promise<void>;
    sendMessage(text: string): Promise<void>;
    getPartialResponse(): string;
    getRuntimeMetadata(): PtyRuntimeMetadata | null;
    updateRuntimeMeta(meta: Record<string, unknown>, replace?: boolean): void;
    cancel(): void;
    saveAndStop(): Promise<void>;
    private waitForStopped;
    shutdown(): void;
    detach(): void;
    clearHistory(): void;
    isProcessing(): boolean;
    isReady(): boolean;
    writeRaw(data: string): void;
    resolveModal(buttonIndex: number): void;
    resize(cols: number, rows: number): void;
    getDebugState(): Record<string, any>;
    getTraceState(limit?: number): Record<string, any>;
    getProviderResolutionMeta(): ProviderResolutionMeta;
}
