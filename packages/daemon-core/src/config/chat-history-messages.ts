/**
 * The saved-history record shape and its normalization: content cleanup, the
 * content hash / signature a record is deduplicated by, adjacent-duplicate removal,
 * and the collapse of an assistant turn a provider replayed. Pure functions over
 * HistoryMessage — the writer, the tail reader and the session index share them.
 */
import type { ProviderHistoryBehavior } from '../providers/contracts.js';

export interface HistoryMessage {
    ts: string;           // ISO timestamp
    receivedAt: number;   // epoch ms
    role: 'user' | 'assistant' | 'system';
    content: string;
    kind?: string;
    senderName?: string;
    /** The specific tool invoked (e.g. 'read_file'), when the reader resolves
     *  one — distinct from the generic senderName:'Tool'. Currently only
     *  antigravity's native-history reader stamps this. */
    toolName?: string;
    agent: string;        // e.g. 'antigravity', 'cursor', 'gemini-cli'
    instanceId?: string;  // IDE instance UUID (distinguishes windows of the same agent type)
    historySessionId?: string; // Persistent provider-side conversation/session key
    sessionTitle?: string;
    workspace?: string;   // Working directory at session start (kind: 'session_start' only)
    /**
     * (BUBBLE-IDENTITY) Producer-minted, content-free bubble identity. Declared
     * here because it is genuinely persisted to the JSONL record — it used to be
     * stamped through `as any` on the normalizer path only, which hid the fact
     * that the incremental-append writer dropped it on the floor.
     *
     * Identifiers and ordinals only, never content. `toolBlockRef` is
     * deliberately NOT part of this set: it is sealed by `sourceMtimeMs`, so a
     * persisted ref is dead on the next read (see `appendNewMessages`).
     */
    sequence?: number;
    _turnKey?: string;
    bubbleState?: string;
    providerUnitKey?: string;
    bubbleId?: string;
}

function normalizeHistoryComparable(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

export function cleanupHistoryContent(agentType: string, role: HistoryMessage['role'], content: string, historyBehavior?: ProviderHistoryBehavior): string {
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

export function buildHistoryMessageHash(
    agentType: string,
    message: Pick<HistoryMessage, 'role' | 'content' | 'receivedAt' | 'kind'> & { historyDedupKey?: string },
): string {
    if (message.historyDedupKey) return message.historyDedupKey;
    const cleaned = cleanupHistoryContent(agentType, message.role, message.content);
    return `${message.kind || 'standard'}:${message.role}:${message.receivedAt || 0}:${normalizeHistoryComparable(cleaned)}`;
}

export function buildHistoryMessageSignature(
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
    signatureFor: (
        agentType: string,
        message: Pick<HistoryMessage, 'role' | 'content' | 'kind'>,
    ) => string = buildHistoryMessageSignature,
): boolean {
    if (!previous || !next) return false;
    return signatureFor(agentType, previous) === signatureFor(agentType, next);
}

/**
 * Preserve the historical adjacent/last-turn duplicate rules while computing
 * each normalized signature once per record. Large assistant/tool payloads used
 * to pass through normalizeHistoryComparable up to four times in one paging
 * pass (as both `previous` and `lastTurn`).
 */
export function dedupeAdjacentHistoryMessages(agentType: string, messages: HistoryMessage[]): HistoryMessage[] {
    const deduped: HistoryMessage[] = [];
    let lastTurn: HistoryMessage | null = null;
    const signatureCache = new WeakMap<object, string>();
    const signatureFor = (
        currentAgentType: string,
        message: Pick<HistoryMessage, 'role' | 'content' | 'kind'>,
    ): string => {
        const key = message as object;
        const cached = signatureCache.get(key);
        if (cached !== undefined) return cached;
        const signature = buildHistoryMessageSignature(currentAgentType, message);
        signatureCache.set(key, signature);
        return signature;
    };

    for (const message of messages) {
        const previous = deduped[deduped.length - 1];
        if (isAdjacentHistoryDuplicate(agentType, previous, message, signatureFor)) continue;
        if (message.role !== 'system' && isAdjacentHistoryDuplicate(agentType, lastTurn, message, signatureFor)) continue;
        deduped.push(message);
        if (message.role !== 'system') lastTurn = message;
    }
    return deduped;
}

export function collapseReplayAssistantTurns(messages: HistoryMessage[], historyBehavior?: ProviderHistoryBehavior): HistoryMessage[] {
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
            // Tool / activity bubbles are distinct events, not replayed prose —
            // collapsing them would erase every tool call and result after the
            // turn's first assistant message. Only consecutive *prose* assistant
            // turns are the replay-dedup target this collapse exists for.
            const isActivity = message.kind === 'tool' || message.kind === 'terminal' || message.kind === 'thought';
            if (isActivity) {
                collapsed.push(message);
                continue;
            }
            if (sawAssistantSinceLastUser) continue;
            sawAssistantSinceLastUser = true;
            collapsed.push(message);
            continue;
        }

        collapsed.push(message);
    }

    return collapsed;
}

export function sanitizeHistoryMessage(agentType: string, message: HistoryMessage): HistoryMessage | null {
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
