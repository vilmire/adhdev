import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isMeshOwnedDelegateSession,
  classifyRemoteDelegateRelaySafety,
} from '../src/tools/mesh-tools.js';

// Regression coverage for the redispatch-guard ownership misclassification:
//
// When a coordinator relay-safely completes the FIRST task on a remote worktree
// worker session, detachMeshAssignment intentionally clears meshNodeFor /
// meshNodeId / meshActiveTaskId but PRESERVES the coordinator markers
// (launchedByCoordinator / meshCoordinatorDaemonId). The redispatch guard used
// to key ownership solely off meshNodeFor, so a follow-up task to the SAME
// session was misclassified as an unrelated alias ('unsafe_alias') and rejected
// — even though the remote router self-heals meshNodeFor at dispatch time.

const MESH = 'mesh_remote';
const NODE = 'node_worker';
const COORD = 'daemon-coordinator';

test('mesh-owned while meshNodeFor present and matching', () => {
  const session = { settings: { meshNodeFor: MESH, meshNodeId: NODE } };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, NODE), true);
});

test('not mesh-owned when meshNodeFor targets a different mesh', () => {
  const session = { settings: { meshNodeFor: 'mesh_other', meshNodeId: NODE } };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, NODE), false);
});

test('not mesh-owned when meshNodeFor matches but meshNodeId is a different node', () => {
  const session = { settings: { meshNodeFor: MESH, meshNodeId: 'node_else' } };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, NODE), false);
});

test('post-detach: ownership recognized via launchedByCoordinator marker', () => {
  // meshNodeFor / meshNodeId cleared by detachMeshAssignment; coordinator
  // markers preserved.
  const session = {
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD },
  };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, NODE), true);
});

test('post-detach: ownership recognized via meshCoordinatorDaemonId alone', () => {
  const session = { settings: { meshCoordinatorDaemonId: COORD } };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, NODE), true);
});

test('a stranger session with no mesh markers is NOT owned', () => {
  const session = { settings: { providerType: 'claude-cli' } };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, NODE), false);
});

test('post-detach session is relay-safe (not unsafe_alias) when anchor preserved', () => {
  // The exact bug: detach left meshCoordinatorDaemonId, so the session both
  // proves ownership AND carries the relay anchor → 'safe'.
  const session = {
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD },
  };
  assert.equal(
    classifyRemoteDelegateRelaySafety(session, MESH, NODE, COORD),
    'safe',
  );
});

test('post-detach owned without anchor but resolvable coordinator → self_heal', () => {
  const session = { settings: { launchedByCoordinator: true } };
  assert.equal(
    classifyRemoteDelegateRelaySafety(session, MESH, NODE, COORD),
    'self_heal',
  );
});

test('post-detach owned without anchor and no resolvable coordinator → missing_anchor', () => {
  const session = { settings: { launchedByCoordinator: true } };
  assert.equal(
    classifyRemoteDelegateRelaySafety(session, MESH, NODE, ''),
    'missing_anchor',
  );
});

test('truly unrelated session still classified unsafe_alias', () => {
  const session = { settings: { meshNodeFor: 'mesh_other', meshNodeId: NODE } };
  assert.equal(
    classifyRemoteDelegateRelaySafety(session, MESH, NODE, COORD),
    'unsafe_alias',
  );
});
