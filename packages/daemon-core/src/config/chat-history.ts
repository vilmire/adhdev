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
import type { ProviderCanonicalHistoryConfig, ProviderHistoryBehavior } from '../providers/contracts.js';

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

// Bounded-tail read cache. The dashboard re-subscribes and polls hot sessions
// every ~2.5s; without a cache each poll re-reads/parses/sorts the whole
// conversation just to slice a small tail. We key on (type, sessionId,
// pagination args) plus the on-disk size+mtime signature so an UNCHANGED
// session returns the previously computed tail in O(1) and only re-reads when a
// new message is appended (signature changes). The map is bounded by a small
// LRU to keep memory flat regardless of how many sessions are touched.
interface BoundedTailCacheEntry {
    signature: string;
    result: { messages: HistoryMessage[]; hasMore: boolean };
}

const BOUNDED_TAIL_CACHE_MAX_ENTRIES = 64;
const boundedTailReadCache = new Map<string, BoundedTailCacheEntry>();

function readBoundedTailCache(key: string, signature: string): { messages: HistoryMessage[]; hasMore: boolean } | null {
    const cached = boundedTailReadCache.get(key);
    if (!cached || cached.signature !== signature) return null;
    // Refresh LRU recency.
    boundedTailReadCache.delete(key);
    boundedTailReadCache.set(key, cached);
    return cached.result;
}

function writeBoundedTailCache(key: string, signature: string, result: { messages: HistoryMessage[]; hasMore: boolean }): void {
    boundedTailReadCache.delete(key);
    boundedTailReadCache.set(key, { signature, result });
    while (boundedTailReadCache.size > BOUNDED_TAIL_CACHE_MAX_ENTRIES) {
        const oldest = boundedTailReadCache.keys().next().value;
        if (oldest === undefined) break;
        boundedTailReadCache.delete(oldest);
    }
}

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

function normalizeHistoryComparable(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanupHistoryContent(agentType: string, role: HistoryMessage['role'], content: string, historyBehavior?: ProviderHistoryBehavior): string {
    let value = String(content || '').replace(/\r\n/g, '\n').trim();
    if (!value) return '';

    if (role === 'assistant' && historyBehavior?.filterAssistantPatterns?.length) {
        const filters = historyBehavior.filterAssistantPatterns.map((p) => {
            try { return new RegExp(p, 'i'); } catch { return null; }
        }).filter(Boolean) as RegExp[];
        if (filters.length > 0) {
            const filtered = value
                .split('\n')
                .filter((line) => !filters.some((re) => re.test(line.trim())))
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            value = filtered;
        }
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

function collapseReplayAssistantTurns(messages: HistoryMessage[], historyBehavior?: ProviderHistoryBehavior): HistoryMessage[] {
    if (!historyBehavior?.collapseConsecutiveAssistantTurns) return messages;

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
    source?: 'adhdev-mirror' | 'provider-native';
    sourcePath?: string;
    sourceMtimeMs?: number;
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

function normalizeSavedHistorySessionId(historySessionId: string): string {
    return String(historySessionId || '').trim();
}

function extractSavedHistorySessionIdFromFile(file: string): string {
    const match = file.match(/^([A-Za-z0-9_-]+)_\d{4}-\d{2}-\d{2}\.jsonl$/);
    return normalizeSavedHistorySessionId(match?.[1] || '');
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
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId);
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
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId || '');
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

function computeSavedHistoryFileSummary(dir: string, file: string): SavedHistoryFileSummary | null {
    const historySessionId = extractSavedHistorySessionIdFromFile(file);
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
        const fileSummary = reusableEntry?.summary || computeSavedHistoryFileSummary(dir, file);
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

    compactHistorySession(agentType: string, historySessionId: string, historyBehavior?: ProviderHistoryBehavior): void {
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
                const collapsed = collapseReplayAssistantTurns(dedupedAdjacent, historyBehavior);
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
function normalizePaginationNumber(value: number, fallback: number, min: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(min, numeric) : fallback;
}

function pageHistoryRecords(
    agentType: string,
    records: HistoryMessage[],
    offset: number = 0,
    limit: number = 30,
    excludeRecentCount: number = 0,
    historyBehavior?: ProviderHistoryBehavior,
): { messages: HistoryMessage[]; hasMore: boolean } {
    const allMessages = records
        .map((message) => sanitizeHistoryMessage(agentType, message))
        .filter(Boolean) as HistoryMessage[];
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
    const collapsed = collapseReplayAssistantTurns(chronological, historyBehavior);
    const boundedLimit = normalizePaginationNumber(limit, 30, 1);
    const boundedOffset = normalizePaginationNumber(offset, 0, 0);
    const boundedExclude = Math.min(
        normalizePaginationNumber(excludeRecentCount, 0, 0),
        collapsed.length,
    );
    const endExclusive = Math.max(0, collapsed.length - boundedExclude - boundedOffset);
    const startInclusive = Math.max(0, endExclusive - boundedLimit);
    const sliced = collapsed.slice(startInclusive, endExclusive);
    return { messages: sliced, hasMore: startInclusive > 0 };
}

// A finite tail request can be served by reading only the newest files instead
// of the whole conversation. Treat very large limits (e.g. MAX_SAFE_INTEGER, or
// anything past a generous ceiling) as a full-history request so restore/seed
// callers keep their existing behavior.
const BOUNDED_TAIL_MAX_LIMIT = 5_000;
// Slack added to the requested window before sorting/dedup/collapse so the
// boundary message at the top of the tail dedupes/collapses identically to a
// full read. Modest and bounded — it only widens the parse window, not output.
const BOUNDED_TAIL_SLACK = 50;

function isBoundedTailRequest(limit: number, offset: number, excludeRecentCount: number): boolean {
    const numericLimit = Number(limit);
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) return false;
    if (numericLimit > BOUNDED_TAIL_MAX_LIMIT) return false;
    const numericOffset = Number(offset);
    const numericExclude = Number(excludeRecentCount);
    if (!Number.isFinite(numericOffset) || !Number.isFinite(numericExclude)) return false;
    return true;
}

// Byte threshold below which a file is small enough that reading the whole
// thing is cheaper than seeking. Reverse-seek pays off only on large files.
const REVERSE_TAIL_SMALL_FILE_BYTES = 64 * 1024;
// Chunk size for backward reads. We read the file tail one chunk at a time
// (newest bytes first) until we have collected enough complete lines.
const REVERSE_TAIL_CHUNK_BYTES = 64 * 1024;

// Per-(file path) incremental tail cache. A hot session's daily JSONL file grows
// append-only while it generates; the size+mtime signature on the bounded-tail
// read cache therefore invalidates on every append and forces a full re-read.
// Here we keep the most recently decoded tail LINES for a file plus the byte
// length we read them from. When the file has only grown (append-only: size
// increased, the previously-read prefix is unchanged) we read just the new bytes
// from `size` onward and splice them onto the retained tail — no full re-parse.
// Truncation/rotation (size shrank, or a fresh inode) drops the entry and falls
// back to a full reverse-seek.
interface IncrementalTailCacheEntry {
    // File length (bytes) we have already consumed into `lines`.
    size: number;
    mtimeMs: number;
    // Decoded complete lines (oldest-first) covering at least the tail window.
    // Bounded to TAIL_LINES_RETAINED so memory stays flat for huge files.
    lines: string[];
    // True when `lines` is the entire file (head reached), so older pages can
    // trust that nothing precedes the retained window.
    coversWholeFile: boolean;
}

// How many trailing lines we retain per file. The bounded-tail caller never
// asks for more than BOUNDED_TAIL_MAX_LIMIT + slack; keep a generous multiple so
// repeated reads at the same window are served incrementally.
const TAIL_LINES_RETAINED = BOUNDED_TAIL_MAX_LIMIT + 2 * BOUNDED_TAIL_SLACK;
const INCREMENTAL_TAIL_CACHE_MAX_ENTRIES = 64;
const incrementalTailCache = new Map<string, IncrementalTailCacheEntry>();

function evictIncrementalTailCache(): void {
    while (incrementalTailCache.size > INCREMENTAL_TAIL_CACHE_MAX_ENTRIES) {
        const oldest = incrementalTailCache.keys().next().value;
        if (oldest === undefined) break;
        incrementalTailCache.delete(oldest);
    }
}

// Split a Buffer into complete lines plus a leftover head fragment, partitioning
// only on the newline byte (0x0A). 0x0A never appears inside a multibyte UTF-8
// sequence, so decoding each complete byte segment is boundary-safe. The leftover
// (bytes before the first newline) is returned undecoded so a caller stitching
// chunks together never splits a multibyte char.
function splitBufferLines(buf: Buffer): { head: Buffer; lines: string[] } {
    const lines: string[] = [];
    let lineEnd = buf.length;
    let firstNewline = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        if (i + 1 < lineEnd) {
            lines.push(buf.toString('utf-8', i + 1, lineEnd));
        }
        lineEnd = i;
        firstNewline = i;
    }
    // Lines were collected newest-first; restore oldest-first for the segment
    // that follows the first (lowest-index) newline.
    lines.reverse();
    const head = firstNewline >= 0 ? buf.subarray(0, firstNewline) : buf;
    return { head, lines };
}

// Read the last bytes of a file, newest-first, until we have at least `needed`
// complete lines (or reach the start of the file). Returns lines oldest-first and
// whether the whole file was consumed. Boundary-safe: lines are cut on the
// newline byte only, so multibyte UTF-8 chars are never split, and a trailing
// partial line (no terminating newline) is preserved as a complete final line.
function readReverseTailLines(filePath: string, needed: number): { lines: string[]; coversWholeFile: boolean; size: number; mtimeMs: number } {
    const fd = fs.openSync(filePath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        const size = stat.size;
        let position = size;
        // `carry` holds bytes belonging to a line that straddles the current
        // chunk boundary (its start is in an older, not-yet-read chunk).
        let carry: Buffer = Buffer.alloc(0);
        const collected: string[] = [];

        while (position > 0 && collected.length < needed) {
            const chunkSize = Math.min(REVERSE_TAIL_CHUNK_BYTES, position);
            position -= chunkSize;
            const chunk = Buffer.alloc(chunkSize);
            fs.readSync(fd, chunk, 0, chunkSize, position);
            const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
            const { head, lines } = splitBufferLines(combined);
            // `head` is the (possibly partial) line whose start lies further back;
            // hold it for the next (older) chunk to complete.
            carry = head;
            // `lines` are oldest-first within this combined buffer; prepend them
            // ahead of what we already collected (which is strictly newer).
            for (let i = lines.length - 1; i >= 0; i--) {
                collected.push(lines[i]);
            }
        }

        const reachedStart = position <= 0;
        if (reachedStart && carry.length) {
            // Leftover head at the start of the file is itself a complete line.
            collected.push(carry.toString('utf-8'));
        }
        // `collected` is newest-first; restore oldest-first.
        collected.reverse();
        return { lines: collected, coversWholeFile: reachedStart, size, mtimeMs: stat.mtimeMs };
    } finally {
        fs.closeSync(fd);
    }
}

// Return the tail lines (oldest-first) for a single history file, reading as
// little of the file as possible. Strategy:
//   - Small files: one readFileSync (seeking is not worth the syscalls).
//   - Large files: reverse byte-seek for the newest `needed` lines.
//   - Append-only growth since the last read: read only the appended bytes and
//     splice them onto the retained tail (no full re-parse) — this is what keeps
//     a hot, still-generating session cheap to poll.
// `needed` is a soft floor; we may return more (whole small files / retained
// window). Lines include any trailing partial (unterminated) final line.
function readFileTailLines(filePath: string, needed: number): { lines: string[]; coversWholeFile: boolean } {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return { lines: [], coversWholeFile: true };
    }
    const size = stat.size;
    const mtimeMs = stat.mtimeMs;
    if (size === 0) {
        incrementalTailCache.delete(filePath);
        return { lines: [], coversWholeFile: true };
    }

    const cached = incrementalTailCache.get(filePath);
    if (cached) {
        if (cached.size === size && cached.mtimeMs === mtimeMs) {
            // Unchanged since last read — reuse retained tail. Refresh LRU.
            incrementalTailCache.delete(filePath);
            incrementalTailCache.set(filePath, cached);
            if (cached.coversWholeFile || cached.lines.length >= needed) {
                return { lines: cached.lines, coversWholeFile: cached.coversWholeFile };
            }
            // Retained window is smaller than this request needs; fall through
            // to a fresh reverse-seek for the larger window.
        } else if (size > cached.size) {
            // Append-only growth: the prefix [0, cached.size) is assumed
            // unchanged (JSONL is append-only). Read just the new bytes and
            // stitch them — but verify the byte at cached.size-1 is still the
            // newline that terminated our last retained line, so a rewrite that
            // happens to grow the file (compaction) is detected and rejected.
            const incremental = tryIncrementalTailGrowth(filePath, cached, size, mtimeMs, needed);
            if (incremental) return { lines: incremental.lines, coversWholeFile: incremental.coversWholeFile };
        }
        // size shrank (truncation/rotation) or incremental failed → drop & reload.
        incrementalTailCache.delete(filePath);
    }

    if (size <= REVERSE_TAIL_SMALL_FILE_BYTES) {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return { lines: [], coversWholeFile: true };
        }
        const lines = content.split('\n');
        // A trailing newline yields a final empty element; drop only that one so
        // an unterminated partial last line is still preserved.
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        storeIncrementalTailCache(filePath, size, mtimeMs, lines, true);
        return { lines, coversWholeFile: true };
    }

    let result: { lines: string[]; coversWholeFile: boolean; size: number; mtimeMs: number };
    try {
        result = readReverseTailLines(filePath, needed);
    } catch {
        return { lines: [], coversWholeFile: true };
    }
    storeIncrementalTailCache(filePath, result.size, result.mtimeMs, result.lines, result.coversWholeFile);
    return { lines: result.lines, coversWholeFile: result.coversWholeFile };
}

// Read appended bytes [cached.size, size) and splice them onto the retained tail.
// Returns null if the prior byte is not a newline (the retained tail did not end
// on a record boundary, e.g. the file was rewritten) so the caller can full-reload.
function tryIncrementalTailGrowth(
    filePath: string,
    cached: IncrementalTailCacheEntry,
    size: number,
    mtimeMs: number,
    needed: number,
): { lines: string[]; coversWholeFile: boolean } | null {
    const fd = fs.openSync(filePath, 'r');
    try {
        // Confirm the byte ending the previously-read prefix is still a newline.
        if (cached.size > 0) {
            const boundary = Buffer.alloc(1);
            fs.readSync(fd, boundary, 0, 1, cached.size - 1);
            if (boundary[0] !== 0x0a) return null;
        }
        const appendedLength = size - cached.size;
        const appended = Buffer.alloc(appendedLength);
        fs.readSync(fd, appended, 0, appendedLength, cached.size);
        const newLines = appended.toString('utf-8').split('\n');
        if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
        const merged = cached.lines.concat(newLines);
        // Keep memory flat: retain only the trailing window.
        const trimmed = merged.length > TAIL_LINES_RETAINED
            ? merged.slice(merged.length - TAIL_LINES_RETAINED)
            : merged;
        const coversWholeFile = cached.coversWholeFile && trimmed.length === merged.length;
        storeIncrementalTailCache(filePath, size, mtimeMs, trimmed, coversWholeFile);
        if (coversWholeFile || trimmed.length >= needed) {
            return { lines: trimmed, coversWholeFile };
        }
        // Should not happen (we only grew), but be safe.
        return { lines: trimmed, coversWholeFile };
    } catch {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

function storeIncrementalTailCache(filePath: string, size: number, mtimeMs: number, lines: string[], coversWholeFile: boolean): void {
    const retained = lines.length > TAIL_LINES_RETAINED ? lines.slice(lines.length - TAIL_LINES_RETAINED) : lines;
    const covers = coversWholeFile && retained.length === lines.length;
    incrementalTailCache.delete(filePath);
    incrementalTailCache.set(filePath, { size, mtimeMs, lines: retained, coversWholeFile: covers });
    evictIncrementalTailCache();
}

// Read newest-first only as many files as needed to cover the requested window
// plus slack. listHistoryFiles already returns files reversed (newest-first), so
// we accumulate (de-duped) candidates from the end and stop once we have enough,
// then hand the bounded window to pageHistoryRecords in chronological order.
function readBoundedTailRecords(
    agentType: string,
    dir: string,
    files: string[],
    needed: number,
): { records: HistoryMessage[]; readAllFiles: boolean } {
    const collected: HistoryMessage[] = [];
    const seen = new Set<string>();
    let readAllFiles = true;

    for (let f = 0; f < files.length; f++) {
        const filePath = path.join(dir, files[f]);
        // Read only the file tail needed to top up the window — for a large
        // single-day file this seeks the last `needed` lines instead of parsing
        // the whole file. We re-derive the per-file floor each iteration from how
        // many records are still missing (plus slack so dedup at the boundary is
        // stable), capped at `needed`.
        const remaining = Math.max(0, needed - collected.length);
        const perFileNeeded = Math.min(needed, remaining + BOUNDED_TAIL_SLACK);
        const { lines, coversWholeFile } = readFileTailLines(filePath, perFileNeeded);
        // Walk this file's tail lines newest-first so we fill the tail window from
        // the bottom. seen-dedup keeps the same first-wins-by-newest semantics the
        // full read produced (files are processed newest-first there too).
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line) continue;
            try {
                const parsed = JSON.parse(line) as HistoryMessage;
                const sanitizedMessage = sanitizeHistoryMessage(agentType, parsed);
                if (!sanitizedMessage) continue;
                const hash = buildHistoryMessageHash(agentType, sanitizedMessage);
                if (seen.has(hash)) continue;
                seen.add(hash);
                collected.push(sanitizedMessage);
            } catch { /* skip invalid lines */ }
        }
        // If we only read this file's tail (its head was not reached), older
        // messages remain within this very file — the conversation is NOT fully
        // represented even if this is the last file, so hasMore must stay true.
        if (!coversWholeFile) {
            readAllFiles = false;
            break;
        }
        // Stop once we have the window AND there is at least one more file (so a
        // potential older boundary message exists). If this is the last file we
        // fall through and mark the whole history as read.
        if (collected.length >= needed && f < files.length - 1) {
            readAllFiles = false;
            break;
        }
    }

    // collected is newest-first across the bounded window; restore chronological
    // (oldest-first) order before paging. pageHistoryRecords re-sorts by
    // receivedAt regardless, so this is purely for stable input ordering.
    collected.reverse();
    return { records: collected, readAllFiles };
}

export function readChatHistory(
    agentType: string,
    offset: number = 0,
    limit: number = 30,
    historySessionId?: string,
    excludeRecentCount: number = 0,
    historyBehavior?: ProviderHistoryBehavior,
): { messages: HistoryMessage[]; hasMore: boolean } {
    try {
        const sanitized = agentType.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(HISTORY_DIR, sanitized);
        if (!fs.existsSync(dir)) return { messages: [], hasMore: false };

 // JSONL file list — filter by persistent history key when specified
        const files = listHistoryFiles(dir, historySessionId);

        const bounded = isBoundedTailRequest(limit, offset, excludeRecentCount);

        if (bounded) {
            const fileSignatures = buildSavedHistoryFileSignatureMap(dir, files);
            const cacheKey = `${sanitized}\0${historySessionId || ''}\0${offset}\0${limit}\0${excludeRecentCount}\0${historyBehavior?.collapseConsecutiveAssistantTurns ? '1' : '0'}`;
            const signature = buildSavedHistoryCacheSignature(files, fileSignatures);
            const cached = readBoundedTailCache(cacheKey, signature);
            if (cached) return cached;

            // Window large enough that the top boundary dedupes/collapses the same
            // as a full read. hasMore reflects whether older messages exist beyond
            // the window we actually read.
            const numericLimit = Math.max(1, Number(limit));
            const numericOffset = Math.max(0, Number(offset));
            const numericExclude = Math.max(0, Number(excludeRecentCount));
            const needed = numericLimit + numericOffset + numericExclude + Math.max(BOUNDED_TAIL_SLACK, numericLimit);
            const { records, readAllFiles } = readBoundedTailRecords(agentType, dir, files, needed);
            const result = pageHistoryRecords(agentType, records, offset, limit, excludeRecentCount, historyBehavior);
            // If we read every file, the conversation is fully represented in the
            // window and pageHistoryRecords' hasMore is authoritative. If we
            // stopped early there are older messages we never read, so hasMore
            // must stay true regardless of the in-window slice position.
            const boundedResult = readAllFiles ? result : { messages: result.messages, hasMore: true };
            writeBoundedTailCache(cacheKey, signature, boundedResult);
            return boundedResult;
        }

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

        return pageHistoryRecords(agentType, allMessages, offset, limit, excludeRecentCount, historyBehavior);
    } catch {
        return { messages: [], hasMore: false };
    }
}

export function listSavedHistorySessions(
    agentType: string,
    options: { offset?: number; limit?: number } = {},
    historyBehavior?: ProviderHistoryBehavior,
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

function readExistingSessionStartRecord(agentType: string, historySessionId: string): HistoryMessage | null {
    try {
        const dir = path.join(HISTORY_DIR, agentType);
        if (!fs.existsSync(dir)) return null;
        const files = listHistoryFiles(dir, historySessionId).sort();
        for (const file of files) {
            const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line) as HistoryMessage;
                    if (parsed.historySessionId !== historySessionId) continue;
                    if (parsed.kind === 'session_start' && parsed.role === 'system') {
                        return parsed;
                    }
                } catch {
                    // Ignore malformed lines while probing for the original session_start marker.
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

function rewriteCanonicalSavedHistory(agentType: string, historySessionId: string, records: HistoryMessage[]): boolean {
    if (records.length === 0) return false;
    try {
        const dir = path.join(HISTORY_DIR, agentType);
        fs.mkdirSync(dir, { recursive: true });
        const prefix = `${historySessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}_`;
        for (const file of fs.readdirSync(dir)) {
            if (file.startsWith(prefix) && file.endsWith('.jsonl')) {
                fs.unlinkSync(path.join(dir, file));
            }
        }
        const targetDate = new Date(records[records.length - 1].receivedAt || Date.now()).toISOString().slice(0, 10);
        const filePath = path.join(dir, `${prefix}${targetDate}.jsonl`);
        fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8');
        invalidatePersistedSavedHistoryIndex(agentType, dir);
        savedHistorySessionCache.delete(agentType.replace(/[^a-zA-Z0-9_-]/g, '_'));
        return true;
    } catch {
        return false;
    }
}

export type ProviderNativeHistoryScripts = Record<string, ((input: any) => any) | undefined>;

type ProviderNativeHistoryReadResult = {
    records: HistoryMessage[];
    sourcePath: string;
    sourceMtimeMs: number;
    providerSessionId?: string;
    workspace?: string;
    nativeHistoryCoverage?: string;
    partialReason?: string;
    unavailableReason?: string;
};

function getNativeHistoryScriptName(canonicalHistory: ProviderCanonicalHistoryConfig | undefined, key: 'readSession' | 'listSessions'): string {
    const configured = canonicalHistory?.scripts?.[key];
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
    return key === 'readSession' ? 'readNativeHistory' : 'listNativeHistory';
}

function getProviderNativeHistoryScript(
    scripts: ProviderNativeHistoryScripts | undefined,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    key: 'readSession' | 'listSessions',
): ((input: any) => any) | null {
    if (!canonicalHistory?.scripts) return null;
    const fn = scripts?.[getNativeHistoryScriptName(canonicalHistory, key)];
    return typeof fn === 'function' ? fn : null;
}

function normalizeProviderNativeHistoryRecords(agentType: string, historySessionId: string, records: unknown): HistoryMessage[] {
    if (!Array.isArray(records)) return [];
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId);
    return records
        .map((record: any) => {
            const base: HistoryMessage = {
                ts: typeof record?.ts === 'string' ? record.ts : new Date(Number(record?.receivedAt) || Date.now()).toISOString(),
                receivedAt: Number(record?.receivedAt) || Date.parse(record?.ts || '') || Date.now(),
                role: record?.role,
                content: String(record?.content || ''),
                kind: record?.kind || (record?.role === 'system' ? 'session_start' : 'standard'),
                senderName: record?.senderName,
                agent: agentType,
                instanceId: record?.instanceId,
                historySessionId: normalizeSavedHistorySessionId(record?.historySessionId || normalizedSessionId),
                sessionTitle: record?.sessionTitle,
                workspace: record?.workspace,
            } as HistoryMessage;
            // (A2.3 v2 identity passthrough) — if the producer (native_history.js)
            // emitted v2 stable identity, keep it across the sanitize layer so
            // downstream (chat-commands.ts normalizeNativeHistoryMessages) sees
            // the producer's contract output instead of recomputing from index
            // and content hash. v1 producers without these fields are unaffected.
            if (typeof record?.providerUnitKey === 'string' && record.providerUnitKey) {
                (base as any).providerUnitKey = record.providerUnitKey;
            }
            if (typeof record?.bubbleId === 'string' && record.bubbleId) {
                (base as any).bubbleId = record.bubbleId;
            }
            if (typeof record?.sequence === 'number' && Number.isFinite(record.sequence)) {
                (base as any).sequence = record.sequence;
            }
            if (typeof record?._turnKey === 'string' && record._turnKey) {
                (base as any)._turnKey = record._turnKey;
            }
            if (typeof record?.bubbleState === 'string' && record.bubbleState) {
                (base as any).bubbleState = record.bubbleState;
            }
            return sanitizeHistoryMessage(agentType, base);
        })
        .filter(Boolean) as HistoryMessage[];
}

function callProviderNativeHistoryRead(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    scripts: ProviderNativeHistoryScripts | undefined,
    historySessionId: string | undefined,
    workspace?: string,
    excludeInProgressTurn?: boolean,
    sessionStartedAtMs?: number,
    envOverrides?: Record<string, string>,
    forceRefresh?: boolean,
): ProviderNativeHistoryReadResult | null {
    const fn = getProviderNativeHistoryScript(scripts, canonicalHistory, 'readSession');
    if (!fn) return null;
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId || '');
    const result = fn({
        agentType,
        sessionId: normalizedSessionId,
        historySessionId: normalizedSessionId,
        workspace,
        format: canonicalHistory?.format,
        watchPath: canonicalHistory?.watchPath,
        excludeInProgressTurn: excludeInProgressTurn === true,
        sessionStartedAtMs,
        envOverrides,
        forceRefresh: forceRefresh === true,
        args: { sessionId: normalizedSessionId, historySessionId: normalizedSessionId, workspace, excludeInProgressTurn: excludeInProgressTurn === true, sessionStartedAtMs, envOverrides, forceRefresh: forceRefresh === true },
    });
    if (!result || typeof result !== 'object') return null;
    const records = normalizeProviderNativeHistoryRecords(agentType, normalizedSessionId, (result as any).messages || (result as any).records);
    if (records.length === 0) return null;
    return {
        records,
        sourcePath: typeof (result as any).sourcePath === 'string' ? (result as any).sourcePath : '',
        sourceMtimeMs: Number((result as any).sourceMtimeMs) || 0,
        providerSessionId: typeof (result as any).providerSessionId === 'string' ? (result as any).providerSessionId.trim() : undefined,
        workspace: typeof (result as any).workspace === 'string' ? (result as any).workspace.trim() : undefined,
        nativeHistoryCoverage: typeof (result as any).nativeHistoryCoverage === 'string' ? (result as any).nativeHistoryCoverage.trim() : undefined,
        partialReason: typeof (result as any).partialReason === 'string' ? (result as any).partialReason.trim() : undefined,
        unavailableReason: typeof (result as any).unavailableReason === 'string' ? (result as any).unavailableReason.trim() : undefined,
    };
}

function buildNativeHistoryReadResult(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    scripts: ProviderNativeHistoryScripts | undefined,
    historySessionId: string | undefined,
    workspace?: string,
    excludeInProgressTurn?: boolean,
    sessionStartedAtMs?: number,
    envOverrides?: Record<string, string>,
    forceRefresh?: boolean,
): ProviderNativeHistoryReadResult | null {
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId || '');
    const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
    if (!canonicalHistory || (!normalizedSessionId && !normalizedWorkspace) || !isNativeSourceCanonicalHistory(canonicalHistory)) return null;
    return callProviderNativeHistoryRead(agentType, canonicalHistory, scripts, normalizedSessionId, workspace, excludeInProgressTurn, sessionStartedAtMs, envOverrides, forceRefresh);
}

function materializeNativeHistoryToMirror(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig,
    historySessionId: string,
    workspace?: string,
    scripts?: ProviderNativeHistoryScripts,
): boolean {
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId);
    if (!normalizedSessionId) return false;
    const nativeResult = callProviderNativeHistoryRead(agentType, canonicalHistory, scripts, normalizedSessionId, workspace);
    const nativeRecords = nativeResult?.records || [];
    if (nativeRecords.length === 0) return false;
    const normalizedRecords = nativeRecords.map((record) => ({
        ...record,
        agent: agentType,
        historySessionId: normalizedSessionId,
    }));
    const existingSessionStart = readExistingSessionStartRecord(agentType, normalizedSessionId);
    const records = existingSessionStart && normalizedRecords[0]?.kind !== 'session_start'
        ? [{ ...existingSessionStart, historySessionId: normalizedSessionId, agent: agentType }, ...normalizedRecords]
        : normalizedRecords;
    return rewriteCanonicalSavedHistory(agentType, normalizedSessionId, records);
}

export function materializeProviderNativeHistory(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    historySessionId: string,
    workspace?: string,
    scripts?: ProviderNativeHistoryScripts,
): boolean {
    if (!canonicalHistory || canonicalHistory.mode !== 'materialized-mirror') return false;
    return materializeNativeHistoryToMirror(agentType, canonicalHistory, historySessionId, workspace, scripts);
}

export function isNativeSourceCanonicalHistory(canonicalHistory?: ProviderCanonicalHistoryConfig): boolean {
    if (!canonicalHistory) return false;
    if ((canonicalHistory as any).mode === 'disabled') return false;
    if ((canonicalHistory as any).mode === 'materialized-mirror') return false;
    return true;
}

export function readProviderChatHistory(
    agentType: string,
    options: {
        canonicalHistory?: ProviderCanonicalHistoryConfig;
        historySessionId?: string;
        workspace?: string;
        offset?: number;
        limit?: number;
        excludeRecentCount?: number;
        historyBehavior?: ProviderHistoryBehavior;
        scripts?: ProviderNativeHistoryScripts;
        excludeInProgressTurn?: boolean;
        sessionStartedAtMs?: number;
        envOverrides?: Record<string, string>;
        forceRefresh?: boolean;
    } = {},
): {
    messages: HistoryMessage[];
    hasMore: boolean;
    source: 'provider-native' | 'adhdev-mirror' | 'native-unavailable';
    sourcePath?: string;
    sourceMtimeMs?: number;
    providerSessionId?: string;
    workspace?: string;
    nativeHistoryCoverage?: string;
    partialReason?: string;
    unavailableReason?: string;
} {
    if (isNativeSourceCanonicalHistory(options.canonicalHistory) && (options.historySessionId || options.workspace)) {
        const nativeResult = buildNativeHistoryReadResult(agentType, options.canonicalHistory, options.scripts, options.historySessionId, options.workspace, options.excludeInProgressTurn, options.sessionStartedAtMs, options.envOverrides, options.forceRefresh);
        if (!nativeResult) return { messages: [], hasMore: false, source: 'native-unavailable' };
        return {
            ...pageHistoryRecords(agentType, nativeResult.records, options.offset || 0, options.limit || 30, options.excludeRecentCount || 0, options.historyBehavior),
            source: 'provider-native',
            sourcePath: nativeResult.sourcePath,
            sourceMtimeMs: nativeResult.sourceMtimeMs,
            providerSessionId: nativeResult.providerSessionId,
            workspace: nativeResult.workspace,
            nativeHistoryCoverage: nativeResult.nativeHistoryCoverage,
            partialReason: nativeResult.partialReason,
            unavailableReason: nativeResult.unavailableReason,
        };
    }
    return {
        ...readChatHistory(agentType, options.offset || 0, options.limit || 30, options.historySessionId, options.excludeRecentCount || 0, options.historyBehavior),
        source: 'adhdev-mirror',
    };
}

function buildNativeSessionSummary(
    agentType: string,
    historySessionId: string,
    records: HistoryMessage[],
    sourcePath: string,
): SavedHistorySessionSummary | null {
    const visible = pageHistoryRecords(agentType, records, 0, Number.MAX_SAFE_INTEGER).messages;
    if (visible.length === 0) return null;
    let sourceMtimeMs = 0;
    try { sourceMtimeMs = fs.statSync(sourcePath).mtimeMs; } catch { /* ignore */ }
    const firstMessageAt = visible[0]?.receivedAt || sourceMtimeMs || Date.now();
    const lastMessageAt = visible[visible.length - 1]?.receivedAt || firstMessageAt;
    const lastNonSystem = [...visible].reverse().find((message) => message.role !== 'system') || visible[visible.length - 1];
    const firstSystem = visible.find((message) => message.kind === 'session_start');
    return {
        historySessionId,
        sessionTitle: lastNonSystem?.content,
        messageCount: visible.length,
        firstMessageAt,
        lastMessageAt,
        preview: lastNonSystem?.content,
        workspace: firstSystem?.workspace || (firstSystem?.kind === 'session_start' ? firstSystem.content : undefined),
        source: 'provider-native',
        sourcePath,
        sourceMtimeMs,
    };
}

function normalizeProviderNativeHistorySessionSummary(agentType: string, item: any): SavedHistorySessionSummary | null {
    const historySessionId = normalizeSavedHistorySessionId(item?.historySessionId || item?.sessionId || '');
    if (!historySessionId) return null;
    const sourcePath = typeof item?.sourcePath === 'string' ? item.sourcePath : '';
    const sourceMtimeMs = Number(item?.sourceMtimeMs) || 0;
    const firstMessageAt = Number(item?.firstMessageAt) || sourceMtimeMs || Date.now();
    const lastMessageAt = Number(item?.lastMessageAt) || firstMessageAt;
    const messageCount = Math.max(0, Number(item?.messageCount) || 0);
    return {
        historySessionId,
        sessionTitle: typeof item?.sessionTitle === 'string' ? item.sessionTitle : undefined,
        messageCount,
        firstMessageAt,
        lastMessageAt,
        preview: typeof item?.preview === 'string' ? item.preview : undefined,
        workspace: typeof item?.workspace === 'string' ? item.workspace : undefined,
        source: 'provider-native',
        sourcePath,
        sourceMtimeMs,
    };
}

function collectProviderScriptNativeHistorySessionSummaries(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig,
    scripts?: ProviderNativeHistoryScripts,
): SavedHistorySessionSummary[] | null {
    const fn = getProviderNativeHistoryScript(scripts, canonicalHistory, 'listSessions');
    if (!fn) return null;
    const result = fn({
        agentType,
        format: canonicalHistory.format,
        watchPath: canonicalHistory.watchPath,
        args: {},
    });
    if (!result || typeof result !== 'object') return [];
    const sessions = Array.isArray((result as any).sessions) ? (result as any).sessions : [];
    const summaries: SavedHistorySessionSummary[] = [];
    for (const item of sessions) {
        if (Array.isArray(item?.messages || item?.records)) {
            const historySessionId = normalizeSavedHistorySessionId(item?.historySessionId || item?.sessionId || '');
            if (!historySessionId) continue;
            const records = normalizeProviderNativeHistoryRecords(agentType, historySessionId, item.messages || item.records);
            const summary = buildNativeSessionSummary(agentType, historySessionId, records, typeof item?.sourcePath === 'string' ? item.sourcePath : '');
            if (summary) {
                if (Number(item?.sourceMtimeMs)) summary.sourceMtimeMs = Number(item.sourceMtimeMs);
                summaries.push(summary);
            }
            continue;
        }
        const summary = normalizeProviderNativeHistorySessionSummary(agentType, item);
        if (summary) summaries.push(summary);
    }
    return sortSavedHistorySessionSummaries(summaries);
}

function collectNativeHistorySessionSummaries(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig,
    scripts?: ProviderNativeHistoryScripts,
): SavedHistorySessionSummary[] {
    return collectProviderScriptNativeHistorySessionSummaries(agentType, canonicalHistory, scripts) || [];
}

export function listProviderHistorySessions(
    agentType: string,
    options: {
        canonicalHistory?: ProviderCanonicalHistoryConfig;
        offset?: number;
        limit?: number;
        historyBehavior?: ProviderHistoryBehavior;
        scripts?: ProviderNativeHistoryScripts;
    } = {},
): { sessions: SavedHistorySessionSummary[]; hasMore: boolean; source: 'provider-native' | 'adhdev-mirror' } {
    if (isNativeSourceCanonicalHistory(options.canonicalHistory)) {
        const offset = Math.max(0, options.offset || 0);
        const limit = Math.max(1, options.limit || 30);
        const summaries = collectNativeHistorySessionSummaries(agentType, options.canonicalHistory!, options.scripts);
        return {
            sessions: summaries.slice(offset, offset + limit),
            hasMore: offset + limit < summaries.length,
            source: 'provider-native',
        };
    }
    return {
        ...listSavedHistorySessions(agentType, { offset: options.offset, limit: options.limit }, options.historyBehavior),
        source: 'adhdev-mirror',
    };
}
