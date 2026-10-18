import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeOwnedPaths } from '@adhdev/mesh-shared';
import { broadOwnedPathsWarning } from '../src/tools/mesh-owned-paths-warning.js';
import { compactQueueRows, compactActiveWorkRecords, buildQueueStatusSummary, buildQueueStatusSummaryFromCounts } from '../src/tools/mesh-queue-helpers.js';
const task = (id: string, paths: string[], status = 'pending') => ({ id, message: `Task ${id}`, status, taskMode: 'code_change', ownedPaths: normalizeOwnedPaths(paths).declaration });
describe('compact hold visibility and enqueue advice', () => {
    it('keeps reason, blocker title and age in compact queue and mesh_status activeWork', () => {
        const hold = { reason: 'owned_paths_conflict', since: '2026-10-18T00:00:00Z', ageMs: 180_000, blockingTaskIds: ['holder'], blockingTasks: [{ taskId: 'holder', title: 'Broad test owner' }], detail: { overlappingPaths: [{ taskId: 'holder', ownedPath: 'packages/core/test/a.ts', blockingPath: 'packages/core/test/**' }] } };
        const row = { ...task('held', []), hold };
        assert.deepEqual(compactQueueRows([row]).rows[0].hold, hold);
        assert.deepEqual(compactActiveWorkRecords([{ taskId: row.id, status: 'pending', taskTitle: 'Fix tests', hold }]).records[0].hold, hold);
        for (const summary of [buildQueueStatusSummary([row]), buildQueueStatusSummaryFromCounts({ pending: 1 }, [row])]) {
            assert.equal(summary.heldCount, 1);
            assert.deepEqual(summary.heldReasons, { owned_paths_conflict: 1 });
        }
        const filtered = buildQueueStatusSummaryFromCounts({ pending: 1 }, [row], new Set(['assigned']));
        assert.equal(filtered.heldCount, 0);
        assert.deepEqual(filtered.heldReasons, {});
    });
    for (const path of ['oss/packages/core/test/**', 'packages/core/src/**', 'packages/core/**', 'packages/core', 'src/**', 'packages/**', '**']) {
        it(`warns for broad scope ${path}`, () => {
            assert.deepEqual(broadOwnedPathsWarning(task('new', [path]), [])?.broadOwnedPathsWarning.broadPaths, [path]);
        });
    }
    for (const path of ['packages/core/test/mesh/**', 'packages/core/src/queue.ts', 'src/mesh/**', 'README.md']) {
        it(`does not warn for narrow scope ${path}`, () => {
            assert.equal(broadOwnedPathsWarning(task('new', [path]), []), undefined);
        });
    }
    it('names assigned and pending conflicts, excluding self, readonly and terminal tasks', () => {
        const own = task('new', ['oss/packages/core/test/**']);
        const queue = [task('running', ['oss/packages/core/test/a.ts'], 'assigned'), task('waiting', ['oss/packages/core/test/b.ts']), task('finished', ['oss/packages/core/test/c.ts'], 'completed'), { ...task('read', ['oss/packages/core/test/**'], 'assigned'), readonly: true }, own];
        assert.deepEqual(broadOwnedPathsWarning(own, queue)?.broadOwnedPathsWarning.relatedTasks, [
            { taskId: 'running', title: 'Task running', status: 'assigned', relationship: 'blocked_by' },
            { taskId: 'waiting', title: 'Task waiting', status: 'pending', relationship: 'potential_conflict' },
        ]);
        assert.equal(broadOwnedPathsWarning({ ...own, taskMode: 'live_debug_readonly' }, queue), undefined);
    });
});
