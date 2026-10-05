/**
 * Kimi asks before every MCP tool call with "▶ Approve mcp__<server>__<tool>?".
 * The spec's approval phrases did not include that form, so a kimi coordinator
 * parked on its first mesh tool call while the daemon reported `generating` —
 * nothing could approve it (2026-10-05 provider matrix, kimi→claude).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadSpec(): CliSpecV4 {
    const repoRoot = path.resolve(TEST_DIR, '../../../../../..');
    const candidates = [
        path.join(repoRoot, 'adhdev-providers/cli/kimi/specs/1.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/kimi/specs/1.0.json'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('kimi 1.0.json spec not found');
    const raw = JSON.parse(fs.readFileSync(found, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

const clk = (now: number): FsmClock => ({ now, stateEnteredAt: 0, regionLastChangedAt: new Map() });

// Live kimi 2.1.1 capture (2026-10-06), last lines of the screen.
const screen = [
    ' ● Using mesh_clone_node · MCP/adhdev-mesh (node_317245f329cb4fe2be3416b94a89…)',
    ' ──────────────────────────────────────────────────────────────────────────────',
    '   ▶ Approve mcp__adhdev-mesh__mesh_clone_node?',
    '',
    '   Approve mcp__adhdev-mesh__mesh_clone_node',
    '',
    '   ▶ 1. Approve once',
    '     2. Approve for this session',
    '     3. Reject',
    '     4. Reject with feedback',
    '',
    '   ↑/↓ select · 1/2/3/4 choose · ↵ confirm',
    ' ──────────────────────────────────────────────────────────────────────────────',
    ' K2.8 Preview thinking: high  ~/demo/todo-web  main [± ↑2]',
    '                                                         context: 4% (36.8k/1M)',
].join('\n');

describe('kimi FSM — MCP tool-call approval', () => {
    const spec = loadSpec();

    it('busy → approval on "▶ Approve mcp__…?"', () => {
        const ev = evaluateFsm(spec, 'busy', screen, { row: 14, col: 4 }, undefined, clk(10_000));
        expect(ev.fired?.to).toBe('approval');
    });

    it('extracts the four choices with "Approve once" first', () => {
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = screen.split('\n');
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = approval.extract!.buttons!;
        const buttons = extractButtonsFromRule(rule, sectionText(sections, rule.section, screen));
        expect(buttons.map(b => b.label)).toEqual(['Approve once', 'Approve for this session', 'Reject', 'Reject with feedback']);
        expect(buttons[0].key).toBe('1');
    });
});
