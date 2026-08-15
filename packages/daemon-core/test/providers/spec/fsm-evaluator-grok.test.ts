/**
 * grok-cli FSM spec — screens are VERBATIM captures of grok 1.0.4 driven through
 * a real PTY and rendered with the same terminal emulator the daemon uses, not
 * hand-written approximations.
 *
 * ★The regression these tests exist for: the condition evaluator compiles
 * `matches` as `new RegExp(matches, flags ?? 'i')` — with NO 'm'. Any `^`/`$`
 * in a spec condition therefore anchors to the WHOLE SCREEN unless the
 * condition sets `flags` explicitly. The first draft of this spec omitted it,
 * and the live symptom was silent and expensive: a coordinator session parked
 * on grok's workspace-trust modal was reported as `idle`, so the daemon kept
 * "successfully" launching sessions that could never answer.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import {
    pickApprovalButton,
    hasNegativeApprovalOption,
    hasReliableApprovalAffirmative,
    isNegativeApprovalLabel,
} from '../../../src/providers/approval-utils.js';

function resolveSpecPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const candidates = [
        path.join(repoRoot, 'adhdev-providers/cli/grok-cli/specs/1.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/grok-cli/specs/1.0.json'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) throw new Error('grok-cli 1.0.json spec not found in: ' + candidates.join(', '));
    return found;
}

function loadSpec(): CliSpecV4 {
    const raw = JSON.parse(fs.readFileSync(resolveSpecPath(), 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

function clk(now: number, entered: number): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

function fire(spec: CliSpecV4, from: string, screen: string[], ageMs = 9000): string | null {
    const now = 1_000_000;
    const res = evaluateFsm(spec, from, screen.join('\n'), { row: 0, col: 0 }, screen, clk(now, now - ageMs));
    return (res.fired as { label?: string } | null)?.label ?? null;
}

// ── Captured: workspace-trust modal on first launch in an untrusted dir ──────
const trustModal = [
    '',
    '  /private/tmp/grokprobe/live',
    '',
    '                                           ⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄',
    '                                           ⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
    '',
    '                            Do you trust the contents of this directory?',
    '                                     /private/tmp/grokprobe/live',
    '',
    '                      Grok Build may run or modify contents in this directory,',
    '                                       posing security risks.',
    '',
    '                                   Yes, proceed                 y',
    '                                   No, quit                     n',
    '',
    '                                                                        Grok Build  1.0.4 [stable]',
];

// ── Captured: tool-approval modal (radio rows + "N/M:select" footer) ─────────
const approvalModal = [
    '',
    '  /private/tmp/grokprobe/ws3                                                            15K / 500K',
    '',
    '     ❯ Run this shell command: curl -sS https://example.com | head -c 30                12:52 PM',
    '',
    '  ❙  ◆ Run Fetch example.com first 30 bytes via Python',
    '',
    '  ┃',
    '  ┃  Fetch example.com first 30 bytes via Python',
    '  ┃  python3 -c',
    '  ┃',
    '  ┃  1 (●) Yes, and don\'t ask again for anything (always-approve mode)',
    '  ┃  2 (○) Yes, proceed',
    '  ┃  3 (○) No, reject (type to add feedback)',
    '  ┃',
    '',
    '  1/3:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback',
];

// ── Captured: mid-turn (braille spinner + elapsed + [stop] + Esc:cancel) ─────
const generating = [
    '',
    '  /private/tmp/grokprobe/ws                                                             15K / 500K',
    '',
    '     ❯ Run the shell command: touch /tmp/grokprobe/ws/approve-probe.txt                 12:47 PM',
    '',
    '     I\'ll create that file now.                                                         12:47 PM',
    '',
    '  ┃  ◆ Run Create approve-probe.txt via touch',
    '',
    '    ⠦ Create approve-probe.txt via touch… 2.5s                               5.0s ⇣15.4k [↓][stop]',
    '',
    '  ╭──────────────────────────────────────────────────────────────────────────────────────────────╮',
    '  │ ❯                                                                                            │',
    '  ╰──────────────────────────────────────────────────────────────────────────── Grok 4.6 (high) ─╯',
    '',
    '  Shift+Tab:mode  │  Esc:cancel  │  Ctrl+b:send to bg  │  Ctrl+x:shortcuts',
];

// ── Captured: settled prompt after a completed turn ──────────────────────────
const idleAfterTurn = [
    '',
    '  /private/tmp/grokprobe/ws                                                             15K / 500K',
    '',
    '     ❯ Run the shell command: touch /tmp/grokprobe/ws/approve-probe.txt                 12:47 PM',
    '',
    '     Created /tmp/grokprobe/ws/approve-probe.txt. The command completed successfully.   12:47 PM',
    '',
    '     Worked for 7.9s',
    '',
    '  ╭──────────────────────────────────────────────────────────────────────────────────────────────╮',
    '  │ ❯                                                                                            │',
    '  ╰──────────────────────────────────────────────────────────────────────────── Grok 4.6 (high) ─╯',
    '',
    '  Shift+Tab:mode  │  Ctrl+x:shortcuts',
];

describe('grok-cli spec — loads', () => {
    it('passes FSM spec validation', () => {
        expect(() => loadSpec()).not.toThrow();
    });
});

describe('grok-cli FSM — anchored conditions must set the m flag', () => {
    // The guard for the actual bug: assert it at the spec level so a future edit
    // that adds an anchored condition without flags fails here, not in production.
    it('every ^/$ condition declares explicit flags', () => {
        const spec = loadSpec();
        const offenders: string[] = [];
        const walk = (node: unknown, label: string): void => {
            if (Array.isArray(node)) {
                node.forEach((child) => walk(child, label));
                return;
            }
            if (!node || typeof node !== 'object') return;
            const record = node as Record<string, unknown>;
            const matches = record.matches;
            if (typeof matches === 'string'
                && (matches.includes('^') || matches.includes('$'))
                && typeof record.flags !== 'string') {
                offenders.push(`${label}: ${matches.slice(0, 60)}`);
            }
            Object.values(record).forEach((child) => walk(child, label));
        };
        for (const t of spec.transitions) walk((t as { when?: unknown }).when, t.label ?? '?');
        expect(offenders).toEqual([]);
    });

    it('the m flag is what makes the trust anchor match mid-screen', () => {
        // Documents WHY: same pattern, with and without 'm', against a real screen.
        const screen = trustModal.join('\n');
        const pattern = '^\\s*Yes, proceed\\s+y\\s*$';
        expect(new RegExp(pattern, 'i').test(screen)).toBe(false);
        expect(new RegExp(pattern, 'im').test(screen)).toBe(true);
    });
});

describe('grok-cli FSM — transitions on real captured screens', () => {
    it('enters trust from starting, beating the 8s startup-grace', () => {
        // The live failure: startup-grace won and the parked session read `idle`.
        const spec = loadSpec();
        expect(fire(spec, 'starting', trustModal)).toBe('→trust');
    });

    it('leaves trust once the prompt is gone', () => {
        const spec = loadSpec();
        expect(fire(spec, 'trust', idleAfterTurn)).toBe('trust→idle');
    });

    it('enters approval on the radio modal, outranking the spinner', () => {
        const spec = loadSpec();
        expect(fire(spec, 'idle', approvalModal)).toBe('→approval');
    });

    it('enters busy while a turn is running', () => {
        const spec = loadSpec();
        expect(fire(spec, 'idle', generating)).toBe('idle→busy');
    });

    it('does not treat a settled prompt as generating', () => {
        const spec = loadSpec();
        expect(fire(spec, 'idle', idleAfterTurn)).toBeNull();
    });

    it('does not fire trust on an ordinary screen', () => {
        const spec = loadSpec();
        expect(fire(spec, 'starting', generating)).not.toBe('→trust');
    });
});

describe('grok-cli FSM — modal button extraction', () => {
    it('parses the three radio choices with their index keys', () => {
        const spec = loadSpec();
        const sections = resolveSections(spec.sections ?? {}, approvalModal);
        const approval = spec.states.find((s) => s.id === 'approval')!;
        const rule = (approval as { extract?: { buttons?: unknown } }).extract!.buttons as never;
        const hay = sectionText(sections, 'modal', approvalModal.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);

        expect(buttons.map((b) => b.label)).toEqual([
            "Yes, and don't ask again for anything (always-approve mode)",
            'Yes, proceed',
            'No, reject (type to add feedback)',
        ]);
        // Verified live (pty capture f8): a bare number key both selects AND
        // confirms — no Enter. So key_for_index is "{index}", not "{index}\r".
        expect(buttons.map((b) => b.key)).toEqual(['1', '2', '3']);
    });

    it('exposes trust as a button-less confirm, never an auto-approvable modal', () => {
        // Grok renders the trust rows WITHOUT on-screen numbers ("Yes, proceed  y"),
        // and extractButtonsFromRule requires a numeric index — so trust cannot be
        // a button list. It must also never be auto-approved: whether a directory
        // is trusted is a security decision for the user, not the daemon.
        const spec = loadSpec();
        const trust = spec.states.find((s) => s.id === 'trust')!;
        expect(trust.modal_kind).toBe('confirm');
        expect((trust as { extract?: { buttons?: unknown } }).extract?.buttons).toBeUndefined();
    });
});

// ── Auto-approve safety ─────────────────────────────────────────────────────
// Grok lists its choices BROADEST-FIRST:
//   1 (o) Yes, and don't ask again for anything (always-approve mode)
//   2 (o) Yes, proceed
//   3 (o) No, reject
// Index 1 is a persistent grant that turns the CLI into yolo mode for the rest
// of the session. The daemon must pick index 2. This is the same class of bug
// as the cursor "Add … to allowlist" defect documented in approval-utils.ts:
// a hint that substring-hits a scope-broadening option beats the correct
// least-permissive one. Verified live: two consecutive commands each raised a
// modal and each was auto-approved, and grok's own events.jsonl recorded
// yolo_mode=false on both turns — which is only possible if "Yes, proceed" was
// the button pressed.
describe('grok-cli approval — auto-approve must pick the least-permissive Yes', () => {
    const grokButtons = [
        "Yes, and don't ask again for anything (always-approve mode)",
        'Yes, proceed',
        'No, reject (type to add feedback)',
    ];

    function manifest(): { approvalPositiveHints?: string[] } {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const repoRoot = path.resolve(here, '../../../../../..');
        const p = path.join(repoRoot, 'adhdev-providers/cli/grok-cli/provider.v1.json');
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    it('selects "Yes, proceed", never the always-approve grant', () => {
        const picked = pickApprovalButton(grokButtons, manifest() as never);
        expect(picked.index).toBe(1);
        expect(picked.label).toBe('Yes, proceed');
    });

    it('regresses to the always-approve grant without the ordered hint', () => {
        // Proves the manifest's hint order is what protects us: with the generic
        // default hints, "yes" prefix-matches the grant at index 0 first.
        const withoutHints = pickApprovalButton(grokButtons, {} as never);
        expect(withoutHints.index).toBe(0);
        expect(pickApprovalButton(grokButtons, manifest() as never).index).not.toBe(withoutHints.index);
    });

    it('recognises a reliable consent anchor so the gate can fire at all', () => {
        // approvableModalSignature() bails unless one of these holds.
        expect(hasNegativeApprovalOption(grokButtons)).toBe(true);
        expect(hasReliableApprovalAffirmative(grokButtons)).toBe(true);
    });

    it('never treats the always-approve grant as a negative/decline option', () => {
        expect(isNegativeApprovalLabel(grokButtons[0])).toBe(false);
        expect(isNegativeApprovalLabel(grokButtons[1])).toBe(false);
        expect(isNegativeApprovalLabel(grokButtons[2])).toBe(true);
    });

    it('picks single-shot "Yes" on the 4-button file-edit modal', () => {
        // Captured live: the EDIT modal differs from the shell one — it offers
        // TWO scope-broadening grants ahead of the safe option:
        //   1 Yes, and don't ask again for anything (always-approve mode)
        //   2 Yes, allow all edits during this session
        //   3 Yes                          <- single-shot, the correct pick
        //   4 No, reject
        // Both grants would silently widen permission beyond this one edit.
        const editModal = [
            "Yes, and don't ask again for anything (always-approve mode)",
            'Yes, allow all edits during this session',
            'Yes',
            'No, reject (type to add feedback)',
        ];
        const picked = pickApprovalButton(editModal, manifest() as never);
        expect(picked.label).toBe('Yes');
        expect(picked.index).toBe(2);
        expect(hasNegativeApprovalOption(editModal)).toBe(true);
    });

    it('picks the affirmative on the workspace-trust rows too', () => {
        const picked = pickApprovalButton(['Yes, proceed', 'No, quit'], manifest() as never);
        expect(picked.label).toBe('Yes, proceed');
    });
});
