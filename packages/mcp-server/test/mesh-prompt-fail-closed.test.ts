import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMeshModeCoordinatorPrompt, readCoordinatorPromptResourceText } from '../src/server.js';

test('mesh mode coordinator prompt generation fails closed instead of returning a compact fallback', async () => {
  const brokenMesh = {
    id: 'mesh-broken-prompt',
    name: 'Broken Prompt Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
  };

  await assert.rejects(
    () => buildMeshModeCoordinatorPrompt(brokenMesh),
    /Failed to build Repo Mesh coordinator prompt/,
  );
});

test('coordinator://system-prompt read is failure-tolerant: a render error becomes a short error text, never a throw', async () => {
  const brokenMesh = {
    id: 'mesh-broken-prompt',
    name: 'Broken Prompt Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
  };

  const text = await readCoordinatorPromptResourceText(brokenMesh);
  assert.match(text, /^Coordinator system prompt unavailable: Failed to build Repo Mesh coordinator prompt/);
});

test('coordinator://system-prompt read renders the default prompt for a well-formed mesh', async () => {
  const mesh = {
    id: 'mesh-ok', name: 'OK Mesh', repoIdentity: 'example/repo', nodes: [], policy: {}, coordinator: {},
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };

  const text = await readCoordinatorPromptResourceText(mesh);
  assert.match(text, /Repo Mesh Coordinator/);
  assert.match(text, /## Requests relayed by the assistant/);
});
