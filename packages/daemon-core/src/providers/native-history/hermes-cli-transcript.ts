/**
 * Hermes Agent — native history adapter.
 *
 * Hermes persists state in ~/.hermes/state.db (SQLite, better-sqlite3):
 *   sessions(id, source, started_at, ended_at, message_count, ...)
 *   messages(id, session_id, role, content, timestamp, ...)
 *
 * Earlier releases dumped per-session JSON files under ~/.hermes/sessions/;
 * recent hermes (≥ 0.14) writes only to state.db. We read straight from
 * the db when available and fall back to scanning legacy JSON dumps for
 * archived sessions.
 *
 * The dispatcher hands us a sourcePath (the file the resolveHermesPath
 * function picks). For the SQLite case the "path" is the db file itself
 * and we resolve the most recent cli-source session inside readSession.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';

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

const HERMES_STATE_DB = path.join(os.homedir(), '.hermes', 'state.db');
const HERMES_LEGACY_SESSIONS_DIR = path.join(os.homedir(), '.hermes', 'sessions');

function statMtimeMs(p: string): number {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
}

function openDb(): any | null {
    if (!fs.existsSync(HERMES_STATE_DB)) return null;
    try {
        const Database = loadBetterSqlite3();
        return new Database(HERMES_STATE_DB, { readonly: true, fileMustExist: true });
    } catch {
        return null;
    }
}

function loadMessagesForSession(db: any, sessionId: string): NativeHistoryMessage[] {
    const rows: any[] = db.prepare(
        `SELECT id, role, content, timestamp
         FROM messages
         WHERE session_id = ? AND content IS NOT NULL AND content != ''
         ORDER BY timestamp ASC, id ASC`,
    ).all(sessionId);
    const out: NativeHistoryMessage[] = [];
    for (const r of rows) {
        const role = normalizeHermesRole(r.role);
        // Hermes stores some tool/system rows under role='tool'; surface as
        // 'assistant' so they don't get dropped on the daemon's chat schema
        // validation (role must be user/assistant/system).
        out.push({
            id: String(r.id),
            role,
            content: String(r.content),
            receivedAt: Math.floor(Number(r.timestamp) * 1000),
            kind: 'standard',
        });
    }
    return out;
}

export function readSession(sessionPath: string): NativeHistorySession | null {
    if (!sessionPath) return null;

    // Path mode A: SQLite — sourcePath is the state.db path. Pick the
    // newest source='cli' session that has at least one persisted message.
    if (sessionPath === HERMES_STATE_DB) {
        const db = openDb();
        if (!db) return null;
        try {
            const row: any = db.prepare(
                `SELECT id, started_at FROM sessions
                 WHERE source = 'cli' AND message_count > 0
                 ORDER BY started_at DESC LIMIT 1`,
            ).get();
            if (!row) return null;
            const messages = loadMessagesForSession(db, row.id);
            if (messages.length === 0) return null;
            return {
                messages,
                providerSessionId: String(row.id),
                source: 'provider-native',
                sourcePath: sessionPath,
                sourceMtimeMs: statMtimeMs(sessionPath),
                nativeHistoryCoverage: 'full',
            };
        } finally {
            try { db.close(); } catch { /* ignore */ }
        }
    }

    // Path mode B: legacy JSON dump — keep the old reader for archived
    // sessions that pre-date the db format.
    if (!path.isAbsolute(sessionPath) || !fs.existsSync(sessionPath)) return null;
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
    if (rawMessages.length === 0) return null;
    const sourceMtimeMs = statMtimeMs(sessionPath);
    const sessionStart = Number(raw.session_start) || sourceMtimeMs - rawMessages.length * 1000;
    const messages: NativeHistoryMessage[] = [];
    for (let i = 0; i < rawMessages.length; i += 1) {
        const m = rawMessages[i];
        const content = typeof m?.content === 'string' ? m.content : '';
        if (!content) continue;
        messages.push({
            id: typeof m?.id === 'string' ? m.id : `msg_${i}`,
            role: normalizeHermesRole(m?.role),
            content,
            receivedAt: sessionStart + i * 1000,
            kind: 'standard',
        });
    }
    if (messages.length === 0) return null;
    const sessionId = typeof raw.session_id === 'string' && raw.session_id
        ? raw.session_id
        : path.basename(sessionPath, '.json').replace(/^session_/, '');
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
    const out: NativeHistorySessionMeta[] = [];

    const db = openDb();
    if (db) {
        try {
            const rows: any[] = db.prepare(
                `SELECT id, started_at, ended_at, message_count, title
                 FROM sessions
                 WHERE source = 'cli' AND message_count > 0
                 ORDER BY started_at DESC LIMIT 100`,
            ).all();
            const mtime = statMtimeMs(HERMES_STATE_DB);
            for (const r of rows) {
                out.push({
                    historySessionId: String(r.id),
                    sessionId: String(r.id),
                    sourcePath: HERMES_STATE_DB,
                    sourceMtimeMs: mtime,
                    messageCount: Number(r.message_count) || 0,
                    firstMessageAt: Math.floor(Number(r.started_at) * 1000),
                    lastMessageAt: Math.floor(Number(r.ended_at || r.started_at) * 1000),
                    sessionTitle: typeof r.title === 'string' ? r.title : undefined,
                });
            }
        } finally {
            try { db.close(); } catch { /* ignore */ }
        }
    }

    if (fs.existsSync(HERMES_LEGACY_SESSIONS_DIR)) {
        for (const name of fs.readdirSync(HERMES_LEGACY_SESSIONS_DIR)) {
            if (!/^session_.*\.json$/.test(name)) continue;
            const p = path.join(HERMES_LEGACY_SESSIONS_DIR, name);
            const mtime = statMtimeMs(p);
            if (!mtime) continue;
            let raw: any;
            try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
            const msgs = Array.isArray(raw?.messages) ? raw.messages : [];
            if (msgs.length === 0) continue;
            const sessionId = typeof raw.session_id === 'string' && raw.session_id
                ? raw.session_id
                : name.replace(/^session_/, '').replace(/\.json$/, '');
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
