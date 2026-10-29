/**
 * Mission fea90234 (standalone QA 2026-10-29): a codex worker launched for a read-only task
 * parked on codex's own per-call prompt for the `adhdev-worker` MCP server and ADHDev showed
 * `generating` for 15+ minutes (no waiting_approval, no auto-approve, no dashboard buttons).
 *
 * The launch half is fixed by `approvalModeTemplate` (default_tools_approval_mode="approve");
 * this file pins the detection safety net: the codex FSM spec must read that screen as an
 * `approval` modal from every live state, expose all four options, and auto-approve must pick
 * the one-time "Allow" (never the session/persistent grants or Cancel).
 *
 * The first screen is the verbatim tail captured from codex 0.162.1 under `-s read-only`
 * (the full byte stream is the replay fixture mcp-tool-approval-readonly-2026-10-29.pty).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import { pickLeastPrivilegeApprovalButton } from '../../../src/providers/approval-utils.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.resolve(HERE, '../../../../../../adhdev-providers/cli/codex-cli/specs/4.0.json');
const maybe = fs.existsSync(SPEC) ? describe : describe.skip;
const clk = (now: number): FsmClock => ({ now, stateEnteredAt: 0, regionLastChangedAt: new Map() });

const PROMPT_TAIL = [
    '  Field 1/1',
    '  Allow the adhdev-worker MCP server to run tool "ping_tool"?',
    '  › 1. Allow                   Run the tool and continue',
    '    2. Allow for this session  Run the tool and remember this choice for this session',
    '    3. Always allow            Run the tool and remember this choice for future tool calls',
    '    4. Cancel                  Cancel this tool call',
    '  enter to submit | esc to cancel',
];

const LIVE_SCREEN = [
    '› Call the MCP tool ping_tool from server adhdev-worker once, then reply done.',
    '',
    '',
    '• I’ll call the tool once.',
    '',
    '◦ Calling adhdev-worker.ping_tool',
    '    + Show details',
    '', '', '', '', '', '', '', '',
    ...PROMPT_TAIL,
].join('\n');

// driver_invoke shows its arguments as form fields above the question.
const MULTI_FIELD_SCREEN = [
    '• Working (3s • esc to interrupt)',
    '◦ Calling adhdev-worker.driver_invoke',
    '',
    '  Field 1/3',
    '  Allow the adhdev-worker MCP server to run tool "driver_invoke"?',
    '  action: navigate',
    '  url: https://example.test/a/very/long/path?with=query&and=more',
    '  session: sess_example',
    '',
    ...PROMPT_TAIL.slice(2),
].join('\n');

maybe('codex MCP tool approval prompt (read-only sandbox)', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as CliSpecV4;

    it('spec is valid', () => expect(validateFsmSpec(spec)).toEqual([]));

    for (const [name, screen] of [['live capture', LIVE_SCREEN], ['multi-field driver_invoke', MULTI_FIELD_SCREEN]] as const) {
        it(`${name}: → approval from every live state`, () => {
            const row = screen.split('\n').length - 1;
            for (const from of ['starting', 'idle', 'busy', 'mcp_init']) {
                const ev = evaluateFsm(spec, from, screen, { row, col: 2 }, undefined, clk(10000));
                expect(ev.fired?.to, `from ${from}`).toBe('approval');
            }
        });

        it(`${name}: exposes all four options with index keys`, () => {
            const approval = spec.states.find((s) => s.id === 'approval')!;
            const lines = screen.split('\n');
            const sections = resolveSections(spec.sections ?? {}, lines);
            const rule = approval.extract!.buttons!;
            const buttons = extractButtonsFromRule(rule, sectionText(sections, rule.section, lines.join('\n')));
            expect(buttons.map((b) => b.key)).toEqual(['1\r', '2\r', '3\r', '4\r']);
            expect(buttons.map((b) => b.label.split(/\s{2,}/)[0])).toEqual([
                'Allow', 'Allow for this session', 'Always allow', 'Cancel',
            ]);
        });
    }

    it('auto-approve picks the one-time "Allow" (index 0), never a session/persistent grant or Cancel', () => {
        const labels = PROMPT_TAIL.slice(2, 6).map((l) => l.replace(/^\s*[›>]?\s*\d+\.\s+/, ''));
        expect(pickLeastPrivilegeApprovalButton(labels).index).toBe(0);
        expect(pickLeastPrivilegeApprovalButton(['Allow', 'Allow for this session', 'Always allow', 'Cancel']).index).toBe(0);
    });
});
