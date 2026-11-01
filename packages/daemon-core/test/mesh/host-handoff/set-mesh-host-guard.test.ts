import { afterEach, describe, expect, it } from 'vitest';
import { meshCrudHandlers } from '../../../src/commands/med-family/mesh-crud.js';
import { createMesh, getMesh } from '../../../src/config/mesh-config.js';
import { MeshRuntimeStore } from '../../../src/mesh/mesh-runtime-store.js';
import { meshHasHostData } from '../../../src/mesh/host-handoff/snapshot-import.js';

const HOST_A = 'daemon_mach_aaaaaaaaaaaaaaaa';
const HOST_B = 'daemon_mach_bbbbbbbbbbbbbbbb';
const ctx: any = { inlineMeshCache: new Map(), getCachedInlineMesh: () => undefined, invalidateAggregateMeshStatus: () => {}, deps: {} };
const setHost = (meshId: string, hostDaemonId: string, force?: boolean) => (meshCrudHandlers.set_mesh_host as any)(ctx, { meshId, hostDaemonId, ...(force ? { force: true } : {}) });
const pinned = (meshId: string) => (getMesh(meshId)?.meshHost as { hostDaemonId?: string } | undefined)?.hostDaemonId;

afterEach(() => { try { MeshRuntimeStore.resetForTests(); } catch { /* fresh */ } });

describe('acceptance 16: set_mesh_host force vs host-owned data', () => {
    it('an empty mesh keeps the old behaviour: first pin, refusal without force, forced re-pin', async () => {
        const mesh = createMesh({ name: 'guard-empty', repoIdentity: 'example/guard-empty' });
        expect(await setHost(mesh.id, HOST_A)).toMatchObject({ success: true, applied: true });
        expect(await setHost(mesh.id, HOST_B)).toMatchObject({ success: false, code: 'host_already_pinned' });
        expect(await setHost(mesh.id, HOST_B, true)).toMatchObject({ success: true, applied: true });
        expect(pinned(mesh.id)).toBe(HOST_B);
    });

    it('a mesh with a queue / mission / decision row refuses a forced move to another daemon with host_has_data_use_handoff, and the pin does not change', async () => {
        for (const seed of [
            (id: string, t: string) => MeshRuntimeStore.getInstance().db.prepare("INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES ('q1', ?, 'pending', ?, ?, '{}')").run(id, t, t),
            (id: string, t: string) => MeshRuntimeStore.getInstance().db.prepare("INSERT INTO mesh_missions (id, mesh_id, title, created_at, updated_at) VALUES ('m1', ?, 't', ?, ?)").run(id, t, t),
            (id: string, t: string) => MeshRuntimeStore.getInstance().db.prepare("INSERT INTO mesh_mission_items (id, mission_id, mesh_id, kind, created_at, updated_at) VALUES ('i1', 'm1', ?, 'decision', ?, ?)").run(id, t, t),
        ]) {
            MeshRuntimeStore.resetForTests();
            const mesh = createMesh({ name: `guard-data-${Math.random().toString(36).slice(2, 6)}`, repoIdentity: `example/guard-${Math.random().toString(36).slice(2, 8)}` });
            await setHost(mesh.id, HOST_A);
            expect(meshHasHostData(MeshRuntimeStore.getInstance().db as never, mesh.id)).toBe(false);
            seed(mesh.id, '2026-11-01T00:00:00.000Z');
            expect(meshHasHostData(MeshRuntimeStore.getInstance().db as never, mesh.id)).toBe(true);
            const refused: any = await setHost(mesh.id, HOST_B, true);
            expect(refused).toMatchObject({ success: false, code: 'host_has_data_use_handoff', meshId: mesh.id });
            expect(refused.error).toContain('handoff');
            expect(pinned(mesh.id)).toBe(HOST_A);
        }
    });

    it('re-pinning the SAME daemon (any id form) with force, and the first pin, still work on a mesh with data', async () => {
        const mesh = createMesh({ name: 'guard-same', repoIdentity: 'example/guard-same' });
        await setHost(mesh.id, HOST_A);
        MeshRuntimeStore.getInstance().db.prepare("INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES ('q9', ?, 'pending', 't', 't', '{}')").run(mesh.id);
        expect(await setHost(mesh.id, HOST_A, true)).toMatchObject({ success: true });
        expect(await setHost(mesh.id, HOST_A.replace('daemon_', ''), true)).toMatchObject({ success: true });
        // a fresh mesh with data but no pin yet: first-setup is not a "move"
        const fresh = createMesh({ name: 'guard-fresh', repoIdentity: 'example/guard-fresh' });
        MeshRuntimeStore.getInstance().db.prepare("INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES ('q10', ?, 'pending', 't', 't', '{}')").run(fresh.id);
        expect(await setHost(fresh.id, HOST_B, true)).toMatchObject({ success: true, applied: true });
    });
});
