import {
    buildCliScreenSnapshot,
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

export function normalizeCliParsedMessages(
    parsedMessages: any[],
    _options: {
        scope?: TurnParseScope | null;
        lastOutputAt: number;
        now?: number;
    },
): CliChatMessage[] {
    return Array.isArray(parsedMessages) ? parsedMessages as CliChatMessage[] : [];
}

export function buildCliParseInput(options: {
    accumulatedBuffer: string;
    accumulatedRawBuffer: string;
    recentOutputBuffer: string;
    terminalScreenText: string;
    workingDir?: string;
    providerSessionId?: string;
    historySessionId?: string;
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
        workingDir,
        providerSessionId,
        historySessionId,
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
        workspace: workingDir,
        workingDir,
        providerSessionId,
        historySessionId,
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
