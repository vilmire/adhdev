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
  assert.ok(JSON.stringify(MESH_ENQUEUE_TASK_TOOL).length <= 4000);
  assert.deepEqual((MESH_TASK_STAGE_DECIDE_TOOL.inputSchema.properties.action as { enum: string[] }).enum, ['accept', 'revise_once', 'rereview', 'abandon']);
});
