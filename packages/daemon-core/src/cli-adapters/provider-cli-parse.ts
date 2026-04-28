import {
    buildCliScreenSnapshot,
    normalizeComparableMessageContent,
    sanitizeTerminalText,
    type CliChatMessage,
    type CliScriptInput,
} from './provider-cli-shared.js';

export interface TurnParseScope {
    prompt: string;
    startedAt: number;
    bufferStart: number;
    rawBufferStart: number;
}

function sliceFromOffset(text: string, start: number): string {
    if (!text) return '';
    if (!Number.isFinite(start) || start <= 0) return text;
    if (start >= text.length) return '';
    return text.slice(start);
}

export function hydrateCliParsedMessages(
    parsedMessages: any[],
    options: {
        committedMessages: CliChatMessage[];
        scope?: TurnParseScope | null;
        lastOutputAt: number;
        now?: number;
    },
): any[] {
    const { committedMessages, scope, lastOutputAt } = options;
    const referenceMessages = [...committedMessages];
    const referenceComparables: Array<string | undefined> = new Array(referenceMessages.length);
    const usedReferenceIndexes = new Set<number>();
    const now = options.now ?? Date.now();
    let exactReferenceIndexesByKey: Map<string, number[]> | null = null;
    const exactReferenceCursorByKey = new Map<string, number>();

    const hasFiniteTimestamp = (message: any): message is { timestamp: number } => (
        typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)
    );

    const getReferenceComparable = (index: number): string => {
        if (typeof referenceComparables[index] === 'string') return referenceComparables[index] || '';
        const comparable = normalizeComparableMessageContent(referenceMessages[index]?.content || '');
        referenceComparables[index] = comparable;
        return comparable;
    };

    const messagesShareStableIdentity = (parsed: any, reference: any): boolean => {
        if (!parsed || !reference) return false;
        const parsedId = typeof parsed.id === 'string' ? parsed.id.trim() : '';
        const referenceId = typeof reference.id === 'string' ? reference.id.trim() : '';
        if (parsedId && referenceId && parsedId === referenceId) return true;
        return typeof parsed.index === 'number'
            && Number.isFinite(parsed.index)
            && typeof reference.index === 'number'
            && Number.isFinite(reference.index)
            && parsed.index === reference.index;
    };

    const exactReferenceKey = (role: 'user' | 'assistant', comparable: string): string => `${role}\u0000${comparable}`;

    const ensureExactReferenceIndex = (): Map<string, number[]> => {
        if (exactReferenceIndexesByKey) return exactReferenceIndexesByKey;
        const byKey = new Map<string, number[]>();
        for (let i = 0; i < referenceMessages.length; i++) {
            const candidate = referenceMessages[i];
            if (!candidate || (candidate.role !== 'user' && candidate.role !== 'assistant') || !hasFiniteTimestamp(candidate)) continue;
            const comparable = getReferenceComparable(i);
            if (!comparable) continue;
            const key = exactReferenceKey(candidate.role, comparable);
            const indexes = byKey.get(key);
            if (indexes) {
                indexes.push(i);
            } else {
                byKey.set(key, [i]);
            }
        }
        exactReferenceIndexesByKey = byKey;
        return byKey;
    };

    const takeExactReferenceTimestamp = (role: 'user' | 'assistant', normalizedContent: string): number | undefined => {
        const key = exactReferenceKey(role, normalizedContent);
        const indexes = ensureExactReferenceIndex().get(key);
        if (!indexes) return undefined;
        let cursor = exactReferenceCursorByKey.get(key) || 0;
        while (cursor < indexes.length) {
            const candidateIndex = indexes[cursor];
            cursor += 1;
            if (usedReferenceIndexes.has(candidateIndex)) continue;
            const candidate = referenceMessages[candidateIndex];
            if (!candidate || candidate.role !== role || !hasFiniteTimestamp(candidate)) continue;
            usedReferenceIndexes.add(candidateIndex);
            exactReferenceCursorByKey.set(key, cursor);
            return candidate.timestamp;
        }
        exactReferenceCursorByKey.set(key, cursor);
        return undefined;
    };

    const findReferenceTimestamp = (message: any, role: 'user' | 'assistant', content: string, parsedIndex: number): number | undefined => {
        const sameIndex = referenceMessages[parsedIndex];
        if (
            sameIndex
            && !usedReferenceIndexes.has(parsedIndex)
            && sameIndex.role === role
            && hasFiniteTimestamp(sameIndex)
            && messagesShareStableIdentity(message, sameIndex)
        ) {
            usedReferenceIndexes.add(parsedIndex);
            return sameIndex.timestamp;
        }

        const normalizedContent = normalizeComparableMessageContent(content);
        if (!normalizedContent) return undefined;

        if (
            sameIndex
            && !usedReferenceIndexes.has(parsedIndex)
            && sameIndex.role === role
            && getReferenceComparable(parsedIndex) === normalizedContent
            && hasFiniteTimestamp(sameIndex)
        ) {
            usedReferenceIndexes.add(parsedIndex);
            return sameIndex.timestamp;
        }

        const exactTimestamp = takeExactReferenceTimestamp(role, normalizedContent);
        if (typeof exactTimestamp === 'number') return exactTimestamp;

        for (let i = 0; i < referenceMessages.length; i++) {
            if (usedReferenceIndexes.has(i)) continue;
            const candidate = referenceMessages[i];
            if (!candidate || candidate.role !== role) continue;
            const candidateContent = getReferenceComparable(i);
            if (!candidateContent) continue;
            const fuzzyMatch = candidateContent.includes(normalizedContent) || normalizedContent.includes(candidateContent);
            if (!fuzzyMatch) continue;
            if (hasFiniteTimestamp(candidate)) {
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
            const referenceTimestamp = parsedTimestamp ?? findReferenceTimestamp(message, role, content, index);
            const fallbackTimestamp = role === 'user'
                ? (scope?.startedAt || now)
                : (lastOutputAt || scope?.startedAt || now);
            const timestamp = referenceTimestamp ?? fallbackTimestamp;
            return {
                ...message,
                role,
                content,
                timestamp,
                receivedAt: typeof message.receivedAt === 'number' && Number.isFinite(message.receivedAt)
                    ? message.receivedAt
                    : timestamp,
            };
        });
}

function chooseMoreComparableCliMessage(
    left: CliChatMessage,
    right: CliChatMessage,
    leftComparable = normalizeComparableMessageContent(left.content || ''),
    rightComparable = normalizeComparableMessageContent(right.content || ''),
): CliChatMessage {
    if (leftComparable && leftComparable === rightComparable) {
        const leftNewlines = String(left.content || '').split(/\r\n|\n|\r/g).length - 1;
        const rightNewlines = String(right.content || '').split(/\r\n|\n|\r/g).length - 1;
        return rightNewlines < leftNewlines ? right : left;
    }

    return rightComparable.length > leftComparable.length ? right : left;
}

function dedupeConsecutiveComparableCliMessages(messages: CliChatMessage[]): CliChatMessage[] {
    const deduped: Array<{ message: CliChatMessage; comparable: string }> = [];

    for (const message of messages) {
        const current = {
            ...message,
            content: typeof message.content === 'string' ? message.content : String(message.content || ''),
        } as CliChatMessage;
        const currentComparable = normalizeComparableMessageContent(current.content || '');
        const previous = deduped[deduped.length - 1];
        if (!previous) {
            deduped.push({ message: current, comparable: currentComparable });
            continue;
        }

        const sameRole = previous.message.role === current.role;
        const sameKind = (previous.message.kind || 'standard') === (current.kind || 'standard');
        const sameSender = (previous.message.senderName || '') === (current.senderName || '');
        const comparableMatch = previous.comparable && previous.comparable === currentComparable;

        if (sameRole && sameKind && sameSender && comparableMatch) {
            const selected = chooseMoreComparableCliMessage(
                previous.message,
                current,
                previous.comparable,
                currentComparable,
            );
            deduped[deduped.length - 1] = {
                message: selected,
                comparable: selected === current ? currentComparable : previous.comparable,
            };
            continue;
        }

        deduped.push({ message: current, comparable: currentComparable });
    }

    return deduped.map((entry) => entry.message);
}

export function normalizeCliParsedMessages(
    parsedMessages: any[],
    options: {
        committedMessages: CliChatMessage[];
        scope?: TurnParseScope | null;
        lastOutputAt: number;
        now?: number;
    },
): CliChatMessage[] {
    return dedupeConsecutiveComparableCliMessages(hydrateCliParsedMessages(parsedMessages, options).map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        receivedAt: message.receivedAt,
        kind: message.kind,
        id: message.id,
        index: message.index,
        providerUnitKey: message.providerUnitKey,
        bubbleId: message.bubbleId,
        bubbleState: message.bubbleState,
        _turnKey: message._turnKey,
        meta: message.meta,
        senderName: message.senderName,
    })));
}

export function buildCliParseInput(options: {
    accumulatedBuffer: string;
    accumulatedRawBuffer: string;
    recentOutputBuffer: string;
    terminalScreenText: string;
    baseMessages: CliChatMessage[];
    partialResponse: string;
    isWaitingForResponse?: boolean;
    scope?: TurnParseScope | null;
    runtimeSettings: Record<string, any>;
}): CliScriptInput {
    const {
        accumulatedBuffer,
        accumulatedRawBuffer,
        recentOutputBuffer,
        terminalScreenText,
        baseMessages,
        partialResponse,
        isWaitingForResponse,
        scope,
        runtimeSettings,
    } = options;
    const buffer = scope
        ? sliceFromOffset(accumulatedBuffer, scope.bufferStart)
        : accumulatedBuffer;
    const rawBuffer = scope
        ? sliceFromOffset(accumulatedRawBuffer, scope.rawBufferStart)
        : accumulatedRawBuffer;
    const screenText = terminalScreenText;
    const recentBuffer = buffer.slice(-1000) || recentOutputBuffer;

    return {
        buffer,
        rawBuffer,
        recentBuffer,
        screenText,
        screen: buildCliScreenSnapshot(screenText),
        bufferScreen: buildCliScreenSnapshot(buffer),
        recentScreen: buildCliScreenSnapshot(recentBuffer),
        messages: [...baseMessages],
        partialResponse,
        isWaitingForResponse,
        promptText: scope?.prompt || '',
        settings: { ...runtimeSettings },
    };
}

export function summarizeCliTraceText(text: string, max = 800): string {
    const value = sanitizeTerminalText(String(text || ''));
    if (value.length <= max) return value;
    return `…${value.slice(-max)}`;
}

export function summarizeCliTraceMessages(
    messages: CliChatMessage[],
    limit = 3,
): { role: string; content: string; timestamp?: number }[] {
    return messages.slice(-limit).map((message) => ({
        role: message.role,
        content: summarizeCliTraceText(message.content, 240),
        timestamp: message.timestamp,
    }));
}

export function buildCliTraceParseSnapshot(options: {
    accumulatedBuffer: string;
    accumulatedRawBuffer: string;
    responseBuffer: string;
    partialResponse?: string;
    scope?: TurnParseScope | null;
}): Record<string, any> {
    const { accumulatedBuffer, accumulatedRawBuffer, responseBuffer, partialResponse, scope } = options;
    const scopedBuffer = scope
        ? sliceFromOffset(accumulatedBuffer, scope.bufferStart)
        : accumulatedBuffer;
    const scopedRawBuffer = scope
        ? sliceFromOffset(accumulatedRawBuffer, scope.rawBufferStart)
        : accumulatedRawBuffer;
    return {
        currentTurnScope: scope || null,
        responseBuffer: summarizeCliTraceText(responseBuffer, 1200),
        partialResponse: summarizeCliTraceText(partialResponse || responseBuffer, 1200),
        turnBuffer: summarizeCliTraceText(scopedBuffer, 1600),
        turnRawPreview: summarizeCliTraceText(scopedRawBuffer, 1600),
        turnSanitizedRawPreview: summarizeCliTraceText(sanitizeTerminalText(scopedRawBuffer), 1600),
    };
}
