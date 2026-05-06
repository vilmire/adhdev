import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMeshModeCoordinatorPrompt } from '../src/server.js';

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
