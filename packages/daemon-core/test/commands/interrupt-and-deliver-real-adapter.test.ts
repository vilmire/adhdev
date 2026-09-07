/**
 * SEND-NOW end-to-end regression, against a REAL SpecCliAdapter driving a REAL
 * FsmDriver over a fake PTY — deliberately not a stubbed adapter.
 *
 * A stub can be made to satisfy any ordering the implementation happens to
 * produce, which is exactly how the retired `forceSendMessage` path passed its
 * tests for months while never existing in src. What must be proven here is a
 * property of the live wiring:
 *
 *   1. While the session is GENERATING, the body is never written to the PTY.
 *   2. `interruptAndDeliver` writes the provider's stop key FIRST.
 *   3. The body is written only AFTER the FSM has observed busy→idle.
 *
 * The fake PTY records every byte in order, so the assertions are made against
 * the actual write sequence rather than against mock call counts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpecCliAdapter } from '../../src/providers/spec/cli-adapter.js';
import { CTRL_C } from '../../src/providers/spec/interrupt-capability.js';
import { interruptAndDeliver, waitForIdleAfterInterrupt } from '../../src/commands/interrupt-and-deliver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4243;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void {
        this.writes.push(data);
        // A real terminal echoes written input back into the rendered screen;
        // the submit path withholds the submit key until that echo is observed.
        this.dataCb?.(data);
    }
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
 * Minimal claude-shaped spec with a real `stop` control, so interrupt
 * capability is resolved from the spec exactly as it is in production
 * (resolveInterruptCapability reads control_bar, never a hardcoded table).
 *
 * idle ⇄ generating is driven by a footer marker the test feeds, standing in
 * for the "esc to interrupt" spinner a real CLI draws while working.
 */
function interruptibleSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'claude-cli',
        name: 'interrupt test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        control_bar: [
            { id: 'stop', label: 'Stop', visible_when_state: ['generating'], action: { type: 'send_keys', keys: CTRL_C } },
        ],
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Working', status: 'generating' },
        ],
        transitions: [
            { label: 'starting→idle', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
            { label: 'idle→generating', from: 'idle', to: 'generating', when: { section: 'footer', matches: 'esc to interrupt' } },
            { label: 'generating→idle', from: 'generating', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
        ],
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-now-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function makeRunningAdapter() {
    const factory = new DrivableFactory();
    const adapter = new SpecCliAdapter(
        writeSpec(interruptibleSpec()),
        os.tmpdir(),
        [],
        {},
        factory,
    );
    await adapter.spawn();
    const pty = factory.last!;
    // Reach readiness, then go busy — the state a Send now press acts on.
    pty.feed('\n>\n? for shortcuts');
    await sleep(300);
    pty.feed('\n>\nesc to interrupt');
    await sleep(300);
    return { adapter, pty };
}

describe('SEND-NOW: interruptAndDeliver against a real SpecCliAdapter', () => {
    it('writes the stop key BEFORE the body, and the body only after busy→idle', async () => {
        const { adapter, pty } = await makeRunningAdapter();
        try {
            expect(adapter.getStatus().status).toBe('generating');

            // The FSM only leaves `generating` when the CLI redraws its idle
            // footer. A real CLI does that in response to the stop key; the fake
            // PTY cannot, so the test plays the CLI's part — but only AFTER
            // observing the stop key, which is precisely the ordering under test.
            const before = pty.writes.length;
            const settle = (async () => {
                for (let i = 0; i < 100; i += 1) {
                    if (pty.writes.slice(before).includes(CTRL_C)) {
                        pty.feed('\n>\n? for shortcuts');
                        return true;
                    }
                    await sleep(20);
                }
                return false;
            })();

            const outcome = await interruptAndDeliver(adapter as never, 'send this now');
            expect(await settle).toBe(true);
            expect(outcome.ok).toBe(true);

            await sleep(800);
            const writes = pty.writes;
            const stopAt = writes.indexOf(CTRL_C);
            const bodyAt = writes.findIndex(w => w.includes('send this now'));

            // ★ The three properties this feature exists to guarantee.
            expect(stopAt).toBeGreaterThanOrEqual(0);
            expect(bodyAt).toBeGreaterThanOrEqual(0);
            expect(stopAt).toBeLessThan(bodyAt);
            // Nothing resembling the body may appear among the writes that
            // preceded the stop key — that would be the retired force-inject.
            expect(writes.slice(0, stopAt).join('')).not.toContain('send this now');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('refuses and writes NOTHING when the provider declares an empty stop key', async () => {
        const spec = interruptibleSpec();
        (spec as { control_bar: { action: { keys: string } }[] }).control_bar[0].action.keys = '';
        const factory = new DrivableFactory();
        const adapter = new SpecCliAdapter(writeSpec(spec), os.tmpdir(), [], {}, factory);
        await adapter.spawn();
        const pty = factory.last!;
        try {
            pty.feed('\n>\n? for shortcuts');
            await sleep(300);
            pty.feed('\n>\nesc to interrupt');
            await sleep(300);

            const before = pty.writes.length;
            const outcome = await interruptAndDeliver(adapter as never, 'must not be written');

            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.reason).toBe('stop_keys_empty');
            // The whole point: an unsupported interrupt must not fall back to
            // writing the body into a generating PTY.
            expect(pty.writes.slice(before).join('')).not.toContain('must not be written');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('reports idle_timeout without writing the body when the session never leaves generating', async () => {
        const { adapter, pty } = await makeRunningAdapter();
        try {
            const before = pty.writes.length;
            // No idle frame is ever fed, so the FSM stays in `generating`.
            const outcome = await interruptAndDeliver(adapter as never, 'never delivered', {
                timeoutMs: 300,
                pollMs: 30,
            });

            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.reason).toBe('idle_timeout');
            const after = pty.writes.slice(before);
            // The stop key WAS written; the body was not.
            expect(after).toContain(CTRL_C);
            expect(after.join('')).not.toContain('never delivered');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    // ── SEND-NOW-DOUBLE-SEND ──────────────────────────────────────────────
    // "Send now" is pressed on a bubble that is ALREADY queued in the driver
    // FIFO, so the driver would drain that copy on the next idle frame. These
    // two tests pin the invariant that fixes the live 2026-09-07 defect:
    // whatever interruptAndDeliver reports is the whole truth about that body.
    describe('with the same body already queued in the driver FIFO', () => {
        /** Queue `text` the way an ordinary send does while the session is busy,
         *  and assert it really was parked rather than written. */
        async function queueWhileBusy(adapter: SpecCliAdapter, text: string) {
            const disposition = await adapter.sendMessage(text);
            expect(disposition).toEqual({ status: 'queued' });
        }

        it('does not double-send: on idle_timeout the queued copy is NOT drained later', async () => {
            const { adapter, pty } = await makeRunningAdapter();
            try {
                const body = 'steer the agent here';
                await queueWhileBusy(adapter, body);
                const before = pty.writes.length;

                // Never leaves `generating` within the window, so the interrupt
                // observation times out — the exact live shape.
                const outcome = await interruptAndDeliver(adapter as never, body, {
                    timeoutMs: 300,
                    pollMs: 30,
                });
                expect(outcome.ok).toBe(false);
                if (!outcome.ok) expect(outcome.reason).toBe('idle_timeout');
                // ★ The report must be truthful: nothing sent, retry is safe.
                if (!outcome.ok) expect(outcome.message).not.toContain('still queued');

                // Now let the CLI settle. Before the fix this is where
                // `draining queued send` wrote the body the caller was just told
                // had NOT been delivered.
                pty.feed('\n>\n? for shortcuts');
                await sleep(800);

                const written = pty.writes.slice(before).join('');
                expect(written).toContain(CTRL_C);
                expect(written).not.toContain(body);
            } finally {
                adapter.shutdown();
            }
        }, 20_000);

        it('delivers EXACTLY ONCE when idle is observed, despite the queued copy', async () => {
            const { adapter, pty } = await makeRunningAdapter();
            try {
                const body = 'deliver me exactly once';
                await queueWhileBusy(adapter, body);
                const before = pty.writes.length;

                const settle = (async () => {
                    for (let i = 0; i < 100; i += 1) {
                        if (pty.writes.slice(before).includes(CTRL_C)) {
                            pty.feed('\n>\n? for shortcuts');
                            return true;
                        }
                        await sleep(20);
                    }
                    return false;
                })();

                const outcome = await interruptAndDeliver(adapter as never, body);
                expect(await settle).toBe(true);
                expect(outcome.ok).toBe(true);
                if (outcome.ok) expect(outcome.delivered).toBe(true);

                // Give the drain timer every chance to write a second copy.
                await sleep(1_200);

                // Count PTY writes that carry the body. The driver writes a body
                // in one burst (plus the echo the fake PTY replays into the
                // screen, which is not a write), so >1 means two submissions.
                const bodyWrites = pty.writes.slice(before).filter(w => w.includes(body));
                expect(bodyWrites).toHaveLength(1);
            } finally {
                adapter.shutdown();
            }
        }, 20_000);
    });

    it('presses the stop key a SECOND time when a proven provider stays busy', async () => {
        // Defect A: claude-cli was measured taking 9.0s to redraw an idle prompt
        // because one Ctrl-C means "finish the running tool, then stop". The
        // extra press is the shortcut; the FSM's own busy→idle is still the only
        // thing we treat as proof.
        const { adapter, pty } = await makeRunningAdapter();
        try {
            const before = pty.writes.length;
            await interruptAndDeliver(adapter as never, 'body', {
                timeoutMs: 600,
                pollMs: 30,
                secondPressAfterMs: 100,
            });
            const stops = pty.writes.slice(before).filter(w => w === CTRL_C);
            expect(stops.length).toBe(2);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('does NOT press a second time once the session reports idle', async () => {
        // A CLI that stopped on the first press must never see a stray control
        // byte at its idle prompt.
        const { adapter, pty } = await makeRunningAdapter();
        try {
            const before = pty.writes.length;
            const settle = (async () => {
                for (let i = 0; i < 100; i += 1) {
                    if (pty.writes.slice(before).includes(CTRL_C)) {
                        pty.feed('\n>\n? for shortcuts');
                        return;
                    }
                    await sleep(5);
                }
            })();
            await interruptAndDeliver(adapter as never, 'body', { pollMs: 20, secondPressAfterMs: 400 });
            await settle;
            await sleep(600);
            expect(pty.writes.slice(before).filter(w => w === CTRL_C).length).toBe(1);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('waitForIdleAfterInterrupt resolves once the real adapter reports idle', async () => {
        const { adapter, pty } = await makeRunningAdapter();
        try {
            const waiting = waitForIdleAfterInterrupt(adapter as never, 3_000, 30);
            await sleep(60);
            pty.feed('\n>\n? for shortcuts');
            expect(await waiting).toBe(true);
            expect(adapter.getStatus().status).toBe('idle');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);
});
