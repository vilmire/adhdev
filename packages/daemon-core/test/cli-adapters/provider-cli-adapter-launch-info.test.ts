import { describe, expect, it } from 'vitest';
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';

/**
 * getLaunchInfo() surfaces the session's launch metadata (args / cwd / extra-env
 * KEYS / providerSessionId) for the dashboard Session info panel. It re-derives the
 * spawn plan from the live adapter inputs and intentionally drops extra-env VALUES so
 * secrets are never sent to the dashboard.
 */
function makeAdapter(opts: {
    spawnArgs?: string[];
    extraArgs?: string[];
    extraEnv?: Record<string, string>;
    workingDir?: string;
} = {}) {
    const provider = {
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        binary: 'claude',
        spawn: {
            command: 'claude',
            args: opts.spawnArgs ?? ['--resume', '{{workingDir}}'],
            shell: true,
            env: {},
        },
        scripts: {
            detectStatus: () => 'generating',
            parseApproval: () => null,
        },
    } as any;
    return new ProviderCliAdapter(
        provider,
        opts.workingDir ?? '/tmp/project',
        opts.extraArgs ?? [],
        opts.extraEnv ?? {},
    ) as any;
}

describe('ProviderCliAdapter.getLaunchInfo', () => {
    it('returns cwd, the full arg vector (spawn.args + extraArgs), and extra-env KEYS only', () => {
        const adapter = makeAdapter({
            spawnArgs: ['--model', 'opus'],
            extraArgs: ['--dangerously-skip-permissions'],
            extraEnv: { ANTHROPIC_API_KEY: 'sk-secret-value', SOME_FLAG: '1' },
            workingDir: '/tmp/project',
        });
        const info = adapter.getLaunchInfo();
        expect(info.cwd).toBe('/tmp/project');
        // Full vector = provider base args + per-launch extra args.
        expect(info.args).toEqual(['--model', 'opus', '--dangerously-skip-permissions']);
        expect(info.extraArgs).toEqual(['--dangerously-skip-permissions']);
        // Only KEYS — values (which may be secrets) are never included.
        expect(info.extraEnvKeys.sort()).toEqual(['ANTHROPIC_API_KEY', 'SOME_FLAG']);
        expect(JSON.stringify(info)).not.toContain('sk-secret-value');
    });

    it('expands {{workingDir}} placeholders in args', () => {
        const adapter = makeAdapter({ spawnArgs: ['--cwd', '{{workingDir}}'], workingDir: '/tmp/ws' });
        const info = adapter.getLaunchInfo();
        expect(info.args).toContain('/tmp/ws');
        expect(info.args).not.toContain('{{workingDir}}');
    });

    it('reports providerSessionId once the adapter has one (undefined before)', () => {
        const adapter = makeAdapter();
        expect(adapter.getLaunchInfo().providerSessionId).toBeUndefined();
        adapter.providerSessionId = 'sess_abc123';
        expect(adapter.getLaunchInfo().providerSessionId).toBe('sess_abc123');
    });

    it('falls back to raw extraArgs when the spawn plan cannot resolve', () => {
        // A provider whose spawn config is malformed makes resolveCliSpawnPlan throw;
        // getLaunchInfo must still return the cwd + extra args rather than blow up.
        const adapter = makeAdapter({ extraArgs: ['--flag'] });
        adapter.provider = { type: 'broken', name: 'broken', spawn: null } as any;
        const info = adapter.getLaunchInfo();
        expect(info.cwd).toBe('/tmp/project');
        expect(info.extraArgs).toEqual(['--flag']);
        expect(info.args).toEqual(['--flag']);
    });
});
