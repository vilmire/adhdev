/**
 * The saved-history session index: a persisted, lock-guarded per-agent summary of
 * every saved-history file (session id, message count, first/last timestamps,
 * preview) so the history browser lists sessions without re-reading every JSONL
 * file. The writer keeps it current on session start and append; readers fall back
 * to a background rescan (and a rollup of oversized files) when it is stale.
 */
import * as fs from 'fs';
import * as path from 'path';
import { listHistoryFiles, normalizeSavedHistorySessionId, extractSavedHistorySessionIdFromFile, getHistoryDir } from './chat-history-files.js';
import { ChatHistoryWriter } from './chat-history.js';
import { type HistoryMessage } from './chat-history-messages.js';
import type { ProviderHistoryBehavior } from '../providers/contracts.js';

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

export const savedHistorySessionCache = new Map<string, SavedHistorySessionCacheEntry>();

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

export function sortSavedHistorySessionSummaries(summaries: SavedHistorySessionSummary[]): SavedHistorySessionSummary[] {
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

export function buildSavedHistoryFileSignatureMap(dir: string, files: string[]): Map<string, string> {
    return new Map(files.map((file) => {
        try {
            const stat = fs.statSync(path.join(dir, file));
            return [file, `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`] as const;
        } catch {
            return [file, `${file}:missing`] as const;
        }
    }));
}

export function buildSavedHistoryCacheSignature(files: string[], fileSignatures: Map<string, string>): string {
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

export function invalidatePersistedSavedHistoryIndex(agentType: string, dir: string): void {
    try {
        fs.rmSync(getSavedHistoryIndexFilePath(dir), { force: true });
    } catch {
        // Ignore persisted index cleanup failures.
    }
    savedHistorySessionCache.delete(agentType.replace(/[^a-zA-Z0-9_-]/g, '_'));
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

export function updateSavedHistoryIndexForSessionStart(agentType: string, dir: string, file: string, historySessionId: string, workspace: string): void {
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

export function updateSavedHistoryIndexForAppendedMessages(
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
            for (const entry of Array.from(computed.persistedEntries.values())) {
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

export function listSavedHistorySessions(
    agentType: string,
    options: { offset?: number; limit?: number } = {},
    historyBehavior?: ProviderHistoryBehavior,
): { sessions: SavedHistorySessionSummary[]; hasMore: boolean } {
    try {
        const sanitized = agentType.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(getHistoryDir(), sanitized);
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
