import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_MESH_TOOL_NAMES, CANONICAL_MESH_TOOL_COUNT } from '@adhdev/daemon-core';
import { ALL_MESH_TOOLS, MESH_ADD_NODE_TOOL, MESH_CLEANUP_SESSIONS_TOOL, MESH_CREATE_TOOL, MESH_ENQUEUE_TASK_TOOL, MESH_FAST_FORWARD_NODE_TOOL, MESH_LAUNCH_SESSION_TOOL, MESH_PLAN_ONBOARDING_TOOL, MESH_READ_CHAT_TOOL, MESH_READ_DEBUG_TOOL, MESH_REMOVE_NODE_TOOL, MESH_REQUEUE_HELD_EVENTS_TOOL, MESH_SEND_TASK_TOOL, MESH_STATUS_TOOL, MESH_VIEW_QUEUE_TOOL, MESH_MISSION_UPSERT_TOOL } from '../src/tools/mesh-tools.js';
import { MESH_ENQUEUE_BATCH_TOOL } from '../src/tools/mesh-tool-schemas.js';

test('ALL_MESH_TOOLS is exactly the canonical mesh tool registry (6-6 consistency)', () => {
  const published = ALL_MESH_TOOLS.map(tool => tool.name).sort();
  const canonical = [...CANONICAL_MESH_TOOL_NAMES].sort();
  // Set-equality: every published tool is canonical, every canonical tool is published.
  assert.deepEqual(published, canonical);
  assert.equal(ALL_MESH_TOOLS.length, CANONICAL_MESH_TOOL_COUNT);
  // No duplicate names in the published surface.
  assert.equal(new Set(published).size, published.length);
});

test('mesh_requeue_held_events schema exposes the event_held requeue surface', () => {
  assert.equal(MESH_REQUEUE_HELD_EVENTS_TOOL.name, 'mesh_requeue_held_events');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_requeue_held_events'), true);
  assert.equal(CANONICAL_MESH_TOOL_NAMES.includes('mesh_requeue_held_events' as any), true);
  const filter = (MESH_REQUEUE_HELD_EVENTS_TOOL.inputSchema.properties as any).filter;
  assert.equal(filter.type, 'object');
  assert.equal(filter.properties.task_id.type, 'string');
  assert.equal(filter.properties.node_id.type, 'string');
  assert.equal(filter.properties.event.type, 'string');
  assert.equal(filter.properties.reason.type, 'string');
  assert.equal(filter.properties.since.type, 'string');
});

test('mesh_fast_forward_node schema registers the safe direct fast-forward surface', () => {
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.name, 'mesh_fast_forward_node');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_fast_forward_node'), true);
  assert.deepEqual(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.required, ['node_id']);
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.execute.type, 'boolean');
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.dry_run.type, 'boolean');
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.update_submodules.type, 'boolean');
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.mode.type, 'string');
  assert.deepEqual(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.mode.enum, ['merge', 'push']);
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.push_submodules.type, 'boolean');
  // push mode is strict ff-only: force-push/rebase/reset/clean remain forbidden.
  assert.match(MESH_FAST_FORWARD_NODE_TOOL.description, /Never force-pushes, rebases, resets, cleans/);
});

test('mesh_enqueue_task schema exposes optional capability tag requirements', () => {
  assert.equal(MESH_ENQUEUE_TASK_TOOL.name, 'mesh_enqueue_task');
  assert.equal(MESH_ENQUEUE_TASK_TOOL.inputSchema.properties.requiredTags.type, 'array');
  assert.equal(MESH_ENQUEUE_TASK_TOOL.inputSchema.properties.required_tags.type, 'array');
  assert.match(MESH_ENQUEUE_TASK_TOOL.inputSchema.properties.requiredTags.description, /provider=codex-cli/);
});

test('mesh_launch_session schema maps providers, keeps type optional, and has no claude default', () => {
  const description = `${MESH_LAUNCH_SESSION_TOOL.description} ${MESH_LAUNCH_SESSION_TOOL.inputSchema.properties.type.description}`;

  assert.match(description, /Hermes\s*=\s*hermes-cli|Hermes.*hermes-cli/);
  assert.deepEqual(MESH_LAUNCH_SESSION_TOOL.inputSchema.required, ['node_id']);
  assert.match(description, /Do not default to claude-cli/);
  assert.doesNotMatch(description, /default to claude-cli unless/i);
});

test('mesh_read_chat schema exposes provider_session_id and compact mode for completed session history', () => {
  assert.equal(MESH_READ_CHAT_TOOL.inputSchema.properties.provider_session_id.type, 'string');
  assert.equal(MESH_READ_CHAT_TOOL.inputSchema.properties.compact.type, 'boolean');
  assert.match(MESH_READ_CHAT_TOOL.description, /compact=true/);
});

test('mesh_status and mesh_view_queue schemas expose compact/verbose payload controls', () => {
  assert.equal((MESH_STATUS_TOOL.inputSchema.properties as any).compact.type, 'boolean');
  assert.equal((MESH_STATUS_TOOL.inputSchema.properties as any).verbose.type, 'boolean');
  assert.match((MESH_STATUS_TOOL.inputSchema.properties as any).compact.description, /Default true/);

  assert.equal((MESH_VIEW_QUEUE_TOOL.inputSchema.properties as any).compact.type, 'boolean');
  assert.equal((MESH_VIEW_QUEUE_TOOL.inputSchema.properties as any).verbose.type, 'boolean');
  assert.match((MESH_VIEW_QUEUE_TOOL.inputSchema.properties as any).compact.description, /Default true/);
});

test('mesh_create / mesh_add_node bootstrap tools are published for MCP-only mesh creation', () => {
  // Exposed in ALL_MESH_TOOLS (so mesh-mode list-tools advertises them) and canonical.
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_create'), true);
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_add_node'), true);
  assert.equal(CANONICAL_MESH_TOOL_NAMES.includes('mesh_create' as any), true);
  assert.equal(CANONICAL_MESH_TOOL_NAMES.includes('mesh_add_node' as any), true);

  // mesh_create: requires name, accepts either repo identity source.
  assert.equal(MESH_CREATE_TOOL.name, 'mesh_create');
  assert.deepEqual(MESH_CREATE_TOOL.inputSchema.required, ['name']);
  assert.equal((MESH_CREATE_TOOL.inputSchema.properties as any).repo_remote_url.type, 'string');
  assert.equal((MESH_CREATE_TOOL.inputSchema.properties as any).repo_identity.type, 'string');
  assert.equal((MESH_CREATE_TOOL.inputSchema.properties as any).add_current.type, 'boolean');

  // mesh_add_node: requires workspace, mesh_id optional (defaults to active mesh in mesh mode).
  assert.equal(MESH_ADD_NODE_TOOL.name, 'mesh_add_node');
  assert.deepEqual(MESH_ADD_NODE_TOOL.inputSchema.required, ['workspace']);
  assert.equal((MESH_ADD_NODE_TOOL.inputSchema.properties as any).mesh_id.type, 'string');
  assert.equal((MESH_ADD_NODE_TOOL.inputSchema.properties as any).read_only.type, 'boolean');
  assert.equal((MESH_ADD_NODE_TOOL.inputSchema.properties as any).provider_priority.type, 'array');
});

test('mesh_plan_onboarding is a read-only Git-aware preflight shared by bootstrap tools', () => {
  assert.equal(MESH_PLAN_ONBOARDING_TOOL.name, 'mesh_plan_onboarding');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_plan_onboarding'), true);
  assert.equal(CANONICAL_MESH_TOOL_NAMES.includes('mesh_plan_onboarding' as any), true);
  assert.deepEqual(MESH_PLAN_ONBOARDING_TOOL.inputSchema.required, ['workspace']);
  assert.deepEqual((MESH_PLAN_ONBOARDING_TOOL.inputSchema.properties as any).operation.enum, [
    'auto',
    'add_existing',
    'clone_worktree',
    'create_mesh',
  ]);
  assert.match(MESH_PLAN_ONBOARDING_TOOL.description, /never fetches, writes config, creates/i);
});

test('mesh session cleanup tools expose explicit manual cleanup and remove-node policy override', () => {
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.name, 'mesh_cleanup_sessions');
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.mode.enum.includes('delete_stopped'), true);
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.mode.enum.includes('stop_and_delete'), true);
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.dry_run.type, 'boolean');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_cleanup_sessions'), true);

  assert.equal(MESH_REMOVE_NODE_TOOL.inputSchema.properties.session_cleanup_mode.enum.includes('preserve'), true);
  assert.match(MESH_REMOVE_NODE_TOOL.description, /sessionCleanupOnNodeRemove/);
});

// ─── H1 (path ownership) + H2 (mission brief) schema-only additions ───
// (wiring-unification Phase H, docs/design/2026-09-23-wiring-unification.md §7c)

test('mesh_enqueue_task schema exposes owned_paths and its camelCase alias, both optional', () => {
  const props = MESH_ENQUEUE_TASK_TOOL.inputSchema.properties as any;
  assert.equal(props.owned_paths.type, 'array');
  assert.equal(props.owned_paths.items.type, 'string');
  assert.equal(props.ownedPaths.type, 'array');
  assert.equal(props.ownedPaths.items.type, 'string');
  assert.equal(MESH_ENQUEUE_TASK_TOOL.inputSchema.required.includes('owned_paths'), false);
  assert.equal(MESH_ENQUEUE_TASK_TOOL.inputSchema.required.includes('ownedPaths'), false);
  assert.match(props.owned_paths.description, /code_change/);
  assert.match(props.owned_paths.description, /owned_paths_conflict/);
});

test('mesh_enqueue_batch per-task schema exposes owned_paths and its camelCase alias', () => {
  const itemProps = (MESH_ENQUEUE_BATCH_TOOL.inputSchema.properties as any).tasks.items.properties;
  assert.equal(itemProps.owned_paths.type, 'array');
  assert.equal(itemProps.owned_paths.items.type, 'string');
  assert.equal(itemProps.ownedPaths.type, 'array');
  assert.equal(itemProps.ownedPaths.items.type, 'string');
  // Per-task required list is unchanged (still message + difficulty only).
  assert.deepEqual(MESH_ENQUEUE_BATCH_TOOL.inputSchema.properties.tasks.items.required, ['message', 'difficulty']);
});

test('mesh_send_task schema exposes owned_paths and its camelCase alias, required list unchanged', () => {
  const props = MESH_SEND_TASK_TOOL.inputSchema.properties as any;
  assert.equal(props.owned_paths.type, 'array');
  assert.equal(props.owned_paths.items.type, 'string');
  assert.equal(props.ownedPaths.type, 'array');
  // node_id/message/difficulty stays the required set — owned_paths never becomes mandatory.
  assert.deepEqual(MESH_SEND_TASK_TOOL.inputSchema.required, ['node_id', 'message', 'difficulty']);
});

test('mesh_mission_upsert schema exposes an optional structured brief object with the H2 fields', () => {
  const brief = (MESH_MISSION_UPSERT_TOOL.inputSchema.properties as any).brief;
  assert.equal(brief.type, 'object');
  assert.equal(brief.properties.goal.type, 'string');
  assert.equal(brief.properties.constraints.type, 'array');
  assert.equal(brief.properties.constraints.items.type, 'string');
  assert.equal(brief.properties.doneCriteria.type, 'array');
  assert.equal(brief.properties.handoffNotes.type, 'array');
  assert.equal(brief.properties.ownedPaths.type, 'array');
  // brief is optional at the tool level — mesh_mission_upsert's required list stays [].
  assert.deepEqual(MESH_MISSION_UPSERT_TOOL.inputSchema.required, []);
  // brief.goal is documented as required-for-storage in prose (not JSON-schema `required`,
  // since normalizeMissionBrief treats a goal-less object as "no brief" rather than erroring).
  assert.match(brief.description, /goal \(required/);
});
