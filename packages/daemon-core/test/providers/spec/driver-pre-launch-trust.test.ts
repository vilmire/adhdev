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
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

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
    it('trusts the workspace in the declared settings file on start()', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-settings-'));
        const settingsPath = path.join(tmp, 'settings.json');
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-ws-'));
        const factory = new StubFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(baseSpec({
                pre_launch_trust: { settings_path: settingsPath, key: 'trustedWorkspaces' },
            })),
            workingDir: workspace,
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
});
