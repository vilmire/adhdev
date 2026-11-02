import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ dir: '', notify: vi.fn((_notice: any) => true) }));
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => state.dir, getMachineId: () => 'hold-test', loadConfig: () => ({ machineId: 'hold-test' }) }));
vi.mock('../../src/mesh/turn-ledger/deliver.js', () => ({ notifyMeshCoordinator: state.notify }));
import { enqueueTask, getQueueEntryById, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { projectTurnTopicEntry } from '../../src/seqscribe/mesh-publisher.js';
import type { MeshTopicEntry } from '@adhdev/mesh-shared';
import { QUEUE_HOLD_NOTICE_AFTER_MS } from '../../src/mesh/mesh-queue-hold.js';
import { recordQueueTaskHold, notifyHeldQueueTasks, holdReasonIdPart } from '../../src/mesh/mesh-queue-hold-store.js';
import { __markAutoLaunchForTests } from '../../src/mesh/mesh-queue-autolaunch.js';
import { noteQuotaGateEvidence, resetQuotaGateEvidenceForTests } from '../../src/mesh/mesh-quota-override.js';

const mesh = 'queue-hold-quota-test';
const QUOTA_REASON = 'all_providers_quota_gated: claude-cli: provider_quota_weekly_low';
beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'mesh-hold-quota-'));
    state.notify.mockClear();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
});
afterEach(() => { resetQuotaGateEvidenceForTests(); __resetMeshRuntimeStoreForTests(); rmSync(state.dir, { recursive: true, force: true }); vi.useRealTimers(); });

describe('quota-gated holds notify the coordinator', () => {
    it('raises mesh:queue_held once after the threshold for an all-providers-quota-gated hold', () => {
        const task = enqueueTask(mesh, 'Pinned to claude', { difficulty: 'medium', taskMode: 'code_change', requiredTags: ['provider=claude-cli'] } as any);
        __markAutoLaunchForTests(mesh, task.id, { status: 'skipped', reason: QUOTA_REASON });
        notifyHeldQueueTasks(mesh);
        expect(state.notify).not.toHaveBeenCalled();
        vi.advanceTimersByTime(QUEUE_HOLD_NOTICE_AFTER_MS);
        // The 4 s reconcile loop re-stamps the same skip every tick; the hold clock must survive it.
        for (let i = 0; i < 3; i++) { __markAutoLaunchForTests(mesh, task.id, { status: 'skipped', reason: QUOTA_REASON }); vi.advanceTimersByTime(4_000); }
        notifyHeldQueueTasks(mesh); notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(1);
        expect(state.notify.mock.calls[0][0]).toMatchObject({ event: 'mesh:queue_held', metadataEvent: { taskId: task.id } });
        expect(getQueueEntryById(mesh, task.id)?.holdNoticeId).toBeTruthy();
    });

    it('says in plain words what blocks the task and the next actions, with the reset time', () => {
        const task = enqueueTask(mesh, 'Pinned to claude', { difficulty: 'medium', taskMode: 'code_change', requiredTags: ['provider=claude-cli'] } as any);
        noteQuotaGateEvidence(mesh, task.id, [{ providerType: 'claude-cli', block: { reason: 'provider_quota_weekly_low', window: 'weekly', remainingPercent: 4, thresholdPercent: 10, resetsAt: Date.parse('2026-11-03T09:00:00Z') } }]);
        __markAutoLaunchForTests(mesh, task.id, { status: 'skipped', reason: QUOTA_REASON });
        vi.advanceTimersByTime(QUEUE_HOLD_NOTICE_AFTER_MS);
        notifyHeldQueueTasks(mesh);
        const text: string = state.notify.mock.calls[0][0].coordinatorMessage;
        expect(text).toContain('claude-cli weekly quota is 4% left, reserve 10%');
        expect(text).toContain('pinned to claude-cli');
        expect(text).toContain('2026-11-03 09:00Z');
        expect(text).toContain('wait until the reset');
        expect(text).toContain('requestQuotaOverride');
        expect(text).toContain('you cannot');
    });

    it('does not page a second time with the difficulty-floor wording ten minutes later', () => {
        const task = enqueueTask(mesh, 'Quota held', { difficulty: 'medium', taskMode: 'code_change' } as any);
        __markAutoLaunchForTests(mesh, task.id, { status: 'skipped', reason: QUOTA_REASON });
        vi.advanceTimersByTime(QUEUE_HOLD_NOTICE_AFTER_MS);
        notifyHeldQueueTasks(mesh);
        vi.advanceTimersByTime(8 * 60_000);
        __markAutoLaunchForTests(mesh, task.id, { status: 'skipped', reason: QUOTA_REASON });
        notifyHeldQueueTasks(mesh);
        expect(state.notify).toHaveBeenCalledTimes(1);
        expect(state.notify.mock.calls[0][0].event).toBe('mesh:queue_held');
    });
});

describe('hold notice event id', () => {
    it('keeps the id identifier-shaped when the reason is free-form', () => {
        const part = holdReasonIdPart('all_providers_quota_gated: claude-cli: provider_quota_weekly_low');
        expect(part).toMatch(/^all_providers_quota_gated-[0-9a-f]{12}$/);
        expect(holdReasonIdPart('review_input_unavailable')).toBe('review_input_unavailable');
        // The real publish guard: a raw free-form reason parks the notice as local-only.
        const entry = (reason: string) => ({ v: 2, at: 1, k: 'turn.notify', notify: 'mesh_event', targetDaemonId: 'standalone_mach_x', taskId: 't', eventId: `queue-hold:m:t:2026-11-02T07:27:01.686Z:${reason}:none` }) as MeshTopicEntry;
        expect(projectTurnTopicEntry(entry('all_providers_quota_gated: claude-cli: provider_quota_weekly_low'))).toBeNull();
        expect(projectTurnTopicEntry(entry(part))).not.toBeNull();
    });
});
