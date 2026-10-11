/**
 * A torn-down driver must stop evaluating.
 *
 * Live 2026-10-11 (antigravity): 8 s after a session was stopped, its driver
 * logged stall-refocus writes into no PTY and then timed out busy→approval on a
 * blank screen. teardown() cleared the timers it knew about, but a callback
 * already in flight called reevaluate(), which re-armed the wake timer — so the
 * dead driver kept running its state machine.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type { PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions } from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4345;
    readonly ready = Promise.resolve();
    private dataCb: ((chunk: string) => void) | null = null;
    write(): void { /* no-op */ }
    resize(): void { /* no-op */ }
    kill(): void { /* no-op */ }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(): void { /* no-op */ }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

const dirs: string[] = [];
function specPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-torn-down-'));
    dirs.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify({
        $schema: 'adhdev:cli/spec@4',
        id: 'test.torn-down',
        name: 'torn down driver test',
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
    }));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

for (const mode of ['shutdown', 'detach'] as const) {
    describe(`FsmDriver after ${mode}()`, () => {
        it('does not evaluate again or re-arm its wake timer', async () => {
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: specPath(), workingDir: os.tmpdir(), hotReload: false,
                transportFactory: factory, sessionId: 'sess-torn-down-0001',
            });
            driver.start();
            factory.last!.feed('\n>\n? for shortcuts');
            await sleep(300);
            factory.last!.feed('\n>\nThinking...');
            await sleep(300);

            driver[mode]();
            const internals = driver as unknown as { evalCount: number; wakeTimer: unknown; reevaluate(force?: boolean): void };
            const evalsAtTeardown = internals.evalCount;

            // A callback that was already in flight when teardown ran.
            internals.reevaluate();
            internals.reevaluate(true);
            await sleep(200);

            expect(internals.evalCount).toBe(evalsAtTeardown);
            expect(internals.wakeTimer).toBeNull();
        });
    });
}
