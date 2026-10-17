/**
 * List native coordinator finals for the relay's missing-reply detector.
 * Classification (no_attempt / inside_attempt / restart_closed) stays in
 * `AssistantRelay.tick` — this module only pairs bubbles with attempt windows.
 */
import type { Database } from 'better-sqlite3';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';
import { standardAssistantBubble } from './assistant-native-window.js';

type Execute = (command: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface AttemptSpan {
    attempt_id: string;
    accepted_at: number;
    terminal_at: number | null;
    terminal_reason: string | null;
    terminal_source: string | null;
    state: string;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const SESSION_CAP = 20;
const LOOKBACK_MS = 120_000;

function restartClosed(row: AttemptSpan): boolean {
    return row.terminal_reason === 'session_error' && row.terminal_source === 'session_registry';
}

export async function collectCoordinatorReplies(opts: {
    db: Database;
    execute: Execute;
    sinceMs: number;
    now: number;
}): Promise<AuditedCoordinatorReply[]> {
    const since = opts.sinceMs - LOOKBACK_MS;
    let sessions: Array<{ session_id: string }>;
    try {
        sessions = opts.db.prepare(`
        SELECT session_id FROM (
            SELECT session_id, MAX(COALESCE(terminal_at, last_activity_at, accepted_at)) AS seen
            FROM turn_attempts
            WHERE scope='plain' AND COALESCE(terminal_at, last_activity_at, accepted_at) >= ?
            GROUP BY session_id
            UNION
            SELECT coordinator_session_id AS session_id, MAX(committed_at) AS seen
            FROM assistant_relays WHERE committed_at >= ? GROUP BY coordinator_session_id
        ) ORDER BY seen DESC LIMIT ?
    `).all(since, since, SESSION_CAP) as Array<{ session_id: string }>;
    } catch {
        return [];
    }
    const out: AuditedCoordinatorReply[] = [];
    for (const { session_id: sessionId } of sessions) {
        if (!sessionId) continue;
        const attempts = opts.db.prepare(`
            SELECT attempt_id, accepted_at, terminal_at, terminal_reason, terminal_source, state
            FROM turn_attempts WHERE session_id=? AND scope='plain'
        `).all(sessionId) as AttemptSpan[];
        let chat: Record<string, unknown>;
        try {
            chat = await opts.execute('read_chat', { targetSessionId: sessionId, limit: 200 });
        } catch {
            continue;
        }
        if (!chat?.success || !Array.isArray(chat.messages)) continue;
        for (const m of chat.messages) {
            const bubble = standardAssistantBubble(m);
            if (!bubble || bubble.at < opts.sinceMs) continue;
            const containing = attempts.filter((a) => bubble.at >= a.accepted_at - 1000 && bubble.at <= (a.terminal_at ?? opts.now));
            containing.sort((a, b) => b.accepted_at - a.accepted_at);
            const attempt = containing[0];
            const open = !!attempt && !TERMINAL.has(attempt.state);
            out.push({
                sessionId,
                messageAt: bubble.at,
                chars: Array.from(bubble.text).length,
                text: bubble.text,
                attemptId: attempt?.attempt_id ?? null,
                ...(open ? { attemptOpen: true } : {}),
                ...(attempt && restartClosed(attempt) ? { restartClosed: true } : {}),
            });
        }
    }
    return out;
}
