import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testConfigDir = join(tmpdir(), `adhdev-mission-git-digest-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { missionRefEvals } from '../../src/mesh/mesh-mission-ref-evals-store.js';
import { enqueueTask, __clearMeshQueueForTests, __writeTaskStatusForTests } from '../../src/mesh/mesh-work-queue.js';
import { collectMissionGitDigest, formatMissionGitDigestSection, missionGitStatusFields, sanitizeMissionGitFields } from '../../src/assistant/mission-git-digest.js';

let meshId = '';
beforeEach(() => { meshId = `mission-git-digest-${randomUUID().slice(0, 8)}`; });
afterEach(() => {
    __clearMeshQueueForTests(meshId);
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

const SHA = 'a'.repeat(40);
function mission(title: string, status: 'contained_ancestor' | 'not_contained' | 'unknown', opts: { openRemaining?: boolean; tasksDone?: boolean } = {}): string {
    const itemsAdd: unknown[] = [{ kind: 'evidence', text: 'ev', refs: [{ kind: 'commit', value: SHA }], dedupe_key: `ev-${title}` }];
    if (opts.openRemaining) itemsAdd.push({ kind: 'remaining', text: 'still to do' });
    const { record, result } = upsertStructuredMission(meshId, { title, goal: 'g', status: 'active', itemsAdd });
    const itemId = (MeshRuntimeStore.getInstance().missionItems().listItems(meshId, record.id).find(i => i.kind === 'evidence'))!.id;
    missionRefEvals().upsert(meshId, record.id, {
        itemId, refKey: `commit::${SHA}`, kind: 'commit', value: SHA, baseRef: 'origin/main', status, evaluatedAt: new Date().toISOString(),
        ...(status === 'contained_ancestor' ? { method: 'ancestry' as const } : {}),
    });
    if (opts.tasksDone) {
        const t = enqueueTask(meshId, 'task', { missionId: record.id, difficulty: 'medium' });
        __writeTaskStatusForTests(meshId, t.id, 'completed');
    }
    void result;
    return record.id;
}

describe('mission git digest (data instead of a guess)', () => {
    it('lists "landed but still active with nothing open" and "all tasks done but not landed"; open work and unknown stay out', () => {
        const landedOpenNothing = mission('Landed, nothing open', 'contained_ancestor');
        mission('Landed, work remains', 'contained_ancestor', { openRemaining: true });
        const doneNotLanded = mission('Done, not landed', 'not_contained', { tasksDone: true });
        mission('Done, git unknown', 'unknown', { tasksDone: true });
        mission('Not landed, still working', 'not_contained');

        const d = collectMissionGitDigest(meshId);
        expect(d.landedStillOpen.map(e => e.missionId)).toEqual([landedOpenNothing]);
        expect(d.finishedNotLanded.map(e => e.missionId)).toEqual([doneNotLanded]);
        expect(d.counts).toMatchObject({ landed: 2, not_landed: 2, unknown: 1 });

        const text = formatMissionGitDigestSection([{ project: 'proj', digest: d }]);
        expect(text).toContain('from git, not guesses');
        expect(text).toContain('Landed, nothing open');
        expect(text).toContain('confirm live acceptance');
        expect(text).toContain('Done, not landed');
        expect(text).not.toContain('Done, git unknown'); // unknown is never reported as "not landed"
        expect(text).not.toContain('work remains');
    });

    it('nothing to say → empty section; project_status carries the field only when missions have git refs', () => {
        expect(formatMissionGitDigestSection([{ project: 'p', digest: collectMissionGitDigest(meshId) }])).toBe('');
        expect(missionGitStatusFields(meshId)).toEqual({});
        mission('One', 'contained_ancestor');
        expect(missionGitStatusFields(meshId).missionGit?.counts).toEqual({ landed: 1 });
    });

    it('a followed remote project re-projects the field by allow-list', () => {
        const hostile = { missionGit: { counts: { landed: 2, 'bad key!': 3 }, landedStillOpen: [{ missionId: 'm1', title: 'T'.repeat(200), gitState: 'landed', extra: 'x', transcript: 'secret' }, { nope: 1 }], finishedNotLanded: 'x' } };
        const out = sanitizeMissionGitFields(hostile as any).missionGit!;
        expect(out.counts).toEqual({ landed: 2 });
        expect(out.landedStillOpen).toEqual([{ missionId: 'm1', title: 'T'.repeat(60), gitState: 'landed' }]);
        expect(out.finishedNotLanded).toEqual([]);
        expect(sanitizeMissionGitFields({} as any)).toEqual({});
    });
});
