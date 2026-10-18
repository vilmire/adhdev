import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ dir: '', notify: vi.fn((_notice: any) => true) }));
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => state.dir, getMachineId: () => 'hold-test', loadConfig: () => ({ machineId: 'hold-test' }) }));
vi.mock('../../src/mesh/turn-ledger/deliver.js', () => ({ notifyMeshCoordinator: state.notify }));
import { TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, getQueueEntryById, updateSessionTaskStatus, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { QUEUE_HOLD_NOTICE_AFTER_MS } from '../../src/mesh/mesh-queue-hold.js';
import { recordQueueTaskHold, notifyHeldQueueTasks } from '../../src/mesh/mesh-queue-hold-store.js';
import { buildMeshActiveWork } from '../../src/mesh/mesh-active-work.js';
import { compactProjectStatus } from '../../src/assistant/project-views.js';
import { __markAutoLaunchForTests } from '../../src/mesh/mesh-queue-autolaunch.js';
const opts = { providerType: 'codex-cli', assignedModel: 'gpt-5.4', allowedTaskDifficulties: ['easy', 'medium', 'difficult'] as const };
const mesh = 'queue-hold-test';
beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'mesh-hold-'));
    state.notify.mockClear();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
});
afterEach(() => { __resetMeshRuntimeStoreForTests(); rmSync(state.dir, { recursive: true, force: true }); vi.useRealTimers(); });
function conflict() {
    const store = MeshRuntimeStore.getInstance();
    const holder = enqueueTask(mesh, 'Broad test owner', { difficulty: 'medium', taskMode: 'code_change', ownedPaths: ['oss/packages/daemon-core/test/**'] });
    expect(store.claimNextQueueTask(mesh, 'holder-node', 'holder-session', [], opts)?.id).toBe(holder.id);
    const task = enqueueTask(mesh, 'Fix queue tests', { difficulty: 'medium', taskMode: 'code_change', ownedPaths: ['oss/packages/daemon-core/test/mesh/queue.test.ts'] });
    return { store, holder, task };
}
describe('durable queue holds', () => {
    it('records blocker and path pair on claim, preserves since, clears on claim', () => {
        const { store, holder, task } = conflict();
        expect(store.claimNextQueueTask(mesh, 'worker-node', 'worker-session', [], opts)).toBeNull();
        const hold = getQueueEntryById(mesh, task.id)!.hold!;
        expect(hold).toEqual({ reason: 'owned_paths_conflict', since: '2026-10-18T00:00:00.000Z', blockingTaskIds: [holder.id], detail: { overlappingPaths: [{ taskId: holder.id, ownedPath: 'oss/packages/daemon-core/test/mesh/queue.test.ts', blockingPath: 'oss/packages/daemon-core/test/**' }] } });
        vi.advanceTimersByTime(60_000); store.claimNextQueueTask(mesh, 'worker-node', 'worker-session', [], opts);
        expect(getQueueEntryById(mesh, task.id)?.hold?.since).toBe(hold.since);
        updateSessionTaskStatus(mesh, 'holder-session', 'completed', { taskId: holder.id });
        expect(store.claimNextQueueTask(mesh, 'worker-node', 'worker-session', [], opts)?.id).toBe(task.id);
        expect(getQueueEntryById(mesh, task.id)?.hold).toBeUndefined();
    });
    it('preserves scheduling timestamps and retries a notice when the runtime was unavailable', () => {
        const { task } = conflict();
        const updatedAt = getQueueEntryById(mesh, task.id)!.updatedAt;
        vi.advanceTimersByTime(30_000); recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict');
        expect(getQueueEntryById(mesh, task.id)?.updatedAt).toBe(updatedAt);
        state.notify.mockReturnValueOnce(false);
        vi.advanceTimersByTime(QUEUE_HOLD_NOTICE_AFTER_MS); notifyHeldQueueTasks(mesh);
        expect(getQueueEntryById(mesh, task.id)?.holdNoticeId).toBeUndefined();
        notifyHeldQueueTasks(mesh); notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(2);
        expect(getQueueEntryById(mesh, task.id)?.updatedAt).toBe(updatedAt);
    });
    it('auto-launch skip records the same structured blocker', () => {
        const { holder, task } = conflict();
        __markAutoLaunchForTests(mesh, task.id, { status: 'skipped', reason: 'owned_paths_conflict' });
        expect(getQueueEntryById(mesh, task.id)?.hold).toMatchObject({ reason: 'owned_paths_conflict', blockingTaskIds: [holder.id] });
    });
    it('notifies once after threshold and rearms only on reason or blocker changes', () => {
        const { store, task, holder } = conflict();
        recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict'); notifyHeldQueueTasks(mesh);
        expect(state.notify).not.toHaveBeenCalled();
        vi.advanceTimersByTime(QUEUE_HOLD_NOTICE_AFTER_MS); notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(1);
        expect(state.notify.mock.calls[0][0]).toMatchObject({ event: 'mesh:queue_held', metadataEvent: { hold: { blockingTaskIds: [holder.id] } } });
        __resetMeshRuntimeStoreForTests(); // dedup and hold clock survive a daemon restart
        vi.advanceTimersByTime(600_000); recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict'); notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(1);
        recordQueueTaskHold(mesh, task.id, 'max_parallel_tasks_reached'); notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(QUEUE_HOLD_NOTICE_AFTER_MS); notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(2);
        recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict');
        const firstSince = getQueueEntryById(mesh, task.id)!.hold!.since;
        updateSessionTaskStatus(mesh, 'holder-session', 'completed', { taskId: holder.id });
        const replacement = enqueueTask(mesh, 'New test owner', { difficulty: 'medium', taskMode: 'code_change', ownedPaths: ['oss/packages/daemon-core/test/**'], targetSessionId: 'replacement' });
        expect(MeshRuntimeStore.getInstance().claimNextQueueTask(mesh, 'new-node', 'replacement', [], opts)?.id).toBe(replacement.id);
        vi.advanceTimersByTime(1); recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict');
        expect(getQueueEntryById(mesh, task.id)?.hold?.since).not.toBe(firstSince);
        vi.advanceTimersByTime(QUEUE_HOLD_NOTICE_AFTER_MS); notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(3);
        expect(getQueueEntryById(mesh, task.id)?.hold?.blockingTaskIds).toEqual([replacement.id]);
    });
    it('activeWork and assistant status include reason, blocker title, age and counts', () => {
        const { store, task, holder } = conflict(); recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict');
        vi.advanceTimersByTime(123_000);
        const built = buildMeshActiveWork({ meshId: mesh, queue: store.getQueueEntries(mesh), nodes: [] });
        const expected = { reason: 'owned_paths_conflict', ageMs: 123_000, blockingTasks: [{ taskId: holder.id, title: 'Broad test owner' }] };
        expect(built.summary).toMatchObject({ heldCount: 1, heldReasons: { owned_paths_conflict: 1 } });
        expect(built.activeWork.find(row => row.taskId === task.id)?.hold).toMatchObject(expected);
        expect(compactProjectStatus({ activeWork: { activeWork: built } }, { queue: null, pendingApprovals: 0, coordinator: 'idle', threadOpen: false, lastRelayAt: null } as any)).toMatchObject({ heldCount: 1, heldReasons: { owned_paths_conflict: 1 }, heldTasks: [{ taskId: task.id, hold: expected }] });
    });
    it('queue_query view includes blocker titles even when only the pending row is requested', async () => {
        const { task, holder } = conflict(); recordQueueTaskHold(mesh, task.id, 'owned_paths_conflict');
        vi.advanceTimersByTime(60_000);
        const result: any = await meshStoreIpcHandlers.queue_query({} as any, { v: TURN_IPC_PROTOCOL_VERSION, meshId: mesh, view: true, statuses: ['pending'] });
        expect(result.success).toBe(true);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].hold).toMatchObject({ ageMs: 60_000, blockingTasks: [{ taskId: holder.id, title: 'Broad test owner' }] });
    });
    it('records dependency and per-node write blocker ids for every skipped candidate', () => {
        const store = MeshRuntimeStore.getInstance();
        const root = enqueueTask(mesh, 'Dependency', { difficulty: 'medium', taskMode: 'code_change' }); store.claimNextQueueTask(mesh, 'busy-node', 'busy-session', [], opts);
        const dependent = enqueueTask(mesh, 'Dependent', { difficulty: 'medium', dependsOn: [root.id] });
        const write = enqueueTask(mesh, 'Other write', { difficulty: 'medium', taskMode: 'code_change' }); store.claimNextQueueTask(mesh, 'busy-node', 'new-session', [], opts);
        expect(getQueueEntryById(mesh, dependent.id)?.hold).toMatchObject({ reason: 'dependencies_unsatisfied', blockingTaskIds: [root.id] });
        expect(getQueueEntryById(mesh, write.id)?.hold).toMatchObject({ reason: 'node_busy_with_active_assignment', blockingTaskIds: [root.id] });
    });
});
