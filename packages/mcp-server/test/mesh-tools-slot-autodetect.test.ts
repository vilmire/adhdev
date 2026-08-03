import assert from 'node:assert/strict';
import test from 'node:test';

import { extractInstalledCliProviders, meshNodeSlotsPropose } from '../src/tools/mesh-tools-slot-autodetect.js';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { MESH_NODE_SLOTS_PROPOSE_TOOL } from '../src/tools/mesh-tool-schemas.js';

/** A get_status_metadata-shaped response with the given availableProviders. */
const statusPayload = (availableProviders: unknown[]) => ({ status: { availableProviders } });

const cli = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  category: 'cli',
  installed: true,
  ...extra,
});

// ─── detection extraction ────────────────────────────────────────────────────

test('extracts installed cli providers from a status payload', () => {
  const detected = extractInstalledCliProviders(statusPayload([
    cli('claude-cli', { displayName: 'Claude Code', providerVersion: '2.1.0' }),
    cli('codex-cli'),
  ]));
  assert.deepEqual(detected, [
    { type: 'claude-cli', displayName: 'Claude Code', version: '2.1.0' },
    { type: 'codex-cli' },
  ]);
});

test('excludes non-cli categories — ide/acp/extension are out of scope', () => {
  const detected = extractInstalledCliProviders(statusPayload([
    cli('claude-cli'),
    { type: 'cursor', category: 'ide', installed: true },
    { type: 'some-acp', category: 'acp', installed: true },
    { type: 'some-ext', category: 'extension', installed: true },
  ]));
  assert.deepEqual(detected.map(d => d.type), ['claude-cli']);
});

test('excludes not-installed cli providers', () => {
  const detected = extractInstalledCliProviders(statusPayload([
    cli('claude-cli'),
    { type: 'kimi', category: 'cli', installed: false },
  ]));
  assert.deepEqual(detected.map(d => d.type), ['claude-cli']);
});

test('treats a missing `installed` flag as NOT installed (older daemon payload)', () => {
  // Under-proposing is recoverable; proposing a slot for an absent binary is not.
  const detected = extractInstalledCliProviders(statusPayload([
    { type: 'legacy-cli', category: 'cli' },
  ]));
  assert.deepEqual(detected, []);
});

test('returns [] for malformed / empty payloads instead of throwing', () => {
  for (const bad of [undefined, null, {}, { status: {} }, { status: { availableProviders: 'nope' } }, 42, []]) {
    assert.deepEqual(extractInstalledCliProviders(bad), [], `input: ${JSON.stringify(bad)}`);
  }
});

test('skips entries with a blank or missing type', () => {
  const detected = extractInstalledCliProviders(statusPayload([
    cli(''),
    cli('   '),
    { category: 'cli', installed: true },
    cli('kimi'),
  ]));
  assert.deepEqual(detected.map(d => d.type), ['kimi']);
});

test('reads availableProviders from a top-level payload shape too', () => {
  const detected = extractInstalledCliProviders({ availableProviders: [cli('kimi')] });
  assert.deepEqual(detected.map(d => d.type), ['kimi']);
});

// ─── tool registration ───────────────────────────────────────────────────────

test('mesh_node_slots_propose is published in the tool registry', () => {
  assert.equal(MESH_NODE_SLOTS_PROPOSE_TOOL.name, 'mesh_node_slots_propose');
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_node_slots_propose'), true);
  const props = MESH_NODE_SLOTS_PROPOSE_TOOL.inputSchema.properties as any;
  assert.equal(props.node_id.type, 'string');
  assert.equal(props.include_magi.type, 'boolean');
  assert.deepEqual(MESH_NODE_SLOTS_PROPOSE_TOOL.inputSchema.required, ['node_id']);
});

// ─── tool behavior (stubbed transport) ───────────────────────────────────────

/** A MeshContext stub whose node lookup and command transport are controlled. */
const ctxWith = (node: any, commandResult: unknown) => ({
  mesh: { id: 'mesh_1', name: 'ADHDev', nodes: [node] },
  transport: {
    command: async () => commandResult,
    meshCommand: async () => commandResult,
  },
} as any);

const nodeWith = (slots?: unknown) => ({
  id: 'node_1',
  workspace: '/repo',
  daemonId: 'daemon_1',
  policy: slots === undefined ? {} : { slots },
});

test('requires node_id', async () => {
  const out = JSON.parse(await meshNodeSlotsPropose({} as any, {}));
  assert.equal(out.success, false);
  assert.match(out.error, /node_id required/);
});

test('proposes slots for a bare node and is non-destructive', async () => {
  const ctx = ctxWith(nodeWith(), statusPayload([cli('claude-cli'), cli('codex-cli')]));
  const out = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node_1' }));

  assert.equal(out.success, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.destructive, false);
  assert.deepEqual(out.droppedSlots, []);
  assert.deepEqual(out.detectedCliProviders.map((d: any) => d.type), ['claude-cli', 'codex-cli']);
  // claude-cli contributes two slots (sonnet + opus), codex-cli one.
  assert.equal(out.proposedSlots.length, 3);
  assert.equal(out.rationale.length, 3);
  assert.ok(out.note.includes('PROPOSAL ONLY'));
});

test('surfaces droppedSlots and a destructive warning when it would delete tuning', async () => {
  const existing = [{ provider: 'gemini-cli', model: 'flash', capability: ['docs'] }];
  const ctx = ctxWith(nodeWith(existing), statusPayload([cli('claude-cli')]));
  const out = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node_1' }));

  assert.equal(out.destructive, true);
  assert.deepEqual(out.droppedProviders, ['gemini-cli']);
  assert.equal(out.droppedSlots.length, 1);
  assert.ok(out.warnings.some((w: string) => w.startsWith('DESTRUCTIVE')));
});

test('detecting nothing proposes nothing rather than an empty wipe', async () => {
  const existing = [{ provider: 'claude-cli', model: 'opus' }];
  const ctx = ctxWith(nodeWith(existing), statusPayload([]));
  const out = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node_1' }));

  assert.equal(out.success, true);
  assert.deepEqual(out.proposedSlots, []);
  assert.deepEqual(out.detectedCliProviders, []);
  // The existing profile must be reported back untouched, and the note must say so.
  assert.equal(out.currentSlots.length, 1);
  assert.ok(out.note.includes('would wipe'));
  // No destructive apply path is offered for an empty draft.
  assert.equal(out.destructive, undefined);
});

test('warns about unrecognized and provisional providers', async () => {
  const ctx = ctxWith(nodeWith(), statusPayload([cli('brand-new-cli'), cli('hermes-cli')]));
  const out = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node_1' }));

  assert.ok(out.warnings.some((w: string) => w.includes('brand-new-cli')));
  assert.ok(out.warnings.some((w: string) => w.includes('hermes-cli')));
  assert.ok(out.rationale.some((r: any) => r.unknownProvider === true));
  assert.ok(out.rationale.some((r: any) => r.provisional === true));
});

test('omits the MAGI draft unless include_magi is set', async () => {
  const ctx = ctxWith(nodeWith(), statusPayload([cli('claude-cli'), cli('codex-cli')]));

  const without = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node_1' }));
  assert.equal(without.magiPanelProposal, undefined);

  const withMagi = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node_1', include_magi: true }));
  assert.equal(withMagi.magiPanelProposal.slots.length, 2);
  // One slot per distinct provider, pinned to the node, models unpinned.
  assert.deepEqual(withMagi.magiPanelProposal.slots.map((s: any) => s.provider), ['claude-cli', 'codex-cli']);
  assert.ok(withMagi.magiPanelProposal.slots.every((s: any) => s.nodeId === 'node_1'));
  assert.ok(withMagi.magiPanelProposal.slots.every((s: any) => s.model === undefined));
});

test('reports detection_unavailable when the node probe fails', async () => {
  const ctx = {
    mesh: { id: 'mesh_1', name: 'ADHDev', nodes: [nodeWith()] },
    transport: {
      command: async () => { throw new Error('node offline'); },
      meshCommand: async () => { throw new Error('node offline'); },
    },
  } as any;
  const out = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node_1' }));

  assert.equal(out.success, false);
  assert.equal(out.code, 'detection_unavailable');
  assert.match(out.error, /node offline/);
});
