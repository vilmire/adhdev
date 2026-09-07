/**
 * Regression coverage for CliSpecV4.send_on_spawn -- the spawn-time input prime
 * that wakes a focus-gated TUI (e.g. antigravity's `agy`) so its first
 * programmatic message lands without a manual keystroke.
 *
 * The engine stays CLI-agnostic: it writes the declared sequences once after
 * spawn and writes nothing extra when the field is absent.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { LOG } from '../../../src/logging/logger.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

// A fake PTY that records every write so the test can assert on the priming
// bytes the engine sends after spawn.
class RecordingPty implements PtyRuntimeTransport {
    readonly pid = 7373;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    private dataCb: ((data: string) => void) | null = null;
    constructor(private readonly writeOutcome: 'success' | 'false' | 'throw' | 'reject' = 'success') {}
    write(data: string): boolean | void | Promise<void> {
        this.writes.push(data);
        if (this.writeOutcome === 'false') return false;
        if (this.writeOutcome === 'throw') throw new Error('simulated PTY write failure');
        if (this.writeOutcome === 'reject') return Promise.reject(new Error('simulated async PTY write failure'));
    }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (data: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    emitOutput(data: string): void { this.dataCb?.(data); }
}

class RecordingFactory implements PtyTransportFactory {
    last: RecordingPty | null = null;
    constructor(private readonly writeOutcome: 'success' | 'false' | 'throw' | 'reject' = 'success') {}
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new RecordingPty(this.writeOutcome);
        return this.last;
    }
}

function baseSpec(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.spawn-prime',
        name: 'spawn prime test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
        ...overrides,
    };
}

const __tmpDirsToClean: string[] = [];

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-prime-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const FOCUS_IN = '\x1b[I';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (__tmpDirsToClean.length > 0) {
        const dir = __tmpDirsToClean.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('FsmDriver -- send_on_spawn input prime', () => {
    it('waits for first PTY output, then writes the declared prime after its delay', async () => {
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                send_on_spawn: [FOCUS_IN],
                send_on_spawn_delay_ms: 20,
            })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // The spawn delay alone is not enough: a slow macOS child can still
            // be in canonical echo mode, where focus-in is printed as ^[[I and
            // lost before the TUI installs its input handler.
            expect(pty.writes).toEqual([]);
            await sleep(40);
            expect(pty.writes).toEqual([]);
            pty.emitOutput('\r ⣷ ');
            await sleep(10);
            expect(pty.writes).toEqual([]);
            await sleep(30);
            // Exactly the focus-in event, exactly once.
            expect(pty.writes).toEqual([FOCUS_IN]);
        } finally {
            driver.shutdown();
        }
    });

    it('falls back to sending the prime when the child never emits PTY output', async () => {
        vi.useFakeTimers();
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                send_on_spawn: [FOCUS_IN],
                send_on_spawn_delay_ms: 20,
                send_on_spawn_max_wait_ms: 60,
            })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            await vi.advanceTimersByTimeAsync(59);
            expect(pty.writes).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(pty.writes).toEqual([FOCUS_IN]);
        } finally {
            driver.shutdown();
        }
    });

    it('cancels the timeout fallback when output arrives just before it, so the prime fires once', async () => {
        vi.useFakeTimers();
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                send_on_spawn: [FOCUS_IN],
                send_on_spawn_delay_ms: 20,
                send_on_spawn_max_wait_ms: 60,
            })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            await vi.advanceTimersByTimeAsync(59);
            pty.emitOutput('\r ⣷ ');
            await vi.advanceTimersByTimeAsync(1);
            expect(pty.writes).toEqual([]);
            await vi.advanceTimersByTimeAsync(19);
            expect(pty.writes).toEqual([FOCUS_IN]);
            await vi.advanceTimersByTimeAsync(100);
            expect(pty.writes).toEqual([FOCUS_IN]);
        } finally {
            driver.shutdown();
        }
    });

    it('keeps the first spawn prime at info while successful PTY write boundaries are debug-only', async () => {
        const info = vi.spyOn(LOG, 'info').mockImplementation(() => undefined);
        const debug = vi.spyOn(LOG, 'debug').mockImplementation(() => undefined);
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                send_on_spawn: [FOCUS_IN],
                send_on_spawn_delay_ms: 20,
            })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        factory.last!.emitOutput('\r ⣷ ');
        try {
            await sleep(80);
            expect(info).toHaveBeenCalledWith(
                'FsmDriver',
                expect.stringMatching(/spawn prime firing trigger=first-output sequences=1/),
            );
            expect(debug).toHaveBeenCalledWith(
                'FsmDriver',
                expect.stringMatching(/PTY write before source=spawn-prime bytes=3 afterSpawnMs=\d+/),
            );
            expect(debug).toHaveBeenCalledWith(
                'FsmDriver',
                expect.stringMatching(/PTY write after source=spawn-prime bytes=3 afterSpawnMs=\d+ outcome=success/),
            );
            expect(info.mock.calls.some(([, message]) => message.includes('PTY write'))).toBe(false);
        } finally {
            driver.shutdown();
        }
    });

    it.each([
        ['false', 'false'],
        ['throw', 'error error=simulated PTY write failure'],
        ['reject', 'error error=simulated async PTY write failure'],
    ] as const)('logs a %s PTY write failure instead of reporting success', async (writeOutcome, expectedOutcome) => {
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined);
        const factory = new RecordingFactory(writeOutcome);
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                send_on_spawn: [FOCUS_IN],
                send_on_spawn_delay_ms: 20,
            })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        factory.last!.emitOutput('\r ⣷ ');
        try {
            await sleep(80);
            expect(warn).toHaveBeenCalledWith(
                'FsmDriver',
                expect.stringMatching(new RegExp(`PTY write after source=spawn-prime bytes=3 afterSpawnMs=\\d+ outcome=${expectedOutcome}`)),
            );
        } finally {
            driver.shutdown();
        }
    });

    it('writes nothing extra when send_on_spawn is absent (CLI-agnostic)', async () => {
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({})),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        pty.emitOutput('\r ⣷ ');
        try {
            await sleep(80);
            expect(pty.writes).toEqual([]);
        } finally {
            driver.shutdown();
        }
    });

    it('antigravity-cli spec ships a focus-in spawn prime', () => {
        const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
        const specPath = path.join(REPO_ROOT, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json');
        const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
        expect(Array.isArray(spec.send_on_spawn)).toBe(true);
        // Focus-in event: ESC [ I -- wakes antigravity's focus-gated input box
        // so the first programmatic message lands without a manual keystroke.
        expect(spec.send_on_spawn).toContain(FOCUS_IN);
    });

    it('antigravity-cli spec opts into stall refocus', () => {
        const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
        const specPath = path.join(REPO_ROOT, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json');
        const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
        // The focus-gated TUI also freezes output mid-turn on focus loss; the
        // refocus window re-injects the focus-in wake to flush it.
        expect(typeof spec.refocus_when_stalled_ms).toBe('number');
        expect(spec.refocus_when_stalled_ms).toBeGreaterThan(0);
    });
});

describe('FsmDriver -- refocus_when_stalled_ms stall recovery', () => {
    // An initial state with generating status and no outgoing transitions: the
    // fake emits one startup frame, then the screen never changes, which is the
    // focus-gated stall the watchdog must recover.
    function generatingStallSpec(overrides: Record<string, unknown>): Record<string, unknown> {
        return baseSpec({
            states: [{ id: 'busy', label: 'Working', initial: true, status: 'generating' }],
            transitions: [],
            send_on_spawn: [FOCUS_IN],
            send_on_spawn_delay_ms: 10,
            ...overrides,
        });
    }

    it('re-injects focus-in while a generating screen stays frozen', async () => {
        const info = vi.spyOn(LOG, 'info').mockImplementation(() => undefined);
        const debug = vi.spyOn(LOG, 'debug').mockImplementation(() => undefined);
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(generatingStallSpec({ refocus_when_stalled_ms: 50 })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        pty.emitOutput('\r ⣷ ');
        try {
            // Spawn prime (1) plus at least one stall re-prime within a few
            // windows. Each write is the focus-in event.
            await sleep(220);
            const focusInWrites = pty.writes.filter(w => w === FOCUS_IN).length;
            expect(focusInWrites).toBeGreaterThanOrEqual(2);
            expect(pty.writes.every(w => w === FOCUS_IN)).toBe(true);
            expect(debug).toHaveBeenCalledWith(
                'FsmDriver',
                expect.stringMatching(/PTY write before source=stall-refocus bytes=3 afterSpawnMs=\d+/),
            );
            expect(debug).toHaveBeenCalledWith(
                'FsmDriver',
                expect.stringMatching(/PTY write after source=stall-refocus bytes=3 afterSpawnMs=\d+ outcome=success/),
            );
            expect(info).toHaveBeenCalledWith(
                'FsmDriver',
                expect.stringMatching(/stall detected .* re-injecting focus-in \(1\/3 detailed\)/),
            );
        } finally {
            driver.shutdown();
        }
    });

    it('caps detailed watchdog reinjection logs at three and summarizes later suppressions once', async () => {
        vi.useFakeTimers();
        const info = vi.spyOn(LOG, 'info').mockImplementation(() => undefined);
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(generatingStallSpec({ refocus_when_stalled_ms: 50 })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        pty.emitOutput('\r ⣷ ');
        try {
            await vi.advanceTimersByTimeAsync(500);
            expect(pty.writes.filter(w => w === FOCUS_IN).length).toBeGreaterThan(4);
            const detailed = info.mock.calls.filter(([, message]) => message.includes('stall detected'));
            expect(detailed).toHaveLength(3);
        } finally {
            driver.shutdown();
        }
        const summaries = info.mock.calls.filter(([, message]) => message.includes('stall refocus log summary'));
        expect(summaries).toHaveLength(1);
        expect(summaries[0][1]).toMatch(/: [1-9]\d* later reinjection\(s\) suppressed after first 3$/);
    });

    it('does not re-inject when refocus_when_stalled_ms is absent', async () => {
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(generatingStallSpec({})),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        pty.emitOutput('\r ⣷ ');
        try {
            await sleep(220);
            // Only the one spawn prime -- no stall watchdog without the opt-in.
            const focusInWrites = pty.writes.filter(w => w === FOCUS_IN).length;
            expect(focusInWrites).toBe(1);
        } finally {
            driver.shutdown();
        }
    });
});
