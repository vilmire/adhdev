/** Recover an exact native window or, failing that, an unverified envelope. Never select the latest tail. */
import { createHash } from 'node:crypto';
import { SqliteAssistantRelayStore } from './assistant-relay-sqlite-store.js';
import type { Database } from 'better-sqlite3';
import type { TurnAttempt } from '../mesh/turn-ledger/types.js';
import type { Execute } from './assistant-project-ports.js';
import { LOG } from '../logging/logger.js';
import {
    envelopeIsNativePrefix, partsOf, renderNativeReplies, selectNativeWindow,
    type NativeReplyPart, type ReportCompleteness,
} from './assistant-native-window.js';
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
/** v2: rc16 rows pinned a truncated body under a v1 ref that the upsert would not replace. */
export const ATTEMPT_EVIDENCE_VERSION = 2;
export interface ExactAttemptReportReference {
    version: 2; attemptId: string; coordinatorSessionId: string; generation: number; evidenceRef: string;
}
export interface RecoveredAttemptReport {
    body: string | null;
    source: string;
    reason?: string;
    completeness?: ReportCompleteness;
    parts?: Array<{ at: number; chars: number }>;
    provenance?: ExactAttemptReportReference;
}

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
    // referenced source evidence. A parts hash makes a corrected native window
    // a different ref from the rc16 v1 row, so the upsert may replace it.
    // Old session-tail captures have no such provenance and are not read.
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const stable = [ATTEMPT_EVIDENCE_VERSION, attempt.generation, attempt.terminal.at, terminal.event_id,
        hash(terminal.payload_json), sourceEvent.event_id, hash(sourceEvent.payload_json)];
    const store = new SqliteAssistantRelayStore(db);
    const provenanceFor = (evidenceRef: string): ExactAttemptReportReference => ({
        version: ATTEMPT_EVIDENCE_VERSION, attemptId: attempt.attemptId,
        coordinatorSessionId: sessionId, generation: attempt.generation, evidenceRef,
    });
    const envelopeText = (() => {
        const envelope = rec(rec(payload?.local)?.envelope);
        return typeof envelope?.finalSummary === 'string' && envelope.finalSummary.trim() ? envelope.finalSummary : null;
    })();
    const windowStart = attempt.acceptedAt - 1000;
    const windowEnd = attempt.terminal.at;
    const pooled: unknown[] = [];
    const take = (messages: unknown): { ambiguous: boolean; bubbles: NativeReplyPart[] } => {
        if (Array.isArray(messages)) pooled.push(...messages);
        return selectNativeWindow(pooled, windowStart, windowEnd);
    };
    let selected: { ambiguous: boolean; bubbles: NativeReplyPart[] } = { ambiguous: false, bubbles: [] };
    let sawChat = false;
    const chat = await execute('read_chat', { targetSessionId: sessionId, limit: 200 });
    if (chat.success) {
        sawChat = true;
        selected = take(chat.messages);
        if (selected.ambiguous) return { body: null, source: 'unavailable', reason: 'ambiguous_original_native_bubble' };
    }
    if (!selected.bubbles.length && (!sawChat || chat.hasMore === true)) {
        for (let offset = 0; offset < 400; offset += 100) {
            const history = await execute('chat_history', { targetSessionId: sessionId, offset, limit: 100, excludeRecentCount: 0 });
            if (!history.success) break;
            sawChat = true;
            selected = take(history.messages);
            if (selected.ambiguous) return { body: null, source: 'unavailable', reason: 'ambiguous_original_native_bubble' };
            if (history.hasMore !== true) break;
        }
    }
    // messageAt anchor, kept beside the window: one bubble whose timestamp is
    // the evidence anchor. It does not override a non-empty window.
    let anchorOutside = false;
    let viaAnchor = false;
    if (!selected.bubbles.length && isNativeReference(evidence) && typeof evidence?.messageAt === 'number') {
        const at = evidence.messageAt;
        if (at < attempt.acceptedAt || at > attempt.terminal.at) anchorOutside = true;
        else {
            const anchored = selectNativeWindow(pooled, at, at);
            if (anchored.ambiguous) return { body: null, source: 'unavailable', reason: 'ambiguous_original_native_bubble' };
            if (anchored.bubbles.length === 1) { selected = anchored; viaAnchor = true; }
        }
    }
    const finishNative = (bubbles: NativeReplyPart[], source: string): RecoveredAttemptReport => {
        if (envelopeText && !envelopeIsNativePrefix(envelopeText, bubbles)) {
            LOG.warn('Assistant', `envelope_native_mismatch attempt=${attempt.attemptId} envelopeChars=${envelopeText.length} nativeChars=${bubbles.reduce((n, b) => n + b.chars, 0)}`);
        }
        const parts = partsOf(bubbles);
        const evidenceRef = JSON.stringify([...stable, hash(parts.map((p) => `${p.at}:${p.chars}`).join('|'))]);
        const body = renderNativeReplies(bubbles);
        store.captureAttemptBody(attempt.attemptId, meshId, sessionId, body, Date.now(), evidenceRef, { completeness: 'final_native', parts });
        return { body, source, completeness: 'final_native', parts, provenance: provenanceFor(evidenceRef) };
    };
    if (selected.bubbles.length) return finishNative(selected.bubbles, viaAnchor ? 'exact_native_bubble' : 'native_window');
    const durable = store.readVerifiedAttemptBody(attempt.attemptId, meshId, sessionId, Date.now(), JSON.stringify(stable));
    if (durable) return {
        body: durable.body, source: 'durable_attempt_capture', completeness: 'final_native',
        parts: durable.parts, provenance: provenanceFor(durable.evidenceRef),
    };
    // Unverified envelope is delivered flagged and is NOT stored as exact.
    if (envelopeText) return { body: envelopeText, source: 'existing_attempt_envelope', completeness: 'envelope_unverified', provenance: provenanceFor(JSON.stringify(stable)) };
    if (anchorOutside) return { body: null, source: 'unavailable', reason: 'native_reference_outside_attempt' };
    return { body: null, source: 'unavailable', reason: 'original_native_bubble_unavailable' };
}
