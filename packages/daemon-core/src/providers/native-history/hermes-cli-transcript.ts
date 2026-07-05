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

/**
 * Expand an anchor session id to every session id in its logical cluster.
 *
 * hermes ≥0.14 splits a SINGLE logical turn across several `sessions` rows
 * linked by `parent_session_id` (a 0-message intermediate row is common), and
 * the turn's final assistant message lands in a DIFFERENT row than the one the
 * daemon pins. A bidirectional walk — up the parent chain to the cluster root,
 * then down through every descendant — returns the complete set from ANY anchor
 * (root, middle, or leaf), mirroring the declarative executor's
 * `session_cluster_query`. Falls back to the anchor alone if the schema has no
 * `parent_session_id` column (older hermes) or the walk fails.
 */
function resolveClusterSessionIds(db: any, anchorId: string): string[] {
    if (!anchorId) return [];
    try {
        const rows: any[] = db.prepare(
            `WITH RECURSIVE
               up(id) AS (
                 SELECT id FROM sessions WHERE id = ?
                 UNION
                 SELECT s.parent_session_id FROM sessions s JOIN up ON s.id = up.id
                   WHERE s.parent_session_id IS NOT NULL
               ),
               cluster(id) AS (
                 SELECT id FROM up
                 UNION
                 SELECT s.id FROM sessions s JOIN cluster ON s.parent_session_id = cluster.id
               )
             SELECT id FROM cluster`,
        ).all(anchorId);
        const ids = new Set<string>([anchorId]);
        for (const r of rows) {
            if (r && r.id != null && String(r.id)) ids.add(String(r.id));
        }
        return Array.from(ids);
    } catch {
        // No parent_session_id column (older hermes) or a walk failure — the
        // single anchor is still a valid (degenerate) cluster.
        return [anchorId];
    }
}

function loadMessagesForSession(db: any, sessionId: string): NativeHistoryMessage[] {
    // Read the WHOLE sub-session cluster, not just the pinned anchor. hermes
    // ≥0.14 writes a turn's final assistant into a descendant sub-session row,
    // so an anchor-only read misses it → read_chat shows zero assistant bubbles
    // and the completion gate false-fires missing_final_assistant. Gather every
    // cluster member (parent-chain walk) and merge; the SQL `ORDER BY timestamp`
    // re-interleaves bubbles from different sub-sessions into true chronological
    // order so the final assistant lands last.
    const clusterIds = resolveClusterSessionIds(db, sessionId);
    if (clusterIds.length === 0) return [];
    const placeholders = clusterIds.map(() => '?').join(', ');
    // Assistant turns whose finish_reason='tool_calls' persist an EMPTY
    // `content` — their payload lives in the `tool_calls` column. Filtering on
    // `content != ''` alone drops those rows, so a turn whose terminal message
    // is a tool call surfaces zero assistant bubbles. Accept a row when either
    // `content` OR `tool_calls` is non-empty, and project `tool_calls` into the
    // content slot when `content` is empty so the bubble still carries text.
    const rows: any[] = db.prepare(
        `SELECT id, role, COALESCE(NULLIF(content, ''), tool_calls) AS content, timestamp
         FROM messages
         WHERE session_id IN (${placeholders})
           AND ((content IS NOT NULL AND content != '') OR (tool_calls IS NOT NULL AND tool_calls != ''))
         ORDER BY timestamp ASC, id ASC`,
    ).all(...clusterIds);
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

export function readSession(sessionPath: string, requestedSessionId?: string): NativeHistorySession | null {
    if (!sessionPath) return null;

    // Path mode A: SQLite — sourcePath is the state.db path.
    if (sessionPath === HERMES_STATE_DB) {
        const db = openDb();
        if (!db) return null;
        try {
            const pinned = String(requestedSessionId || '').trim();
            let sessionId: string;
            if (pinned) {
                // Session pin: the caller is already bound to a specific
                // provider session, so read THAT session directly instead of
                // the newest-wins pick below. hermes ≥0.14 writes a fresh
                // `sessions` row per internal sub-session, so an unpinned
                // `ORDER BY started_at DESC LIMIT 1` drifts to a different id
                // on every read → re-bind churn + reading completion evidence
                // from the wrong session. loadMessagesForSession returning
                // rows validates the id exists.
                sessionId = pinned;
            } else {
                // No bound id yet (discovery): pick the newest source='cli'
                // session that has at least one persisted message. Use an
                // EXISTS check against `messages` rather than the denormalized
                // `message_count` column — a freshly-started session already
                // has message rows while `message_count` (DEFAULT 0) can still
                // lag at 0, and the old predicate excluded exactly that
                // just-created session, resolving to nothing.
                const row: any = db.prepare(
                    `SELECT id, started_at FROM sessions
                     WHERE source = 'cli'
                       AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)
                     ORDER BY started_at DESC LIMIT 1`,
                ).get();
                if (!row) return null;
                sessionId = String(row.id);
            }
            const messages = loadMessagesForSession(db, sessionId);
            if (messages.length === 0) return null;
            return {
                messages,
                providerSessionId: sessionId,
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
                 WHERE source = 'cli'
                   AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)
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
