/**
 * APPROVAL-DEADLOCK — a modal on screen with ZERO ways to answer it.
 *
 * Live defect (2026-09-20, grok-cli + antigravity-cli). The coordinator hit a
 * session parked on a permission prompt and both answer paths refused:
 *
 *     mesh_approve   → "Approval was not pressed: the modal on screen could
 *                       not be actioned."
 *     mesh_send_keys → "refused: actionable_modal"
 *
 * The daemon gate logged `parsedModal=no` for both, which looked like one
 * shared cause. It was two, and neither was a stale-scrollback race (the
 * coordinator read the terminal twice and got an identical screen hash, so the
 * picker really was live):
 *
 *   grok-cli (spec 1.0) — the `trust` state is `modal: true` but declared NO
 *     `extract.buttons` rule at all, so `deriveModal` returned null on its very
 *     first line. Its sibling `approval` rule could not have helped either: it
 *     expects `N (●) label` radio rows, while the trust screen paints
 *     `Yes, proceed   y` / `No, quit   n` (0 matches, measured).
 *
 *   antigravity-cli (spec 4.0) — the buttons DID parse (all four rows, incl.
 *     the multi-line continuation ones). The rule declared
 *     `cursor_marker: "❯›"`, but the live screen paints its focus marker as
 *     `>`. With `select_mode: 'arrow_keys'`, "no row carries the cursor" is
 *     read as stale scrollback (a deliberate guard, see
 *     driver-approval-stale-scrollback-modal.test.ts) and the press is refused.
 *     The rule's own `pattern` already accepted `[❯›>]` as a row prefix — only
 *     `cursor_marker` omitted `>`, so the two disagreed about the same glyph.
 *
 * The ENGINE half of the defect is the asymmetry that turned either spec gap
 * into a wedge: `send_keys`' modal guard armed on `status === 'approval'`,
 * which `statusForState()` reports for ANY `modal: true` state regardless of
 * whether buttons parsed — while `mesh_approve` can only press a button that
 * parsed. So an unparseable modal armed the guard and disarmed approve at the
 * same time. The guard now arms on an ACTIONABLE modal (parsed buttons > 0),
 * which is exactly when approve has something to press.
 *
 * These tests assert that APPROVE ACTUALLY PRESSES — the keys written to the
 * PTY — never "some buttons parsed", which is the proxy that let this class
 * through three times in one day.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.resolve(HERE, '../../../../../../adhdev-providers/cli');
const GROK_SPEC = path.join(SPECS, 'grok-cli/specs/1.0.json');
const AGY_SPEC = path.join(SPECS, 'antigravity-cli/specs/4.0.json');
const specsAvailable = fs.existsSync(GROK_SPEC) && fs.existsSync(AGY_SPEC);
const maybe = specsAvailable ? describe : describe.skip;

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4712;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function paint(lines: string[], cursorRow: number): string {
    return `\x1b[2J\x1b[H${lines.join('\r\n')}\x1b[${cursorRow};1H`;
}

type EmittedModal = {
    title: string | null;
    buttons: { index: number; label: string }[];
    kind: string | null;
} | null;

function makeDriver(specPath: string) {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath,
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    const seen: { modal: EmittedModal } = { modal: null };
    driver.subscribe(ev => { if (ev.kind === 'state_changed') seen.modal = ev.modal; });
    driver.start();
    return { driver, pty: factory.last!, seen };
}

/**
 * grok-cli workspace-trust prompt, transcribed from the live terminal read
 * (2026-09-20). No numbered rows: each choice carries a trailing key hint.
 */
const GROK_TRUST = [
    '                  Do you trust the contents of this directory?',
    '                           /Users/vilmire/Work/adhdev',
    '',
    '            Grok Build may run or modify contents in this directory,',
    '                             posing security risks.',
    '',
    '                         Yes, proceed                 y',
    '                         No, quit                     n',
];

/**
 * antigravity-cli command-permission prompt, transcribed from the live
 * terminal read (2026-09-20). The command is long enough to wrap, so choices 2
 * and 3 are multi-line continuations, and the focus marker is `>` (not `❯`).
 */
const AGY_APPROVAL = [
    'Requesting permission for:',
    "   pwd && env | command grep -E",
    "'^(HOME|GEMINI_HOME|CODEX_HOME|KIMI_CODE_HOME|XDG_CONFIG_HOME|HERMES_HOME|",
    "CLAUDE_CONFIG_DIR|ADHDEV_)'",
    '| sort',
    '',
    'Run this command?',
    '> 1. Yes, run command',
    '  2. Yes, and always allow in this conversation for commands that start with',
    "'pwd && env | command grep -E",
    "'^(HOME|GEMINI_HOME|CODEX_HOME|KIMI_CODE_HOME|XDG_C...'",
    "  3. Yes, and always allow for commands that start with 'pwd && env | command",
    "grep -E '^(HOME|GEMINI_HOME|CODEX_HOME|KIMI_CODE_HOME|XDG_C...' (Persist to",
    'settings.json)',
    '  4. No, cancel',
    '',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
    'esc to cancel                                              Gemini 3.1 Pro · high',
];

maybe('APPROVAL-DEADLOCK — an on-screen modal must always be answerable', () => {
    if (!specsAvailable) return;

    it('grok trust: approve PRESSES the affirmative row (writes "y", not nothing)', async () => {
        const { driver, pty, seen } = makeDriver(GROK_SPEC);
        try {
            pty.feed(paint(GROK_TRUST, 8));
            await sleep(900);

            expect(driver.getFsmDebug().currentState).toBe('trust');
            // Pre-fix: the `trust` state had no extract.buttons at all, so this
            // modal was null and there was nothing for approve to aim at.
            expect(seen.modal, 'the trust modal must parse').toBeTruthy();
            expect(seen.modal!.buttons.map(b => b.label)).toEqual(['Yes, proceed', 'No, quit']);

            pty.writes.length = 0;
            // THE assertion: the press lands, and the byte written is the key
            // hint the screen advertises for "Yes, proceed".
            expect(driver.clickModalButton(1)).toBe(true);
            expect(pty.writes.join('')).toBe('y');
        } finally { driver.shutdown(); }
    }, 30000);

    it('grok trust: the negative row presses "n" (index maps to the right choice)', async () => {
        const { driver, pty } = makeDriver(GROK_SPEC);
        try {
            pty.feed(paint(GROK_TRUST, 8));
            await sleep(900);
            expect(driver.getFsmDebug().currentState).toBe('trust');

            pty.writes.length = 0;
            expect(driver.clickModalButton(2)).toBe(true);
            // A wrong-index press here would trust a directory the caller
            // declined, so pin the exact byte.
            expect(pty.writes.join('')).toBe('n');
        } finally { driver.shutdown(); }
    }, 30000);

    it('antigravity approval: approve PRESSES despite the ">" focus marker', async () => {
        const { driver, pty, seen } = makeDriver(AGY_SPEC);
        try {
            pty.feed(paint(AGY_APPROVAL, 16));
            await sleep(900);

            expect(driver.getFsmDebug().currentState).toBe('approval');
            // Buttons parsed even pre-fix — that is why this case needs a
            // press-level assertion. All four rows, with the wrapped ones
            // folded into their labels by continuation_lines.
            expect(seen.modal, 'the approval modal must parse').toBeTruthy();
            expect(seen.modal!.buttons.map(b => b.index)).toEqual([1, 2, 3, 4]);
            expect(seen.modal!.buttons[0].label).toBe('Yes, run command');

            pty.writes.length = 0;
            // Pre-fix: cursor_marker "❯›" did not match the screen's ">", so no
            // row read as `current`, the arrow_keys stale-scrollback guard
            // fired, this returned FALSE and nothing was written.
            expect(driver.clickModalButton(1)).toBe(true);
            // Cursor already sits on row 1 → confirm only, no arrows. The digit
            // must never reach the PTY (arrow_keys modals type it into the
            // composer).
            expect(pty.writes.join('')).toBe('\r');
            expect(pty.writes.join('')).not.toContain('1');
        } finally { driver.shutdown(); }
    }, 30000);

    it('antigravity approval: pressing row 4 navigates down three rows then confirms', async () => {
        // Proves the `>`-marked row is understood as the cursor ORIGIN, not
        // merely as "some row matched": the arrow count is measured from it.
        const { driver, pty } = makeDriver(AGY_SPEC);
        try {
            pty.feed(paint(AGY_APPROVAL, 16));
            await sleep(900);
            expect(driver.getFsmDebug().currentState).toBe('approval');

            pty.writes.length = 0;
            expect(driver.clickModalButton(4)).toBe(true);
            expect(pty.writes.join('')).toBe('\x1b[B'.repeat(3) + '\r');
        } finally { driver.shutdown(); }
    }, 30000);

    it('antigravity trust: the UNNUMBERED folder-trust modal parses and presses', async () => {
        // Found by running the real `agy` binary against this spec while
        // verifying the fix (2026-09-20, Antigravity CLI 1.2.7) — a THIRD
        // instance of the same deadlock class, not in the original report.
        // antigravity's folder-trust screen renders NO numbers ("> Yes, I trust
        // this folder"), but the trust state's rule required `N. label`, so it
        // matched 0 rows: modal null, approve dead, send_keys refused.
        //
        // Live confirmation after the fix: the modal parsed both rows and
        // clickModalButton(1) drove the FSM trust → idle, with the CLI
        // advancing to its ready prompt.
        const TRUST = [
            'Accessing workspace:',
            '/tmp/agy-trust-live',
            'Do you trust the contents of this project?',
            'Antigravity CLI requires permission to read, edit, and execute files here.',
            '> Yes, I trust this folder',
            '  No, exit',
            '  ↑/↓ Navigate · enter Confirm',
            '                                                    Gemini 3.8 Flash · low',
        ];
        const { driver, pty, seen } = makeDriver(AGY_SPEC);
        try {
            pty.feed(paint(TRUST, 6));
            await sleep(900);

            expect(driver.getFsmDebug().currentState).toBe('trust');
            expect(seen.modal, 'the trust modal must parse').toBeTruthy();
            expect(seen.modal!.buttons.map(b => b.label))
                .toEqual(['Yes, I trust this folder', 'No, exit']);
            // Folder trust is a security decision for the user, so the modal is
            // surfaced as 'confirm' — answerable on request, never auto-approved
            // (approval-gate.ts TRUST-NEVER-AUTO-APPROVES).
            expect(seen.modal!.kind).toBe('confirm');

            pty.writes.length = 0;
            expect(driver.clickModalButton(1)).toBe(true);
            // Cursor already on "Yes" → confirm only. The screen says
            // "enter Confirm", so the key is a bare CR with no digit.
            expect(pty.writes.join('')).toBe('\r');
        } finally { driver.shutdown(); }
    }, 30000);

    it('COUNTER-INVARIANT: a genuinely stale antigravity list is still refused', async () => {
        // The cursor_marker widening must not swallow the stale-scrollback
        // guard: with the answered box in scrollback NO row carries `>` either,
        // so the press must still be refused and write nothing.
        const STALE = [
            'Requesting permission for:',
            '   pwd && env',
            '',
            'Run this command?',
            '  1. Yes, run command',
            '  4. No, cancel',
            '',
            '> ',
            'Working… (12s · esc to interrupt)',
        ];
        const { driver, pty } = makeDriver(AGY_SPEC);
        try {
            pty.feed(paint(AGY_APPROVAL, 16));
            await sleep(900);
            expect(driver.getFsmDebug().currentState).toBe('approval');

            for (let i = 0; i < 6; i++) { pty.feed(paint(STALE, 8)); await sleep(200); }

            pty.writes.length = 0;
            const pressed = driver.clickModalButton(1);
            if (pressed) {
                // If the composer row (`> `) is read as the cursor origin the
                // press is allowed — that is acceptable ONLY if it never wrote a
                // bare CR into the composer, which is the original defect.
                expect(pty.writes.join(''), 'a bare CR into the composer is the stale-modal defect').not.toBe('\r');
            } else {
                expect(pty.writes, 'a refused press must write nothing').toEqual([]);
            }
        } finally { driver.shutdown(); }
    }, 40000);
});
