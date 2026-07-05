import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_MESH_TOOL_NAMES, CANONICAL_MESH_TOOL_COUNT } from '@adhdev/daemon-core';
import { ALL_MESH_TOOLS, MESH_CLEANUP_SESSIONS_TOOL, MESH_ENQUEUE_TASK_TOOL, MESH_FAST_FORWARD_NODE_TOOL, MESH_LAUNCH_SESSION_TOOL, MESH_READ_CHAT_TOOL, MESH_READ_DEBUG_TOOL, MESH_REMOVE_NODE_TOOL, MESH_REQUEUE_HELD_EVENTS_TOOL, MESH_STATUS_TOOL, MESH_VIEW_QUEUE_TOOL } from '../src/tools/mesh-tools.js';

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

test('mesh session cleanup tools expose explicit manual cleanup and remove-node policy override', () => {
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.name, 'mesh_cleanup_sessions');
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.mode.enum.includes('delete_stopped'), true);
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.mode.enum.includes('stop_and_delete'), true);
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.dry_run.type, 'boolean');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_cleanup_sessions'), true);

  assert.equal(MESH_REMOVE_NODE_TOOL.inputSchema.properties.session_cleanup_mode.enum.includes('preserve'), true);
  assert.match(MESH_REMOVE_NODE_TOOL.description, /sessionCleanupOnNodeRemove/);
});
