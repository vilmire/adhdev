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

        // ── SEND-NOW-WRONG-ITEM ───────────────────────────────────────────
        // Owner-reported live (2026-09-11, rc.10): two bodies queued, "Send
        // now" pressed on the SECOND bubble, and the FIRST one was sent.
        //
        // The dashboard addresses the entry by id and the daemon claims it by
        // text, so both ends were already per-item. The wrong body was sent by
        // the DRIVER, not by either of them: interruptAndDeliver's step 0
        // removes only the pressed body, leaving the other one in the FIFO, and
        // the FSM evaluation loop calls drainPendingSends() on the very frame it
        // reaches idle — before the interrupt caller's poll observes the same
        // idle. So the leftover entry wins the race, takes the in-flight latch,
        // and the pressed body is re-parked behind it.
        it('sends the PRESSED body, not the one queued ahead of it', async () => {
            const { adapter, pty } = await makeRunningAdapter();
            try {
                const first = 'queue test one';
                const second = 'queue test two';
                await queueWhileBusy(adapter, first);
                await queueWhileBusy(adapter, second);
                const before = pty.writes.length;

                const settle = (async () => {
                    for (let i = 0; i < 200; i += 1) {
                        if (pty.writes.slice(before).includes(CTRL_C)) {
                            pty.feed('\n>\n? for shortcuts');
                            return true;
                        }
                        await sleep(10);
                    }
                    return false;
                })();

                // Press Send now on the SECOND entry.
                const outcome = await interruptAndDeliver(adapter as never, second);
                expect(await settle).toBe(true);
                expect(outcome.ok).toBe(true);
                if (outcome.ok) expect(outcome.delivered).toBe(true);

                // Let any drain timer fire before reading the tape.
                await sleep(600);

                const written = pty.writes.slice(before);
                const secondAt = written.findIndex(w => w.includes(second));
                const firstAt = written.findIndex(w => w.includes(first));

                // ★ The pressed body must actually have been written.
                expect(secondAt).toBeGreaterThanOrEqual(0);
                // ★ And it must be written FIRST. Before the fix `firstAt` was
                //   the earlier index: the leftover entry drained ahead of it.
                if (firstAt >= 0) expect(secondAt).toBeLessThan(firstAt);

                // The untouched entry stays queued — Send now steers one body,
                // it does not discard the rest of the owner's queue.
                expect(written.filter(w => w.includes(second))).toHaveLength(1);
            } finally {
                adapter.shutdown();
            }
        }, 25_000);

        // The drain hold that fixes the case above must be strictly temporary.
        // Holding the FIFO is how the pressed body wins the idle prompt, but the
        // owner's OTHER messages are not this call's to keep — if the hold
        // outlived the sequence it would trade a wrong-item send for a stranded
        // queue, which is the worse defect (silent, and unbounded in time).
        it('releases the drain hold so the untouched entry still gets delivered', async () => {
            const { adapter, pty } = await makeRunningAdapter();
            try {
                const first = 'left in the queue';
                const second = 'pressed send now';
                await queueWhileBusy(adapter, first);
                await queueWhileBusy(adapter, second);
                const before = pty.writes.length;

                const settle = (async () => {
                    for (let i = 0; i < 200; i += 1) {
                        if (pty.writes.slice(before).includes(CTRL_C)) {
                            pty.feed('\n>\n? for shortcuts');
                            return true;
                        }
                        await sleep(10);
                    }
                    return false;
                })();

                const outcome = await interruptAndDeliver(adapter as never, second);
                expect(await settle).toBe(true);
                expect(outcome.ok).toBe(true);

                // Run the pressed body's turn to completion, which is what frees
                // the prompt for the entry that stayed queued. The FSM only
                // drains on an observed frame, so each state is fed and awaited
                // rather than assumed.
                await sleep(200);
                pty.feed('\n>\nesc to interrupt');
                await sleep(400);
                expect(adapter.getStatus().status).toBe('generating');
                pty.feed('\n>\n? for shortcuts');

                // ★ The leftover entry must eventually reach the PTY.
                const delivered = await (async () => {
                    for (let i = 0; i < 100; i += 1) {
                        if (pty.writes.slice(before).some(w => w.includes(first))) return true;
                        // Keep the idle prompt repainting: a real CLI redraws,
                        // and the drain runs on an FSM frame.
                        pty.feed('\n>\n? for shortcuts');
                        await sleep(20);
                    }
                    return false;
                })();
                expect(delivered).toBe(true);
            } finally {
                adapter.shutdown();
            }
        }, 25_000);

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

    // ── SEND-NOW-SECOND-PRESS-KILL ────────────────────────────────────────
    // Live 2026-09-11 10:25, session 270c7cf7: both Ctrl-C presses landed 215ms
    // apart with NO busy→idle line between them, and claude-cli exited 2.6s
    // later. For claude-cli a Ctrl-C at an ALREADY IDLE prompt is not a no-op —
    // it quits the program. The press had been gated only on elapsed time
    // against adapter.getStatus(), which returns the cached FsmDriver
    // `latestState`; that cache trails the terminal by an 80ms screen-change
    // debounce plus a 120ms poll, so at a 200ms delay it can still read
    // `generating` for a prompt that is already idle.
    //
    // These drive waitForIdleAfterInterrupt against a scripted status source
    // rather than the real adapter, because the whole point is a status that is
    // STALE relative to the terminal — a state a real FsmDriver reaches only by
    // a timing race, which is exactly what must not be left to chance in a test.
    describe('second-press safety when the observed status is stale', () => {
        /** Adapter double whose reported status is read from a script, so the
         *  lag between "terminal is idle" and "FSM says idle" is explicit. */
        function scriptedAdapter(statusAt: (elapsedMs: number) => string | undefined) {
            const startedAt = Date.now();
            const presses: number[] = [];
            return {
                presses,
                adapter: {
                    cliType: 'claude-cli',
                    getStatus: () => ({ status: statusAt(Date.now() - startedAt) }),
                    sendMessage: async () => ({ status: 'delivered' as const }),
                    interruptTurn: async () => {
                        presses.push(Date.now() - startedAt);
                        return { ok: true as const, keyName: 'Ctrl-C', bytes: 1, confidence: 'proven' as const };
                    },
                },
            };
        }

        it('does NOT fire the second press when the session went idle but the status is still stale', async () => {
            // The terminal returned to an idle prompt at 40ms. The FSM does not
            // report it until 400ms — the observation lag measured above. A
            // clock-only gate fires at 200ms, straight into the idle prompt.
            const { adapter, presses } = scriptedAdapter(
                elapsed => (elapsed < 400 ? 'generating' : 'idle'),
            );
            let secondPresses = 0;

            const wentIdle = await waitForIdleAfterInterrupt(adapter as never, 3_000, 30, {
                secondPress: () => { secondPresses += 1; },
                secondPressAfterMs: 200,
                // Dwell longer than the stale window, so "still busy" can only be
                // satisfied by observations that outlast the lag.
                minBusyDwellMs: 600,
            });

            expect(wentIdle).toBe(true);
            // ★ The assertion this fix exists for: no stray Ctrl-C at an idle
            //   prompt. Reverting the dwell gate makes this 1.
            expect(secondPresses).toBe(0);
            expect(presses).toHaveLength(0);
        }, 15_000);

        it('STILL fires the second press when the session is genuinely, durably busy', async () => {
            // Feature preservation: the whole reason the second press exists is
            // a claude-cli turn that does not abort on one Ctrl-C (9.0s measured).
            // A session that stays busy well past the dwell must still get it.
            const { adapter, presses } = scriptedAdapter(() => 'generating');
            let secondPresses = 0;

            const wentIdle = await waitForIdleAfterInterrupt(adapter as never, 1_200, 30, {
                secondPress: () => { secondPresses += 1; },
                secondPressAfterMs: 200,
                minBusyDwellMs: 260,
            });

            expect(wentIdle).toBe(false); // never left generating
            expect(secondPresses).toBe(1);
        }, 15_000);

        it('fires the second press no earlier than the dwell allows', async () => {
            const { adapter } = scriptedAdapter(() => 'generating');
            const startedAt = Date.now();
            let pressedAt = -1;

            await waitForIdleAfterInterrupt(adapter as never, 1_500, 30, {
                secondPress: () => { pressedAt = Date.now() - startedAt; },
                // Clock gate is early; the dwell is what actually holds it back.
                secondPressAfterMs: 50,
                minBusyDwellMs: 500,
            });

            expect(pressedAt).toBeGreaterThanOrEqual(500);
        }, 15_000);

        it('treats an unreadable status as NOT busy, so it cannot license a press', async () => {
            // An adapter that throws (or has no state yet) yields undefined.
            // Unknown must never be evidence of generating: fail-closed costs a
            // slower abort, fail-open costs the session.
            const { adapter } = scriptedAdapter(() => undefined);
            let secondPresses = 0;

            await waitForIdleAfterInterrupt(adapter as never, 700, 30, {
                secondPress: () => { secondPresses += 1; },
                secondPressAfterMs: 100,
                minBusyDwellMs: 200,
            });

            expect(secondPresses).toBe(0);
        }, 15_000);

        // The self-contradiction in the same live trace: `generating → stopped`
        // at 10:25:48.060, then `interrupt(...) → idle → requeued` at
        // 10:25:48.389. `stopped` is not a BUSY status, so the old "not busy ⇒
        // idle" test reported a DEAD session as a successful interrupt, sent
        // into a dead adapter, and the body was parked in a FIFO the shutdown
        // sweep discarded 5s later — a silent loss behind a success report.
        it('reports session_exited — not idle — when the session dies after the stop key', async () => {
            const startedAt = Date.now();
            let sent = 0;
            const adapter = {
                cliType: 'claude-cli',
                // Dies 150ms in, exactly like the live trace.
                getStatus: () => ({ status: Date.now() - startedAt < 150 ? 'generating' : 'stopped' }),
                sendMessage: async () => { sent += 1; return { status: 'queued' as const }; },
                interruptTurn: async () => ({
                    ok: true as const, keyName: 'Ctrl-C', bytes: 1, confidence: 'proven' as const,
                }),
            };

            const outcome = await interruptAndDeliver(adapter as never, 'body', {
                timeoutMs: 2_000,
                pollMs: 30,
            });

            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.reason).toBe('session_exited');
            // ★ Nothing may be handed to a dead adapter.
            expect(sent).toBe(0);
        }, 15_000);

        it('does not fire when busy is only observed intermittently', async () => {
            // A flapping observation never accumulates an uninterrupted busy run,
            // so it cannot satisfy the dwell. Each undefined sample resets it.
            let sample = 0;
            const { adapter } = scriptedAdapter(() => {
                sample += 1;
                return sample % 2 === 0 ? 'generating' : undefined;
            });
            let secondPresses = 0;

            await waitForIdleAfterInterrupt(adapter as never, 900, 30, {
                secondPress: () => { secondPresses += 1; },
                secondPressAfterMs: 100,
                minBusyDwellMs: 300,
            });

            expect(secondPresses).toBe(0);
        }, 15_000);
    });

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
