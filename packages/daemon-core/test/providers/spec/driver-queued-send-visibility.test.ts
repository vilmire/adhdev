/**
 * QUEUED-SEND-LOSS regression coverage.
 *
 * An owner send that arrives while the agent is generating is parked in the
 * driver's in-memory `pendingSends` FIFO. Two things then made a lost prompt
 * undetectable:
 *
 *   1. `shutdown()` cleared the backlog with NO log line at all, so a driver
 *      torn down with a queued body left no evidence anywhere that owner input
 *      had been dropped;
 *   2. the daemon reported the send as plain success before the PTY write, so
 *      the dashboard cleared the draft box on an ack that only ever meant
 *      "accepted for later".
 *
 * In the live incident the queue drained after 35.5s and the prompt survived.
 * Had the daemon restarted inside that window the text would have been gone
 * with nobody — user, transcript, or log — able to tell.
 *
 * These tests assert the two halves of the visibility fix:
 *   1. discarding a non-empty queue on shutdown emits a warning naming the
 *      session, the count and the body lengths (and never the bodies);
 *   2. a queued send and a submitted send are reported as DIFFERENT states.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { LOG } from '../../../src/logging/logger.js';
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

/** Same minimal idle↔generating machine used by the send-overlap gate tests. */
function busyCycleSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.queued-send',
        name: 'queued send visibility test',
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

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-queued-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const IDLE_FRAME = '\n>\n? for shortcuts';
const BUSY_FRAME = '\n>\nThinking...';

const TEST_SESSION_ID = 'sess-queued-send-0001';

function makeDriver(): { driver: FsmDriver; pty: DrivablePty } {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath: writeSpec(busyCycleSpec()),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
        sessionId: TEST_SESSION_ID,
    });
    driver.start();
    return { driver, pty: factory.last! };
}

async function reachReady(pty: DrivablePty): Promise<void> {
    pty.feed(IDLE_FRAME);
    await sleep(300);
}

/** Drive to idle, then into generating, so any further send must queue. */
async function reachGenerating(pty: DrivablePty): Promise<void> {
    await reachReady(pty);
    pty.feed(BUSY_FRAME);
    await sleep(300);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('FsmDriver -- queued send visibility', () => {
    it('logs a warning naming session, count and lengths when shutdown discards queued sends', async () => {
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => { /* capture only */ });
        const { driver, pty } = makeDriver();
        await reachGenerating(pty);

        // Two owner sends arrive mid-turn: both queue, neither is written.
        driver.dispatch({ kind: 'send_message', text: 'A'.repeat(120) });
        driver.dispatch({ kind: 'send_message', text: 'B'.repeat(340) });
        await sleep(300);
        expect(pty.writes.join('')).not.toContain('A'.repeat(120));

        // The driver is torn down with the backlog still in memory — the exact
        // shape of the silent-loss window.
        driver.shutdown();

        const discardLogs = warn.mock.calls
            .map(call => call.join(' '))
            .filter(line => line.includes('DISCARDING'));

        expect(discardLogs.length).toBe(1);
        const line = discardLogs[0];
        expect(line).toContain('2 queued send(s)');
        expect(line).toContain(TEST_SESSION_ID);
        expect(line).toContain('120,340');
        // Content-free: the log records that input was lost and how much, never
        // the prompt bodies themselves.
        expect(line).not.toContain('A'.repeat(120));
        expect(line).not.toContain('B'.repeat(340));
    });

    it('does not log a discard warning when the queue is empty at shutdown', async () => {
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => { /* capture only */ });
        const { driver, pty } = makeDriver();
        await reachReady(pty);

        // Sent at an idle prompt — goes straight to the PTY, nothing queues.
        driver.dispatch({ kind: 'send_message', text: 'STRAIGHT-THROUGH' });
        await sleep(500);
        expect(pty.writes.join('')).toContain('STRAIGHT-THROUGH');

        driver.shutdown();

        const discardLogs = warn.mock.calls
            .map(call => call.join(' '))
            .filter(line => line.includes('DISCARDING'));
        expect(discardLogs.length).toBe(0);
    });

    it('reports a queued send and a submitted send as DIFFERENT states', async () => {
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);

            // At an idle prompt the body reaches the PTY: `delivered`.
            const submitted = driver.sendMessageWithDisposition('SUBMITTED-BODY');
            expect(submitted.status).toBe('delivered');
            await sleep(500);
            expect(pty.writes.join('')).toContain('SUBMITTED-BODY');

            // Mid-turn the body only enters the FIFO: `queued`, NOT delivered.
            pty.feed(BUSY_FRAME);
            await sleep(300);
            const queued = driver.sendMessageWithDisposition('QUEUED-BODY');
            expect(queued.status).toBe('queued');
            expect(queued.status === 'queued' && queued.queueDepth).toBe(1);
            expect(queued.status === 'queued' && queued.reason).toContain('generating');

            // The distinction is real, not cosmetic: nothing was written.
            await sleep(300);
            expect(pty.writes.join('')).not.toContain('QUEUED-BODY');

            // And it still drains normally once the machine frees up.
            pty.feed(IDLE_FRAME);
            await sleep(900);
            expect(pty.writes.join('')).toContain('QUEUED-BODY');
        } finally {
            driver.shutdown();
        }
    });

    it('reports queued for a send arriving before the machine is ever ready', async () => {
        const { driver, pty } = makeDriver();
        try {
            // No idle frame yet — the ready latch has never been set.
            const queued = driver.sendMessageWithDisposition('PRE-READY-BODY');
            expect(queued.status).toBe('queued');
            expect(queued.status === 'queued' && queued.reason).toContain('not ready');
            await sleep(200);
            expect(pty.writes.join('')).not.toContain('PRE-READY-BODY');
        } finally {
            driver.shutdown();
        }
    });
});
