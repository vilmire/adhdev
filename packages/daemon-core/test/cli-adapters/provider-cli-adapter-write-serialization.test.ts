/**
 * Regression coverage for PTY-WRITE-SERIALIZE (consecutive-message concatenation).
 *
 * Root cause: two messages force-injected into the same CLI PTY session back-to-back
 * were not serialized at the write layer. Message A's body could still be sitting on
 * the input line (its Enter/CR not yet processed) when message B's body was written to
 * the SAME line, so the TUI rendered/submitted "A B" as a single undivided user turn.
 *
 * The fix chains every writeToPty() onto a single per-session tail promise
 * (this.ptyWriteChain), so message A's (body + sendKey) is fully written to the PTY
 * before message B's body write begins — no interleave. This exercises both the force
 * path (forceSendMessage) and the low-level writeToPty primitive that the retry-timer
 * writes also flow through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function buildAdapter() {
    const adapter = new ProviderCliAdapter({
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        binary: 'claude',
        spawn: { command: 'claude', args: [], shell: true, env: {} },
        scripts: { detectStatus: () => 'idle', parseApproval: () => null },
    } as any, '/tmp/project') as any;
    adapter.waitForInteractivePrompt = vi.fn().mockResolvedValue(undefined);
    adapter.terminalScreen = { getText: () => '❯\n' };
    adapter.recentOutputBuffer = '❯\n';
    adapter.runDetectStatus = vi.fn(() => 'idle');
    adapter.startupParseGate = false;
    adapter.submitStrategy = 'immediate';
    adapter.ready = true;
    return adapter;
}

/**
 * A mock PTY whose write() does NOT resolve synchronously — it records the exact
 * order of `begin` / `end` events and only settles on the next microtask/macrotask.
 * If two writes were allowed to overlap, we would observe two consecutive `begin`
 * events with no intervening `end` (interleave). Serialization guarantees strict
 * begin→end→begin→end pairing.
 */
function makeAsyncRecordingPty() {
    const events: string[] = [];
    const chunks: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const write = vi.fn((d: string) => {
        events.push(`begin:${d}`);
        chunks.push(d);
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        return new Promise<void>((resolve) => {
            // Defer resolution so a non-serialized caller would have a window to
            // start a second overlapping write before this one "completes".
            setTimeout(() => {
                inFlight -= 1;
                events.push(`end:${d}`);
                resolve();
            }, 5);
        });
    });
    return { pty: { write }, events, chunks, get maxConcurrent() { return maxConcurrent; } };
}

describe('ProviderCliAdapter PTY write serialization (PTY-WRITE-SERIALIZE)', () => {
    beforeEach(() => { setPlatform('darwin'); });
    afterEach(() => { setPlatform(ORIGINAL_PLATFORM); vi.useRealTimers(); });

    it('serializes overlapping writeToPty calls — never more than one write in flight (FIFO)', async () => {
        const adapter = buildAdapter();
        const rec = makeAsyncRecordingPty();
        adapter.ptyProcess = rec.pty;

        // Fire two writes without awaiting the first — the exact shape of the bug
        // (message A still writing when message B is requested).
        const a = adapter.writeToPty('AAA\r');
        const b = adapter.writeToPty('BBB\r');
        await Promise.all([a, b]);

        // Strict pairing: A begins and ends before B begins. No interleave.
        expect(rec.events).toEqual(['begin:AAA\r', 'end:AAA\r', 'begin:BBB\r', 'end:BBB\r']);
        expect(rec.maxConcurrent).toBe(1);
    });

    it('force-send A fully writes (body + CR) before force-send B body — no concatenation', async () => {
        const adapter = buildAdapter();
        const rec = makeAsyncRecordingPty();
        adapter.ptyProcess = rec.pty;
        adapter.currentStatus = 'idle';
        adapter.onStatusChange = vi.fn();

        const msgA = 'message A body';
        const msgB = 'message B body';

        // Two consecutive force dispatches (the mesh reconcile burst shape).
        const pA = adapter.forceSendMessage(msgA);
        const pB = adapter.forceSendMessage(msgB);
        await Promise.all([pA, pB]);

        // Each force-send is one atomic content+sendKey write; the chain guarantees
        // A's write fully lands before B's begins.
        expect(rec.chunks).toEqual([msgA + '\r', msgB + '\r']);
        // And they were strictly non-overlapping at the PTY layer.
        expect(rec.events).toEqual([
            `begin:${msgA}\r`, `end:${msgA}\r`,
            `begin:${msgB}\r`, `end:${msgB}\r`,
        ]);
    });

    it('a rejected write does not wedge the chain — the next write still proceeds', async () => {
        const adapter = buildAdapter();
        const events: string[] = [];
        let call = 0;
        adapter.ptyProcess = {
            write: vi.fn((d: string) => {
                call += 1;
                if (call === 1) return Promise.reject(new Error('boom'));
                events.push(d);
                return Promise.resolve();
            }),
        };

        const failing = adapter.writeToPty('first\r');
        const following = adapter.writeToPty('second\r');

        // The failing write surfaces its rejection to ITS caller...
        await expect(failing).rejects.toThrow('boom');
        // ...but the chain is not permanently rejected — the next write runs.
        await expect(following).resolves.toBeUndefined();
        expect(events).toEqual(['second\r']);
    });
});
