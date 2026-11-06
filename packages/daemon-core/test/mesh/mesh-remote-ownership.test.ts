import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ dir: '', mesh: undefined as any, hostRecord: null as any }));
// This machine is 'host-machine'; a scope from 'remote-machine' was attested elsewhere.
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => state.dir, getMachineId: () => 'host-machine', loadConfig: () => ({ machineId: 'host-machine' }) }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: () => state.mesh, getMeshByRepo: () => undefined, listMeshes: () => [] }));
vi.mock('../../src/mesh/mesh-host-memory.js', async importOriginal => ({ ...await importOriginal<any>(), readMeshHostRecord: () => state.hostRecord }));
import { normalizeOwnedPaths } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, getQueueEntryById, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { attestLocalOwnership, currentPhysicalScope, isForeignPhysicalScope } from '../../src/mesh/mesh-physical-ownership.js';
import {
    remoteOwnershipProofSync, resetRemoteOwnershipForTest, validateRemoteOwnershipScope, type RemoteOwnershipTarget,
} from '../../src/mesh/mesh-remote-ownership.js';
import { meshOwnershipAttestHandlers } from '../../src/commands/low-family/mesh-ownership-attest.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';

const meshId = 'remote-ownership-mesh';
const claim = { providerType: 'codex-cli', assignedModel: 'gpt-5.4', allowedTaskDifficulties: ['medium', 'difficult'] as const };
const paths = normalizeOwnedPaths(['file.ts']).declaration;
let repo: string;

function initRepo(dir: string) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'file.ts'), 'export {};\n');
}
/** What the remote machine would answer for its own checkout. */
const remoteScope = (nodeId = 'remote-node') => attestLocalOwnership({ repoIdentity: 'repo', machineId: 'remote-machine', nodeId, workspace: repo, phase: 'source', paths });
const target = (over: Partial<RemoteOwnershipTarget> = {}): RemoteOwnershipTarget => ({
    meshId, nodeId: 'remote-node', daemonId: 'daemon_mach_remote', workspace: '/remote-host/remote-projects/abc', repoIdentity: 'repo', phase: 'source', paths, ...over,
});

beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'remote-ownership-')); state.mesh = undefined; state.hostRecord = null;
    __resetMeshRuntimeStoreForTests(); resetRemoteOwnershipForTest();
    repo = join(state.dir, 'checkout'); initRepo(repo);
});
afterEach(() => { __resetMeshRuntimeStoreForTests(); rmSync(state.dir, { recursive: true, force: true }); });

describe('foreign physical scopes', () => {
    it('keeps another machine\'s attestation as that machine answered it', () => {
        const scope = remoteScope();
        expect(isForeignPhysicalScope(scope)).toBe(true);
        // Even when this host has no such path, the scope stays current.
        expect(currentPhysicalScope({ ...scope, worktree: '/nowhere/on/this/host' }, paths)).toMatchObject({ machineId: 'remote-machine' });
        // A declaration change still invalidates it.
        expect(currentPhysicalScope(scope, normalizeOwnedPaths(['other.ts']).declaration)).toBeUndefined();
    });
    it('re-attests a local scope and never treats an unknown local id as foreign', () => {
        const local = attestLocalOwnership({ repoIdentity: 'repo', machineId: 'host-machine', nodeId: 'n', workspace: repo, phase: 'source', paths });
        expect(isForeignPhysicalScope(local)).toBe(false);
        expect(currentPhysicalScope({ ...local, gitDir: '/elsewhere' }, paths)).toBeUndefined();
        expect(isForeignPhysicalScope(local, undefined)).toBe(false);
    });
});

describe('remote attestation answer', () => {
    it('accepts only an answer for the exact node, repo, phase and declaration from another machine', () => {
        const scope = remoteScope();
        expect(validateRemoteOwnershipScope({ success: true, scope }, target())).toEqual({ scope });
        expect(validateRemoteOwnershipScope({ result: { success: true, scope } }, target())).toEqual({ scope });
        expect(validateRemoteOwnershipScope({ success: true, scope: { ...scope, nodeId: 'other' } }, target())).toMatchObject({ error: expect.stringContaining('mismatch') });
        expect(validateRemoteOwnershipScope({ success: true, scope: { ...scope, repoIdentity: 'other' } }, target())).toMatchObject({ error: expect.stringContaining('mismatch') });
        expect(validateRemoteOwnershipScope({ success: true, scope }, target({ paths: normalizeOwnedPaths(['x.ts']).declaration }))).toMatchObject({ error: expect.stringContaining('mismatch') });
        expect(validateRemoteOwnershipScope({ success: true, scope: { ...scope, machineId: 'host-machine' } }, target())).toMatchObject({ error: expect.stringContaining('mismatch') });
        expect(validateRemoteOwnershipScope({ success: false, code: 'not_mesh_host' }, target())).toMatchObject({ error: expect.stringContaining('refused: not_mesh_host') });
    });
    it('reports pending, asks once, then serves the answer', async () => {
        const scope = remoteScope();
        const dispatch = vi.fn(async () => ({ success: true, scope }));
        const onAnswer = vi.fn();
        expect(remoteOwnershipProofSync(dispatch, target(), onAnswer)).toEqual({ error: 'ownership_unproven: remote_attestation_pending' });
        expect(remoteOwnershipProofSync(dispatch, target(), onAnswer)).toEqual({ error: 'ownership_unproven: remote_attestation_pending' });
        await vi.waitFor(() => expect(onAnswer).toHaveBeenCalled());
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith('daemon_mach_remote', 'mesh_attest_node_ownership', expect.objectContaining({ nodeId: 'remote-node', ownedPaths: paths }));
        expect(remoteOwnershipProofSync(dispatch, target(), onAnswer)).toEqual({ scope });
    });
    it('turns an unreachable machine into a refusal, not a throw', async () => {
        const dispatch = vi.fn(async () => { throw new Error('peer offline'); });
        remoteOwnershipProofSync(dispatch, target());
        await vi.waitFor(() => expect(remoteOwnershipProofSync(dispatch, target())).toMatchObject({ error: expect.stringContaining('remote_attestation_unreachable: peer offline') }));
    });
});

describe('claim on a node held by another machine', () => {
    it('is held while the remote answers, then admitted with that machine\'s scope', () => {
        const store = MeshRuntimeStore.getInstance();
        const task = enqueueTask(meshId, 'Remote writer', { difficulty: 'medium', targetNodeId: 'remote-node', ownedPaths: ['file.ts'] });
        let answer: { scope: any } | { error: string } = { error: 'ownership_unproven: remote_attestation_pending' };
        const physicalContext = { workspace: '/remote-host/remote-projects/abc', machineId: 'host-machine', repoIdentity: 'repo', remoteOwnership: () => answer };
        expect(store.claimNextQueueTask(meshId, 'remote-node', 'remote-session', [], { ...claim, physicalContext })).toBeNull();
        const held = getQueueEntryById(meshId, task.id)!;
        expect(held.hold?.reason).toBe('ownership_unproven');
        expect(JSON.stringify(held.hold?.detail)).toContain('Waiting for the machine that holds this checkout');
        answer = { scope: remoteScope() };
        expect(store.claimNextQueueTask(meshId, 'remote-node', 'remote-session', [], { ...claim, physicalContext })?.id).toBe(task.id);
        expect(getQueueEntryById(meshId, task.id)?.ownershipScope).toMatchObject({ machineId: 'remote-machine', nodeId: 'remote-node' });
    });
    it('never attests the remote path on this host (the ENOENT this replaces)', () => {
        const store = MeshRuntimeStore.getInstance();
        const task = enqueueTask(meshId, 'Remote writer', { difficulty: 'medium', targetNodeId: 'remote-node', ownedPaths: ['file.ts'] });
        const remoteOwnership = vi.fn(() => ({ error: 'ownership_unproven: remote_attestation_pending' }));
        store.claimNextQueueTask(meshId, 'remote-node', 'remote-session', [], { ...claim, physicalContext: { workspace: '/absent/on/host', machineId: 'host-machine', repoIdentity: 'repo', remoteOwnership } });
        expect(remoteOwnership).toHaveBeenCalled();
        expect(JSON.stringify(getQueueEntryById(meshId, task.id)?.hold)).not.toContain('ENOENT');
    });
    it('a running remote writer does not fence a local writer on this machine', () => {
        const store = MeshRuntimeStore.getInstance();
        const remoteTask = enqueueTask(meshId, 'Remote writer', { difficulty: 'medium', targetNodeId: 'remote-node', ownedPaths: ['file.ts'] });
        expect(store.claimNextQueueTask(meshId, 'remote-node', 'remote-session', [], {
            ...claim, physicalContext: { workspace: '/absent', machineId: 'host-machine', repoIdentity: 'repo', remoteOwnership: () => ({ scope: remoteScope() }) },
        })?.id).toBe(remoteTask.id);
        const localRepo = join(state.dir, 'local'); initRepo(localRepo);
        const localTask = enqueueTask(meshId, 'Local writer', { difficulty: 'medium', targetNodeId: 'local-node', ownedPaths: ['file.ts'] });
        expect(store.claimNextQueueTask(meshId, 'local-node', 'local-session', [], {
            ...claim, physicalContext: { workspace: localRepo, machineId: 'host-machine', repoIdentity: 'repo' },
        })?.id).toBe(localTask.id);
        expect(getQueueEntryById(meshId, localTask.id)?.ownershipScope?.worktree).toBe(realpathSync(localRepo));
    });
});

describe('mesh_attest_node_ownership (on the machine that holds the checkout)', () => {
    const ctx = () => ({ deps: { statusInstanceId: 'daemon_mach_member' }, components: () => ({ cliManager: { adapters: new Map() } }) }) as any;
    const args = (sender: string, over: Record<string, unknown> = {}) => ({
        [MESH_SENDER_DAEMON_ID_ARG]: sender, meshId, nodeId: 'remote-node', workspace: repo, repoIdentity: 'repo', phase: 'source', ownedPaths: paths, ...over,
    });
    const handler = meshOwnershipAttestHandlers.mesh_attest_node_ownership;
    it('answers the mesh host it knows, from the host record when it has no mesh copy', async () => {
        state.hostRecord = { hostDaemonId: 'daemon_mach_host' };
        const res: any = await handler(ctx(), args('daemon_mach_host'));
        expect(res).toMatchObject({ success: true, scope: { machineId: 'host-machine', worktree: realpathSync(repo), nodeId: 'remote-node' } });
    });
    it('refuses anyone but that host', async () => {
        state.hostRecord = { hostDaemonId: 'daemon_mach_host' };
        expect(await handler(ctx(), args('daemon_mach_other'))).toMatchObject({ success: false, code: 'not_mesh_host' });
        state.hostRecord = null;
        expect(await handler(ctx(), args('daemon_mach_host'))).toMatchObject({ success: false, code: 'not_mesh_host' });
    });
    it('refuses a workspace that disagrees with its own record, and a session in another checkout', async () => {
        state.mesh = { meshHost: { hostDaemonId: 'daemon_mach_host' }, nodes: [{ id: 'remote-node', daemonId: 'daemon_mach_member', workspace: '/somewhere/else' }] };
        expect(await handler(ctx(), args('daemon_mach_host'))).toMatchObject({ success: false, code: 'workspace_mismatch' });
        state.mesh = { meshHost: { hostDaemonId: 'daemon_mach_host' }, nodes: [] };
        const other = join(state.dir, 'other'); initRepo(other);
        const withSession = { deps: { statusInstanceId: 'daemon_mach_member' }, components: () => ({ cliManager: { adapters: new Map([['s1', { workingDir: other }]]) } }) } as any;
        expect(await handler(withSession, args('daemon_mach_host', { sessionId: 's1' }))).toMatchObject({ success: false, code: 'active_workspace_unproven' });
    });
    it('reports a checkout it cannot attest instead of throwing', async () => {
        state.hostRecord = { hostDaemonId: 'daemon_mach_host' };
        expect(await handler(ctx(), args('daemon_mach_host', { workspace: join(state.dir, 'missing') }))).toMatchObject({ success: false, code: 'ownership_unproven' });
    });
});
