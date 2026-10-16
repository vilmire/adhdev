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
    type EventRow = { event_id: string; session_id: string; generation: number | null; kind: string; source: string;
        verdict: string; from_state: string | null; to_state: string | null; at_ms: number; payload_json: string };
    const payloadOf = (row: EventRow | undefined) => {
        try { return row ? rec(JSON.parse(row.payload_json)) : null; } catch { return null; }
    };
    // Recorded/rejected observations after completion also retain to_state. Only
    // an applied transition into a terminal state is a cause; the commit effect
    // is a separate row with the producer's deterministic cause#committed id.
    // Query transitions directly so later observations cannot hide the cause.
    // Three rows already prove ambiguity; bound the read without selecting a
    // preferred cause from competing transitions.
    const rows = db.prepare(`SELECT * FROM turn_events WHERE attempt_id=? AND
        (kind='committed' OR (verdict='applied' AND to_state IN ('completed','failed','cancelled')
        AND from_state NOT IN ('completed','failed','cancelled'))) LIMIT 3`)
        .all(attempt.attemptId) as EventRow[];
    const causes = rows.filter(row => row.kind !== 'committed');
    const commits = rows.filter(row => row.kind === 'committed');
    if (causes.length !== 1 || commits.length !== 1) return { body: null, source: 'unavailable', reason: 'original_terminal_evidence_unavailable' };
    const terminal = causes[0]!, committed = commits[0]!;
    const owns = (row: EventRow) => row.session_id === sessionId && row.generation === attempt.generation;
    const commitPayload = payloadOf(committed);
    let payload = payloadOf(terminal);
    let evidence = rec(payload?.evidence);
    const matchesEvidence = (row: EventRow, e: Record<string, unknown> | null) => {
        const ref = rec(e?.attemptRef);
        return owns(row) && e?.eventId === row.event_id && e?.kind === row.kind && e?.sessionId === sessionId
            && e?.at === row.at_ms && (!ref || (ref.attemptId === attempt.attemptId && ref.generation === attempt.generation));
    };
    if (!matchesEvidence(terminal, evidence) || !owns(committed)
        || terminal.to_state !== attempt.terminal.outcome || terminal.at_ms !== attempt.terminal.at
        || committed.event_id !== terminal.event_id + '#committed' || committed.verdict !== 'applied'
        || committed.from_state !== null || committed.source !== terminal.source
        || committed.to_state !== attempt.terminal.outcome || committed.at_ms !== terminal.at_ms
        || commitPayload?.outcome !== attempt.terminal.outcome || commitPayload?.reason !== attempt.terminal.reason
        || commitPayload?.strength !== attempt.terminal.strength || evidence?.source !== attempt.terminal.source) {
        return { body: null, source: 'unavailable', reason: 'original_terminal_evidence_unavailable' };
    }
    let sourceEvent = terminal;
    const isNativeReference = (e: Record<string, unknown> | null) => e?.kind === 'turn_end' || e?.kind === 'transcript_final';
    const directEnvelope = rec(rec(payload?.local)?.envelope);
    if (!isNativeReference(evidence) && !(typeof directEnvelope?.finalSummary === 'string' && directEnvelope.finalSummary)) {
        // Plain scope never emits notify rows. The resolved hold retains the
        // exact opener pointer used by the reducer, bound to this generation.
        const hold = evidence?.kind === 'hold_expired' && typeof evidence.holdId === 'string'
            && ['weak_candidate', 'await_report', 'await_end'].includes(String(evidence.reason))
            ? db.prepare(`SELECT * FROM turn_holds WHERE hold_id=? AND attempt_id=? AND generation=?
                AND reason=? AND status='resolved' AND until_ms<=?`)
                .get(evidence.holdId, attempt.attemptId, attempt.generation, evidence.reason, terminal.at_ms) as { data_json: string } | undefined
            : undefined;
        let textEventId: unknown;
        try { textEventId = hold ? rec(JSON.parse(hold.data_json))?.textEventId : undefined; } catch { /* unavailable */ }
        const original = typeof textEventId === 'string'
            ? db.prepare('SELECT * FROM turn_events WHERE event_id=? AND attempt_id=?').get(textEventId, attempt.attemptId) as EventRow | undefined
            : undefined;
        const originalPayload = payloadOf(original), originalEvidence = rec(originalPayload?.evidence);
        if (!original || !matchesEvidence(original, originalEvidence) || original.verdict !== 'applied'
            || !isNativeReference(originalEvidence) || original.at_ms > terminal.at_ms) {
            return { body: null, source: 'unavailable', reason: 'no_unique_original_native_bubble_reference' };
        }
        sourceEvent = original; payload = originalPayload; evidence = originalEvidence;
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
