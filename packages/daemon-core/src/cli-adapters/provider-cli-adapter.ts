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
import * as path from 'path';
import { execSync } from 'child_process';
import type { CliAdapter } from '../cli-adapter-types.js';
import { LOG } from '../logging/logger.js';
import { TerminalScreen } from './terminal-screen.js';
import type { ProviderResumeCapability } from '../providers/contracts.js';
import {
    NodePtyTransportFactory,
    type PtyRuntimeMetadata,
    type PtyRuntimeTransport,
    type PtyTransportFactory,
} from './pty-transport.js';

let pty: any;
try {
    pty = require('node-pty');
    // node-pty ships spawn-helper without +x on macOS (npm umask issue) — fix it
    if (os.platform() !== 'win32') {
        try {
            const fs = require('fs');
            const ptyDir = path.resolve(path.dirname(require.resolve('node-pty')), '..');
            const platformArch = `${os.platform()}-${os.arch()}`;
            const helper = path.join(ptyDir, 'prebuilds', platformArch, 'spawn-helper');
            if (fs.existsSync(helper)) {
                const stat = fs.statSync(helper);
                if (!(stat.mode & 0o111)) {
                    fs.chmodSync(helper, stat.mode | 0o755);
                    LOG.info('CLI', '[node-pty] Fixed spawn-helper permissions');
                }
            }
        } catch { /* best-effort */ }
    }
} catch {
    LOG.error('CLI', '[ProviderCliAdapter] node-pty not found. Terminal features disabled.');
}

// ─── Types ──────────────────────────────────────────

export interface CliChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
}

export interface CliSessionStatus {
    status: 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting';
    messages: CliChatMessage[];
    workingDir: string;
    activeModal: { message: string; buttons: string[] } | null;
}

/**
 * CLI Script Functions.
 * Unlike IDE scripts (which return JS code strings for CDP evaluate),
 * CLI scripts are Node.js functions that receive PTY buffer data and return structured results.
 */
export interface CliScripts {
    /** Full PTY buffer → ReadChatResult (messages, status, activeModal) */
    parseOutput?: (input: CliScriptInput) => any;
    /** Lightweight status detection (high-frequency polling) → AgentStatus string */
    detectStatus?: (input: { tail: string; screenText?: string; rawBuffer?: string }) => string | null;
    /** Parse approval modal from PTY output → ModalInfo | null */
    parseApproval?: (input: { buffer: string; screenText?: string; rawBuffer?: string; tail: string }) => { message: string; buttons: string[] } | null;
    /** Produce a cli-specific prompt from a dashboard action payload */
    resolveAction?: (data: any) => string;
    /** Custom scripts */
    [name: string]: ((input: any) => any) | undefined;
}

export interface CliScriptInput {
    buffer: string;          // Full ANSI-stripped accumulated PTY output
    rawBuffer: string;       // Raw PTY output (with ANSI)
    recentBuffer: string;    // Recent 1000 chars (ANSI-stripped)
    screenText: string;      // Current visible screen snapshot
    messages: CliChatMessage[];  // Previously parsed messages
    partialResponse: string; // Current partial response being generated
}

interface TurnParseScope {
    prompt: string;
    startedAt: number;
    bufferStart: number;
    rawBufferStart: number;
}

interface IdleFinishCandidate {
    armedAt: number;
    lastOutputAt: number;
    lastScreenChangeAt: number;
    responseEpoch: number;
    assistantLength: number;
}

export interface CliTraceEntry {
    id: number;
    at: number;
    type: string;
    status: CliSessionStatus['status'];
    isWaitingForResponse: boolean;
    activeModal: { message: string; buttons: string[] } | null;
    payload: Record<string, any>;
}

export interface CliProviderModule {
    type: string;
    name: string;
    category: 'cli';
    binary: string;
    sendDelayMs?: number;
    sendKey?: string;
    submitStrategy?: 'wait_for_echo' | 'immediate';
    spawn: {
        command: string;
        args: string[];
        shell: boolean;
        env: Record<string, string>;
    };
    timeouts?: {
 /** PTY output batch transmit interval (default 50ms) */
        ptyFlush?: number;
 /** Wait for startup dialog auto-proceed (default 300ms) */
        dialogAccept?: number;
 /** Approval detect cooldown (default 2000ms) */
        approvalCooldown?: number;
 /** Check for completion on no-response during generating (default 6000ms) */
        generatingIdle?: number;
 /** Check for completion on no-response (default 5000ms) */
        idleFinish?: number;
 /** Max response wait (default 300000ms = 5min) */
        maxResponse?: number;
 /** shutdown after kill wait (default 1000ms) */
        shutdownGrace?: number;
 /** Output settle debounce before evaluating status (default 300ms) */
        outputSettle?: number;
    };
    resume?: ProviderResumeCapability;
}

// ─── Utility Functions ──────────────────────────────

function stripAnsi(str: string): string {
 // eslint-disable-next-line no-control-regex
    return str
        // OSC sequences (title bar etc) — strip before generic ESC removal so payload cannot leak.
        .replace(/\x1B\][^\x07]*\x07/g, '')
        .replace(/\x1B\][\s\S]*?\x1B\\/g, '')
        // DCS / APC / PM / SOS control strings terminated by ST or BEL.
        .replace(/\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g, '')
        // Cursor movement sequences → space (prevents word concatenation)
        .replace(/\x1B\[\d*[A-HJKSTfG]/g, ' ')
        // SGR and other CSI sequences → remove
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
        // Collapse multiple spaces
        .replace(/  +/g, ' ');
}

function stripTerminalNoise(str: string): string {
    return String(str || '')
        // Remove remaining C0/C1 control chars except newlines/tabs.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        // Drop common terminal negotiation/report fragments that can remain after ANSI stripping.
        .replace(/(^|[\s([])(?:\??\d{1,4}(?:;\d{1,4})*[A-Za-z])(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:\[\??\d{1,4}(?:;\d{1,4})*[A-Za-z])(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:\d{1,4};\?)(?=$|[\s)\]])/g, '$1')
        // Drop common leftover DCS/OSC payload fragments when a control string was split across PTY chunks.
        .replace(/(^|[\s([])(?:\d+\$r[0-9;\" ]*[A-Za-z]?)(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:>\|[A-Za-z0-9_.:-]+(?:\([^)]*\))?)(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:[A-Z]\d(?:\s+[A-Z]\d)+)(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:\d+;[^\s)\]]+)(?=$|[\s)\]])/g, '$1')
        .replace(/\r+/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ {2,}/g, ' ');
}

function sanitizeTerminalText(str: string): string {
    return stripTerminalNoise(stripAnsi(str));
}

function applyPreferredTerminalColorEnv(env: Record<string, string>): void {
    if (env.NO_COLOR) return;

    if (!env.TERM || env.TERM === 'xterm-color') {
        env.TERM = 'xterm-256color';
    }
    if (!env.COLORTERM) env.COLORTERM = 'truecolor';

    if (process.platform === 'win32') {
        if (!env.FORCE_COLOR) env.FORCE_COLOR = '1';
        if (!env.CLICOLOR) env.CLICOLOR = '1';
    }
}

function buildCliSpawnEnv(baseEnv: NodeJS.ProcessEnv, overrides?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    const source = { ...baseEnv, ...(overrides || {}) } as NodeJS.ProcessEnv;

    for (const [key, value] of Object.entries(source)) {
        if (typeof value !== 'string') continue;
        env[key] = value;
    }

    for (const key of Object.keys(env)) {
        if (
            key === 'INIT_CWD'
            || key === 'npm_command'
            || key === 'npm_execpath'
            || key === 'npm_node_execpath'
            || key.startsWith('npm_')
            || key.startsWith('npm_config_')
            || key.startsWith('npm_package_')
            || key.startsWith('npm_lifecycle_')
            || key.startsWith('PNPM_')
            || key.startsWith('YARN_')
            || key.startsWith('BUN_')
        ) {
            delete env[key];
        }
    }

    applyPreferredTerminalColorEnv(env);
    return env;
}

function computeTerminalQueryTail(buffer: string): string {
    const prefixes = ['\x1b[6n', '\x1b[?6n'];
    const maxLength = prefixes.reduce((n, value) => Math.max(n, value.length), 0) - 1;
    const start = Math.max(0, buffer.length - maxLength);
    for (let i = start; i < buffer.length; i++) {
        const suffix = buffer.slice(i);
        if (prefixes.some((pattern) => suffix.length < pattern.length && pattern.startsWith(suffix))) {
            return suffix;
        }
    }
    return '';
}

function findBinary(name: string): string {
    const isWin = os.platform() === 'win32';
    try {
        const cmd = isWin ? `where ${name}` : `which ${name}`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
    } catch {
        return isWin ? `${name}.cmd` : name;
    }
}

/** True if file starts with a UTF-8 BOM then #!, or plain #!. */
function isScriptBinary(binaryPath: string): boolean {
    if (!path.isAbsolute(binaryPath)) return false;
    try {
        const fs = require('fs');
        const resolved = fs.realpathSync(binaryPath);
        const head = Buffer.alloc(8);
        const fd = fs.openSync(resolved, 'r');
        fs.readSync(fd, head, 0, 8, 0);
        fs.closeSync(fd);
        let i = 0;
        if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
        return head[i] === 0x23 && head[i + 1] === 0x21; // '#!'
    } catch {
        return false;
    }
}

/** True only for Mach-O / ELF — npm shims and shell scripts return false. */
function looksLikeMachOOrElf(filePath: string): boolean {
    if (!path.isAbsolute(filePath)) return false;
    try {
        const fs = require('fs');
        const resolved = fs.realpathSync(filePath);
        const buf = Buffer.alloc(8);
        const fd = fs.openSync(resolved, 'r');
        fs.readSync(fd, buf, 0, 8, 0);
        fs.closeSync(fd);
        let i = 0;
        if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
        const b = buf.subarray(i);
        if (b.length < 4) return false;
        // ELF
        if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true;
        const le = b.readUInt32LE(0);
        const be = b.readUInt32BE(0);
        const magics = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca];
        return magics.some(m => m === le || m === be);
    } catch {
        return false;
    }
}

function shSingleQuote(arg: string): string {
    if (/^[a-zA-Z0-9@%_+=:,./-]+$/.test(arg)) return arg;
    if (os.platform() === 'win32') {
        return `"${arg.replace(/"/g, '""')}"`;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function estimatePromptDisplayLines(text: string, cols = 80): number {
    const normalized = String(text || '').replace(/\r/g, '');
    if (!normalized) return 1;
    return normalized
        .split('\n')
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / cols)), 0);
}

function extractPromptRetrySnippet(text: string): string {
    const lines = String(text || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const candidate = lines[lines.length - 1] || lines[0] || '';
    return candidate.slice(-120);
}

function normalizePromptText(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function compactPromptText(text: string): string {
    return String(text || '').replace(/\s+/g, '').trim();
}

function promptLikelyVisible(screenText: string, promptSnippet: string): boolean {
    const snippet = normalizePromptText(promptSnippet);
    if (!snippet) return false;

    const normalizedScreen = normalizePromptText(screenText);
    if (normalizedScreen.includes(snippet)) return true;

    const compactScreen = compactPromptText(screenText);
    const compactSnippet = compactPromptText(promptSnippet);
    if (compactSnippet && compactScreen.includes(compactSnippet)) return true;

    const tokens = snippet
        .split(/[^A-Za-z0-9_.:/-]+/)
        .map(token => token.trim())
        .filter(token => token.length >= 4);
    if (tokens.length === 0) return false;

    const required = Math.min(tokens.length, 3);
    const matched = tokens.filter(token =>
        normalizedScreen.includes(token) || compactScreen.includes(compactPromptText(token)),
    ).length;
    return matched >= required;
}

function normalizeScreenSnapshot(text: string): string {
    return sanitizeTerminalText(String(text || ''))
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeComparableMessageContent(text: string): string {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalize provider.json for auto-implement approval detection.
 * Kept for backward compat with dev-server auto-impl pipeline only.
 */
function parsePatternEntry(x: unknown): RegExp | null {
    if (x instanceof RegExp) return x;
    if (x && typeof x === 'object' && typeof (x as { source?: string }).source === 'string') {
        try {
            const s = x as { source: string; flags?: string };
            return new RegExp(s.source, s.flags || '');
        } catch {
            return null;
        }
    }
    return null;
}

function coercePatternArray(raw: unknown): RegExp[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(parsePatternEntry).filter((r): r is RegExp => r != null);
}

/**
 * Normalize raw provider JSON for auto-implement approval patterns.
 * Used by dev-server only — ProviderCliAdapter itself uses scripts.
 */
export function normalizeCliProviderForRuntime(raw: any): { patterns: { approval: RegExp[] } } {
    const patterns = raw?.patterns || {};
    return {
        patterns: {
            approval: coercePatternArray(patterns.approval),
        },
    };
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
    private responseTimeout: NodeJS.Timeout | null = null;
    private idleTimeout: NodeJS.Timeout | null = null;
    private ready = false;
    private startupBuffer = '';
    private startupParseGate = false;
    private spawnAt = 0;

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

 // Resize redraw suppression
    private resizeSuppressUntil: number = 0;

 // Debug: status transition history
    private statusHistory: { status: string; at: number; trigger?: string }[] = [];

 // ─── CLI Scripts (script-based parsing) ───
    private cliScripts: CliScripts;
    /** Full accumulated ANSI-stripped PTY output */
    private accumulatedBuffer: string = '';
    /** Full accumulated raw PTY output (with ANSI) */
    private accumulatedRawBuffer: string = '';
    /** Current visible terminal screen snapshot */
    private terminalScreen = new TerminalScreen(24, 80);
    /** Max accumulated buffer size (last 50KB) */
    private static readonly MAX_ACCUMULATED_BUFFER = 50000;
    private currentTurnScope: TurnParseScope | null = null;
    private traceEntries: CliTraceEntry[] = [];
    private traceSeq = 0;
    private traceSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    private static readonly MAX_TRACE_ENTRIES = 250;
    private readonly providerResolutionMeta: Record<string, any>;
    private static readonly IDLE_FINISH_CONFIRM_MS = 900;

    private syncMessageViews(): void {
        this.messages = [...this.committedMessages];
        this.structuredMessages = [...this.committedMessages];
    }

    private normalizeParsedMessages(parsedMessages: any[]): CliChatMessage[] {
        const referenceMessages = [...this.committedMessages];
        const usedReferenceIndexes = new Set<number>();
        const now = Date.now();

        const findReferenceTimestamp = (role: 'user' | 'assistant', content: string, parsedIndex: number): number | undefined => {
            const normalizedContent = normalizeComparableMessageContent(content);
            if (!normalizedContent) return undefined;

            const sameIndex = referenceMessages[parsedIndex];
            if (
                sameIndex
                && !usedReferenceIndexes.has(parsedIndex)
                && sameIndex.role === role
                && normalizeComparableMessageContent(sameIndex.content) === normalizedContent
                && typeof sameIndex.timestamp === 'number'
                && Number.isFinite(sameIndex.timestamp)
            ) {
                usedReferenceIndexes.add(parsedIndex);
                return sameIndex.timestamp;
            }

            for (let i = 0; i < referenceMessages.length; i++) {
                if (usedReferenceIndexes.has(i)) continue;
                const candidate = referenceMessages[i];
                if (!candidate || candidate.role !== role) continue;
                const candidateContent = normalizeComparableMessageContent(candidate.content);
                if (!candidateContent) continue;
                const exactMatch = candidateContent === normalizedContent;
                const fuzzyMatch = candidateContent.includes(normalizedContent) || normalizedContent.includes(candidateContent);
                if (!exactMatch && !fuzzyMatch) continue;
                if (typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)) {
                    usedReferenceIndexes.add(i);
                    return candidate.timestamp;
                }
            }

            return undefined;
        };

        return parsedMessages
            .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
            .map((message, index) => {
                const role = message.role as 'user' | 'assistant';
                const content = typeof message.content === 'string' ? message.content : String(message.content || '');
                const parsedTimestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
                    ? message.timestamp
                    : undefined;
                const referenceTimestamp = parsedTimestamp ?? findReferenceTimestamp(role, content, index);
                return {
                    role,
                    content,
                    timestamp: referenceTimestamp ?? now,
                };
            });
    }

    private sliceFromOffset(text: string, start: number): string {
        if (!text) return '';
        if (!Number.isFinite(start) || start <= 0) return text;
        if (start >= text.length) return '';
        return text.slice(start);
    }

    private buildParseInput(baseMessages: CliChatMessage[], partialResponse: string, scope?: TurnParseScope | null): CliScriptInput {
        const buffer = scope
            ? (this.sliceFromOffset(this.accumulatedBuffer, scope.bufferStart) || this.accumulatedBuffer)
            : this.accumulatedBuffer;
        const rawBuffer = scope
            ? (this.sliceFromOffset(this.accumulatedRawBuffer, scope.rawBufferStart) || this.accumulatedRawBuffer)
            : this.accumulatedRawBuffer;

        return {
            buffer,
            rawBuffer,
            recentBuffer: buffer.slice(-1000) || this.recentOutputBuffer,
            screenText: this.terminalScreen.getText(),
            messages: [...baseMessages],
            partialResponse,
        };
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
        this.idleFinishCandidate = {
            armedAt: now,
            lastOutputAt: this.lastOutputAt,
            lastScreenChangeAt: this.lastScreenChangeAt,
            responseEpoch: this.responseEpoch,
            assistantLength,
        };
        this.recordTrace('idle_candidate_armed', {
            confirmMs: ProviderCliAdapter.IDLE_FINISH_CONFIRM_MS,
            candidate: this.idleFinishCandidate,
            ...this.buildTraceParseSnapshot(this.currentTurnScope, this.responseBuffer),
        });
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            this.settledBuffer = this.recentOutputBuffer;
            this.evaluateSettled();
        }, ProviderCliAdapter.IDLE_FINISH_CONFIRM_MS);
    }

    private summarizeTraceText(text: string, max = 800): string {
        const value = sanitizeTerminalText(String(text || ''));
        if (value.length <= max) return value;
        return `…${value.slice(-max)}`;
    }

    private summarizeTraceMessages(messages: CliChatMessage[], limit = 3): { role: string; content: string; timestamp?: number }[] {
        return messages.slice(-limit).map((message) => ({
            role: message.role,
            content: this.summarizeTraceText(message.content, 240),
            timestamp: message.timestamp,
        }));
    }

    private buildTraceParseSnapshot(scope?: TurnParseScope | null, partialResponse = ''): Record<string, any> {
        const scopedBuffer = scope
            ? (this.sliceFromOffset(this.accumulatedBuffer, scope.bufferStart) || this.accumulatedBuffer)
            : this.accumulatedBuffer;
        const scopedRawBuffer = scope
            ? (this.sliceFromOffset(this.accumulatedRawBuffer, scope.rawBufferStart) || this.accumulatedRawBuffer)
            : this.accumulatedRawBuffer;
        return {
            currentTurnScope: scope || null,
            responseBuffer: this.summarizeTraceText(this.responseBuffer, 1200),
            partialResponse: this.summarizeTraceText(partialResponse || this.responseBuffer, 1200),
            turnBuffer: this.summarizeTraceText(scopedBuffer, 1600),
            turnRawPreview: this.summarizeTraceText(scopedRawBuffer, 1600),
            turnSanitizedRawPreview: this.summarizeTraceText(sanitizeTerminalText(scopedRawBuffer), 1600),
        };
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
    private static readonly SCRIPT_STATUS_DEBOUNCE_MS = 1000;

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

        const t = provider.timeouts || {};
        this.timeouts = {
            ptyFlush: t.ptyFlush ?? 50,
            dialogAccept: t.dialogAccept ?? 300,
            approvalCooldown: t.approvalCooldown ?? 3000,
            generatingIdle: t.generatingIdle ?? 6000,
            idleFinish: t.idleFinish ?? 5000,
            maxResponse: t.maxResponse ?? 300000,
            shutdownGrace: t.shutdownGrace ?? 1000,
            outputSettle: t.outputSettle ?? 300,
        };

        const rawKeys = (provider as any).approvalKeys;
        this.approvalKeys = (rawKeys && typeof rawKeys === 'object') ? rawKeys : {};
        this.sendDelayMs = typeof (provider as any).sendDelayMs === 'number' ? Math.max(0, (provider as any).sendDelayMs) : 0;
        this.sendKey = typeof (provider as any).sendKey === 'string' && (provider as any).sendKey.length > 0
            ? (provider as any).sendKey
            : '\r';
        this.submitStrategy = (provider as any).submitStrategy === 'immediate' ? 'immediate' : 'wait_for_echo';
        this.providerResolutionMeta = {
            type: provider.type,
            name: provider.name,
            resolvedVersion: (provider as any)._resolvedVersion || null,
            resolvedOs: (provider as any)._resolvedOs || null,
            providerDir: (provider as any)._resolvedProviderDir || null,
            scriptDir: (provider as any)._resolvedScriptDir || null,
            scriptsPath: (provider as any)._resolvedScriptsPath || null,
            scriptsSource: (provider as any)._resolvedScriptsSource || null,
            versionWarning: (provider as any)._versionWarning || null,
        };

        // Scripts are required — loaded by ProviderLoader via compatibility array
        this.cliScripts = (provider as any).scripts || {};
        const scriptNames = Object.keys(this.cliScripts).filter(k => typeof (this.cliScripts as any)[k] === 'function');
        if (scriptNames.length > 0) {
            LOG.info('CLI', `[${this.cliType}] CLI scripts: [${scriptNames.join(', ')}]`);
            LOG.info(
                'CLI',
                `[${this.cliType}] Provider resolution: providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'} source=${this.providerResolutionMeta.scriptsSource || '-'} version=${this.providerResolutionMeta.resolvedVersion || '-'}`
            );
        } else {
            LOG.warn('CLI', `[${this.cliType}] ⚠ No CLI scripts loaded! Provider needs scripts/{version}/scripts.js`);
        }
    }

    /** Inject CLI scripts after construction (e.g. when resolved by ProviderLoader) */
    setCliScripts(scripts: CliScripts): void {
        this.cliScripts = scripts;
        const scriptNames = Object.keys(scripts).filter(k => typeof (scripts as any)[k] === 'function');
        LOG.info('CLI', `[${this.cliType}] CLI scripts injected: [${scriptNames.join(', ')}]`);
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

        const { spawn: spawnConfig } = this.provider;
        const binaryPath = findBinary(spawnConfig.command);
        const isWin = os.platform() === 'win32';
        const allArgs = [...spawnConfig.args, ...this.extraArgs];

        LOG.info('CLI', `[${this.cliType}] Spawning in ${this.workingDir}`);
        this.resetTraceSession();

        let shellCmd: string;
        let shellArgs: string[];
        const useShellUnix = !isWin && (
            !!spawnConfig.shell
            || !path.isAbsolute(binaryPath)
            || isScriptBinary(binaryPath)
            || !looksLikeMachOOrElf(binaryPath)
        );
        // On Windows, .cmd/.bat shims cannot be spawned directly — must go through cmd.exe
        const isCmdShim = isWin && /\.(cmd|bat)$/i.test(binaryPath);
        const useShell = isWin ? (!!spawnConfig.shell || isCmdShim) : useShellUnix;

        if (useShell) {
            if (!spawnConfig.shell && !isWin) {
                LOG.info('CLI', `[${this.cliType}] Using login shell (script shim or non-native binary)`);
            }
            if (isCmdShim) {
                LOG.info('CLI', `[${this.cliType}] Using cmd.exe shell for .cmd/.bat shim: ${binaryPath}`);
            }
            shellCmd = isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
            if (isWin) {
                // On Windows, pass binaryPath and args as separate items so node-pty's
                // argvToCommandLine quotes each one individually. Joining them into a
                // single pre-quoted string causes cmd.exe to receive \"path\" (backslash-
                // escaped quotes) which it does not recognise as a valid executable name.
                shellArgs = ['/c', binaryPath, ...allArgs];
            } else {
                const fullCmd = [binaryPath, ...allArgs].map(shSingleQuote).join(' ');
                shellArgs = ['-l', '-c', fullCmd];
            }
        } else {
            shellCmd = binaryPath;
            shellArgs = allArgs;
        }

        const ptyOpts = {
            cols: 80,
            rows: 24,
            cwd: this.workingDir,
            env: buildCliSpawnEnv(process.env, spawnConfig.env),
        };
        this.recordTrace('spawn', {
            shellCommand: shellCmd,
            shellArgs,
            cwd: ptyOpts.cwd,
            cols: ptyOpts.cols,
            rows: ptyOpts.rows,
            providerResolution: this.providerResolutionMeta,
        });

        try {
            this.ptyProcess = this.transportFactory.spawn(shellCmd, shellArgs, ptyOpts);
        } catch (err: any) {
            const msg = err?.message || String(err);
            if (!isWin && !useShell && /posix_spawn|spawn/i.test(msg)) {
                LOG.warn('CLI', `[${this.cliType}] Direct spawn failed (${msg}), retrying via login shell`);
                shellCmd = process.env.SHELL || '/bin/zsh';
                const fullCmd = [binaryPath, ...allArgs].map(shSingleQuote).join(' ');
                shellArgs = ['-l', '-c', fullCmd];
                this.ptyProcess = this.transportFactory.spawn(shellCmd, shellArgs, ptyOpts);
            } else {
                throw err;
            }
        }

        this.ptyProcess.onData((data: string) => {
            if (Date.now() < this.resizeSuppressUntil) return;

            if (!this.ptyProcess?.terminalQueriesHandled) {
                this.respondToTerminalQueries(data);
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
        this.terminalScreen.reset(24, 80);
        this.pendingTerminalQueryTail = '';
        this.currentTurnScope = null;
        this.ready = false;
        await this.ptyProcess.ready;
        this.recordTrace('ready', {
            runtimeMeta: this.getRuntimeMetadata(),
        });
        this.setStatus('idle', 'pty_ready');
        this.onStatusChange?.();
    }

 // ─── Output Handling ────────────────────────────

    private handleOutput(rawData: string): void {
        this.terminalScreen.write(rawData);
        const cleanData = sanitizeTerminalText(rawData);
        const now = Date.now();
        const normalizedScreenSnapshot = normalizeScreenSnapshot(this.terminalScreen.getText());
        this.lastOutputAt = now;
        if (cleanData.trim()) this.lastNonEmptyOutputAt = now;
        if (normalizedScreenSnapshot !== this.lastScreenSnapshot) {
            this.lastScreenSnapshot = normalizedScreenSnapshot;
            this.lastScreenChangeAt = now;
        }
        if (this.idleFinishCandidate && (rawData.length > 0 || cleanData.length > 0)) {
            this.clearIdleFinishCandidate('new_output');
        }
        this.recordTrace('output', {
            rawLength: rawData.length,
            cleanLength: cleanData.length,
            rawPreview: this.summarizeTraceText(rawData, 300),
            cleanPreview: this.summarizeTraceText(cleanData, 300),
            screenText: this.summarizeTraceText(this.terminalScreen.getText(), 1200),
        });

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
        this.accumulatedBuffer = (this.accumulatedBuffer + cleanData).slice(-ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);
        this.accumulatedRawBuffer = (this.accumulatedRawBuffer + rawData).slice(-ProviderCliAdapter.MAX_ACCUMULATED_BUFFER);

        // ─── Startup: detect CLI readiness (no auto-proceed)
        if (this.startupParseGate) {
            this.startupBuffer += cleanData;
            const elapsed = Date.now() - this.spawnAt;
            const scriptStatus = this.runDetectStatus(this.startupBuffer);
            const screenText = this.terminalScreen.getText() || '';
            const hasInteractivePrompt = this.looksLikeVisibleIdlePrompt(screenText);
            const startupStableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : 0;
            const isReady = ((scriptStatus === 'idle' || scriptStatus === 'waiting_approval') && hasInteractivePrompt && startupStableMs >= 700)
                || elapsed > 8000
                || this.startupBuffer.length > 12000;

            if (isReady) {
                this.startupParseGate = false;
                this.ready = true;
                LOG.info(
                    'CLI',
                    `[${this.cliType}] Startup ready (${elapsed}ms, scriptStatus=${scriptStatus}, prompt=${hasInteractivePrompt}, stableMs=${startupStableMs}) providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'}`
                );
                this.onStatusChange?.();
            }
            // No early return — status detection runs from the start
        }

        // ─── Script-based status detection
        this.scheduleSettle();
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
            const modal = this.runParseApproval(tail);
            const stillWaiting = this.runDetectStatus(tail) === 'waiting_approval' || !!modal;
            if (stillWaiting) {
                this.activeModal = modal || this.activeModal || { message: 'Approval required', buttons: ['Allow', 'Deny'] };
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

    private looksLikeVisibleIdlePrompt(screenText: string): boolean {
        const text = String(screenText || '');
        if (!text.trim()) return false;
        return /(^|\n)\s*[❯›>]\s*(?:\n|$)/m.test(text)
            || /⏎\s+send/i.test(text)
            || /\?\s*for\s*shortcuts/i.test(text)
            || /Type your message(?:\s+or\s+@path\/to\/file)?/i.test(text)
            || /workspace\s*\(\/directory\)/i.test(text)
            || /for\s*shortcuts/i.test(text);
    }

    private async waitForInteractivePrompt(maxWaitMs = 5000): Promise<void> {
        const startedAt = Date.now();
        let loggedWait = false;

        while (Date.now() - startedAt < maxWaitMs) {
            const screenText = this.terminalScreen.getText() || '';
            const hasPrompt = this.looksLikeVisibleIdlePrompt(screenText);
            const stableMs = this.lastScreenChangeAt ? (Date.now() - this.lastScreenChangeAt) : 0;
            const recentlyOutput = this.lastNonEmptyOutputAt ? (Date.now() - this.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
            const status = this.runDetectStatus(this.recentOutputBuffer) || this.currentStatus;
            const startupLikelyActive = /Welcome back|Tips for getting|Recent activity|Claude Code v\d/i.test(screenText);
            const interactiveReady = hasPrompt
                && stableMs >= 700
                && recentlyOutput >= 350
                && status !== 'starting'
                && status !== 'generating';

            if (interactiveReady) {
                if (loggedWait) {
                    LOG.info(
                        'CLI',
                        `[${this.cliType}] Interactive prompt ready after ${Date.now() - startedAt}ms (stableMs=${stableMs}, recentOutputMs=${recentlyOutput}, startup=${startupLikelyActive})`
                    );
                }
                return;
            }

            if (!loggedWait && (Date.now() - startedAt) >= 400) {
                loggedWait = true;
                LOG.info(
                    'CLI',
                    `[${this.cliType}] Waiting for interactive prompt: hasPrompt=${hasPrompt} stableMs=${stableMs} recentOutputMs=${recentlyOutput} status=${status} startup=${startupLikelyActive} screen=${JSON.stringify(this.summarizeTraceText(screenText, 220)).slice(0, 260)}`
                );
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const finalScreenText = this.terminalScreen.getText() || '';
        LOG.warn(
            'CLI',
            `[${this.cliType}] Interactive prompt wait timed out after ${maxWaitMs}ms; proceeding with screen=${JSON.stringify(this.summarizeTraceText(finalScreenText, 240)).slice(0, 280)}`
        );
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
        const modal = this.runParseApproval(tail);
        const rawScriptStatus = this.runDetectStatus(tail);
        // detectStatus is the sole authority for status. parseApproval only enriches modal info.
        const scriptStatus = rawScriptStatus;
        const parsedTranscript = this.parseCurrentTranscript(
            this.committedMessages,
            this.responseBuffer,
            this.currentTurnScope,
        );
        const parsedMessages = Array.isArray(parsedTranscript?.messages)
            ? this.normalizeParsedMessages(parsedTranscript.messages)
            : [];
        const lastParsedAssistant = [...parsedMessages].reverse().find((message) => message.role === 'assistant');
        this.recordTrace('settled', {
            tail: this.summarizeTraceText(tail, 500),
            screenText: this.summarizeTraceText(screenText, 1200),
            detectStatus: scriptStatus,
            parsedStatus: parsedTranscript?.status || null,
            parsedMessageCount: parsedMessages.length,
            parsedLastAssistant: lastParsedAssistant ? this.summarizeTraceText(lastParsedAssistant.content, 280) : '',
            parsedActiveModal: parsedTranscript?.activeModal ?? null,
            approval: modal,
            ...this.buildTraceParseSnapshot(this.currentTurnScope, this.responseBuffer),
        });
        if (this.currentTurnScope && !lastParsedAssistant) {
            LOG.info(
                'CLI',
                `[${this.cliType}] Settled without assistant: prompt=${JSON.stringify(this.currentTurnScope.prompt).slice(0, 140)} responseBuffer=${JSON.stringify(this.summarizeTraceText(this.responseBuffer, 220)).slice(0, 260)} screen=${JSON.stringify(this.summarizeTraceText(screenText, 220)).slice(0, 260)} providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'}`
            );
        }
        if (!scriptStatus) return;

        const prevStatus = this.currentStatus;

        const clearPendingScriptStatus = () => {
            this.pendingScriptStatus = null;
            this.pendingScriptStatusSince = 0;
            if (this.pendingScriptStatusTimer) {
                clearTimeout(this.pendingScriptStatusTimer);
                this.pendingScriptStatusTimer = null;
            }
        };
        const armPendingScriptStatus = (delayMs: number) => {
            if (this.pendingScriptStatusTimer) clearTimeout(this.pendingScriptStatusTimer);
            this.pendingScriptStatusTimer = setTimeout(() => {
                this.pendingScriptStatusTimer = null;
                this.settledBuffer = this.recentOutputBuffer;
                this.evaluateSettled();
            }, delayMs);
        };
        const shouldDebouncePromotion = (status: string) =>
            prevStatus === 'idle'
            && !this.isWaitingForResponse
            && !this.currentTurnScope
            && (status === 'generating' || status === 'waiting_approval');

        if (shouldDebouncePromotion(scriptStatus)) {
            if (this.pendingScriptStatus !== scriptStatus) {
                this.pendingScriptStatus = scriptStatus as 'generating' | 'waiting_approval';
                this.pendingScriptStatusSince = now;
                armPendingScriptStatus(ProviderCliAdapter.SCRIPT_STATUS_DEBOUNCE_MS);
                return;
            }
            const elapsed = now - this.pendingScriptStatusSince;
            if (elapsed < ProviderCliAdapter.SCRIPT_STATUS_DEBOUNCE_MS) {
                armPendingScriptStatus(ProviderCliAdapter.SCRIPT_STATUS_DEBOUNCE_MS - elapsed);
                return;
            }
        } else {
            clearPendingScriptStatus();
        }

        if (scriptStatus === 'waiting_approval') {
            this.clearIdleFinishCandidate('waiting_approval');
            const inCooldown = this.lastApprovalResolvedAt && (Date.now() - this.lastApprovalResolvedAt) < this.timeouts.approvalCooldown;
            const visibleIdlePrompt = this.looksLikeVisibleIdlePrompt(screenText);
            if ((inCooldown || visibleIdlePrompt) && !modal) {
                if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
                this.activeModal = null;
                if (this.isWaitingForResponse) {
                    this.setStatus('generating', inCooldown ? 'approval_cooldown_ignore' : 'approval_prompt_gone');
                    if (this.idleTimeout) clearTimeout(this.idleTimeout);
                    this.idleTimeout = setTimeout(() => {
                        if (this.isWaitingForResponse && this.currentStatus !== 'waiting_approval') {
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
                this.isWaitingForResponse = true;
                this.setStatus('waiting_approval', 'script_detect');

                // Use parseApproval script for modal info
                this.activeModal = modal || { message: 'Approval required', buttons: ['Allow', 'Deny'] };

                if (this.idleTimeout) clearTimeout(this.idleTimeout);
                this.armApprovalExitTimeout();
                this.onStatusChange?.();
                return;
            }
        }

        if (scriptStatus === 'generating') {
            this.clearIdleFinishCandidate('generating');
            const effectiveScreenText = screenText || this.accumulatedBuffer;
            const noActiveTurn = !this.currentTurnScope;
            const looksIdleChrome = /(^|\n)\s*[❯›>]\s*(?:\n|$)/m.test(effectiveScreenText)
                || (/accept edits on/i.test(effectiveScreenText)
                    && (/Update available!/i.test(screenText)
                        || /\/effort/i.test(screenText)
                        || /^.*➜\s+\S+/m.test(effectiveScreenText)));
            if (prevStatus === 'idle' && !this.isWaitingForResponse && noActiveTurn && !modal && looksIdleChrome) {
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
                if (this.isWaitingForResponse) this.finishResponse();
            }, this.timeouts.generatingIdle);
            this.onStatusChange?.();
            return;
        }

        if (scriptStatus === 'idle') {
            if (prevStatus === 'waiting_approval') {
                if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
                this.activeModal = null;
                this.lastApprovalResolvedAt = Date.now();
            }
            if (this.isWaitingForResponse) {
                const visibleIdlePrompt = this.looksLikeVisibleIdlePrompt(screenText);
                const quietForMs = this.lastNonEmptyOutputAt ? (now - this.lastNonEmptyOutputAt) : Number.MAX_SAFE_INTEGER;
                const screenStableMs = this.lastScreenChangeAt ? (now - this.lastScreenChangeAt) : 0;
                const hasAssistantTurn = !!lastParsedAssistant;
                const assistantLength = lastParsedAssistant?.content?.length || 0;
                const idleQuietThresholdMs = Math.max(220, this.timeouts.outputSettle);
                const idleStableThresholdMs = Math.max(120, Math.min(220, this.timeouts.outputSettle));
                const idleReady = visibleIdlePrompt
                    && !modal
                    && hasAssistantTurn
                    && quietForMs >= idleQuietThresholdMs
                    && screenStableMs >= idleStableThresholdMs;
                const candidate = this.idleFinishCandidate;
                const candidateQuiet = !!candidate
                    && candidate.responseEpoch === this.responseEpoch
                    && candidate.lastOutputAt === this.lastOutputAt
                    && candidate.lastScreenChangeAt === this.lastScreenChangeAt
                    && assistantLength >= candidate.assistantLength
                    && (now - candidate.armedAt) >= ProviderCliAdapter.IDLE_FINISH_CONFIRM_MS;
                const canFinishImmediately = idleReady && candidateQuiet;

                this.recordTrace('idle_decision', {
                    visibleIdlePrompt,
                    quietForMs,
                    screenStableMs,
                    hasAssistantTurn,
                    assistantLength,
                    hasModal: !!modal,
                    idleQuietThresholdMs,
                    idleStableThresholdMs,
                    idleReady,
                    idleFinishConfirmMs: ProviderCliAdapter.IDLE_FINISH_CONFIRM_MS,
                    idleFinishCandidate: candidate,
                    candidateQuiet,
                    canFinishImmediately,
                    submitPendingUntil: this.submitPendingUntil,
                    responseSettleIgnoreUntil: this.responseSettleIgnoreUntil,
                    ...this.buildTraceParseSnapshot(this.currentTurnScope, this.responseBuffer),
                });

                if (canFinishImmediately) {
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
                        this.clearIdleFinishCandidate('idle_timeout_finish');
                        this.finishResponse();
                    }
                }, this.timeouts.idleFinish);
            } else if (prevStatus !== 'idle') {
                this.clearIdleFinishCandidate('idle_without_response');
                this.setStatus('idle', 'script_detect');
                this.onStatusChange?.();
            }
        }
    }

    private finishResponse(): void {
        if (this.submitPendingUntil > Date.now()) return;
        if (this.responseSettleIgnoreUntil > Date.now()) return;
        this.clearIdleFinishCandidate('finish_response_enter');
        this.recordTrace('finish_response', {
            ...this.buildTraceParseSnapshot(this.currentTurnScope, this.responseBuffer),
        });
        this.commitCurrentTranscript();
        if (this.responseTimeout) { clearTimeout(this.responseTimeout); this.responseTimeout = null; }
        if (this.idleTimeout) { clearTimeout(this.idleTimeout); this.idleTimeout = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        if (this.submitRetryTimer) { clearTimeout(this.submitRetryTimer); this.submitRetryTimer = null; }

        this.responseBuffer = '';
        this.isWaitingForResponse = false;
        this.responseSettleIgnoreUntil = 0;
        this.submitRetryUsed = false;
        this.submitRetryPromptSnippet = '';
        this.currentTurnScope = null;
        this.activeModal = null;
        this.setStatus('idle', 'response_finished');
        this.onStatusChange?.();
    }

    private commitCurrentTranscript(): void {
        const parsed = this.parseCurrentTranscript(
            this.committedMessages,
            this.responseBuffer,
            this.currentTurnScope,
        );
        if (parsed && Array.isArray(parsed.messages)) {
            this.committedMessages = this.normalizeParsedMessages(parsed.messages);
            this.syncMessageViews();
            const lastAssistant = [...this.committedMessages].reverse().find((message) => message.role === 'assistant');
            this.recordTrace('commit_transcript', {
                parsedStatus: parsed.status || null,
                messageCount: this.committedMessages.length,
                lastAssistant: lastAssistant ? this.summarizeTraceText(lastAssistant.content, 320) : '',
                messages: this.summarizeTraceMessages(this.committedMessages),
                ...this.buildTraceParseSnapshot(this.currentTurnScope, this.responseBuffer),
            });
            if (!lastAssistant && this.currentTurnScope) {
                LOG.warn(
                    'CLI',
                    `[${this.cliType}] Commit without assistant turn: prompt=${JSON.stringify(this.currentTurnScope.prompt).slice(0, 140)} responseBuffer=${JSON.stringify(this.summarizeTraceText(this.responseBuffer, 220)).slice(0, 260)} providerDir=${this.providerResolutionMeta.providerDir || '-'} scriptDir=${this.providerResolutionMeta.scriptDir || '-'} scriptsPath=${this.providerResolutionMeta.scriptsPath || '-'}`
                );
            }
        }
    }

 // ─── Script Execution ──────────────────────────

    private runDetectStatus(text: string): string | null {
        if (!this.cliScripts?.detectStatus) return null;
        try {
            return this.cliScripts.detectStatus({
                tail: text.slice(-500),
                screenText: this.terminalScreen.getText(),
                rawBuffer: this.accumulatedRawBuffer,
            });
        } catch (e: any) {
            LOG.warn('CLI', `[${this.cliType}] detectStatus error: ${e.message}`);
            return null;
        }
    }

    private runParseApproval(tail: string): { message: string; buttons: string[] } | null {
        if (!this.cliScripts?.parseApproval) return null;
        try {
            return this.cliScripts.parseApproval({
                buffer: this.terminalScreen.getText() || this.accumulatedBuffer,
                screenText: this.terminalScreen.getText(),
                rawBuffer: this.accumulatedRawBuffer,
                tail,
            });
        } catch (e: any) {
            LOG.warn('CLI', `[${this.cliType}] parseApproval error: ${e.message}`);
            return null;
        }
    }

 // ─── Public API (CliAdapter) ───────────────────

    getStatus(): CliSessionStatus {
        return {
            status: this.currentStatus,
            messages: [...this.committedMessages],
            workingDir: this.workingDir,
            activeModal: this.activeModal,
        };
    }

    /**
     * Script-based full parse — returns ReadChatResult.
     * Called by command handler / dashboard for rich content rendering.
     */
    getScriptParsedStatus(): any {
        const parsed = this.parseCurrentTranscript(
            this.committedMessages,
            this.responseBuffer,
            this.currentTurnScope,
        );
        if (parsed && Array.isArray(parsed.messages)) {
            return {
                id: parsed.id || 'cli_session',
                status: parsed.status || this.currentStatus,
                title: parsed.title || this.cliName,
                messages: parsed.messages,
                activeModal: parsed.activeModal ?? this.activeModal,
                providerSessionId: typeof parsed.providerSessionId === 'string' ? parsed.providerSessionId : undefined,
            };
        }

        const messages = [...this.committedMessages];
        return {
            id: 'cli_session',
            status: this.currentStatus,
            title: this.cliName,
            messages: messages.slice(-50).map((message, index) => ({
                id: `msg_${index}`,
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
                index,
                kind: 'standard',
            })),
            activeModal: this.activeModal,
        };
    }

    private parseCurrentTranscript(baseMessages: CliChatMessage[], partialResponse: string, scope?: TurnParseScope | null): any {
        if (!this.cliScripts?.parseOutput) return null;
        try {
            const input = this.buildParseInput(baseMessages, partialResponse, scope);
            return this.cliScripts.parseOutput(input);
        } catch (e: any) {
            LOG.warn('CLI', `[${this.cliType}] parseOutput error: ${e.message}`);
            return null;
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
        if (!promptText && data) {
            // Default fallback
            promptText = `Please fix the following issue:\n${data.title || ''}\n${data.explanation || ''}\n\n${data.message || ''}`.trim();
        }
        if (promptText) {
            await this.sendMessage(promptText);
        }
    }

    async sendMessage(text: string): Promise<void> {
        if (!this.ptyProcess) throw new Error(`${this.cliName} is not running`);
        if (this.startupParseGate) {
            const deadline = Date.now() + 10000;
            while (this.startupParseGate && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        if (!this.ready) throw new Error(`${this.cliName} not ready (status: ${this.currentStatus})`);
        if (this.isWaitingForResponse) return;
        await this.waitForInteractivePrompt();

        this.committedMessages.push({ role: 'user', content: text, timestamp: Date.now() });
        this.syncMessageViews();
        this.isWaitingForResponse = true;
        this.responseBuffer = '';
        this.clearIdleFinishCandidate('send_message');
        this.currentTurnScope = {
            prompt: text,
            startedAt: Date.now(),
            bufferStart: this.accumulatedBuffer.length,
            rawBufferStart: this.accumulatedRawBuffer.length,
        };
        this.recordTrace('send_message', {
            text: this.summarizeTraceText(text, 500),
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
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = null;
        }
        this.responseEpoch += 1;
        this.responseSettleIgnoreUntil = Date.now() + submitDelayMs + this.timeouts.outputSettle + 250;
        this.setStatus('generating', 'sendMessage');
        this.onStatusChange?.();
        const startResponseTimeout = () => {
            if (this.responseTimeout) clearTimeout(this.responseTimeout);
            this.responseTimeout = setTimeout(() => {
                if (this.isWaitingForResponse) this.finishResponse();
            }, this.timeouts.maxResponse);
        };

        const submit = () => {
            if (!this.ptyProcess) return;
            this.submitPendingUntil = 0;
            this.recordTrace('submit_write', {
                mode: 'submit_key',
                sendKey: this.sendKey,
                screenText: this.summarizeTraceText(this.terminalScreen.getText(), 500),
            });
            this.ptyProcess.write(this.sendKey);
            const retrySubmitIfStuck = (attempt: number) => {
                this.submitRetryTimer = null;
                if (!this.ptyProcess || !this.isWaitingForResponse || this.submitRetryUsed) return;
                if (this.currentStatus !== 'generating') return;
                if ((this.responseBuffer || '').trim()) return;
                const screenText = this.terminalScreen.getText();
                if (!promptLikelyVisible(screenText, normalizedPromptSnippet)) return;
                if (/Esc to interrupt|Do you want to proceed|This command requires approval|Allow Codex to|Approve and run now|Always approve this session|Running…|Running\.\.\./i.test(screenText)) return;
                this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
                LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt ${attempt})`);
                this.recordTrace('submit_write', {
                    mode: 'submit_retry',
                    attempt,
                    sendKey: this.sendKey,
                    screenText: this.summarizeTraceText(screenText, 500),
                });
                this.ptyProcess.write(this.sendKey);
                if (attempt >= 3) {
                    this.submitRetryUsed = true;
                    return;
                }
                this.submitRetryTimer = setTimeout(() => retrySubmitIfStuck(attempt + 1), retryDelayMs);
            };
            this.submitRetryTimer = setTimeout(() => retrySubmitIfStuck(1), retryDelayMs);
            startResponseTimeout();
        };

        if (this.submitStrategy === 'immediate') {
            this.submitPendingUntil = 0;
            this.recordTrace('submit_write', {
                mode: 'immediate',
                text: this.summarizeTraceText(text, 500),
                sendKey: this.sendKey,
                screenText: this.summarizeTraceText(this.terminalScreen.getText(), 500),
            });
            this.ptyProcess.write(text + this.sendKey);
            this.submitRetryTimer = setTimeout(() => {
                this.submitRetryTimer = null;
                if (!this.ptyProcess || !this.isWaitingForResponse || this.submitRetryUsed) return;
                if (this.currentStatus !== 'generating') return;
                if ((this.responseBuffer || '').trim()) return;
                const screenText = this.terminalScreen.getText();
                if (!promptLikelyVisible(screenText, normalizedPromptSnippet)) return;
                LOG.info('CLI', `[${this.cliType}] Retrying submit key for stuck prompt (attempt 1)`);
                this.responseSettleIgnoreUntil = Date.now() + this.timeouts.outputSettle + 400;
                this.recordTrace('submit_write', {
                    mode: 'immediate_retry',
                    attempt: 1,
                    sendKey: this.sendKey,
                    screenText: this.summarizeTraceText(screenText, 500),
                });
                this.ptyProcess.write(this.sendKey);
                this.submitRetryUsed = true;
            }, retryDelayMs);
            startResponseTimeout();
            return;
        }

        if (submitDelayMs > 0) {
            this.submitPendingUntil = Date.now() + submitDelayMs;
        }
        this.ptyProcess.write(text);
        this.recordTrace('submit_write', {
            mode: 'type_then_submit',
            text: this.summarizeTraceText(text, 500),
            sendKey: this.sendKey,
            screenText: this.summarizeTraceText(this.terminalScreen.getText(), 500),
        });
        const submitStartedAt = Date.now();
        let lastNormalizedScreen = '';
        let lastScreenChangeAt = submitStartedAt;
        const waitForEchoAndSubmit = () => {
            if (!this.ptyProcess) return;
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
        waitForEchoAndSubmit();
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
                if (wasProcessing) setTimeout(writeCommand, 250);
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
        if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        if (this.submitRetryTimer) { clearTimeout(this.submitRetryTimer); this.submitRetryTimer = null; }
        if (this.pendingOutputParseTimer) { clearTimeout(this.pendingOutputParseTimer); this.pendingOutputParseTimer = null; }
        this.pendingOutputParseBuffer = '';
        this.pendingTerminalQueryTail = '';
        if (this.ptyOutputFlushTimer) { clearTimeout(this.ptyOutputFlushTimer); this.ptyOutputFlushTimer = null; }
        this.ptyOutputBuffer = '';
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
        if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
        if (this.approvalExitTimeout) { clearTimeout(this.approvalExitTimeout); this.approvalExitTimeout = null; }
        if (this.submitRetryTimer) { clearTimeout(this.submitRetryTimer); this.submitRetryTimer = null; }
        if (this.pendingOutputParseTimer) { clearTimeout(this.pendingOutputParseTimer); this.pendingOutputParseTimer = null; }
        this.pendingOutputParseBuffer = '';
        this.pendingTerminalQueryTail = '';
        if (this.ptyOutputFlushTimer) { clearTimeout(this.ptyOutputFlushTimer); this.ptyOutputFlushTimer = null; }
        this.ptyOutputBuffer = '';
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
        this.terminalScreen.reset();
        this.ptyProcess?.clearBuffer?.();
        this.onStatusChange?.();
    }

    isProcessing(): boolean { return this.isWaitingForResponse; }
    isReady(): boolean { return this.ready; }

    writeRaw(data: string): void {
        this.recordTrace('write_raw', {
            keys: JSON.stringify(data),
            length: data.length,
        });
        this.ptyProcess?.write(data);
    }

    resolveModal(buttonIndex: number): void {
        if (!this.ptyProcess || (this.currentStatus !== 'waiting_approval' && !this.activeModal)) return;
        this.clearIdleFinishCandidate('resolve_modal');
        this.recordTrace('resolve_modal', {
            buttonIndex,
            activeModal: this.activeModal,
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
        return {
            type: this.cliType,
            name: this.cliName,
            providerResolution: this.providerResolutionMeta,
            status: this.currentStatus,
            ready: this.ready,
            startupParseGate: this.startupParseGate,
            spawnAt: this.spawnAt,
            workingDir: this.workingDir,
            messages: this.messages.slice(-20),
            committedMessages: this.committedMessages.slice(-20),
            structuredMessages: this.structuredMessages.slice(-20),
            messageCount: this.committedMessages.length,
            screenText: sanitizeTerminalText(this.terminalScreen.getText()).slice(-4000),
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
            activeModal: this.activeModal,
            lastApprovalResolvedAt: this.lastApprovalResolvedAt,
            sendDelayMs: this.sendDelayMs,
            sendKey: this.sendKey,
            submitStrategy: this.submitStrategy,
            submitPendingUntil: this.submitPendingUntil,
            responseSettleIgnoreUntil: this.responseSettleIgnoreUntil,
            resizeSuppressUntil: this.resizeSuppressUntil,
            hasCliScripts: this.hasCliScripts(),
            scriptNames: Object.keys(this.cliScripts).filter(k => typeof (this.cliScripts as any)[k] === 'function'),
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
            screenText: this.summarizeTraceText(this.terminalScreen.getText(), 4000),
            recentOutputBuffer: this.summarizeTraceText(this.recentOutputBuffer, 1000),
            responseBuffer: this.summarizeTraceText(this.responseBuffer, 1200),
            status: this.currentStatus,
            activeModal: this.activeModal,
            currentTurnScope: this.currentTurnScope,
            messages: this.summarizeTraceMessages(this.committedMessages, 5),
        };
    }

    getProviderResolutionMeta(): Record<string, any> {
        return { ...this.providerResolutionMeta };
    }

    private respondToTerminalQueries(data: string): void {
        if (!this.ptyProcess || !data) return;

        const combined = this.pendingTerminalQueryTail + data;
        const regex = /\x1b\[(\?)?6n/g;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(combined)) !== null) {
            const cursor = this.terminalScreen.getCursorPosition();
            const row = Math.max(1, (cursor.row | 0) + 1);
            const col = Math.max(1, (cursor.col | 0) + 1);
            const response = match[1]
                ? `\x1b[?${row};${col}R`
                : `\x1b[${row};${col}R`;
            this.ptyProcess.write(response);
        }

        this.pendingTerminalQueryTail = computeTerminalQueryTail(combined);
    }
}
