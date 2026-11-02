import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectTargetReadiness, type ReadinessPorts } from '../../../src/mesh/host-handoff/target-readiness.js';

function fixture(): ReadinessPorts {
    const workspace = mkdtempSync(join(tmpdir(), 'handoff-ready-repo-'));
    execFileSync('git', ['init', '--quiet', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'remote.origin.url', 'https://example.invalid/owner/project.git']);
    return { selfDaemonId: 'target', mesh: { id: 'project', repoIdentity: 'example.invalid/owner/project',
        nodes: [{ id: 'target-node', daemonId: 'target', workspace }] },
        plan: { provider: 'fixture-cli', targetNodeId: 'target-node' }, validateSelection: () => true,
        coordinatorCapable: () => true, census: async () => [],
        provider: () => ({ type: 'fixture-cli', spawn: { command: process.execPath }, hostHandoffCanary: { version: 1,
            privateContextDisabled: true, toolsDisabled: true, args: ['-e', "process.stdout.write('ADHDEV_HANDOFF_READY')", '{{prompt}}', '{{maxTurns}}', '{{maxOutputTokens}}'] } }) };
}

describe('exact target readiness without release/deployment prerequisites', () => {
    it('verifies a registered workspace/repo/runtime/provider/auth canary for a local tool project with no releases', async () => {
        const ready = await inspectTargetReadiness(fixture());
        expect(ready.ok).toBe(true);
        expect(ready.checks.map(c => c.id)).toEqual(['launch_selection', 'target_workspace_binding', 'workspace_access', 'repository_identity', 'session_runtime', 'provider_installed', 'coordinator_capability', 'provider_auth_canary']);
    });
    it('rejects an ambiguous or foreign node, mismatched repository, unavailable runtime and absent canary contract', async () => {
        const p = fixture();
        p.plan!.targetNodeId = 'foreign-node';
        expect((await inspectTargetReadiness(p)).ok).toBe(false);
        p.plan!.targetNodeId = 'target-node'; p.mesh.repoIdentity = 'example.invalid/other/repo';
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'repository_identity')?.ok).toBe(false);
        p.mesh.repoIdentity = 'example.invalid/owner/project'; p.census = async () => { throw new Error('unresponsive'); };
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'session_runtime')?.ok).toBe(false);
        p.census = async () => []; p.provider = () => ({ type: 'fixture-cli', spawn: { command: process.execPath } });
        expect((await inspectTargetReadiness(p)).checks.find(c => c.id === 'provider_auth_canary')).toMatchObject({ ok: false, detail: 'canary_contract_unsupported' });
    });
});
