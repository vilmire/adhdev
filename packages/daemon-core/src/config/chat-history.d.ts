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
interface HistoryMessage {
    ts: string;
    receivedAt: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    kind?: string;
    senderName?: string;
    agent: string;
    instanceId?: string;
    historySessionId?: string;
    sessionTitle?: string;
}
export interface SavedHistorySessionSummary {
    historySessionId: string;
    sessionTitle?: string;
    messageCount: number;
    firstMessageAt: number;
    lastMessageAt: number;
    preview?: string;
}
export declare class ChatHistoryWriter {
    /** Last seen message count per agent (deduplication) */
    private lastSeenCounts;
    /** Last seen message hash per agent (deduplication) */
    private lastSeenHashes;
    /** Last appended normalized message signature per agent/session */
    private lastSeenSignatures;
    /** Last appended normalized non-system turn signature per agent/session */
    private lastSeenTurnSignatures;
    private rotated;
    /**
    * Append new messages to history
    *
    * @param agentType agent type (e.g. 'antigravity', 'cursor')
    * @param messages Message array received from readChat
    * @param sessionTitle Current session title
    * @param instanceId IDE instance UUID (distinguishes windows of the same agent)
    */
    appendNewMessages(agentType: string, messages: Array<{
        role: string;
        content: string;
        receivedAt?: number;
        kind?: string;
        senderName?: string;
        historyDedupKey?: string;
    }>, sessionTitle?: string, instanceId?: string, historySessionId?: string): void;
    seedSessionHistory(agentType: string, messages?: Array<{
        role: string;
        content: string;
        receivedAt?: number;
        kind?: string;
        historyDedupKey?: string;
    }>, historySessionId?: string, instanceId?: string): void;
    appendSystemMarker(agentType: string, content: string, options?: {
        sessionTitle?: string;
        instanceId?: string;
        historySessionId?: string;
        dedupKey?: string;
        receivedAt?: number;
        senderName?: string;
    }): void;
    promoteHistorySession(agentType: string, previousHistorySessionId: string, nextHistorySessionId: string): void;
    compactHistorySession(agentType: string, historySessionId: string): void;
    /** Called when agent session is explicitly changed */
    onSessionChange(agentType: string): void;
    /** Delete history files older than 30 days */
    private rotateOldFiles;
    /** Allow only filename-safe characters */
    private sanitize;
}
/**
 * Read history (static — called from P2P commands)
 *
 * Read JSONL files in reverse order, returning most recent messages first.
 * When instanceId is specified, reads only that instance file.
 * Offset/limit-based paging.
 */
export declare function readChatHistory(agentType: string, offset?: number, limit?: number, historySessionId?: string): {
    messages: HistoryMessage[];
    hasMore: boolean;
};
export declare function listSavedHistorySessions(agentType: string, options?: {
    offset?: number;
    limit?: number;
}): {
    sessions: SavedHistorySessionSummary[];
    hasMore: boolean;
};
export {};
