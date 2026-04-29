import type { ProviderCanonicalHistoryConfig } from '../../providers/contracts.js';

export type NativeHistoryFormat = ProviderCanonicalHistoryConfig['format'];

export interface NativeHistoryMessage {
    ts: string;
    receivedAt: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    kind?: string;
    senderName?: string;
    agent: string;
    historySessionId?: string;
    workspace?: string;
}

export interface NativeHistorySessionRef {
    sessionId: string;
    sourcePath: string;
    sourceMtimeMs: number;
    workspace?: string;
}

export interface NativeHistoryAdapter {
    providerType: string;
    format: NativeHistoryFormat;
    resolveSession(args: { sessionId: string; workspace?: string }): NativeHistorySessionRef | null;
    listSessionRefs(): NativeHistorySessionRef[];
    readSessionRef(ref: NativeHistorySessionRef): NativeHistoryMessage[] | null;
    readMessages(args: { sessionId: string; workspace?: string }): NativeHistoryMessage[] | null;
}
