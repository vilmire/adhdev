/**
 * Single evaluator for the unified CLI provider spec (adhdev:cli/spec@1).
 *
 * Input: a screen snapshot (the terminal as the user sees it right now)
 *        and the provider spec.
 * Output: one verdict.
 *
 * Verdicts are derived purely from the current screen. There is no
 * cached `activeModal` mirror, no cooldown, no debounce — every call is
 * a clean re-derivation. If consecutive same-shape decisions appear,
 * each one is its own verdict because we compare the choice TEXT, not
 * the choice count.
 */
'use strict';

export interface CliSpec {
    id: string;
    binary: string;
    spawn_args?: string[];
    send: { submit: string };
    decision: {
        numbered_choice_pattern: string;
        footer_patterns: string[];
        min_choices: number;
        choice_key: string;
    };
    busy: { patterns: string[] };
    idle: { patterns: string[] };
}

export interface DecisionVerdict {
    status: 'decision_required';
    choices: { index: number; label: string }[];
    signature: string;
}

export interface SimpleVerdict {
    status: 'busy' | 'idle' | 'unknown';
}

export type Verdict = DecisionVerdict | SimpleVerdict;

function stripAnsi(text: string): string {
    return text
        .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.max(1, Number(n) || 1)))
        .replace(/\x1b\[\d*D/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n|$))/g, '')
        .replace(/\x1b[P^_X][\s\S]*?(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b(?:[@-Z\\-_])/g, '')
        .replace(//g, '');
}

function anyMatch(text: string, patterns: string[]): boolean {
    for (const p of patterns) {
        if (new RegExp(p, 'i').test(text)) return true;
    }
    return false;
}

function fingerprintChoices(choices: { index: number; label: string }[]): string {
    return choices.map(c => `${c.index}|${c.label}`).join('\n');
}

export function evaluateScreen(screenText: string, spec: CliSpec): Verdict {
    const text = stripAnsi(String(screenText || ''));
    if (!text.trim()) return { status: 'unknown' };

    // ── 1. Decision detection ────────────────────────────────────────────
    // Numbered choices on consecutive (allowing wrap-continued) lines,
    // backed by a footer phrase from the spec. Scoped by footer position
    // so a choice list earlier in the transcript (e.g. an assistant's
    // numbered prose) cannot trip detection.
    const footerHit = (() => {
        for (const fp of spec.decision.footer_patterns) {
            const m = new RegExp(fp, 'i').exec(text);
            if (m && typeof m.index === 'number') return m.index;
        }
        return -1;
    })();

    if (footerHit >= 0) {
        // Look at the ~30 lines immediately above the footer hit.
        const before = text.slice(0, footerHit);
        const lines = before.split('\n').slice(-30);
        const choiceRe = new RegExp(spec.decision.numbered_choice_pattern);
        const choices: { index: number; label: string }[] = [];
        for (const raw of lines) {
            const m = choiceRe.exec(raw);
            if (!m) continue;
            const idx = Number(m[1]);
            const label = String(m[2] || '').trim();
            if (!Number.isFinite(idx) || idx <= 0 || !label) continue;
            // Skip duplicates (same index already captured) — wrapping
            // can re-emit the leading char on a second physical row.
            if (choices.some(c => c.index === idx)) continue;
            choices.push({ index: idx, label });
        }
        choices.sort((a, b) => a.index - b.index);
        if (choices.length >= spec.decision.min_choices) {
            return {
                status: 'decision_required',
                choices,
                signature: fingerprintChoices(choices),
            };
        }
    }

    // ── 2. Simple states ─────────────────────────────────────────────────
    if (anyMatch(text, spec.busy.patterns)) return { status: 'busy' };
    if (anyMatch(text, spec.idle.patterns)) return { status: 'idle' };
    return { status: 'unknown' };
}

export function resolveChoiceKey(spec: CliSpec, choiceIndex: number): string {
    return spec.decision.choice_key.replace(/\{index\}/g, String(choiceIndex));
}
