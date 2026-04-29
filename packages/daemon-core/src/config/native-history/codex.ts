import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NativeHistoryAdapter, NativeHistoryMessage, NativeHistorySessionRef } from './types.js';
import { extractTimestampValue, isPathInside, listFilesRecursive, normalizeHistorySessionId, statMtimeMs } from './shared.js';

function isUuidLikeSessionId(sessionId: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
}

export function readCodexSessionMeta(filePath: string): Record<string, unknown> | null {
    try {
        const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n').find(Boolean);
        if (!firstLine) return null;
        const parsed = JSON.parse(firstLine) as Record<string, unknown>;
        if (String(parsed.type || '') !== 'session_meta') return null;
        const payload = parsed.payload && typeof parsed.payload === 'object'
            ? parsed.payload as Record<string, unknown>
            : null;
        return payload;
    } catch {
        return null;
    }
}

export function resolveCodexSessionTranscriptPath(historySessionId: string, workspace?: string): string | null {
    const normalizedSessionId = normalizeHistorySessionId(historySessionId);
    if (!normalizedSessionId || !isUuidLikeSessionId(normalizedSessionId)) return null;
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;
    const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
    const candidates: Array<{ path: string; mtimeMs: number; workspaceMatches: boolean; metaMatches: boolean }> = [];
    const stack = [sessionsDir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.includes(normalizedSessionId)) continue;
            const meta = readCodexSessionMeta(entryPath);
            const metaSessionId = String(meta?.id || '').trim();
            if (metaSessionId && metaSessionId !== normalizedSessionId) continue;
            const metaWorkspace = String(meta?.cwd || '').trim();
            candidates.push({
                path: entryPath,
                mtimeMs: statMtimeMs(entryPath),
                workspaceMatches: !!normalizedWorkspace && metaWorkspace === normalizedWorkspace,
                metaMatches: metaSessionId === normalizedSessionId,
            });
        }
    }
    candidates.sort((a, b) => Number(b.workspaceMatches) - Number(a.workspaceMatches)
        || Number(b.metaMatches) - Number(a.metaMatches)
        || b.mtimeMs - a.mtimeMs);
    return candidates[0]?.path || null;
}

function flattenCodexContent(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (content == null) return '';
    if (Array.isArray(content)) {
        return content.map((entry) => flattenCodexContent(entry)).filter(Boolean).join('\n').trim();
    }
    if (typeof content === 'object') {
        const record = content as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text.trim();
        if (typeof record.content === 'string' || Array.isArray(record.content)) return flattenCodexContent(record.content);
        if (typeof record.output === 'string') return record.output.trim();
        if (typeof record.message === 'string') return record.message.trim();
    }
    return '';
}

function summarizeCodexToolCall(payload: Record<string, unknown>): string {
    const name = String(payload.name || payload.type || 'tool').trim() || 'tool';
    const rawArguments = payload.arguments ?? payload.input;
    let argumentValue = '';
    if (typeof rawArguments === 'string') {
        const trimmed = rawArguments.trim();
        try { argumentValue = summarizeCodexToolArguments(JSON.parse(trimmed) as unknown); } catch { argumentValue = trimmed; }
    } else {
        argumentValue = summarizeCodexToolArguments(rawArguments);
    }
    return argumentValue ? `${name}: ${argumentValue}` : name;
}

function summarizeCodexToolArguments(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.map((entry) => String(entry)).join(' ').trim();
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    const direct = record.command || record.cmd || record.query || record.path || record.prompt;
    if (typeof direct === 'string') return direct.trim();
    if (Array.isArray(direct)) return direct.map((entry) => String(entry)).join(' ').trim();
    try { return JSON.stringify(record).trim(); } catch { return ''; }
}

function codexToolOutputContent(payload: Record<string, unknown>): string {
    const output = payload.output ?? payload.result ?? payload.content;
    const text = flattenCodexContent(output);
    if (text) return text;
    if (output && typeof output === 'object') {
        try { return JSON.stringify(output).trim(); } catch { return ''; }
    }
    return '';
}

export const codexNativeHistoryAdapter: NativeHistoryAdapter = {
    providerType: 'codex-cli',
    format: 'codex-jsonl',

    resolveSession({ sessionId, workspace }): NativeHistorySessionRef | null {
        const normalizedSessionId = normalizeHistorySessionId(sessionId);
        if (!normalizedSessionId || !isUuidLikeSessionId(normalizedSessionId)) return null;
        const sourcePath = resolveCodexSessionTranscriptPath(normalizedSessionId, workspace);
        if (!sourcePath) return null;
        const meta = readCodexSessionMeta(sourcePath);
        return {
            sessionId: normalizedSessionId,
            sourcePath,
            sourceMtimeMs: statMtimeMs(sourcePath),
            workspace: String(meta?.cwd || workspace || '').trim() || undefined,
        };
    },

    listSessionRefs(): NativeHistorySessionRef[] {
        const root = path.join(os.homedir(), '.codex', 'sessions');
        const uuidPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
        return listFilesRecursive(root, (_entryPath, entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map((sourcePath) => {
                const meta = readCodexSessionMeta(sourcePath);
                const sessionId = String(meta?.id || path.basename(sourcePath).match(uuidPattern)?.[1] || '').trim();
                if (!sessionId) return null;
                return {
                    sessionId,
                    sourcePath,
                    sourceMtimeMs: statMtimeMs(sourcePath),
                    workspace: String(meta?.cwd || '').trim() || undefined,
                } satisfies NativeHistorySessionRef;
            })
            .filter(Boolean) as NativeHistorySessionRef[];
    },

    readSessionRef(ref): NativeHistoryMessage[] | null {
        const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
        if (!isUuidLikeSessionId(ref.sessionId) || !isPathInside(sessionsDir, ref.sourcePath)) return null;
        try {
            const lines = fs.readFileSync(ref.sourcePath, 'utf-8').split('\n').filter(Boolean);
            const records: NativeHistoryMessage[] = [];
            let fallbackTs = Date.now();
            for (const line of lines) {
                let parsed: Record<string, unknown> | null = null;
                try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { parsed = null; }
                if (!parsed) continue;
                const receivedAt = extractTimestampValue(parsed.timestamp) || fallbackTs;
                fallbackTs = receivedAt + 1;
                const type = String(parsed.type || '').trim();
                const payload = parsed.payload && typeof parsed.payload === 'object'
                    ? parsed.payload as Record<string, unknown>
                    : null;
                if (!payload) continue;
                if (type === 'session_meta') {
                    const parsedSessionId = String(payload.id || '').trim();
                    if (parsedSessionId && parsedSessionId !== ref.sessionId) return null;
                    const parsedWorkspace = String(payload.cwd || ref.workspace || '').trim();
                    if (records.length === 0 && parsedWorkspace) {
                        records.push({
                            ts: new Date(receivedAt).toISOString(),
                            receivedAt,
                            role: 'system',
                            kind: 'session_start',
                            content: parsedWorkspace,
                            agent: 'codex-cli',
                            historySessionId: ref.sessionId,
                            workspace: parsedWorkspace,
                        });
                    }
                    continue;
                }
                if (type !== 'response_item') continue;
                const payloadType = String(payload.type || '').trim();
                if (payloadType === 'message') {
                    const role = String(payload.role || '').trim();
                    if (role !== 'user' && role !== 'assistant') continue;
                    const content = flattenCodexContent(payload.content);
                    if (!content) continue;
                    records.push({
                        ts: new Date(receivedAt).toISOString(),
                        receivedAt,
                        role,
                        content,
                        kind: 'standard',
                        agent: 'codex-cli',
                        historySessionId: ref.sessionId,
                    });
                    continue;
                }
                if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
                    const content = summarizeCodexToolCall(payload);
                    if (!content) continue;
                    records.push({
                        ts: new Date(receivedAt).toISOString(),
                        receivedAt,
                        role: 'assistant',
                        content,
                        kind: 'tool',
                        senderName: 'Tool',
                        agent: 'codex-cli',
                        historySessionId: ref.sessionId,
                    });
                    continue;
                }
                if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
                    const content = codexToolOutputContent(payload);
                    if (!content) continue;
                    records.push({
                        ts: new Date(receivedAt).toISOString(),
                        receivedAt,
                        role: 'assistant',
                        content,
                        kind: 'tool',
                        senderName: 'Tool',
                        agent: 'codex-cli',
                        historySessionId: ref.sessionId,
                    });
                }
            }
            return records;
        } catch {
            return null;
        }
    },

    readMessages({ sessionId, workspace }): NativeHistoryMessage[] | null {
        const ref = this.resolveSession({ sessionId, workspace });
        return ref ? this.readSessionRef(ref) : null;
    },
};
