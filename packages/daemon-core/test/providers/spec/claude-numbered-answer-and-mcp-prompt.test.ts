import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections } from '../../../src/providers/spec/evaluator.js';
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

// Two claude-cli parsing defects measured live 2026-10-01 (Claude Code 2.1.220,
// claude-cli spec v1.2.9) — screens below are the captured ones.

function loadSpec(): CliSpecV4 {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(here, '../../../../../../adhdev-providers/cli/claude-cli/specs/4.0.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}
const clk = (now: number): FsmClock => ({ now, stateEnteredAt: 0, regionLastChangedAt: new Map() });
const RULE = '────────────────────────────────────────────────────────────────────────────────';

// 1. The approval dialog was just answered; the FSM is still in `approval` for
//    ~1s until approval→vanished. The modal was re-derived from THIS screen and
//    the whole-screen fallback bound the answer's numbered list as buttons, with
//    the footer status line as the title. Pressing one types a digit into the
//    prompt. A real choice block always carries the ❯ cursor; a body list never.
const answeredApprovalScreen = [
    '❯ First, reply with a numbered list of three short tips about TypeScript',
    '  (format: "1. **Title** — sentence"). Then create a file notes.txt containing',
    '  the word hi.',
    '',
    '⏺ 1. Prefer unknown over any — It forces you to narrow the type before use, so',
    '  you keep type safety at the boundaries where data arrives untyped.',
    '  2. Use discriminated unions for state — A shared literal field (e.g. status:',
    "  'loading' | 'error') lets the compiler prove which fields exist in each",
    '  branch.',
    '  3. Turn on strict early — Enabling it on a young codebase costs minutes;',
    '  retrofitting it later costs weeks of null-check archaeology.',
    '',
    '⏺ Write(notes.txt)',
    '  ⎿  Wrote 1 line to notes.txt',
    '      1 hi',
    '',
    '✻ Perambulating… (6s · ↓ 177 tokens)',
    '',
    RULE,
    '❯',
    RULE,
    '  ⏸ manual mode on · ← 2 agents                               ● high · /effort',
].join('\n');

// 2. Claude Code's MCP permission prompt (Claude in Chrome). No "Esc to cancel"
//    footer — the escape hint is on the Deny row — so →approval never fired and
//    the session read idle while it was blocked.
const chromePermissionScreen = [
    '⏺ Server is up. Opening it in a browser.',
    '',
    '  Calling claude-in-chrome… (ctrl+o to expand)',
    '',
    RULE,
    ' Claude in Chrome wants to navigate on localhost:4173',
    '',
    ' http://localhost:4173/',
    '',
    ' ❯ 1. Allow',
    '   2. Allow all actions on localhost:4173 for this session',
    '   3. Deny (esc)',
].join('\n');

describe('claude-cli — numbered answer is never an approval', () => {
    const spec = loadSpec();
    const approval = spec.states.find(s => s.id === 'approval')!;

    it('derives NO modal from a screen whose only numbered list is the assistant answer', () => {
        const lines = answeredApprovalScreen.split('\n');
        const sections = resolveSections(spec.sections ?? {}, lines);
        const modal = deriveModal(approval, sections, answeredApprovalScreen, () => {});
        expect(modal).toBeNull();
    });

    it('does not enter approval from busy on that screen', () => {
        const lines = answeredApprovalScreen.split('\n');
        const ev = evaluateFsm(spec, 'busy', answeredApprovalScreen, { row: lines.length - 3, col: 2 }, undefined, clk(10000));
        expect(ev.fired?.to).not.toBe('approval');
    });
});

describe('claude-cli — MCP tool permission prompt is an approval', () => {
    const spec = loadSpec();
    const approval = spec.states.find(s => s.id === 'approval')!;

    it('→approval fires on the Claude in Chrome navigate prompt', () => {
        const lines = chromePermissionScreen.split('\n');
        const ev = evaluateFsm(spec, 'busy', chromePermissionScreen, { row: lines.length - 3, col: 3 }, undefined, clk(10000));
        expect(ev.fired?.to).toBe('approval');
    });

    it('extracts the three choices with the cursor on Allow', () => {
        const lines = chromePermissionScreen.split('\n');
        const sections = resolveSections(spec.sections ?? {}, lines);
        const modal = deriveModal(approval, sections, chromePermissionScreen, () => {});
        expect(modal?.buttons.map(b => b.label)).toEqual([
            'Allow',
            'Allow all actions on localhost:4173 for this session',
            'Deny (esc)',
        ]);
        expect(modal?.buttons.find(b => b.current)?.label).toBe('Allow');
    });
});
