/**
 * submit-verdict — what SendSubmitEngine does with a MESH DISPATCH whose submit
 * budget ran out at an idle FSM (SUBMIT-UNCONFIRMED-RECLAIM ①). Split out of
 * send-submit-engine.ts (file-size gate); the engine is the only consumer.
 *
 * Live (rc.25, antigravity-cli): a task body whose submit key never took sat in
 * the composer while the coordinator's ledger read it as delivered. The old
 * verdict was a log line nobody read.
 *
 * Scope. Only a send someone OPTED IN by registering a verdict observer — a mesh
 * dispatch, whose turn ledger can reclaim it (SessionInputService registers it
 * only for the instance's installed dispatch) — goes through here. Every other
 * send (a human's chat, a notice) never reaches this module: it keeps main's
 * give-up byte for byte, and no composer read is even made for it.
 *
 * Ownership — every part must hold, or nothing is ever deleted or re-written:
 *  - nobody else can type, as the SESSION HOST itself accounts it: every
 *    input it accepted since this send began came from this daemon, and write
 *    ownership never moved to another client (TerminalAdapter.inputProvenanceKey
 *    ← the host's `session_input` / `write_owner_changed` announcements; an
 *    older host that does not announce inputs is unknown → never owned). Also:
 *    no other writable client attached or owning the runtime
 *    (TerminalAdapter.otherWritersPossible), every write from this process was
 *    the engine's own (TerminalAdapter.getWriteCount, the one choke point every
 *    caller writes through), and no foreign driver input (composerEpoch);
 *  - the cursor row (exact native read, composer-evidence.ts) was an empty
 *    prompt right before the write — its exact cells are the BASELINE;
 *  - every frame after the write was watched (TerminalAdapter.onScreenWrite):
 *    the row went from the baseline, through rendering states only, to exactly
 *    ONE chip or exactly the body verbatim, and stayed that row (R6-1, R6-3);
 *  - every DEL is written by the session host only if its input stream is
 *    still exactly where we accounted it (send_input_if_seq): the check and
 *    the write are one host-side step, so input arriving after our check but
 *    before the DEL can never be deleted (R8-1);
 *  - "cleared" means the row is the baseline again — the same row with the
 *    same visible cells (composer-evidence sameVisibleRow), so any residue,
 *    left or right of the cursor, is seen — never a classifier's "looks
 *    empty" (R6-2).
 *
 * The rejected review scenarios are regression tests:
 *   - R1 a double run: nothing is ever re-written on `unknown`, and the one
 *     re-paste needs the row proven to be our own unsent body;
 *   - R2 / R6-1 / R6-3 a user draft deleted: a DEL is pressed only on a row
 *     proven ours as above, one press at a time, each removing only characters
 *     from the end of it;
 *   - R3 an idle-only verdict hard-stopping a worker: `unknown` is never
 *     reported; only a proven-unsent body (twice) is;
 *   - R4 a stale paste chip: the pre-write row was not the empty baseline;
 *   - R5 / R6-2 a queued body written over residue: a slot is given back only
 *     on the baseline row (or, with no baseline, a strictly empty one).
 *
 * Flow after the budget (one gap later, so the last key gets its chance):
 *   proven unsent (held UNSUBMITTED_HOLD_MS) → verified clear → re-paste ONCE
 *   (a fresh verified attempt, watched the same way) → if proven unsent again
 *   → verified clear → report `unconfirmed` (the instance turns it into
 *   dispatch_failed{submit_unconfirmed}; the ledger reclaims under a new nonce,
 *   i.e. a new messageId) and give the slot back.
 *   Anything else → QUARANTINE: the slot stays held, nothing is reported or
 *   cleared. It has NO local time limit, deliberately — releasing onto content
 *   we cannot attribute is the defect. It ends on exactly three events: the FSM
 *   leaves idle (consumed); the row reads as the baseline (or, with none, as a
 *   strictly empty prompt) for COMPOSER_EMPTY_HOLD_MS at an idle FSM; or the
 *   turn ledger retires the attempt (H2 probe → H2r/H3 reclaim, which
 *   hard-stops the session and with it this driver).
 *
 * KNOWN LIMIT (accepted, fail-closed — reviews R6/R7). Local recovery may
 * rarely run in practice:
 *  - a CLI that repaints its input row in pieces after our body rendered
 *    (erase → partial chip → full chip, observed shapes in agy and Claude
 *    Code redraws) taints the send, because a partial row after an own render
 *    is indistinguishable from someone else's edit. Such sends quarantine and
 *    fall back to the ledger's H2r/H3 reclaim (a hard stop) — exactly what
 *    happens without this module. The proof is NOT weakened to make recovery
 *    run more often; live verification after deploy decides whether it is
 *    useful on each CLI;
 *  - a transport with no session host (the raw node-pty fallback) never
 *    proves provenance, so recovery never runs there; every production CLI
 *    session is hosted (session-host/host-bootstrap.ts);
 *  - an older session host that does not announce inputs (no
 *    SessionHostRecord.inputSeq) never proves provenance either.
 */

import { LOG } from '../../logging/logger.js';
import { DispatchAcceptanceLog } from './dispatch-acceptance-log.js';
import type { DispatchAcknowledgementWatermark } from '../../boot/stages/mesh-runtime.js';
import { classifyRender, isStrictPrefixOf, readComposer, rightChrome, sameRow, sameVisibleRow, type ComposerRead, type ComposerScreen, type RowCells } from './composer-evidence.js';

/** How long after the LAST submit key of a budget the verdict waits. */
export const UNCONFIRMED_VERDICT_GAP_MS = 1_500;
/** The proof must HOLD this long — FSM idle, no other input, the input row
 *  exactly our rendered body — before the send counts as unsent. A CLI that took
 *  the last key but paints it late (measured fake: 2 s) is caught as confirmed. */
export const UNSUBMITTED_HOLD_MS = 4_000;
export const UNSUBMITTED_POLL_MS = 250;
/** Gap between a DEL press and reading what it did. */
export const CLEAR_STEP_MS = 150;
/** Reads in a row a DEL may show no effect before the clear is given up. */
export const CLEAR_MAX_STALLS = 6;
/** A cleared row must still read as the baseline this much later before
 *  anything is written into it (a late repaint of the body is caught here). */
export const CLEAR_SETTLE_MS = 400;
/** How often a quarantined composer is re-read. */
export const COMPOSER_HOLD_POLL_MS = 1_000;
/** A quarantined composer is released only after it read as the baseline (or
 *  strictly empty) this long in a row at an idle FSM. */
export const COMPOSER_EMPTY_HOLD_MS = 10_000;
/** Blind-fire backstop of a mesh dispatch's paste gate (the first CR waits for
 *  its own chip on the input row; a paste lands in tens of ms when it lands). */
export const PASTE_GATE_MAX_WAIT_MS = 3_000;
/** Bound on remembered verdicts / observers / first-write anchors. */
export const SUBMIT_OUTCOME_MEMORY = 2_048;

/**
 * What the engine knows about the send written under a messageId:
 *  - `in_flight`   — written (or about to be), verdict pending, or being recovered;
 *  - `confirmed`   — the FSM left idle after it was written;
 *  - `unconfirmed` — proven not taken, twice; the composer was cleared;
 *  - `unknown`     — anything else (never written here, forgotten, quarantined).
 */
export type SubmitState = 'in_flight' | 'confirmed' | 'unconfirmed' | 'unknown';

/** What the observer of a mesh dispatch is told — only ever a proven verdict. */
export type SubmitVerdict = 'unconfirmed';
export interface SubmitVerdictInfo {
    /** Wall clock of the FIRST body write under this messageId on this engine —
     *  never moved by the re-paste or a later write (review R5-2). */
    firstWrittenAt: number;
}
export type SubmitVerdictObserver = (verdict: SubmitVerdict, info: SubmitVerdictInfo) => boolean | void;
/** What a fresh transcript read says about the turn since the first body write. */
export type ConsumptionEvidence = 'consumed' | 'not_consumed' | 'unknown';
export type ConsumptionProbe = (sinceMs: number, opts?: { messageId?: string; expectedText?: string }) => Promise<ConsumptionEvidence>;

/** The adapter surface this machine reads (TerminalAdapter satisfies it).
 *  Every member missing on a test double makes ownership unprovable. */
export interface VerdictScreen extends ComposerScreen {
    getWriteCount?(): number;
    onScreenWrite?(listener: () => void): () => void;
    otherWritersPossible?(): boolean;
    inputProvenanceKey?(): string | null;
}

/** The send currently holding the composer. */
export interface CurrentSend {
    messageId?: string;
    text: string;
    bracketedPaste?: boolean;
    /** composerEpoch when written; any other driver input moves it. */
    epoch: number;
    /** All of the write-time ownership conditions held (see the header). */
    ownsComposer: boolean;
    /** The exact empty row right before the write. */
    baseline?: RowCells;
    /** The row this send's body rendered as (first own sighting). */
    rendered?: { row: number; text: string; cells: RowCells };
    /** Why the row can no longer be attributed to this send (sticky). */
    tainted?: string;
    /** `watch` = frames are checked; `clear` = the verified clear owns the row. */
    phase: 'watch' | 'clear' | 'done';
    /** The one re-paste has been spent. */
    repasted: boolean;
    firstWrittenAt: number;
}

/** The engine operations this machine drives. */
export interface SubmitVerdictHost {
    specTag(): string;
    currentStatus(): string;
    readonly adapter: VerdictScreen;
    /** Write keys as the engine's own input, ONLY if the session host still has
     *  no other input since our accounted point — checked and written by the
     *  host in one step (review R8-1). false = refused or not possible. */
    writeOwnKeysGuarded(keys: string): Promise<boolean>;
    /** Write `send`'s body again as a fresh verified attempt, slot kept.
     *  The write itself is guarded (input unchanged since this call). */
    rewrite(send: CurrentSend): void;
    /** Optional transcript read. Absent → non-consumption is unproven (R9-3). */
    confirmConsumption?(sinceMs: number, opts?: { messageId?: string; expectedText?: string }): Promise<ConsumptionEvidence>;
    /** Whether the in-flight latch is held. */
    slotTaken(): boolean;
    /** Give the slot back and let the FIFO drain one resend gap later. */
    releaseSlot(): void;
}

function bounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > SUBMIT_OUTCOME_MEMORY) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

export class SubmitVerdictMachine {
    current: CurrentSend | null = null;
    private readonly outcomes = new Map<string, 'confirmed' | 'unconfirmed'>();
    private readonly observers = new Map<string, SubmitVerdictObserver[]>();
    private readonly firstWrites = new Map<string, number>();
    private epoch = 0;
    /** PTY write count right after the engine's last own write (null = not tracked). */
    private lastOwnWrites: number | null = null;
    /** The session host's input-provenance key when the current send began. */
    private provenanceAtBegin: string | null = null;
    /** Set from the moment an opted-in budget is spent until its verdict is
     *  settled: judging, clearing, re-pasting. Keeps the slot taken. */
    private recovering: CurrentSend | null = null;
    private hold: { send: CurrentSend; reason: string; since: number; matchSince: number | null } | null = null;
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    private stepTimer: ReturnType<typeof setTimeout> | null = null;
    private unwatch: (() => void) | null = null;
    /** A guarded DEL is on its way to the host. */
    private delInFlight = false;
    /** Transcript read for the opted-in dispatch. One session, one in-flight send. */
    private consumptionProbe: ConsumptionProbe | null = null;
    /** DISPATCH-ACK PRODUCER: every write/acceptance/verdict in engine order (dispatch-acceptance-log.ts). */
    private readonly acceptance = new DispatchAcceptanceLog();

    constructor(private readonly host: SubmitVerdictHost) {}

    /** Register (before submitting) the observer of the NEXT write under
     *  `messageId`. Registering is what opts the send in (see the header). */
    observe(messageId: string, observer: SubmitVerdictObserver, probe?: ConsumptionProbe): void {
        bounded(this.observers, messageId, [...(this.observers.get(messageId) ?? []), observer]);
        if (probe) this.consumptionProbe = probe;
    }

    isObserved(send: CurrentSend | null | undefined): send is CurrentSend & { messageId: string } {
        return !!send?.messageId && this.observers.has(send.messageId);
    }

    /** The send is about to be written (beginSend). Only an opted-in send reads the composer. */
    begin(messageId: string | undefined, text: string, bracketedPaste: boolean | undefined): CurrentSend {
        this.stopWatching();
        this.lastOwnWrites = this.writes();
        this.provenanceAtBegin = this.provenance();
        let firstWrittenAt = Date.now();
        if (messageId) {
            this.acceptance.record('written', messageId);
            this.outcomes.delete(messageId);
            firstWrittenAt = this.firstWrites.get(messageId) ?? firstWrittenAt;
            bounded(this.firstWrites, messageId, firstWrittenAt);
        }
        const send: CurrentSend = { ...(messageId ? { messageId } : {}), text, ...(bracketedPaste ? { bracketedPaste } : {}), epoch: this.epoch, ownsComposer: false, phase: 'watch', repasted: false, firstWrittenAt };
        this.current = send;
        if (this.isObserved(send)) {
            const read = readComposer(this.host.adapter);
            if (read.kind === 'empty' && this.soleWriter()) { send.baseline = read.cells; send.ownsComposer = true; this.watch(send); }
        }
        return send;
    }

    /** The FIFO drain owns the slot from this tick on (the write follows 50 ms later). */
    reserve(messageId: string, text: string): void {
        this.current = { messageId, text, epoch: this.epoch, ownsComposer: false, phase: 'done', repasted: false, firstWrittenAt: Date.now() };
    }

    /** Any driver input into this PTY that is not the engine's own. */
    noteForeignInput(): void { this.epoch += 1; this.acceptance.record('foreign_input'); }

    /** The engine just wrote into the PTY. A count that moved by more than this
     *  one write means someone else wrote in between. */
    noteOwnWrite(): void {
        const n = this.writes();
        if (n === null) return;
        if (this.lastOwnWrites !== null && n !== this.lastOwnWrites + 1) { this.epoch += 1; this.acceptance.record('foreign_input'); }
        this.lastOwnWrites = n;
    }

    /** The slot must stay taken (quarantine or recovery in progress). */
    holding(): boolean { return !!this.hold || !!this.recovering; }

    holdReason(): string | null {
        if (this.recovering) return 'judging / recovering a mesh dispatch whose submit was not confirmed';
        return this.hold ? `${this.hold.reason} (${Date.now() - this.hold.since}ms)` : null;
    }

    /** DISPATCH-ACK PRODUCER: the serialized acceptance watermark for one exact dispatch. */
    dispatchAcknowledgement(messageId: string, nonce?: number): DispatchAcknowledgementWatermark | null { return this.acceptance.watermark(messageId, nonce); }

    submitState(messageId: string, inFlight: boolean): SubmitState {
        if (this.recovering?.messageId === messageId) return 'in_flight';
        if (this.hold?.send.messageId === messageId) return 'unknown';
        if (this.current?.messageId === messageId && inFlight) return 'in_flight';
        return this.outcomes.get(messageId) ?? 'unknown';
    }

    /** Paste-gate readiness: the row now shows this owned send's own body. */
    noteRendered(send: CurrentSend): boolean {
        this.checkFrame(send);
        if (!send.ownsComposer || send.tainted || !send.rendered) return false;
        return sameRow(readComposer(this.host.adapter), send.rendered.cells);
    }

    /** The FSM left idle while `send` held the composer: the CLI took it. */
    noteConfirmed(send: CurrentSend | null): void {
        if (!send) return;
        this.acceptance.record('accepted', send.messageId);
        if (send.messageId) { bounded(this.outcomes, send.messageId, 'confirmed'); this.observers.delete(send.messageId); }
        send.phase = 'done';
        if (this.current === send) { this.current = null; this.stopWatching(); }
        if (this.recovering === send) this.recovering = null;
        this.clearStep();
    }

    /** The FSM left idle: whatever was held or recovered was consumed. */
    releaseOnActivity(): void {
        this.acceptance.record('activity');
        this.releaseHold();
        if (this.recovering) this.noteConfirmed(this.recovering);
    }

    cancel(): void {
        this.acceptance.record('reset');
        this.observers.clear();
        this.current = null;
        this.recovering = null;
        this.stopWatching();
        this.releaseHold();
        this.clearStep();
    }

    /** An opted-in send's budget was just spent: keep the slot until judge(). */
    awaitVerdict(send: CurrentSend): void { if (this.current === send) this.recovering = send; }

    /** The budget of an opted-in send is spent (one gap after its last key). */
    judge(send: CurrentSend): void {
        if (this.current !== send) return;
        const provenUntil = Date.now() + UNSUBMITTED_HOLD_MS;
        const poll = (): void => {
            this.stepTimer = null;
            if (this.current !== send) return;
            if (!this.host.slotTaken() || this.host.currentStatus() !== 'idle') { this.noteConfirmed(send); return; }
            this.checkFrame(send);
            const why = this.unprovenReason(send);
            if (why) { this.quarantine(send, why); return; }
            if (Date.now() < provenUntil) { this.stepTimer = setTimeout(poll, UNSUBMITTED_POLL_MS); return; }
            this.recovering = send;
            void this.decideRecovery(send);
        };
        poll();
    }

    /**
     * The hold elapsed and the screen still looks like our unsent body. Re-paste
     * (or report) ONLY with positive evidence of non-consumption: the transcript
     * has no agent activity since the first write, AND the composer still
     * contains exactly our text (review R9-3). A delayed Thinking repaint leaves
     * the chip up and the FSM idle after the CLI already took the submit — that
     * screen is not evidence. Consumed or ambiguous (no probe, a failed read,
     * `unknown`) is treated as consumed: nothing is cleared, re-pasted, or
     * reported `unconfirmed` (which would reclaim and send the task again).
     */
    private async decideRecovery(send: CurrentSend): Promise<void> {
        const evidence = await this.nonConsumption(send);
        if (this.recovering !== send || this.current !== send) return;
        if (!this.host.slotTaken() || this.host.currentStatus() !== 'idle') { this.noteConfirmed(send); return; }
        this.checkFrame(send);
        const why = this.unprovenReason(send);
        if (evidence === 'absent' && !why) {
            LOG.warn('FsmDriver', `[${this.host.specTag()}] submit of ${send.messageId} not taken — turn evidence is absent and its own body is still the whole input row after the budget${send.repasted ? ' and the one re-paste' : ''}; clearing exactly that${send.repasted ? ' and reporting it unconfirmed' : ' and re-pasting once'}`);
            this.clearOwn(send, () => (send.repasted ? this.reportUnconfirmed(send) : this.repaste(send)));
            return;
        }
        if (evidence === 'absent' && why) { this.quarantine(send, why); return; }
        LOG.warn('FsmDriver', `[${this.host.specTag()}] submit of ${send.messageId} is not positively unsent (turn evidence ${evidence}${why ? `; ${why}` : ''}) — treating it as consumed; not clearing, re-pasting, or reporting a failure`);
        this.quarantine(send, `treated as consumed — turn evidence ${evidence}; not re-pasting`);
    }

    /** 'absent' only for a positive `not_consumed`. Anything else is not proof. */
    private async nonConsumption(send: CurrentSend): Promise<'absent' | 'present' | 'unknown'> {
        const probe = this.consumptionProbe ?? this.host.confirmConsumption;
        if (!probe) return 'unknown';
        try {
            const check = await probe(send.firstWrittenAt, { ...(send.messageId ? { messageId: send.messageId } : {}), expectedText: send.text });
            if (check === 'not_consumed') return 'absent';
            if (check === 'consumed') return 'present';
            return 'unknown';
        } catch { return 'unknown'; }
    }

    /** The guarded re-paste or its submit key was refused. Do not write further. */
    abortRecovery(why: string): void {
        const send = this.recovering;
        if (!send) return;
        this.quarantine(send, why);
    }

    private writes(): number | null {
        try { return typeof this.host.adapter.getWriteCount === 'function' ? this.host.adapter.getWriteCount() : null; } catch { return null; }
    }

    private provenance(): string | null {
        try { return typeof this.host.adapter.inputProvenanceKey === 'function' ? this.host.adapter.inputProvenanceKey() : null; } catch { return null; }
    }

    /**
     * No other client can type, every PTY write from this process since begin()
     * was ours, and the SESSION HOST's own account agrees: no input by another
     * client, no write-ownership move to another client and no lost input
     * announcement since begin() (reviews R7-1/R7-2 — a client list cached on
     * this side is not an input boundary). Anything unknown is false.
     */
    private soleWriter(): boolean {
        const n = this.writes();
        if (n === null || this.lastOwnWrites === null || n !== this.lastOwnWrites) return false;
        const p = this.provenance();
        if (p === null || p !== this.provenanceAtBegin) return false;
        try { return typeof this.host.adapter.otherWritersPossible === 'function' && this.host.adapter.otherWritersPossible() === false; } catch { return false; }
    }

    private watch(send: CurrentSend): void {
        this.stopWatching();
        if (typeof this.host.adapter.onScreenWrite !== 'function') { send.tainted = 'the screen cannot be watched frame by frame'; return; }
        try { this.unwatch = this.host.adapter.onScreenWrite(() => this.checkFrame(send)); } catch { send.tainted = 'the screen cannot be watched frame by frame'; }
    }

    private stopWatching(): void {
        const off = this.unwatch;
        this.unwatch = null;
        try { off?.(); } catch { /* best effort */ }
    }

    /** One frame (or one on-demand read) while `send` is watched (see the header). */
    private checkFrame(send: CurrentSend): void {
        if (this.current !== send || send.phase !== 'watch' || !send.ownsComposer || send.tainted) return;
        if (send.epoch !== this.epoch || !this.soleWriter()) { send.tainted = 'other input reached the PTY since this send was written'; return; }
        const read = readComposer(this.host.adapter);
        if (!send.rendered) {
            const seen = classifyRender(read, send.text);
            if ((seen === 'own_chip' || seen === 'own_literal') && read.kind !== 'unknown' && read.kind !== 'empty') {
                send.rendered = { row: read.row, text: read.text, cells: read.cells };
            } else if (seen === 'foreign') {
                send.tainted = `the input row showed content that is not exactly this send's paste (${read.kind})`;
            }
            return;
        }
        if (sameRow(read, send.rendered.cells) || read.kind === 'unknown') return;
        // Back to the baseline: the CLI took it or is repainting; the FSM decides.
        if (send.baseline && read.kind === 'empty' && sameVisibleRow(read, send.baseline)) return;
        send.tainted = `the input row changed after this send rendered (${read.kind})`;
    }

    /** Null when `send` is provably still unsent in the composer; else why not. */
    private unprovenReason(send: CurrentSend): string | null {
        if (send.tainted) return send.tainted;
        if (send.epoch !== this.epoch || !this.soleWriter()) return 'other input reached the PTY, or another client can type into it';
        if (!send.ownsComposer || !send.baseline) return 'the input row was not an empty prompt (exact read) right before the write';
        if (!send.rendered) return 'this send was never seen rendered on the input row';
        const read = readComposer(this.host.adapter);
        if (!sameRow(read, send.rendered.cells)) return `the input row is not exactly this send's body (${read.kind})`;
        return null;
    }

    /**
     * Delete exactly our own rendered body: one DEL at a time, each read back.
     * A step must leave a strict prefix of what was there (only our characters,
     * from the end, the rest of the row unchanged) or the baseline row itself;
     * anything else — other input or another writer, an unknown read, a
     * different row, a DEL that does nothing for CLEAR_MAX_STALLS reads, more
     * presses than the body has characters, the FSM leaving idle — stops the
     * clear and quarantines the slot. `done` runs once the row has read as the
     * baseline for CLEAR_SETTLE_MS.
     */
    private clearOwn(send: CurrentSend, done: () => void): void {
        send.phase = 'clear';
        const baseline = send.baseline!;
        const row = send.rendered!.row;
        const chrome = rightChrome(send.rendered!.cells);
        const lead = send.rendered!.cells.left.slice(0, send.rendered!.cells.left.length - send.rendered!.text.length);
        let prev = send.rendered!.text;
        let presses = 0;
        let stalls = 0;
        const limit = Array.from(prev).length;
        const press = (): void => {
            presses += 1;
            // The ownership check above and this DEL must not be separable: the
            // host refuses it if ANY input landed since our accounted point.
            this.delInFlight = true;
            let written: Promise<boolean>;
            try { written = this.host.writeOwnKeysGuarded('\x7f'); } catch { written = Promise.resolve(false); }
            void written.then((ok) => ok, () => false).then((ok) => {
                this.delInFlight = false;
                if (this.recovering !== send) return;
                if (!ok) { this.quarantine(send, 'the session host refused the guarded DEL (input changed since the ownership check, or no host guard)'); return; }
                this.stepTimer = setTimeout(step, CLEAR_STEP_MS);
            });
        };
        const owned = (): string | null => {
            if (this.recovering !== send) return 'superseded';
            if (send.epoch !== this.epoch || !this.soleWriter()) return 'other input reached the PTY during the clear';
            return null;
        };
        const step = (): void => {
            this.stepTimer = null;
            if (this.recovering !== send) return;
            if (this.host.currentStatus() !== 'idle') { this.noteConfirmed(send); return; }
            const lost = owned();
            if (lost) { this.quarantine(send, lost); return; }
            const read = readComposer(this.host.adapter);
            if (read.kind === 'empty' && sameVisibleRow(read, baseline)) {
                this.stepTimer = setTimeout(() => {
                    this.stepTimer = null;
                    if (this.recovering !== send) return;
                    if (this.host.currentStatus() !== 'idle') { this.noteConfirmed(send); return; }
                    const again = readComposer(this.host.adapter);
                    const lostAgain = owned();
                    if (lostAgain || again.kind !== 'empty' || !sameVisibleRow(again, baseline)) { this.quarantine(send, lostAgain ?? `the cleared input row did not stay exactly as it was before the write (${again.kind})`); return; }
                    done();
                }, CLEAR_SETTLE_MS);
                return;
            }
            const content = (read.kind === 'chip' || read.kind === 'text') && read.row === row && rightChrome(read.cells) === chrome
                && read.cells.left === lead + read.text ? read.text : null;
            if (content !== null && content === prev) {
                if (++stalls > CLEAR_MAX_STALLS) { this.quarantine(send, 'a DEL press had no effect on the input row'); return; }
                this.stepTimer = setTimeout(step, CLEAR_STEP_MS);
                return;
            }
            if (content !== null && isStrictPrefixOf(content, prev) && presses < limit) {
                prev = content;
                stalls = 0;
                press();
                return;
            }
            this.quarantine(send, `the input row changed in a way a DEL of our own body does not explain (${read.kind})`);
        };
        press();
    }

    /** The one re-paste: a fresh verified attempt into the proven baseline row.
     *  Refuses before any byte if input landed after the clear settled (R9-2).
     *  The write itself is also guarded by the host. */
    private repaste(send: CurrentSend): void {
        if (send.epoch !== this.epoch || !this.soleWriter()) {
            this.quarantine(send, 'other input reached the PTY before the re-paste');
            return;
        }
        const read = readComposer(this.host.adapter);
        if (!send.baseline || read.kind !== 'empty' || !sameVisibleRow(read, send.baseline)) {
            this.quarantine(send, 'the input row was not the empty baseline at the re-paste');
            return;
        }
        send.repasted = true;
        send.rendered = undefined;
        send.phase = 'watch';
        send.epoch = this.epoch;
        LOG.warn('FsmDriver', `[${this.host.specTag()}] composer cleared; re-pasting ${send.messageId} once`);
        this.host.rewrite(send);
    }

    /** Proven unsent twice and the composer cleared: report, give the slot back. */
    private reportUnconfirmed(send: CurrentSend): void {
        LOG.error('FsmDriver', `[${this.host.specTag()}] SUBMIT NOT CONFIRMED for ${send.messageId} after the budget and one re-paste (len=${send.text.length}) — the agent is NOT working on it; the composer was cleared; reporting it to the turn ledger`);
        send.phase = 'done';
        this.recovering = null;
        if (this.current === send) { this.current = null; this.stopWatching(); }
        if (!send.messageId) { this.host.releaseSlot(); return; }
        // Recorded before the observers run, so a watermark read from one already sees it.
        this.acceptance.record('unaccepted', send.messageId);
        bounded(this.outcomes, send.messageId, 'unconfirmed');
        const observers = this.observers.get(send.messageId) ?? [];
        this.observers.delete(send.messageId);
        let taken = false;
        for (const observer of observers) {
            try { if (observer('unconfirmed', { firstWrittenAt: send.firstWrittenAt }) === true) taken = true; } catch (error) {
                LOG.warn('FsmDriver', `[${this.host.specTag()}] submit-verdict observer for ${send.messageId} threw: ${(error as Error)?.message ?? error}`);
            }
        }
        if (!taken) LOG.warn('FsmDriver', `[${this.host.specTag()}] the unconfirmed verdict on ${send.messageId} was not taken by its dispatch (it moved on); the composer is back to its pre-write row, so the slot is released`);
        this.host.releaseSlot();
    }

    /** Keep the slot taken; nothing reported or cleared. See the header for
     *  the three events that end it — there is no local time limit. */
    private quarantine(send: CurrentSend, why: string): void {
        LOG.warn('FsmDriver', `[${this.host.specTag()}] submit of ${send.messageId ?? '(anonymous)'} (len=${send.text.length}) is not proven either way — ${why}; holding the composer (nothing cleared, re-sent or reported; the turn ledger's own deadlines decide the dispatch)`);
        this.acceptance.record('indeterminate', send.messageId);
        if (send.messageId) this.outcomes.delete(send.messageId);
        send.phase = 'done';
        this.recovering = null;
        this.stopWatching();
        this.clearStep();
        this.hold = { send, reason: `composer held — ${why}`, since: Date.now(), matchSince: null };
        this.armHoldPoll();
    }

    /** The quarantined row is back to how it was before the write (or, with no
     *  baseline, a strictly empty prompt). */
    private holdReleasable(send: CurrentSend, read: ComposerRead): boolean {
        return read.kind === 'empty' && (!send.baseline || sameVisibleRow(read, send.baseline));
    }

    private armHoldPoll(): void {
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            const hold = this.hold;
            if (!hold) return;
            if (this.host.currentStatus() !== 'idle') return; // the engine's drain releases it as consumed
            if (!this.holdReleasable(hold.send, readComposer(this.host.adapter))) { hold.matchSince = null; this.armHoldPoll(); return; }
            hold.matchSince ??= Date.now();
            if (Date.now() - hold.matchSince < COMPOSER_EMPTY_HOLD_MS) { this.armHoldPoll(); return; }
            LOG.info('FsmDriver', `[${this.host.specTag()}] input row is back to its pre-write state after ${Date.now() - hold.since}ms — releasing the held slot`);
            this.releaseHold();
            if (this.current === hold.send) this.current = null;
            this.host.releaseSlot();
        }, COMPOSER_HOLD_POLL_MS);
    }

    private releaseHold(): void {
        this.hold = null;
        if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    }

    private clearStep(): void {
        if (this.stepTimer) { clearTimeout(this.stepTimer); this.stepTimer = null; }
    }

    /** A step timer is armed (counts as an in-flight submit for shutdown). */
    stepping(): boolean { return this.stepTimer !== null || this.delInFlight; }
}
