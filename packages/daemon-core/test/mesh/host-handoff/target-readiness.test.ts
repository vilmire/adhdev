import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectTargetReadiness, type ReadinessPorts } from '../../../src/mesh/host-handoff/target-readiness.js';
import { handoffTickerContext } from '../../../src/commands/high-family/mesh-host-handoff.js';

function fixture(): ReadinessPorts {
    const workspace = mkdtempSync(join(tmpdir(), 'handoff-ready-repo-'));
    execFileSync('git', ['init', '--quiet', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'remote.origin.url', 'https://example.invalid/owner/project.git']);
    return { selfDaemonId: 'target', mesh: { id: 'project', repoIdentity: 'example.invalid/owner/project',
        nodes: [{ id: 'target-node', daemonId: 'target', workspace }] },
        plan: { provider: 'fixture-cli', targetNodeId: 'target-node' }, validateSelection: () => true,
        coordinatorCapable: () => true, census: async () => [],
        provider: () => ({ type: 'fixture-cli', spawn: { command: process.execPath }, hostHandoffCanary: { version: 1, enforcement: 'host',
            hostTimeoutMs: 15_000, hostMaxOutputBytes: 16 * 1024, nativeTurnCap: false, nativeOutputTokenCap: false,
            privateContextDisabled: true, toolsDisabled: true, args: ['-e', "process.stdout.write('ADHDEV_HANDOFF_READY')", '{{prompt}}'] } }) };
}

describe('exact target readiness without release/deployment prerequisites', () => {
    it('verifies a registered workspace/repo/runtime/provider/auth canary for a local tool project with no releases', async () => {
        const ready = await inspectTargetReadiness(fixture());
        expect(ready.ok).toBe(true);
        expect(ready.checks.map(c => c.id)).toEqual(['launch_selection', 'target_workspace_binding', 'workspace_access', 'repository_identity', 'session_runtime', 'provider_installed', 'coordinator_capability', 'provider_auth_canary']);
    });
    it('says why the session runtime check failed', async () => {
        const p = fixture();
        p.census = async () => { throw new Error('socket closed'); };
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'session_runtime')).toEqual({ id: 'session_runtime', ok: false, detail: 'The session host did not answer: socket closed' });
        p.census = () => new Promise(() => {}); p.censusTimeoutMs = 20;
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'session_runtime')).toEqual({ id: 'session_runtime', ok: false, detail: 'The session host did not answer: no answer within 20ms' });
        p.census = async () => [{ noId: true }];
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'session_runtime')).toEqual({ id: 'session_runtime', ok: false, detail: 'The session host answered with an unreadable session list.' });
    });
    it('waits for a slow session host instead of calling it dead', async () => {
        const p = fixture();
        p.census = () => new Promise(resolve => setTimeout(() => resolve([]), 3_200));
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'session_runtime')?.ok).toBe(true);
    }, 15_000);
    it('rejects an ambiguous or foreign node, mismatched repository, unavailable runtime and absent canary contract', async () => {
        const p = fixture();
        p.plan!.targetNodeId = 'foreign-node';
        expect((await inspectTargetReadiness(p)).ok).toBe(false);
        p.plan!.targetNodeId = 'target-node'; p.mesh.repoIdentity = 'example.invalid/other/repo';
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'repository_identity')?.ok).toBe(false);
        p.mesh.repoIdentity = 'example.invalid/owner/project'; p.census = async () => { throw new Error('unresponsive'); };
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'session_runtime')?.ok).toBe(false);
        p.census = async () => []; p.provider = () => ({ type: 'fixture-cli', spawn: { command: process.execPath } });
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'provider_auth_canary')).toMatchObject({ ok: false, detail: 'canary_contract_unsupported: missing_declaration:fixture-cli' });
    });
});

describe('host move ticker context', () => {
    it('reaches the session host through the router deps, not the components', () => {
        const deps = { sessionHostControl: { listSessions: async () => [] } };
        const components = { router: { deps, execute: async () => undefined } };
        expect(handoffTickerContext(components).deps).toBe(deps);
    });
});
