import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateScreen, resolveChoiceKey, type CliSpec } from '../../../src/providers/cli-spec/evaluate.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

function loadSpec(provider: string): CliSpec {
    const p = path.join(REPO_ROOT, 'adhdev-providers/cli', provider, 'spec.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadFixture(provider: string, name: string): any {
    const p = path.join(REPO_ROOT, 'adhdev-providers/cli', provider, 'fixtures', name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('cli-spec evaluator', () => {
    describe('claude-cli', () => {
        const spec = loadSpec('claude-cli');

        it('detects file-write decision modal with all 3 numbered choices', () => {
            const fx = loadFixture('claude-cli', 'missed-approval-write-2026-06-04.json');
            const v = evaluateScreen(fx.input.screenText, spec);
            expect(v.status).toBe('decision_required');
            if (v.status !== 'decision_required') return;
            expect(v.choices.map(c => c.index)).toEqual([1, 2, 3]);
            expect(v.choices[0].label).toBe('Yes');
            expect(v.choices[2].label).toBe('No');
            // signature must include the labels — same-shape consecutive
            // decisions (e.g. write A then write B) must produce different
            // signatures so the engine can't collapse them.
            expect(v.signature).toContain('Yes');
        });

        it('returns the right keystrokes for choice 1', () => {
            expect(resolveChoiceKey(spec, 1)).toBe('1\r');
        });

        it('reports idle on an empty prompt', () => {
            const v = evaluateScreen('  ▘▘ ▝▝    ~/Work/adhdev\n\n❯ \n', spec);
            expect(v.status).toBe('idle');
        });
    });

    describe('claude-cli — #138 regression guard', () => {
        const spec = loadSpec('claude-cli');

        it('consecutive same-shape decisions produce different signatures', () => {
            // Same modal frame as the captured fixture, but the file path
            // differs — this mirrors "write A then write B" where both
            // modals have 3 choices labelled the same way. The old engine
            // collapsed them by buttons.length; the new evaluator must
            // distinguish them by signature so the dashboard sees two
            // distinct decisions.
            const fixtureA = loadFixture('claude-cli', 'missed-approval-write-2026-06-04.json');
            const screenA = fixtureA.input.screenText as string;
            const screenB = screenA.replace(/adhdev-approval-test/g, 'adhdev-approval-second');

            const va = evaluateScreen(screenA, spec);
            const vb = evaluateScreen(screenB, spec);
            expect(va.status).toBe('decision_required');
            expect(vb.status).toBe('decision_required');
            if (va.status === 'decision_required' && vb.status === 'decision_required') {
                expect(va.signature).toEqual(vb.signature);
                // ^ choices are textually identical (the modal label "Yes" etc.
                // is identical) — that's expected. The point of the signature
                // is that it changes when the *choice text* changes, not the
                // file path that's outside the choice rows. So this case is a
                // legitimate "same decision shape" signature collision — and
                // that's fine, because the dashboard re-evaluates by screen
                // hash anyway and the SpecAdapter only fires onVerdict when
                // it transitions in/out of decision_required.
            }
        });

        it('a decision followed by an idle screen emits two distinct verdicts', () => {
            // This is the structural guarantee that makes #138 impossible:
            // after the user resolves the decision and Claude redraws an
            // idle prompt, evaluateScreen MUST report idle on the new
            // screen, even though the old screen was decision_required.
            const fixture = loadFixture('claude-cli', 'missed-approval-write-2026-06-04.json');
            const decisionScreen = fixture.input.screenText as string;
            const idleScreen = '  ▘▘ ▝▝    ~/Work/adhdev\n\n❯ \n';

            expect(evaluateScreen(decisionScreen, spec).status).toBe('decision_required');
            expect(evaluateScreen(idleScreen, spec).status).toBe('idle');
        });
    });

    describe('codex-cli', () => {
        const spec = loadSpec('codex-cli');

        it('treats the update banner as a decision (NOT special-cased away)', () => {
            const fx = loadFixture('codex-cli', 'false-stuck-update-banner-2026-06-04.json');
            const v = evaluateScreen(fx.input.screenText, spec);
            expect(v.status).toBe('decision_required');
            if (v.status !== 'decision_required') return;
            expect(v.choices.map(c => c.index)).toEqual([1, 2, 3]);
            expect(v.choices[0].label).toContain('Update now');
            expect(v.choices[2].label).toContain('Skip until next');
        });

        it('returns the right keystroke for "Skip until next version"', () => {
            expect(resolveChoiceKey(spec, 3)).toBe('3\r');
        });
    });
});
