/**
 * Regression coverage for CliSpecV4.send_on_spawn -- the spawn-time input prime
 * that wakes a focus-gated TUI (e.g. antigravity's `agy`) so its first
 * programmatic message lands without a manual keystroke.
 *
 * The engine stays CLI-agnostic: it writes the declared sequences once after
 * spawn and writes nothing extra when the field is absent.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
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
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(): void { /* unused */ }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
}

class RecordingFactory implements PtyTransportFactory {
    last: RecordingPty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new RecordingPty();
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

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-prime-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const FOCUS_IN = '\x1b[I';

describe('FsmDriver -- send_on_spawn input prime', () => {
    it('writes the declared prime sequence once shortly after spawn', async () => {
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
            // Nothing written synchronously at spawn -- the prime is delayed.
            expect(pty.writes).toEqual([]);
            await sleep(80);
            // Exactly the focus-in event, exactly once.
            expect(pty.writes).toEqual([FOCUS_IN]);
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
    // machine sits in it and the screen never changes (RecordingPty emits no
    // data), which is exactly the focus-gated stall the watchdog must recover.
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
        const factory = new RecordingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(generatingStallSpec({ refocus_when_stalled_ms: 50 })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // Spawn prime (1) plus at least one stall re-prime within a few
            // windows. Each write is the focus-in event.
            await sleep(220);
            const focusInWrites = pty.writes.filter(w => w === FOCUS_IN).length;
            expect(focusInWrites).toBeGreaterThanOrEqual(2);
            expect(pty.writes.every(w => w === FOCUS_IN)).toBe(true);
        } finally {
            driver.shutdown();
        }
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
