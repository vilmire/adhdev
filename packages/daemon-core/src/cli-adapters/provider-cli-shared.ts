import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ProviderResumeCapability } from '../providers/contracts.js';
import type { ChatMessageKind } from '../providers/chat-message-normalization.js';
import { sanitizeSpawnEnv } from './spawn-env.js';

export interface CliChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
    receivedAt?: number;
    kind?: ChatMessageKind;
    id?: string;
    index?: number;
    meta?: Record<string, unknown>;
    senderName?: string;
}

export interface CliSessionStatus {
    status: 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting';
    messages: CliChatMessage[];
    workingDir: string;
    activeModal: { message: string; buttons: string[] } | null;
    errorMessage?: string;
    errorReason?: string;
}

export interface CliScripts {
    parseOutput?: (input: CliScriptInput) => any;
    detectStatus?: (input: CliStatusInput) => string | null;
    parseApproval?: (input: CliApprovalInput) => { message: string; buttons: string[] } | null;
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
        .replace(/\x1B\][^\x07]*\x07/g, '')
        .replace(/\x1B\][\s\S]*?\x1B\\/g, '')
        .replace(/\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B\[\d*[A-HJKSTfG]/g, ' ')
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
        .replace(/  +/g, ' ');
}

function stripTerminalNoise(str: string): string {
    return String(str || '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        .replace(/(^|[\s([])(?:\??\d{1,4}(?:;\d{1,4})*[A-Za-z])(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:\[\??\d{1,4}(?:;\d{1,4})*[A-Za-z])(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:\d{1,4};\?)(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:\d+\$r[0-9;\" ]*[A-Za-z]?)(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:>\|[A-Za-z0-9_.:-]+(?:\([^)]*\))?)(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:[A-Z]\d(?:\s+[A-Z]\d)+)(?=$|[\s)\]])/g, '$1')
        .replace(/(^|[\s([])(?:\d+;[^\s)\]]+)(?=$|[\s)\]])/g, '$1')
        .replace(/\r+/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ {2,}/g, ' ');
}

export function sanitizeTerminalText(str: string): string {
    return stripTerminalNoise(stripAnsi(str));
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
    try {
        const cmd = isWin ? `where ${trimmed}` : `which ${trimmed}`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
    } catch {
        return isWin ? `${trimmed}.cmd` : trimmed;
    }
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
