/**
 * InputConsumeAck — the durable application-level consume ACK for session input.
 * Design: docs/design/2026-11-01-durable-consume-ack.md
 *
 * A native write (`submitted`) is NOT consumption. This journal records, per
 * messageId, how far an input provably got:
 *
 *   queued → written → submitted → consumed          (application ACK)
 *                                 → not_consumed      (PROVEN unsent)
 *                      any open state → unknown       (uncertain / restored)
 *
 * Rules enforced here (and nowhere else):
 *  - `consumed` and `not_consumed` need a named evidence kind; queued/written/
 *    submitted/replication never produce them.
 *  - `consumed` always wins (never resend something that may have run).
 *  - An open row written by another process/boot is reported as `unknown`
 *    (restored) — restart is never evidence of non-consumption.
 *  - A resend is allowed only from `not_consumed` and only
 *    `MAX_PROVEN_RESENDS` time(s), claimed atomically.
 * Every failure to persist degrades to "no ACK / no retry" — never to a resend.
 */
import type { Database as DatabaseHandle } from 'better-sqlite3';

export type ConsumeState = 'queued' | 'written' | 'submitted' | 'consumed' | 'not_consumed' | 'unknown';

/** EXACT: bound to this very messageId. The only kind that is an application ACK. */
export const EXACT_CONSUMED_EVIDENCE = [
    'engine_accepted_for_message', // send engine: the FSM left idle while THIS messageId held the composer (SubmitState 'confirmed')
] as const;
/** LOOSE: agent activity after the first write, not bound to the messageId. Blocks any resend, is NOT an ACK. */
export const LOOSE_CONSUMED_EVIDENCE = [
    'agent_activity_since_write', // fresh transcript read (confirmSubmitConsumption) found agent activity since the write
] as const;
export const CONSUMED_EVIDENCE = [...EXACT_CONSUMED_EVIDENCE, ...LOOSE_CONSUMED_EVIDENCE] as const;
export const NOT_CONSUMED_EVIDENCE = [
    'driver_unconfirmed_after_repaste',      // driver budget + one re-paste exhausted, composer cleared
    'transcript_no_turn_after_composer_clear', // composer cleared and fresh transcript has no such turn
] as const;
export type ConsumedEvidence = typeof CONSUMED_EVIDENCE[number];
export type NotConsumedEvidence = typeof NOT_CONSUMED_EVIDENCE[number];

/** Exactly one resend per messageId, and only after a proven not_consumed. */
export const MAX_PROVEN_RESENDS = 1;

/** True only for an application ACK (exact messageId-bound evidence). */
export function isApplicationAck(view: Pick<ConsumeView, 'state' | 'evidence'> | undefined): boolean {
    return view?.state === 'consumed' && (EXACT_CONSUMED_EVIDENCE as readonly string[]).includes(view.evidence ?? '');
}

export interface ConsumeView {
    messageId: string;
    sessionId: string;
    state: ConsumeState;
    evidence: string | null;
    retries: number;
    /** The row was written by another process/boot and is still open. */
    restored: boolean;
    revision: number;
    updatedAt: number;
}

export interface InputConsumeAck {
    begin(messageId: string, sessionId: string): void;
    observeWrite(messageId: string, state: 'started' | 'submitted' | 'uncertain'): void;
    noteQueued(messageId: string): void;
    recordConsumed(messageId: string, evidence: ConsumedEvidence): void;
    recordNotConsumed(messageId: string, evidence: NotConsumedEvidence): void;
    /** Pull the engine's exact per-messageId acceptance (`submitState`) into the journal. */
    noteEngineState(messageId: string, state: 'in_flight' | 'confirmed' | 'unconfirmed' | 'unknown'): void;
    read(messageId: string): ConsumeView | undefined;
    /** Atomically spend the single resend. True only for a proven not_consumed with budget left. */
    claimRetry(messageId: string): boolean;
}

interface Row {
    message_id: string; session_id: string; state: ConsumeState; evidence: string | null;
    retries: number; pid: number; boot_nonce: string; revision: number; updated_at: number;
}

const OPEN_RANK: Partial<Record<ConsumeState, number>> = { queued: 0, written: 1, submitted: 2 };

export function createInputConsumeAck(opts: {
    /** Lazy: the runtime DB may not exist yet at construction. Undefined/throwing = no journal (fail closed). */
    getDb: () => DatabaseHandle | undefined;
    bootNonce: string;
    pid?: number;
    now?: () => number;
    warn?: (msg: string) => void;
}): InputConsumeAck {
    const pid = opts.pid ?? process.pid;
    const now = opts.now ?? Date.now;
    const warn = opts.warn ?? (() => {});
    const db = (): DatabaseHandle | undefined => {
        try { return opts.getDb(); } catch (error) { warn(`consume-ack journal unavailable: ${(error as Error)?.message ?? error}`); return undefined; }
    };
    const guarded = <T>(fallback: T, run: (d: DatabaseHandle) => T): T => {
        const d = db();
        if (!d) return fallback;
        try { return run(d); } catch (error) { warn(`consume-ack journal write failed: ${(error as Error)?.message ?? error}`); return fallback; }
    };
    const get = (d: DatabaseHandle, id: string) => d.prepare('SELECT * FROM input_consume_ack WHERE message_id=?').get(id) as Row | undefined;
    const set = (d: DatabaseHandle, id: string, state: ConsumeState, evidence: string | null) => {
        d.prepare('UPDATE input_consume_ack SET state=?,evidence=COALESCE(?,evidence),pid=?,boot_nonce=?,revision=revision+1,updated_at=? WHERE message_id=?')
            .run(state, evidence, pid, opts.bootNonce, now(), id);
    };
    const advanceOpen = (id: string, next: 'queued' | 'written' | 'submitted' | 'unknown') => guarded(undefined, (d) => {
        const row = get(d, id);
        if (!row || row.state === 'consumed' || row.state === 'not_consumed') return;
        if (next === 'unknown') { if (row.state !== 'submitted') set(d, id, 'unknown', null); return; }
        const cur = OPEN_RANK[row.state];
        if (cur === undefined) { set(d, id, next, null); return; } // unknown -> a fresh observed write in this process
        if (OPEN_RANK[next]! > cur) set(d, id, next, null);
    });
    const api: InputConsumeAck = {
        begin: (messageId, sessionId) => guarded(undefined, (d) => {
            d.prepare('INSERT OR IGNORE INTO input_consume_ack(message_id,session_id,state,evidence,retries,pid,boot_nonce,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
                .run(messageId, sessionId, 'queued', null, 0, pid, opts.bootNonce, 1, now(), now());
        }),
        observeWrite: (id, s) => advanceOpen(id, s === 'started' ? 'written' : s === 'submitted' ? 'submitted' : 'unknown'),
        noteQueued: (id) => advanceOpen(id, 'queued'),
        recordConsumed: (id, evidence) => guarded(undefined, (d) => {
            if (!(CONSUMED_EVIDENCE as readonly string[]).includes(evidence)) return;
            const row = get(d, id);
            // Loose consumed evidence may be upgraded to exact; never the other way.
            const upgrade = row?.state === 'consumed' && !(EXACT_CONSUMED_EVIDENCE as readonly string[]).includes(row.evidence ?? '')
                && (EXACT_CONSUMED_EVIDENCE as readonly string[]).includes(evidence);
            if (row && (row.state !== 'consumed' || upgrade)) set(d, id, 'consumed', evidence);
        }),
        recordNotConsumed: (id, evidence) => guarded(undefined, (d) => {
            if (!(NOT_CONSUMED_EVIDENCE as readonly string[]).includes(evidence)) return;
            const row = get(d, id);
            if (row && row.state !== 'consumed' && row.state !== 'not_consumed') set(d, id, 'not_consumed', evidence);
        }),
        noteEngineState: (id, state) => { if (state === 'confirmed') api.recordConsumed(id, 'engine_accepted_for_message'); },
        read: (id) => guarded(undefined, (d) => {
            const row = get(d, id);
            if (!row) return undefined;
            const terminal = row.state === 'consumed' || row.state === 'not_consumed';
            const restored = !terminal && (row.pid !== pid || row.boot_nonce !== opts.bootNonce);
            return { messageId: row.message_id, sessionId: row.session_id, state: restored ? 'unknown' : row.state, evidence: row.evidence,
                retries: row.retries, restored, revision: row.revision, updatedAt: row.updated_at };
        }),
        claimRetry: (id) => guarded(false, (d) => d.prepare(
            "UPDATE input_consume_ack SET state='written',evidence=NULL,retries=retries+1,pid=?,boot_nonce=?,revision=revision+1,updated_at=? WHERE message_id=? AND state='not_consumed' AND retries<?",
        ).run(pid, opts.bootNonce, now(), id, MAX_PROVEN_RESENDS).changes === 1),
    };
    return api;
}
