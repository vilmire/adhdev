/**
 * Regression coverage for the "first input never processed" bug.
 *
 * A delegated message sent before the machine is "ready" is queued in
 * pendingSends and only flushed once the FSM first enters a non-initial idle
 * state (the prompt is drawn). That readiness is normally reached BY a
 * transition (e.g. signing_in→idle / starting→idle). Before the fix, reevaluate()
 * returned early on the transition branch WITHOUT draining the queue, and an idle
 * state has no pending time-condition — so scheduleWakeForState() armed no timer
 * and, the CLI being quiet at its prompt, no further PTY frame arrived. The
 * queued first message stranded forever.
 *
 * This test drives the FSM through starting→idle via a single PTY frame and
 * asserts the previously-queued message is flushed to the PTY on that same
 * readiness frame — no further screen activity required.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

// A fake PTY whose onData callback the test can drive, simulating CLI output
// frames, and which records every write so we can assert the flushed message.
class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4242;
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

// Minimal antigravity-shaped FSM: starting → idle once the "? for shortcuts"
// footer marker is present (the real readiness signal — agy only honors input
// once its prompt frame is drawn).
function readyGateSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.ready-gate',
        name: 'ready gate test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
        ],
        transitions: [
            {
                label: 'starting→idle',
                from: 'starting',
                to: 'idle',
                when: { section: 'footer', matches: '\\? for shortcuts' },
            },
        ],
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-ready-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('FsmDriver -- ready-gated queue drain', () => {
    it('flushes a queued first message on the readiness transition frame, with no further PTY activity', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(readyGateSpec()),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // Dispatch BEFORE readiness — must be queued, not written.
            driver.dispatch({ kind: 'send_message', text: 'hello agy' });
            await sleep(20);
            expect(pty.writes.join('')).not.toContain('hello agy');

            // One PTY frame brings up the prompt → fires starting→idle. The CLI
            // then goes quiet (no more frames). The queued message must still
            // flush off THIS frame.
            pty.feed('\n>\n? for shortcuts');
            // adapter coalesces screen changes (~80ms debounce) + maybeMarkReady
            // flush setTimeout(50ms) + the submit-key delay floor (~200ms after
            // the text write).
            await sleep(600);

            const all = pty.writes.join('');
            expect(all).toContain('hello agy');
            // and the submit key followed it.
            expect(pty.writes).toContain('\r');
        } finally {
            driver.shutdown();
        }
    });

    it('does not flush before readiness is reached', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(readyGateSpec()),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            driver.dispatch({ kind: 'send_message', text: 'too early' });
            // A frame that does NOT contain the readiness marker — stays in
            // `starting`, message must remain queued.
            pty.feed('\nSigning in...\n');
            await sleep(250);
            expect(pty.writes.join('')).not.toContain('too early');
        } finally {
            driver.shutdown();
        }
    });
});
