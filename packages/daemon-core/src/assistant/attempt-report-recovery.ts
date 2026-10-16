/** Recover an exact durable capture or existing attempt evidence; never select the latest tail. */
import { createHash } from 'node:crypto';
import { SqliteAssistantRelayStore } from './assistant-relay-sqlite-store.js';
import type { Database } from 'better-sqlite3';
import type { TurnAttempt } from '../mesh/turn-ledger/types.js';
import type { Execute } from './assistant-project-ports.js';
import { isVisible, messageText } from './project-views.js';
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
export interface ExactAttemptReportReference {
    version: 1; attemptId: string; coordinatorSessionId: string; generation: number; evidenceRef: string;
}
export interface RecoveredAttemptReport { body: string | null; source: string; reason?: string; provenance?: ExactAttemptReportReference }

export async function recoverAttemptReport(db: Database, attempt: TurnAttempt | null, meshId: string, sessionId: string, execute: Execute): Promise<RecoveredAttemptReport> {
    if (!attempt || attempt.scope !== 'plain' || attempt.sessionId !== sessionId || !attempt.terminal) return { body: null, source: 'unavailable', reason: 'exact_committed_attempt_not_found' };
    // Plain coordinator attempts legitimately have no meshId; caller must authorize the registry session/mesh.
    if (attempt.meshId && attempt.meshId !== meshId) return { body: null, source: 'unavailable', reason: 'attempt_mesh_mismatch' };
    const rows = db.prepare('SELECT event_id,session_id,generation,to_state,payload_json FROM turn_events WHERE attempt_id=? ORDER BY recorded_at DESC,event_id DESC LIMIT 128').all(attempt.attemptId) as Array<{ event_id: string; session_id: string; generation: number | null; to_state: string | null; payload_json: string }>;
    const own = rows.filter(row => row.session_id === sessionId && row.generation === attempt.generation);
    const terminals = own.filter(row => row.to_state === attempt.terminal!.outcome);
    if (terminals.length !== 1) return { body: null, source: 'unavailable', reason: 'original_terminal_evidence_unavailable' };
    const terminal = terminals[0]!;
    let sourceEvent = terminal;
    const payloadOf = (row: typeof terminal | undefined) => {
        try { return row ? rec(JSON.parse(row.payload_json)) : null; } catch { return null; }
    };
    let payload = payloadOf(terminal);
    let evidence = rec(payload?.evidence);
    const isNativeReference = (e: Record<string, unknown> | null) => e?.kind === 'turn_end' || e?.kind === 'transcript_final';
    // Actual native producers emit transcript_final; hold-expiry terminals may
    // instead reference that event through their exact notify textEventId.
    // A direct committed envelope is already attached to this exact terminal.
    const directEnvelope = rec(rec(payload?.local)?.envelope);
    if (!isNativeReference(evidence) && !(typeof directEnvelope?.finalSummary === 'string' && directEnvelope.finalSummary)) {
        const notifications = own.filter(row => row.event_id.startsWith(terminal.event_id + '#notify:'));
        if (notifications.length !== 1) return { body: null, source: 'unavailable', reason: 'no_unique_original_native_bubble_reference' };
        const notify = notifications[0];
        const textEventId = payloadOf(notify)?.textEventId;
        const originals = typeof textEventId === 'string' ? own.filter(row => row.event_id === textEventId) : [];
        if (originals.length !== 1) return { body: null, source: 'unavailable', reason: 'no_unique_original_native_bubble_reference' };
        sourceEvent = originals[0]!;
        payload = payloadOf(sourceEvent); evidence = rec(payload?.evidence);
    }
    // The key binds an independently verified terminal/generation and its exact
    // referenced source evidence. Old session-tail captures have no such provenance.
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const evidenceRef = JSON.stringify([1, attempt.generation, attempt.terminal.at, terminal.event_id,
        hash(terminal.payload_json), sourceEvent.event_id, hash(sourceEvent.payload_json)]);
    const provenance: ExactAttemptReportReference = { version: 1, attemptId: attempt.attemptId,
        coordinatorSessionId: sessionId, generation: attempt.generation, evidenceRef };
    const store = new SqliteAssistantRelayStore(db);
    const capture = (body: string, source: string): RecoveredAttemptReport => {
        store.captureAttemptBody(attempt.attemptId, meshId, sessionId, body, Date.now(), evidenceRef);
        return { body, source, provenance };
    };
    const envelope = rec(rec(payload?.local)?.envelope);
    if (typeof envelope?.finalSummary === 'string' && envelope.finalSummary) return capture(envelope.finalSummary, 'existing_attempt_envelope');
    const anchors = new Set<number>();
    if (isNativeReference(evidence) && typeof evidence?.messageAt === 'number') anchors.add(evidence.messageAt);
    if (anchors.size !== 1) return { body: null, source: 'unavailable', reason: 'no_unique_original_native_bubble_reference' };
    const at = [...anchors][0];
    if (at < attempt.acceptedAt || at > attempt.terminal.at) return { body: null, source: 'unavailable', reason: 'native_reference_outside_attempt' };
    const captured = store.readAttemptBody(attempt.attemptId, meshId, sessionId, Date.now(), evidenceRef);
    if (captured) return { body: captured, source: 'durable_attempt_capture', provenance };
    let ambiguous = false;
    const match = (chat: Record<string, unknown>): string | null => {
        const matches = (Array.isArray(chat.messages) ? chat.messages : []).filter(m => {
            const r = rec(m); const timestamp = typeof r?.timestamp === 'number' ? r.timestamp : Date.parse(String(r?.timestamp ?? ''));
            return isVisible(m) && ['assistant', 'agent'].includes(String(r?.role).toLowerCase()) && timestamp === at;
        });
        if (matches.length > 1) ambiguous = true;
        return matches.length === 1 ? messageText(matches[0]) || null : null;
    };
    const chat = await execute('read_chat', { targetSessionId: sessionId, limit: 200 });
    if (chat.success) {
        const body = match(chat);
        if (ambiguous) return { body: null, source: 'unavailable', reason: 'ambiguous_original_native_bubble' };
        if (body) return capture(body, 'exact_native_bubble');
    }
    for (let offset = 0; offset < 400; offset += 100) {
        const history = await execute('chat_history', { targetSessionId: sessionId, offset, limit: 100, excludeRecentCount: 0 });
        if (!history.success) break;
        const body = match(history);
        if (ambiguous) return { body: null, source: 'unavailable', reason: 'ambiguous_original_native_bubble' };
        if (body) return capture(body, 'exact_native_history_bubble');
        if (history.hasMore !== true) break;
    }
    return { body: null, source: 'unavailable', reason: 'original_native_bubble_unavailable' };
}
