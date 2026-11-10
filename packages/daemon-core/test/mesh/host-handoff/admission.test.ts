import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ config: { meshes: [] as any[] }, fence: undefined as unknown, pending: undefined as unknown }));
vi.mock('../../../src/config/mesh-config-store.js', () => ({
    readMeshConfigFromDisk: () => state.config,
    getMeshConfigPath: () => '/fixture/meshes.json',
}));
vi.mock('../../../src/mesh/mesh-runtime-store.js', () => ({
    MeshRuntimeStore: { getInstance: () => ({ db: { prepare: (sql: string) => ({ get: () => sql.includes('mesh_host_write_fences') ? state.fence : state.pending }) } }) },
}));
import { durableHandoffAdmissionFailure } from '../../../src/mesh/host-handoff/admission.js';

beforeEach(() => {
    state.config = { meshes: [{ id: 'mesh', meshHost: { role: 'member' } }] };
    state.fence = undefined;
    state.pending = undefined;
});
describe('durable handoff admission', () => {
    it('leaves ordinary member authority refusal to the normal host guard', () => {
        expect(durableHandoffAdmissionFailure('mesh')).toBeNull();
    });
    it.each(['handoffFence', 'handedOffTo'])('retains a persisted %s even for a host role', field => {
        state.config.meshes[0].meshHost = { role: 'host', [field]: { handoffId: 'handoff', epoch: 2 } };
        expect(durableHandoffAdmissionFailure('mesh')).toMatchObject({ code: 'mesh_host_handoff_fenced' });
    });
    it('retains durable write fences even without a project record', () => {
        state.config.meshes = [];
        state.fence = { held: true };
        expect(durableHandoffAdmissionFailure('mesh')).toMatchObject({ code: 'mesh_host_handoff_fenced' });
    });
    it.each(['frozen', 'exporting', 'exported', 'awaiting_ack', 'acked', 'activating', 'uncertain', 'committed'])('retains source authority during %s', phase => {
        state.pending = { phase, epoch: 2 };
        expect(durableHandoffAdmissionFailure('mesh')).toMatchObject({ code: 'mesh_host_handoff_fenced' });
    });
    describe('member scope (a former host acting on its own node for the current host)', () => {
        const member = { scope: 'member' as const };
        it('allows a completed handoff: handedOffTo, history fence, committed source row', () => {
            state.config.meshes[0].meshHost = { role: 'member', hostEpoch: 1, handedOffTo: { daemonId: 'b', epoch: 1, handoffId: 'h', at: 1, retainUntil: 2 } };
            state.fence = { mode: 'history' };
            state.pending = { phase: 'committed', epoch: 1 };
            expect(durableHandoffAdmissionFailure('mesh', member)).toBeNull();
            // host-role operations on the same former host stay refused
            expect(durableHandoffAdmissionFailure('mesh')).toMatchObject({ code: 'mesh_host_handoff_fenced' });
        });
        it.each(['frozen', 'exporting', 'activating', 'uncertain'])('still refuses an in-flight %s cut', phase => {
            state.pending = { phase, epoch: 2 };
            expect(durableHandoffAdmissionFailure('mesh', member)).toMatchObject({ code: 'mesh_host_handoff_fenced' });
        });
        it('still refuses a freeze fence, a transfer write fence and unreadable authority', () => {
            state.config.meshes[0].meshHost = { role: 'host', handoffFence: { handoffId: 'h', epoch: 2 } };
            expect(durableHandoffAdmissionFailure('mesh', member)).toMatchObject({ code: 'mesh_host_handoff_fenced' });
            state.config.meshes[0].meshHost = { role: 'member' };
            state.fence = { mode: 'transfer' };
            expect(durableHandoffAdmissionFailure('mesh', member)).toMatchObject({ code: 'mesh_host_handoff_fenced' });
        });
    });
    it('does not revive an older source intent after a newer host epoch', () => {
        state.config.meshes[0].meshHost.hostEpoch = 3;
        state.pending = { phase: 'committed', epoch: 2 };
        expect(durableHandoffAdmissionFailure('mesh')).toBeNull();
    });
});
