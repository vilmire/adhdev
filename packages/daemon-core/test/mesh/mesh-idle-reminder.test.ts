import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// The reminder reads missions/queue/ledger through MeshRuntimeStore, whose ledger
// side-writes a per-mesh JSONL under getConfigDir(); redirect it to a temp dir so the
// test never touches the real ~/.adhdev.
const testConfigDir = join(tmpdir(), `adhdev-idle-reminder-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    maybeInjectIdleActiveMissionReminder,
    shouldFireIdleReminder,
    buildIdleReminderMessage,
    missionSetHash,
    IDLE_REMINDER_DEBOUNCE_MS,
} from '../../src/mesh/mesh-idle-reminder.js';
import { upsertMeshMission } from '../../src/mesh/mesh-missions.js';
import { enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshLedgerForTests, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js';
import type { MeshMissionRecord } from '../../src/mesh/mesh-missions.js';

// Minimal coordinator stub: the reminder only ever calls onEvent('send_message', …).
function makeCoordinator() {
    const calls: Array<{ event: string; payload: any }> = [];
    return {
        calls,
        instance: {
            onEvent: (event: string, payload: any) => { calls.push({ event, payload }); },
        } as any,
    };
}

function mission(id: string, title: string): MeshMissionRecord {
    return {
        id, meshId: 'x', title, goal: '', status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as MeshMissionRecord;
}

describe('mesh idle-active-mission reminder', () => {
    let meshId = `idle-reminder-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `idle-reminder-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try {
            const store = MeshRuntimeStore.getInstance();
            store.clearMissionsForMesh(meshId);
            store.clearIdleReminderState(meshId);
        } catch { /* fresh store */ }
        __clearMeshLedgerForTests(meshId);
        MeshRuntimeStore.resetForTests();
    });

    describe('shouldFireIdleReminder (pure)', () => {
        it('fires when there is no prior marker', () => {
            expect(shouldFireIdleReminder(null, 'a,b', 1000)).toBe(true);
        });
        it('suppresses within the debounce window for the same mission set', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,b', 1000 + IDLE_REMINDER_DEBOUNCE_MS - 1)).toBe(false);
        });
        it('re-fires once the debounce window has elapsed', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,b', 1000 + IDLE_REMINDER_DEBOUNCE_MS + 1)).toBe(true);
        });
        it('re-fires immediately when the mission set changed', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,c', 1001)).toBe(true);
        });
    });

    describe('missionSetHash / message', () => {
        it('is order-independent', () => {
            expect(missionSetHash([mission('b', 'B'), mission('a', 'A')]))
                .toBe(missionSetHash([mission('a', 'A'), mission('b', 'B')]));
        });
        it('lists each mission as title (id) and never embeds the full goal', () => {
            const msg = buildIdleReminderMessage([mission('m1', 'Ship X'), mission('m2', 'Fix Y')]);
            expect(msg).toContain('[System] Coordinator idle with 2 active mission(s):');
            expect(msg).toContain('Ship X (m1)');
            expect(msg).toContain('Fix Y (m2)');
        });
        it('folds the overflow past the cap into "and M more"', () => {
            const many = Array.from({ length: 13 }, (_, i) => mission(`m${i}`, `T${i}`));
            const msg = buildIdleReminderMessage(many);
            expect(msg).toContain('…and 3 more');
        });
    });

    it('injects a reminder once when idle with active missions', () => {
        upsertMeshMission(meshId, { title: 'Deploy pipeline', goal: 'ship rc' });
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(true);
        expect(coord.calls).toHaveLength(1);
        expect(coord.calls[0].event).toBe('send_message');
        expect(coord.calls[0].payload.input.text).toContain('Deploy pipeline');
    });

    it('no-op when there are no active missions', () => {
        const coord = makeCoordinator();
        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    it('no-op when a completed/abandoned mission is the only mission', () => {
        const m = upsertMeshMission(meshId, { title: 'Done work', goal: 'x' });
        upsertMeshMission(meshId, { id: m.id, title: 'Done work', status: 'completed' });
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    it('no-op when the mesh is NOT idle (a queue task is in flight)', () => {
        upsertMeshMission(meshId, { title: 'Active work', goal: 'x' });
        enqueueTask(meshId, 'do the thing', { difficulty: 'medium' }); // pending queue task → totalActiveCount > 0
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    // A running `mesh_refine_node` job is recorded in the ledger as a `task_dispatched`
    // refine entry with no matching terminal. buildMeshActiveWork does not model refine jobs,
    // so without the explicit async-refine gate this mesh reads as "no work in flight" and the
    // reminder would push the coordinator to close a mission whose verification is still running.
    function appendRefineDispatch(id: string) {
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node-a',
            payload: {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId: id, status: 'accepted', meshId, nodeId: 'node-a' },
                async: true,
            },
        } as any);
    }
    function appendRefineTerminal(id: string) {
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-a',
            payload: {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId: id, status: 'completed', meshId, nodeId: 'node-a' },
                async: true,
                success: true,
            },
        } as any);
    }

    it('no-op when an async refine job is in flight (accepted/running)', () => {
        upsertMeshMission(meshId, { title: 'Refining branch', goal: 'x' });
        appendRefineDispatch('job-inflight');
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    it('fires once the async refine job terminates and nothing else is in flight', () => {
        upsertMeshMission(meshId, { title: 'Refining branch', goal: 'x' });
        appendRefineDispatch('job-done');
        const coord = makeCoordinator();

        // Still running → suppressed.
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(false);
        // Terminal entry lands → the job is no longer active → reminder now fires.
        appendRefineTerminal('job-done');
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 2_000)).toBe(true);
        expect(coord.calls).toHaveLength(1);
    });

    it('debounces a second reminder for the same mission set inside the window', () => {
        upsertMeshMission(meshId, { title: 'Lingering', goal: 'x' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);
        // Same set, still inside the window → suppressed.
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000 + 5_000)).toBe(false);
        expect(coord.calls).toHaveLength(1);
    });

    it('re-fires when the active mission set changes', () => {
        const a = upsertMeshMission(meshId, { title: 'Mission A', goal: 'x' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);
        // Add a second active mission → the set hash changes → re-fire even inside the window.
        upsertMeshMission(meshId, { title: 'Mission B', goal: 'y' });
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 2_000)).toBe(true);
        expect(coord.calls).toHaveLength(2);
        void a;
    });

    it('re-fires after the debounce window elapses for an unchanged set', () => {
        upsertMeshMission(meshId, { title: 'Persistent', goal: 'x' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);
        const later = 1_000 + IDLE_REMINDER_DEBOUNCE_MS + 1;
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, later)).toBe(true);
        expect(coord.calls).toHaveLength(2);
    });

    it('no-op when policy.idleActiveMissionReminder === false', () => {
        upsertMeshMission(meshId, { title: 'Suppressed', goal: 'x' });
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(
            meshId,
            coord.instance,
            { idleActiveMissionReminder: false } as any,
            1_000,
        );
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });
});
