/** Recover an exact native window or, failing that, an unverified envelope. Never select the latest tail. */
import { createHash } from 'node:crypto';
import { SqliteAssistantRelayStore } from './assistant-relay-sqlite-store.js';
import { ATTEMPT_BODY_MAX_CHARS } from './assistant-relay-store.js';
import type { Database } from 'better-sqlite3';
import type { TurnAttempt } from '../mesh/turn-ledger/types.js';
import type { Execute } from './assistant-project-ports.js';
import { LOG } from '../logging/logger.js';
import { getCoordinatorForSession } from '../mesh/coordinator-registry.js';
import {
    formatReplyClock, partsOf, renderNativeReplies, selectNativeWindow, standardAssistantBubble,
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

const VERIFIED_WINDOW_REF = 'verified-native-window:';
const NATIVE_READ_BUDGET_MS = 2_000;
const TIMESTAMPED_PROVIDERS = new Set(['claude-cli', 'codex-cli', 'antigravity-cli', 'hermes-cli']);
type NativeExecute = (command: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Old v2 readers also pinned unproven windows. Version alone is insufficient. */
export function isVerifiedNativeEvidenceRef(reference: unknown, generation?: number): boolean {
    if (typeof reference !== 'string') return false;
    try {
        const parts: unknown = JSON.parse(reference);
        return Array.isArray(parts) && parts.length === 8 && parts[0] === ATTEMPT_EVIDENCE_VERSION
            && Number.isSafeInteger(parts[1]) && parts[1] >= 0 && (generation === undefined || parts[1] === generation)
            && Number.isSafeInteger(parts[2]) && Number.isFinite(new Date(parts[2]).getTime())
            && [parts[3], parts[5]].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512)
            && [parts[4], parts[6]].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
            && typeof parts[7] === 'string' && /^verified-native-window:[a-f0-9]{64}$/.test(parts[7]);
    } catch { return false; }
}

/** Verify that a host's exact-body claim actually binds this body and its parts. */
export function verifiedNativeReportParts(body: string, parts: unknown, reference: unknown, generation: number): NativeReplyPart[] | null {
    if (body.length > ATTEMPT_BODY_MAX_CHARS || !isVerifiedNativeEvidenceRef(reference, generation)
        || !Array.isArray(parts) || !parts.length || parts.length > 600) return null;
    const ref = JSON.parse(reference as string) as unknown[];
    const points = Array.from(body);
    const bubbles: NativeReplyPart[] = [];
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = rec(parts[i]);
        const at = part?.at, chars = part?.chars;
        if (typeof at !== 'number' || !Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())
            || at > Number(ref[2]) || (i > 0 && at <= bubbles[i - 1]!.at)
            || typeof chars !== 'number' || !Number.isSafeInteger(chars) || chars <= 0) return null;
        if (parts.length > 1) {
            const label = Array.from(`${i ? '\n\n' : ''}[reply ${i + 1}/${parts.length} · ${formatReplyClock(at)}]\n`);
            if (points.slice(offset, offset + label.length).join('') !== label.join('')) return null;
            offset += label.length;
        }
        const text = points.slice(offset, offset + chars).join(''); offset += chars;
        if (Array.from(text).length !== chars || text.trim() !== text) return null;
        bubbles.push({ at, chars, text });
    }
    if (offset !== points.length || renderNativeReplies(bubbles) !== body) return null;
    const digest = createHash('sha256').update(JSON.stringify(bubbles)).digest('hex');
    return ref[7] === VERIFIED_WINDOW_REF + digest ? bubbles : null;
}

/** A successful chat read may still contain the PTY parser's screen scrape. */
export function verifiedNativeRead(read: Record<string, unknown>, sessionId: string): boolean {
    const source = rec(read.messageSource) ?? rec(read.transcriptProvenance);
    const providers = [read.agent, rec(read.debugReadChat)?.provider, getCoordinatorForSession(sessionId)?.cliType]
        .filter((p): p is string => typeof p === 'string' && p.length > 0).map(p => p.toLowerCase());
    // Grok's receivedAt values are interpolated display positions, not wall-clock
    // evidence. Unknown providers need a clock/turn-boundary contract before use.
    if (!providers.length || providers.some(p => !TIMESTAMPED_PROVIDERS.has(p)) || new Set(providers).size !== 1) return false;
    if (read.success !== true || read.source === 'pty-parser') return false;
    if (source?.selected === 'pty-parser' && source.nativeOnlyContentPreserved !== true) return false;
    return read.source === 'provider-native' || source?.selected === 'native-history'
        || source?.nativeOnlyContentPreserved === true;
}

function finalized(message: unknown): boolean {
    const r = rec(message);
    return !!r && r.bubbleState === 'final' && r.isStreaming !== true && r.truncated !== true;
}

/** Bounded, source-checked paging. An exhausted/failed page never proves completeness. */
export async function readNativeWindow(execute: NativeExecute, sessionId: string, start: number, end: number) {
    const deadline = Date.now() + NATIVE_READ_BUDGET_MS;
    const messages: unknown[] = [];
    let providerIdle = false;
    let invalid = false;
    const request = async (command: string, args: Record<string, unknown>) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                Promise.resolve().then(() => execute(command, args)),
                new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); }),
            ]);
        } catch { return null; }
        finally { if (timer !== undefined) clearTimeout(timer); }
    };
    const take = (read: Record<string, unknown> | null): boolean => {
        if (!read || !verifiedNativeRead(read, sessionId) || !Array.isArray(read.messages)) return false;
        providerIdle ||= read.providerObservedStatus === 'idle';
        for (const message of read.messages) {
            const b = standardAssistantBubble(message);
            if (b && b.at >= start && b.at <= end && !finalized(message)) invalid = true;
        }
        messages.push(...read.messages);
        return true;
    };
    const result = (complete: boolean) => ({ ...selectNativeWindow(messages, start, end), complete: complete && !invalid, providerIdle });
    const chat = await request('read_chat', { targetSessionId: sessionId, tailLimit: 200 });
    if (take(chat)) {
        if (chat!.coverage === 'full' && chat!.hasMore !== true) return result(true);
    } else if (!chat) return result(false); // deadline/failure: do not launch a second hung request
    // Start at offset zero with no live-window exclusion. Overlap is deduplicated
    // by timestamp+text. A page older than the start proves lower-bound coverage.
    for (let offset = 0; offset < 400; offset += 100) {
        const history = await request('chat_history', { targetSessionId: sessionId, offset, limit: 100, excludeRecentCount: 0 });
        if (!take(history)) return result(false);
        const oldest = (history!.messages as unknown[]).map(standardAssistantBubble).filter(b => b !== null)
            .reduce((at, b) => Math.min(at, b.at), Infinity);
        if (history!.hasMore === false || oldest < start) return result(true);
    }
    return result(false);
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
    const windowStart = attempt.acceptedAt;
    const windowEnd = attempt.terminal.at;
    const selected = await readNativeWindow(execute, sessionId, windowStart, windowEnd);
    if (selected.ambiguous) return { body: null, source: 'unavailable', reason: 'ambiguous_original_native_bubble' };
    const anchor = typeof evidence?.messageAt === 'number' ? evidence.messageAt : null;
    const anchorOutside = anchor !== null && (anchor < windowStart || anchor > windowEnd);
    const last = selected.bubbles.at(-1);
    // A finalized intermediate is still only an intermediate. Native anchor
    // evidence must name the last bubble. An unanchored FSM end additionally
    // needs an independent provider-idle observation and matching last text.
    const terminalPresent = !anchorOutside && !!last && (anchor !== null ? last.at === anchor
        : selected.providerIdle && !!envelopeText && last.text.startsWith(envelopeText.trim()));
    const finishNative = (bubbles: NativeReplyPart[], source: string): RecoveredAttemptReport => {
        if (envelopeText && !bubbles.at(-1)?.text.startsWith(envelopeText.trim())) {
            LOG.warn('Assistant', `envelope_native_mismatch attempt=${attempt.attemptId} envelopeChars=${envelopeText.length} nativeChars=${bubbles.reduce((n, b) => n + b.chars, 0)}`);
        }
        const parts = partsOf(bubbles);
        const evidenceRef = JSON.stringify([...stable, VERIFIED_WINDOW_REF + hash(JSON.stringify(bubbles))]);
        const body = renderNativeReplies(bubbles);
        store.captureAttemptBody(attempt.attemptId, meshId, sessionId, body, Date.now(), evidenceRef, { completeness: 'final_native', parts });
        return { body, source, completeness: 'final_native', parts, provenance: provenanceFor(evidenceRef) };
    };
    if (selected.complete && terminalPresent) return finishNative(selected.bubbles, 'native_window');
    const durable = store.readVerifiedAttemptBody(attempt.attemptId, meshId, sessionId, Date.now(), JSON.stringify(stable));
    // Earlier v2 captures did not check native provenance, paging or finality.
    // They may be replaced, but cannot be read back as independently verified.
    if (durable && verifiedNativeReportParts(durable.body, durable.parts, durable.evidenceRef, attempt.generation)) return {
        body: durable.body, source: 'durable_attempt_capture', completeness: 'final_native',
        parts: durable.parts, provenance: provenanceFor(durable.evidenceRef),
    };
    // Unverified envelope is delivered flagged and is NOT stored as exact.
    if (envelopeText) return { body: envelopeText, source: 'existing_attempt_envelope', completeness: 'envelope_unverified',
        reason: anchorOutside ? 'native_reference_outside_attempt' : !selected.complete ? 'native_window_unverified' : 'terminal_native_reply_unavailable',
        provenance: provenanceFor(JSON.stringify(stable)) };
    if (anchorOutside) return { body: null, source: 'unavailable', reason: 'native_reference_outside_attempt' };
    return { body: null, source: 'unavailable', reason: 'original_native_bubble_unavailable' };
}
