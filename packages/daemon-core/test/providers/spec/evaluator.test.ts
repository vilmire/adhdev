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

    it('recognizes wrapped Codex shell escalation prompts and preserves labels', () => {
        const screen = [
            'Earlier transcript line 1',
            'Earlier transcript line 2',
            'Earlier transcript line 3',
            'Earlier transcript line 4',
            'Earlier transcript line 5',
            'Earlier transcript line 6',
            'Earlier transcript line 7',
            'Earlier transcript line 8',
            'Earlier transcript line 9',
            'Would you like to run the following command?',
            '',
            'Reason: The patched standalone is listening on 127.0.0.1:3848 but sandbox curl cannot connect;',
            'allow reading the local smoke-test status outside the sandbox?',
            '',
            '$ curl -sS http://127.0.0.1:3848/api/v1/status | node -e "let',
            '  s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{const',
            '  j=JSON.parse(s);console.log(JSON.stringify(j.sessions?.[0]?.activeModal));})"',
            '› 1. Yes, proceed (y)',
            '  2. Yes, and don\'t ask again for commands that start with `node -e "let',
            '     s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{const',
            '     j=JSON.parse(s);console.log(JSON.stringify(j.sessions?.[0]?.activeModal));})"` (p)',
            '  3. No, and tell Codex what to do differently (esc)',
            'Press enter to confirm or esc to cancel',
            '›',
        ].join('\n');
        const ev = evaluate(spec, screen);
        expect(ev.state.id).toBe('approval');
        expect(ev.modal?.title).toBe('Would you like to run the following command?');
        expect(ev.modal?.buttons.map(button => button.label)).toEqual([
            'Yes, proceed (y)',
            'Yes, and don\'t ask again for commands that start with `node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.sessions?.[0]?.activeModal));})"` (p)',
            'No, and tell Codex what to do differently (esc)',
        ]);
    });
});

// ── Minimal inline spec factory for cursor-position tests ───────────────────

function minimalSpec(overrides: {
    states?: any[];
    sections?: any[];
    default_state?: string;
} = {}): CliSpec {
    return {
        $schema: 'adhdev:cli/spec@1' as any,
        id: 'test-cursor',
        name: 'Test Cursor',
        binary: 'test',
        spawn_args: [],
        send_message: { submit_key: '\r' },
        layout: {
            sections: overrides.sections ?? [
                { id: 'body', from_top: 0 },
                { id: 'footer', from_bottom: 4 },
            ],
        },
        states: overrides.states ?? [
            { id: 'idle', label: 'Idle', when: { regex: '.' } },
        ],
        default_state: overrides.default_state ?? 'idle',
    } as unknown as CliSpec;
}

// Build a 32-row terminal screen where the approval question appears both in
// the body (row 5) and in the modal_zone (row 20). The cursor alternates.
function buildDualZoneScreen(): string {
    const rows: string[] = [];
    for (let i = 0; i < 32; i++) {
        if (i === 5)  rows.push('  Do you want to proceed?');
        else if (i === 20) rows.push('  Do you want to proceed?');
        else rows.push('');
    }
    return rows.join('\n');
}

describe('spec evaluator — cursor position guards', () => {
    it('matches state when no cursor predicates and cursor is not supplied (backward compat)', () => {
        const spec = minimalSpec({
            states: [{ id: 'approval', label: 'Approval', when: { section: 'body', regex: 'Do you want' } }, { id: 'idle', label: 'Idle', when: { regex: '.' } }],
            default_state: 'idle',
        });
        const screen = 'Do you want to proceed?\n\n';
        const ev = evaluate(spec, screen);
        expect(ev.state.id).toBe('approval');
    });

    it('matches state when cursor predicates are met', () => {
        const spec = minimalSpec({
            states: [
                {
                    id: 'modal',
                    label: 'Modal',
                    // Only matches when cursor is in modal zone (rows 8-31 of 32-row terminal)
                    when: { regex: 'Do you want', cursor_row_min: 8, cursor_row_max: 31 },
                },
                { id: 'idle', label: 'Idle', when: { regex: '.' } },
            ],
            default_state: 'idle',
        });
        const screen = buildDualZoneScreen();
        // Cursor in modal zone → should match modal state
        const ev = evaluate(spec, screen, { row: 20, col: 0 });
        expect(ev.state.id).toBe('modal');
    });

    it('rejects state when cursor row is below cursor_row_min', () => {
        const spec = minimalSpec({
            states: [
                {
                    id: 'modal',
                    label: 'Modal',
                    when: { regex: 'Do you want', cursor_row_min: 8 },
                },
                { id: 'idle', label: 'Idle', when: { regex: '.' } },
            ],
            default_state: 'idle',
        });
        const screen = buildDualZoneScreen();
        // Cursor in body zone (row 5 < cursor_row_min 8) → should skip modal, fall to idle
        const ev = evaluate(spec, screen, { row: 5, col: 0 });
        expect(ev.state.id).toBe('idle');
        // Trace should include the skip reason
        const skipEntry = ev.trace.find(t => t.kind === 'state_skip' && t.text.includes('cursor row'));
        expect(skipEntry).toBeTruthy();
        expect(skipEntry!.text).toContain('cursor_row_min');
    });

    it('rejects state when cursor row exceeds cursor_row_max', () => {
        const spec = minimalSpec({
            states: [
                {
                    id: 'footer_only',
                    label: 'Footer',
                    when: { regex: 'status', cursor_row_max: 28 },
                },
                { id: 'idle', label: 'Idle', when: { regex: '.' } },
            ],
            default_state: 'idle',
        });
        const rows = Array.from({ length: 32 }, (_, i) => i === 30 ? 'status ok' : '');
        const screen = rows.join('\n');
        // Cursor at row 30 > max 28 → skip footer_only
        const ev = evaluate(spec, screen, { row: 30, col: 5 });
        expect(ev.state.id).toBe('idle');
        expect(ev.trace.some(t => t.kind === 'state_skip' && t.text.includes('cursor_row_max'))).toBe(true);
    });

    it('applies cursor_col_min / cursor_col_max predicates', () => {
        const spec = minimalSpec({
            states: [
                {
                    id: 'picker',
                    label: 'Picker',
                    // Only active when cursor is in right half (col >= 40)
                    when: { regex: 'Select:', cursor_col_min: 40 },
                },
                { id: 'idle', label: 'Idle', when: { regex: '.' } },
            ],
            default_state: 'idle',
        });
        const screen = 'Select: option 1\nSelect: option 2\n';
        // Cursor at col 45 → match
        expect(evaluate(spec, screen, { row: 0, col: 45 }).state.id).toBe('picker');
        // Cursor at col 10 → skip
        expect(evaluate(spec, screen, { row: 0, col: 10 }).state.id).toBe('idle');
    });

    it('ignores cursor predicates when cursor is not supplied (text-only mode)', () => {
        const spec = minimalSpec({
            states: [
                {
                    id: 'modal',
                    label: 'Modal',
                    when: { regex: 'Do you want', cursor_row_min: 8 },
                },
                { id: 'idle', label: 'Idle', when: { regex: '.' } },
            ],
            default_state: 'idle',
        });
        const screen = buildDualZoneScreen();
        // No cursor supplied → cursor predicates are skipped entirely → modal still matches
        const ev = evaluate(spec, screen);
        expect(ev.state.id).toBe('modal');
    });

    it('spec schema accepts cursor_row_min/max fields in sectionRegex (v1 migrated to v3)', () => {
        // v1 spec with cursor guards in when.regex — after migration the guards
        // live in the first condition of when.all[0].cursor_row_min.
        const specObj = {
            $schema: 'adhdev:cli/spec@1',
            id: 'cursor-test', name: 'Cursor Test', binary: 'test',
            send_message: { submit_key: '\r' },
            layout: { sections: [{ id: 'body', from_top: 0 }] },
            states: [{
                id: 'approval', label: 'Approval',
                when: { regex: 'Do you want', cursor_row_min: 8, cursor_row_max: 31 },
            }, { id: 'idle', label: 'Idle', when: { regex: '.' } }],
            default_state: 'idle',
        };
        const tmp = path.join(__dirname, `tmp-cursor-spec-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(specObj));
        const res = loadSpec(tmp);
        fs.unlinkSync(tmp);
        expect(res.ok).toBe(true);
        if (res.ok) {
            const approvalState = res.spec.states.find((s: any) => s.id === 'approval');
            // v3 format: cursor guards are in when.all[0] (the migrated RegexCondition)
            const whenCond = (approvalState?.when as any)?.all?.[0];
            expect(whenCond?.cursor_row_min).toBe(8);
            expect(whenCond?.cursor_row_max).toBe(31);
        }
    });

    it('cursor position is included in trace when supplied', () => {
        const spec = minimalSpec({
            states: [{ id: 'idle', label: 'Idle', when: { regex: '.' } }],
        });
        const ev = evaluate(spec, 'hello world', { row: 15, col: 7 });
        const cursorEntry = ev.trace.find(t => t.text.includes('cursor (15, 7)'));
        expect(cursorEntry).toBeTruthy();
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
