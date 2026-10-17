import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-delegated-launch.js';
import { applyPreLaunchTrust } from '../../src/providers/spec/pre-launch-trust.js';
import {
    recordWorkerAutoTrustGrant,
    resolveLaunchTrustPlan,
    type WorkerTrustLedger,
} from '../../src/providers/trust-provenance-ledger.js';
import { serializeKimiWorkspaceTrust } from '../../src/providers/kimi-workspace-trust.js';
import { serializeGrokWorkspaceTrust } from '../../src/providers/grok-workspace-trust.js';
import { hasTomlTrustTable } from '../../src/providers/workspace-trust-shared.js';

function temporary(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeAntigravityHome(): string {
    const home = temporary('trust-ledger-real-home-');
    const root = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(path.join(root, 'brain'), { recursive: true });
    fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'antigravity-oauth-token'), '{}', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"sentinel"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'history.jsonl'), '', { mode: 0o600 });
    return home;
}

describe('resolved worker trust plan + provenance ledger', () => {
    it('records one reusable grant with per-session provenance and expiry metadata', () => {
        const root = temporary('trust-ledger-record-');
        const workspace = fs.mkdtempSync(path.join(root, 'workspace-'));
        const workerHomeA = path.join(root, 'worker-a');
        const workerHomeB = path.join(root, 'worker-b');
        const ledgerPath = path.join(root, 'daemon', 'trust.json');
        const trust = { settings_path: '~/.gemini/antigravity-cli/settings.json', key: 'trustedWorkspaces' } as const;
        const lifecycle = {
            kind: 'worktree' as const,
            worktreePath: fs.realpathSync(workspace),
            taskId: 'task-a',
            expiresAt: '2030-01-01T00:00:00.000Z',
        };
        const first = resolveLaunchTrustPlan({
            provider: 'antigravity-cli', workspace, trust, storeHome: workerHomeA,
            scope: 'worker', origin: 'worker_auto', sessionKey: 'session-a', lifecycle,
        })!;
        const second = resolveLaunchTrustPlan({
            provider: 'antigravity-cli', workspace, trust, storeHome: workerHomeB,
            scope: 'worker', origin: 'worker_auto', sessionKey: 'session-b',
            lifecycle: { ...lifecycle, taskId: 'task-b' },
        })!;

        expect(recordWorkerAutoTrustGrant(first, { ledgerPath, nowMs: Date.parse('2026-09-01T00:00:00Z') }).reused).toBe(false);
        expect(recordWorkerAutoTrustGrant(second, { ledgerPath, nowMs: Date.parse('2026-09-01T01:00:00Z') }).reused).toBe(true);

        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as WorkerTrustLedger;
        expect(ledger.grants).toHaveLength(1);
        expect(ledger.grants[0]).toMatchObject({
            provider: 'antigravity-cli', scope: 'worker', origin: 'worker_auto',
            firstUsedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-01T01:00:00.000Z',
        });
        expect(ledger.grants[0].usages.map((usage) => [usage.sessionKey, usage.taskId])).toEqual([
            ['session-a', 'task-a'], ['session-b', 'task-b'],
        ]);
        expect(ledger.grants[0].lifecycle.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('plans ledger then per-worker projection without mutating real settings.json', () => {
        const realHome = fakeAntigravityHome();
        const workspace = temporary('trust-ledger-workspace-');
        const workerBase = temporary('trust-ledger-worker-base-');
        const ledgerPath = path.join(temporary('trust-ledger-daemon-'), 'worker-grants.json');
        const realSettings = path.join(realHome, '.gemini', 'antigravity-cli', 'settings.json');
        const original = fs.readFileSync(realSettings, 'utf8');
        const trust = { settings_path: '~/.gemini/antigravity-cli/settings.json', key: 'trustedWorkspaces' } as const;

        const launch = buildCoordinatorDelegatedCliLaunchOptions({
            cliType: 'antigravity-cli',
            workspace,
            sessionKey: 'session-worker',
            preLaunchTrust: trust,
            trustLifecycle: {
                kind: 'worktree', worktreePath: fs.realpathSync(workspace), taskId: 'task-worker', expiresAt: null,
            },
            isolation: {},
            mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
            realHome,
            workerHomeBaseDir: workerBase,
            trustLedgerPath: ledgerPath,
            runtimeEnv: { ADHDEV_WORKER_MCP: '1' } as NodeJS.ProcessEnv,
        });

        expect(launch.resolvedTrustPlan).toMatchObject({
            provider: 'antigravity-cli', scope: 'worker', origin: 'worker_auto', sessionKey: 'session-worker',
        });
        expect(path.isAbsolute(launch.resolvedTrustPlan!.storePath)).toBe(true);
        expect(launch.resolvedTrustPlan!.storePath.startsWith(launch.workerIsolation!.workerHome!)).toBe(true);
        expect(fs.existsSync(ledgerPath)).toBe(true);

        applyPreLaunchTrust(trust, launch.resolvedTrustPlan!);
        expect(fs.readFileSync(realSettings, 'utf8')).toBe(original);
        const projected = JSON.parse(fs.readFileSync(launch.resolvedTrustPlan!.storePath, 'utf8'));
        expect(projected.theme).toBe('sentinel');
        expect(projected.trustedWorkspaces).toEqual([fs.realpathSync(workspace)]);
    });

    it('keeps kimi and grok native serializers independent of their existing HOME behavior', () => {
        expect(JSON.parse(serializeKimiWorkspaceTrust('/workspace', 123))).toEqual({ root: '/workspace', trustedAt: 123 });
        expect(serializeGrokWorkspaceTrust('/workspace', 456)).toBe(
            '[folders."/workspace"]\ntrusted = true\ndecided_at = 456\n',
        );
    });
});

describe('grok worker trust plan: private store + owner-registered repository root', () => {
    const GROK = { scheme: 'grok_toml_file' } as const;

    /** <repo> with a linked worktree at <repo>-linked; returns both realpaths. */
    function repoWithLinkedWorktree(): { repo: string; linked: string } {
        const base = temporary('trust-ledger-grok-repo-');
        const repo = path.join(base, 'repository');
        fs.mkdirSync(repo);
        const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        git(['init']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
        const linked = path.join(base, 'linked');
        git(['worktree', 'add', '-b', 'fixture-linked', linked]);
        return { repo: fs.realpathSync(repo), linked: fs.realpathSync(linked) };
    }

    function plan(workspace: string, storeHome: string, registeredRepoRoots?: readonly string[], scope: 'worker' | 'user' = 'worker') {
        return resolveLaunchTrustPlan({
            provider: 'grok-cli', workspace, trust: GROK, storeHome,
            scope, origin: scope === 'worker' ? 'worker_auto' : 'user_confirmed', sessionKey: 'session-grok',
            lifecycle: { kind: 'worktree', worktreePath: workspace, meshId: 'mesh-a', taskId: 'task-grok', expiresAt: null },
            ...(registeredRepoRoots ? { registeredRepoRoots } : {}),
        });
    }

    it('pins a worker plan to <storeHome>/.grok/trusted_folders.toml and keeps user launches unchanged', () => {
        const workspace = temporary('trust-ledger-grok-ws-');
        const storeHome = temporary('trust-ledger-grok-home-');
        const worker = plan(workspace, storeHome)!;
        expect(worker.storePath).toBe(path.join(storeHome, '.grok', 'trusted_folders.toml'));
        expect(worker.workspaceRealpath).toBe(fs.realpathSync(workspace));
        expect(worker.authorizedRepoRoot).toBeUndefined();
        // A user launch keeps honoring the owner's own GROK_HOME (driver branch).
        expect(plan(workspace, storeHome, undefined, 'user')).toBeNull();
        // Other named schemes are untouched.
        expect(resolveLaunchTrustPlan({
            provider: 'kimi', workspace, trust: { scheme: 'kimi_workspace_file' }, storeHome,
            scope: 'worker', origin: 'worker_auto', sessionKey: 's', lifecycle: { kind: 'persistent', expiresAt: null },
        })).toBeNull();
    });

    it('authorizes the canonical repository root only when it is an exact owner-registered root', () => {
        const { repo, linked } = repoWithLinkedWorktree();
        const storeHome = temporary('trust-ledger-grok-home-');
        expect(plan(linked, storeHome, [repo])!.authorizedRepoRoot).toEqual({
            realpath: repo, authority: 'owner_registered_mesh_node', meshId: 'mesh-a',
        });
        // Git metadata alone, a registered ancestor, or a relative path never authorize.
        expect(plan(linked, storeHome, [])!.authorizedRepoRoot).toBeUndefined();
        expect(plan(linked, storeHome, [path.dirname(repo)])!.authorizedRepoRoot).toBeUndefined();
        expect(plan(linked, storeHome, ['repository'])!.authorizedRepoRoot).toBeUndefined();
        // Launching in the registered root itself needs no second entry.
        expect(plan(repo, storeHome, [repo])!.authorizedRepoRoot).toBeUndefined();
    });

    it('records root provenance on the ledger grant and drops it once the root is no longer registered', () => {
        const { repo, linked } = repoWithLinkedWorktree();
        const storeHome = temporary('trust-ledger-grok-home-');
        const ledgerPath = path.join(temporary('trust-ledger-grok-daemon-'), 'grants.json');
        const first = recordWorkerAutoTrustGrant(plan(linked, storeHome, [repo])!, { ledgerPath, nowMs: 1_000 });
        expect(first.grant.authorizedRepoRoot?.realpath).toBe(repo);
        expect(first.grant.lifecycle).toMatchObject({ kind: 'worktree', worktreePath: linked, taskId: 'task-grok' });
        expect(first.grant.usages[0]).toMatchObject({ sessionKey: 'session-grok', taskId: 'task-grok' });

        const second = recordWorkerAutoTrustGrant(plan(linked, storeHome, [])!, { ledgerPath, nowMs: 2_000 });
        expect(second.reused).toBe(true);
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as WorkerTrustLedger;
        expect(ledger.grants).toHaveLength(1);
        expect(ledger.grants[0].authorizedRepoRoot).toBeUndefined();
    });

    it('delegated grok launch projects worktree + registered root into the private store only', () => {
        const { repo, linked } = repoWithLinkedWorktree();
        const realHome = temporary('trust-ledger-grok-realhome-');
        fs.mkdirSync(path.join(realHome, '.grok'));
        fs.writeFileSync(path.join(realHome, '.grok', 'auth.json'), '{}', { mode: 0o600 });
        const ownerStore = path.join(realHome, '.grok', 'trusted_folders.toml');
        fs.writeFileSync(ownerStore, '# owner\n', { mode: 0o600 });
        const launch = buildCoordinatorDelegatedCliLaunchOptions({
            cliType: 'grok-cli',
            workspace: linked,
            sessionKey: 'session-grok-launch',
            preLaunchTrust: GROK,
            registeredRepoRoots: [repo],
            trustContext: { meshId: 'mesh-a', taskId: 'task-grok' },
            realHome,
            workerHomeBaseDir: temporary('trust-ledger-grok-base-'),
            trustLedgerPath: path.join(temporary('trust-ledger-grok-daemon-'), 'grants.json'),
            runtimeEnv: { ADHDEV_WORKER_MCP: 'off' } as NodeJS.ProcessEnv,
        });
        const resolved = launch.resolvedTrustPlan!;
        expect(resolved.authorizedRepoRoot?.realpath).toBe(repo);
        expect(resolved.storePath).toBe(path.join(launch.env.GROK_HOME, 'trusted_folders.toml'));
        expect(applyPreLaunchTrust(GROK, resolved)).toBe(linked);
        const projected = fs.readFileSync(resolved.storePath, 'utf8');
        expect(hasTomlTrustTable(projected, 'folders', linked)).toBe(true);
        expect(hasTomlTrustTable(projected, 'folders', repo)).toBe(true);
        expect(fs.readFileSync(ownerStore, 'utf8')).toBe('# owner\n');
    });
});
