/**
 * Wiring-unification A5-3 — the adapter clocks are live.
 *
 * `SpecCliAdapter` is the only `CliAdapter` implementation, and until this
 * change its status projection never set `lastOutputAt` / `lastScreenChangeAt`
 * even though the driver tracked both internally. Every consumer of those
 * fields — the mesh stall watchdog (falls back to `startedAt`), the completion
 * engine's new-output checks, the status-transition progress fingerprint and
 * the ghost-approval guard — was therefore reading a constant `undefined`.
 *
 * Three layers are pinned here:
 *   1. the REAL chain (TerminalAdapter → FsmDriver → SpecCliAdapter) advances
 *      `lastOutputAt` on a raw PTY chunk and `lastScreenChangeAt` only when the
 *      rendered screen actually changes;
 *   2. the pure projection carries the clocks on every status branch, and omits
 *      them until they have ticked;
 *   3. the cheap read path the watchdog uses — `getStatus({ allowParse: false })`
 *      — reads latched counters only: it neither re-evaluates the screen nor
 *      writes to the PTY, so polling cannot move the clocks it reports.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
    PtyRuntimeExitInfo,
    PtyRuntimeTransport,
    PtySpawnOptions,
    PtyTransportFactory,
} from '../../../src/cli-adapters/pty-transport.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { projectAdapterStatus, type AdapterStatusInputs } from '../../../src/providers/spec/adapter-status-projection.js';
import { minimalSpecPath } from '../../helpers/minimal-spec.js';

// A fake PTY whose onData callback the test drives to simulate CLI output.
class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: PtyRuntimeExitInfo) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 } as PtyRuntimeExitInfo); }
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** TerminalAdapter coalesces screen snapshots (80ms debounce); wait past it. */
const SCREEN_SETTLE_MS = 200;

const adaptersToShutdown: SpecCliAdapter[] = [];
afterEach(() => {
    while (adaptersToShutdown.length > 0) {
        try { adaptersToShutdown.pop()!.shutdown(); } catch { /* ignore */ }
    }
});

function spawnRealAdapter(): { adapter: SpecCliAdapter; pty: DrivablePty } {
    const factory = new DrivableFactory();
    const adapter = new SpecCliAdapter(minimalSpecPath(), '/tmp/project', [], {}, factory, 'sess_clocks');
    adaptersToShutdown.push(adapter);
    void adapter.spawn();
    return { adapter, pty: factory.last! };
}

describe('SpecCliAdapter status clocks — real TerminalAdapter → FsmDriver → adapter chain', () => {
    it('omits both clocks before any PTY output', () => {
        const { adapter } = spawnRealAdapter();
        const status = adapter.getStatus({ allowParse: false });
        expect(status.lastOutputAt).toBeUndefined();
        expect(status.lastScreenChangeAt).toBeUndefined();
    });

    it('advances lastOutputAt on every raw PTY chunk, synchronously', async () => {
        const { adapter, pty } = spawnRealAdapter();
        const t0 = Date.now();
        pty.feed('hello');
        const first = adapter.getStatus({ allowParse: false }).lastOutputAt;
        expect(typeof first).toBe('number');
        expect(first!).toBeGreaterThanOrEqual(t0);

        await sleep(15);
        pty.feed(' world');
        const second = adapter.getStatus({ allowParse: false }).lastOutputAt;
        expect(second!).toBeGreaterThan(first!);
    });

    it('advances lastScreenChangeAt only when the rendered screen actually changes', async () => {
        const { adapter, pty } = spawnRealAdapter();
        const t0 = Date.now();
        pty.feed('hello');
        await sleep(SCREEN_SETTLE_MS);
        const afterFirstPaint = adapter.getStatus({ allowParse: false });
        expect(typeof afterFirstPaint.lastScreenChangeAt).toBe('number');
        expect(afterFirstPaint.lastScreenChangeAt!).toBeGreaterThanOrEqual(t0);

        // A bare carriage return moves the cursor but leaves the rendered text
        // untouched: raw-output clock ticks, screen-change clock must not.
        await sleep(15);
        pty.feed('\r');
        await sleep(SCREEN_SETTLE_MS);
        const afterNeutralChunk = adapter.getStatus({ allowParse: false });
        expect(afterNeutralChunk.lastOutputAt!).toBeGreaterThan(afterFirstPaint.lastOutputAt!);
        expect(afterNeutralChunk.lastScreenChangeAt).toBe(afterFirstPaint.lastScreenChangeAt);

        // Real new content: both clocks advance.
        await sleep(15);
        pty.feed('\nsecond line');
        await sleep(SCREEN_SETTLE_MS);
        const afterSecondPaint = adapter.getStatus({ allowParse: false });
        expect(afterSecondPaint.lastScreenChangeAt!).toBeGreaterThan(afterFirstPaint.lastScreenChangeAt!);
        expect(afterSecondPaint.lastOutputAt!).toBeGreaterThan(afterNeutralChunk.lastOutputAt!);
    });

    it('getStatus({ allowParse: false }) is a pure read: no PTY write, clocks unchanged across repeated polls', async () => {
        const { adapter, pty } = spawnRealAdapter();
        pty.feed('prompt >');
        await sleep(SCREEN_SETTLE_MS);
        const writesBefore = pty.writes.length;
        const a = adapter.getStatus({ allowParse: false });
        await sleep(15);
        const b = adapter.getStatus({ allowParse: false });
        const c = adapter.getStatus({ allowParse: false });
        expect(pty.writes.length).toBe(writesBefore);
        expect(b.lastOutputAt).toBe(a.lastOutputAt);
        expect(c.lastOutputAt).toBe(a.lastOutputAt);
        expect(b.lastScreenChangeAt).toBe(a.lastScreenChangeAt);
        expect(c.lastScreenChangeAt).toBe(a.lastScreenChangeAt);
    });

    it('keeps the clocks on the stopped branch (termination bridge reads silentForMs off them)', async () => {
        const { adapter, pty } = spawnRealAdapter();
        pty.feed('last words');
        await sleep(SCREEN_SETTLE_MS);
        const live = adapter.getStatus({ allowParse: false });
        pty.kill();
        await sleep(20);
        const stopped = adapter.getStatus({ allowParse: false });
        expect(stopped.status).toBe('stopped');
        expect(stopped.lastOutputAt).toBe(live.lastOutputAt);
        expect(stopped.lastScreenChangeAt).toBe(live.lastScreenChangeAt);
    });
});

describe('projectAdapterStatus — clock carriage', () => {
    const baseInputs = (over: Partial<AdapterStatusInputs>): AdapterStatusInputs => ({
        providerSessionId: undefined,
        providerFailure: null,
        exited: false,
        spawned: true,
        activeInteractivePrompt: null,
        state: { id: 'idle', label: 'Idle', title: null, status: 'idle' },
        modal: null,
        readySeen: () => true,
        lastOutputAt: 1_700_000_000_100,
        lastScreenChangeAt: 1_700_000_000_050,
        ...over,
    });

    it.each([
        ['error', { providerFailure: { message: 'auth expired' } }],
        ['stopped', { exited: true }],
        ['starting (not spawned)', { spawned: false }],
        ['starting (no state)', { state: null }],
        ['starting (ready not seen)', { readySeen: () => false }],
        ['waiting_approval', { state: { id: 'approve', label: 'Approve?', title: null, status: 'approval' as const } }],
        ['generating', { state: { id: 'busy', label: 'Busy', title: null, status: 'generating' as const } }],
        ['idle', {}],
    ])('carries both clocks on the %s branch', (_label, over) => {
        const status = projectAdapterStatus(baseInputs(over as Partial<AdapterStatusInputs>));
        expect(status.lastOutputAt).toBe(1_700_000_000_100);
        expect(status.lastScreenChangeAt).toBe(1_700_000_000_050);
    });

    it('omits a clock that has not ticked (0) or that the driver does not expose (undefined)', () => {
        const zeroed = projectAdapterStatus(baseInputs({ lastOutputAt: 0, lastScreenChangeAt: 0 }));
        expect('lastOutputAt' in zeroed).toBe(false);
        expect('lastScreenChangeAt' in zeroed).toBe(false);
        const absent = projectAdapterStatus(baseInputs({ lastOutputAt: undefined, lastScreenChangeAt: undefined }));
        expect('lastOutputAt' in absent).toBe(false);
        expect('lastScreenChangeAt' in absent).toBe(false);
    });
});

describe('SpecCliAdapter.getStatus({ allowParse: false }) — cheap read path touches latched driver counters only', () => {
    /** An adapter over a call-recording driver stub, built the way the other
     *  projection tests do (Object.create + latched fields) so no PTY exists. */
    function makeRecordingAdapter(clocks: { out: number; scr: number }) {
        const calls: string[] = [];
        const driver = new Proxy({} as Record<string, unknown>, {
            get(_target, prop) {
                const name = String(prop);
                if (name === 'then') return undefined;
                return (..._args: unknown[]) => {
                    calls.push(name);
                    if (name === 'hasSeenReady') return true;
                    if (name === 'getLastOutputAt') return clocks.out;
                    if (name === 'getLastScreenChangeAt') return clocks.scr;
                    return undefined;
                };
            },
        });
        const adapter = Object.create(SpecCliAdapter.prototype);
        Object.assign(adapter, {
            cliType: 'test-minimal',
            cliName: 'Test Minimal',
            spawned: true,
            exited: false,
            providerFailure: null,
            activeInteractivePrompt: null,
            latestState: { id: 'idle', label: 'Idle', title: null, status: 'idle' },
            latestModal: null,
            spec: { id: 'test-minimal', name: 'Test Minimal' },
            runtimeSettings: {},
            driver,
            providerSessionId: undefined,
        });
        return { adapter: adapter as SpecCliAdapter, calls, clocks };
    }

    it('reads the two clock getters and readiness, and nothing that could re-evaluate or write', () => {
        const { adapter, calls } = makeRecordingAdapter({ out: 5000, scr: 4000 });
        const status = adapter.getStatus({ allowParse: false });
        expect(status.lastOutputAt).toBe(5000);
        expect(status.lastScreenChangeAt).toBe(4000);
        const distinct = [...new Set(calls)].sort();
        expect(distinct).toEqual(['getLastOutputAt', 'getLastScreenChangeAt', 'hasSeenReady']);
    });

    it('reports whatever the driver has latched at read time — the poll itself never moves a clock', () => {
        const { adapter, clocks } = makeRecordingAdapter({ out: 10, scr: 10 });
        expect(adapter.getStatus({ allowParse: false }).lastOutputAt).toBe(10);
        expect(adapter.getStatus({ allowParse: false }).lastOutputAt).toBe(10);
        clocks.out = 20;
        expect(adapter.getStatus({ allowParse: false }).lastOutputAt).toBe(20);
        expect(adapter.getStatus({ allowParse: false }).lastScreenChangeAt).toBe(10);
    });

    it('tolerates a driver without the clock surface (test doubles / legacy) by omitting the fields', () => {
        const adapter = Object.create(SpecCliAdapter.prototype);
        Object.assign(adapter, {
            cliType: 'test-minimal', cliName: 'Test Minimal',
            spawned: true, exited: false, providerFailure: null, activeInteractivePrompt: null,
            latestState: { id: 'idle', label: 'Idle', title: null, status: 'idle' },
            latestModal: null, spec: { id: 'test-minimal', name: 'Test Minimal' }, runtimeSettings: {},
            driver: { hasSeenReady: () => true },
            providerSessionId: undefined,
        });
        const status = (adapter as SpecCliAdapter).getStatus({ allowParse: false });
        expect(status.status).toBe('idle');
        expect('lastOutputAt' in status).toBe(false);
        expect('lastScreenChangeAt' in status).toBe(false);
    });
});
