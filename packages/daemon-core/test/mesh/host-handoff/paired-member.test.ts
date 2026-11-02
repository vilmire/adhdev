import { describe, expect, it } from 'vitest';
import { findHandoffMesh, mergeIncomingHandoffNode, presentHandoffMesh, retargetHandoffMeshId } from '../../../src/mesh/host-handoff/paired-member.js';

const SELF = 'standalone_mach_target';
const HOST = 'standalone_mach_source';
const PROTOCOL = 'mesh_host';

function member(id: string, hostMeshId = PROTOCOL, hostDaemonId = HOST) {
    return {
        id,
        meshHost: { role: 'member' as const, hostDaemonId, hostMeshId },
        nodes: [{ id: 'node-member', workspace: '/work' }],
    };
}

describe('findHandoffMesh', () => {
    it('uses an exact id and ignores a second alias', () => {
        const exact = { id: PROTOCOL, meshHost: { role: 'host' as const, hostDaemonId: HOST }, nodes: [] };
        const found = findHandoffMesh([member('mesh_local'), exact], PROTOCOL, SELF);
        expect(found).toBe(exact);
    });

    it('resolves the one paired member mesh', () => {
        const local = member('mesh_local');
        expect(findHandoffMesh([local], PROTOCOL, SELF)).toBe(local);
    });

    it('refuses zero, many, self-hosted, or unpaired records', () => {
        expect(findHandoffMesh([], PROTOCOL, SELF)).toBeUndefined();
        expect(findHandoffMesh([member('a'), member('b')], PROTOCOL, SELF)).toBeUndefined();
        expect(findHandoffMesh([member('mesh_local', PROTOCOL, SELF)], PROTOCOL, SELF)).toBeUndefined();
        expect(findHandoffMesh([{ id: 'mesh_local', meshHost: { role: 'member', hostMeshId: PROTOCOL }, nodes: [] }], PROTOCOL, SELF)).toBeUndefined();
        expect(findHandoffMesh([member('mesh_local')], PROTOCOL, '')).toBeUndefined();
    });
});

describe('presentHandoffMesh', () => {
    it('stamps the single blank node only on an aliased member mesh', () => {
        const mesh = member('mesh_local');
        const presented = presentHandoffMesh(mesh, PROTOCOL, SELF);
        expect(presented).not.toBe(mesh);
        expect(presented.nodes?.[0]?.daemonId).toBe(SELF);
        expect(mesh.nodes?.[0]?.daemonId).toBeUndefined();
        expect(presentHandoffMesh({ ...mesh, id: PROTOCOL }, PROTOCOL, SELF)).toMatchObject({ id: PROTOCOL });
    });

    it('does not choose among several blank nodes or replace an existing self node', () => {
        const many = { ...member('mesh_local'), nodes: [{ id: 'a' }, { id: 'b' }] };
        expect(presentHandoffMesh(many, PROTOCOL, SELF).nodes?.every(n => !n.daemonId)).toBe(true);
        const owned = { ...member('mesh_local'), nodes: [{ id: 'node-member', daemonId: SELF, workspace: '/work' }, { id: 'other' }] };
        const presented = presentHandoffMesh(owned, PROTOCOL, SELF);
        expect(presented).toBe(owned);
    });
});

describe('mergeIncomingHandoffNode', () => {
    it('keeps a matching workspace and adopts only this daemon on the alias', () => {
        const kept = mergeIncomingHandoffNode({ daemonId: SELF, workspace: '/local' }, { id: 'n', daemonId: SELF, workspace: '/snap' }, { aliased: false, selfDaemonId: SELF });
        expect(kept).toEqual({ ok: true, node: { id: 'n', daemonId: SELF, workspace: '/local' } });
        const adopted = mergeIncomingHandoffNode({ workspace: '/local' }, { id: 'n', daemonId: SELF, workspace: '/snap' }, { aliased: true, selfDaemonId: SELF });
        expect(adopted).toEqual({ ok: true, node: { id: 'n', daemonId: SELF, workspace: '/local' } });
    });

    it('rejects a changed identity, a foreign adopt, and a blank incoming id', () => {
        const changed = 'target node identity changed during config apply';
        expect(mergeIncomingHandoffNode({ daemonId: SELF, workspace: '/local' }, { daemonId: HOST }, { aliased: true, selfDaemonId: SELF }).ok).toBe(false);
        expect(mergeIncomingHandoffNode({ workspace: '/local' }, { daemonId: HOST }, { aliased: true, selfDaemonId: SELF })).toEqual({ ok: false, error: changed });
        expect(mergeIncomingHandoffNode({ workspace: '/local' }, { daemonId: SELF }, { aliased: false, selfDaemonId: SELF }).ok).toBe(false);
        expect(mergeIncomingHandoffNode({ daemonId: SELF }, {}, { aliased: true, selfDaemonId: SELF }).ok).toBe(false);
    });
});

describe('retargetHandoffMeshId', () => {
    it('renames the aliased record and refuses a second record with the protocol id', () => {
        const mesh = { id: 'mesh_local' };
        const other = { id: 'mesh_other' };
        expect(retargetHandoffMeshId([mesh, other], mesh, PROTOCOL)).toEqual({ ok: true });
        expect(mesh.id).toBe(PROTOCOL);
        const occupied = { id: PROTOCOL };
        const again = { id: 'mesh_local' };
        expect(retargetHandoffMeshId([again, occupied], again, PROTOCOL)).toEqual({ ok: false, error: 'handoff mesh id collision' });
        expect(again.id).toBe('mesh_local');
    });
});
