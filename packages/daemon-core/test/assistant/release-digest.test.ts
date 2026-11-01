import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testConfigDir = join(tmpdir(), `adhdev-release-digest-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { recordReleaseDeploy, scopeRelease, upsertRelease } from '../../src/mesh/mesh-releases.js';
import { collectReleaseDigest, releaseStatusFields, sanitizeReleaseFields } from '../../src/assistant/release-digest.js';

let meshId = '';
beforeEach(() => { meshId = `rel-digest-${randomUUID().slice(0, 8)}`; });
afterEach(() => {
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('assistant release digest (design 2026-11-01-release-objects §7)', () => {
    it('answers "what is in this release" from data and stays empty without releases', () => {
        expect(releaseStatusFields(meshId)).toEqual({});
        const rel = upsertRelease(meshId, { name: '1.0.82-rc.34', channel: 'preview' }, 'coordinator');
        if (!rel.ok) throw new Error(rel.error);
        const { record: m1 } = upsertStructuredMission(meshId, { title: 'Release badge', goal: 'g', status: 'active', releaseNote: 'Added a release badge.', itemsAdd: [{ kind: 'live_check', text: 'see badge', machine: 'mac' }] } as any);
        const { record: m2 } = upsertStructuredMission(meshId, { title: 'Quiet', goal: 'g', status: 'active' } as any);
        scopeRelease(meshId, rel.release.id, { add: [m1.id, m2.id] }, 'coordinator');
        recordReleaseDeploy(meshId, { releaseId: rel.release.id, channel: 'preview', version: '1.0.82-rc.34', commit: 'abc123', targets: { npm: { commit: 'abc123', deployedAt: '2026-11-01T01:00:00.000Z' } } }, 'script');
        const [entry] = collectReleaseDigest(meshId);
        expect(entry).toMatchObject({ name: '1.0.82-rc.34', status: 'deployed', version: '1.0.82-rc.34', headCommit: 'abc123', deployedAt: '2026-11-01T01:00:00.000Z', missionCount: 2, needsNote: 1, openLiveChecks: 1 });
        expect(entry.missions.find(m => m.missionId === m1.id)).toMatchObject({ title: 'Release badge', releaseNote: 'Added a release badge.', openLiveChecks: 1 });
        expect(releaseStatusFields(meshId).releases).toHaveLength(1);
    });

    it('re-projects a remote host block by allow-list (unknown fields and bad enums are dropped)', () => {
        const out = sanitizeReleaseFields({ releases: [
            { id: 'rel_1', name: 'rc', channel: 'preview', status: 'deployed', missionCount: 2, needsNote: 1, openLiveChecks: 0, secret: 'x', missions: [{ missionId: 'm1', title: 'T'.repeat(100), chat: 'private', openLiveChecks: 1 }] },
            { id: 'rel_2', name: 'bad', channel: 'beta', status: 'deployed' },
        ] });
        expect(out.releases).toHaveLength(1);
        expect(JSON.stringify(out)).not.toMatch(/secret|private/);
        expect(out.releases![0].missions[0].title).toHaveLength(60);
        expect(sanitizeReleaseFields({})).toEqual({});
    });
});
