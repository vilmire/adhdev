/**
 * APPROVAL-MODAL-VANISHED wedge — end-to-end coverage through the real
 * FsmDriver (not just the pure evaluator), against the SHIPPING claude-cli
 * spec, driven by real ANSI frames through a fake PTY.
 *
 * Live symptom (2026-08-03, Windows moltbot): `State: approval /
 * waiting_approval` with `Modal: none`, oscillating approval ↔
 * approval_resolving roughly once a second, indefinitely. Switching the inner
 * Claude to auto mode did not release it.
 *
 * The evaluator-level tests in test/claude-cli-approval-spinner-wedge.test.ts
 * pin the transition table. This file pins the part those cannot: that the
 * driver's OWN region-change tracking — which is what decides whether
 * `stable_ms` is satisfiable — still lets the machine out. The distinction
 * matters because the wedge only bites when the screen keeps REPAINTING: on a
 * quiet screen the pre-existing `approval→idle` edge (stable_ms:3000 +
 * cursor_above:5) already escapes, which is exactly why this defect looked
 * intermittent and why an evaluator test with a synthetic all-stable clock
 * passes with or without the fix.
 *
 * Here the `⏵⏵ auto mode on` banner is repainted every 250ms — the live
 * condition — so `stable_ms:3000` can never be satisfied and only the
 * modal-absence rule can fire.
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

/** Clear screen + home, then draw `lines` from row 1 and park the cursor. */
function paint(lines: string[], cursorRow: number): string {
    return `\x1b[2J\x1b[H${lines.join('\r\n')}\x1b[${cursorRow};1H`;
}

/** A real claude-cli approval modal (the Bash-consent shape). */
const MODAL_OPEN = [
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
 * The wedge screen: modal GONE (no choices, no question, no Esc hatch), NO
 * spinner, and the `⏵⏵ auto mode on` banner sitting between two rules — which
 * is what re-anchored the `modal` section and made deriveModal report
 * `Modal: none` on every frame.
 */
const MODAL_GONE = (tick: number) => [
    '⏺ Ran the command.',
    `  ⎿  done ${tick}`,
    '',
    RULE,
    '⏵⏵ auto mode on',
    RULE,
    '❯',
];

maybe('FsmDriver — claude-cli approval modal vanished on a REPAINTING screen', () => {
    if (!specAvailable) return;

    async function driveToWedge() {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: SPEC_PATH,
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;

        // 1. Open a real approval modal and let the FSM commit to `approval`.
        pty.feed(paint(MODAL_OPEN, 6));
        await sleep(900);
        return { driver, pty };
    }

    it('commits to approval while the modal is open (setup is real)', async () => {
        const { driver, pty } = await driveToWedge();
        try {
            const dbg = driver.getFsmDebug();
            expect(dbg.currentState).toBe('approval');
            // …and it reports the approval STATUS the dashboard keys on.
            expect(dbg.status).toBe('approval');
        } finally { driver.shutdown(); void pty; }
    });

    it('does NOT leave approval while the modal stays open on a repainting screen', async () => {
        // The counter-invariant: the same repaint churn that the fix relies on
        // must not let it dismiss a prompt the user never answered.
        const { driver, pty } = await driveToWedge();
        try {
            for (let i = 0; i < 12; i++) {
                // Repaint the modal in place, cursor jitter and all.
                pty.feed(paint(MODAL_OPEN, 6));
                await sleep(250);
            }
            expect(driver.getFsmDebug().currentState).toBe('approval');
        } finally { driver.shutdown(); void pty; }
    });

    it('escapes approval once the modal is gone, with NO spinner and NO quiet screen', async () => {
        const { driver, pty } = await driveToWedge();
        try {
            expect(driver.getFsmDebug().currentState).toBe('approval');

            // 2. Modal closes. The screen keeps repainting (the banner ticks),
            //    so stable_ms:3000 is never satisfiable, and there is no
            //    spinner, so every spinner-gated exit stays shut. Pre-fix this
            //    is the wedge: no edge can fire, ever.
            for (let i = 0; i < 16; i++) {
                pty.feed(paint(MODAL_GONE(i), 7));
                await sleep(250);
            }

            // ~4s of modal-absence on a never-quiet screen. The probation
            // window is 1200ms, so this must have settled to idle long ago.
            const st = driver.getFsmDebug().currentState;
            expect(st, `expected idle, got ${st}`).toBe('idle');
        } finally { driver.shutdown(); void pty; }
    });

    it('returns to approval when the modal reappears mid-probation (transient parse miss)', async () => {
        const { driver, pty } = await driveToWedge();
        try {
            // Modal blinks out for less than the probation window …
            pty.feed(paint(MODAL_GONE(0), 7));
            await sleep(400);
            // … then comes back. This is the deriveModal transient-miss case
            // (fsm-driver.ts:841-845) and it must NOT have settled to idle.
            for (let i = 0; i < 8; i++) {
                pty.feed(paint(MODAL_OPEN, 6));
                await sleep(250);
            }
            const dbg = driver.getFsmDebug();
            expect(dbg.currentState, `expected approval, got ${dbg.currentState}`).toBe('approval');
            // Status never left 'approval' across the blink — a transient
            // parse miss must be invisible to the dashboard.
            expect(dbg.status).toBe('approval');
        } finally { driver.shutdown(); void pty; }
    });
});
