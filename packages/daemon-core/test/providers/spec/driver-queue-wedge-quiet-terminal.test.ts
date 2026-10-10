/**
 * QUEUE-WEDGE — a send the CLI never consumed must not strand the sends queued
 * behind it when the terminal is quiet.
 *
 * Live defect, 2026-10-10 (MainPC, win32, claude-cli assistant): the first
 * message was typed into a startup dialog, so its submit was never confirmed
 * ("SUBMIT NOT CONFIRMED after 14 submit-key attempts"). Two more messages were
 * queued behind it and stayed there: the in-flight latch does expire, but the
 * expiry was only ever observed from the driver's evaluation loop, which runs
 * on PTY frames — and a CLI sitting at an untouched prompt emits none. The
 * session read `idle` with two bodies silently parked until an unrelated
 * keystroke produced a frame.
 *
 * The tests feed NO frame after the first send: any drain here is the engine
 * waking itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { SEND_IN_FLIGHT_MAX_MS } from '../../../src/providers/spec/submit-policy.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4747;
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

function spec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.queue-wedge',
        name: 'queue wedge test',
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

const tmpDirs: string[] = [];
const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
    vi.useRealTimers();
    setPlatform(ORIGINAL_PLATFORM);
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function readyDriver(): Promise<{ driver: FsmDriver; pty: DrivablePty }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-queue-wedge-'));
    tmpDirs.push(dir);
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec()));
    const factory = new DrivableFactory();
    const driver = new FsmDriver({ specPath, workingDir: os.tmpdir(), hotReload: false, transportFactory: factory });
    driver.start();
    const pty = factory.last!;
    pty.feed('\n>\n? for shortcuts');
    await vi.advanceTimersByTimeAsync(300);
    return { driver, pty };
}

describe('FsmDriver — queued sends behind a send the CLI never consumed', () => {
    it('drains the queue when the in-flight latch expires, with no PTY frame to wake it', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        try {
            expect(driver.sendMessageWithDisposition('FIRST-BODY', false, 'm1')).toEqual({ status: 'delivered' });
            await vi.advanceTimersByTimeAsync(2_000);
            // The CLI never reacts: no frame, the machine stays idle.
            expect(driver.sendMessageWithDisposition('SECOND-BODY', false, 'm2').status).toBe('queued');
            expect(driver.sendMessageWithDisposition('THIRD-BODY', false, 'm3').status).toBe('queued');

            await vi.advanceTimersByTimeAsync(SEND_IN_FLIGHT_MAX_MS - 5_000);
            expect(pty.writes.join('')).not.toContain('SECOND-BODY');

            await vi.advanceTimersByTimeAsync(6_000);
            expect(pty.writes.join('')).toContain('SECOND-BODY');
            expect(driver.hasQueuedSend('m2')).toBe(false);
            // One body per latch: the third waits for the second's own slot.
            expect(pty.writes.join('')).not.toContain('THIRD-BODY');
            expect(driver.hasQueuedSend('m3')).toBe(true);

            await vi.advanceTimersByTimeAsync(SEND_IN_FLIGHT_MAX_MS + 1_000);
            expect(pty.writes.join('')).toContain('THIRD-BODY');
            expect(driver.queuedMessageIds()).toEqual([]);
        } finally {
            driver.shutdown();
        }
    });

    it('win32: an unconfirmed submit gives its slot back and the next queued body is attempted', async () => {
        vi.useFakeTimers();
        setPlatform('win32');
        const { driver, pty } = await readyDriver();
        try {
            expect(driver.sendMessageWithDisposition('FIRST-BODY', false, 'm1')).toEqual({ status: 'delivered' });
            await vi.advanceTimersByTimeAsync(1_000);
            expect(driver.sendMessageWithDisposition('SECOND-BODY', false, 'm2').status).toBe('queued');

            // Echo-gate blind fire (20 s) + the 14-attempt resend net (≈33.25 s): the
            // submit is abandoned at ≈53.25 s, before the 60 s latch expiry.
            for (let i = 0; i < 48; i++) {
                await vi.advanceTimersByTimeAsync(1_000);
            }
            expect(pty.writes.join('')).not.toContain('SECOND-BODY');

            for (let i = 0; i < 5; i++) {
                await vi.advanceTimersByTimeAsync(1_000);
            }
            expect(pty.writes.join('')).toContain('SECOND-BODY');
            expect(driver.hasQueuedSend('m2')).toBe(false);
        } finally {
            driver.shutdown();
        }
    });

    it('cancels the watchdog on shutdown — nothing is written into a dead PTY', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        driver.sendMessageWithDisposition('FIRST-BODY', false, 'm1');
        await vi.advanceTimersByTimeAsync(1_000);
        driver.sendMessageWithDisposition('SECOND-BODY', false, 'm2');
        driver.shutdown();
        await vi.advanceTimersByTimeAsync(SEND_IN_FLIGHT_MAX_MS * 2);
        expect(pty.writes.join('')).not.toContain('SECOND-BODY');
    });
});
