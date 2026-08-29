import assert from 'node:assert/strict';
import test from 'node:test';

// Imported from cli-args, NOT index: index.ts boots a stdio server at module load.
import { parseArgs } from '../src/cli-args.js';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import {
  ALL_WORKER_TOOLS,
  readWorkerCredentials,
  reportCompletion,
  progressUpdate,
} from '../src/tools/worker-tools.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

// ─── Mode selection ───────────────────────────────────────────────────────

test('--worker selects worker mode', () => {
  const parsed = parseArgs(['node', 'idx', '--mode', 'ipc', '--worker'], EMPTY_ENV);
  assert.equal(parsed.worker, true);
  assert.equal(parsed.mode, 'ipc');
});

test('worker mode DROPS a meshId so a worker can never reach the coordinator toolset', () => {
  // A worker inherits its workspace's config files. A repo carrying --repo-mesh
  // in a committed .mcp.json would otherwise hand the worker all 60 coordinator
  // tools — the exact inheritance this feature exists to remove.
  const parsed = parseArgs(['node', 'idx', '--repo-mesh', 'mesh_abc', '--worker'], EMPTY_ENV);
  assert.equal(parsed.worker, true);
  assert.equal(parsed.meshId, undefined);

  // Same via the env-var route into meshId.
  const viaEnv = parseArgs(['node', 'idx', '--worker'], { ADHDEV_MESH_ID: 'mesh_abc' } as NodeJS.ProcessEnv);
  assert.equal(viaEnv.meshId, undefined);
});

test('without --worker the mesh path is untouched', () => {
  const parsed = parseArgs(['node', 'idx', '--repo-mesh', 'mesh_abc'], EMPTY_ENV);
  assert.equal(parsed.worker, undefined);
  assert.equal(parsed.meshId, 'mesh_abc');
});

// ─── Toolset shape (design §3) ────────────────────────────────────────────

test('the worker toolset is minimal and shares NO tool name with mesh mode', () => {
  const meshNames = new Set(ALL_MESH_TOOLS.map(t => t.name));
  for (const tool of ALL_WORKER_TOOLS) {
    assert.ok(!meshNames.has(tool.name), `worker tool ${tool.name} must not be a mesh tool`);
  }
  assert.deepEqual(ALL_WORKER_TOOLS.map(t => t.name).sort(), ['peer_context_pull', 'progress_update', 'report_completion']);
});

test('no worker tool takes a task id — attribution is never caller-supplied', () => {
  // A worker that supplies its own task id can supply the wrong one, which is
  // the misattribution family the token exists to close (design §4).
  for (const tool of ALL_WORKER_TOOLS) {
    const props = Object.keys(tool.inputSchema.properties ?? {});
    for (const forbidden of ['task_id', 'taskId', 'attempt_id', 'attemptId', 'session_id', 'sessionId']) {
      assert.ok(!props.includes(forbidden), `${tool.name} must not accept ${forbidden}`);
    }
  }
});

test('report_completion requires outcome and summary, and enumerates the branch states', () => {
  const schema = ALL_WORKER_TOOLS.find(t => t.name === 'report_completion')!.inputSchema;
  assert.deepEqual(schema.required, ['outcome', 'summary']);
  const props = schema.properties as Record<string, any>;
  assert.deepEqual(props.outcome.enum, ['completed', 'blocked', 'failed']);
  assert.ok(props.branch_state.enum.includes('pushed_feature_branch_needs_merge'));
  // handoff_notes carries its own required pair.
  assert.deepEqual(props.handoff_notes.required, ['intent', 'touched_files']);
});

// ─── Credentials ──────────────────────────────────────────────────────────

test('credentials are read from the env the MCP config supplied', () => {
  assert.deepEqual(readWorkerCredentials(EMPTY_ENV), {});
  assert.deepEqual(
    readWorkerCredentials({ ADHDEV_WORKER_SESSION_BIND: ' wsb_abc ' } as NodeJS.ProcessEnv),
    { bind: 'wsb_abc' },
  );
  assert.deepEqual(
    readWorkerCredentials({ ADHDEV_WORKER_TASK_TOKEN: 'wtk_x' } as NodeJS.ProcessEnv),
    { token: 'wtk_x' },
  );
});

// ─── Wire shape + result rendering ────────────────────────────────────────

function fakeTransport(reply: any, capture?: { last?: any }) {
  return {
    async command(_type: string, args: any) {
      if (capture) capture.last = args;
      return reply;
    },
    async ping() { return true; },
  } as any;
}

test('report_completion translates the snake_case wire shape to the daemon report', async () => {
  const capture: { last?: any } = {};
  await reportCompletion(fakeTransport({ success: true, taskId: 't1', outcome: 'completed' }, capture), { bind: 'wsb_x' }, {
    outcome: 'completed',
    summary: 'done',
    branch_state: 'merged_to_main',
    touched_files: ['a.ts'],
    handoff_notes: { intent: 'why', touched_files: ['a.ts'], conflict_guidance: 'keep mine', follow_ups: ['later'] },
  });

  assert.equal(capture.last.bind, 'wsb_x');
  assert.deepEqual(capture.last.report, {
    outcome: 'completed',
    summary: 'done',
    touchedFiles: ['a.ts'],
    branchState: 'merged_to_main',
    handoffNotes: {
      intent: 'why',
      conflictGuidance: 'keep mine',
      touchedFiles: ['a.ts'],
      followUps: ['later'],
    },
  });
});

test('validation errors come back field-by-field so the worker can fix and re-call', async () => {
  const result = await reportCompletion(
    fakeTransport({
      success: false,
      error: 'invalid_report',
      validationErrors: [{ field: 'summary', message: 'summary is required' }],
    }),
    { bind: 'wsb_x' },
    { outcome: 'completed' },
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /summary: summary is required/);
});

test('a refusal surfaces the reason and the hint rather than reading as success', async () => {
  const result = await reportCompletion(
    fakeTransport({ success: false, error: 'unauthenticated', hint: 'No live task is bound.' }),
    { bind: 'wsb_x' },
    { outcome: 'completed', summary: 'x' },
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /unauthenticated/);
  assert.match(result.text, /No live task is bound/);
});

test('a duplicate report is reported as accepted, not as a failure', async () => {
  const result = await reportCompletion(
    fakeTransport({ success: true, taskId: 't1', outcome: 'completed', duplicate: true }),
    { bind: 'wsb_x' },
    { outcome: 'completed', summary: 'x' },
  );
  assert.equal(result.isError, undefined);
  assert.match(result.text, /duplicate/);
});

test('progress_update refuses an empty note without calling the daemon', async () => {
  const capture: { last?: any } = {};
  const result = await progressUpdate(fakeTransport({ success: true }, capture), { bind: 'wsb_x' }, { note: '   ' });
  assert.equal(result.isError, true);
  assert.equal(capture.last, undefined);
});
