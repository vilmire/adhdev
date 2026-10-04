// cursor-cli: a signed-out Cursor Agent sits on its browser-login prompt. The
// startup-grace fallback used to call that screen `idle` after 10s, so the
// dashboard showed a ready session that silently ignored every message
// (standalone CLI check, 2026-10-05). The prompt is now its own state,
// `signing_in` (status waiting_external), mirroring grok-cli.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadSpec(): CliSpecV4 {
    const repoRoot = path.resolve(TEST_DIR, '../../../../../..');
    const candidates = [
        path.join(repoRoot, 'adhdev-providers/cli/cursor-cli/specs/1.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/cursor-cli/specs/1.0.json'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('cursor-cli 1.0.json spec not found');
    const raw = JSON.parse(fs.readFileSync(found, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

function clk(now: number, entered: number): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

function fire(spec: CliSpecV4, from: string, screen: string[], ageMs = 15_000): { label: string | null; to: string | null } {
    const now = 1_000_000;
    const res = evaluateFsm(spec, from, screen.join('\n'), { row: 0, col: 0 }, screen, clk(now, now - ageMs));
    const fired = res.fired as { label?: string; to?: string } | null;
    return { label: fired?.label ?? null, to: fired?.to ?? null };
}

// Captured from a signed-out cursor-agent (standalone, 2026-10-05).
const loginPrompt = [
    '',
    ' Signing in with the browser...',
    " If your browser didn't open, click this link to log in:",
    '',
    'https://cursor.com/loginDeepControl?challenge=abc&uuid=00000000-0000-0000-0000-000000000000&mode=login&redirectTarget=cli',
    '',
    ' Press q to show a QR code to log in from another device',
    '',
];

const readyScreen = [
    '',
    '  Cursor Agent',
    '',
    '  → Plan, search, build anything',
    '',
    '  Auto · 3.2%',
    '  ~/demo/todo-api · main',
];

describe('cursor-cli browser sign-in state', () => {
    const spec = loadSpec();

    it('declares signing_in as waiting_external', () => {
        const state = spec.states.find(s => s.id === 'signing_in');
        expect(state?.status).toBe('waiting_external');
    });

    it('a login prompt at startup goes to signing_in, even past the 10s grace fallback', () => {
        expect(fire(spec, 'starting', loginPrompt, 15_000).to).toBe('signing_in');
        expect(fire(spec, 'starting', loginPrompt, 1_000).to).toBe('signing_in');
    });

    it('stays out of idle while the prompt is on screen', () => {
        expect(fire(spec, 'signing_in', loginPrompt).to).not.toBe('idle');
    });

    it('returns to idle once signed in and the footer is drawn', () => {
        expect(fire(spec, 'signing_in', readyScreen)).toEqual({ label: 'signing_in→idle (signed in, footer drawn)', to: 'idle' });
    });

    it('a normal ready screen never enters signing_in', () => {
        expect(fire(spec, 'idle', readyScreen).to).not.toBe('signing_in');
        expect(fire(spec, 'starting', readyScreen).to).toBe('idle');
    });
});
