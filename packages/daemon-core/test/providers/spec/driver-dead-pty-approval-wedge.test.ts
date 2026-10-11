/**
 * DEAD-PTY-APPROVAL-WEDGE (live 2026-10-11, antigravity-cli session a82e5031).
 *
 * Live log shape (coordinator-confirmed):
 *
 *   [FsmDriver] PTY write skipped source=stall-refocus outcome=no-active-pty
 *   [FsmDriver] busy → approval ("busy→approval-timeout")
 *   [CLI] dropped agent:waiting_approval from disposed instance a82e5031
 *
 * The PTY died mid-turn, but the FSM's time-based `busy→approval-timeout` edge
 * (elapsed_ms + stable_ms on a frozen screen) still fired — synthesizing an
 * approval state with no modal behind it. The adapter then projected
 * waiting_approval from a dead session and the mesh task sat 'assigned' for
 * 15 minutes with nobody able to claim it, until the coordinator force-
 * requeued it by hand.
 *
 * The fix gates FsmDriver.reevaluate() on TerminalAdapter.hasActivePty(): with
 * no PTY the screen can never change again, so no evaluation — and therefore
 * no transition — may run. This file pins BOTH directions:
 *
 *   ① dead PTY  → the timeout edge never fires (no synthetic approval), even
 *     when a post-death refreshNow() poke (the mesh_approve recovery path)
 *     lands on the stale frame;
 *   ② live PTY  → a real modal still reaches approval with parsed buttons
 *     (the owner can still approve), and the timeout edge itself still fires
 *     when the session is genuinely alive but stuck (the legitimate purpose
 *     of the edge).
 */
import { afterEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { projectAdapterStatus } from '../../../src/providers/spec/adapter-status-projection.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Paint `lines` onto a cleared screen and park the cursor below them. */
function paint(lines: string[]): string {
    return `\x1b[2J\x1b[H${lines.join('\r\n')}\x1b[${lines.length + 1};1H`;
}

const BUSY_SCREEN = [
    'Generating answer',
    'working on the task',
    '',
];
const MODAL_SCREEN = [
    ' Do you want to proceed?',
    '',
    ' ❯ 1. Yes',
    '   2. No',
    '',
];

/**
 * Minimal spec shaped exactly like the shipping antigravity wedge: a content
 * edge into approval at priority 100 and a TIME-ONLY `busy→approval-timeout`
 * edge at priority 90 (the shipping one is elapsed 90s + stable 5s; shrunk
 * here so the test runs in milliseconds).
 */
const FIXTURE_SPEC = {
    $schema: 'adhdev:cli/spec@4',
    id: 'dead-pty-fixture',
    name: 'Dead PTY Fixture',
    binary: 'fixture-cli',
    send_message: { submit_key: '\r' },
    sections: {},
    states: [
        { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
        { id: 'busy', label: 'Generating', status: 'generating' },
        {
            id: 'approval', label: 'Approval requested', status: 'approval',
            modal: true, modal_kind: 'approval',
            extract: {
                buttons: {
                    pattern: '^\\s*(?:❯\\s*)?(\\d+)\\.\\s*(\\S.+?)\\s*$',
                    flags: 'gm',
                    key_for_index: '{index}\r',
                    min_count: 2,
                },
            },
        },
    ],
    transitions: [
        { label: 'starting→busy', from: 'starting', to: 'busy', when: { matches: 'Generating answer' } },
        { label: 'busy→approval', from: 'busy', to: 'approval', priority: 100, when: { matches: 'Do you want to proceed\\?' } },
        {
            label: 'busy→approval-timeout', from: 'busy', to: 'approval', priority: 90,
            when: { all: [{ not: { matches: 'Do you want to proceed\\?' } }, { stable_ms: 100 }, { elapsed_ms: 400 }] },
        },
    ],
};

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4713;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    killed = false;
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    /** The driver kills the transport on teardown; death itself is die(). */
    kill(): void { this.killed = true; }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
    /** The child process died — the transport reports exit, once. */
    die(): void { this.exitCb?.({ exitCode: 0 }); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

interface EmittedState { state: string; buttons: number }

const drivers: FsmDriver[] = [];
afterEach(() => {
    for (const d of drivers.splice(0)) { try { d.shutdown(); } catch { /* already down */ } }
});

let specPathCache = '';
function specPath(): string {
    if (specPathCache) return specPathCache;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-pty-wedge-'));
    specPathCache = path.join(dir, 'spec.json');
    fs.writeFileSync(specPathCache, JSON.stringify(FIXTURE_SPEC));
    return specPathCache;
}

/** Boot the fixture spec and drive it into `busy`. */
async function bootIntoBusy(): Promise<{ driver: FsmDriver; pty: DrivablePty; emits: EmittedState[] }> {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath: specPath(),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
        sessionId: 'dead-pty-wedge-test',
    });
    drivers.push(driver);
    const emits: EmittedState[] = [];
    driver.subscribe((ev: any) => {
        if (ev.kind === 'state_changed') {
            emits.push({ state: ev.state.id, buttons: ev.modal ? ev.modal.buttons.length : 0 });
        }
    });
    driver.start();
    const pty = factory.last!;
    pty.feed(paint(BUSY_SCREEN));
    await sleep(300); // screen-change debounce + evaluation; well under elapsed_ms 400
    expect(driver.getFsmDebug().currentState).toBe('busy');
    return { driver, pty, emits };
}

describe('FsmDriver — dead PTY must not synthesize approval (DEAD-PTY-APPROVAL-WEDGE)', () => {
    it('① never fires busy→approval-timeout after the PTY died, even when poked via refreshNow()', async () => {
        const { driver, pty, emits } = await bootIntoBusy();
        // Kill the child BEFORE the timeout edge can legitimately fire. The
        // exit tears the driver down (timers cleared), exactly the live shape.
        pty.die();
        expect(driver.getFsmDebug().currentState).toBe('busy');

        // Let elapsed_ms(400) + stable_ms(100) lapse against the frozen frame…
        await sleep(600);
        // …then poke a re-evaluation the way the mesh_approve recovery path
        // does (SpecCliAdapter.refreshModalNow → driver.refreshNow). Without
        // the gate this evaluation commits busy→approval-timeout on the stale
        // screen — the exact synthetic approval from the live log.
        driver.refreshNow();
        await sleep(100);

        expect(
            driver.getFsmDebug().currentState,
            'a dead PTY must never reach approval — the timeout edge is time-synthesized fiction on a frozen frame',
        ).toBe('busy');
        expect(
            emits.filter(e => e.state === 'approval'),
            `no approval state_changed may be emitted after PTY death, got ${JSON.stringify(emits)}`,
        ).toEqual([]);
    });

    it('②a a REAL modal on a LIVE PTY still reaches approval with parsed buttons (and projects waiting_approval)', async () => {
        const { driver, pty, emits } = await bootIntoBusy();
        pty.feed(paint(MODAL_SCREEN));
        await sleep(400);

        expect(driver.getFsmDebug().currentState).toBe('approval');
        const approvalEmit = [...emits].reverse().find(e => e.state === 'approval');
        expect(
            approvalEmit?.buttons ?? 0,
            'the modal really parsed — a button-less fixture would make this assertion vacuous',
        ).toBeGreaterThanOrEqual(2);

        // The daemon-visible projection: this is the status the owner approves
        // through. (Direct call of the untouched pure projection — no mock.)
        const projected = projectAdapterStatus({
            providerSessionId: undefined,
            providerFailure: null,
            exited: false,
            spawned: true,
            activeInteractivePrompt: null,
            state: { id: 'approval', label: 'Approval requested', title: null, status: 'approval' },
            modal: { title: null, buttons: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }], kind: 'approval' },
            readySeen: () => true,
            lastOutputAt: Date.now(),
            lastScreenChangeAt: Date.now(),
        });
        expect(projected.status).toBe('waiting_approval');
        expect(projected.activeModal?.buttons).toEqual(['Yes', 'No']);
    });

    it('②b the timeout edge itself still fires on a LIVE PTY (the gate is liveness, not "no timeouts")', async () => {
        const { driver } = await bootIntoBusy();
        // Quiet, live PTY: the driver's own wake timer arms on the elapsed
        // countdown at busy entry and fires the edge once 400ms lapse — the
        // legitimate "agent stopped rendering mid-turn" fallback this edge
        // exists for.
        await sleep(900);
        expect(
            driver.getFsmDebug().currentState,
            'busy→approval-timeout must still fire when the PTY is alive but the screen froze mid-turn',
        ).toBe('approval');
    });
});
