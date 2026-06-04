/**
 * CliAdapter — common interface for CLI agents
 *
 * Contract implemented by all CLI adapters (ProviderCliAdapter etc).
 */

import type { ChatMessage } from './types.js';

export interface CliAdapterStatus {
    status?: string;
    messages?: ChatMessage[];
    activeModal?: {
        message: string;
        buttons: string[];
    } | null;
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
    resolveModal?(buttonIndex: number): void;
    isApprovalRecentlyResolved?(): boolean;
 // Raw PTY I/O (for terminal view)
    setOnPtyData?(callback: (data: string) => void): void;
    writeRaw?(data: string): void;
    resize?(cols: number, rows: number): void;
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
