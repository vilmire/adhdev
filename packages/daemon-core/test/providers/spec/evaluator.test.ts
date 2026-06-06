import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '../../../src/providers/spec/evaluator.js';
import { loadSpec } from '../../../src/providers/spec/loader.js';
import type { CliSpec } from '../../../src/providers/spec/types.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

function loadSpecFor(provider: string): CliSpec {
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

function loadSpecResultFor(provider: string) {
    const providerDir = path.join(REPO_ROOT, 'adhdev-providers/cli', provider);
    const manifestPath = path.join(providerDir, 'provider.v1.json');
    let specPath = path.join(providerDir, 'spec.json');
    if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const declaredSpec = manifest?.compatibility?.find((entry: any) => typeof entry?.spec === 'string')?.spec;
        if (declaredSpec) specPath = path.join(providerDir, declaredSpec);
    }
    return loadSpec(specPath);
}

function loadFixture(provider: string, name: string): any {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'adhdev-providers/cli', provider, 'fixtures', name), 'utf8'));
}

describe('spec evaluator — claude-cli', () => {
    const spec = loadSpecFor('claude-cli');

    it('hits the approval state on the write-modal fixture', () => {
        const fx = loadFixture('claude-cli', 'missed-approval-write-2026-06-04.json');
        const ev = evaluate(spec, fx.input.screenText);
        expect(ev.state.id).toBe('approval');
        expect(ev.state.label).toBe('Approval requested');
        expect(ev.state.title).toContain('create');
        expect(ev.modal).not.toBeNull();
        expect(ev.modal!.buttons.map(b => b.label)).toEqual([
            'Yes',
            "Yes, allow all edits in tmp/ during this session (shift+tab)",
            'No',
        ]);
        expect(ev.modal!.buttons[0].key).toBe('1\r');
        expect(ev.notifications.map(n => n.id)).toContain('approval_needed');
        expect(ev.notifications[0].body).toContain('create');
    });

    it('falls back to idle on a bare prompt screen', () => {
        const ev = evaluate(spec, '  ▘▘ ▝▝    ~/Work/adhdev\n\n❯ \n');
        expect(ev.state.id).toBe('idle');
        expect(ev.modal).toBeNull();
    });

    it('emits trace entries for sections and state matches', () => {
        const fx = loadFixture('claude-cli', 'missed-approval-write-2026-06-04.json');
        const ev = evaluate(spec, fx.input.screenText);
        const kinds = new Set(ev.trace.map(t => t.kind));
        expect(kinds.has('section')).toBe(true);
        expect(kinds.has('state_match')).toBe(true);
        expect(kinds.has('modal')).toBe(true);
    });

    it('control_bar visibility tracks the active state', () => {
        const fx = loadFixture('claude-cli', 'missed-approval-write-2026-06-04.json');
        const ev = evaluate(spec, fx.input.screenText);
        const visibleIds = ev.controls.map(c => c.id);
        // approval state — stop is busy-only, model+image are idle-only, so none visible
        expect(visibleIds).not.toContain('stop');
        expect(visibleIds).not.toContain('set_model');
        expect(visibleIds).not.toContain('attach_image');

        const ev2 = evaluate(spec, '\n❯ \n');
        const idleIds = ev2.controls.map(c => c.id);
        expect(idleIds).toContain('set_model');
        expect(idleIds).toContain('attach_image');
    });
});

describe('spec evaluator — codex-cli', () => {
    const spec = loadSpecFor('codex-cli');

    it('hits update_banner state on the codex update fixture', () => {
        const fx = loadFixture('codex-cli', 'false-stuck-update-banner-2026-06-04.json');
        const ev = evaluate(spec, fx.input.screenText);
        expect(ev.state.id).toBe('update_banner');
        expect(ev.state.label).toBe('Update available');
        expect(ev.modal).not.toBeNull();
        expect(ev.modal!.buttons.length).toBeGreaterThanOrEqual(2);
        expect(ev.modal!.buttons[0].label).toContain('Update now');
    });

    it('recognizes the current Codex shell approval prompt', () => {
        const screen = [
            'Would you like to run the following command?',
            '',
            'Reason: Allow the exact curl command to access the network.',
            '',
            '$ curl -I https://example.com',
            '',
            '› 1. Yes, proceed (y)',
            "  2. Yes, and don't ask again for commands that start with `curl -I` (p)",
            '  3. No, and tell Codex what to do differently (esc)',
            '',
            'Press enter to confirm or esc to cancel',
            '›',
        ].join('\n');
        const ev = evaluate(spec, screen);
        expect(ev.state.id).toBe('approval');
        expect(ev.modal?.title).toBe('Would you like to run the following command?');
        expect(ev.modal?.buttons.map(button => button.label)).toEqual([
            'Yes, proceed (y)',
            "Yes, and don't ask again for commands that start with `curl -I` (p)",
            'No, and tell Codex what to do differently (esc)',
        ]);
        expect(ev.modal?.buttons[0].key).toBe('1\r');
    });
});

describe('spec loader — strict validation', () => {
    it('rejects a spec with unknown top-level field', () => {
        const bad = {
            $schema: 'adhdev:cli/spec@1',
            id: 'x', name: 'X', binary: 'x',
            send_message: { submit_key: '\r' },
            layout: { sections: [{ id: 'footer', from_bottom: 5 }] },
            states: [{ id: 'idle', label: 'Idle', when: { regex: '.' } }],
            default_state: 'idle',
            UNKNOWN_FIELD: 1,
        };
        const tmp = path.join(__dirname, 'tmp-bad-1.json');
        fs.writeFileSync(tmp, JSON.stringify(bad));
        const res = loadSpec(tmp);
        fs.unlinkSync(tmp);
        expect(res.ok).toBe(false);
    });

    it('rejects a spec whose default_state is not defined', () => {
        const bad = {
            $schema: 'adhdev:cli/spec@1',
            id: 'x', name: 'X', binary: 'x',
            send_message: { submit_key: '\r' },
            layout: { sections: [{ id: 'footer', from_bottom: 5 }] },
            states: [{ id: 'idle', label: 'Idle', when: { regex: '.' } }],
            default_state: 'NOPE',
        };
        const tmp = path.join(__dirname, 'tmp-bad-2.json');
        fs.writeFileSync(tmp, JSON.stringify(bad));
        const res = loadSpec(tmp);
        fs.unlinkSync(tmp);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('; ')).toContain('NOPE');
    });

    it('accepts both providers shipped in this repo', () => {
        expect(loadSpecResultFor('claude-cli').ok).toBe(true);
        expect(loadSpecResultFor('codex-cli').ok).toBe(true);
    });
});
