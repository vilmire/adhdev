import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Bundle E (design §6.2 / acceptance 11): live-check listing option + "Reopen" on the owner_abandoned confirmation.
const testConfigDir = join(tmpdir(), `adhdev-needs-you-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { answerMissionDecision, buildOpenLiveChecks } from '../../src/mesh/mesh-mission-decisions.js';
import { getMeshMission } from '../../src/mesh/mesh-missions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { missionDecisionSpecs, MISSION_DECISIONS_LIST } from '../../src/commands/high-family/mission-decisions.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
const owner = { by: 'owner', via: 'dashboard' } as const;

beforeEach(() => { meshId = `needs-you-${randomUUID().slice(0, 8)}`; });
afterEach(() => {
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

const write = (input: Parameters<typeof upsertStructuredMission>[1]) => upsertStructuredMission(meshId, input, { actor: 'coordinator' });

describe('mission_decisions_list includeLiveChecks', () => {
    it('lists open live_check items only on request; default output is unchanged', async () => {
        const { record } = write({ title: 'Ship', goal: 'g', itemsAdd: [{ kind: 'live_check', text: 'verify on win32', machine: 'win-box' }, { kind: 'remaining', text: 'other' }] });
        const done = write({ id: record.id, title: '', itemsAdd: [{ kind: 'live_check', text: 'already checked' }] });
        const doneId = done.result.itemResults[0].id!;
        write({ id: record.id, title: '', itemsUpdate: [{ id: doneId, state: 'done' }] });

        const checks = buildOpenLiveChecks(meshId);
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({ meshId, missionId: record.id, missionTitle: 'Ship', text: 'verify on win32', machine: 'win-box' });

        const spec = missionDecisionSpecs.find(x => x.name === MISSION_DECISIONS_LIST)!;
        const run = spec.run as (ctx: unknown, args: Record<string, unknown>) => Promise<any>;
        const ctx = { components: () => ({}) };
        const plain = await run(ctx, { meshId });
        expect(plain).not.toHaveProperty('liveChecks');
        const withChecks = await run(ctx, { meshId, includeLiveChecks: true });
        expect(withChecks.liveChecks).toHaveLength(1);
        expect(withChecks).not.toHaveProperty('missions');
        const withMissions = await run(ctx, { meshId, includeMissions: true });
        expect(withMissions.missions).toEqual([expect.objectContaining({ missionId: record.id, openItems: expect.objectContaining({ live_check: 1, remaining: 1 }) })]);
    });
});

describe('Reopen on the owner_abandoned confirmation (acceptance 11)', () => {
    function abandon() {
        const { record } = write({ title: 'Big refactor', itemsAdd: [{ text: 'left over' }] });
        const closed = write({ id: record.id, status: 'abandoned', outcome: 'owner_abandoned' });
        return { missionId: record.id, confirmId: closed.result.ownerConfirmationItemId! };
    }

    it('answering Reopen reopens the mission and restores its carried-over items', () => {
        const { missionId, confirmId } = abandon();
        expect(getMeshMission(meshId, missionId)!.status).toBe('abandoned');
        expect(answerMissionDecision({ meshId, itemId: confirmId, optionId: 'b' }, owner)).toMatchObject({ ok: true, action: 'answered' });
        expect(getMeshMission(meshId, missionId)!.status).toBe('active');
        const left = store().missionItems().listItems(meshId, missionId, { states: ['open'] });
        expect(left.map(i => i.text)).toEqual(['left over']);
        // the answered confirmation stays answered (the coordinator is told the owner reopened it)
        expect(store().missionItems().getItem(meshId, confirmId)!.state).toBe('answered');
    });

    it('answering Correct just closes the item and leaves the mission closed', () => {
        const { missionId, confirmId } = abandon();
        expect(answerMissionDecision({ meshId, itemId: confirmId, optionId: 'a' }, owner)).toMatchObject({ ok: true });
        expect(getMeshMission(meshId, missionId)!.status).toBe('abandoned');
        expect(store().missionItems().getItem(meshId, confirmId)!.state).toBe('answered');
    });
});
