import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isMeshOwnedDelegateSession,
  chooseDispatchableSession,
} from '../src/tools/mesh-tools.js';

// WTCLAIM (A): a detached but coordinator-owned session (meshNodeFor/meshNodeId
// cleared by detachMeshAssignment, launchedByCoordinator / meshCoordinatorDaemonId
// preserved) is reusable ONLY for the node it last served. detachMeshAssignment now
// preserves a sticky meshLastNodeId. On a daemon hosting BOTH a base node and a
// cloned worktree node (same daemonId), without this gate a detached BASE session
// would be auto-picked (chooseDispatchableSession) for a worktree-targeted dispatch.

const MESH = 'mesh_remote';
const BASE = 'node_base';
const WORKTREE = 'node_worktree';
const COORD = 'daemon-coordinator';
const PROVIDER = 'claude-cli';

test('detached session is NOT owned by a different node than the one it last served', () => {
  const detachedBase = {
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: BASE },
  };
  assert.equal(isMeshOwnedDelegateSession(detachedBase, MESH, WORKTREE), false);
});

test('detached session IS owned by the same node it last served (legit reuse preserved)', () => {
  const detachedBase = {
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: BASE },
  };
  assert.equal(isMeshOwnedDelegateSession(detachedBase, MESH, BASE), true);
});

test('detached session with NO node history stays permissive (pre-fix backstop, documented)', () => {
  // No meshLastNodeId — e.g. a session detached before this fix shipped, or one
  // never bound to a node. Behavior unchanged; fix (B) is the worker-side backstop.
  const session = { settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD } };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, WORKTREE), true);
});

test('a non-coordinator session is still NOT owned (unchanged)', () => {
  const session = { settings: { providerType: PROVIDER } };
  assert.equal(isMeshOwnedDelegateSession(session, MESH, WORKTREE), false);
});

test('chooseDispatchableSession: worktree dispatch picks the worktree session, not the detached base', () => {
  const detachedBase = {
    id: 'sess_base',
    status: 'idle',
    providerType: PROVIDER,
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: BASE },
  };
  const worktree = {
    id: 'sess_worktree',
    status: 'idle',
    providerType: PROVIDER,
    settings: { meshNodeFor: MESH, meshNodeId: WORKTREE, meshCoordinatorDaemonId: COORD },
  };
  const chosen = chooseDispatchableSession([detachedBase, worktree], PROVIDER, MESH, WORKTREE, COORD);
  assert.equal(chosen?.id, 'sess_worktree');
});

test('chooseDispatchableSession: worktree dispatch does NOT auto-pick a lone detached base session', () => {
  const detachedBase = {
    id: 'sess_base',
    status: 'idle',
    providerType: PROVIDER,
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: BASE },
  };
  const chosen = chooseDispatchableSession([detachedBase], PROVIDER, MESH, WORKTREE, COORD);
  assert.equal(chosen, undefined);
});

test('chooseDispatchableSession: a detached base session IS still pickable for the base node', () => {
  const detachedBase = {
    id: 'sess_base',
    status: 'idle',
    providerType: PROVIDER,
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: BASE },
  };
  const chosen = chooseDispatchableSession([detachedBase], PROVIDER, MESH, BASE, COORD);
  assert.equal(chosen?.id, 'sess_base');
});
