import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSubmitDelayMs } from '../../../src/providers/spec/fsm-driver.js';
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
