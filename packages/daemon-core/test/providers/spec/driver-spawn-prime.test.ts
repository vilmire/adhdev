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
});
