/**
 * SECURITY regression — grep ReDoS in the daemon log tail reader.
 *
 * `get_mesh_node_logs` forwards a peer-supplied `grep` source to the owning
 * daemon, which applies it to every line of the whole log file plus rotation
 * backups. Compiling that source as an unrestricted regex let a catastrophic
 * backtracking pattern such as `(a+)+$` stall the event loop — measured at
 * ~59_000 ms against a SINGLE 40-char line before the fix.
 *
 * INJECTION CHECK: revert `buildGrepPredicate` in
 * `src/logging/log-tail-reader.ts` to its previous body —
 *
 *     let re = null;
 *     try { re = new RegExp(grepSource, 'i'); } catch { re = null; }
 *     if (re) { const c = re; return (line) => c.test(line); }
 *     const needle = grepSource.toLowerCase();
 *     return (line) => line.toLowerCase().includes(needle);
 *
 * — and "matches a catastrophic pattern in bounded time" hangs (test timeout),
 * while "falls back to a literal match" fails on mode/semantics.
 */
import { describe, it, expect } from 'vitest';
import {
    buildGrepPredicate,
    MAX_GREP_PATTERN_LENGTH,
} from '../../src/logging/log-tail-reader.js';

/** The classic exponential-backtracking source, plus a line that never matches. */
const EVIL_PATTERN = '(a+)+$';
const EVIL_LINE = `[12:00:00.000] ${'a'.repeat(40)}!`;

describe('log tail grep — ReDoS containment', () => {
    it('matches a catastrophic pattern in bounded time (was ~59s per line)', () => {
        const predicate = buildGrepPredicate(EVIL_PATTERN);

        const started = process.hrtime.bigint();
        // Apply it the way a full-file scan would — many lines, not just one.
        for (let i = 0; i < 500; i++) predicate(EVIL_LINE);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

        // Pre-fix this exceeded 59_000ms for ONE line. Generous bound so the
        // assertion is about the blowup class, not machine speed.
        expect(elapsedMs).toBeLessThan(1000);
    });

    it('refuses to compile a catastrophic source, falling back to a literal', () => {
        const predicate = buildGrepPredicate(EVIL_PATTERN);
        expect(predicate.mode).toBe('literal');
        // Literal semantics: the raw source text is not present in the line.
        expect(predicate(EVIL_LINE)).toBe(false);
        expect(predicate(`prefix ${EVIL_PATTERN} suffix`)).toBe(true);
    });

    it.each([
        ['(a*)*b', 'nested star'],
        ['(a|aa)+$', 'alternation of repeatable atoms'],
        ['(x+x+)+y', 'adjacent quantifiers in a quantified group'],
        ['(\\w+\\s?)*$', 'quantified group with inner quantifiers'],
    ])('treats %s (%s) as a literal, not a regex', (pattern) => {
        expect(buildGrepPredicate(pattern).mode).toBe('literal');
    });

    it('still compiles simple, backtracking-safe regexes', () => {
        const predicate = buildGrepPredicate('dispatch|inject');
        expect(predicate.mode).toBe('regex');
        expect(predicate('[10:00:00] mesh dispatch sent')).toBe(true);
        expect(predicate('[10:00:00] INJECT forwarded')).toBe(true); // case-insensitive
        expect(predicate('[10:00:00] unrelated line')).toBe(false);
    });

    it('matches plain substrings literally without compiling', () => {
        const predicate = buildGrepPredicate('get_pending_mesh_events');
        expect(predicate.mode).toBe('literal');
        expect(predicate('[10:00:00] cmd get_pending_mesh_events ok')).toBe(true);
    });

    it('does not let a regex metachar in a literal source change semantics', () => {
        // A dot in a literal source must match a dot, not "any char".
        const predicate = buildGrepPredicate('node_84407c5a.events');
        expect(predicate('node_84407c5a.events')).toBe(true);
        if (predicate.mode === 'literal') {
            expect(predicate('node_84407c5aXevents')).toBe(false);
        }
    });

    it('exposes a pattern-length cap for callers to enforce', () => {
        expect(MAX_GREP_PATTERN_LENGTH).toBeGreaterThan(0);
        expect(MAX_GREP_PATTERN_LENGTH).toBeLessThanOrEqual(200);
    });
});
