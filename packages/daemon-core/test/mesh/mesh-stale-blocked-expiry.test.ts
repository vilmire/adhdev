import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rows: [] as any[],
    getQueueEntries: vi.fn(),
    cancelTask: vi.fn(),
    notify: vi.fn(() => true),
}));

vi.mock('../../src/config/config.js', () => ({ getMachineId: () => 'mach_self' }));
vi.mock('../../src/mesh/mesh-runtime-store.js', () => ({ MeshRuntimeStore: { getInstance: () => ({ getQueueEntries: mocks.getQueueEntries }) } }));
vi.mock('../../src/mesh/mesh-work-queue.js', () => ({ cancelTask: mocks.cancelTask }));
vi.mock('../../src/mesh/turn-ledger/deliver.js', () => ({ notifyMeshCoordinator: mocks.notify }));

import { sweepStaleBlockedTasks, STALE_BLOCKED_REASON, STALE_BLOCKED_SWEEP_CAP, STALE_BLOCKED_SWEEP_INTERVAL_MS } from '../../src/mesh/mesh-stale-blocked-expiry.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T00:00:00Z');
const row = (id: string, ageMs: number, extra: any = {}) => ({ id, status: 'blocked', updatedAt: new Date(NOW - ageMs).toISOString(), ...extra });

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADHDEV_STALE_BLOCKED_TASK_MS;
    mocks.rows = [];
    mocks.getQueueEntries.mockImplementation((_m: string, statuses: string[]) =>
        mocks.rows.filter(r => statuses.includes(r.status)));
    mocks.cancelTask.mockImplementation((_m: string, id: string) => ({ id }));
});
afterEach(() => { delete process.env.ADHDEV_STALE_BLOCKED_TASK_MS; });

describe('stale blocked expiry', () => {
    it('leaves blocked rows younger than 3 days', () => {
        mocks.rows = [row('fresh1234', 2 * DAY)];
        expect(sweepStaleBlockedTasks('m1', {}, NOW)).toEqual([]);
        expect(mocks.cancelTask).not.toHaveBeenCalled();
        expect(mocks.notify).not.toHaveBeenCalled();
    });

    it('cancels rows blocked >=3 days with the reason and sends exactly one notice', () => {
        mocks.rows = [row('old00001xx', 4 * DAY), row('old00002xx', 3 * DAY), row('fresh1234', DAY)];
        expect(sweepStaleBlockedTasks('m1', {}, NOW)).toEqual(['old00001xx', 'old00002xx']);
        expect(mocks.cancelTask).toHaveBeenCalledWith('m1', 'old00001xx', { reason: STALE_BLOCKED_REASON });
        expect(mocks.notify).toHaveBeenCalledTimes(1);
        const n = (mocks.notify.mock.calls[0] as any[])[0];
        expect(n.coordinatorMessage).toContain('Retired 2 tasks that stayed blocked for over 3 days: old00001, old00002');
    });

    it('skips a row that a pending follow-up depends on', () => {
        mocks.rows = [row('old00001xx', 5 * DAY), { id: 'child', status: 'pending', dependsOn: ['old00001xx'], updatedAt: new Date(NOW).toISOString() }];
        expect(sweepStaleBlockedTasks('m1', {}, NOW)).toEqual([]);
    });

    it('caps work per sweep and throttles per mesh', () => {
        mocks.rows = Array.from({ length: 70 }, (_, i) => row(`old${i}`.padEnd(10, 'x'), 5 * DAY));
        const state = {};
        expect(sweepStaleBlockedTasks('m1', state, NOW)).toHaveLength(STALE_BLOCKED_SWEEP_CAP);
        mocks.cancelTask.mockClear();
        expect(sweepStaleBlockedTasks('m1', state, NOW + 1000)).toEqual([]);
        expect(mocks.cancelTask).not.toHaveBeenCalled();
        expect(sweepStaleBlockedTasks('m2', state, NOW + 1000).length).toBeGreaterThan(0);
        expect(sweepStaleBlockedTasks('m1', state, NOW + STALE_BLOCKED_SWEEP_INTERVAL_MS).length).toBeGreaterThan(0);
    });

    it('ADHDEV_STALE_BLOCKED_TASK_MS=0 disables', () => {
        process.env.ADHDEV_STALE_BLOCKED_TASK_MS = '0';
        mocks.rows = [row('old00001xx', 9 * DAY)];
        expect(sweepStaleBlockedTasks('m1', {}, NOW)).toEqual([]);
        expect(mocks.cancelTask).not.toHaveBeenCalled();
    });
});
