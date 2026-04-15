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

const HISTORY_DIR = path.join(os.homedir(), '.adhdev', 'history');
const RETAIN_DAYS = 30;

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
            const filePath = path.join(dir, `${filePrefix}${date}.jsonl`);
            const lines = newMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
            fs.appendFileSync(filePath, lines, 'utf-8');

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
            const filePath = path.join(dir, `${this.sanitize(id)}_${date}.jsonl`);
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

                for (const file of files) {
                    const filePath = path.join(dirPath, file);
                    const stat = fs.statSync(filePath);
                    if (stat.mtimeMs < cutoff) {
                        fs.unlinkSync(filePath);
                    }
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
 * Read JSONL files in reverse order, returning most recent messages first.
 * When instanceId is specified, reads only that instance file.
 * Offset/limit-based paging.
 */
export function readChatHistory(
    agentType: string,
    offset: number = 0,
    limit: number = 30,
    historySessionId?: string,
): { messages: HistoryMessage[]; hasMore: boolean } {
    try {
        const sanitized = agentType.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(HISTORY_DIR, sanitized);
        if (!fs.existsSync(dir)) return { messages: [], hasMore: false };

 // JSONL file list — filter by persistent history key when specified
        const sanitizedInstance = historySessionId?.replace(/[^a-zA-Z0-9_-]/g, '_');
        const files = fs.readdirSync(dir)
            .filter(f => {
                if (!f.endsWith('.jsonl')) return false;
                if (sanitizedInstance) {
                    // With instanceId: only that instance's files
                    return f.startsWith(`${sanitizedInstance}_`);
                }
                // Without instanceId: include ALL files (legacy + instanced)
                return true;
            })
            .sort()
            .reverse();

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

 // offset/limit apply
        const sliced = collapsed.slice(offset, offset + limit);
        const hasMore = collapsed.length > offset + limit;

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
        if (!fs.existsSync(dir)) return { sessions: [], hasMore: false };

        const groupedFiles = new Map<string, string[]>();
        const filePattern = /^([A-Za-z0-9_-]+)_\d{4}-\d{2}-\d{2}\.jsonl$/;
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.jsonl')) continue;
            const match = file.match(filePattern);
            if (!match?.[1]) continue;
            const historySessionId = match[1];
            const files = groupedFiles.get(historySessionId) || [];
            files.push(file);
            groupedFiles.set(historySessionId, files);
        }

        const summaries: SavedHistorySessionSummary[] = [];
        for (const [historySessionId, files] of groupedFiles.entries()) {
            let messageCount = 0;
            let firstMessageAt = 0;
            let lastMessageAt = 0;
            let sessionTitle = '';
            let preview = '';
            let workspace = '';

            for (const file of files.sort()) {
                const filePath = path.join(dir, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n').filter(Boolean);
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
            }

            if (messageCount === 0 || !lastMessageAt) continue;
            summaries.push({
                historySessionId,
                sessionTitle: sessionTitle || undefined,
                messageCount,
                firstMessageAt,
                lastMessageAt,
                preview: preview || undefined,
                workspace: workspace || undefined,
            });
        }

        summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        const offset = Math.max(0, options.offset || 0);
        const limit = Math.max(1, options.limit || 30);
        const sliced = summaries.slice(offset, offset + limit);
        return {
            sessions: sliced,
            hasMore: summaries.length > offset + limit,
        };
    } catch {
        return { sessions: [], hasMore: false };
    }
}
