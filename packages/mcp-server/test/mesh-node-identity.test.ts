import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCoordinatorNode } from '../src/tools/mesh-node-identity.js';
import type { MeshContext } from '../src/tools/mesh-tools.js';

// isConfiguredCoordinatorNode (same file) has always accepted both
// `preferredNodeId` and the snake_case `preferred_node_id` alias on
// mesh.coordinator. resolveCoordinatorNode read only the camelCase form, so a
// mesh.coordinator populated via the snake alias resolved differently depending
// on which of the two helpers was asked — this pins that both now agree.

function makeCtx(overrides: Partial<MeshContext> & { coordinator?: any; nodes: any[] }): MeshContext {
  return {
    mesh: {
      id: 'mesh-1',
      name: 'mesh-1',
      coordinator: overrides.coordinator,
      nodes: overrides.nodes,
    } as any,
    transport: {} as any,
    ...overrides,
  } as MeshContext;
}

test('resolveCoordinatorNode resolves via camelCase preferredNodeId', () => {
  const ctx = makeCtx({
    coordinator: { preferredNodeId: 'node-a' },
    nodes: [{ id: 'node-a', daemonId: 'daemon_mach_abc' }, { id: 'node-b', daemonId: 'daemon_mach_def' }],
  });
  const node = resolveCoordinatorNode(ctx);
  assert.equal(node?.id, 'node-a');
});

test('resolveCoordinatorNode resolves via snake_case preferred_node_id alias (break-once: pre-fix this returned undefined and fell through to machine/daemon fallback)', () => {
  const ctx = makeCtx({
    coordinator: { preferred_node_id: 'node-a' },
    nodes: [{ id: 'node-a', daemonId: 'daemon_mach_abc' }, { id: 'node-b', daemonId: 'daemon_mach_def' }],
  });
  const node = resolveCoordinatorNode(ctx);
  assert.equal(node?.id, 'node-a');
});

test('resolveCoordinatorNode falls back to localDaemonId under id-form equivalence when no preferred node is set', () => {
  const ctx = makeCtx({
    coordinator: {},
    localDaemonId: 'mach_abc',
    nodes: [{ id: 'node-a', daemonId: 'daemon_mach_abc' }, { id: 'node-b', daemonId: 'daemon_mach_def' }],
  });
  const node = resolveCoordinatorNode(ctx);
  assert.equal(node?.id, 'node-a');
});
