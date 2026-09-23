/**
 * RawTail — one bounded ring of raw PTY chunks per session, with two
 * independent read views over the SAME underlying buffer.
 *
 * Wiring-unification C6 (docs/design/2026-09-23-wiring-unification.md §5 C6
 * "PTY ordering + RawTail").
 *
 * Today `SpecCliAdapter` keeps two separate hand-rolled tails that both
 * append the same PTY output but for different purposes:
 *   - `live-auth-advisory.ts`'s `appendAuthTail`/`TAIL_BYTES` — an
 *     ANSI-STRIPPED, append-and-cap tail used by the auth/billing classifier.
 *   - `cli-adapter.ts`'s `jsonLineTail` — a RAW (non-stripped) accumulation
 *     split on newlines, used by the Claude TUI JSON-line prompt detector,
 *     which consumes complete lines and keeps only the trailing partial line.
 * Because they're separate fields fed by separate call sites, one reader's
 * cursor can never accidentally consume the other's view — but the daemon
 * pays for two copies of the same bytes and two independent cap/slice paths.
 * `RawTail` replaces both with one append, two read views:
 *   - `strippedTail(maxBytes)` is the ANSI-stripped, capped tail (auth reader).
 *   - `takeCompleteLines()` is the raw, newline-cursored reader (JSON-line
 *     reader) — it consumes up to the last `\n` and keeps the remainder as
 *     its own cursor, independent of `strippedTail`'s read.
 *
 * `seq` is a monotonic counter bumped on every `append()`, so evidence kinds
 * that observe PTY output (`turn_started`, `transcript_activity`, …) can
 * carry a `rawTailSeq` alongside the observation to let admission logic prove
 * ordering ("this evidence was observed no earlier than raw-tail sequence
 * N") without ever putting PTY content into evidence — evidence carries only
 * `seq` (a number) and byte counts, never the buffered text itself. This is
 * the same content-free-by-construction rule `mesh-shared/turn-evidence.ts`
 * already enforces for evidence bodies.
 */
'use strict';

import { stripAnsi } from './provider-failure-classifier.js';

/** Default cap for the raw ring — matches the prior `jsonLineTail` 64KiB cap
 *  (the auth tail's 16KiB cap is applied per-read via `strippedTail(maxBytes)`,
 *  not at the buffer level, so a caller that wants a smaller stripped view
 *  doesn't force a smaller raw buffer for the line reader). */
const DEFAULT_CAP_BYTES = 64 * 1024;

export class RawTail {
    /** Raw (non-stripped) accumulated bytes. Capped at `capBytes` on every
     *  append, oldest bytes first. Shared by both read views. */
    private buf = '';
    /**
     * `takeCompleteLines()`'s own cursor: the portion of `buf` already
     * returned as complete lines, so a second call without an intervening
     * `append()` returns nothing (not the same lines again), and one that
     * follows a new `append()` sees only the newly-appended tail joined onto
     * whatever partial line was left over. Independent of `strippedTail`,
     * which always reads the full `buf` fresh and has no cursor of its own.
     */
    private lineCursorPos = 0;
    /** Monotonic append counter. Bumped once per `append()` call, never reset. */
    private seqCounter = 0;
    /**
     * `seq` at the last `clearStrippedTail()` call. `strippedTail()` reports
     * empty until a NEW `append()` moves `seqCounter` past this mark — the
     * classifier-side equivalent of "drop the append-only tail so only new
     * output can re-raise a dismissed suspicion" (the old `failureOutputTail
     * = ''` pattern), without truncating the shared buffer `takeCompleteLines()`
     * also reads.
     */
    private strippedClearedAtSeq = 0;

    constructor(private readonly capBytes: number = DEFAULT_CAP_BYTES) {}

    /**
     * Append one PTY chunk to the shared buffer. The single writer both read
     * views (`strippedTail`, `takeCompleteLines`) observe — callers must not
     * maintain their own copy alongside this one.
     */
    append(chunk: string): void {
        if (!chunk) return;
        const before = this.buf.length;
        const next = (this.buf + chunk).slice(-this.capBytes);
        // The cap can slice off a prefix; shift the line cursor by exactly how
        // much was trimmed so it still points at the same logical position
        // (clamped to 0 — a cursor can never trail the buffer's new start).
        const trimmed = before + chunk.length - next.length;
        this.buf = next;
        this.lineCursorPos = Math.max(0, this.lineCursorPos - trimmed);
        this.seqCounter++;
    }

    /**
     * Current monotonic sequence number — the count of `append()` calls so
     * far. Evidence built from an observation made after this `append()`
     * (e.g. inside the same PTY-data handler, after the ordering fix in
     * `adapter.ts`) may carry this value as `rawTailSeq` alongside the
     * evidence kind, purely as a numeric ordering proof — never the buffer
     * content itself.
     */
    get seq(): number {
        return this.seqCounter;
    }

    /**
     * ANSI-stripped tail, capped to `maxBytes` (bytes of the STRIPPED text,
     * not the raw buffer). Replaces `appendAuthTail`/`TAIL_BYTES`'s
     * `` `${tail}${stripAnsi(chunk)}`.slice(-TAIL_BYTES) `` — same semantics
     * (append-and-cap over stripped text), but reading is now decoupled from
     * writing: this is a pure read over the shared raw buffer, so calling it
     * repeatedly with different `maxBytes` never mutates state and never
     * competes with `takeCompleteLines()`'s cursor.
     */
    strippedTail(maxBytes: number): string {
        if (this.seqCounter <= this.strippedClearedAtSeq) return '';
        return stripAnsi(this.buf).slice(-maxBytes);
    }

    /**
     * Mark the stripped-tail view as consumed: `strippedTail()` reports empty
     * until the next `append()`. Does not touch the shared buffer or
     * `takeCompleteLines()`'s cursor — only `strippedTail()`'s own read is
     * affected. A classifier calls this after a dismissed live suspicion, so
     * the SAME already-seen bytes cannot re-raise it on the next read.
     */
    clearStrippedTail(): void {
        this.strippedClearedAtSeq = this.seqCounter;
    }

    /**
     * Consume every complete line (`\r?\n`-terminated) accumulated since the
     * last call, returning them oldest-first, and advance this reader's own
     * cursor past them — a line returned once is never returned again, and a
     * call with no new complete lines since the last one returns `[]`.
     * Replaces `jsonLineTail`'s `split(/\r?\n/)` + `lines.pop()` dance.
     *
     * The cursor is independent of `strippedTail`'s view: taking lines here
     * never shrinks or otherwise affects what `strippedTail()` can still
     * read from `this.buf` — only `append()` mutates the shared buffer (and
     * shifts this cursor to compensate for cap-driven trimming); this method
     * only advances where in that buffer IT has already read up to.
     */
    takeCompleteLines(): string[] {
        const unread = this.buf.slice(this.lineCursorPos);
        const lastNewline = unread.lastIndexOf('\n');
        if (lastNewline === -1) return [];
        // Include the '\n' itself in the consumed span so a trailing '\r' just
        // before it is captured by the split below (matches jsonLineTail's
        // original `split(/\r?\n/)` over the whole buffer, whose `\r?` always
        // ate the CR immediately preceding a LF it also matched).
        const complete = unread.slice(0, lastNewline + 1);
        this.lineCursorPos += complete.length;
        const lines = complete.split(/\r?\n/);
        // split(/\r?\n/) on a string ending in '\n' always yields a trailing
        // '' for the terminator itself — drop it, it is not a line.
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        return lines;
    }

    /** Full raw buffer as currently held (debug/tests only — production
     *  readers should use `strippedTail`/`takeCompleteLines`). */
    snapshot(): string {
        return this.buf;
    }

    /** Byte length of the currently held raw buffer. */
    byteLength(): number {
        return Buffer.byteLength(this.buf, 'utf8');
    }
}
