/**
 * Host-side: a meshes.json READ FAILURE (ENFILE/EMFILE/EIO) must never read as
 * "mesh missing" / "not on roster" for a follower (the 2026-10-22 false revocation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateMeshSender, MESH_SENDER_DAEMON_ID_ARG, type MeshSenderGateDeps } from '../../src/commands/mesh-sender.js';
import { ASSISTANT_ACCOUNT_SLOT } from '@adhdev/mesh-shared';
import { ASSISTANT_REMOTE_PROJECT_COMMAND } from '../../src/assistant/assistant-remote-host.js';
import { loadMeshConfigStrict, MeshConfigUnreadableError } from '../../src/config/mesh-config-store.js';

const SELF = 'daemon_mach_host0001';
const FOLLOWER = 'daemon_mach_follow0001';
const MESH = 'mesh_follow_1';

const aclMesh = () => ({
    id: MESH,
    meshHost: { role: 'host', hostDaemonId: SELF },
    nodes: [{ id: 'n1', workspace: '/w', daemonId: SELF }],
    assistantRemoteAccess: {
        status: 'active', hostDaemonId: SELF, activeDaemonId: FOLLOWER, meshId: MESH,
        grantRevision: 1, bindingRevision: 1, allowedOps: ['poll'], accountSlot: ASSISTANT_ACCOUNT_SLOT, grantedAt: 1,
    },
});

function deps(over: Partial<MeshSenderGateDeps>): MeshSenderGateDeps {
    return {
        selfDaemonId: SELF,
        getLocalMesh: async () => null,
        listLocalMeshes: () => [],
        getSessionSettings: () => null,
        listSessionSettings: () => [],
        resolveForwardEventMeshId: () => '',
        ...over,
    } as MeshSenderGateDeps;
}
const args = { [MESH_SENDER_DAEMON_ID_ARG]: FOLLOWER, meshId: MESH, op: 'poll', bindingRevision: 1, grantRevision: 1 };
const enfile = () => Object.assign(new Error('ENFILE: file table overflow'), { code: 'ENFILE' });

describe('follower ACL under disk read pressure', () => {
    for (const code of ['ENFILE', 'EMFILE', 'EIO']) {
        it(`${code} on the disk read is a transient refusal, never not_on_roster/remote_access_denied`, async () => {
            const v = await evaluateMeshSender('roster', args, deps({
                getDiskMesh: async () => { throw Object.assign(new Error(code), { code }); },
            }), ASSISTANT_REMOTE_PROJECT_COMMAND);
            expect(v.ok).toBe(false);
            if (!v.ok) {
                expect(v.refusal).toBe('host_unavailable_transient');
                expect(v.detail).not.toContain('remote_access_denied');
                expect(v.detail).not.toContain('host_revoked');
            }
        });
    }

    it('falls back to the in-memory mesh when it carries the ACL', async () => {
        const v = await evaluateMeshSender('roster', args, deps({
            getDiskMesh: async () => { throw enfile(); },
            getLocalMesh: async () => aclMesh(),
        }), ASSISTANT_REMOTE_PROJECT_COMMAND);
        expect(v, JSON.stringify(v)).toMatchObject({ ok: true });
    });

    it('a genuinely absent mesh still follows the old (non-transient) path', async () => {
        const v = await evaluateMeshSender('roster', args, deps({ getDiskMesh: async () => null }), ASSISTANT_REMOTE_PROJECT_COMMAND);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.refusal).toBe('mesh_sender_not_on_roster');
    });
});

describe('loadMeshConfigStrict', () => {
    let dir = '';
    let prev: string | undefined;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mesh-strict-')); prev = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = dir; });
    afterEach(() => { if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

    it('ENOENT → empty config; unreadable (EISDIR) / torn JSON → throws', () => {
        expect(loadMeshConfigStrict()).toEqual({ meshes: [] });
        mkdirSync(join(dir, 'meshes.json'));
        expect(() => loadMeshConfigStrict()).toThrow(MeshConfigUnreadableError);
        rmSync(join(dir, 'meshes.json'), { recursive: true });
        writeFileSync(join(dir, 'meshes.json'), '{"meshes": [');
        expect(() => loadMeshConfigStrict()).toThrow(MeshConfigUnreadableError);
        writeFileSync(join(dir, 'meshes.json'), JSON.stringify({ meshes: [{ id: MESH }] }));
        expect(loadMeshConfigStrict().meshes[0]!.id).toBe(MESH);
    });
});
