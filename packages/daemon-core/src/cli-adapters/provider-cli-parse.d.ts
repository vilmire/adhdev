import { type CliChatMessage, type CliScriptInput } from './provider-cli-shared.js';
export interface TurnParseScope {
    prompt: string;
    startedAt: number;
    bufferStart: number;
    rawBufferStart: number;
}
export declare function hydrateCliParsedMessages(parsedMessages: any[], options: {
    committedMessages: CliChatMessage[];
    scope?: TurnParseScope | null;
    lastOutputAt: number;
    now?: number;
}): any[];
export declare function normalizeCliParsedMessages(parsedMessages: any[], options: {
    committedMessages: CliChatMessage[];
    scope?: TurnParseScope | null;
    lastOutputAt: number;
    now?: number;
}): CliChatMessage[];
export declare function buildCliParseInput(options: {
    accumulatedBuffer: string;
    accumulatedRawBuffer: string;
    recentOutputBuffer: string;
    terminalScreenText: string;
    baseMessages: CliChatMessage[];
    partialResponse: string;
    scope?: TurnParseScope | null;
    runtimeSettings: Record<string, any>;
}): CliScriptInput;
export declare function summarizeCliTraceText(text: string, max?: number): string;
export declare function summarizeCliTraceMessages(messages: CliChatMessage[], limit?: number): {
    role: string;
    content: string;
    timestamp?: number;
}[];
export declare function buildCliTraceParseSnapshot(options: {
    accumulatedBuffer: string;
    accumulatedRawBuffer: string;
    responseBuffer: string;
    partialResponse?: string;
    scope?: TurnParseScope | null;
}): Record<string, any>;
