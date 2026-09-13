/**
 * MCP behavior-annotation coverage and correctness.
 *
 * Two distinct jobs here, and the first is the one that actually keeps this
 * honest over time:
 *
 * 1. COVERAGE — every tool the server can publish, in every mode, carries all
 *    four hints. This is the regression that a per-tool inline literal cannot
 *    catch: a tool added without annotations looks identical to one that was
 *    deliberately considered. Here it fails the suite by name.
 *
 * 2. CORRECTNESS — spot-checks that the classification says what the tool
 *    actually does, plus invariants that hold across the whole registry (a
 *    read-only tool cannot be destructive, etc.). These are the assertions that
 *    would go wrong if someone bulk-edited the map without reading it.
 *
 * The values are hints, not enforcement — a client uses them to decide whether
 * to prompt before running something. That is exactly why a WRONG hint is worse
 * than a missing one, and why the destructive spot-checks below name tools
 * whose default is a safe dry-run but whose capability is not.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL } from '../src/tools/mesh-tools.js';
import { ALL_WORKER_TOOLS } from '../src/tools/worker-tools.js';
import {
  TOOL_ANNOTATIONS,
  annotateAll,
  findUnannotatedTools,
  withAnnotations,
} from '../src/tools/tool-annotations.js';

import { LIST_DAEMONS_TOOL } from '../src/tools/list-daemons.js';
import { LIST_SESSIONS_TOOL } from '../src/tools/list-sessions.js';
import { LAUNCH_SESSION_TOOL } from '../src/tools/launch-session.js';
import { STOP_SESSION_TOOL } from '../src/tools/stop-session.js';
import { CHECK_PENDING_TOOL } from '../src/tools/check-pending.js';
import { READ_CHAT_TOOL } from '../src/tools/read-chat.js';
import { READ_CHAT_DEBUG_TOOL } from '../src/tools/read-chat-debug.js';
import { SPEC_DEBUG_TOOL } from '../src/tools/spec-debug.js';
import { SEND_CHAT_TOOL } from '../src/tools/send-chat.js';
import { APPROVE_TOOL } from '../src/tools/approve.js';
import { SCREENSHOT_TOOL } from '../src/tools/screenshot.js';
import { GIT_STATUS_TOOL } from '../src/tools/git-status.js';
import { GIT_LOG_TOOL } from '../src/tools/git-log.js';
import { GIT_DIFF_TOOL } from '../src/tools/git-diff.js';
import { GIT_CHECKPOINT_TOOL } from '../src/tools/git-checkpoint.js';
import { GIT_PUSH_TOOL } from '../src/tools/git-push.js';

/**
 * Every tool definition the server can publish, across all three modes.
 * Standard mode builds its list inline in server.ts, so it is reproduced here
 * from the same consts — including SCREENSHOT_TOOL, which server.ts publishes
 * only in local mode.
 */
const STANDARD_MODE_TOOLS = [
  LIST_DAEMONS_TOOL, LIST_SESSIONS_TOOL, LAUNCH_SESSION_TOOL, STOP_SESSION_TOOL,
  CHECK_PENDING_TOOL, READ_CHAT_TOOL, READ_CHAT_DEBUG_TOOL, SPEC_DEBUG_TOOL,
  SEND_CHAT_TOOL, APPROVE_TOOL, GIT_STATUS_TOOL, GIT_LOG_TOOL, GIT_DIFF_TOOL,
  GIT_CHECKPOINT_TOOL, GIT_PUSH_TOOL, SCREENSHOT_TOOL,
];

const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

test('every published mesh tool carries all four behavior hints', () => {
  assert.ok(ALL_MESH_TOOLS.length > 0, 'registry must not be empty');
  for (const tool of ALL_MESH_TOOLS) {
    const annotations = (tool as any).annotations;
    assert.ok(annotations, `${tool.name} has no annotations`);
    for (const key of HINT_KEYS) {
      assert.equal(typeof annotations[key], 'boolean', `${tool.name}.${key} must be a boolean`);
    }
  }
});

test('every published worker tool carries all four behavior hints', () => {
  assert.equal(ALL_WORKER_TOOLS.length, 3);
  for (const tool of ALL_WORKER_TOOLS) {
    const annotations = (tool as any).annotations;
    assert.ok(annotations, `${tool.name} has no annotations`);
    for (const key of HINT_KEYS) {
      assert.equal(typeof annotations[key], 'boolean', `${tool.name}.${key} must be a boolean`);
    }
  }
});

test('every standard-mode tool is classified', () => {
  // server.ts wraps this list in annotateAll(), which throws on an unclassified
  // tool — so an omission here is a startup crash, not a silent hint-less tool.
  assert.deepEqual(findUnannotatedTools(STANDARD_MODE_TOOLS), []);
});

test('the flag-gated mesh_notify_worker tool is classified', () => {
  // Published only when the worker-MCP flag is on, so it is absent from
  // ALL_MESH_TOOLS and would escape the registry sweep above.
  assert.deepEqual(findUnannotatedTools([MESH_NOTIFY_WORKER_TOOL]), []);
});

test('an unclassified tool throws rather than publishing with no hints', () => {
  assert.throws(
    () => withAnnotations({ name: 'totally_new_tool_nobody_classified' }),
    /has no entry in TOOL_ANNOTATIONS/,
  );
});

test('annotating does not mutate the shared tool const', () => {
  // The *_TOOL consts are module singletons published by more than one mode
  // (GIT_STATUS_TOOL appears in both standard and worker mode), so annotateAll
  // must copy rather than mutate.
  const [annotated] = annotateAll([GIT_STATUS_TOOL]);
  assert.ok(annotated.annotations, 'returned copy carries annotations');
  assert.equal((GIT_STATUS_TOOL as any).annotations, undefined, 'original const stays untouched');
  assert.equal(annotated.name, GIT_STATUS_TOOL.name);
  assert.equal(annotated.description, GIT_STATUS_TOOL.description);
});

test('annotations never contradict themselves', () => {
  for (const [name, annotations] of Object.entries(TOOL_ANNOTATIONS)) {
    if (annotations.readOnlyHint) {
      // A tool that modifies nothing cannot destroy anything, and repeating a
      // read cannot have an additional effect.
      assert.equal(annotations.destructiveHint, false, `${name}: read-only but marked destructive`);
      assert.equal(annotations.idempotentHint, true, `${name}: read-only but marked non-idempotent`);
    }
  }
});

test('read-only mesh inspection tools are marked read-only and non-destructive', () => {
  const readOnly = [
    'mesh_status', 'mesh_list_nodes', 'mesh_route_preview', 'mesh_view_queue',
    'mesh_graph_view', 'mesh_read_chat', 'mesh_read_terminal', 'mesh_read_node_logs',
    'mesh_git_status', 'mesh_task_history', 'mesh_ledger_query', 'mesh_mission_list',
    'mesh_review_inbox', 'mesh_list_pending_approvals', 'mesh_node_slots_list',
    'mesh_refine_config', 'mesh_change_impact_config', 'mesh_plan_onboarding',
    'mesh_refine_plan', 'mesh_coordinator_prompt_append_get', 'mesh_magi_kind_panel_list',
  ];
  for (const name of readOnly) {
    const annotations = TOOL_ANNOTATIONS[name];
    assert.ok(annotations, `${name} missing from TOOL_ANNOTATIONS`);
    assert.equal(annotations.readOnlyHint, true, `${name} should be read-only`);
    assert.equal(annotations.destructiveHint, false, `${name} should not be destructive`);
  }
});

test('destructive tools are marked destructive even when they default to dry-run', () => {
  // The point of the hint is capability, not default. Each of these returns a
  // plan unless given execute/dry_run:false — and then merges, pushes, deletes
  // or restarts for real.
  const dryRunByDefault = ['mesh_refine_node', 'mesh_refine_batch', 'mesh_fast_forward_node', 'mesh_prune_stale_direct'];
  for (const name of dryRunByDefault) {
    const annotations = TOOL_ANNOTATIONS[name];
    assert.ok(annotations, `${name} missing from TOOL_ANNOTATIONS`);
    assert.equal(annotations.readOnlyHint, false, `${name} can execute, so it is not read-only`);
    assert.equal(annotations.destructiveHint, true, `${name} can destroy/overwrite state`);
  }
});

test('state-removing tools are marked destructive', () => {
  const destructive = [
    'mesh_queue_cancel', 'mesh_remove_node', 'mesh_cleanup_worktree_nodes',
    'mesh_cleanup_sessions', 'mesh_restart_daemon', 'mesh_forget_note',
    'mesh_graph_gate_abandon', 'mesh_reinit', 'mesh_write_mesh_json_config',
    'stop_session', 'git_push',
  ];
  for (const name of destructive) {
    const annotations = TOOL_ANNOTATIONS[name];
    assert.ok(annotations, `${name} missing from TOOL_ANNOTATIONS`);
    assert.equal(annotations.destructiveHint, true, `${name} should be destructive`);
    assert.equal(annotations.readOnlyHint, false, `${name} should not be read-only`);
  }
});

test('agent-spawning tools are open-world and not idempotent', () => {
  // Calling one of these twice runs the work twice — the single most important
  // thing for a client not to retry blindly after a timeout.
  const dispatch = ['mesh_enqueue_task', 'mesh_enqueue_batch', 'mesh_send_task', 'mesh_launch_session', 'mesh_magi_review', 'launch_session'];
  for (const name of dispatch) {
    const annotations = TOOL_ANNOTATIONS[name];
    assert.ok(annotations, `${name} missing from TOOL_ANNOTATIONS`);
    assert.equal(annotations.openWorldHint, true, `${name} spawns external agents`);
    assert.equal(annotations.idempotentHint, false, `${name} repeats the work when called again`);
    assert.equal(annotations.readOnlyHint, false, `${name} is not read-only`);
  }
});

test('purely local reads are not marked open-world', () => {
  // Distinguishes "reads this daemon's own ledger/config" from "crosses to
  // another machine". Over-reporting open-world would make the hint useless.
  for (const name of ['mesh_list_nodes', 'mesh_route_preview', 'mesh_task_history', 'mesh_ledger_query', 'git_status', 'git_log', 'git_diff', 'list_sessions']) {
    const annotations = TOOL_ANNOTATIONS[name];
    assert.ok(annotations, `${name} missing from TOOL_ANNOTATIONS`);
    assert.equal(annotations.openWorldHint, false, `${name} stays local`);
  }
});

test('additive writes explicitly opt out of the destructive default', () => {
  // MCP defaults destructiveHint to true for a non-read-only tool, so these
  // must state false rather than omit it.
  for (const name of ['mesh_requeue_held_events', 'mesh_mission_upsert', 'mesh_reconcile_ledger', 'mesh_record_note', 'mesh_node_slots_set', 'git_checkpoint']) {
    const annotations = TOOL_ANNOTATIONS[name];
    assert.ok(annotations, `${name} missing from TOOL_ANNOTATIONS`);
    assert.equal(annotations.readOnlyHint, false, `${name} writes`);
    assert.equal(annotations.destructiveHint, false, `${name} is additive, not destructive`);
  }
});

test('report_completion is idempotent and progress_update is not', () => {
  // The daemon reports a duplicate completion as accepted rather than as a
  // failure, so a retry is safe. A second progress note is a second note.
  assert.equal(TOOL_ANNOTATIONS.report_completion.idempotentHint, true);
  assert.equal(TOOL_ANNOTATIONS.progress_update.idempotentHint, false);
  assert.equal(TOOL_ANNOTATIONS.peer_context_pull.readOnlyHint, true);
});

test('no classification exists for a tool that is not published anywhere', () => {
  // Guards the other direction: a stale entry for a deleted tool is dead weight
  // that makes the map look more complete than it is.
  const published = new Set<string>([
    ...ALL_MESH_TOOLS.map(t => t.name),
    ...ALL_WORKER_TOOLS.map(t => t.name),
    ...STANDARD_MODE_TOOLS.map(t => t.name),
    MESH_NOTIFY_WORKER_TOOL.name,
  ]);
  const orphans = Object.keys(TOOL_ANNOTATIONS).filter(name => !published.has(name));
  assert.deepEqual(orphans, [], 'TOOL_ANNOTATIONS has entries for tools nothing publishes');
});
