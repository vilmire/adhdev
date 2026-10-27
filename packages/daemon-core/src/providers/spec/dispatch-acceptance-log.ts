/**
 * DISPATCH-ACK PRODUCER — the per-session, serialized record of what the send engine
 * did with each mesh dispatch's input, from which a `DispatchAcknowledgementWatermark`
 * (boot/stages/mesh-runtime.ts) is derived for one exact messageId/nonce.
 *
 * Why it exists. `hasAuthoritativeNonConsumptionProof` (the consumer) will only ever
 * answer `not_consumed` — and so arm automatic clear/redelivery — when a provider both
 * declares `canProveNonConsumption` + `supportsDispatchAcknowledgementWatermark` AND the
 * read carries a watermark bound to this dispatch's messageId and serialized with input
 * acceptance. Every provider declares both false today, so the consumer is dormant; this
 * module is the producer half only. It does NOT flip any capability and does not change
 * when anything is re-sent — quarantine, H2/H2r and nonce requeue are untouched.
 *
 * Serialization. The engine has one in-flight slot per session, so every write, every
 * acceptance (the FSM left idle), every verdict and every foreign keystroke happens in
 * one order. This log appends them in that order with a strictly monotonic ms-clock
 * `seq` (comparable with the dispatch's firstWrittenAt, which the consumer requires).
 *
 * The watermark claims `unacceptedConfirmed: true` ONLY when, for that exact messageId
 * (and nonce, when one is asked for):
 *   - its last write is in the log, and an `unaccepted` verdict (the engine's own
 *     proof: twice-proven unsent, composer cleared — submit-verdict.ts) follows it;
 *   - and NOTHING that could be an acceptance follows that write — no `accepted`
 *     (any message), no FSM `activity`, no `indeterminate` (quarantine), no foreign
 *     input, no engine `reset`, and no forgotten history (eviction past the bound).
 * Anything else is `unacceptedConfirmed: false`, and an id the log never saw written
 * gets no watermark at all. Fail-closed is the whole contract: a stale or partial
 * picture can only ever withhold the claim, never make it.
 */
import type { DispatchAcknowledgementWatermark } from '../../boot/stages/mesh-runtime.js';

export type DispatchAcceptanceEvent =
    /** The engine began writing this dispatch's body into the PTY. */
    | 'written'
    /** The FSM left idle while this dispatch held the composer: the CLI took it. */
    | 'accepted'
    /** Proven not taken (budget + one re-paste) and the composer cleared. */
    | 'unaccepted'
    /** Not proven either way (quarantine) — the CLI may yet consume it. */
    | 'indeterminate'
    /** The FSM left idle with no attributable send (anything held may be consumed). */
    | 'activity'
    /** Input reached the PTY that was not the engine's own. */
    | 'foreign_input'
    /** The engine dropped its send state (cancel / session reset). */
    | 'reset';

export interface DispatchAcceptanceEntry {
    readonly seq: number;
    readonly event: DispatchAcceptanceEvent;
    readonly messageId?: string;
    readonly nonce?: number;
}

/** Bound on retained entries; eviction is recorded so a watermark never spans it. */
export const DISPATCH_ACCEPTANCE_LOG_MAX = 1_024;

/** Events that end any claim that an earlier write is still unaccepted. */
const ACCEPTANCE_POSSIBLE: ReadonlySet<DispatchAcceptanceEvent> = new Set(['accepted', 'indeterminate', 'activity', 'foreign_input', 'reset']);

export class DispatchAcceptanceLog {
    private readonly entries: DispatchAcceptanceEntry[] = [];
    private lastSeq = 0;
    /** seq of the newest evicted entry; history at or before it is gone. */
    private evictedThrough = 0;

    constructor(private readonly now: () => number = Date.now) {}

    /** Append one event in engine order; returns its seq. */
    record(event: DispatchAcceptanceEvent, messageId?: string, nonce?: number): number {
        const seq = Math.max(this.now(), this.lastSeq + 1);
        this.lastSeq = seq;
        this.entries.push({
            seq,
            event,
            ...(typeof messageId === 'string' && messageId ? { messageId } : {}),
            ...(typeof nonce === 'number' && Number.isFinite(nonce) ? { nonce } : {}),
        });
        while (this.entries.length > DISPATCH_ACCEPTANCE_LOG_MAX) {
            this.evictedThrough = this.entries.shift()!.seq;
        }
        return seq;
    }

    /** Read-only view (tests / diagnostics). */
    snapshot(): readonly DispatchAcceptanceEntry[] { return [...this.entries]; }

    /**
     * The watermark for one exact dispatch, or null when its write is not in the log.
     * `nonce` (optional) must match the nonce recorded on that write when given.
     */
    watermark(messageId: string, nonce?: number): DispatchAcknowledgementWatermark | null {
        if (typeof messageId !== 'string' || !messageId) return null;
        let writeIndex = -1;
        for (let i = this.entries.length - 1; i >= 0; i -= 1) {
            const entry = this.entries[i];
            if (entry.event === 'written' && entry.messageId === messageId) { writeIndex = i; break; }
        }
        if (writeIndex < 0) return null;
        const write = this.entries[writeIndex];
        if (nonce !== undefined && write.nonce !== nonce) return null;
        let unacceptedAt: number | null = null;
        let contradicted = write.seq <= this.evictedThrough;
        for (let i = writeIndex + 1; i < this.entries.length; i += 1) {
            const entry = this.entries[i];
            if (ACCEPTANCE_POSSIBLE.has(entry.event)) { contradicted = true; break; }
            // A later write of the same id supersedes this one (found above as the last).
            if (entry.event === 'unaccepted' && entry.messageId === messageId) unacceptedAt = entry.seq;
        }
        const confirmed = !contradicted && unacceptedAt !== null;
        return {
            messageId,
            ...(write.nonce !== undefined ? { nonce: write.nonce } : {}),
            watermarkSeq: confirmed ? unacceptedAt! : this.lastSeq,
            unacceptedConfirmed: confirmed,
        };
    }
}
