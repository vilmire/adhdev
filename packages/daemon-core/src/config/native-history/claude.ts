import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NativeHistoryAdapter, NativeHistoryMessage, NativeHistorySessionRef } from './types.js';
import { extractTimestampValue, isPathInside, isSafeNativeHistorySessionId, listFilesRecursive, normalizeHistorySessionId, resolvePathInside, statMtimeMs } from './shared.js';

export function resolveClaudeProjectTranscriptPath(historySessionId: string, workspace?: string): string | null {
    const normalizedSessionId = normalizeHistorySessionId(historySessionId);
    if (!isSafeNativeHistorySessionId(normalizedSessionId)) return null;
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeProjectsDir)) return null;
    const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
    if (normalizedWorkspace) {
        const workspaceDir = normalizedWorkspace.replace(/[\\/]/g, '-');
        const directPath = resolvePathInside(claudeProjectsDir, workspaceDir, `${normalizedSessionId}.jsonl`);
        if (directPath && fs.existsSync(directPath)) return directPath;
    }
    const matches = listFilesRecursive(
        claudeProjectsDir,
        (_entryPath, entry) => entry.isFile() && entry.name === `${normalizedSessionId}.jsonl`,
    );
    return matches[0] || null;
}

function extractClaudeAssistantContentParts(content: unknown): Array<{ content: string; kind: 'standard' | 'tool'; senderName?: string }> {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        return trimmed ? [{ content: trimmed, kind: 'standard' }] : [];
    }
    if (!Array.isArray(content)) return [];
    const parts: Array<{ content: string; kind: 'standard' | 'tool'; senderName?: string }> = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        const type = String(record.type || '').trim();
        if (type === 'text') {
            const text = String(record.text || '').trim();
            if (text) parts.push({ content: text, kind: 'standard' });
            continue;
        }
        if (type === 'tool_use') {
            const name = String(record.name || '').trim() || 'Tool';
            const input = record.input && typeof record.input === 'object'
                ? record.input as Record<string, unknown>
                : null;
            const command = input ? String(input.command || '').trim() : '';
            const summary = command ? `${name}: ${command}` : name;
            if (summary) parts.push({ content: summary, kind: 'tool', senderName: 'Tool' });
        }
    }
    return parts;
}

function extractClaudeUserContentParts(content: unknown): Array<{ role: 'user' | 'assistant'; content: string; kind: 'standard' | 'tool'; senderName?: string }> {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        return trimmed ? [{ role: 'user', content: trimmed, kind: 'standard' }] : [];
    }
    if (!Array.isArray(content)) return [];
    const parts: Array<{ role: 'user' | 'assistant'; content: string; kind: 'standard' | 'tool'; senderName?: string }> = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        const type = String(record.type || '').trim();
        if (type === 'text') {
            const text = String(record.text || '').trim();
            if (text) parts.push({ role: 'user', content: text, kind: 'standard' });
            continue;
        }
        if (type === 'tool_result') {
            const rawContent = record.content;
            const text = typeof rawContent === 'string'
                ? rawContent.trim()
                : Array.isArray(rawContent)
                    ? rawContent
                        .map((entry) => {
                            if (typeof entry === 'string') return entry.trim();
                            if (!entry || typeof entry !== 'object') return '';
                            const nested = entry as Record<string, unknown>;
                            if (typeof nested.text === 'string') return nested.text.trim();
                            if (typeof nested.content === 'string') return nested.content.trim();
                            return '';
                        })
                        .filter(Boolean)
                        .join('\n')
                : '';
            if (text) parts.push({ role: 'assistant', content: text, kind: 'tool', senderName: 'Tool' });
        }
    }
    return parts;
}

export const claudeNativeHistoryAdapter: NativeHistoryAdapter = {
    providerType: 'claude-cli',
    format: 'claude-jsonl',

    resolveSession({ sessionId, workspace }): NativeHistorySessionRef | null {
        const normalizedSessionId = normalizeHistorySessionId(sessionId);
        if (!isSafeNativeHistorySessionId(normalizedSessionId)) return null;
        const sourcePath = resolveClaudeProjectTranscriptPath(normalizedSessionId, workspace);
        if (!sourcePath) return null;
        return { sessionId: normalizedSessionId, sourcePath, sourceMtimeMs: statMtimeMs(sourcePath), workspace };
    },

    listSessionRefs(): NativeHistorySessionRef[] {
        const root = path.join(os.homedir(), '.claude', 'projects');
        return listFilesRecursive(root, (_entryPath, entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map((sourcePath) => {
                const sessionId = path.basename(sourcePath, '.jsonl');
                if (!isSafeNativeHistorySessionId(sessionId)) return null;
                return {
                    sessionId,
                    sourcePath,
                    sourceMtimeMs: statMtimeMs(sourcePath),
                } satisfies NativeHistorySessionRef;
            })
            .filter(Boolean) as NativeHistorySessionRef[];
    },

    readSessionRef(ref): NativeHistoryMessage[] | null {
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        if (!isSafeNativeHistorySessionId(ref.sessionId) || !isPathInside(claudeProjectsDir, ref.sourcePath)) return null;
        if (path.basename(ref.sourcePath) !== `${ref.sessionId}.jsonl`) return null;
        try {
            const lines = fs.readFileSync(ref.sourcePath, 'utf-8').split('\n').filter(Boolean);
            const records: NativeHistoryMessage[] = [];
            let fallbackTs = Date.now();
            for (const line of lines) {
                let parsed: Record<string, unknown> | null = null;
                try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { parsed = null; }
                if (!parsed) continue;
                const parsedSessionId = String(parsed.sessionId || '').trim();
                if (parsedSessionId && parsedSessionId !== ref.sessionId) continue;
                const receivedAt = extractTimestampValue(parsed.timestamp) || fallbackTs;
                fallbackTs = receivedAt + 1;
                const parsedWorkspace = String(parsed.cwd || ref.workspace || '').trim();
                if (records.length === 0 && parsedWorkspace) {
                    records.push({
                        ts: new Date(receivedAt).toISOString(),
                        receivedAt,
                        role: 'system',
                        kind: 'session_start',
                        content: parsedWorkspace,
                        agent: 'claude-cli',
                        historySessionId: ref.sessionId,
                        workspace: parsedWorkspace,
                    });
                }
                const type = String(parsed.type || '').trim();
                const message = parsed.message && typeof parsed.message === 'object'
                    ? parsed.message as Record<string, unknown>
                    : null;
                if (type === 'user' && message) {
                    for (const part of extractClaudeUserContentParts(message.content)) {
                        records.push({
                            ts: new Date(receivedAt).toISOString(),
                            receivedAt,
                            role: part.role,
                            content: part.content,
                            kind: part.kind,
                            senderName: part.senderName,
                            agent: 'claude-cli',
                            historySessionId: ref.sessionId,
                        });
                    }
                    continue;
                }
                if (type === 'assistant' && message) {
                    for (const part of extractClaudeAssistantContentParts(message.content)) {
                        records.push({
                            ts: new Date(receivedAt).toISOString(),
                            receivedAt,
                            role: 'assistant',
                            content: part.content,
                            kind: part.kind,
                            senderName: part.senderName,
                            agent: 'claude-cli',
                            historySessionId: ref.sessionId,
                        });
                    }
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
