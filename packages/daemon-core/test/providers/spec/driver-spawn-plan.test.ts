/**
 * Regression coverage for the single-source spawn path: FsmDriver must route a
 * v4 spec's binary/args/env through the SAME planner the legacy
 * ProviderCliAdapter uses (resolveCliSpawnPlanFromParts). Before this, the
 * driver passed `spec.binary` / `spec.spawn_args` / `spec.env` straight to the
 * PTY — so it had no findBinary resolution (off-PATH npm-global binaries never
 * resolved), no `{{workingDir}}` token substitution, no shell wrapping for
 * script-shims, and no env sanitization. These tests assert the planner's
 * output reaches the PTY spawn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class RecordingPty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(): void { /* unused */ }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(): void { /* unused */ }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
}

class CapturingFactory implements PtyTransportFactory {
    command: string | null = null;
    args: string[] | null = null;
    options: PtySpawnOptions | null = null;
    spawn(command: string, args: string[], options: PtySpawnOptions): PtyRuntimeTransport {
        this.command = command;
        this.args = args;
        this.options = options;
        return new RecordingPty();
    }
}

function baseSpec(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.spawn-plan',
        name: 'spawn plan test',
        // An ELF/Mach-O native binary that exists on every CI box, so the
        // planner takes the direct (non-shell) path on this platform.
        binary: '/bin/echo',
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
        ...overrides,
    };
}

const __tmpDirsToClean: string[] = [];

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-spawn-plan-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

afterEach(() => {
    while (__tmpDirsToClean.length > 0) {
        const dir = __tmpDirsToClean.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('FsmDriver -- single-source spawn plan', () => {
    it('substitutes {{workingDir}} in spawn_args before spawning', () => {
        const factory = new CapturingFactory();
        const workingDir = os.tmpdir();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                spawn_args: ['--cwd', '{{workingDir}}', 'chat'],
            })),
            workingDir,
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        try {
            // Direct path on this platform: command is the resolved binary,
            // args carry the substituted token.
            expect(factory.args).toContain(workingDir);
            expect(factory.args).not.toContain('{{workingDir}}');
            expect(factory.args).toContain('chat');
        } finally {
            driver.shutdown();
        }
    });

    it('passes a complete sanitized env with TERMINAL_CWD, stripping npm_* keys', () => {
        // Seed an npm_* key the planner must strip and a benign key it must keep.
        const prevNpm = process.env.npm_config_test_marker;
        const prevKeep = process.env.ADHDEV_SPAWN_PLAN_KEEP;
        process.env.npm_config_test_marker = 'should-be-stripped';
        process.env.ADHDEV_SPAWN_PLAN_KEEP = 'kept';
        const factory = new CapturingFactory();
        const workingDir = os.tmpdir();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({ env: { SPEC_ENV_MARKER: 'from-spec' } })),
            workingDir,
            extraEnv: { EXTRA_ENV_MARKER: 'from-extra' },
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        try {
            const env = factory.options!.env;
            // Planner merges base process env (sanitized) + spec env + extra env.
            expect(env.SPEC_ENV_MARKER).toBe('from-spec');
            expect(env.EXTRA_ENV_MARKER).toBe('from-extra');
            expect(env.ADHDEV_SPAWN_PLAN_KEEP).toBe('kept');
            // TERMINAL_CWD pinned to the launch workspace.
            expect(env.TERMINAL_CWD).toBe(workingDir);
            // npm_* injected key stripped — the whole reason the spec path must
            // go through the planner instead of overlaying process.env raw.
            expect(env.npm_config_test_marker).toBeUndefined();
        } finally {
            driver.shutdown();
            if (prevNpm === undefined) delete process.env.npm_config_test_marker;
            else process.env.npm_config_test_marker = prevNpm;
            if (prevKeep === undefined) delete process.env.ADHDEV_SPAWN_PLAN_KEEP;
            else process.env.ADHDEV_SPAWN_PLAN_KEEP = prevKeep;
        }
    });

    it('wraps a non-absolute (unresolvable) binary in a login shell on unix', () => {
        if (os.platform() === 'win32') return; // unix-only assertion
        const factory = new CapturingFactory();
        const driver = new FsmDriver({
            // A bare name findBinary cannot resolve to an absolute native binary
            // falls back to the name itself → not absolute → shell-wrapped.
            specPath: writeSpec(baseSpec({ binary: 'definitely-not-a-real-binary-xyz' })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        try {
            // Login shell: command is a shell, args end with the `-c <cmd>` form.
            expect(factory.args).toContain('-l');
            expect(factory.args).toContain('-c');
            const joined = (factory.args ?? []).join(' ');
            expect(joined).toContain('definitely-not-a-real-binary-xyz');
        } finally {
            driver.shutdown();
        }
    });

    it('appends extraCliArgs after spawn_args', () => {
        const factory = new CapturingFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({ spawn_args: ['--permission-mode', 'default'] })),
            workingDir: os.tmpdir(),
            extraCliArgs: ['--session-id', 'abc-123'],
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        try {
            const joined = (factory.args ?? []).join(' ');
            expect(joined).toContain('--permission-mode default');
            expect(joined).toContain('--session-id abc-123');
            // extra args come AFTER the base spawn args
            expect(joined.indexOf('--session-id')).toBeGreaterThan(joined.indexOf('--permission-mode'));
        } finally {
            driver.shutdown();
        }
    });
});
