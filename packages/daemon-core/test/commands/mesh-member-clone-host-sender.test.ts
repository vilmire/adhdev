import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ config: { meshes: [] as any[] } }));
vi.mock('../../src/config/mesh-config-store.js', async (orig) => ({
    ...(await orig<any>()),
    readMeshConfigFromDisk: () => state.config,
    getMeshConfigPath: () => '/fixture/meshes.json',
}));
vi.mock('../../src/mesh/mesh-runtime-store.js', async (orig) => ({
    ...(await orig<any>()),
    MeshRuntimeStore: { getInstance: () => ({ db: { prepare: () => ({ get: () => undefined }) } }) },
}));
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';

const HOST = 'daemon_host';
const gate = (mesh: any, scope: 'host' | 'member', args: Record<string, unknown>) =>
    (DaemonCommandRouter.prototype as any).requireMeshHostMutationOwner.call(
        { getMeshForCommand: async () => ({ mesh, inline: false, source: 'local_config' }) },
        'mesh', undefined, 'worktree clone', scope, args,
    );
const fromHost = { [MESH_SENDER_DAEMON_ID_ARG]: HOST };

beforeEach(() => {
    state.config = { meshes: [{ id: 'mesh', meshHost: { role: 'member' } }] };
});

describe('member-side worktree clone requested by the current host', () => {
    // Daemon A: former host, own meshes.json says member + handedOffTo the current host.
    const formerHost = () => {
        const meshHost = { role: 'member', hostDaemonId: HOST, hostEpoch: 1, handedOffTo: { daemonId: HOST, epoch: 1, handoffId: 'h', at: 1, retainUntil: 2 } };
        state.config = { meshes: [{ id: 'mesh', meshHost }] };
        return { id: 'mesh', meshHost, nodes: [] };
    };
    // Daemon J: never a host, no local meshes.json entry; the inline mesh carries no meshHost.
    const plainMember = () => { state.config = { meshes: [] }; return { id: 'mesh', nodes: [] }; };

    it('A (former host) accepts a clone from the current host', async () => {
        expect(await gate(formerHost(), 'member', fromHost)).toBeNull();
    });
    it('J (no local entry) accepts a clone from the host', async () => {
        expect(await gate(plainMember(), 'member', fromHost)).toBeNull();
    });
    it('A refuses a non-host sender, an unauthenticated caller and host-scope operations', async () => {
        const mesh = formerHost();
        expect(await gate(mesh, 'member', { [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_other' })).toMatchObject({ code: 'mesh_host_required' });
        expect(await gate(mesh, 'member', {})).toMatchObject({ code: 'mesh_host_required' });
        expect(await gate(mesh, 'member', { inlineMesh: { meshHost: { hostDaemonId: 'daemon_other' } } })).toMatchObject({ code: 'mesh_host_required' });
        expect(await gate(mesh, 'host', fromHost)).toMatchObject({ code: 'mesh_host_handoff_fenced' });
    });
});
