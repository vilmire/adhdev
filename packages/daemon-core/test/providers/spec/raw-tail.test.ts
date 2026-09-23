/**
 * Wiring-unification C6 — RawTail.
 *
 * Pins the two-reader/one-writer contract: `append` is the single writer,
 * `strippedTail` (replaces `appendAuthTail`/`TAIL_BYTES`) and
 * `takeCompleteLines` (replaces `jsonLineTail`) are independent read views
 * over the same buffer, and the byte cap holds.
 */
import { describe, expect, it } from 'vitest';
import { RawTail } from '../../../src/providers/spec/raw-tail.js';

describe('RawTail', () => {
    describe('append + seq', () => {
        it('seq starts at 0 and increments once per append', () => {
            const tail = new RawTail();
            expect(tail.seq).toBe(0);
            tail.append('a');
            expect(tail.seq).toBe(1);
            tail.append('b');
            expect(tail.seq).toBe(2);
        });

        it('an empty-string append is a no-op (no seq bump, no buffer change)', () => {
            const tail = new RawTail();
            tail.append('hello');
            const seqBefore = tail.seq;
            tail.append('');
            expect(tail.seq).toBe(seqBefore);
            expect(tail.snapshot()).toBe('hello');
        });
    });

    describe('strippedTail — replaces appendAuthTail/TAIL_BYTES', () => {
        it('returns the accumulated text capped to maxBytes', () => {
            const tail = new RawTail();
            tail.append('hello ');
            tail.append('world');
            expect(tail.strippedTail(1024)).toBe('hello world');
            expect(tail.strippedTail(5)).toBe('world');
        });

        it('strips ANSI escape sequences the same way appendAuthTail did', () => {
            const tail = new RawTail();
            // eslint-disable-next-line no-control-regex
            tail.append('\x1b[31mred\x1b[0m plain');
            expect(tail.strippedTail(1024)).toBe('red plain');
        });

        it('is a pure read: calling it repeatedly does not mutate state or affect takeCompleteLines', () => {
            const tail = new RawTail();
            tail.append('line-one\nline-two\n');
            const first = tail.strippedTail(1024);
            const second = tail.strippedTail(1024);
            expect(first).toBe(second);
            // takeCompleteLines still sees everything — strippedTail reads never consumed it.
            expect(tail.takeCompleteLines()).toEqual(['line-one', 'line-two']);
        });
    });

    describe('takeCompleteLines — replaces jsonLineTail', () => {
        it('returns only complete lines and keeps the trailing partial line as its own cursor', () => {
            const tail = new RawTail();
            tail.append('{"a":1}\n{"b":2}\npartial-tail');
            expect(tail.takeCompleteLines()).toEqual(['{"a":1}', '{"b":2}']);
            // A second call with no new complete-line-terminating bytes returns nothing —
            // the partial tail is not re-returned, and it is not lost either.
            expect(tail.takeCompleteLines()).toEqual([]);
        });

        it('folds a later append onto the still-partial line rather than losing it', () => {
            const tail = new RawTail();
            tail.append('partial-sta');
            expect(tail.takeCompleteLines()).toEqual([]);
            tail.append('rt\ncomplete-now\nstill-partial');
            expect(tail.takeCompleteLines()).toEqual(['partial-start', 'complete-now']);
        });

        it('handles \\r\\n line endings the same as \\n', () => {
            const tail = new RawTail();
            tail.append('one\r\ntwo\r\nrest');
            expect(tail.takeCompleteLines()).toEqual(['one', 'two']);
        });

        it('a call with nothing new since the last one returns an empty array (never repeats lines)', () => {
            const tail = new RawTail();
            tail.append('only-one-line\n');
            expect(tail.takeCompleteLines()).toEqual(['only-one-line']);
            expect(tail.takeCompleteLines()).toEqual([]);
            expect(tail.takeCompleteLines()).toEqual([]);
        });

        it('two readers do not cross-consume: taking lines never shrinks what strippedTail can still read', () => {
            const tail = new RawTail();
            tail.append('alpha\nbeta\ntrailing');
            expect(tail.takeCompleteLines()).toEqual(['alpha', 'beta']);
            // strippedTail still sees the FULL buffer, including the lines
            // takeCompleteLines already consumed from its own cursor.
            expect(tail.strippedTail(1024)).toBe('alpha\nbeta\ntrailing');
        });
    });

    describe('byte cap', () => {
        it('caps the raw buffer to capBytes, keeping only the most recent bytes', () => {
            const tail = new RawTail(10);
            tail.append('0123456789'); // exactly 10 bytes
            expect(tail.snapshot()).toBe('0123456789');
            tail.append('X'); // 11 bytes total -> capped to last 10
            expect(tail.snapshot()).toBe('123456789X');
            expect(tail.byteLength()).toBe(10);
        });

        it('shifts the line-reader cursor to compensate for cap-driven trimming instead of desyncing', () => {
            const tail = new RawTail(12);
            tail.append('short\n'); // 6 bytes, buffer = "short\n", 1 complete line
            expect(tail.takeCompleteLines()).toEqual(['short']);
            // Cursor is now at position 6 (== buffer length so far). Append
            // exactly 10 more bytes with no newline: buffer would be 16 bytes
            // ("short\n0123456789"), capped to the LAST 12 -> "t\n0123456789"
            // (the leading "shor" is dropped by the cap). The cap trimmed 4
            // bytes from the front, so a correctly-compensated cursor moves
            // from 6 to 2 (still pointing just past "t\n" — the tail end of
            // the consumed "short\n" that survived the cap). WITHOUT
            // compensation the cursor would stay at 6, landing two bytes into
            // "0123456789" and silently dropping "01" from the next read.
            tail.append('0123456789');
            expect(tail.snapshot()).toBe('t\n0123456789'); // sanity: cap kept the last 12 bytes
            tail.append('\n');
            // A correctly-compensated cursor reads the unread tail as
            // "0123456789\n" -> exactly one complete line, full content intact.
            expect(tail.takeCompleteLines()).toEqual(['0123456789']);
        });
    });

    describe('break-once — pins the "one writer, two independent readers" contract', () => {
        it('would fail if takeCompleteLines shared strippedTail\'s cursor (simulated regression)', () => {
            // Simulate the regression: a SINGLE shared cursor advanced by
            // whichever reader runs first. This is what the two-tail-field
            // design (jsonLineTail/failureOutputTail) accidentally avoided by
            // being separate fields — RawTail must preserve that separation
            // internally even though it's one buffer now.
            let buf = '';
            let sharedCursor = 0;
            function regressedStrippedTail(maxBytes: number): string {
                sharedCursor = buf.length; // BUG: a "read" advances the cursor
                return buf.slice(-maxBytes);
            }
            function regressedTakeCompleteLines(): string[] {
                const unread = buf.slice(sharedCursor);
                const idx = unread.lastIndexOf('\n');
                if (idx === -1) return [];
                const complete = unread.slice(0, idx);
                sharedCursor += idx + 1;
                return complete === '' ? [] : complete.split('\n');
            }
            buf = 'alpha\nbeta\ntrailing';
            regressedStrippedTail(1024); // a mere read poisons the cursor in the regressed version
            expect(regressedTakeCompleteLines()).toEqual([]); // lines are lost — proves why RawTail must NOT do this

            // The real RawTail does not have this bug:
            const tail = new RawTail();
            tail.append('alpha\nbeta\ntrailing');
            tail.strippedTail(1024);
            expect(tail.takeCompleteLines()).toEqual(['alpha', 'beta']);
        });
    });
});
