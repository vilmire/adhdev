import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_MESH_TOOLS, MESH_ROUTE_PREVIEW_TOOL, meshRoutePreview, type MeshContext } from '../src/tools/mesh-tools.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

test('mesh_route_preview publishes the required hypothetical-routing schema', () => {
  assert.equal(MESH_ROUTE_PREVIEW_TOOL.name, 'mesh_route_preview');
  assert.deepEqual(MESH_ROUTE_PREVIEW_TOOL.inputSchema.required, ['difficulty']);
  assert.deepEqual(MESH_ROUTE_PREVIEW_TOOL.inputSchema.properties.difficulty.enum, ['easy', 'medium', 'difficult', 'freeform']);
  for (const property of ['required_tags', 'readonly', 'target_node_id']) {
    assert.ok(property in MESH_ROUTE_PREVIEW_TOOL.inputSchema.properties, `${property} missing`);
  }
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_route_preview'), true);
});

// The handler (mesh-tools-route-preview.ts) always read camelCase requiredTags/
// targetNodeId as aliases, but the schema declared only snake_case — so the
// unknown-arg gate rejected a caller that used the aliases the handler itself
// documents supporting. Pins the schema fix (camelCase properties added).
test('mesh_route_preview schema declares the camelCase requiredTags/targetNodeId aliases the handler reads', () => {
  for (const property of ['requiredTags', 'targetNodeId']) {
    assert.ok(property in MESH_ROUTE_PREVIEW_TOOL.inputSchema.properties, `${property} missing from schema`);
  }
});

test('validateMeshToolArgs: mesh_route_preview accepts the camelCase requiredTags/targetNodeId aliases', () => {
  const err = validateMeshToolArgs('mesh_route_preview', {
    difficulty: 'easy',
    requiredTags: ['reasoning'],
    targetNodeId: 'node-a',
  });
  assert.equal(err, null);
});

test('mesh_route_preview is fetch-free and labels its live-capacity result as a point-in-time snapshot', async () => {
  const commandCalls: Array<{ command: string; args: unknown }> = [];
  const ctx: MeshContext = {
    mesh: {
      id: 'mesh_route_preview',
      name: 'Preview mesh',
      repoIdentity: 'preview/repo',
      policy: {} as any,
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-a',
        workspace: '/preview/node-a',
        userOverrides: {},
        policy: {
          slots: [{ provider: 'codex-cli', model: 'gpt-5.6-sol', difficulty: ['difficult'], maxParallel: 2 }],
        },
      }],
    },
    transport: {
      command: async (command: string, args: unknown) => {
        commandCalls.push({ command, args });
        throw new Error('mesh_route_preview must not call transport.command');
      },
    } as any,
  };

  const result = JSON.parse(await meshRoutePreview(ctx, {
    difficulty: 'difficult',
    required_tags: ['reasoning'],
    readonly: true,
    target_node_id: 'node-a',
  }));

  assert.equal(commandCalls.length, 0);
  assert.equal(result.tool, 'mesh_route_preview');
  assert.equal(result.snapshot.pointInTime, true);
  assert.equal(result.snapshot.writesPerformed, false);
  assert.equal(result.snapshot.quotaFetchPerformed, false);
  assert.match(result.snapshot.warning, /live queue/i);
  assert.ok(Number.isFinite(Date.parse(result.snapshot.observedAt)));
});

test('mesh_route_preview handler accepts camelCase requiredTags/targetNodeId and produces the same result as the snake_case call', async () => {
  const ctx: MeshContext = {
    mesh: {
      id: 'mesh_route_preview',
      name: 'Preview mesh',
      repoIdentity: 'preview/repo',
      policy: {} as any,
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-a',
        workspace: '/preview/node-a',
        userOverrides: {},
        policy: {
          slots: [{ provider: 'codex-cli', model: 'gpt-5.6-sol', difficulty: ['difficult'], maxParallel: 2 }],
        },
      }],
    },
    transport: { command: async () => { throw new Error('must not be called'); } } as any,
  };

  const viaCamel = JSON.parse(await meshRoutePreview(ctx, {
    difficulty: 'difficult',
    requiredTags: ['reasoning'],
    readonly: true,
    targetNodeId: 'node-a',
  } as any));
  const viaSnake = JSON.parse(await meshRoutePreview(ctx, {
    difficulty: 'difficult',
    required_tags: ['reasoning'],
    readonly: true,
    target_node_id: 'node-a',
  }));

  assert.equal(viaCamel.tool, 'mesh_route_preview');
  assert.deepEqual(viaCamel.nodes, viaSnake.nodes);
});
