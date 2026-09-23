/**
 * APPROVE-LATCH-STALE fix ② — floor wake while parked at a modal.
 *
 * Live defect (2026-09-23, win32 + antigravity, 3/3): mesh_approve refused a
 * session whose status was waiting_approval, because every modal source read
 * null. The modal latch is refreshed only when FsmDriver emits; FsmDriver emits
 * only from a PTY frame or an armed wake timer; and `scheduleWakeForState` arms
 * a timer only for a FINITE pending time-condition. An approval state whose
 * outgoing transitions are pure CONTENT guards therefore arms nothing — see the
 * shipping antigravity spec, whose `approval→busy` / `approval→idle` edges carry
 * only `not section matches` (plus a 300ms min_hold that expires immediately).
 *
 * The stall watchdog cannot cover this either: it is `generating`-only by
 * construction (fsm-driver scheduleStallWatchdog).
 *
 * So on a quiet PTY the latch freezes at whatever the state-ENTRY frame parsed.
 * This file pins that the driver now re-evaluates on its own while parked at a
 * modal, and — the counter-invariant — that the floor does NOT dismiss a prompt
 * nobody answered, and does not arm itself outside modal states.
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
    HERE, '../../../../../../adhdev-providers/cli/antigravity-cli/specs/4.0.json',
);
const specAvailable = fs.existsSync(SPEC_PATH);
const maybe = specAvailable ? describe : describe.skip;

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

/** A real antigravity approval modal (the shape the shipping spec anchors on). */
const MODAL_OPEN = [
    '  Running command',
    '',
    ' Do you want to proceed?',
    '',
    ' ❯ 1. Yes',
    '   2. Yes, and don\'t ask again for this command',
    '   3. No, and tell agy what to do differently',
    '',
    ' ? for shortcuts',
];

const IDLE_SCREEN = [
    '  Ready.',
    '',
    '❯',
    '',
    ' ? for shortcuts',
];

maybe('FsmDriver — approval-state floor wake keeps the modal latch fresh (APPROVE-LATCH-STALE ②)', () => {
    if (!specAvailable) return;

    /** Drive to a committed `approval` state with the modal drawn, then stop
     *  feeding the PTY entirely — the live "agy went quiet at the modal" shape. */
    async function parkAtModal() {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: SPEC_PATH,
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        const emits: Array<{ state: string; buttons: number }> = [];
        driver.subscribe((ev: any) => {
            if (ev.kind === 'state_changed') {
                emits.push({ state: ev.state.id, buttons: ev.modal ? ev.modal.buttons.length : 0 });
            }
        });
        driver.start();
        const pty = factory.last!;
        pty.feed(paint(MODAL_OPEN, 5));
        await sleep(700);
        return { driver, pty, emits };
    }

    it('commits to approval with the modal parsed (setup is real, against the shipping spec)', async () => {
        const { driver, pty, emits } = await parkAtModal();
        try {
            const dbg = driver.getFsmDebug();
            expect(dbg.currentState).toBe('approval');
            expect(dbg.status).toBe('approval');
            // The modal really parsed — this fixture is not silently button-less,
            // which would make every assertion below vacuous.
            const lastWithModal = [...emits].reverse().find(e => e.state === 'approval');
            expect(lastWithModal?.buttons ?? 0).toBeGreaterThanOrEqual(2);
        } finally { driver.shutdown(); void pty; }
    });

    it('keeps re-evaluating while parked at the modal on a COMPLETELY quiet PTY', async () => {
        // THE assertion fix ② exists for. Without the floor, `soonest` stays
        // Infinity for this state (the approval exits are pure content guards and
        // the 300ms min_hold has long expired), scheduleWakeForState returns having
        // armed nothing, and reevaluate() never runs again after the last PTY frame
        // — so the adapter's latched modal is frozen forever.
        //
        // evalCount is the only honest observable here: every other debug field is
        // re-derived live on read, so a stale latch LOOKS current in all of them.
        // That is exactly the blind spot that let this reach production.
        const { driver, pty } = await parkAtModal();
        try {
            const before = driver.getFsmDebug().evalCount;

            // Go quiet for two-plus floor intervals. No PTY data at all: nothing
            // but a timer of our own can produce a re-evaluation.
            await sleep(2 * 2000 + 600);

            const after = driver.getFsmDebug().evalCount;
            expect(
                after - before,
                `expected >=2 floor-driven re-evaluations over ~4.6s at a modal, got ${after - before}`,
            ).toBeGreaterThanOrEqual(2);
            // …and the floor did not run away: ~4.6s at a 2s floor is a handful of
            // wakes, not a spin loop.
            expect(after - before).toBeLessThan(12);
            // Still parked — the re-evaluations observed the same screen.
            expect(driver.getFsmDebug().currentState).toBe('approval');
        } finally { driver.shutdown(); void pty; }
    });

    it('arms NO floor wake in a non-modal state (the floor is scoped, not global)', async () => {
        // Counter-invariant for the scope of fix ②: an idle session on a quiet PTY
        // must stay as cheap as it was before. If the floor leaked out of modal
        // states it would turn every parked session into a permanent 0.5Hz poller.
        const { driver, pty } = await parkAtModal();
        try {
            pty.feed(paint(IDLE_SCREEN, 3));
            await sleep(900);
            expect(driver.getFsmDebug().currentState).not.toBe('approval');

            const before = driver.getFsmDebug().evalCount;
            await sleep(2 * 2000 + 600);
            const after = driver.getFsmDebug().evalCount;
            expect(
                after - before,
                `idle state should not self-poll, but ran ${after - before} extra evaluations`,
            ).toBeLessThanOrEqual(1);
        } finally { driver.shutdown(); void pty; }
    });

    it('does NOT dismiss an unanswered modal just because the floor keeps firing', async () => {
        // Counter-invariant. The floor re-runs the SAME evaluation the PTY pump
        // would run; it must not become a way for a prompt to time itself out.
        const { driver, pty } = await parkAtModal();
        try {
            await sleep(3 * 2000 + 500);
            const dbg = driver.getFsmDebug();
            expect(dbg.currentState, `expected approval, got ${dbg.currentState}`).toBe('approval');
            expect(dbg.status).toBe('approval');
        } finally { driver.shutdown(); void pty; }
    });

    it('still escapes approval promptly once the screen shows the modal is gone', async () => {
        // The floor must not interfere with the normal exit path.
        const { driver, pty } = await parkAtModal();
        try {
            expect(driver.getFsmDebug().currentState).toBe('approval');
            pty.feed(paint(IDLE_SCREEN, 3));
            await sleep(900);
            const st = driver.getFsmDebug().currentState;
            expect(st, `expected to leave approval, got ${st}`).not.toBe('approval');
        } finally { driver.shutdown(); void pty; }
    });

    it('refreshNow() re-emits the current state on demand (the fix ① plumbing)', async () => {
        // handleResolveAction calls this through SpecCliAdapter.refreshModalNow.
        // It must emit even when nothing changed — the adapter's latch is updated
        // by the listener, so a `changed`-gated emit would skip the null→null case
        // the approve gate has to be able to tell apart from null→buttons.
        const { driver, pty, emits } = await parkAtModal();
        try {
            const before = emits.length;
            driver.refreshNow();
            expect(emits.length).toBe(before + 1);
            const last = emits[emits.length - 1];
            expect(last.state).toBe('approval');
            expect(last.buttons).toBeGreaterThanOrEqual(2);
        } finally { driver.shutdown(); void pty; }
    });
});
