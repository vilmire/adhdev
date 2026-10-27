import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { handleArtifactFetchOrigin } from '../../src/commands/med-family/artifact-sharing.js';
import { setArtifactCommandRuntimeForDeps } from '../../src/commands/med-family/artifact-runtime.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { normalizeAssistantRemoteAccessBinding } from '../../src/config/mesh-config.js';
import { ASSISTANT_ACCOUNT_SLOT } from '@adhdev/mesh-shared';
import { localArtifactRead } from '../../src/commands/high-family/assistant.js';

describe('artifact sharing security-review regressions', () => {
    it('MED-1: origin fetch refuses a forwarded record whose origin is another daemon', async () => {
        const reads: string[] = [];
        const record = {
            artifactId: 'art_0123456789abcdef', sessionId: 's1', meshId: 'mesh-1',
            originDaemonId: 'daemon_mach_peer', workspaceRoot: '/etc', relPath: 'hosts.md',
            kind: 'markdown', mime: 'text/markdown', title: 't', sizeBytes: 1, sha256: 'a'.repeat(64),
        };
        const fakeStore = {
            get: () => record,
            readArtifactContent: () => { reads.push('read'); return {}; },
            fetchArtifactContent: () => { reads.push('fetch'); return {}; },
        };
        const deps: any = { statusInstanceId: 'daemon_mach_self' };
        setArtifactCommandRuntimeForDeps(deps, { artifactStore: fakeStore as any } as any);
        const res: any = await handleArtifactFetchOrigin(
            { deps } as any,
            { [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_mach_peer', artifactId: record.artifactId, meshId: 'mesh-1' },
        );
        expect(res.success).toBe(false);
        expect(res.code).toBe('artifact_not_found');
        expect(reads).toEqual([]);
    });

    it('MED-2: missing allowArtifactRead no longer grants artifact ops; explicit true does', () => {
        const base = {
            hostDaemonId: 'daemon_mach_host_a_00001', meshId: 'm1', accountSlot: ASSISTANT_ACCOUNT_SLOT,
            activeDaemonId: 'daemon_mach_asst_b_00002', bindingRevision: 1, grantRevision: 1, status: 'active',
            allowedOps: ['status', 'read'], grantedAt: 1,
        };
        const legacy = normalizeAssistantRemoteAccessBinding(base, 'm1');
        expect(legacy).toBeTruthy();
        if (legacy) {
            expect(legacy.allowArtifactRead).toBe(false);
            expect(legacy.allowedOps).not.toContain('artifact_read');
        }
        const optIn = normalizeAssistantRemoteAccessBinding({ ...base, allowArtifactRead: true }, 'm1');
        if (optIn) {
            expect(optIn.allowArtifactRead).toBe(true);
            expect(optIn.allowedOps).toContain('artifact_read');
        }
        expect(optIn).toBeTruthy();
    });

    it('LOW-3: listByMission honours meshId', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-lowthree-'));
        try {
            const store = new ArtifactStore(new Database(':memory:'));
            for (const [mesh, name] of [['mesh-a', 'a.md'], ['mesh-b', 'b.md']] as const) {
                fs.writeFileSync(path.join(root, name), `# ${name}\n`);
                store.register({
                    sessionId: `sess-${mesh}`, meshId: mesh, missionId: 'mis-1', producerRole: 'worker',
                    workspaceRoot: root, path: name, title: name,
                } as any);
            }
            expect(store.listByMission('mis-1')).toHaveLength(2);
            const only = store.listByMission('mis-1', { meshId: 'mesh-a' });
            expect(only.map((r) => r.meshId)).toEqual(['mesh-a']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('LOW-5: remote-origin record without mesh transport fails closed (no local read)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-lowfive-'));
        try {
            fs.writeFileSync(path.join(root, 'x.md'), '# local\n');
            const { MeshRuntimeStore } = await import('../../src/mesh/mesh-runtime-store.js');
            const store = new ArtifactStore(MeshRuntimeStore.getInstance().db);
            const reg: any = store.register({
                sessionId: 'sess-r', meshId: 'mesh-r', producerRole: 'worker',
                originDaemonId: 'daemon_mach_remote', workspaceRoot: root, path: 'x.md', title: 'x',
            } as any);
            const ports: any = { selfDaemonId: () => 'daemon_mach_self' };
            const out: any = await localArtifactRead(ports, 'mesh-r', { artifactId: reg.record.artifactId }, { deps: {} } as any);
            expect(out.ok).toBe(false);
            expect(out.code).toBe('artifact_origin_unreachable');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
