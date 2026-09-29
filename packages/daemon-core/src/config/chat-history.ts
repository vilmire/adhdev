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
import { buildRuntimeSystemChatMessage } from '../providers/chat-message-normalization.js';
import { carryBubbleIdentity } from '../providers/cli-provider-history-dedup.js';
import type { ProviderHistoryBehavior } from '../providers/contracts.js';
import { getHistoryDir, listHistoryFiles } from './chat-history-files.js';
import { savedHistorySessionCache, buildSavedHistoryFileSignatureMap, buildSavedHistoryCacheSignature, invalidatePersistedSavedHistoryIndex, updateSavedHistoryIndexForSessionStart, updateSavedHistoryIndexForAppendedMessages } from './saved-history-index.js';
import { readBoundedTailCache, writeBoundedTailCache, pageHistoryRecords, BOUNDED_TAIL_SLACK, isBoundedTailRequest, readBoundedTailRecords } from './chat-history-tail.js';
import { cleanupHistoryContent, buildHistoryMessageHash, buildHistoryMessageSignature, dedupeAdjacentHistoryMessages, collapseReplayAssistantTurns, sanitizeHistoryMessage, type HistoryMessage } from './chat-history-messages.js';
const RETAIN_DAYS = 30;

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
 * @message-projection l3 identity
 * @message-projection-excludes toolBlockRef: sealed by sourceMtimeMs, so a ref
 * persisted to disk is dead on the next read (expandToolBlock fails closed with
 * `source_changed`). Re-stamped by the native parser on each read instead.
 * @message-projection-excludes _src: the identity ledger's reader address is re-stamped by the native reader on every read; a persisted copy would pin a stale lineage.
 *
 * The incremental-append lane. Read-back is a passthrough, so a field omitted
 * here is unrecoverable — see the note on the pushed record below.
 *
 * @param agentType agent type (e.g. 'antigravity', 'cursor')
 * @param messages Message array received from readChat
 * @param sessionTitle Current session title
 * @param instanceId IDE instance UUID (distinguishes windows of the same agent)
 */
    appendNewMessages(
        agentType: string,
        messages: Array<{
            role: string;
            content: string;
            receivedAt?: number;
            kind?: string;
            senderName?: string;
            historyDedupKey?: string;
            sequence?: number;
            _turnKey?: string;
            bubbleState?: string;
            providerUnitKey?: string;
            bubbleId?: string;
        }>,
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
                    // (BUBBLE-IDENTITY) This writer is the incremental-append lane
                    // (PTY-parsed tail via cli-provider-state-projection, plus the
                    // runtime/system markers). Read-back is a passthrough
                    // (JSON.parse -> sanitizeHistoryMessage spreads `...message`),
                    // so whatever lands here survives a restart — and whatever does
                    // NOT land here is unrecoverable, because the downstream
                    // activeChat/persisted-tail remaps only carry what they are
                    // handed. Identity was previously dropped at this hop, which
                    // forced every restored bubble onto an index-derived React key.
                    //
                    // `toolBlockRef` is deliberately excluded: it is sealed by
                    // `sourceMtimeMs` and `expandToolBlock` fails closed with
                    // `source_changed` when the seal no longer matches, so a
                    // persisted ref would render a permanently dead expand control.
                    // Refs are re-stamped by the native parser on each read instead.
                    ...carryBubbleIdentity(msg),
                });
            }

            if (newMessages.length === 0) return;

 // Append to file — keyed by persistent history session when available
            const dir = path.join(getHistoryDir(), this.sanitize(agentType));
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
            const dir = path.join(getHistoryDir(), this.sanitize(agentType));
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

            const dir = path.join(getHistoryDir(), this.sanitize(agentType));
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
            const dir = path.join(getHistoryDir(), this.sanitize(agentType));
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
                const dedupedAdjacent = dedupeAdjacentHistoryMessages(agentType, next);
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
            if (!fs.existsSync(getHistoryDir())) return;
            const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;

            const agentDirs = fs.readdirSync(getHistoryDir(), { withFileTypes: true })
                .filter(d => d.isDirectory());

            for (const dir of agentDirs) {
                const dirPath = path.join(getHistoryDir(), dir.name);
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

export function readChatHistory(
    agentType: string,
    offset: number = 0,
    limit: number = 30,
    historySessionId?: string,
    excludeRecentCount: number = 0,
    historyBehavior?: ProviderHistoryBehavior,
    excludeFromIdentity?: string,
    excludeActivity: boolean = false,
): { messages: HistoryMessage[]; hasMore: boolean } {
    try {
        const sanitized = agentType.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(getHistoryDir(), sanitized);
        if (!fs.existsSync(dir)) return { messages: [], hasMore: false };

 // JSONL file list — filter by persistent history key when specified
        const files = listHistoryFiles(dir, historySessionId);

        const bounded = isBoundedTailRequest(limit, offset, excludeRecentCount);

        if (bounded) {
            const fileSignatures = buildSavedHistoryFileSignatureMap(dir, files);
            const cacheKey = `${sanitized}\0${historySessionId || ''}\0${offset}\0${limit}\0${excludeRecentCount}\0${excludeFromIdentity || ''}\0${historyBehavior?.collapseConsecutiveAssistantTurns ? '1' : '0'}\0${excludeActivity ? '1' : '0'}`;
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
            const result = pageHistoryRecords(agentType, records, offset, limit, excludeRecentCount, historyBehavior, excludeFromIdentity, excludeActivity);
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

        return pageHistoryRecords(agentType, allMessages, offset, limit, excludeRecentCount, historyBehavior, excludeFromIdentity, excludeActivity);
    } catch {
        return { messages: [], hasMore: false };
    }
}

export function readExistingSessionStartRecord(agentType: string, historySessionId: string): HistoryMessage | null {
    try {
        const dir = path.join(getHistoryDir(), agentType);
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

export function rewriteCanonicalSavedHistory(agentType: string, historySessionId: string, records: HistoryMessage[]): boolean {
    if (records.length === 0) return false;
    try {
        const dir = path.join(getHistoryDir(), agentType);
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
