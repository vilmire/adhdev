/**
 * Chat History Persistence — Persist completed chat messages to local disk
 * 
 * Design:
 * - ~/.adhdev/history/{agentType}/YYYY-MM-DD.jsonl
 * - JSONL format (one line = one message, append-friendly)
 * - Track only new messages (hash comparison with previous)
 * - Auto-rotation (delete files older than 30 days)
 * - Async/non-blocking (no impact on chat collection)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildRuntimeSystemChatMessage } from '../providers/chat-message-normalization.js';
import { normalizeProviderSessionId } from '../providers/provider-session-id.js';

const HISTORY_DIR = path.join(os.homedir(), '.adhdev', 'history');
const RETAIN_DAYS = 30;
const SAVED_HISTORY_INDEX_VERSION = 1;
const SAVED_HISTORY_INDEX_FILE = '.saved-history-index.json';
const SAVED_HISTORY_INDEX_LOCK_SUFFIX = '.lock';
const SAVED_HISTORY_INDEX_LOCK_WAIT_MS = 1500;
const SAVED_HISTORY_INDEX_LOCK_STALE_MS = 15_000;
const SAVED_HISTORY_INDEX_LOCK_POLL_MS = 25;
export const SAVED_HISTORY_ROLLUP_THRESHOLD_BYTES = 16 * 1024 * 1024;

interface SavedHistorySessionCacheEntry {
    signature: string;
    summaries: SavedHistorySessionSummary[];
}

const savedHistorySessionCache = new Map<string, SavedHistorySessionCacheEntry>();

interface SavedHistoryFileSummaryCacheEntry {
    signature: string;
    summary: SavedHistoryFileSummary | null;
}

interface SavedHistoryFileSummary {
    file: string;
    historySessionId: string;
    messageCount: number;
    firstMessageAt: number;
    lastMessageAt: number;
    sessionTitle?: string;
    preview?: string;
    workspace?: string;
}

interface PersistedSavedHistoryIndexFile {
    version: number;
    files: Record<string, SavedHistoryFileSummaryCacheEntry>;
    sessions?: Record<string, SavedHistorySessionSummary>;
}

const savedHistoryFileSummaryCache = new Map<string, SavedHistoryFileSummaryCacheEntry>();
const savedHistoryBackgroundRefresh = new Set<string>();
const savedHistoryRollupInFlight = new Set<string>();

interface HistoryMessage {
    ts: string;           // ISO timestamp
    receivedAt: number;   // epoch ms
    role: 'user' | 'assistant' | 'system';
    content: string;
    kind?: string;
    senderName?: string;
    agent: string;        // e.g. 'antigravity', 'cursor', 'gemini-cli'
    instanceId?: string;  // IDE instance UUID (distinguishes windows of the same agent type)
    historySessionId?: string; // Persistent provider-side conversation/session key
    sessionTitle?: string;
    workspace?: string;   // Working directory at session start (kind: 'session_start' only)
}

const CODEX_STARTER_PROMPT_RE = /^(?:[›❯]\s*)?(?:Find and fix a bug in @filename|Improve documentation in @filename|Write tests for @filename|Explain this codebase|Summarize recent commits|Implement \{feature\}|Use \/skills(?: to list available skills)?|Run \/review on my current changes)$/i;

function normalizeHistoryComparable(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanupHistoryContent(agentType: string, role: HistoryMessage['role'], content: string): string {
    let value = String(content || '').replace(/\r\n/g, '\n').trim();
    if (!value) return '';

    if (agentType === 'codex-cli' && role === 'assistant') {
        const filtered = value
            .split('\n')
            .filter((line) => !CODEX_STARTER_PROMPT_RE.test(line.trim()))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        value = filtered;
    }

    return value;
}

function buildHistoryMessageHash(
    agentType: string,
    message: Pick<HistoryMessage, 'role' | 'content' | 'receivedAt' | 'kind'> & { historyDedupKey?: string },
): string {
    if (message.historyDedupKey) return message.historyDedupKey;
    const cleaned = cleanupHistoryContent(agentType, message.role, message.content);
    return `${message.kind || 'standard'}:${message.role}:${message.receivedAt || 0}:${normalizeHistoryComparable(cleaned)}`;
}

function buildHistoryMessageSignature(
    agentType: string,
    message: Pick<HistoryMessage, 'role' | 'content' | 'kind'>,
): string {
    const cleaned = cleanupHistoryContent(agentType, message.role, message.content);
    return `${message.kind || 'standard'}:${message.role}:${normalizeHistoryComparable(cleaned)}`;
}

function isAdjacentHistoryDuplicate(
    agentType: string,
    previous: Pick<HistoryMessage, 'role' | 'content' | 'kind'> | null | undefined,
    next: Pick<HistoryMessage, 'role' | 'content' | 'kind'> | null | undefined,
): boolean {
    if (!previous || !next) return false;
    return buildHistoryMessageSignature(agentType, previous) === buildHistoryMessageSignature(agentType, next);
}

function collapseReplayAssistantTurns(agentType: string, messages: HistoryMessage[]): HistoryMessage[] {
    if (agentType !== 'codex-cli') return messages;

    const collapsed: HistoryMessage[] = [];
    let sawAssistantSinceLastUser = false;

    for (const message of messages) {
        if (message.role === 'user') {
            sawAssistantSinceLastUser = false;
            collapsed.push(message);
            continue;
        }

        if (message.role === 'assistant') {
            if (sawAssistantSinceLastUser) continue;
            sawAssistantSinceLastUser = true;
            collapsed.push(message);
            continue;
        }

        collapsed.push(message);
    }

    return collapsed;
}

function sanitizeHistoryMessage(agentType: string, message: HistoryMessage): HistoryMessage | null {
    if (!message || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system')) {
        return null;
    }
    const content = cleanupHistoryContent(agentType, message.role, message.content);
    if (!content) return null;
    return {
        ...message,
        content,
    };
}

export interface SavedHistorySessionSummary {
    historySessionId: string;
    sessionTitle?: string;
    messageCount: number;
    firstMessageAt: number;
    lastMessageAt: number;
    preview?: string;
    workspace?: string;
}

function sortSavedHistorySessionSummaries(summaries: SavedHistorySessionSummary[]): SavedHistorySessionSummary[] {
    return summaries.slice().sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

function buildSavedHistorySessionSummaryMapFromEntries(entries: Map<string, SavedHistoryFileSummaryCacheEntry>): Record<string, SavedHistorySessionSummary> {
    const summaries = new Map<string, SavedHistorySessionSummary>();

    for (const entry of Array.from(entries.values())) {
        const fileSummary = entry.summary;
        if (!fileSummary || fileSummary.messageCount <= 0 || !fileSummary.lastMessageAt) continue;
        const existing = summaries.get(fileSummary.historySessionId);
        if (!existing) {
            summaries.set(fileSummary.historySessionId, {
                historySessionId: fileSummary.historySessionId,
                sessionTitle: fileSummary.sessionTitle,
                messageCount: fileSummary.messageCount,
                firstMessageAt: fileSummary.firstMessageAt,
                lastMessageAt: fileSummary.lastMessageAt,
                preview: fileSummary.preview,
                workspace: fileSummary.workspace,
            });
            continue;
        }
        existing.messageCount += fileSummary.messageCount;
        if (!existing.firstMessageAt || fileSummary.firstMessageAt < existing.firstMessageAt) {
            existing.firstMessageAt = fileSummary.firstMessageAt;
        }
        if (fileSummary.lastMessageAt >= existing.lastMessageAt) {
            existing.lastMessageAt = fileSummary.lastMessageAt;
            if (fileSummary.sessionTitle) existing.sessionTitle = fileSummary.sessionTitle;
            if (fileSummary.preview) existing.preview = fileSummary.preview;
        }
        if (!existing.workspace && fileSummary.workspace) {
            existing.workspace = fileSummary.workspace;
        }
    }

    return Object.fromEntries(sortSavedHistorySessionSummaries(Array.from(summaries.values())).map((summary) => [summary.historySessionId, summary]));
}

function readPersistedSavedHistorySessionSummaries(dir: string): SavedHistorySessionSummary[] | null {
    try {
        const filePath = getSavedHistoryIndexFilePath(dir);
        if (!fs.existsSync(filePath)) return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedSavedHistoryIndexFile;
        if (!raw || raw.version !== SAVED_HISTORY_INDEX_VERSION || !raw.sessions || typeof raw.sessions !== 'object') {
            return null;
        }
        return sortSavedHistorySessionSummaries(
            Object.values(raw.sessions)
                .filter((summary) => !!summary && typeof summary.historySessionId === 'string' && summary.messageCount > 0 && summary.lastMessageAt > 0)
                .map((summary) => ({
                    historySessionId: summary.historySessionId,
                    sessionTitle: summary.sessionTitle,
                    messageCount: summary.messageCount,
                    firstMessageAt: summary.firstMessageAt,
                    lastMessageAt: summary.lastMessageAt,
                    preview: summary.preview,
                    workspace: summary.workspace,
                })),
        );
    } catch {
        return null;
    }
}

export function shouldScheduleSavedHistoryRollup(totalBytes: number): boolean {
    return Number.isFinite(totalBytes) && totalBytes >= SAVED_HISTORY_ROLLUP_THRESHOLD_BYTES;
}

function sanitizeHistoryFileSegment(value?: string): string {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function listHistoryFiles(dir: string, historySessionId?: string): string[] {
    const sanitizedSessionId = historySessionId ? sanitizeHistoryFileSegment(historySessionId) : '';
    return fs.readdirSync(dir)
        .filter((file) => {
            if (!file.endsWith('.jsonl')) return false;
            if (sanitizedSessionId) {
                return file.startsWith(`${sanitizedSessionId}_`);
            }
            return true;
        })
        .sort()
        .reverse();
}

function normalizeSavedHistorySessionId(agentType: string, historySessionId: string): string {
    const normalizedId = String(historySessionId || '').trim();
    if (!normalizedId) return '';
    const strictProviderId = normalizeProviderSessionId(agentType, normalizedId);
    if (strictProviderId) return strictProviderId;
    return agentType === 'hermes-cli' ? '' : normalizedId;
}

function extractSavedHistorySessionIdFromFile(agentType: string, file: string): string {
    const match = file.match(/^([A-Za-z0-9_-]+)_\d{4}-\d{2}-\d{2}\.jsonl$/);
    return normalizeSavedHistorySessionId(agentType, match?.[1] || '');
}

function buildSavedHistoryFileSignatureMap(dir: string, files: string[]): Map<string, string> {
    return new Map(files.map((file) => {
        try {
            const stat = fs.statSync(path.join(dir, file));
            return [file, `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`] as const;
        } catch {
            return [file, `${file}:missing`] as const;
        }
    }));
}

function buildSavedHistoryCacheSignature(files: string[], fileSignatures: Map<string, string>): string {
    return files.map((file) => fileSignatures.get(file) || `${file}:missing`).join('|');
}

function getSavedHistoryIndexFilePath(dir: string): string {
    return path.join(dir, SAVED_HISTORY_INDEX_FILE);
}

function getSavedHistoryIndexLockPath(dir: string): string {
    return `${getSavedHistoryIndexFilePath(dir)}${SAVED_HISTORY_INDEX_LOCK_SUFFIX}`;
}

function sleepBlocking(ms: number): void {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadPersistedSavedHistoryIndexFromFile(dir: string): Map<string, SavedHistoryFileSummaryCacheEntry> {
    try {
        const filePath = getSavedHistoryIndexFilePath(dir);
        if (!fs.existsSync(filePath)) return new Map();
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedSavedHistoryIndexFile;
        if (!raw || raw.version !== SAVED_HISTORY_INDEX_VERSION || !raw.files || typeof raw.files !== 'object') {
            return new Map();
        }
        return new Map(
            Object.entries(raw.files)
                .filter(([file, entry]) => !!file && !!entry && typeof entry.signature === 'string')
                .map(([file, entry]) => [file, {
                    signature: entry.signature,
                    summary: entry.summary || null,
                }]),
        );
    } catch {
        return new Map();
    }
}

function writePersistedSavedHistoryIndexFile(dir: string, entries: Map<string, SavedHistoryFileSummaryCacheEntry>): void {
    const filePath = getSavedHistoryIndexFilePath(dir);
    const tempPath = `${filePath}.tmp`;
    const payload: PersistedSavedHistoryIndexFile = {
        version: SAVED_HISTORY_INDEX_VERSION,
        files: Object.fromEntries(entries.entries()),
        sessions: buildSavedHistorySessionSummaryMapFromEntries(entries),
    };
    fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tempPath, filePath);
}

function acquireSavedHistoryIndexLock(dir: string): (() => void) | null {
    const lockPath = getSavedHistoryIndexLockPath(dir);
    const deadline = Date.now() + SAVED_HISTORY_INDEX_LOCK_WAIT_MS;

    while (Date.now() <= deadline) {
        try {
            fs.mkdirSync(lockPath);
            return () => {
                try {
                    fs.rmSync(lockPath, { recursive: true, force: true });
                } catch {
                    // Ignore lock cleanup failures.
                }
            };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') return null;
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > SAVED_HISTORY_INDEX_LOCK_STALE_MS) {
                    fs.rmSync(lockPath, { recursive: true, force: true });
                    continue;
                }
            } catch {
                // Lock disappeared between stat attempts; retry immediately.
                continue;
            }
            sleepBlocking(SAVED_HISTORY_INDEX_LOCK_POLL_MS);
        }
    }

    return null;
}

function withLockedPersistedSavedHistoryIndex<T>(
    dir: string,
    callback: (entries: Map<string, SavedHistoryFileSummaryCacheEntry>) => T,
): T | null {
    const release = acquireSavedHistoryIndexLock(dir);
    if (!release) return null;
    try {
        const entries = loadPersistedSavedHistoryIndexFromFile(dir);
        const result = callback(entries);
        writePersistedSavedHistoryIndexFile(dir, entries);
        return result;
    } catch {
        return null;
    } finally {
        release();
    }
}

function loadPersistedSavedHistoryIndex(dir: string): Map<string, SavedHistoryFileSummaryCacheEntry> {
    return loadPersistedSavedHistoryIndexFromFile(dir);
}

function savePersistedSavedHistoryIndex(dir: string, entries: Map<string, SavedHistoryFileSummaryCacheEntry>): void {
    withLockedPersistedSavedHistoryIndex(dir, (currentEntries) => {
        const incomingFiles = new Set(Array.from(entries.keys()));
        for (const [file, entry] of Array.from(entries.entries())) {
            const liveSignature = buildSavedHistoryFileSignature(dir, file);
            const existingEntry = currentEntries.get(file);
            if (existingEntry && existingEntry.signature !== liveSignature && entry.signature !== liveSignature) {
                continue;
            }
            if (entry.signature !== liveSignature && (!existingEntry || existingEntry.signature !== liveSignature)) {
                continue;
            }
            currentEntries.set(file, entry.signature === liveSignature ? entry : {
                signature: liveSignature,
                summary: existingEntry?.summary || entry.summary,
            });
        }
        for (const file of Array.from(currentEntries.keys())) {
            if (incomingFiles.has(file)) continue;
            if (!fs.existsSync(path.join(dir, file))) {
                currentEntries.delete(file);
            }
        }
    });
}

function invalidatePersistedSavedHistoryIndex(agentType: string, dir: string): void {
    try {
        fs.rmSync(getSavedHistoryIndexFilePath(dir), { force: true });
    } catch {
        // Ignore persisted index cleanup failures.
    }
    savedHistorySessionCache.delete(agentType.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function getSavedHistoryFileSummaryCacheEntry(dir: string, file: string): SavedHistoryFileSummaryCacheEntry | null {
    const filePath = path.join(dir, file);
    const cached = savedHistoryFileSummaryCache.get(filePath);
    if (cached) return cached;
    const persisted = loadPersistedSavedHistoryIndex(dir).get(file) || null;
    if (persisted) {
        savedHistoryFileSummaryCache.set(filePath, persisted);
    }
    return persisted;
}

function buildSavedHistoryIndexFileSignature(dir: string): string {
    try {
        const stat = fs.statSync(getSavedHistoryIndexFilePath(dir));
        return `index:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch {
        return 'index:missing';
    }
}

function historyDirectoryHasFilesNewerThanIndex(dir: string): boolean {
    try {
        const indexStat = fs.statSync(getSavedHistoryIndexFilePath(dir));
        const files = listHistoryFiles(dir);
        for (const file of files) {
            const stat = fs.statSync(path.join(dir, file));
            if (stat.mtimeMs > indexStat.mtimeMs) return true;
        }
        return false;
    } catch {
        return true;
    }
}

function buildSavedHistoryFileSignature(dir: string, file: string): string {
    try {
        const stat = fs.statSync(path.join(dir, file));
        return `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch {
        return `${file}:missing`;
    }
}

function persistSavedHistoryFileSummaryEntry(agentType: string, dir: string, file: string, updater: (currentSummary: SavedHistoryFileSummary | null) => SavedHistoryFileSummary | null): void {
    const filePath = path.join(dir, file);
    const result = withLockedPersistedSavedHistoryIndex(dir, (entries) => {
        const currentEntry = entries.get(file) || null;
        const nextSummary = updater(currentEntry?.summary || null);
        const nextEntry: SavedHistoryFileSummaryCacheEntry = {
            signature: buildSavedHistoryFileSignature(dir, file),
            summary: nextSummary,
        };
        entries.set(file, nextEntry);
        savedHistoryFileSummaryCache.set(filePath, nextEntry);
        return nextEntry;
    });
    if (!result) return;
    if (result.summary?.historySessionId && shouldScheduleSavedHistoryRollupForSignature(result.signature)) {
        scheduleSavedHistoryRollup(agentType, result.summary.historySessionId);
    }
}

function updateSavedHistoryIndexForSessionStart(agentType: string, dir: string, file: string, historySessionId: string, workspace: string): void {
    const normalizedSessionId = normalizeSavedHistorySessionId(agentType, historySessionId);
    const normalizedWorkspace = String(workspace || '').trim();
    if (!normalizedSessionId || !normalizedWorkspace) return;
    persistSavedHistoryFileSummaryEntry(agentType, dir, file, (currentSummary) => ({
        file,
        historySessionId: normalizedSessionId,
        messageCount: currentSummary?.messageCount || 0,
        firstMessageAt: currentSummary?.firstMessageAt || 0,
        lastMessageAt: currentSummary?.lastMessageAt || 0,
        sessionTitle: currentSummary?.sessionTitle,
        preview: currentSummary?.preview,
        workspace: normalizedWorkspace,
    }));
}

function updateSavedHistoryIndexForAppendedMessages(
    agentType: string,
    dir: string,
    file: string,
    historySessionId: string | undefined,
    messages: HistoryMessage[],
): void {
    const normalizedSessionId = normalizeSavedHistorySessionId(agentType, historySessionId || '');
    if (!normalizedSessionId || messages.length === 0) return;
    persistSavedHistoryFileSummaryEntry(agentType, dir, file, (currentSummary) => {
        const nextSummary: SavedHistoryFileSummary = {
            file,
            historySessionId: normalizedSessionId,
            messageCount: currentSummary?.messageCount || 0,
            firstMessageAt: currentSummary?.firstMessageAt || 0,
            lastMessageAt: currentSummary?.lastMessageAt || 0,
            sessionTitle: currentSummary?.sessionTitle,
            preview: currentSummary?.preview,
            workspace: currentSummary?.workspace,
        };

        for (const message of messages) {
            if (!message || message.historySessionId !== historySessionId) continue;
            if (message.kind === 'session_start') {
                if (message.workspace) nextSummary.workspace = message.workspace;
                continue;
            }
            nextSummary.messageCount += 1;
            if (!nextSummary.firstMessageAt || message.receivedAt < nextSummary.firstMessageAt) {
                nextSummary.firstMessageAt = message.receivedAt;
            }
            if (!nextSummary.lastMessageAt || message.receivedAt >= nextSummary.lastMessageAt) {
                nextSummary.lastMessageAt = message.receivedAt;
                if (message.sessionTitle) nextSummary.sessionTitle = message.sessionTitle;
                if (message.role !== 'system' && message.content.trim()) nextSummary.preview = message.content.trim();
            } else if (message.sessionTitle) {
                nextSummary.sessionTitle = message.sessionTitle;
            }
            if (!nextSummary.preview && message.role !== 'system' && message.content.trim()) {
                nextSummary.preview = message.content.trim();
            }
        }

        return nextSummary;
    });
}

function computeSavedHistoryFileSummary(agentType: string, dir: string, file: string): SavedHistoryFileSummary | null {
    const historySessionId = extractSavedHistorySessionIdFromFile(agentType, file);
    if (!historySessionId) return null;

    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    let messageCount = 0;
    let firstMessageAt = 0;
    let lastMessageAt = 0;
    let sessionTitle = '';
    let preview = '';
    let workspace = '';

    for (const line of lines) {
        let parsed: HistoryMessage | null = null;
        try {
            parsed = JSON.parse(line) as HistoryMessage;
        } catch {
            parsed = null;
        }
        if (!parsed || parsed.historySessionId !== historySessionId) continue;
        if (parsed.kind === 'session_start') {
            if (!workspace && parsed.workspace) workspace = parsed.workspace;
            continue;
        }
        messageCount += 1;
        if (!firstMessageAt || parsed.receivedAt < firstMessageAt) firstMessageAt = parsed.receivedAt;
        if (!lastMessageAt || parsed.receivedAt > lastMessageAt) lastMessageAt = parsed.receivedAt;
        if (parsed.sessionTitle) sessionTitle = parsed.sessionTitle;
        if (parsed.role !== 'system' && parsed.content.trim()) preview = parsed.content.trim();
    }

    if (messageCount === 0 || !lastMessageAt) return null;
    return {
        file,
        historySessionId,
        messageCount,
        firstMessageAt,
        lastMessageAt,
        sessionTitle: sessionTitle || undefined,
        preview: preview || undefined,
        workspace: workspace || undefined,
    };
}

function shouldScheduleSavedHistoryRollupForSignature(signature: string): boolean {
    const parts = String(signature || '').split(':');
    const size = Number(parts[1] || 0);
    return shouldScheduleSavedHistoryRollup(size);
}

function scheduleSavedHistoryRollup(agentType: string, historySessionId: string): void {
    const key = `${agentType}:${historySessionId}`;
    if (!historySessionId || savedHistoryRollupInFlight.has(key)) return;
    savedHistoryRollupInFlight.add(key);
    setTimeout(() => {
        try {
            new ChatHistoryWriter().compactHistorySession(agentType, historySessionId);
        } finally {
            savedHistoryRollupInFlight.delete(key);
        }
    }, 0);
}

function scheduleSavedHistoryBackgroundRefresh(agentType: string, dir: string): void {
    const key = `${agentType}:${dir}`;
    if (savedHistoryBackgroundRefresh.has(key)) return;
    savedHistoryBackgroundRefresh.add(key);
    setTimeout(() => {
        try {
            if (!fs.existsSync(dir)) return;
            const files = listHistoryFiles(dir);
            const fileSignatures = buildSavedHistoryFileSignatureMap(dir, files);
            const persistedEntries = loadPersistedSavedHistoryIndex(dir);
            const computed = computeSavedHistorySessionSummaries(agentType, dir, files, fileSignatures, persistedEntries);
            savePersistedSavedHistoryIndex(dir, computed.persistedEntries || new Map());
            const refreshedIndexSignature = buildSavedHistoryIndexFileSignature(dir);
            savedHistorySessionCache.set(agentType.replace(/[^a-zA-Z0-9_-]/g, '_'), {
                signature: refreshedIndexSignature,
                summaries: computed.summaries || [],
            });
            for (const [file, entry] of Array.from(computed.persistedEntries.entries())) {
                if (!entry?.summary || !shouldScheduleSavedHistoryRollupForSignature(entry.signature)) continue;
                scheduleSavedHistoryRollup(agentType, entry.summary.historySessionId);
            }
        } catch {
            // Ignore background refresh failures.
        } finally {
            savedHistoryBackgroundRefresh.delete(key);
        }
    }, 0);
}

function computeSavedHistorySessionSummaries(
    agentType: string,
    dir: string,
    files: string[],
    fileSignatures: Map<string, string>,
    persistedEntries: Map<string, SavedHistoryFileSummaryCacheEntry>,
): { summaries: SavedHistorySessionSummary[]; persistedEntries: Map<string, SavedHistoryFileSummaryCacheEntry> } {
    const summaryBySessionId = new Map<string, SavedHistorySessionSummary>();
    const nextPersistedEntries = new Map<string, SavedHistoryFileSummaryCacheEntry>();

    for (const file of files.slice().sort()) {
        const filePath = path.join(dir, file);
        const signature = fileSignatures.get(file) || `${file}:missing`;
        const cached = savedHistoryFileSummaryCache.get(filePath);
        const persisted = persistedEntries.get(file);
        const reusableEntry = cached?.signature === signature
            ? cached
            : persisted?.signature === signature
                ? persisted
                : null;
        const fileSummary = reusableEntry?.summary || computeSavedHistoryFileSummary(agentType, dir, file);
        const nextEntry: SavedHistoryFileSummaryCacheEntry = reusableEntry || {
            signature,
            summary: fileSummary,
        };

        if (!reusableEntry) {
            nextEntry.signature = signature;
            nextEntry.summary = fileSummary;
        }
        savedHistoryFileSummaryCache.set(filePath, nextEntry);
        nextPersistedEntries.set(file, nextEntry);

        if (!fileSummary) continue;
        const existing = summaryBySessionId.get(fileSummary.historySessionId);
        if (fileSummary.messageCount <= 0 || !fileSummary.lastMessageAt) {
            continue;
        }
        if (!existing) {
            summaryBySessionId.set(fileSummary.historySessionId, {
                historySessionId: fileSummary.historySessionId,
                sessionTitle: fileSummary.sessionTitle,
                messageCount: fileSummary.messageCount,
                firstMessageAt: fileSummary.firstMessageAt,
                lastMessageAt: fileSummary.lastMessageAt,
                preview: fileSummary.preview,
                workspace: fileSummary.workspace,
            });
            continue;
        }

        existing.messageCount += fileSummary.messageCount;
        if (!existing.firstMessageAt || fileSummary.firstMessageAt < existing.firstMessageAt) {
            existing.firstMessageAt = fileSummary.firstMessageAt;
        }
        if (fileSummary.lastMessageAt >= existing.lastMessageAt) {
            existing.lastMessageAt = fileSummary.lastMessageAt;
            if (fileSummary.sessionTitle) existing.sessionTitle = fileSummary.sessionTitle;
            if (fileSummary.preview) existing.preview = fileSummary.preview;
        }
        if (!existing.workspace && fileSummary.workspace) {
            existing.workspace = fileSummary.workspace;
        }
    }

    return {
        summaries: Array.from(summaryBySessionId.values())
            .sort((a, b) => b.lastMessageAt - a.lastMessageAt),
        persistedEntries: nextPersistedEntries,
    };
}

export class ChatHistoryWriter {
/** Last seen message count per agent (deduplication) */
    private lastSeenCounts = new Map<string, number>();
/** Last seen message hash per agent (deduplication) */
    private lastSeenHashes = new Map<string, Set<string>>();
/** Last appended normalized message signature per agent/session */
    private lastSeenSignatures = new Map<string, string>();
/** Last appended normalized non-system turn signature per agent/session */
    private lastSeenTurnSignatures = new Map<string, string>();
    private rotated = false;

 /**
 * Append new messages to history
 * 
 * @param agentType agent type (e.g. 'antigravity', 'cursor')
 * @param messages Message array received from readChat
 * @param sessionTitle Current session title
 * @param instanceId IDE instance UUID (distinguishes windows of the same agent)
 */
    appendNewMessages(
        agentType: string,
        messages: Array<{ role: string; content: string; receivedAt?: number; kind?: string; senderName?: string; historyDedupKey?: string }>,
        sessionTitle?: string,
        instanceId?: string,
        historySessionId?: string,
    ): void {
        if (!messages || messages.length === 0) return;

        try {
 // dedup key: agentType + persistent history key (fallback: runtime instanceId)
            const effectiveHistoryKey = historySessionId || instanceId;
            const dedupKey = effectiveHistoryKey ? `${agentType}:${effectiveHistoryKey}` : agentType;
            let seenHashes = this.lastSeenHashes.get(dedupKey);
            if (!seenHashes) {
                seenHashes = new Set<string>();
                this.lastSeenHashes.set(dedupKey, seenHashes);
            }

 // Filter new messages
            const newMessages: HistoryMessage[] = [];
            for (const msg of messages) {
                const role = msg.role as 'user' | 'assistant' | 'system';
                if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
                const content = cleanupHistoryContent(agentType, role, msg.content || '');
                if (!content) continue;
                const receivedAt = msg.receivedAt || Date.now();
                const hash = buildHistoryMessageHash(agentType, {
                    role,
                    content,
                    receivedAt,
                    kind: typeof msg.kind === 'string' ? msg.kind : undefined,
                    historyDedupKey: msg.historyDedupKey,
                });
                const signature = buildHistoryMessageSignature(agentType, {
                    role,
                    content,
                    kind: typeof msg.kind === 'string' ? msg.kind : undefined,
                });
                if (seenHashes.has(hash)) continue;
                if (this.lastSeenSignatures.get(dedupKey) === signature) continue;
                if (role !== 'system' && this.lastSeenTurnSignatures.get(dedupKey) === signature) continue;
                seenHashes.add(hash);
                this.lastSeenSignatures.set(dedupKey, signature);
                if (role !== 'system') {
                    this.lastSeenTurnSignatures.set(dedupKey, signature);
                }
                newMessages.push({
                    ts: new Date(receivedAt).toISOString(),
                    receivedAt,
                    role,
                    content,
                    kind: typeof msg.kind === 'string' ? msg.kind : undefined,
                    senderName: typeof msg.senderName === 'string' ? msg.senderName : undefined,
                    agent: agentType,
                    instanceId,
                    historySessionId: effectiveHistoryKey,
                    sessionTitle,
                });
            }

            if (newMessages.length === 0) return;

 // Append to file — keyed by persistent history session when available
            const dir = path.join(HISTORY_DIR, this.sanitize(agentType));
            fs.mkdirSync(dir, { recursive: true });

            const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const filePrefix = effectiveHistoryKey ? `${this.sanitize(effectiveHistoryKey)}_` : '';
            const fileName = `${filePrefix}${date}.jsonl`;
            const filePath = path.join(dir, fileName);
            const lines = newMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
            fs.appendFileSync(filePath, lines, 'utf-8');
            updateSavedHistoryIndexForAppendedMessages(agentType, dir, fileName, effectiveHistoryKey, newMessages);

 // Detect session switch — only for unstable runtime-only histories.
 // When we have a persistent history session key, replayed read_chat payloads
 // must not clear dedupe state or old turns can be appended again.
            const prevCount = this.lastSeenCounts.get(dedupKey) || 0;
            if (!historySessionId && messages.length < prevCount * 0.5 && prevCount > 3) {
                seenHashes.clear();
                this.lastSeenSignatures.delete(dedupKey);
                this.lastSeenTurnSignatures.delete(dedupKey);
                for (const msg of messages) {
                    seenHashes.add(msg.historyDedupKey || `${msg.kind || 'standard'}:${msg.role}:${(msg.content || '').slice(0, 50)}`);
                }
            }
            this.lastSeenCounts.set(dedupKey, messages.length);

 // Rotate only once on first call
            if (!this.rotated) {
                this.rotated = true;
                this.rotateOldFiles().catch(() => {});
            }
        } catch {
 // Ignore history save failures (must not affect main functionality)
        }
    }

    seedSessionHistory(
        agentType: string,
        messages: Array<{ role: string; content: string; receivedAt?: number; kind?: string; historyDedupKey?: string }> = [],
        historySessionId?: string,
        instanceId?: string,
    ): void {
        const effectiveHistoryKey = historySessionId || instanceId;
        const dedupKey = effectiveHistoryKey ? `${agentType}:${effectiveHistoryKey}` : agentType;
        const seenHashes = new Set<string>();

        for (const raw of messages) {
            const role = raw?.role as 'user' | 'assistant' | 'system';
            if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
            const content = cleanupHistoryContent(agentType, role, raw?.content || '');
            if (!content) continue;
            seenHashes.add(buildHistoryMessageHash(agentType, {
                role,
                content,
                receivedAt: raw?.receivedAt || 0,
                kind: typeof raw?.kind === 'string' ? raw.kind : undefined,
                historyDedupKey: raw?.historyDedupKey,
            }));
        }

        this.lastSeenHashes.set(dedupKey, seenHashes);
        this.lastSeenCounts.set(dedupKey, messages.length);
        const lastMessage = [...messages].reverse().find((raw) => {
            const role = raw?.role as 'user' | 'assistant' | 'system';
            if (role !== 'user' && role !== 'assistant' && role !== 'system') return false;
            return !!cleanupHistoryContent(agentType, role, raw?.content || '');
        });
        const lastTurnMessage = [...messages].reverse().find((raw) => {
            const role = raw?.role as 'user' | 'assistant';
            if (role !== 'user' && role !== 'assistant') return false;
            return !!cleanupHistoryContent(agentType, role, raw?.content || '');
        });
        if (lastMessage) {
            this.lastSeenSignatures.set(dedupKey, buildHistoryMessageSignature(agentType, {
                role: lastMessage.role as HistoryMessage['role'],
                content: lastMessage.content,
                kind: typeof lastMessage.kind === 'string' ? lastMessage.kind : undefined,
            }));
        } else {
            this.lastSeenSignatures.delete(dedupKey);
        }
        if (lastTurnMessage) {
            this.lastSeenTurnSignatures.set(dedupKey, buildHistoryMessageSignature(agentType, {
                role: lastTurnMessage.role as 'user' | 'assistant',
                content: lastTurnMessage.content,
                kind: typeof lastTurnMessage.kind === 'string' ? lastTurnMessage.kind : undefined,
            }));
        } else {
            this.lastSeenTurnSignatures.delete(dedupKey);
        }
    }

    appendSystemMarker(
        agentType: string,
        content: string,
        options: {
            sessionTitle?: string;
            instanceId?: string;
            historySessionId?: string;
            dedupKey?: string;
            receivedAt?: number;
            senderName?: string;
        } = {},
    ): void {
        this.appendNewMessages(
            agentType,
            [{
                ...buildRuntimeSystemChatMessage({
                    content,
                    receivedAt: options.receivedAt,
                    senderName: options.senderName,
                }),
                historyDedupKey: options.dedupKey,
            }],
            options.sessionTitle,
            options.instanceId,
            options.historySessionId,
        );
    }

    writeSessionStart(
        agentType: string,
        historySessionId: string,
        workspace: string,
        instanceId?: string,
    ): void {
        const id = String(historySessionId || '').trim();
        const ws = String(workspace || '').trim();
        if (!id || !ws) return;
        try {
            const dir = path.join(HISTORY_DIR, this.sanitize(agentType));
            fs.mkdirSync(dir, { recursive: true });
            const date = new Date().toISOString().slice(0, 10);
            const fileName = `${this.sanitize(id)}_${date}.jsonl`;
            const filePath = path.join(dir, fileName);
            const record: HistoryMessage = {
                ts: new Date().toISOString(),
                receivedAt: Date.now(),
                role: 'system',
                kind: 'session_start',
                content: ws,
                agent: agentType,
                instanceId,
                historySessionId: id,
                workspace: ws,
            };
            fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
            updateSavedHistoryIndexForSessionStart(agentType, dir, fileName, id, ws);
        } catch {
            // Ignore — must not affect main functionality
        }
    }

    promoteHistorySession(
        agentType: string,
        previousHistorySessionId: string,
        nextHistorySessionId: string,
    ): void {
        const fromId = String(previousHistorySessionId || '').trim();
        const toId = String(nextHistorySessionId || '').trim();
        if (!fromId || !toId || fromId === toId) return;

        try {
            const fromDedupKey = `${agentType}:${fromId}`;
            const toDedupKey = `${agentType}:${toId}`;
            const fromHashes = this.lastSeenHashes.get(fromDedupKey);
            if (fromHashes?.size) {
                const nextHashes = this.lastSeenHashes.get(toDedupKey) || new Set<string>();
                for (const hash of fromHashes) nextHashes.add(hash);
                this.lastSeenHashes.set(toDedupKey, nextHashes);
                this.lastSeenHashes.delete(fromDedupKey);
            }
            const fromSignature = this.lastSeenSignatures.get(fromDedupKey);
            if (fromSignature) {
                this.lastSeenSignatures.set(toDedupKey, fromSignature);
                this.lastSeenSignatures.delete(fromDedupKey);
            }
            const fromTurnSignature = this.lastSeenTurnSignatures.get(fromDedupKey);
            if (fromTurnSignature) {
                this.lastSeenTurnSignatures.set(toDedupKey, fromTurnSignature);
                this.lastSeenTurnSignatures.delete(fromDedupKey);
            }
            const fromCount = this.lastSeenCounts.get(fromDedupKey);
            if (typeof fromCount === 'number') {
                this.lastSeenCounts.set(toDedupKey, Math.max(fromCount, this.lastSeenCounts.get(toDedupKey) || 0));
                this.lastSeenCounts.delete(fromDedupKey);
            }

            const dir = path.join(HISTORY_DIR, this.sanitize(agentType));
            if (!fs.existsSync(dir)) return;

            const fromPrefix = `${this.sanitize(fromId)}_`;
            const toPrefix = `${this.sanitize(toId)}_`;
            const files = fs.readdirSync(dir).filter((file) => file.startsWith(fromPrefix) && file.endsWith('.jsonl'));

            for (const file of files) {
                const sourcePath = path.join(dir, file);
                const targetPath = path.join(dir, `${toPrefix}${file.slice(fromPrefix.length)}`);
                const sourceLines = fs.readFileSync(sourcePath, 'utf-8').split('\n').filter(Boolean);
                const rewritten = sourceLines
                    .map((line) => {
                        try {
                            const parsed = JSON.parse(line) as HistoryMessage;
                            if (parsed.historySessionId !== fromId) return null;
                            return JSON.stringify({
                                ...parsed,
                                historySessionId: toId,
                            });
                        } catch {
                            return null;
                        }
                    })
                    .filter((line): line is string => !!line);
                if (rewritten.length === 0) {
                    fs.unlinkSync(sourcePath);
                    continue;
                }

                const existing = fs.existsSync(targetPath)
                    ? new Set(fs.readFileSync(targetPath, 'utf-8').split('\n').filter(Boolean))
                    : new Set<string>();
                const nextLines = rewritten.filter((line) => !existing.has(line));
                if (nextLines.length > 0) {
                    fs.appendFileSync(targetPath, `${nextLines.join('\n')}\n`, 'utf-8');
                }
                fs.unlinkSync(sourcePath);
            }
            invalidatePersistedSavedHistoryIndex(agentType, dir);
        } catch {
            // Ignore promotion failure; future messages will still write to the new session key.
        }
    }

    compactHistorySession(agentType: string, historySessionId: string): void {
        const sessionId = String(historySessionId || '').trim();
        if (!sessionId) return;

        try {
            const dir = path.join(HISTORY_DIR, this.sanitize(agentType));
            if (!fs.existsSync(dir)) return;

            const prefix = `${this.sanitize(sessionId)}_`;
            const files = fs.readdirSync(dir)
                .filter((file) => file.startsWith(prefix) && file.endsWith('.jsonl'))
                .sort();

            const seen = new Set<string>();
            for (const file of files) {
                const filePath = path.join(dir, file);
                const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
                const next: HistoryMessage[] = [];

                for (const line of lines) {
                    let parsed: HistoryMessage | null = null;
                    try {
                        parsed = JSON.parse(line) as HistoryMessage;
                    } catch {
                        parsed = null;
                    }
                    if (!parsed || parsed.historySessionId !== sessionId) continue;
                    const sanitized = sanitizeHistoryMessage(agentType, parsed);
                    if (!sanitized) continue;
                    const hash = buildHistoryMessageHash(agentType, sanitized);
                    if (seen.has(hash)) continue;
                    seen.add(hash);
                    next.push(sanitized);
                }

                next.sort((a, b) => a.receivedAt - b.receivedAt);
                const dedupedAdjacent: HistoryMessage[] = [];
                let lastTurn: HistoryMessage | null = null;
                for (const entry of next) {
                    const previous = dedupedAdjacent[dedupedAdjacent.length - 1];
                    if (isAdjacentHistoryDuplicate(agentType, previous, entry)) continue;
                    if (entry.role !== 'system' && isAdjacentHistoryDuplicate(agentType, lastTurn, entry)) continue;
                    dedupedAdjacent.push(entry);
                    if (entry.role !== 'system') lastTurn = entry;
                }
                const collapsed = collapseReplayAssistantTurns(agentType, dedupedAdjacent);
                if (collapsed.length === 0) {
                    fs.unlinkSync(filePath);
                    continue;
                }
                fs.writeFileSync(filePath, `${collapsed.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf-8');
            }
            invalidatePersistedSavedHistoryIndex(agentType, dir);
        } catch {
            // Ignore compaction failure.
        }
    }

/** Called when agent session is explicitly changed */
    onSessionChange(agentType: string): void {
        this.lastSeenHashes.delete(agentType);
        this.lastSeenCounts.delete(agentType);
        this.lastSeenSignatures.delete(agentType);
        this.lastSeenTurnSignatures.delete(agentType);
    }

 /** Delete history files older than 30 days */
    private async rotateOldFiles(): Promise<void> {
        try {
            if (!fs.existsSync(HISTORY_DIR)) return;
            const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;

            const agentDirs = fs.readdirSync(HISTORY_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory());

            for (const dir of agentDirs) {
                const dirPath = path.join(HISTORY_DIR, dir.name);
                const files = fs.readdirSync(dirPath)
                    .filter(f => f.endsWith('.jsonl') || f.endsWith('.terminal.log'));
                let removedAny = false;

                for (const file of files) {
                    const filePath = path.join(dirPath, file);
                    const stat = fs.statSync(filePath);
                    if (stat.mtimeMs < cutoff) {
                        fs.unlinkSync(filePath);
                        removedAny = true;
                    }
                }
                if (removedAny) {
                    invalidatePersistedSavedHistoryIndex(dir.name, dirPath);
                }
            }
        } catch {
 // Ignore rotate failure
        }
    }

 /** Allow only filename-safe characters */
    private sanitize(name: string): string {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_');
    }
}

/**
 * Read history (static — called from P2P commands)
 * 
 * Read JSONL files for a session and return a chronological page while paging
 * backwards from the newest saved messages. When excludeRecentCount is set,
 * the newest N messages are skipped so older-history pagination can avoid
 * duplicating the live transcript tail already shown in the UI.
 */
export function readChatHistory(
    agentType: string,
    offset: number = 0,
    limit: number = 30,
    historySessionId?: string,
    excludeRecentCount: number = 0,
): { messages: HistoryMessage[]; hasMore: boolean } {
    try {
        const sanitized = agentType.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(HISTORY_DIR, sanitized);
        if (!fs.existsSync(dir)) return { messages: [], hasMore: false };

 // JSONL file list — filter by persistent history key when specified
        const files = listHistoryFiles(dir, historySessionId);

        const allMessages: HistoryMessage[] = [];
        const seen = new Set<string>();

        for (const file of files) {
            const filePath = path.join(dir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean);

            for (let i = 0; i < lines.length; i++) {
                try {
                    const parsed = JSON.parse(lines[i]) as HistoryMessage;
                    const sanitizedMessage = sanitizeHistoryMessage(agentType, parsed);
                    if (!sanitizedMessage) continue;
                    const hash = buildHistoryMessageHash(agentType, sanitizedMessage);
                    if (seen.has(hash)) continue;
                    seen.add(hash);
                    allMessages.push(sanitizedMessage);
                } catch { /* skip invalid lines */ }
            }
        }

        allMessages.sort((a, b) => a.receivedAt - b.receivedAt);
        const chronological: HistoryMessage[] = [];
        let lastTurn: HistoryMessage | null = null;
        for (const message of allMessages) {
            const previous = chronological[chronological.length - 1];
            if (isAdjacentHistoryDuplicate(agentType, previous, message)) continue;
            if (message.role !== 'system' && isAdjacentHistoryDuplicate(agentType, lastTurn, message)) continue;
            chronological.push(message);
            if (message.role !== 'system') lastTurn = message;
        }
        const collapsed = collapseReplayAssistantTurns(agentType, chronological);

 // Page backwards from the newest saved messages while keeping the returned
 // slice in chronological order for prepend-based UI rendering.
        const boundedLimit = Math.max(1, limit);
        const boundedOffset = Math.max(0, offset);
        const boundedExclude = Math.max(0, Math.min(excludeRecentCount, collapsed.length));
        const endExclusive = Math.max(0, collapsed.length - boundedExclude - boundedOffset);
        const startInclusive = Math.max(0, endExclusive - boundedLimit);
        const sliced = collapsed.slice(startInclusive, endExclusive);
        const hasMore = startInclusive > 0;

        return { messages: sliced, hasMore };
    } catch {
        return { messages: [], hasMore: false };
    }
}

export function listSavedHistorySessions(
    agentType: string,
    options: { offset?: number; limit?: number } = {},
): { sessions: SavedHistorySessionSummary[]; hasMore: boolean } {
    try {
        const sanitized = agentType.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(HISTORY_DIR, sanitized);
        if (!fs.existsSync(dir)) {
            savedHistorySessionCache.delete(sanitized);
            return { sessions: [], hasMore: false };
        }

        const cached = savedHistorySessionCache.get(sanitized);
        const offset = Math.max(0, options.offset || 0);
        const limit = Math.max(1, options.limit || 30);
        const indexSignature = buildSavedHistoryIndexFileSignature(dir);
        let cacheWasInvalidated = false;
        if (cached) {
            const cacheLooksPersisted = cached.signature.startsWith('index:');
            const cacheStillValid = cacheLooksPersisted
                ? cached.signature === indexSignature
                : (() => {
                    const files = listHistoryFiles(dir);
                    const fileSignatures = buildSavedHistoryFileSignatureMap(dir, files);
                    return cached.signature === buildSavedHistoryCacheSignature(files, fileSignatures);
                })();
            if (cacheStillValid) {
                const sliced = cached.summaries.slice(offset, offset + limit);
                return {
                    sessions: sliced,
                    hasMore: cached.summaries.length > offset + limit,
                };
            }
            cacheWasInvalidated = true;
        }

        const persistedSessions = readPersistedSavedHistorySessionSummaries(dir);
        if (!cacheWasInvalidated && persistedSessions?.length && !historyDirectoryHasFilesNewerThanIndex(dir)) {
            savedHistorySessionCache.set(sanitized, {
                signature: indexSignature,
                summaries: persistedSessions,
            });
            scheduleSavedHistoryBackgroundRefresh(agentType, dir);
            const sliced = persistedSessions.slice(offset, offset + limit);
            return {
                sessions: sliced,
                hasMore: persistedSessions.length > offset + limit,
            };
        }

        const files = listHistoryFiles(dir);
        const fileSignatures = buildSavedHistoryFileSignatureMap(dir, files);
        const signature = buildSavedHistoryCacheSignature(files, fileSignatures);
        const persistedEntries = loadPersistedSavedHistoryIndex(dir);
        const computed = computeSavedHistorySessionSummaries(agentType, dir, files, fileSignatures, persistedEntries);
        const summaries = computed.summaries || [];
        savePersistedSavedHistoryIndex(dir, computed.persistedEntries || new Map());
        savedHistorySessionCache.set(sanitized, {
            signature,
            summaries,
        });

        const sliced = summaries.slice(offset, offset + limit);
        return {
            sessions: sliced,
            hasMore: summaries.length > offset + limit,
        };
    } catch {
        return { sessions: [], hasMore: false };
    }
}
