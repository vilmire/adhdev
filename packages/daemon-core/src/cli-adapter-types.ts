/**
 * CliAdapter — common interface for CLI agents
 *
 * Contract implemented by all CLI adapters (ProviderCliAdapter etc).
 */

import type { ChatMessage } from './types.js';
import type { InteractivePrompt, InteractivePromptResponse } from './providers/types/interactive-prompt.js';

export interface CliAdapterStatus {
    status?: string;
    parsedStatus?: string;
    messages?: ChatMessage[];
    activeModal?: {
        message: string;
        buttons: string[];
        /**
         * Semantic modal class, when the adapter knows it (spec/FSM path):
         * 'approval' = tool/command/trust consent (auto-approve may fire);
         * 'picker' = a selection menu the user opened (/model, /mode — must NOT
         * be auto-answered); 'confirm' = a yes/no left to the user. Absent/null
         * for adapters that don't classify modals — the auto-approve gate then
         * falls back to its structural heuristic.
         */
        kind?: 'approval' | 'picker' | 'confirm' | null;
    } | null;
    activeInteractivePrompt?: InteractivePrompt | null;
    providerSessionId?: string;
    errorMessage?: string;
    errorReason?: string;
}

export interface AcpAdapterHandle {
    onEvent(event: string, data?: unknown): void;
    getState(): {
        status: string;
        activeChat?: {
            messages?: ChatMessage[];
            activeModal?: {
                message: string;
                buttons: string[];
            } | null;
        } | null;
    };
    setMode?(mode: string): Promise<void>;
    setConfigOption?(configId: string, value: string): Promise<void>;
    resolvePermission?(approved: boolean): Promise<void>;
}

/**
 * Launch metadata for a CLI session, surfaced by the dashboard Session info panel.
 * Derived from the live adapter's spawn plan — the resolved binary, the full
 * argument vector (provider base args + per-launch extra args), the cwd, and the
 * set of per-launch extra-env KEYS (values are intentionally omitted so secrets in
 * extraEnv are never sent to the dashboard). providerSessionId is the upstream
 * agent's own session id once the CLI reports it.
 */
export interface CliLaunchInfo {
    /** Resolved executable path the PTY actually spawns. */
    command?: string;
    /** Full argument vector (provider spawn.args + extraArgs, {{workingDir}} expanded). */
    args: string[];
    /** Per-launch extra args only (subset of args), for attribution. */
    extraArgs: string[];
    /** Working directory the session was spawned in. */
    cwd: string;
    /** KEYS of per-launch extra env (values omitted — may contain secrets). */
    extraEnvKeys: string[];
    /** Upstream agent session id, once the CLI reports one. */
    providerSessionId?: string;
}

export interface CliAdapter {
    cliType: string;
    cliName: string;
    workingDir: string;
    _acpInstance?: AcpAdapterHandle;
    spawn(): Promise<void>;
    sendMessage(text: string, options?: { force?: boolean }): Promise<void>;
    forceSendMessage?(text: string): Promise<void>;
    getStatus(options?: { allowParse?: boolean }): CliAdapterStatus;
    getScriptParsedStatus?(): unknown;
    getDebugSnapshot?(): unknown;
    invokeScript?(scriptName: string, args?: Record<string, unknown>): Promise<unknown>;
    getPartialResponse(): string;
    saveAndStop?(): Promise<void>;
    shutdown(): void;
    detach?(): void;
    cancel(): void;
    isProcessing(): boolean;
    isReady(): boolean;
    setOnStatusChange(callback: () => void): void;
    updateRuntimeSettings?(settings: Record<string, unknown>): void;
    setCliScripts?(scripts: Record<string, unknown>): void;
    setServerConn?(serverConn: unknown): void;
    clearHistory?(): void;
    resolveAction?(data: unknown): Promise<void>;
    setInteractivePromptResponse?(response: InteractivePromptResponse): Promise<void>;
    resolveModal?(buttonIndex: number): void;
    isApprovalRecentlyResolved?(): boolean;
 // Raw PTY I/O (for terminal view)
    setOnPtyData?(callback: (data: string) => void): void;
    writeRaw?(data: string): void;
    resize?(cols: number, rows: number): void;
    // ── Launch metadata for the dashboard Session info panel (args/cwd/env keys) ──
    getLaunchInfo?(): CliLaunchInfo;
    // ── Runtime metadata used by CliProviderInstance for session tracking ──
    getRuntimeMetadata?(): unknown;
    updateRuntimeMeta?(meta: Record<string, unknown>): void;
    refreshProviderDefinition?(provider: unknown): void;
    // ── Optional auxiliary fields some daemon paths read off the status ──
}

export interface CliAdapterStatusOptional {
    providerSessionId?: string;
    errorMessage?: string;
    errorReason?: string;
}
