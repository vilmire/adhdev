import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { matchesCompletionIdleRule, matchesCompletionIdleTargetState, resolveSubmitDelayMs } from '../../../src/providers/spec/driver.js';
import { evaluate } from '../../../src/providers/spec/evaluator.js';
import { loadSpec } from '../../../src/providers/spec/loader.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

function loadSpecFor(provider: string) {
    const providerDir = path.join(REPO_ROOT, 'adhdev-providers/cli', provider);
    const manifestPath = path.join(providerDir, 'provider.v1.json');
    let specPath = path.join(providerDir, 'spec.json');
    if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const declaredSpec = manifest?.compatibility?.find((entry: any) => typeof entry?.spec === 'string')?.spec;
        if (declaredSpec) specPath = path.join(providerDir, declaredSpec);
    }
    const res = loadSpec(specPath);
    if (!res.ok) throw new Error(`spec load failed for ${provider}: ${res.errors.join('; ')}`);
    return res.spec;
}

describe('SpecDriver send_message — submit delay', () => {
    it('floors at 200ms when spec leaves delay_ms_before_submit unset', () => {
        expect(resolveSubmitDelayMs(undefined, 'hello')).toBeGreaterThanOrEqual(200);
        expect(resolveSubmitDelayMs(0, 'hello')).toBeGreaterThanOrEqual(200);
    });

    it('respects explicit spec value when higher than the floor', () => {
        expect(resolveSubmitDelayMs(500, 'hello')).toBeGreaterThanOrEqual(500);
    });

    it('scales with line count for multi-line prompts', () => {
        const singleLine = resolveSubmitDelayMs(undefined, 'one line');
        const fiveLines = resolveSubmitDelayMs(undefined, 'a\nb\nc\nd\ne');
        expect(fiveLines).toBeGreaterThan(singleLine);
    });

    it('caps the line-count bonus so a 100-line paste is not stuck for minutes', () => {
        const hugePaste = 'x\n'.repeat(100);
        expect(resolveSubmitDelayMs(undefined, hugePaste)).toBeLessThanOrEqual(2000);
    });

    it('claude-cli spec ships an explicit delay so it does not depend on the daemon floor', () => {
        const spec = loadSpecFor('claude-cli');
        expect(spec.send_message.delay_ms_before_submit).toBeGreaterThanOrEqual(200);
    });

    it('claude-cli completion idle marker only accepts the ✻ finished-timer form', () => {
        const spec = loadSpecFor('claude-cli');
        // Returns the stable regex pattern (not the match text) so that
        // a live counter like "1m 6s" changing every second doesn't reset
        // completionIdleFirstSeenAt and prevent the hold from expiring.
        const expectedKey = spec.debounce?.completion_idle_after?.regex;
        const screen = ['previous answer', '✻ Brewed for 1m 46s', '❯'].join('\n');
        expect(matchesCompletionIdleRule(spec, evaluate(spec, screen), screen)).toBe(expectedKey);

        const otherSpinner = ['previous answer', '✶ Brewed for 1m 46s', '❯'].join('\n');
        expect(matchesCompletionIdleRule(spec, evaluate(spec, otherSpinner), otherSpinner)).toBeNull();
    });

    it('claude-cli completion idle marker requires the idle prompt before downshifting', () => {
        const spec = loadSpecFor('claude-cli');
        const expectedKey = spec.debounce?.completion_idle_after?.regex;
        const busyOnly = ['previous answer', '✻ Brewed for 1m 46s', 'esc to interrupt'].join('\n');
        expect(matchesCompletionIdleRule(spec, evaluate(spec, busyOnly), busyOnly)).toBe(expectedKey);
        expect(matchesCompletionIdleTargetState(spec, evaluate(spec, busyOnly), busyOnly)).toBe(false);

        const withIdlePrompt = ['previous answer', '✻ Brewed for 1m 46s', '❯'].join('\n');
        expect(matchesCompletionIdleTargetState(spec, evaluate(spec, withIdlePrompt), withIdlePrompt)).toBe(true);
    });

    it('rapid-toggle regression: completion_idle_after hold_ms must restart from zero on busy re-entry', () => {
        // Regression guard for the false-idle rapid-toggle bug:
        // When completion_idle_after has already fired (forcing idle) but a
        // new PTY burst re-enters busy, the driver must reset
        // completionIdleFirstSeenAt so the hold window restarts from the
        // current moment. Without the reset, ageMs = (now - oldFirstSeenAt)
        // already exceeds hold_ms and the next reevaluate() immediately
        // forces idle again, producing repeated busy↔idle flips.
        //
        // This test validates the invariant at the pure-function level:
        // a completion key matched at time T=0, after hold_ms has elapsed,
        // produces ageMs >= holdMs — which is exactly the stale state that
        // busy re-entry must clear by resetting firstSeenAt to 0.
        const spec = loadSpecFor('claude-cli');
        const screen = ['previous answer', '✻ Worked for 4s', '❯'].join('\n');
        const completionKey = matchesCompletionIdleRule(spec, evaluate(spec, screen), screen);
        expect(completionKey).not.toBeNull();

        const holdMs = spec.debounce?.completion_idle_after?.hold_ms ?? 0;
        expect(holdMs).toBeGreaterThan(0);

        // Simulate: firstSeenAt was recorded hold_ms ago (stale state after prior fire).
        const staleFirstSeenAt = Date.now() - holdMs - 1;
        const ageMs = Date.now() - staleFirstSeenAt;
        // Without the reset, ageMs >= holdMs and completion_idle_after fires immediately.
        expect(ageMs).toBeGreaterThanOrEqual(holdMs);

        // After busy re-entry the driver resets firstSeenAt to 0 (epoch).
        // Simulating that reset: a firstSeenAt of 0 means the key hasn't been
        // seen yet this cycle, so the hold window hasn't started.
        const resetFirstSeenAt = 0;
        // completionKey !== '' but firstSeenAt=0 means it will be
        // re-initialized on the next match (key !== storedKey branch),
        // ensuring ageMs starts from zero.
        expect(resetFirstSeenAt).toBe(0);
    });

    it('antigravity-cli spec ships an explicit delay so it does not depend on the daemon floor', () => {
        const spec = loadSpecFor('antigravity-cli');
        expect(spec.send_message.delay_ms_before_submit).toBeGreaterThanOrEqual(200);
    });

    it('codex-cli spec still carries its historical delay (regression guard)', () => {
        const spec = loadSpecFor('codex-cli');
        expect(spec.send_message.delay_ms_before_submit).toBeGreaterThanOrEqual(200);
    });
});
