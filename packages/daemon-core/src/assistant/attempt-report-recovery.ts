/** Rehydrate from existing attempt evidence; never persist bodies or select the session's latest tail. */
import type { Database } from 'better-sqlite3';
import type { TurnAttempt } from '../mesh/turn-ledger/types.js';
import type { Execute } from './assistant-project-ports.js';
import { isVisible, messageText } from './project-views.js';
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
export interface RecoveredAttemptReport { body: string | null; source: string; reason?: string }

export async function recoverAttemptReport(db: Database, attempt: TurnAttempt | null, meshId: string, sessionId: string, execute: Execute): Promise<RecoveredAttemptReport> {
    if (!attempt || attempt.scope !== 'plain' || attempt.sessionId !== sessionId || !attempt.terminal) return { body: null, source: 'unavailable', reason: 'exact_committed_attempt_not_found' };
    // Plain coordinator attempts legitimately have no meshId; caller must authorize the registry session/mesh.
    if (attempt.meshId && attempt.meshId !== meshId) return { body: null, source: 'unavailable', reason: 'attempt_mesh_mismatch' };
    const rows = db.prepare('SELECT event_id,session_id,generation,to_state,payload_json FROM turn_events WHERE attempt_id=? ORDER BY recorded_at DESC,event_id DESC LIMIT 128').all(attempt.attemptId) as Array<{ event_id: string; session_id: string; generation: number | null; to_state: string | null; payload_json: string }>;
    const own = rows.filter(row => row.session_id === sessionId && row.generation === attempt.generation);
    const terminal = own.find(row => row.to_state === attempt.terminal!.outcome);
    if (!terminal) return { body: null, source: 'unavailable', reason: 'original_terminal_evidence_unavailable' };
    const payloadOf = (row: typeof terminal | undefined) => {
        try { return row ? rec(JSON.parse(row.payload_json)) : null; } catch { return null; }
    };
    let payload = payloadOf(terminal);
    let evidence = rec(payload?.evidence);
    // A delayed/hold-expiry commit references the end that supplied its report. Never pick an earlier end by time.
    if (evidence?.kind !== 'turn_end') {
        const notify = own.find(row => row.event_id.startsWith(terminal.event_id + '#notify:'));
        const textEventId = payloadOf(notify)?.textEventId;
        const original = typeof textEventId === 'string' ? own.find(row => row.event_id === textEventId) : undefined;
        payload = payloadOf(original); evidence = rec(payload?.evidence);
    }
    const envelope = rec(rec(payload?.local)?.envelope);
    if (typeof envelope?.finalSummary === 'string' && envelope.finalSummary) return { body: envelope.finalSummary, source: 'existing_attempt_envelope' };
    const anchors = new Set<number>();
    if (evidence?.kind === 'turn_end' && typeof evidence.messageAt === 'number') anchors.add(evidence.messageAt);
    if (anchors.size !== 1) return { body: null, source: 'unavailable', reason: 'no_unique_original_native_bubble_reference' };
    const at = [...anchors][0];
    if (at < attempt.acceptedAt || at > attempt.terminal.at) return { body: null, source: 'unavailable', reason: 'native_reference_outside_attempt' };
    const match = (chat: Record<string, unknown>): string | null => {
        const matches = (Array.isArray(chat.messages) ? chat.messages : []).filter(m => {
            const r = rec(m); const timestamp = typeof r?.timestamp === 'number' ? r.timestamp : Date.parse(String(r?.timestamp ?? ''));
            return isVisible(m) && r?.role !== 'user' && timestamp === at;
        });
        return matches.length === 1 ? messageText(matches[0]) || null : null;
    };
    const chat = await execute('read_chat', { targetSessionId: sessionId, limit: 200 });
    if (chat.success) { const body = match(chat); if (body) return { body, source: 'exact_native_bubble' }; }
    for (let offset = 0; offset < 400; offset += 100) {
        const history = await execute('chat_history', { targetSessionId: sessionId, offset, limit: 100, excludeRecentCount: 0 });
        if (!history.success) break;
        const body = match(history); if (body) return { body, source: 'exact_native_history_bubble' };
        if (history.hasMore !== true) break;
    }
    return { body: null, source: 'unavailable', reason: 'original_native_bubble_unavailable' };
}
