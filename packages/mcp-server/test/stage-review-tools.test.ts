import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewToDaemon } from '../src/tools/worker-tools.js';
import { MESH_ENQUEUE_TASK_TOOL, MESH_TASK_STAGE_DECIDE_TOOL } from '../src/tools/mesh-tool-schemas-queue.js';

test('reviewToDaemon maps the snake_case review payload onto the daemon camelCase shape', () => {
  const out = reviewToDaemon({
    verdict: 'changes_requested',
    findings: [{ id: 'f1', severity: 'major', category: 'correctness', claim: 'c', evidence: 'e', suggested_fix: 'fix' }],
    prior_findings: [{ id: 'f0', status: 'resolved' }],
    checked: ['diff'], not_checked: ['perf'], tests_run: [{ command: 'npm test', exit: 0 }],
  }) as Record<string, any>;
  assert.deepEqual(Object.keys(out).sort(), ['checked', 'findings', 'notChecked', 'priorFindings', 'testsRun', 'verdict']);
  assert.equal(out.findings[0].suggestedFix, 'fix');
  assert.equal(out.findings[0].suggested_fix, undefined);
});

test('reviewToDaemon leaves non-objects for the daemon validator to reject', () => {
  assert.equal(reviewToDaemon('nope'), 'nope');
  assert.equal(reviewToDaemon(undefined), undefined);
});

test('enqueue schema advertises review and stays within the 4 KB budget; stage decide enumerates actions', () => {
  assert.ok('review' in (MESH_ENQUEUE_TASK_TOOL.inputSchema.properties as Record<string, unknown>));
  assert.ok(JSON.stringify(MESH_ENQUEUE_TASK_TOOL).length <= 4000, 'enqueue schema over budget');
  assert.deepEqual((MESH_TASK_STAGE_DECIDE_TOOL.inputSchema.properties.action as { enum: string[] }).enum, ['accept', 'revise_once', 'rereview', 'abandon']);
});

import { foldStageChildren } from '../src/tools/stage-queue-fold.js';
test('mesh_view_queue folds review children under their parent', () => {
  const rows = [
    { id: 'p', status: 'assigned', stagePlan: { maxRevisions: 2 }, stageState: { phase: 'reviewing', round: 2, lastVerdict: 'changes_requested', openFindingIds: ['f1'], reviewTaskIds: ['c1', 'c2'] } },
    { id: 'c1', status: 'completed', origin: 'stage', parentTaskId: 'p', stageRole: 'review', stageRound: 1 },
    { id: 'c2', status: 'assigned', origin: 'stage', parentTaskId: 'p', stageRole: 'review', stageRound: 2 },
    { id: 'plain', status: 'pending' },
  ];
  const folded = foldStageChildren(rows);
  assert.deepEqual(folded.map(r => r.id), ['p', 'plain']);
  assert.deepEqual(folded[0].stage, { phase: 'reviewing', round: 2, maxRevisions: 2, lastVerdict: 'changes_requested', openFindings: 1, reviewTaskIds: ['c1', 'c2'] });
  assert.equal((folded[1] as { stage?: unknown }).stage, undefined);
  assert.deepEqual(foldStageChildren(rows, true).map(r => r.id), ['p', 'c1', 'c2', 'plain']);
});
