/**
 * (QUEUED-SEND-CANCEL) Cancellation asserted against the REAL driver FIFO.
 *
 * ★ Why this file exists next to test/commands/cancel-queued-chat.test.ts.
 *
 * That file stubs `claimQueuedSends` with a vi.fn, so it proves the command
 * plumbing and nothing about the queue. The live defect the owner reported —
 * "cancelled a message, sent another one, and the cancelled one went too" —
 * is a property of the FIFO itself: which entries survive a claim, and what
 * `drainPendingSends()` writes to the PTY afterwards. A mocked claim cannot
 * observe either, which is exactly why the suite was green while the owner
 * watched a cancelled body reach the agent.
 *
 * So every assertion here is against bytes written to a drivable PTY by a real
 * FsmDriver. The failure mode under test is silent and irreversible: the owner
 * is told a message is gone and the agent answers it minutes later.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4344;
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
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

/** Same minimal idle↔generating machine the send-overlap gate test drives. */
function busyCycleSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.cancel-queued',
        name: 'cancel queued send test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Working', status: 'generating' },
        ],
        transitions: [
            { label: 'starting→idle', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
            { label: 'idle→generating', from: 'idle', to: 'generating', when: { section: 'footer', matches: 'Thinking' } },
            { label: 'generating→idle', from: 'generating', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
        ],
    };
}

const __tmpDirsToClean: string[] = [];

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-cancel-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

afterEach(() => {
    while (__tmpDirsToClean.length > 0) {
        const dir = __tmpDirsToClean.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const IDLE_FRAME = '\n>\n? for shortcuts';
const BUSY_FRAME = '\n>\nThinking...';

function makeDriver(): { driver: FsmDriver; pty: DrivablePty } {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath: writeSpec(busyCycleSpec()),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    driver.start();
    return { driver, pty: factory.last! };
}

async function reachReady(pty: DrivablePty): Promise<void> {
    pty.feed(IDLE_FRAME);
    await sleep(300);
}

/** Drive one full turn so a body queued behind it has a reason to be parked. */
async function startTurn(pty: DrivablePty): Promise<void> {
    pty.feed(BUSY_FRAME);
    await sleep(300);
}

/**
 * Complete one busy→idle cycle so the NEXT queued body can drain.
 *
 * A real CLI leaves idle when it consumes a submit, and that departure is the
 * only thing that releases the driver's in-flight latch (drainPendingSends:
 * "leaving idle is the observable proof the CLI consumed the submit"). Feeding
 * flat idle frames instead would make the queue look wedged for the 30s latch
 * TTL — an artefact of the fake PTY, not of the code under test.
 */
async function completeTurnCycle(pty: DrivablePty): Promise<void> {
    pty.feed(BUSY_FRAME);
    await sleep(300);
    pty.feed(IDLE_FRAME);
    await sleep(600);
}

describe('FsmDriver — a cancelled queued body never reaches the PTY', () => {
    it('★ the owner\'s sequence: queue two, cancel one, send a third — only the survivors land', async () => {
        // This is the reported live defect verbatim. The cancelled body must not
        // appear in the PTY byte stream at ANY later point, including after the
        // unrelated third message re-opens the drain.
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);

            driver.dispatch({ kind: 'send_message', text: 'TURN-ONE' });
            await sleep(500);
            await startTurn(pty);

            // Both queue: the machine is generating.
            driver.dispatch({ kind: 'send_message', text: 'KEEP-THIS-ONE' });
            driver.dispatch({ kind: 'send_message', text: 'CANCEL-THIS-ONE' });
            await sleep(300);
            expect(pty.writes.join('')).not.toContain('CANCEL-THIS-ONE');

            // The owner cancels the second bubble.
            expect(driver.claimQueuedSends('CANCEL-THIS-ONE')).toBe(1);

            // ...then types a new message while still generating.
            driver.dispatch({ kind: 'send_message', text: 'TYPED-AFTER-CANCEL' });
            await sleep(200);

            // The turn ends and the queue drains, one body per turn cycle.
            pty.feed(IDLE_FRAME);
            await sleep(600);
            await completeTurnCycle(pty);
            await completeTurnCycle(pty);

            const written = pty.writes.join('');
            expect(written).toContain('KEEP-THIS-ONE');
            expect(written).toContain('TYPED-AFTER-CANCEL');
            // ★ The assertion the owner's report is about.
            expect(written).not.toContain('CANCEL-THIS-ONE');
        } finally {
            driver.shutdown();
        }
    });

    it('★ cancelling the body that is next to drain does not drag the one behind it out', async () => {
        // Order matters: claiming the HEAD entry must leave the tail parked and
        // deliverable, not silently drop it with the cancellation.
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);
            driver.dispatch({ kind: 'send_message', text: 'TURN-ONE' });
            await sleep(500);
            await startTurn(pty);

            driver.dispatch({ kind: 'send_message', text: 'HEAD-CANCELLED' });
            driver.dispatch({ kind: 'send_message', text: 'TAIL-SURVIVES' });
            await sleep(300);

            expect(driver.claimQueuedSends('HEAD-CANCELLED')).toBe(1);

            pty.feed(IDLE_FRAME);
            await sleep(1_200);

            const written = pty.writes.join('');
            expect(written).toContain('TAIL-SURVIVES');
            expect(written).not.toContain('HEAD-CANCELLED');
        } finally {
            driver.shutdown();
        }
    });

    it('★ two identical queued bodies: cancelling once removes exactly one copy', async () => {
        // Content-keyed removal is the only identity this path has. The owner
        // queueing "continue" twice and cancelling one must keep the other —
        // a filter that dropped every match would lose a body the owner still
        // wants, which is the same class of silent loss in the other direction.
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);
            driver.dispatch({ kind: 'send_message', text: 'TURN-ONE' });
            await sleep(500);
            await startTurn(pty);

            driver.dispatch({ kind: 'send_message', text: 'continue' });
            driver.dispatch({ kind: 'send_message', text: 'continue' });
            await sleep(300);

            const claimed = driver.claimQueuedSends('continue');

            pty.feed(IDLE_FRAME);
            await sleep(600);
            await completeTurnCycle(pty);

            const occurrences = pty.writes.join('').split('continue').length - 1;
            // Whatever claim() reports removed, exactly that many must be gone:
            // 2 queued - claimed = what the agent receives.
            expect(occurrences).toBe(2 - claimed);
        } finally {
            driver.shutdown();
        }
    });

    it('reports 0 — and delivers the body — when the queue already drained', async () => {
        // The race the UI must not hide: the owner presses cancel just after the
        // agent went idle and took the message. `claimQueuedSends` reporting 0 is
        // what tells the dashboard to KEEP the bubble instead of lying about it.
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);
            driver.dispatch({ kind: 'send_message', text: 'TURN-ONE' });
            await sleep(500);
            await startTurn(pty);

            driver.dispatch({ kind: 'send_message', text: 'ALREADY-GONE' });
            await sleep(300);

            // Queue drains before the owner's cancel arrives.
            pty.feed(IDLE_FRAME);
            await sleep(1_200);
            expect(pty.writes.join('')).toContain('ALREADY-GONE');

            expect(driver.claimQueuedSends('ALREADY-GONE')).toBe(0);
        } finally {
            driver.shutdown();
        }
    });
});
