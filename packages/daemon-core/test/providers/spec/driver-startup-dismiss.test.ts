/**
 * CliSpecV4.startup_dismiss at the driver level (OPENCODE-UPDATE-MODAL class).
 *
 * A CLI that opens a boot-time dialog hijacking the composer (opencode's
 * "Update Available … Ask / Skip / Confirm", dismissible with Esc) declares
 * `startup_dismiss` in its spec; the engine writes the dismiss key when a
 * pattern matches the screen, bounded by the shared decision engine
 * (cli-adapters/startup-dismiss.ts): spawn window + attempt cap +
 * per-snapshot dedupe. This is the spec-path port of the legacy
 * `tui.startupDismiss` manifest feature — a prerequisite for migrating
 * opencode off ProviderCliAdapter
 * (docs/design/2026-08-17-legacy-cli-spec-migration.md).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const ESC = '\u001b';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4245;
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

function baseSpec(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.startup-dismiss',
        name: 'startup dismiss test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
        ...overrides,
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-startup-dismiss-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

function makeDriver(specOverrides: Record<string, unknown>): { driver: FsmDriver; factory: DrivableFactory } {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath: writeSpec(baseSpec(specOverrides)),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    return { driver, factory };
}

const DISMISS = {
    patterns: [{ regex: 'Update Available', flags: 'i' }],
    key: ESC,
    max_attempts: 3,
    window_ms: 20_000,
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// TerminalAdapter coalesces on_screen_changed with an 80ms debounce
// (adapter.ts screenChangeDebounceMs default); waits must clear it.
const SCREEN_SETTLE_MS = 200;

describe('FsmDriver -- startup_dismiss', () => {
    it('writes the dismiss key when a boot prompt matches, once per snapshot', async () => {
        const { driver, factory } = makeDriver({ startup_dismiss: DISMISS });
        try {
            driver.start();
            const pty = factory.last!;
            pty.feed('Update Available v1.2.3\r\nAsk  Skip  Confirm\r\nesc to dismiss\r\n');
            await sleep(SCREEN_SETTLE_MS);
            expect(pty.writes.filter(w => w === ESC)).toHaveLength(1);
            // The same unchanged screen must not trigger a second write
            // (per-snapshot dedupe) even though reevaluate runs again.
            pty.feed('');
            await sleep(SCREEN_SETTLE_MS);
            expect(pty.writes.filter(w => w === ESC)).toHaveLength(1);
        } finally {
            driver.shutdown();
        }
    });

    it('caps total writes at max_attempts across changing frames', async () => {
        const { driver, factory } = makeDriver({ startup_dismiss: { ...DISMISS, max_attempts: 2 } });
        try {
            driver.start();
            const pty = factory.last!;
            for (let i = 0; i < 4; i++) {
                pty.feed(`Update Available frame-${i}\r\n`);
                await sleep(SCREEN_SETTLE_MS);
            }
            expect(pty.writes.filter(w => w === ESC)).toHaveLength(2);
        } finally {
            driver.shutdown();
        }
    });

    it('never writes for a spec without startup_dismiss, or for a non-matching screen', async () => {
        const { driver, factory } = makeDriver({});
        const { driver: driver2, factory: factory2 } = makeDriver({ startup_dismiss: DISMISS });
        try {
            driver.start();
            factory.last!.feed('Update Available v1.2.3\r\n');
            driver2.start();
            factory2.last!.feed('Ask anything\r\n');
            await sleep(SCREEN_SETTLE_MS);
            expect(factory.last!.writes.filter(w => w === ESC)).toHaveLength(0);
            expect(factory2.last!.writes.filter(w => w === ESC)).toHaveLength(0);
        } finally {
            driver.shutdown();
            driver2.shutdown();
        }
    });
});

describe('validateFsmSpec -- startup_dismiss', () => {
    it('accepts a well-formed declaration', () => {
        expect(validateFsmSpec(baseSpec({ startup_dismiss: DISMISS }))).toEqual([]);
    });

    it('rejects a missing key, empty patterns, and a non-compiling regex', () => {
        expect(validateFsmSpec(baseSpec({ startup_dismiss: { patterns: DISMISS.patterns } })))
            .toContain('startup_dismiss.key is required');
        expect(validateFsmSpec(baseSpec({ startup_dismiss: { key: ESC, patterns: [] } })))
            .toContain('startup_dismiss.patterns must be a non-empty array');
        expect(validateFsmSpec(baseSpec({ startup_dismiss: { key: ESC, patterns: [{ regex: '(' }] } })))
            .toContain('startup_dismiss.patterns[0].regex does not compile');
    });
});
