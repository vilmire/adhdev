import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NativeHistoryAdapter, NativeHistoryMessage, NativeHistorySessionRef } from './types.js';
import { isPathInside, isSafeNativeHistorySessionId, listFilesRecursive, normalizeHistorySessionId, resolvePathInside, statMtimeMs } from './shared.js';

function normalizeCanonicalHermesMessageContent(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (content == null) return '';
    if (Array.isArray(content)) {
        return content
            .map((entry) => normalizeCanonicalHermesMessageContent(entry))
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (typeof content === 'object') {
        const record = content as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text.trim();
        if (typeof record.content === 'string' || Array.isArray(record.content)) return normalizeCanonicalHermesMessageContent(record.content);
        try { return JSON.stringify(record); } catch { return ''; }
    }
    return String(content).trim();
}

function extractCanonicalHermesMessageTimestamp(message: Record<string, unknown>, fallbackTs: number): number {
    const numericTimestamp = Number(message.receivedAt || message.timestamp || message.ts || 0);
    if (Number.isFinite(numericTimestamp) && numericTimestamp > 0) return numericTimestamp;
    const stringTimestamp = typeof message.ts === 'string'
        ? Date.parse(message.ts)
        : (typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN);
    if (Number.isFinite(stringTimestamp) && stringTimestamp > 0) return stringTimestamp;
    return fallbackTs;
}

function hermesSessionsRoot(): string {
    return path.join(os.homedir(), '.hermes', 'sessions');
}

function hermesSessionPath(sessionId: string): string | null {
    if (!isSafeNativeHistorySessionId(sessionId)) return null;
    return resolvePathInside(hermesSessionsRoot(), `session_${sessionId}.json`);
}

export const hermesNativeHistoryAdapter: NativeHistoryAdapter = {
    providerType: 'hermes-cli',
    format: 'hermes-json',

    resolveSession({ sessionId }): NativeHistorySessionRef | null {
        const normalizedSessionId = normalizeHistorySessionId(sessionId);
        if (!isSafeNativeHistorySessionId(normalizedSessionId)) return null;
        const sourcePath = hermesSessionPath(normalizedSessionId);
        if (!sourcePath || !fs.existsSync(sourcePath)) return null;
        return { sessionId: normalizedSessionId, sourcePath, sourceMtimeMs: statMtimeMs(sourcePath) };
    },

    listSessionRefs(): NativeHistorySessionRef[] {
        const root = hermesSessionsRoot();
        return listFilesRecursive(root, (_entryPath, entry) => entry.isFile() && /^session_.+\.json$/.test(entry.name))
            .map((sourcePath) => {
                const sessionId = path.basename(sourcePath).replace(/^session_/, '').replace(/\.json$/, '');
                if (!isSafeNativeHistorySessionId(sessionId)) return null;
                return { sessionId, sourcePath, sourceMtimeMs: statMtimeMs(sourcePath) } satisfies NativeHistorySessionRef;
            })
            .filter(Boolean) as NativeHistorySessionRef[];
    },

    readSessionRef(ref): NativeHistoryMessage[] | null {
        if (!isSafeNativeHistorySessionId(ref.sessionId) || !isPathInside(hermesSessionsRoot(), ref.sourcePath)) return null;
        const expectedPath = hermesSessionPath(ref.sessionId);
        if (!expectedPath || path.resolve(expectedPath) !== path.resolve(ref.sourcePath)) return null;
        try {
            const raw = JSON.parse(fs.readFileSync(ref.sourcePath, 'utf-8')) as {
                session_start?: string;
                last_updated?: string;
                messages?: Array<Record<string, unknown>>;
            };
            const canonicalMessages = Array.isArray(raw.messages) ? raw.messages : [];
            const records: NativeHistoryMessage[] = [];
            let fallbackTs = Date.parse(raw.session_start || raw.last_updated || '') || Date.now();
            for (const message of canonicalMessages) {
                const role = String(message.role || '').trim();
                const content = normalizeCanonicalHermesMessageContent(message.content);
                if (!content) continue;
                const receivedAt = extractCanonicalHermesMessageTimestamp(message, fallbackTs);
                fallbackTs = receivedAt + 1;
                if (role === 'user' || role === 'assistant') {
                    records.push({
                        ts: new Date(receivedAt).toISOString(),
                        receivedAt,
                        role,
                        content,
                        kind: 'standard',
                        agent: 'hermes-cli',
                        historySessionId: ref.sessionId,
                    });
                    continue;
                }
                if (role === 'tool') {
                    records.push({
                        ts: new Date(receivedAt).toISOString(),
                        receivedAt,
                        role: 'assistant',
                        content,
                        kind: 'tool',
                        senderName: 'Tool',
                        agent: 'hermes-cli',
                        historySessionId: ref.sessionId,
                    });
                }
            }
            return records;
        } catch {
            return null;
        }
    },

    readMessages({ sessionId }): NativeHistoryMessage[] | null {
        const ref = this.resolveSession({ sessionId });
        return ref ? this.readSessionRef(ref) : null;
    },
};
