import type { ProviderResumeCapability } from '../providers/contracts.js';
import { sanitizeSpawnEnv } from './spawn-env.js';
export interface CliChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
    receivedAt?: number;
    kind?: string;
    id?: string;
    index?: number;
    meta?: Record<string, any>;
    senderName?: string;
}
export interface CliSessionStatus {
    status: 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting';
    messages: CliChatMessage[];
    workingDir: string;
    activeModal: {
        message: string;
        buttons: string[];
    } | null;
}
export interface CliScripts {
    parseOutput?: (input: CliScriptInput) => any;
    detectStatus?: (input: CliStatusInput) => string | null;
    parseApproval?: (input: CliApprovalInput) => {
        message: string;
        buttons: string[];
    } | null;
    resolveAction?: (data: any) => string;
    [name: string]: ((input: any) => any) | undefined;
}
export interface CliScreenLine {
    index: number;
    fromTop: number;
    fromBottom: number;
    text: string;
    trimmed: string;
    isEmpty: boolean;
}
export interface CliScreenSnapshot {
    text: string;
    lineCount: number;
    lines: CliScreenLine[];
    nonEmptyLines: CliScreenLine[];
    firstNonEmptyLineIndex: number;
    lastNonEmptyLineIndex: number;
    firstNonEmptyLine: CliScreenLine | null;
    lastNonEmptyLine: CliScreenLine | null;
    promptLineIndex: number;
    promptLine: CliScreenLine | null;
    linesAbovePrompt: CliScreenLine[];
    linesBelowPrompt: CliScreenLine[];
}
export interface CliScriptInput {
    buffer: string;
    rawBuffer: string;
    recentBuffer: string;
    screenText: string;
    screen: CliScreenSnapshot;
    bufferScreen: CliScreenSnapshot;
    recentScreen: CliScreenSnapshot;
    messages: CliChatMessage[];
    partialResponse: string;
    isWaitingForResponse?: boolean;
    promptText?: string;
    settings?: Record<string, any>;
    args?: Record<string, any>;
}
export interface CliStatusInput {
    tail: string;
    screenText?: string;
    rawBuffer?: string;
    isWaitingForResponse?: boolean;
    screen: CliScreenSnapshot;
    tailScreen: CliScreenSnapshot;
}
export interface CliApprovalInput {
    buffer: string;
    screenText?: string;
    rawBuffer?: string;
    tail: string;
    screen: CliScreenSnapshot;
    bufferScreen: CliScreenSnapshot;
    tailScreen: CliScreenSnapshot;
}
export interface CliTraceEntry {
    id: number;
    at: number;
    type: string;
    status: CliSessionStatus['status'];
    isWaitingForResponse: boolean;
    activeModal: {
        message: string;
        buttons: string[];
    } | null;
    payload: Record<string, any>;
}
export interface CliProviderModule {
    type: string;
    name: string;
    category: 'cli';
    binary: string;
    approvalKeys?: Record<number, string>;
    sendDelayMs?: number;
    sendKey?: string;
    submitStrategy?: 'wait_for_echo' | 'immediate';
    /** Allow sending another prompt while the CLI is still generating so users can intervene mid-turn. */
    allowInputDuringGeneration?: boolean;
    scripts?: CliScripts;
    spawn: {
        command: string;
        args: string[];
        shell: boolean;
        env: Record<string, string>;
    };
    timeouts?: {
        ptyFlush?: number;
        dialogAccept?: number;
        approvalCooldown?: number;
        generatingIdle?: number;
        idleFinish?: number;
        maxResponse?: number;
        shutdownGrace?: number;
        outputSettle?: number;
    };
    resume?: ProviderResumeCapability;
    _resolvedVersion?: string | null;
    _resolvedOs?: string | null;
    _resolvedProviderDir?: string | null;
    _resolvedScriptDir?: string | null;
    _resolvedScriptsPath?: string | null;
    _resolvedScriptsSource?: string | null;
    _versionWarning?: string | null;
}
export declare function sanitizeTerminalText(str: string): string;
export declare function listCliScriptNames(scripts: CliScripts | undefined): string[];
export declare function buildCliScreenSnapshot(text: string): CliScreenSnapshot;
export declare const buildCliSpawnEnv: typeof sanitizeSpawnEnv;
export declare function computeTerminalQueryTail(buffer: string): string;
export declare function findBinary(name: string): string;
export declare function isScriptBinary(binaryPath: string): boolean;
export declare function looksLikeMachOOrElf(filePath: string): boolean;
export declare function shSingleQuote(arg: string): string;
export declare function estimatePromptDisplayLines(text: string, cols?: number): number;
export declare function extractPromptRetrySnippet(text: string): string;
export declare function normalizePromptText(text: string): string;
export declare function compactPromptText(text: string): string;
export declare function promptLikelyVisible(screenText: string, promptSnippet: string): boolean;
export declare function normalizeScreenSnapshot(text: string): string;
export declare function normalizeComparableMessageContent(text: string): string;
export declare function trimPromptEchoPrefix(text: string, promptText?: string | null): string;
export declare function getLastUserPromptText(messages: Array<{
    role?: string;
    content?: string;
}> | null | undefined): string;
export declare function looksLikeConfirmOnlyLabel(label: string): boolean;
export declare function normalizeCliProviderForRuntime(raw: unknown): {
    patterns: {
        approval: RegExp[];
    };
};
