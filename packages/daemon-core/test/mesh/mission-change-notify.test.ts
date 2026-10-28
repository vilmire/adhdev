import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Bundle B follow-up: every mission write refreshes the dashboard (aggregate cache dropped +
// onMeshStateChange fired), and a write that changes nothing does not bump `version`.
const testConfigDir = join(tmpdir(), `adhdev-mission-notify-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { setMissionChangeListener } from '../../src/mesh/mesh-mission-change-notifier.js';
import { acknowledgeAnsweredDecisions } from '../../src/mesh/mesh-mission-prompt.js';
import { applyWorkerReportToMission, attachRefineMergeEvidence, upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { getMeshMission } from '../../src/mesh/mesh-missions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
const calls: string[] = [];

beforeEach(() => { meshId = `mission-notify-${randomUUID().slice(0, 8)}`; calls.length = 0; setMissionChangeListener((id) => { calls.push(id); }); });
afterEach(() => {
    setMissionChangeListener(null);
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('mission writes notify the mesh status flush', () => {
    it('the router drops the aggregate status cache AND fires onMeshStateChange for that mesh', () => {
        const onMeshStateChange = vi.fn();
        const deps = {
            commandHandler: { handle: vi.fn(), rejectUnknown: vi.fn() }, cliManager: {}, cdpManagers: new Map(),
            providerLoader: { getMeta: () => undefined, getByCategory: () => [] },
            instanceManager: { getInstance: () => undefined, listInstanceIds: () => [], collectAllStates: () => [] },
            detectedIdes: { value: [] }, sessionRegistry: {}, statusInstanceId: 'test-mission-notify',
            bus: { emit: () => {}, on: () => () => {} },
            onMeshStateChange,
        } as unknown as CommandRouterDeps;
        const router: any = new DaemonCommandRouter(deps);
        try {
            router.aggregateMeshStatusCache.set(meshId, { builtAt: Date.now(), snapshot: {}, queueRevision: 0 });
            upsertStructuredMission(meshId, { title: 'Live update', summary: 's' });
            expect(router.aggregateMeshStatusCache.has(meshId)).toBe(false);
            expect(onMeshStateChange).toHaveBeenCalledWith(meshId);
        } finally {
            router.meshNodeStatePusher.stop(); router.localMeshNodeGitWatch.stop();
        }
    });

    it('coordinator upsert, worker report decisions, refine merge evidence and the answered-decision ack each notify once the write is committed', () => {
        const m = upsertStructuredMission(meshId, { title: 'M', itemsAdd: [
            { kind: 'decision', question: 'Q?', options: [{ label: 'a' }] },
            { kind: 'remaining', text: 'x', refs: [{ kind: 'branch', value: 'feat/x' }] },
        ] });
        expect(calls).toEqual([meshId]);

        calls.length = 0;
        applyWorkerReportToMission(meshId, 'task-1', { decisionsNeeded: [{ question: 'Worker asks?', options: [{ label: 'y' }] }] });
        expect(calls).toEqual([meshId]);
        calls.length = 0;
        applyWorkerReportToMission(meshId, 'task-1', { decisionsNeeded: [{ question: 'Worker asks?', options: [{ label: 'y' }] }] }); // pure dedupe → nothing changed
        expect(calls).toEqual([]);

        attachRefineMergeEvidence(meshId, 'node-1', { merged: true, branch: 'feat/x', mergedSha: 'abcdef1234567', into: 'main' });
        expect(calls).toEqual([meshId]);

        const d = store().missionItems().listItems(meshId, m.record.id, { kinds: ['decision'] })[0];
        store().missionItems().updateItem(meshId, d.id, { state: 'answered', decision: { ...d.decision!, answer: { by: 'owner', via: 'cli', at: new Date().toISOString(), optionId: 'a' } } });
        calls.length = 0;
        expect(acknowledgeAnsweredDecisions(meshId, m.record.id)).toBe(1);
        expect(calls).toEqual([meshId]);
        calls.length = 0;
        expect(acknowledgeAnsweredDecisions(meshId, m.record.id)).toBe(0); // idempotent → no notify
        expect(calls).toEqual([]);
    });

    it('a throwing listener never fails the write', () => {
        setMissionChangeListener(() => { throw new Error('boom'); });
        expect(() => upsertStructuredMission(meshId, { title: 'Safe' })).not.toThrow();
    });
});

describe('a write that changes nothing does not bump version', () => {
    it('a pure decision re-request leaves version and event history alone; a real change bumps once', () => {
        const first = upsertStructuredMission(meshId, { title: 'V', summary: 's', itemsAdd: [{ kind: 'decision', question: 'Same?', options: [{ label: 'a' }] }] });
        const id = first.record.id;
        const v0 = getMeshMission(meshId, id)!.version;
        const events0 = store().missionItems().listEvents(meshId, id, { limit: 500 }).length;

        const again = upsertStructuredMission(meshId, { id, title: 'V', itemsAdd: [{ kind: 'decision', question: 'Same?', options: [{ label: 'a' }] }] });
        expect(again.result.itemResults[0].deduped).toBe(true);
        expect(getMeshMission(meshId, id)!.version).toBe(v0);
        expect(again.result.version).toBe(v0);
        expect(store().missionItems().listEvents(meshId, id, { limit: 500 }).length).toBe(events0);

        upsertStructuredMission(meshId, { id, title: 'V', summary: 'changed' });
        expect(getMeshMission(meshId, id)!.version).toBe((v0 ?? 1) + 1);
    });
});
