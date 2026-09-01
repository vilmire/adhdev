import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-manager.js';
import { applyPreLaunchTrust } from '../../src/providers/spec/pre-launch-trust.js';
import {
    recordWorkerAutoTrustGrant,
    resolveLaunchTrustPlan,
    type WorkerTrustLedger,
} from '../../src/providers/trust-provenance-ledger.js';
import { serializeKimiWorkspaceTrust } from '../../src/providers/kimi-workspace-trust.js';
import { serializeGrokWorkspaceTrust } from '../../src/providers/grok-workspace-trust.js';

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

