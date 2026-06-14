import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ProviderResumeCapability } from '../providers/contracts.js';
import type { ChatMessageKind } from '../providers/chat-message-normalization.js';
import type { ChatBubbleState } from '../types.js';
import type { InteractivePrompt } from '../providers/types/interactive-prompt.js';
import { sanitizeSpawnEnv } from './spawn-env.js';

export interface CliChatMessage {
    role: string;
    content: any;
    timestamp?: number;
    receivedAt?: number;
    kind?: ChatMessageKind;
    id?: string;
    index?: number;
    providerUnitKey?: string;
    bubbleId?: string;
    bubbleState?: ChatBubbleState;
    _turnKey?: string;
    meta?: Record<string, unknown>;
    senderName?: string;
    [key: string]: any;
}

export interface CliSessionStatus {
    status: 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting';
    messages: CliChatMessage[];
    workingDir: string;
    activeModal: { message: string; buttons: string[] } | null;
    /**
     * Monotonic counter identifying which approval *entry* the current modal
     * belongs to. Bumped by the FSM on every fresh waiting_approval entry.
     * Consumers (e.g. auto-approval) use it to distinguish a genuinely new
     * approval from the same approval re-observed across TUI paint flaps —
     * two distinct approvals can carry identical message/button text, so the
     * seq is the only reliable discriminator.
     */
    approvalEntrySeq?: number;
    activeInteractivePrompt?: InteractivePrompt | null;
    pendingOutboundCount?: number;
    pendingOutboundMessages?: Array<{
        id: string;
        role: 'user';
        content: string;
        queuedAt: number;
        source: string;
    }>;
    errorMessage?: string;
    errorReason?: string;
    providerSessionId?: string;
    bufferState?: {
        responseBuffer?: { truncated: boolean; droppedChars: number; maxChars: number };
        recentOutputBuffer?: { truncated: boolean; droppedChars: number; maxChars: number };
        accumulatedBuffer?: { truncated: boolean; droppedChars: number; maxChars: number };
        accumulatedRawBuffer?: { truncated: boolean; droppedChars: number; maxChars: number };
    };
}

export interface ParsedSession {
    status: string;
    messages: any[];
    modal: { message: string; buttons: string[] } | null;
    parsedStatus: string | null;
    errorMessage?: string;
    errorReason?: string;
    providerSessionId?: string;
    transcriptAuthority?: 'provider' | 'daemon';
    coverage?: 'full' | 'tail' | 'current-turn';
}

export interface CliScripts {
    /**
     * Optional state factory. Called once per CLI session start (or script reload).
     * The returned object is passed as the first argument to detectStatus, parseApproval,
     * and parseSession on every invocation, allowing scripts to maintain per-session state
     * (e.g. last-seen status, approval fingerprints, stability counters).
     *
     * Scripts that don't define createState() receive null as the state argument,
     * making this change fully backward compatible.
     */
    createState?: () => unknown;
    parseSession?: (state: unknown, input: CliScriptInput & { tail?: string; tailScreen?: CliScreenSnapshot }) => ParsedSession | null;
    detectStatus?: (state: unknown, input: CliStatusInput) => string | null;
    parseApproval?: (state: unknown, input: CliApprovalInput) => { message: string; buttons: string[] } | null;
    resolveAction?: (data: any) => string;
    [name: string]: ((state: unknown, input: any) => any) | ((data: any) => any) | (() => unknown) | undefined;
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
    workspace?: string;
    workingDir?: string;
    providerSessionId?: string;
    historySessionId?: string;
    screen: CliScreenSnapshot;
    bufferScreen: CliScreenSnapshot;
    recentScreen: CliScreenSnapshot;
    messages: CliChatMessage[];
    partialResponse: string;
    isWaitingForResponse?: boolean;
    promptText?: string;
    settings?: Record<string, any>;
    args?: Record<string, any>;
    spawnAt?: number;
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
    activeModal: { message: string; buttons: string[] } | null;
    payload: Record<string, any>;
}

export interface CliProviderModule {
    type: string;
    name: string;
    category: 'cli';
    binary: string;
    approvalKeys?: Record<number, string>;
    sendDelayMs?: number;
    /** Wall-clock budget (ms) for a single provider script invocation. Default 50. Range 1..5000.
     *  Exceeding the budget records `timedOut: true` on the invocation trace and emits a
     *  throttled WARN — it does NOT abort the script (Node CJS can't interrupt sync code). */
    scriptCallBudgetMs?: number;
    sendKey?: string;
    submitStrategy?: 'wait_for_echo' | 'immediate';
    /** Require the typed prompt to be visible on the PTY screen before sending Enter. */
    requirePromptEchoBeforeSubmit?: boolean;
    /** Allow sending another prompt while the CLI is still generating so users can intervene mid-turn. */
    allowInputDuringGeneration?: boolean;
    /** When true, only transition to idle after the parsed transcript includes a final standard assistant message. */
    requiresFinalAssistantBeforeIdle?: boolean;
    /** When true, allow providers to augment stale snapshot data before parse. Reserved for future use. */
    augmentStaleSnapshot?: boolean;
    /** When provider-owned, daemon treats provider parser output as canonical transcript authority. */
    transcriptAuthority?: 'provider' | 'daemon';
    /** Full context lets provider-owned parsers canonicalize retained history instead of daemon prefix stitching. */
    transcriptContext?: 'full' | 'tail';
    /** v1 declarative tui block — used by CliScriptRunner to synthesize SDK helpers (declarativeDetectStatus, declarativeParseApproval). */
    tui?: Record<string, unknown>;
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
        idleFinishConfirm?: number;
        statusActivityHold?: number;
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

function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

type SavedCursor = { row: number; col: number };

function parseCount(params: string, fallback = 1): number {
    const first = Number(String(params || '').split(';')[0] || fallback);
    return Math.max(1, Number.isFinite(first) ? first : fallback);
}

function isCombiningMark(ch: string): boolean {
    return /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/.test(ch);
}

function isWideCodePoint(ch: string): boolean {
    const cp = ch.codePointAt(0) || 0;
    return cp >= 0x1100 && (
        cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
        (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE10 && cp <= 0xFE19) ||
        (cp >= 0xFE30 && cp <= 0xFE6F) ||
        (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x1F300 && cp <= 0x1FAFF)
    );
}

/**
 * Stateful, transcript-oriented terminal cell accumulator.
 *
 * CLI transcript parsing must not consume raw PTY append text for user-visible
 * readback: CLIs rewrite prompts/status/tool lines with CR, BS, CSI cursor
 * motion and erase-line. This accumulator preserves parser state across chunks
 * and mutates rendered cells before exposing plain transcript text. It is a
 * deliberately small terminal model for readback buffers; live UI rendering still
 * uses TerminalScreen's ghostty/xterm backend.
 */
export class TerminalTranscriptAccumulator {
    private lines: string[][] = [[]];
    private row = 0;
    private col = 0;
    private savedCursor: SavedCursor | null = null;
    private pendingEscape = '';

    append(data: string): string {
        const input = this.pendingEscape + String(data || '');
        this.pendingEscape = '';
        for (let i = 0; i < input.length; i += 1) {
            let ch = input[i];
            if (ch === '\x1B') {
                const consumed = this.consumeEscape(input.slice(i));
                if (consumed === 0) {
                    this.pendingEscape = input.slice(i);
                    break;
                }
                i += consumed - 1;
                continue;
            }
            const cp = input.codePointAt(i);
            if (cp && cp > 0xFFFF) {
                ch = String.fromCodePoint(cp);
                i += 1;
            }
            this.writeControlOrChar(ch);
        }
        return this.getText();
    }

    reset(): void {
        this.lines = [[]];
        this.row = 0;
        this.col = 0;
        this.savedCursor = null;
        this.pendingEscape = '';
    }

    getText(): string {
        return this.lines.map(line => line.join('').replace(/[ \t]+$/g, '')).join('\n');
    }

    private ensureRow(row = this.row): void {
        while (this.lines.length <= row) this.lines.push([]);
    }

    private writeControlOrChar(ch: string): void {
        if (ch === '\r') {
            this.col = 0;
            return;
        }
        if (ch === '\n') {
            this.row += 1;
            this.col = 0;
            this.ensureRow();
            return;
        }
        if (ch === '\b') {
            this.col = Math.max(0, this.col - 1);
            return;
        }
        if (ch < ' ' || ch === '\x7F') return;

        this.ensureRow();
        const line = this.lines[this.row];
        if (isCombiningMark(ch) && this.col > 0) {
            line[this.col - 1] = `${line[this.col - 1] || ''}${ch}`;
            return;
        }
        while (line.length < this.col) line.push(' ');
        const wide = isWideCodePoint(ch);
        line[this.col] = ch;
        if (wide) line[this.col + 1] = '';
        this.col += wide ? 2 : 1;
    }

    private consumeEscape(seq: string): number {
        if (seq.length < 2) return 0;
        const next = seq[1];
        if (next === '7') {
            this.savedCursor = { row: this.row, col: this.col };
            return 2;
        }
        if (next === '8') {
            if (this.savedCursor) {
                this.row = this.savedCursor.row;
                this.col = this.savedCursor.col;
                this.ensureRow();
            }
            return 2;
        }
        if (next === ']') {
            const bel = seq.indexOf('\x07', 2);
            const st = seq.indexOf('\x1B\\', 2);
            const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : 0;
            return end;
        }
        if (next === '[') {
            const match = seq.match(/^\x1B\[([0-?]*)([ -/]*)([@-~])/);
            if (!match) return seq.length < 32 ? 0 : 1;
            this.applyCsi(match[1] || '', match[3]);
            return match[0].length;
        }
        if (/[P^_X]/.test(next)) {
            const bel = seq.indexOf('\x07', 2);
            const st = seq.indexOf('\x1B\\', 2);
            const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : 0;
            return end;
        }
        return 2;
    }

    private applyCsi(params: string, final: string): void {
        const count = parseCount(params);
        this.ensureRow();
        if (final === 'A') this.row = Math.max(0, this.row - count);
        else if (final === 'B') this.row += count;
        else if (final === 'C') {
            // (fix) Cursor-forward must materialize spaces in the cells it
            // skips, otherwise rendered transcripts collapse "Do you" written
            // as "Do\x1b[1Cyou" into "Doyou". That mis-rendering broke
            // Claude Code's approval-prompt and prompt-line detection
            // (parseApproval saw "Doyouwanttoproceed?" and returned null).
            const line = this.lines[this.row];
            for (let c = this.col; c < this.col + count; c += 1) {
                if (line[c] === undefined) line[c] = ' ';
            }
            this.col += count;
        }
        else if (final === 'D') this.col = Math.max(0, this.col - count);
        else if (final === 'G') this.col = Math.max(0, count - 1);
        else if (final === 'H' || final === 'f') {
            const parts = String(params || '').split(';');
            this.row = Math.max(0, (Number(parts[0] || 1) || 1) - 1);
            this.col = Math.max(0, (Number(parts[1] || 1) || 1) - 1);
        } else if (final === 'J') {
            const mode = Number(params || 0) || 0;
            if (mode === 2 || mode === 3) {
                this.lines = [[]];
                this.row = 0;
                this.col = 0;
            } else if (mode === 0) {
                this.lines[this.row] = this.lines[this.row].slice(0, this.col);
                this.lines.splice(this.row + 1);
            } else if (mode === 1) {
                for (let r = 0; r < this.row; r += 1) this.lines[r] = [];
                const line = this.lines[this.row];
                for (let c = 0; c <= Math.min(this.col, line.length - 1); c += 1) line[c] = ' ';
            }
        } else if (final === 'K') {
            const mode = Number(params || 0) || 0;
            const line = this.lines[this.row];
            if (mode === 2) this.lines[this.row] = [];
            else if (mode === 1) {
                for (let c = 0; c <= Math.min(this.col, line.length - 1); c += 1) line[c] = ' ';
            } else {
                this.lines[this.row] = line.slice(0, this.col);
            }
        } else if (final === 's') {
            this.savedCursor = { row: this.row, col: this.col };
        } else if (final === 'u') {
            if (this.savedCursor) {
                this.row = this.savedCursor.row;
                this.col = this.savedCursor.col;
            }
        }
        this.ensureRow();
    }
}

function stripTerminalNoise(str: string): string {
    return String(str || '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        .replace(/\r+/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n');
}

export function sanitizeTerminalText(str: string): string {
    const accumulator = new TerminalTranscriptAccumulator();
    return stripTerminalNoise(stripAnsi(accumulator.append(str)));
}

export function listCliScriptNames(scripts: CliScripts | undefined): string[] {
    if (!scripts) return [];
    return Object.entries(scripts)
        .filter(([, fn]) => typeof fn === 'function')
        .map(([name]) => name);
}

function splitCliScreenLines(text: string): string[] {
    return String(text || '')
        .replace(/\u0007/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''));
}

function isPromptLikeCliLine(line: string): boolean {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    return /^[❯›>]\s*(?:$|\S.*)$/.test(trimmed);
}

export function buildCliScreenSnapshot(text: string): CliScreenSnapshot {
    const normalizedText = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawLines = splitCliScreenLines(normalizedText);
    const lines = rawLines.map((line, index, arr) => {
        const trimmed = String(line || '').trim();
        return {
            index,
            fromTop: index,
            fromBottom: arr.length - index - 1,
            text: line,
            trimmed,
            isEmpty: trimmed.length === 0,
        };
    });
    const nonEmptyLines = lines.filter((line) => !line.isEmpty);
    const firstNonEmptyLine = nonEmptyLines[0] ?? null;
    const lastNonEmptyLine = nonEmptyLines[nonEmptyLines.length - 1] ?? null;
    let promptLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (isPromptLikeCliLine(lines[i].text)) {
            promptLineIndex = i;
            break;
        }
    }
    return {
        text: normalizedText,
        lineCount: lines.length,
        lines,
        nonEmptyLines,
        firstNonEmptyLineIndex: firstNonEmptyLine?.index ?? -1,
        lastNonEmptyLineIndex: lastNonEmptyLine?.index ?? -1,
        firstNonEmptyLine,
        lastNonEmptyLine,
        promptLineIndex,
        promptLine: promptLineIndex >= 0 ? lines[promptLineIndex] : null,
        linesAbovePrompt: promptLineIndex >= 0 ? lines.slice(0, promptLineIndex) : [...lines],
        linesBelowPrompt: promptLineIndex >= 0 ? lines.slice(promptLineIndex + 1) : [],
    };
}

export const buildCliSpawnEnv = sanitizeSpawnEnv;

export function computeTerminalQueryTail(buffer: string): string {
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

export function findBinary(name: string): string {
    const trimmed = String(name || '').trim();
    if (!trimmed) return trimmed;
    const expanded = trimmed.startsWith('~')
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;
    if (path.isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\')) {
        return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    }
    const isWin = os.platform() === 'win32';
    const paths = (process.env.PATH || '').split(path.delimiter);
    const exes = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
    
    for (const p of paths) {
        if (!p) continue;
        for (const ext of exes) {
            const fullPath = path.join(p, trimmed + ext);
            try {
                const fs = require('fs');
                if (fs.existsSync(fullPath)) {
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile() && (isWin || (stat.mode & 0o111))) {
                        return fullPath;
                    }
                }
            } catch { }
        }
    }
    return isWin ? `${trimmed}.cmd` : trimmed;
}

export function isScriptBinary(binaryPath: string): boolean {
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
        return head[i] === 0x23 && head[i + 1] === 0x21;
    } catch {
        return false;
    }
}

export function looksLikeMachOOrElf(filePath: string): boolean {
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
        if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true;
        const le = b.readUInt32LE(0);
        const be = b.readUInt32BE(0);
        const magics = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca];
        return magics.some(m => m === le || m === be);
    } catch {
        return false;
    }
}

export function shSingleQuote(arg: string): string {
    if (/^[a-zA-Z0-9@%_+=:,./-]+$/.test(arg)) return arg;
    if (os.platform() === 'win32') {
        return `"${arg.replace(/"/g, '""')}"`;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function estimatePromptDisplayLines(text: string, cols = 80): number {
    const normalized = String(text || '').replace(/\r/g, '');
    if (!normalized) return 1;
    return normalized
        .split('\n')
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / cols)), 0);
}

export function extractPromptRetrySnippet(text: string): string {
    const lines = String(text || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const candidate = lines[lines.length - 1] || lines[0] || '';
    return candidate.slice(-120);
}

export function normalizePromptText(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

export function compactPromptText(text: string): string {
    return String(text || '').replace(/\s+/g, '').trim();
}

export function promptLikelyVisible(screenText: string, promptSnippet: string): boolean {
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

export function normalizeScreenSnapshot(text: string): string {
    return sanitizeTerminalText(String(text || ''))
        .replace(/\s+/g, ' ')
        .trim();
}

const COMMON_COMPARABLE_WRAP_WORDS = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'then', 'this', 'to', 'was', 'with',
]);

function shouldReflowComparableMessageLines(lines: string[]): boolean {
    return Array.isArray(lines)
        && lines.length > 1
        && lines.slice(0, -1).every((line) => String(line || '').trim().length >= 48)
        && !lines.some((line) => /^```/.test(line))
        && !lines.some((line) => /^\|/.test(line))
        && !lines.some((line) => /^\s*(?:[-*+] |\d+\.\s)/.test(line));
}

function joinComparableMessageLines(lines: string[]): string {
    return lines.reduce((acc, line) => {
        const next = String(line || '').trim();
        if (!next) return acc;
        if (!acc) return next;

        if (/[,\d]$/.test(acc) && /^\d/.test(next)) {
            return `${acc}${next}`;
        }

        if (/[A-Za-z]$/.test(acc) && /^\d/.test(next)) {
            return `${acc}${next}`;
        }

        const fragmentMatch = acc.match(/([A-Za-z]{1,4})$/);
        const fragment = fragmentMatch ? fragmentMatch[1].toLowerCase() : '';
        if (/^[a-z]/.test(next) && fragment && !COMMON_COMPARABLE_WRAP_WORDS.has(fragment)) {
            return `${acc}${next}`;
        }

        return `${acc} ${next}`;
    }, '')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/(\d)\s+,/g, '$1,')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeComparableMessageContent(text: string): string {
    const lines = String(text || '')
        .split(/\r\n|\n|\r/g)
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) return '';
    if (shouldReflowComparableMessageLines(lines)) {
        return joinComparableMessageLines(lines);
    }
    return lines.join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function trimPromptEchoPrefix(text: string, promptText?: string | null): string {
    const prompt = normalizeComparableMessageContent(String(promptText || ''));
    if (!prompt) return String(text || '');

    const lines = String(text || '').split(/\r\n|\n|\r/g);
    let dropCount = 0;
    for (let index = 0; index < Math.min(lines.length, 6); index += 1) {
        const fragment = normalizeComparableMessageContent(lines[index].replace(/^[.…]+\s*/, ''));
        if (!fragment) {
            if (dropCount === index) dropCount = index + 1;
            continue;
        }
        const fragmentWordCount = fragment ? fragment.split(/\s+/).filter(Boolean).length : 0;
        const canBePromptEcho = fragment.length >= 16 || fragmentWordCount >= 4;
        if (canBePromptEcho && prompt.includes(fragment)) {
            dropCount = index + 1;
            continue;
        }
        break;
    }

    return lines.slice(dropCount).join('\n').trim();
}

export function getLastUserPromptText(messages: Array<{ role?: string; content?: string }> | null | undefined): string {
    const items = Array.isArray(messages) ? messages : [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const message = items[index];
        if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
            return message.content;
        }
    }
    return '';
}

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

export function normalizeCliProviderForRuntime(raw: unknown): { patterns: { approval: RegExp[] } } {
    const patterns = raw && typeof raw === 'object' ? (raw as { patterns?: unknown }).patterns : undefined;
    return {
        patterns: {
            approval: coercePatternArray(
                patterns && typeof patterns === 'object' ? (patterns as { approval?: unknown }).approval : undefined,
            ),
        },
    };
}
