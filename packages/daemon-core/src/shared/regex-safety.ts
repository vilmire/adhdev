/**
 * Shared ReDoS safety screen for regex sources that did not originate in this
 * codebase.
 *
 * Two consumers today, and they must share ONE policy rather than each growing
 * their own:
 *  - `logging/log-tail-reader.ts` — the mesh `get_mesh_node_logs` grep source,
 *    which any peer that can address a node picks.
 *  - `providers/spec/signal-rules.ts` — spec-declared signal-rule patterns,
 *    which arrive from provider channel bundles (published artifacts, not
 *    hand-audited code) and are applied to every rendered PTY frame.
 *
 * The measured incident that motivates the screen: compiling an unrestricted
 * source let a catastrophic-backtracking pattern such as `(a+)+$` stall the
 * daemon's event loop for ~59_000 ms on a single 40-char line. A PTY frame is
 * ~50 lines re-rendered several times a second, so the spec path multiplies
 * that exposure rather than reducing it.
 *
 * Node's RegExp has no execution timeout and no way to abort a running match,
 * so there is no "just time it out" option on this runtime — the only effective
 * mitigation is to refuse to compile a dangerous shape in the first place.
 * (A true linear-time engine — RE2 — is a native dependency; this daemon ships
 * to three platform-arch triplets and already carries native-binding pain in
 * ghostty-vt-node, so adding another is a poor trade for this surface.)
 *
 * The screen is intentionally STRICT and structural rather than a real analysis:
 * it rejects the shapes that make backtracking blow up. A false rejection costs
 * precision (the caller falls back to a literal match, or drops the rule) but
 * never availability — which is the correct direction for a daemon-wide loop.
 */
'use strict';

/** Regex metacharacters — their absence means the source is a plain literal. */
export const REGEX_METACHAR = /[\\^$.|?*+()[\]{}]/;

/**
 * Conservative safety screen for a source we are willing to compile.
 *
 * Rejects the constructs that make backtracking blow up rather than trying to
 * analyse the pattern properly: a quantifier applied to a group that itself
 * contains a quantifier (`(a+)+`, `(a*)*`, `(a|aa)+`), two quantifiers in a row
 * (`a+*`), and backreferences (`\1`). It is intentionally strict — a rejected
 * pattern still matches, as a literal, so a false negative costs precision but
 * never availability.
 */
export function isBacktrackingSafeRegexSource(source: string): boolean {
    if (/\\[1-9]/.test(source)) return false; // backreference
    if (/[*+?}][*+]/.test(source)) return false; // stacked quantifiers: a+*, a{2,}+

    // Walk the source tracking group spans so we can reject a quantified group
    // that contains a quantifier or an alternation of repeatable atoms.
    const openStack: number[] = [];
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === '\\') { i++; continue; } // skip the escaped char
        if (ch === '[') { // skip a character class wholesale
            i++;
            while (i < source.length && source[i] !== ']') {
                if (source[i] === '\\') i++;
                i++;
            }
            continue;
        }
        if (ch === '(') { openStack.push(i); continue; }
        if (ch === ')') {
            const start = openStack.pop();
            if (start === undefined) return false; // unbalanced — let it fail to compile
            const next = source[i + 1];
            const groupIsQuantified = next === '*' || next === '+' || next === '?' || next === '{';
            if (groupIsQuantified) {
                const body = source.slice(start + 1, i);
                // A quantifier or alternation inside a quantified group is the
                // classic exponential shape.
                if (/[*+{]/.test(body.replace(/\\./g, '')) || body.includes('|')) return false;
            }
        }
    }
    return openStack.length === 0;
}
