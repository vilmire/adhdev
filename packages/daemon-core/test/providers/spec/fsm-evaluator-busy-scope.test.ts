import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFsm } from '../../../src/providers/spec/fsm-evaluator.js';
import { collectFsmSpecWarnings, validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import { projectAdapterStatus } from '../../../src/providers/spec/adapter-status-projection.js';

const cliRoot = path.resolve(__dirname, '../../../../../../adhdev-providers/cli');
const cases = [
    { provider: 'cursor-cli', spec: 'cursor-cli/specs/1.0.json', idle: ['  Auto · 27.2% Run Everything', '  /synthetic/workspace'], busy: ['   ⠋ Working…', '  /synthetic/workspace'], markers: ['⠋ Working…', 'Working tree is clean', 'esc to cancel'] },
    { provider: 'grok-cli', spec: 'grok-cli/specs/1.0.json', idle: ['  Shift+Tab:mode │ Ctrl+x:shortcuts'], busy: ['  ⠦ Synthetic task… 2.5s [stop]', '  Shift+Tab:mode │ Esc:cancel │ Ctrl+x:shortcuts'], markers: ['⠦ Synthetic task… 2.5s', '[stop]', 'Esc:cancel'] },
    { provider: 'opencode', spec: 'opencode/specs/1.0.json', idle: ['  ╹▀', '  /synthetic/workspace'], busy: ['  ■■⬝⬝', '  esc interrupt'], markers: ['■■⬝⬝', 'esc interrupt'] },
];

// Shape-guard trap (B) treats load() as a path helper whose LAST join segment is
// the call argument. Keep the provider id out of the mid-path so the gate resolves
// adhdev-providers/cli/<provider>/specs/1.0.json (not cli/specs/1.0.json/<provider>).
function load(specRel: string): CliSpecV4 {
    return JSON.parse(fs.readFileSync(path.join(cliRoot, specRel), 'utf8'));
}

// Model the driver's 200-line guard frame, with old activity above the tail.
function frame(body: string[], tail: string[]): string[] {
    return [...body, ...Array.from({ length: 200 - body.length - tail.length }, () => '  synthetic settled output'), ...tail];
}

function fire(spec: CliSpecV4, from: string, lines: string[], stableFor = 9000) {
    return evaluateFsm(spec, from, lines.join('\n'), { row: 199, col: 0 }, lines, {
        now: 10_000,
        stateEnteredAt: 1000,
        regionLastChangedAt: new Map([['section:status_tail', 10_000 - stableFor]]),
    }).fired;
}

describe.each(cases)('$provider busy-entry scope', ({ provider, spec: specRel, idle, busy, markers }) => {
    it('loads without ignored composite-section warnings', () => {
        const spec = load(specRel);
        expect(validateFsmSpec(spec)).toEqual([]);
        expect(collectFsmSpecWarnings(spec).filter(w => w.includes('ignored'))).toEqual([]);
    });

    it.each(markers)('ignores stale body marker %s and stays idle after busy→idle', marker => {
        const spec = load(specRel);
        const lines = frame([marker], idle);
        expect(fire(spec, 'idle', lines)).toBeNull();
        expect(fire(spec, 'busy', lines)?.to).toBe('idle');
        // The same completed footer must not start another generating cycle.
        expect(fire(spec, 'idle', lines)).toBeNull();
    });

    it('enters busy for real tail activity and cannot exit while active', () => {
        const spec = load(specRel);
        const lines = frame([], busy);
        expect(fire(spec, 'idle', lines)?.to).toBe('busy');
        if (provider !== 'grok-cli') expect(fire(spec, 'starting', lines)?.to).toBe('busy');
        else {
            // Grok's existing startup-grace has priority, then idle sees the tail.
            expect(fire(spec, 'starting', lines)?.to).toBe('idle');
        }
        expect(fire(spec, 'busy', lines)?.to).not.toBe('idle');
        expect(spec.states.find(s => s.id === 'busy')?.status).toBe('generating');
        expect(spec.states.find(s => s.id === 'idle')?.status).toBe('idle');
    });

    it.each(markers.filter(marker => marker !== 'Working tree is clean'))('recognizes each live tail marker %s', marker => {
        expect(fire(load(specRel), 'idle', frame([], [marker]))?.to).toBe('busy');
    });

    it('projects the evaluated FSM state to dashboard status', () => {
        const spec = load(specRel);
        const project = (id: string) => {
            const state = spec.states.find(s => s.id === id)!;
            return projectAdapterStatus({
                providerSessionId: undefined, providerFailure: null, exited: false, spawned: true,
                activeInteractivePrompt: null, modal: null, readySeen: () => true,
                lastOutputAt: 0, lastScreenChangeAt: 0,
                state: { id, label: state.label, title: null, status: state.status! },
            }).status;
        };
        const staleFrame = frame(markers, idle);
        expect(project(fire(spec, 'idle', staleFrame)?.to ?? 'idle')).toBe('idle');
        expect(project(fire(spec, 'idle', frame([], busy))!.to)).toBe('generating');
        expect(project(fire(spec, 'busy', staleFrame)!.to)).toBe('idle');
    });
});

describe('Cursor footer prose and settle boundary', () => {
    it('rejects Working tree prose even within status_tail', () => {
        const spec = load(cases[0].spec);
        const lines = frame([], ['  Working tree is clean', ...cases[0].idle]);
        expect(fire(spec, 'idle', lines)).toBeNull();
        expect(fire(spec, 'busy', lines)?.to).toBe('idle');
    });

    it.each(['  Working', '  Working…', '  Working...', '  ⠋ Running tool', '  esc to cancel'])('preserves live tail marker %s', marker => {
        expect(fire(load(cases[0].spec), 'idle', frame([], [marker, '  /synthetic/workspace']))?.to).toBe('busy');
    });

    it('keeps the 2500ms stable-tail requirement for busy→idle', () => {
        const spec = load(cases[0].spec);
        const lines = frame(['⠋ Working…'], cases[0].idle);
        expect(fire(spec, 'busy', lines, 2499)).toBeNull();
        expect(fire(spec, 'busy', lines, 2500)?.to).toBe('idle');
    });
});

it('Grok vanished→busy ignores stale scrollback but recognizes live tail activity', () => {
    const spec = load(cases[1].spec);
    const row = cases[1];
    const stale = fire(spec, 'approval_vanished', frame(row.markers, row.idle));
    expect(stale?.to).not.toBe('busy');
    expect(fire(spec, 'approval_vanished', frame([], row.busy))?.to).toBe('busy');
});
