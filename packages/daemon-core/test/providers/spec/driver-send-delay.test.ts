import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    resolveSubmitDelayMs,
    resolveEchoConfirmPolicy,
    shouldUseVerifiedSubmit,
    VERIFIED_SUBMIT_MIN_CHARS,
} from '../../../src/providers/spec/fsm-driver.js';
import { loadFsmSpec } from '../../../src/providers/spec/fsm-loader.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

function loadSpecFor(provider: string): { send_message: { delay_ms_before_submit?: number } } {
    const providerDir = path.join(REPO_ROOT, 'adhdev-providers/cli', provider);
    const manifestPath = path.join(providerDir, 'provider.v1.json');
    let specPath = path.join(providerDir, 'spec.json');
    if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const declaredSpec = manifest?.compatibility?.find((entry: any) => typeof entry?.spec === 'string')?.spec;
        if (declaredSpec) specPath = path.join(providerDir, declaredSpec);
    }
    const res = loadFsmSpec(specPath);
    if (!res.ok) throw new Error(`spec load failed for ${provider}: ${res.errors.join('; ')}`);
    return res.spec;
}

/** The manifest (provider.v1.json) as shipped — the declaration side of the pair. */
function loadManifestFor(provider: string): { sendDelayMs?: number; submitStrategy?: string } {
    const manifestPath = path.join(REPO_ROOT, 'adhdev-providers/cli', provider, 'provider.v1.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/** Every shipped CLI provider that declares a manifest sendDelayMs. */
const SHIPPED_CLI_PROVIDERS = [
    'antigravity-cli', 'claude-cli', 'codex-cli', 'cursor-cli',
    'grok-cli', 'hermes-cli', 'kimi', 'opencode',
];

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

    it('antigravity-cli spec ships an explicit delay so it does not depend on the daemon floor', () => {
        const spec = loadSpecFor('antigravity-cli');
        expect(spec.send_message.delay_ms_before_submit).toBeGreaterThanOrEqual(200);
    });

    it('codex-cli spec still carries its historical delay (regression guard)', () => {
        const spec = loadSpecFor('codex-cli');
        expect(spec.send_message.delay_ms_before_submit).toBeGreaterThanOrEqual(200);
    });
});

// ── MANIFEST-SEND-DELAY ──────────────────────────────────────────────────────
// The manifest's `sendDelayMs` was dead on the spec path: its only reader belonged
// to the ProviderCliAdapter engine deleted in 48e5ed1a. A manifest could therefore
// declare 1200ms and silently run at 200ms — which actively misled a live
// investigation into a grok-cli submit failure.
describe('SpecDriver send_message — manifest sendDelayMs is honoured', () => {
    it('a manifest sendDelayMs above the computed delay becomes the delay', () => {
        // Short body ⇒ heuristic returns the 200ms floor; the manifest asks for 1200.
        expect(resolveSubmitDelayMs(200, 'hi', 1200)).toBe(1200);
    });

    it('reproduces the grok-cli case: declared 1200 is what actually runs', () => {
        const manifest = loadManifestFor('grok-cli');
        const spec = loadSpecFor('grok-cli');
        // The exact pairing that caused the misdirection: manifest 1200 vs spec 200.
        expect(manifest.sendDelayMs).toBe(1200);
        expect(spec.send_message.delay_ms_before_submit).toBe(200);

        const wired = resolveSubmitDelayMs(spec.send_message.delay_ms_before_submit, 'hi', manifest.sendDelayMs);
        const dead = resolveSubmitDelayMs(spec.send_message.delay_ms_before_submit, 'hi');
        expect(dead).toBe(200);          // the old, misleading behaviour
        expect(wired).toBe(1200);        // the manifest is no longer a lie
    });

    it('every shipped manifest sendDelayMs is actually reachable as the effective delay', () => {
        for (const provider of SHIPPED_CLI_PROVIDERS) {
            const manifest = loadManifestFor(provider);
            if (typeof manifest.sendDelayMs !== 'number') continue;
            const spec = loadSpecFor(provider);
            const effective = resolveSubmitDelayMs(spec.send_message.delay_ms_before_submit, 'hi', manifest.sendDelayMs);
            expect(effective, `${provider} must wait at least its declared sendDelayMs`)
                .toBeGreaterThanOrEqual(manifest.sendDelayMs);
        }
    });

    // ── Over-correction guard 1: providers declaring nothing are untouched ──
    it('a provider with no manifest sendDelayMs behaves exactly as before', () => {
        for (const text of ['hi', 'a\nb\nc\nd\ne', 'x'.repeat(4000), 'y\n'.repeat(100)]) {
            for (const specDelay of [undefined, 0, 200, 500, 1200]) {
                expect(resolveSubmitDelayMs(specDelay, text, undefined))
                    .toBe(resolveSubmitDelayMs(specDelay, text));
            }
        }
    });

    // ── Over-correction guard 2: the manifest is a FLOOR, never a reduction ──
    it('a manifest sendDelayMs can never shorten the spec or size-derived delay', () => {
        const bigBody = 'x'.repeat(6000);
        const withoutManifest = resolveSubmitDelayMs(1200, bigBody);
        // A manifest asking for far LESS must not drag the delay down.
        expect(resolveSubmitDelayMs(1200, bigBody, 1)).toBe(withoutManifest);
        expect(resolveSubmitDelayMs(1200, bigBody, 0)).toBe(withoutManifest);
        // Nor may it undercut a higher spec value on a short body.
        expect(resolveSubmitDelayMs(1200, 'hi', 300)).toBe(1200);
    });

    it('ignores a non-finite or negative manifest value instead of poisoning the max', () => {
        const baseline = resolveSubmitDelayMs(200, 'hi');
        expect(resolveSubmitDelayMs(200, 'hi', Number.NaN)).toBe(baseline);
        expect(resolveSubmitDelayMs(200, 'hi', Number.POSITIVE_INFINITY)).toBe(baseline);
        expect(resolveSubmitDelayMs(200, 'hi', -500)).toBe(baseline);
    });

    it('keeps the delay bounded so a wired manifest cannot stall a send indefinitely', () => {
        const worst = Math.max(
            ...SHIPPED_CLI_PROVIDERS.map((p) => {
                const m = loadManifestFor(p);
                return resolveSubmitDelayMs(loadSpecFor(p).send_message.delay_ms_before_submit, 'x'.repeat(8000), m.sendDelayMs);
            }),
        );
        // Well under the echo-gate's own 20s blind-fire backstop, so wiring the
        // manifest can never push the opening wait past the submit machinery.
        expect(worst).toBeLessThanOrEqual(2000);
    });
});

// ── MANIFEST-SUBMIT-STRATEGY ─────────────────────────────────────────────────
describe('SpecDriver send_message — submitStrategy cannot disable echo confirmation', () => {
    // ── Over-correction guard 3: echo-confirm (d7332b84) stays alive ──
    it('no declared strategy — including "immediate" — may switch off echo confirmation', () => {
        expect(resolveEchoConfirmPolicy('wait_for_echo').mayDisableEchoConfirm).toBe(false);
        expect(resolveEchoConfirmPolicy('immediate').mayDisableEchoConfirm).toBe(false);
        expect(resolveEchoConfirmPolicy(undefined).mayDisableEchoConfirm).toBe(false);
    });

    it('echo-verified submit is still chosen by body size and platform', () => {
        const big = 'x'.repeat(VERIFIED_SUBMIT_MIN_CHARS);
        expect(shouldUseVerifiedSubmit(big, 'darwin')).toBe(true);
        expect(shouldUseVerifiedSubmit(big, 'linux')).toBe(true);
        expect(shouldUseVerifiedSubmit('short', 'win32')).toBe(true);
        // Short POSIX bodies keep the zero-added-latency immediate path.
        expect(shouldUseVerifiedSubmit('short', 'darwin')).toBe(false);
    });

    it('every shipped manifest declares wait_for_echo, which the gate already provides', () => {
        for (const provider of SHIPPED_CLI_PROVIDERS) {
            const declared = loadManifestFor(provider).submitStrategy;
            if (declared === undefined) continue;
            expect(declared, `${provider} unexpectedly declares a non-echo strategy`).toBe('wait_for_echo');
        }
    });
});
