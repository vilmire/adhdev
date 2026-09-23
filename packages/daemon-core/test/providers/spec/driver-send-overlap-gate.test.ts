/**
 * Regression coverage for SEND-OVERLAP — the duplicate + mid-body-truncated
 * prompt observed live on antigravity/darwin (2026-08-10).
 *
 * One coordinator-side enqueue of a ~1.5KB task reached the worker transcript as
 * TWO user bubbles 8.5s apart, the second missing ~90 chars out of its MIDDLE
 * while head and tail survived — the signature of two bodies braided into one
 * composer, not of a truncating overflow.
 *
 * Root cause: handleSendMessage gated only on `readySeenOnce`, a ONE-SHOT latch.
 * After the machine had been ready once, every later send went to the PTY without
 * consulting the live FSM state, so a resend arriving mid-turn was written on top
 * of a still-generating turn.
 *
 * These tests assert the driver half of the fix:
 *   1. a send arriving while the machine is generating is NOT written to the PTY,
 *      and is drained once the machine returns to idle;
 *   2. the parked body carries its `messageId` (wiring-unification D2), which is
 *      what the ONE dedupe upstream (sessions/session-input-service.ts) checks a
 *      redelivery against — the driver itself no longer drops a body by content
 *      (the 60 s content-hash gate is deleted; test/sessions/session-input-
 *      service.test.ts pins the redelivery-written-once guarantee end to end).
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
    readonly pid = 4343;
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

/**
 * Minimal three-state machine with an observable idle↔generating cycle, driven
 * entirely by screen content so the test controls exactly when the machine is
 * busy:
 *   starting --"? for shortcuts"--> idle --"Thinking"--> generating --"? for shortcuts"--> idle
 */
function busyCycleSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.send-overlap',
        name: 'send overlap gate test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Working', status: 'generating' },
        ],
        transitions: [
            {
                label: 'starting→idle',
                from: 'starting',
                to: 'idle',
                when: { section: 'footer', matches: '\\? for shortcuts' },
            },
            {
                label: 'idle→generating',
                from: 'idle',
                to: 'generating',
                when: { section: 'footer', matches: 'Thinking' },
            },
            {
                label: 'generating→idle',
                from: 'generating',
                to: 'idle',
                when: { section: 'footer', matches: '\\? for shortcuts' },
            },
        ],
    };
}

const __tmpDirsToClean: string[] = [];

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-overlap-'));
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

/** Drive the machine to its first idle (ready) state and let the gate settle. */
async function reachReady(pty: DrivablePty): Promise<void> {
    pty.feed(IDLE_FRAME);
    await sleep(300);
}

describe('FsmDriver -- send overlap gate', () => {
    it('does not write a send to the PTY while the machine is generating, and drains it on return to idle', async () => {
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);

            // Turn 1 goes out normally at the idle prompt.
            driver.dispatch({ kind: 'send_message', text: 'TURN-ONE-BODY' });
            await sleep(600);
            expect(pty.writes.join('')).toContain('TURN-ONE-BODY');

            // The agent starts working — machine is now `generating`.
            pty.feed(BUSY_FRAME);
            await sleep(300);

            // Turn 2 arrives MID-TURN. This is the live defect: before the fix it
            // was written straight into the composer on top of the running turn.
            driver.dispatch({ kind: 'send_message', text: 'TURN-TWO-BODY' });
            await sleep(800);
            expect(pty.writes.join('')).not.toContain('TURN-TWO-BODY');

            // The turn finishes and the prompt comes back — now it must land.
            pty.feed(IDLE_FRAME);
            await sleep(900);
            expect(pty.writes.join('')).toContain('TURN-TWO-BODY');
        } finally {
            driver.shutdown();
        }
    });

    it('parks a mid-turn body under its messageId and drains it exactly once', async () => {
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);

            const body = 'REDELIVERED-TASK-BODY';
            expect(driver.sendMessageWithDisposition(body, false, 'msg_first')).toEqual({ status: 'delivered' });
            await sleep(600);

            // The agent picks the turn up.
            pty.feed(BUSY_FRAME);
            await sleep(300);

            // A second body arrives mid-turn: parked under ITS id, never written now.
            const parked = driver.sendMessageWithDisposition(body, false, 'msg_second');
            expect(parked.status).toBe('queued');
            expect(driver.hasQueuedSend('msg_second')).toBe(true);
            expect(driver.queuedMessageIds()).toEqual(['msg_second']);
            await sleep(500);
            expect(pty.writes.join('').split(body).length - 1).toBe(1);

            // Turn completes; the queue drains that one parked body once.
            pty.feed(IDLE_FRAME);
            await sleep(900);

            expect(driver.hasQueuedSend('msg_second')).toBe(false);
            expect(pty.writes.join('').split(body).length - 1).toBe(2);
        } finally {
            driver.shutdown();
        }
    });

    it('still delivers a genuinely repeated body typed at a settled idle prompt', async () => {
        // Guard against over-correcting: suppressing every repeat within 60s
        // would break ordinary use ("continue", "y", "run it again").
        const { driver, pty } = makeDriver();
        try {
            await reachReady(pty);

            driver.dispatch({ kind: 'send_message', text: 'continue' });
            await sleep(600);
            // Full turn completes and the machine settles back at the prompt.
            pty.feed(BUSY_FRAME);
            await sleep(300);
            pty.feed(IDLE_FRAME);
            await sleep(400);

            driver.dispatch({ kind: 'send_message', text: 'continue' });
            await sleep(700);

            const occurrences = pty.writes.join('').split('continue').length - 1;
            expect(occurrences).toBe(2);
        } finally {
            driver.shutdown();
        }
    });
});
