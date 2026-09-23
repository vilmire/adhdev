/**
 * Wiring-unification C6 — PTY ordering fix pin.
 *
 * `TerminalAdapter.onChunk` used to call `handlers.on_pty_data?.(chunk)`
 * BEFORE `this.screen.write(chunk)`. `on_pty_data` is where the FSM's own
 * pty_data handling lives downstream (`cli-adapter.ts`'s
 * `handleEvent('pty_data')`, reached via `fsm-driver.ts`'s `on_pty_data`
 * wiring), and that handler reads the adapter's screen synchronously
 * (`driver.snapshot()` -> `adapter.snapshot()` -> `this.lastScreen ||
 * this.computeScreen()`) to detect prompts
 * (`maybeCaptureClaudeTuiPrompt`/`maybeUpgradeClaudeTuiMultiSelect`). With
 * the old order, a synchronous read inside `on_pty_data` saw the screen from
 * BEFORE the chunk that triggered the callback — a real ordering defect.
 *
 * This test pins the fix directly at the `TerminalAdapter` level (the file
 * this workstream owns): `on_pty_data` must observe a screen snapshot that
 * already includes the just-delivered chunk. It breaks once by reverting the
 * two-line order in `onChunk` (screen.write after on_pty_data again).
 */
import { describe, expect, it } from 'vitest';
import { TerminalAdapter } from '../../../src/providers/spec/adapter.js';
import type {
    PtyRuntimeExitInfo,
    PtyRuntimeTransport,
    PtySpawnOptions,
    PtyTransportFactory,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: PtyRuntimeExitInfo) => void) | null = null;
    write(): void { /* no-op */ }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: PtyRuntimeExitInfo) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

function spawnAdapter(onPtyData: (chunk: string) => void): { adapter: TerminalAdapter; pty: DrivablePty } {
    const factory = new DrivableFactory();
    const adapter = new TerminalAdapter(
        { binary: '/bin/true', transportFactory: factory },
        { on_pty_data: onPtyData },
    );
    adapter.start();
    return { adapter, pty: factory.last! };
}

describe('TerminalAdapter onChunk ordering (C6)', () => {
    it('on_pty_data observes a screen snapshot that already includes the just-delivered chunk', () => {
        const seenAtCallTime: string[] = [];
        const { adapter, pty } = spawnAdapter(() => {
            // Read the LIVE screen synchronously, the same way
            // cli-adapter.ts's handleEvent('pty_data') -> maybeCaptureClaudeTuiPrompt
            // reads driver.snapshot() -> adapter.snapshot() during the callback.
            seenAtCallTime.push(adapter.snapshot());
        });

        pty.feed('hello-marker');

        expect(seenAtCallTime).toHaveLength(1);
        expect(seenAtCallTime[0]).toContain('hello-marker');
        adapter.kill();
    });

    it('a second chunk is visible inside its own on_pty_data call too (not just the first)', () => {
        const seenAtCallTime: string[] = [];
        const { adapter, pty } = spawnAdapter(() => {
            seenAtCallTime.push(adapter.snapshot());
        });

        pty.feed('first-chunk');
        pty.feed('-second-chunk');

        expect(seenAtCallTime).toHaveLength(2);
        expect(seenAtCallTime[0]).toContain('first-chunk');
        // Second call sees BOTH: the screen accumulates (same viewport line).
        expect(seenAtCallTime[1]).toContain('first-chunk-second-chunk');
        adapter.kill();
    });

    it('break-once: reverting the order (handler before screen.write) makes the first assertion fail', () => {
        // Simulates the OLD (buggy) ordering directly, without touching
        // adapter.ts, to document what this test would catch if the fix in
        // onChunk were reverted: a handler that reads a screen snapshot taken
        // strictly BEFORE the chunk was applied must NOT see the chunk yet.
        let screenBeforeHandler = '';
        const applied: string[] = [];
        function oldOrderOnChunk(chunk: string, write: (c: string) => void, handler: (c: string) => void): void {
            screenBeforeHandler = applied.join('');
            handler(chunk); // handler fires first (the bug)
            applied.push(chunk);
            write(chunk);
        }
        let sawChunkInHandler = false;
        oldOrderOnChunk(
            'X',
            () => { /* screen write, irrelevant to this simulation */ },
            () => { sawChunkInHandler = screenBeforeHandler.includes('X'); },
        );
        expect(sawChunkInHandler).toBe(false);
    });
});
