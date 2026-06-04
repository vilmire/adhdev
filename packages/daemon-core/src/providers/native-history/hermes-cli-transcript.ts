/**
 * Hermes Agent — native history adapter.
 *
 * Hermes persists each chat session as a single JSON object under
 *   ~/.hermes/sessions/session_<timestamp>_<id>.json
 *
 * Each file holds:
 *   {
 *     session_id, model, base_url, ...,
 *     messages: [{ role, content, reasoning?, ... }]
 *   }
 *
 * Hermes only flushes the file on session close (mid-session it lives in
 * RAM), so this reader is mostly useful for resume — it picks up the
 * latest persisted state when an existing session restarts.
 *
 * Same shape as claude-cli/codex-cli/antigravity-cli transcripts so the
 * dispatcher and chat-history pipeline don't branch.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface NativeHistoryMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    receivedAt: number;
    kind?: string;
}

export interface NativeHistorySession {
    messages: NativeHistoryMessage[];
    providerSessionId: string;
    source: 'provider-native';
    sourcePath: string;
    sourceMtimeMs: number;
    nativeHistoryCoverage: 'full';
    workspace?: string;
}

export interface NativeHistorySessionMeta {
    historySessionId: string;
    sessionId: string;
    sourcePath: string;
    sourceMtimeMs: number;
    messageCount: number;
    firstMessageAt: number;
    lastMessageAt: number;
    sessionTitle?: string;
    preview?: string;
    workspace?: string;
}

const HERMES_SESSIONS_DIR = path.join(os.homedir(), '.hermes', 'sessions');

function statMtimeMs(p: string): number {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
}

function safeSessionIdFromBasename(basename: string): string {
    // session_<ts>_<id>.json → <ts>_<id>
    const stripped = basename.replace(/^session_/, '').replace(/\.json$/, '');
    return stripped || basename;
}

export function readSession(sessionPath: string): NativeHistorySession | null {
    if (!sessionPath || !path.isAbsolute(sessionPath)) return null;
    if (!fs.existsSync(sessionPath)) return null;

    let raw: any;
    try {
        raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;

    const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
    if (rawMessages.length === 0) return null;

    const sourceMtimeMs = statMtimeMs(sessionPath);
    const sessionStart = Number(raw.session_start) || sourceMtimeMs - rawMessages.length * 1000;

    const messages: NativeHistoryMessage[] = [];
    for (let i = 0; i < rawMessages.length; i += 1) {
        const m = rawMessages[i];
        const content = typeof m?.content === 'string' ? m.content : '';
        if (!content) continue; // hermes assistant rows often carry only `reasoning`
        const role = normalizeHermesRole(m?.role);
        messages.push({
            id: typeof m?.id === 'string' ? m.id : `msg_${i}`,
            role,
            content,
            receivedAt: sessionStart + i * 1000,
            kind: 'standard',
        });
    }
    if (messages.length === 0) return null;

    const sessionId = typeof raw.session_id === 'string' && raw.session_id
        ? raw.session_id
        : safeSessionIdFromBasename(path.basename(sessionPath));

    return {
        messages,
        providerSessionId: sessionId,
        source: 'provider-native',
        sourcePath: sessionPath,
        sourceMtimeMs,
        nativeHistoryCoverage: 'full',
    };
}

export async function listSessions(_watchPath: string): Promise<NativeHistorySessionMeta[]> {
    if (!fs.existsSync(HERMES_SESSIONS_DIR)) return [];
    const out: NativeHistorySessionMeta[] = [];
    for (const name of fs.readdirSync(HERMES_SESSIONS_DIR)) {
        if (!/^session_.*\.json$/.test(name)) continue;
        const p = path.join(HERMES_SESSIONS_DIR, name);
        const mtime = statMtimeMs(p);
        if (!mtime) continue;
        let raw: any;
        try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
        const msgs = Array.isArray(raw?.messages) ? raw.messages : [];
        if (msgs.length === 0) continue;
        const sessionId = typeof raw.session_id === 'string' && raw.session_id
            ? raw.session_id
            : safeSessionIdFromBasename(name);
        out.push({
            historySessionId: sessionId,
            sessionId,
            sourcePath: p,
            sourceMtimeMs: mtime,
            messageCount: msgs.length,
            firstMessageAt: Number(raw.session_start) || mtime,
            lastMessageAt: Number(raw.last_updated) || mtime,
            sessionTitle: typeof raw.title === 'string' ? raw.title : undefined,
            preview: typeof msgs[0]?.content === 'string' ? String(msgs[0].content).slice(0, 80) : undefined,
        });
    }
    out.sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs);
    return out;
}

function normalizeHermesRole(r: any): 'user' | 'assistant' | 'system' {
    const s = String(r ?? '').toLowerCase();
    if (s === 'user' || s === 'human') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'model') return 'assistant';
    if (s === 'tool' || s === 'tool_result' || s === 'function') return 'assistant';
    return 'system';
}
