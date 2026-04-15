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
    const usedReferenceIndexes = new Set<number>();
    const now = options.now ?? Date.now();

    const findReferenceTimestamp = (role: 'user' | 'assistant', content: string, parsedIndex: number): number | undefined => {
        const normalizedContent = normalizeComparableMessageContent(content);
        if (!normalizedContent) return undefined;

        const sameIndex = referenceMessages[parsedIndex];
        if (
            sameIndex
            && !usedReferenceIndexes.has(parsedIndex)
            && sameIndex.role === role
            && normalizeComparableMessageContent(sameIndex.content) === normalizedContent
            && typeof sameIndex.timestamp === 'number'
            && Number.isFinite(sameIndex.timestamp)
        ) {
            usedReferenceIndexes.add(parsedIndex);
            return sameIndex.timestamp;
        }

        for (let i = 0; i < referenceMessages.length; i++) {
            if (usedReferenceIndexes.has(i)) continue;
            const candidate = referenceMessages[i];
            if (!candidate || candidate.role !== role) continue;
            const candidateContent = normalizeComparableMessageContent(candidate.content);
            if (!candidateContent) continue;
            const exactMatch = candidateContent === normalizedContent;
            const fuzzyMatch = candidateContent.includes(normalizedContent) || normalizedContent.includes(candidateContent);
            if (!exactMatch && !fuzzyMatch) continue;
            if (typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)) {
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
            const referenceTimestamp = parsedTimestamp ?? findReferenceTimestamp(role, content, index);
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

export function normalizeCliParsedMessages(
    parsedMessages: any[],
    options: {
        committedMessages: CliChatMessage[];
        scope?: TurnParseScope | null;
        lastOutputAt: number;
        now?: number;
    },
): CliChatMessage[] {
    return hydrateCliParsedMessages(parsedMessages, options).map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        receivedAt: message.receivedAt,
        kind: message.kind,
        id: message.id,
        index: message.index,
        meta: message.meta,
        senderName: message.senderName,
    }));
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
        ? (sliceFromOffset(accumulatedBuffer, scope.bufferStart) || accumulatedBuffer)
        : accumulatedBuffer;
    const rawBuffer = scope
        ? (sliceFromOffset(accumulatedRawBuffer, scope.rawBufferStart) || accumulatedRawBuffer)
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
        ? (sliceFromOffset(accumulatedBuffer, scope.bufferStart) || accumulatedBuffer)
        : accumulatedBuffer;
    const scopedRawBuffer = scope
        ? (sliceFromOffset(accumulatedRawBuffer, scope.rawBufferStart) || accumulatedRawBuffer)
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
