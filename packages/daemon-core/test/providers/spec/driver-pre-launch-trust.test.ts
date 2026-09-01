/**
 * Regression coverage for CliSpecV4.pre_launch_trust at the driver level: the
 * engine must trust the launch workspace BEFORE spawning the PTY so a
 * first-run "trust this folder?" prompt never appears. It stays CLI-agnostic —
 * a spec without the field triggers no trust write.
 *
 * Root cause this guards: under the v4 FSM path antigravity's `agy` spawns
 * directly with cwd = worktree, and every fresh worktree (mesh task clone)
 * blocked on the trust prompt.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { resolveLaunchTrustPlan } from '../../../src/providers/trust-provenance-ledger.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const homedirOverride = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => homedirOverride.value || actual.homedir() };
});

class StubPty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(): void { /* unused */ }
    resize(): void { /* unused */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(): void { /* unused */ }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
}

class StubFactory implements PtyTransportFactory {
    spawnedCwd: string | null = null;
    spawn(_command: string, _args: string[], options: PtySpawnOptions): PtyRuntimeTransport {
        this.spawnedCwd = (options as { cwd?: string }).cwd ?? null;
        return new StubPty();
    }
}

function baseSpec(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.pre-trust',
        name: 'pre trust test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
        ...overrides,
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-pretrust-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

describe('FsmDriver -- pre_launch_trust', () => {
    it('keeps user-confirmed trust materialization in the user store on start()', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-settings-'));
        const settingsPath = path.join(tmp, 'settings.json');
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-ws-'));
        const factory = new StubFactory();
        const trust = { settings_path: settingsPath, key: 'trustedWorkspaces' } as const;
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                pre_launch_trust: trust,
            })),
            workingDir: workspace,
            resolvedTrustPlan: resolveLaunchTrustPlan({
                provider: 'test.pre-trust', workspace, trust, storeHome: tmp,
                scope: 'user', origin: 'user_confirmed', sessionKey: 'user-session',
                lifecycle: { kind: 'persistent', expiresAt: null },
            }),
            hotReload: false,
            transportFactory: factory,
        });
        try {
            driver.start();
            const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            expect(json.trustedWorkspaces).toContain(fs.realpathSync(workspace));
        } finally {
            driver.shutdown();
            fs.rmSync(tmp, { recursive: true, force: true });
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('worker start never touches the real user settings.json', () => {
        const actualHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-actual-home-'));
        homedirOverride.value = actualHome;
        const actualSettingsPath = path.join(actualHome, '.gemini', 'antigravity-cli', 'settings.json');
        const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-worker-home-'));
        const workerSettingsPath = path.join(workerHome, '.gemini', 'antigravity-cli', 'settings.json');
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-worker-ws-'));
        fs.mkdirSync(path.dirname(actualSettingsPath), { recursive: true });
        fs.mkdirSync(path.dirname(workerSettingsPath), { recursive: true });
        const actualBytes = '{"theme":"real-user-sentinel"}\n';
        fs.writeFileSync(actualSettingsPath, actualBytes, { mode: 0o600 });
        fs.copyFileSync(actualSettingsPath, workerSettingsPath);

        const trust = { settings_path: '~/.gemini/antigravity-cli/settings.json', key: 'trustedWorkspaces' } as const;
        const factory = new StubFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({ pre_launch_trust: trust })),
            workingDir: workspace,
            extraEnv: { HOME: workerHome },
            resolvedTrustPlan: resolveLaunchTrustPlan({
                provider: 'antigravity-cli', workspace, trust, storeHome: workerHome,
                scope: 'worker', origin: 'worker_auto', sessionKey: 'worker-session',
                lifecycle: { kind: 'worktree', worktreePath: fs.realpathSync(workspace), taskId: 'task-1', expiresAt: null },
            }),
            hotReload: false,
            transportFactory: factory,
        });
        try {
            driver.start();
            expect(fs.readFileSync(actualSettingsPath, 'utf8')).toBe(actualBytes);
            const projected = JSON.parse(fs.readFileSync(workerSettingsPath, 'utf8'));
            expect(projected.theme).toBe('real-user-sentinel');
            expect(projected.trustedWorkspaces).toEqual([fs.realpathSync(workspace)]);
        } finally {
            driver.shutdown();
            fs.rmSync(workerHome, { recursive: true, force: true });
            fs.rmSync(workspace, { recursive: true, force: true });
            fs.rmSync(actualHome, { recursive: true, force: true });
            homedirOverride.value = '';
        }
    });

    it('writes no trust file when pre_launch_trust is absent (CLI-agnostic)', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-none-'));
        const settingsPath = path.join(tmp, 'settings.json');
        const factory = new StubFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({})),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        try {
            driver.start();
            expect(fs.existsSync(settingsPath)).toBe(false);
        } finally {
            driver.shutdown();
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('antigravity-cli spec declares pre_launch_trust for trustedWorkspaces', () => {
        const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
        const specPath = path.join(REPO_ROOT, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json');
        const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
        expect(spec.pre_launch_trust).toBeDefined();
        expect(spec.pre_launch_trust.key).toBe('trustedWorkspaces');
        expect(spec.pre_launch_trust.settings_path).toContain('antigravity-cli/settings.json');
    });

    // Named per-workspace-file scheme (PreLaunchTrustScheme) — the kimi trust
    // store is one file per workspace, not an array in a settings file. A spec
    // that declares { scheme: "kimi_workspace_file" } must pre-write kimi's
    // wd_<slug>_<sha256[:12]> trust file before spawn, so a fresh worktree
    // never dies on the unanswered TUI prompt (silent exit 0).
    it('scheme "kimi_workspace_file" pre-writes the per-workspace trust file on start()', () => {
        const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-kimi-home-'));
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-kimi-ws-'));
        const prevEnv = process.env.KIMI_CODE_HOME;
        process.env.KIMI_CODE_HOME = kimiHome;
        const factory = new StubFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({ pre_launch_trust: { scheme: 'kimi_workspace_file' } })),
            workingDir: workspace,
            hotReload: false,
            transportFactory: factory,
        });
        try {
            driver.start();
            const trustDir = path.join(kimiHome, 'workspace-trust');
            const files = fs.existsSync(trustDir) ? fs.readdirSync(trustDir) : [];
            expect(files).toHaveLength(1);
            expect(files[0]).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
            const payload = JSON.parse(fs.readFileSync(path.join(trustDir, files[0]), 'utf8'));
            expect(payload.root).toBe(fs.realpathSync(workspace));
            expect(typeof payload.trustedAt).toBe('number');
        } finally {
            driver.shutdown();
            if (prevEnv === undefined) delete process.env.KIMI_CODE_HOME;
            else process.env.KIMI_CODE_HOME = prevEnv;
            fs.rmSync(kimiHome, { recursive: true, force: true });
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('validator accepts the scheme form and rejects unknown/mixed declarations', async () => {
        const { validateFsmSpec } = await import('../../../src/providers/spec/fsm-loader.js');
        expect(validateFsmSpec(baseSpec({ pre_launch_trust: { scheme: 'kimi_workspace_file' } }))).toEqual([]);
        expect(validateFsmSpec(baseSpec({ pre_launch_trust: { scheme: 'unknown_scheme' } })))
            .toContain('pre_launch_trust.scheme must be "kimi_workspace_file"');
        expect(validateFsmSpec(baseSpec({ pre_launch_trust: { scheme: 'kimi_workspace_file', key: 'x' } })))
            .toContain('pre_launch_trust with scheme excludes settings_path/key');
    });
});
