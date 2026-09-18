/**
 * MESHAPPROVE-STALE-MODAL — mesh_approve reported success six times over 56
 * minutes while nothing was ever approved.
 *
 * Live defect (2026-09-18, MoltBook / claude-cli spec 4.0). The coordinator
 * approved session c8c084ac six times and got
 * `{success:true, buttonIndex:0, button:"Yes"}` every time. The FSM traced:
 *
 *     approval → approval_resolving → busy → approval      (failure: comes back)
 *     approval → approval_resolving → busy                 (success: stops)
 *
 * Root cause — fsm-driver.ts handleClickModalButton, the `arrow_keys` branch:
 *
 *   - `deriveModal` reads a SCROLLBACK-INCLUSIVE buffer for modal states, on
 *     purpose: a tall approval box scrolls out of the viewport and a
 *     viewport-only read would drop the buttons. The side effect is that the
 *     dead `1. Yes / 2. No` lines of an ALREADY-ANSWERED approval keep parsing
 *     into a complete modal, so the FSM stays in `approval`.
 *   - The branch then took `m.buttons.find(b => b.current)?.index ?? 1` as the
 *     cursor origin. On that stale list NO row carries the `❯` marker, so the
 *     `?? 1` fabricated an origin, delta came out 0, no arrows were sent, and
 *     `submitModalConfirm` wrote a BARE CR — into the `❯` composer, submitting
 *     an EMPTY message. claude-cli spun briefly on it and repainted the same
 *     stale screen, which is the approval → resolving → busy → approval loop.
 *   - `clickModalButton` returned `true` regardless, so `resolveModalMatched`
 *     and `mesh_approve` reported success into the void.
 *
 * `parsedModal=no` in the daemon gate log is NOT the fingerprint — the same
 * value appears on successful approvals (it only means the adapter never had to
 * fall back to the script-parsed status). The fingerprint is the FSM returning
 * to `approval`.
 *
 * These tests therefore assert the TRANSITION DIRECTION and the keys actually
 * written to the PTY — never a `parsedModal`-style proxy.
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
const SPEC_PATH = path.resolve(
    HERE, '../../../../../../adhdev-providers/cli/claude-cli/specs/4.0.json',
);
const specAvailable = fs.existsSync(SPEC_PATH);
const maybe = specAvailable ? describe : describe.skip;

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4711;
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
const RULE = '─'.repeat(70);

function paint(lines: string[], cursorRow: number): string {
    return `\x1b[2J\x1b[H${lines.join('\r\n')}\x1b[${cursorRow};1H`;
}

/** A LIVE claude-cli approval: the `❯` marker sits on the focused row. */
const LIVE_MODAL = [
    '⏺ I will run the command.',
    '',
    RULE,
    ' Do you want to run this command?',
    '',
    ' ❯ 1. Yes',
    '   2. No, and tell Claude what to do differently',
    '',
    ' Esc to cancel · Tab to amend',
];

/**
 * The stale screen: the approval was already answered, so the picker is GONE —
 * the choice lines survive only as scrollback (NO `❯` on any of them), the TUI
 * is back at the `❯` composer, and a spinner is running.
 */
const STALE_SCROLLBACK = (tick: number) => [
    '⏺ I will run the command.',
    '',
    RULE,
    ' Do you want to run this command?',
    '',
    '   1. Yes',
    '   2. No, and tell Claude what to do differently',
    '',
    RULE,
    '❯',
    RULE,
    `✻ Thinking… (${tick}s · ↑ 1.2k tokens · esc to interrupt)`,
];

type EmittedModal = {
    title: string | null;
    buttons: { index: number; label: string }[];
    kind: string | null;
} | null;

function makeDriver() {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath: SPEC_PATH,
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    // The `state_changed` modal payload is exactly what the dashboard and
    // mesh_approve aim at, so observing it through `subscribe()` is the real
    // consumer view — not a test-only peek at driver internals.
    const seen: { modal: EmittedModal } = { modal: null };
    driver.subscribe(ev => {
        if (ev.kind === 'state_changed') seen.modal = ev.modal;
    });
    driver.start();
    return { driver, pty: factory.last!, seen };
}

maybe('FsmDriver — approval press against a STALE scrollback modal', () => {
    if (!specAvailable) return;

    it('a LIVE modal (cursor marker present) still presses: one CR, no digit', async () => {
        // Counter-invariant. The refusal must be narrow enough that the healthy
        // approval path is byte-for-byte unchanged, or the fix trades a silent
        // false success for a silent inability to approve at all.
        const { driver, pty } = makeDriver();
        try {
            pty.feed(paint(LIVE_MODAL, 6));
            await sleep(900);
            expect(driver.getFsmDebug().currentState).toBe('approval');

            pty.writes.length = 0;
            expect(driver.clickModalButton(1)).toBe(true);
            // Cursor already on "Yes" → no arrows, just the confirm CR.
            expect(pty.writes.join('')).toBe('\r');
            // The digit must never reach the PTY (it would type into the composer).
            expect(pty.writes.join('')).not.toContain('1');
        } finally { driver.shutdown(); }
    }, 30000);

    it('refuses the press when the parsed modal is stale scrollback (no cursor marker)', async () => {
        const { driver, pty, seen } = makeDriver();
        try {
            pty.feed(paint(LIVE_MODAL, 6));
            await sleep(900);
            expect(driver.getFsmDebug().currentState).toBe('approval');

            // The approval gets answered elsewhere; the box drops into scrollback
            // and the composer comes back with a spinner.
            for (let i = 0; i < 14; i++) {
                pty.feed(paint(STALE_SCROLLBACK(i), 10));
                await sleep(250);
            }

            // The whole trap: the dead lines still parse into a full modal, so
            // the FSM is still reporting `approval` and mesh_approve is happy to
            // aim at it. If the modal had NOT parsed, clickModalButton would
            // return false for the boring reason (`!m`) and this test would
            // prove nothing — so pin that the button really is still matchable.
            expect(driver.getFsmDebug().currentState).toBe('approval');
            expect(seen.modal, 'the stale list must still parse — that is the trap').toBeTruthy();
            expect(seen.modal!.buttons.map(b => b.label)).toContain('Yes');

            pty.writes.length = 0;
            // Pre-fix: returned true and wrote a bare '\r' into the composer.
            expect(driver.clickModalButton(1)).toBe(false);
            expect(pty.writes, 'a guessed keystroke lands in the composer').toEqual([]);
        } finally { driver.shutdown(); }
    }, 40000);

    it('the bare CR that the old code wrote does NOT resolve — FSM returns to approval', async () => {
        // This is the defect's own fingerprint, asserted on the TRANSITION
        // DIRECTION rather than on any parse-state proxy: feeding the empty-
        // message submit the old fallback produced leaves the machine looping
        // back into `approval`, which is what "success but nothing approved"
        // looked like on the wire.
        const { driver, pty } = makeDriver();
        try {
            pty.feed(paint(LIVE_MODAL, 6));
            await sleep(900);

            for (let i = 0; i < 14; i++) {
                pty.feed(paint(STALE_SCROLLBACK(i), 10));
                await sleep(250);
            }
            expect(driver.getFsmDebug().currentState).toBe('approval');

            // An empty submit makes claude-cli spin, then repaint the SAME stale
            // screen — the modal never goes away, so the machine comes back.
            for (let i = 0; i < 6; i++) {
                pty.feed(paint(STALE_SCROLLBACK(100 + i), 10));
                await sleep(250);
            }

            const st = driver.getFsmDebug().currentState;
            expect(st, `stuck in the approval flap, got ${st}`).toBe('approval');
            // …and the fix keeps refusing rather than feeding the loop again.
            pty.writes.length = 0;
            expect(driver.clickModalButton(1)).toBe(false);
            expect(pty.writes).toEqual([]);
        } finally { driver.shutdown(); }
    }, 40000);
});
