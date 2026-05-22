import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshApprove, meshCheckpoint, meshCloneNode, meshLaunchSession, meshReadChat, meshReadDebug, meshRemoveNode, meshSendTask, meshStatus, meshListNodes, meshGitStatus, meshViewQueue, meshQueueCancel, meshQueueRequeue, meshTaskHistory, ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { appendLedgerEntry, claimNextTask, enqueueTask, getLedgerDir, getQueue } from '@adhdev/daemon-core';
import { clearPendingMeshCoordinatorEvents, drainPendingMeshCoordinatorEvents, handleMeshForwardEvent } from '../../daemon-core/src/mesh/mesh-events.js';

test('mesh worktree tools route clone/remove to the source node daemon and refresh MCP mesh context', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'clone_mesh_node') {
      // Real cloud/daemon relay responses are nested several times:
      // daemon-cloud wraps relayResult, the Durable Object wraps payload,
      // and daemon-core wraps command_result. meshCloneNode must still
      // discover and upsert the returned node into this MCP process context.
      return {
        success: true,
        result: {
          success: true,
          messageId: 'msg-relay-clone',
          result: {
            requestId: 'req-relay-clone',
            success: true,
            result: {
              success: true,
              node: {
                id: 'node-worktree',
                workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
                repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
                daemonId,
                userOverrides: {},
                policy: { canPush: true },
                isLocalWorktree: true,
                worktreeBranch: 'feat/x',
                clonedFromNodeId: 'node-source',
              },
              worktreePath: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
              branch: 'feat/x',
            },
          },
        },
      };
    }
    if (command === 'launch_cli') {
      return { success: true, sessionId: 'session-worktree' };
    }
    if (command === 'remove_mesh_node') {
      return { success: true, removed: true };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const mesh = {
    id: 'mesh-worktree-flow',
    name: 'Worktree Flow',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-source',
      workspace: '/repo',
      repoRoot: '/repo',
      daemonId: 'daemon-source',
      userOverrides: {},
      policy: { canPush: true },
    }],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-coordinator' };

  const cloneText = await meshCloneNode(ctx, { source_node_id: 'node-source', branch: 'feat/x' });
  assert.equal(JSON.parse(cloneText).success, true);
  assert.ok(ctx.mesh.nodes.some(node => node.id === 'node-worktree'));
  assert.equal(calls[0].daemonId, 'daemon-source');
  assert.equal(calls[0].command, 'clone_mesh_node');
  assert.equal(calls[0].args.meshId, 'mesh-worktree-flow');
  assert.equal(calls[0].args.sourceNodeId, 'node-source');
  assert.equal(calls[0].args.branch, 'feat/x');
  assert.equal(calls[0].args.baseBranch, undefined);
  assert.equal((calls[0].args.inlineMesh as typeof mesh).id, 'mesh-worktree-flow');

  const launchText = await meshLaunchSession(ctx, { node_id: 'node-worktree', type: 'hermes-cli' });
  assert.equal(JSON.parse(launchText).sessionId, 'session-worktree');
  assert.equal(calls[1].daemonId, 'daemon-source');
  assert.equal(calls[1].command, 'launch_cli');
  assert.deepEqual(calls[1].args.settings, {
    meshNodeFor: 'mesh-worktree-flow',
    meshNodeId: 'node-worktree',
    spawnedSessionVisibility: 'visible',
    meshCoordinatorDaemonId: 'daemon-coordinator',
    launchedByCoordinator: true,
  });

  const removeText = await meshRemoveNode(ctx, { node_id: 'node-worktree' });
  assert.equal(JSON.parse(removeText).success, true);
  assert.ok(!ctx.mesh.nodes.some(node => node.id === 'node-worktree'));
  assert.equal(calls[3].daemonId, 'daemon-source');
  assert.equal(calls[3].command, 'remove_mesh_node');
});

test('mesh_clone_node keeps cloned worktrees visible after list/status refresh by syncing the coordinator daemon cache', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const clonedNode = {
    id: 'node-worktree',
    workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
    repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
    daemonId: 'daemon-source',
    userOverrides: {},
    policy: { canPush: true },
    isLocalWorktree: true,
    worktreeBranch: 'feat/x',
    clonedFromNodeId: 'node-source',
  };
  const mesh = {
    id: 'mesh-worktree-refresh',
    name: 'Worktree Refresh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-source',
      workspace: '/repo',
      repoRoot: '/repo',
      daemonId: 'daemon-source',
      userOverrides: {},
      policy: { canPush: true },
    }],
  };
  const ctx = { mesh, transport };
  const localGetMeshCalls: Array<Record<string, unknown> | undefined> = [];
  let localDaemonMesh = structuredClone(mesh);

  transport.command = async (command, args = {}) => {
    if (command !== 'get_mesh') {
      throw new Error(`unexpected direct command: ${command}`);
    }
    localGetMeshCalls.push(args);
    if (args.inlineMesh && typeof args.inlineMesh === 'object') {
      localDaemonMesh = structuredClone(args.inlineMesh as typeof mesh);
    }
    return { success: true, mesh: structuredClone(localDaemonMesh) };
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command !== 'clone_mesh_node') {
      throw new Error(`unexpected mesh command: ${command}`);
    }
    return {
      success: true,
      result: {
        success: true,
        result: {
          success: true,
          result: {
            success: true,
            node: clonedNode,
          },
        },
      },
    };
  };

  const cloneText = await meshCloneNode(ctx, { source_node_id: 'node-source', branch: 'feat/x' });
  assert.equal(JSON.parse(cloneText).success, true);
  assert.ok(ctx.mesh.nodes.some(node => node.id === 'node-worktree'));

  const listed = JSON.parse(await meshListNodes(ctx));
  assert.ok(listed.nodes.some((node: { nodeId: string }) => node.nodeId === 'node-worktree'));
  assert.ok(localGetMeshCalls.some(call => call && typeof call === 'object' && 'inlineMesh' in call));
});

test('mesh_launch_session stamps delegated sessions hidden when mesh policy requests hidden spawned session visibility', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'launch_cli') return { success: true, sessionId: 'session-hidden' };
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-hidden-visibility',
      name: 'Hidden Visibility Mesh',
      repoIdentity: 'example/repo',
      policy: { spawnedSessionVisibility: 'hidden' },
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-hidden',
        workspace: '/repo-hidden',
        repoRoot: '/repo-hidden',
        daemonId: 'daemon-hidden',
        userOverrides: {},
        policy: { canPush: true },
      }],
    },
    transport,
  };

  const launchText = await meshLaunchSession(ctx, { node_id: 'node-hidden', type: 'hermes-cli' });

  assert.equal(JSON.parse(launchText).sessionId, 'session-hidden');
  assert.equal(calls[0].command, 'launch_cli');
  assert.equal(calls[0].args.settings?.spawnedSessionVisibility, 'hidden');
  assert.equal(calls[0].args.settings?.launchedByCoordinator, true);
});

test('mesh_launch_session stamps coordinator daemon id for remote worker nodes even when coordinator is not a mesh node', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'launch_cli') return { success: true, sessionId: 'session-remote' };
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-remote-worker',
      name: 'Remote Worker Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-worker',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-worker',
        userOverrides: {},
        policy: { canPush: true },
      }],
    },
    transport,
  };

  const launchText = await meshLaunchSession(ctx, { node_id: 'node-remote-worker', type: 'hermes-cli' });

  assert.equal(JSON.parse(launchText).sessionId, 'session-remote');
  assert.equal(calls[0].daemonId, 'daemon-worker');
  assert.equal(calls[0].command, 'launch_cli');
  assert.equal(calls[0].args.settings?.meshCoordinatorDaemonId, 'daemon-coordinator');
  assert.equal(calls[0].args.settings?.meshNodeFor, 'mesh-remote-worker');
  assert.equal(calls[0].args.settings?.meshNodeId, 'node-remote-worker');
  assert.equal(calls[0].args.settings?.launchedByCoordinator, true);
});

test('mesh_launch_session fails closed for remote worker nodes when coordinator daemon id is unavailable', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  let meshCalls = 0;
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => {
    meshCalls += 1;
    throw new Error('remote launch must be blocked before relay');
  };

  const ctx = {
    mesh: {
      id: 'mesh-remote-worker-no-coordinator',
      name: 'Remote Worker Mesh No Coordinator',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-worker',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-worker',
        userOverrides: {},
        policy: { canPush: true },
      }],
    },
    transport,
  };

  const launch = JSON.parse(await meshLaunchSession(ctx as any, { node_id: 'node-remote-worker', type: 'hermes-cli' }));
  assert.equal(launch.success, false);
  assert.equal(launch.code, 'mesh_coordinator_daemon_unknown');
  assert.equal(launch.nodeId, 'node-remote-worker');
  assert.equal(launch.daemonId, 'daemon-worker');
  assert.equal(meshCalls, 0);
});

test('mesh_launch_session reports recoverable worktree launch failure when daemon mesh transport is unavailable', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: `mesh-worktree-launch-failure-${Date.now()}`,
      name: 'Worktree Launch Failure Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-worktree-failed',
        workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-failed',
        repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-failed',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
        isLocalWorktree: true,
        worktreeBranch: 'feat/failed',
        clonedFromNodeId: 'node-source',
      }],
    },
    transport,
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'launch_cli' || command === 'git_status') {
      throw new Error("P2P DataChannel command 'launch_cli' to daemon-remote timed out after 30s");
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const launchText = await meshLaunchSession(ctx, { node_id: 'node-worktree-failed', type: 'hermes-cli' });
  const launch = JSON.parse(launchText);
  assert.equal(launch.success, false);
  assert.equal(launch.recoverable, true);
  assert.equal(launch.code, 'p2p_timeout');
  assert.equal(launch.nodeId, 'node-worktree-failed');
  assert.equal(launch.daemonId, 'daemon-remote');
  assert.equal(launch.workspace, '/repo-parent/.adhdev-worktrees/mesh/feat-failed');
  assert.equal(launch.worktreeBranch, 'feat/failed');
  assert.equal(launch.cleanup?.tool, 'mesh_remove_node');
  assert.equal(launch.cleanup?.args?.node_id, 'node-worktree-failed');
  assert.equal(launch.transport, 'p2p');
  assert.equal(launch.retryRecommended, true);
  assert.match(launch.nextAction, /bounded retry/i);
  assert.match(launch.noFallbackReason, /WS\/REST command fallback/i);
  assert.ok(launch.retryHint.includes('mesh_launch_session'));

  const statusText = await meshStatus(ctx);
  const status = JSON.parse(statusText);
  const nodeStatus = status.nodes.find((node: any) => node.nodeId === 'node-worktree-failed');
  assert.equal(nodeStatus.health, 'degraded');
  assert.equal(nodeStatus.launchReady, false);
  assert.equal(nodeStatus.launchBlockedReason, 'p2p_timeout');
  assert.equal(nodeStatus.degradedReason, 'worktree_launch_failed');
  assert.ok(nodeStatus.nextStepHints.some((hint: string) => hint.includes('mesh_remove_node')));
});

test('mesh_git_status preserves P2P relay recovery payload for coordinator feedback', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: `mesh-git-status-relay-failure-${Date.now()}`,
      name: 'Git Status Relay Failure Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-git',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'git_status') {
      throw new Error("P2P DataChannel command 'git_status' to daemon-remote timed out after 30s");
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const statusText = await meshGitStatus(ctx, { node_id: 'node-remote-git' });
  const status = JSON.parse(statusText);

  assert.equal(status.success, false);
  assert.equal(status.recoverable, true);
  assert.equal(status.code, 'p2p_timeout');
  assert.equal(status.transport, 'p2p');
  assert.equal(status.retryRecommended, true);
  assert.match(status.noFallbackReason, /WS\/REST command fallback/i);
  assert.equal(status.nodeId, 'node-remote-git');
  assert.equal(status.targetDaemonId, 'daemon-remote');
  assert.equal(status.command, 'git_status');
});

test('mesh_status preserves full git snapshot fields from the aggregate node status shape', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: `mesh-status-full-git-${Date.now()}`,
      name: 'Status Full Git Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-full-git',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'git_status') {
      return {
        success: true,
        status: {
          workspace: '/repo-remote',
          repoRoot: '/repo-remote',
          isGitRepo: true,
          branch: 'main',
          headCommit: '083fe011',
          headMessage: 'fix: aggregate truth',
          upstream: 'origin/main',
          upstreamStatus: 'diverged',
          ahead: 2,
          behind: 12,
          staged: 3,
          modified: 1,
          untracked: 1,
          deleted: 1,
          renamed: 1,
          hasConflicts: false,
          conflictFiles: [],
          stashCount: 2,
          lastCheckedAt: 1710000000000,
          submodules: [
            {
              path: 'oss',
              commit: 'abc1234',
              repoPath: '/repo-remote/oss',
              dirty: false,
              outOfSync: true,
              lastCheckedAt: 1710000000001,
            },
          ],
        },
      };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const status = JSON.parse(await meshStatus(ctx));
  const nodeStatus = status.nodes.find((node: any) => node.nodeId === 'node-full-git');

  assert.equal(nodeStatus.branch, 'main');
  assert.equal(nodeStatus.git.isGitRepo, true);
  assert.equal(nodeStatus.git.repoRoot, '/repo-remote');
  assert.equal(nodeStatus.git.headCommit, '083fe011');
  assert.equal(nodeStatus.git.headMessage, 'fix: aggregate truth');
  assert.equal(nodeStatus.git.upstream, 'origin/main');
  assert.equal(nodeStatus.git.upstreamStatus, 'diverged');
  assert.equal(nodeStatus.git.ahead, 2);
  assert.equal(nodeStatus.git.behind, 12);
  assert.equal(nodeStatus.git.staged, 3);
  assert.equal(nodeStatus.git.modified, 1);
  assert.equal(nodeStatus.git.untracked, 1);
  assert.equal(nodeStatus.git.deleted, 1);
  assert.equal(nodeStatus.git.renamed, 1);
  assert.equal(nodeStatus.git.stashCount, 2);
  assert.equal(nodeStatus.git.lastCheckedAt, 1710000000000);
  assert.deepEqual(nodeStatus.git.submodules, [
    {
      path: 'oss',
      commit: 'abc1234',
      repoPath: '/repo-remote/oss',
      dirty: false,
      outOfSync: true,
      lastCheckedAt: 1710000000001,
    },
  ]);
  assert.deepEqual(nodeStatus.outOfSyncSubmodules, ['oss']);
});

test('mesh_status marks git_status P2P timeout as recoverable degraded node metadata', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: `mesh-status-relay-failure-${Date.now()}`,
      name: 'Status Relay Failure Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-status',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'git_status') {
      throw new Error("P2P DataChannel command 'git_status' to daemon-remote timed out after 30s");
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const statusText = await meshStatus(ctx);
  const status = JSON.parse(statusText);
  const nodeStatus = status.nodes.find((node: any) => node.nodeId === 'node-remote-status');

  assert.equal(nodeStatus.health, 'degraded');
  assert.equal(nodeStatus.recoverable, true);
  assert.equal(nodeStatus.code, 'p2p_timeout');
  assert.equal(nodeStatus.transport, 'p2p');
  assert.equal(nodeStatus.retryRecommended, true);
  assert.match(nodeStatus.noFallbackReason, /WS\/REST command fallback/i);
});

test('mesh_task_history backfills remote pending completion events into the coordinator ledger', async () => {
  clearPendingMeshCoordinatorEvents();
  const meshId = `mesh-task-history-backfill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  let remoteDrained = false;
  const localComponents = {
    instanceManager: {
      getByCategory: () => [],
    },
  } as any;
  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: meshId,
      name: 'Task History Backfill Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-worker',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  transport.command = async (command, args = {}) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    if (command === 'get_pending_mesh_events') {
      return { events: drainPendingMeshCoordinatorEvents() };
    }
    if (command === 'mesh_forward_event') {
      return handleMeshForwardEvent(localComponents, args as Record<string, unknown>);
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'get_pending_mesh_events') {
      if (remoteDrained) return { events: [] };
      remoteDrained = true;
      return {
        events: [{
          event: 'agent:generating_completed',
          meshId,
          nodeId: 'node-remote-worker',
          workspace: '/repo-remote',
          metadataEvent: {
            targetSessionId: 'session-remote',
            providerType: 'hermes-cli',
            providerSessionId: 'provider-remote',
            finalSummary: 'done',
          },
        }],
      };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  try {
    const history = JSON.parse(await meshTaskHistory(ctx as any, { tail: 10 }));
    const completion = history.entries.find((entry: any) => entry.kind === 'task_completed' && entry.sessionId === 'session-remote');
    assert.ok(completion, 'expected task_completed entry after remote pending-event drain');
    assert.equal(completion.nodeId, 'node-remote-worker');
    assert.equal(completion.providerType, 'hermes-cli');
    assert.equal(completion.payload.event, 'agent:generating_completed');
    assert.equal(completion.payload.providerSessionId, 'provider-remote');
    assert.equal(completion.payload.finalSummary, 'done');
    assert.equal(history.summary.taskCompleted >= 1, true);
  } finally {
    clearPendingMeshCoordinatorEvents();
  }
});

test('mesh_send_task preserves P2P relay recovery payload for coordinator feedback', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: `mesh-send-relay-failure-${Date.now()}`,
      name: 'Send Relay Failure Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-worker',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'get_status_metadata') {
      return {
        success: true,
        result: {
          success: true,
          status: {
            sessions: [{
              id: 'session-remote',
              providerType: 'hermes-cli',
              status: 'idle',
              settings: {
                meshNodeFor: ctx.mesh.id,
                meshNodeId: 'node-remote-worker',
                meshCoordinatorDaemonId: 'daemon-coordinator',
              },
            }],
          },
        },
      };
    }
    if (command === 'agent_command') {
      throw new Error("P2P DataChannel command 'agent_command' to daemon-remote timed out after 30s");
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const sendText = await meshSendTask(ctx, { node_id: 'node-remote-worker', session_id: 'session-remote', message: 'do work' });
  const send = JSON.parse(sendText);

  assert.equal(send.success, false);
  assert.equal(send.recoverable, true);
  assert.equal(send.code, 'p2p_timeout');
  assert.equal(send.transport, 'p2p');
  assert.equal(send.retryRecommended, true);
  assert.match(send.nextAction, /requeue/i);
  assert.match(send.noFallbackReason, /WS\/REST command fallback/i);
  assert.equal(send.nodeId, 'node-remote-worker');
  assert.equal(send.sessionId, 'session-remote');
});

test('mesh_send_task does not reuse a remote live session that lacks mesh delegate metadata', async () => {
  const meshId = `mesh-remote-fresh-only-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const relayCalls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  const ctx = {
    mesh: {
      id: meshId,
      name: 'Remote Fresh Only',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-worker',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    relayCalls.push({ daemonId, command, args });
    if (command === 'get_status_metadata') {
      return {
        success: true,
        result: {
          success: true,
          status: {
            sessions: [{
              id: 'session-legacy-live',
              providerType: 'hermes-cli',
              status: 'idle',
              settings: {},
            }],
          },
        },
      };
    }
    if (command === 'agent_command') {
      return { success: true };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const send = JSON.parse(await meshSendTask(ctx as any, { node_id: 'node-remote-worker', message: 'do work' }));

  assert.equal(send.success, true);
  assert.equal(send.dispatched, true);
  assert.equal(relayCalls[0].command, 'get_status_metadata');
  assert.equal(relayCalls[1].command, 'agent_command');
  assert.equal(relayCalls[1].args.targetSessionId, undefined);
  assert.equal(relayCalls[1].args.agentType, 'hermes-cli');
  assert.equal(relayCalls[1].args.cliType, 'hermes-cli');
  assert.equal(relayCalls[1].args.message, 'do work');
});

test('mesh_send_task fails closed when explicitly targeting a remote live session that lacks relay metadata', async () => {
  const meshId = `mesh-remote-explicit-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const relayCalls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  const ctx = {
    mesh: {
      id: meshId,
      name: 'Remote Explicit Session Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-worker',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh: ctx.mesh };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    relayCalls.push({ daemonId, command, args });
    if (command === 'get_status_metadata') {
      return {
        success: true,
        result: {
          success: true,
          status: {
            sessions: [{
              id: 'session-legacy-live',
              providerType: 'hermes-cli',
              status: 'idle',
              settings: {},
            }],
          },
        },
      };
    }
    if (command === 'agent_command') {
      throw new Error('agent_command must not be sent to a non-relay-safe explicit session');
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const send = JSON.parse(await meshSendTask(ctx as any, {
    node_id: 'node-remote-worker',
    session_id: 'session-legacy-live',
    message: 'do work',
  }));

  assert.equal(send.success, false);
  assert.equal(send.code, 'mesh_delegate_session_missing_relay_metadata');
  assert.equal(send.nodeId, 'node-remote-worker');
  assert.equal(send.sessionId, 'session-legacy-live');
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].command, 'get_status_metadata');
});

test('mesh_remove_node falls back to local control-plane cleanup for degraded local worktree nodes when P2P relay is unavailable', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const directCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const relayCalls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-remove-fallback',
      name: 'Remove Fallback Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-worktree-orphan',
        workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-orphan',
        repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-orphan',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
        isLocalWorktree: true,
        worktreeBranch: 'feat/orphan',
        clonedFromNodeId: 'node-source',
      }],
    },
    transport,
  };

  transport.meshCommand = async (daemonId, command, args = {}) => {
    relayCalls.push({ daemonId, command, args });
    throw new Error("P2P DataChannel command 'remove_mesh_node' to daemon-remote timed out after 30s");
  };
  transport.command = async (command, args = {}) => {
    directCalls.push({ command, args });
    if (command === 'get_mesh') return ctx.mesh;
    if (command === 'remove_mesh_node') return { success: true, removed: true, worktreeCleanup: { skipped: true, reason: 'worktree_path_missing' } };
    throw new Error(`unexpected direct command: ${command}`);
  };

  const text = await meshRemoveNode(ctx, { node_id: 'node-worktree-orphan', session_cleanup_mode: 'preserve' });
  const result = JSON.parse(text);

  assert.equal(result.success, true);
  assert.equal(result.removed, true);
  assert.equal(result.transportFallback.from, 'p2p_mesh_relay');
  assert.equal(result.transportFallback.to, 'local_control_plane');
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].command, 'remove_mesh_node');
  assert.equal(directCalls.length, 2);
  assert.equal(directCalls[0].command, 'get_mesh');
  assert.equal(directCalls[1].command, 'remove_mesh_node');
  assert.equal((directCalls[1].args.inlineMesh as any).id, 'mesh-remove-fallback');
  assert.equal(directCalls[1].args.sessionCleanupMode, 'preserve');
  assert.ok(!ctx.mesh.nodes.some(node => node.id === 'node-worktree-orphan'));
});

test('mesh_remove_node does not use local control-plane fallback for non-worktree P2P failures', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  let directCalls = 0;

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-remove-no-fallback',
      name: 'Remove No Fallback Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote-normal',
        workspace: '/repo-remote',
        repoRoot: '/repo-remote',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: {},
      }],
    },
    transport,
  };

  transport.meshCommand = async () => {
    throw new Error("P2P DataChannel command 'remove_mesh_node' to daemon-remote timed out after 30s");
  };
  transport.command = async () => {
    directCalls += 1;
    throw new Error('direct fallback must not be used');
  };

  const text = await meshRemoveNode(ctx, { node_id: 'node-remote-normal' });
  const result = JSON.parse(text);

  assert.equal(result.success, false);
  assert.equal(result.code, 'p2p_unavailable');
  assert.equal(directCalls, 0);
  assert.ok(ctx.mesh.nodes.some(node => node.id === 'node-remote-normal'));
});

test('mesh_launch_session routes local worktree cloned from local source through local control plane without P2P relay', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const directCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const relayCalls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];

  const ctx = {
    localDaemonId: 'daemon-local-runtime',
    localMachineId: 'mreg-local-machine',
    mesh: {
      id: 'mesh-local-worktree-launch',
      name: 'Local Worktree Launch Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        {
          id: 'node-source-local',
          workspace: '/repo',
          repoRoot: '/repo',
          daemonId: 'daemon-cloud-identity',
          machineId: 'mreg-local-machine',
          userOverrides: {},
          policy: { providerPriority: ['hermes-cli'] },
        },
        {
          id: 'node-worktree-a',
          workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-a',
          repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-a',
          daemonId: 'daemon-cloud-identity',
          userOverrides: {},
          policy: { providerPriority: ['hermes-cli'] },
          isLocalWorktree: true,
          worktreeBranch: 'feat/a',
          clonedFromNodeId: 'node-source-local',
        },
        {
          id: 'node-worktree-b',
          workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-b',
          repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-b',
          daemonId: 'daemon-cloud-identity',
          userOverrides: {},
          policy: { providerPriority: ['hermes-cli'] },
          isLocalWorktree: true,
          worktreeBranch: 'feat/b',
          clonedFromNodeId: 'node-source-local',
        },
      ],
    },
    transport,
  };

  transport.meshCommand = async (daemonId, command, args = {}) => {
    relayCalls.push({ daemonId, command, args });
    throw new Error(`unexpected P2P relay for local worktree command: ${command}`);
  };
  transport.command = async (command, args = {}) => {
    directCalls.push({ command, args });
    if (command === 'launch_cli') {
      return { success: true, sessionId: (args as any).dir === '/repo-parent/.adhdev-worktrees/mesh/feat-a' ? 'session-a' : 'session-b' };
    }
    if (command === 'trigger_mesh_queue') return { success: true };
    throw new Error(`unexpected direct command: ${command}`);
  };

  const launchAText = await meshLaunchSession(ctx, { node_id: 'node-worktree-a', type: 'hermes-cli' });
  const launchBText = await meshLaunchSession(ctx, { node_id: 'node-worktree-b', type: 'hermes-cli' });
  const launchA = JSON.parse(launchAText);
  const launchB = JSON.parse(launchBText);

  assert.equal(launchA.sessionId, 'session-a');
  assert.equal(launchB.sessionId, 'session-b');
  assert.equal(relayCalls.length, 0);

  const launchCalls = directCalls.filter(call => call.command === 'launch_cli');
  assert.equal(launchCalls.length, 2);
  assert.equal(launchCalls[0].args.dir, '/repo-parent/.adhdev-worktrees/mesh/feat-a');
  assert.equal(launchCalls[1].args.dir, '/repo-parent/.adhdev-worktrees/mesh/feat-b');
  assert.equal((launchCalls[0].args.settings as any).meshNodeId, 'node-worktree-a');
  assert.equal((launchCalls[1].args.settings as any).meshNodeId, 'node-worktree-b');
});

test('mesh_launch_session still does not use local fallback when non-local worktree P2P relay is unavailable', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  let directLaunchCalls = 0;

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-launch-no-fallback',
      name: 'Launch No Fallback Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-worktree-launch-no-fallback',
        workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-launch',
        repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-launch',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
        isLocalWorktree: true,
        worktreeBranch: 'feat/launch',
        clonedFromNodeId: 'node-source',
      }],
    },
    transport,
  };

  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'launch_cli' || command === 'git_status') {
      throw new Error("P2P DataChannel command 'launch_cli' to daemon-remote timed out after 30s");
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };
  transport.command = async (command) => {
    if (command === 'launch_cli') directLaunchCalls += 1;
    throw new Error(`unexpected direct command: ${command}`);
  };

  const text = await meshLaunchSession(ctx, { node_id: 'node-worktree-launch-no-fallback', type: 'hermes-cli' });
  const result = JSON.parse(text);

  assert.equal(result.success, false);
  assert.equal(result.recoverable, true);
  assert.equal(result.code, 'p2p_timeout');
  assert.equal(result.transport, 'p2p');
  assert.equal(result.retryRecommended, true);
  assert.match(result.nextAction, /bounded retry/i);
  assert.match(result.noFallbackReason, /WS\/REST command fallback/i);
  assert.equal(directLaunchCalls, 0);
});

test('mesh_checkpoint routes untracked checkpoint requests with the exact multiword message', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'git_checkpoint') {
      return {
        success: true,
        result: {
          success: true,
          checkpoint: {
            commit: 'abc123def456',
            message: 'adhdev: checkpoint checkpoint: rc21 fresh global repo mesh e2e smoke',
          },
        },
      };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const ctx = {
    mesh: {
      id: 'mesh-checkpoint',
      name: 'Checkpoint Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-worktree',
        workspace: '/repo-parent/.adhdev-worktrees/mesh/checkpoint',
        repoRoot: '/repo-parent/.adhdev-worktrees/mesh/checkpoint',
        daemonId: 'daemon-source',
        userOverrides: {},
        policy: { canPush: true },
      }],
    },
    transport,
  };

  const checkpointText = await meshCheckpoint(ctx as any, {
    node_id: 'node-worktree',
    message: 'checkpoint: rc21 fresh global repo mesh e2e smoke',
  });

  assert.equal(JSON.parse(checkpointText).success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].daemonId, 'daemon-source');
  assert.equal(calls[0].command, 'git_checkpoint');
  assert.deepEqual(calls[0].args, {
    workspace: '/repo-parent/.adhdev-worktrees/mesh/checkpoint',
    message: 'checkpoint: rc21 fresh global repo mesh e2e smoke',
    includeUntracked: true,
  });
});

test('mesh_launch_session explicit type overrides node providerPriority', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'launch_cli') {
      return { success: true, sessionId: 'runtime-explicit', providerSessionId: 'provider-explicit' };
    }
    if (command === 'get_chat_debug_bundle') {
      return {
        success: true,
        result: {
          success: true,
          payload: {
            success: true,
            delivery: 'daemon_file',
            savedPath: '/tmp/adhdev-chat-debug-runtime-explicit.json',
            summary: { readChatTotalMessages: 88 },
          },
        },
      };
    }
    if (command === 'resolve_action') {
      return { success: true, buttonIndex: 0, button: 'Allow once' };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-provider-explicit',
      name: 'Provider Explicit',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-provider',
        workspace: '/repo',
        repoRoot: '/repo',
        daemonId: 'daemon-source',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  const launchText = await meshLaunchSession(ctx as any, { node_id: 'node-provider', type: 'codex-cli' });
  const launch = JSON.parse(launchText);
  assert.equal(launch.sessionId, 'runtime-explicit');
  assert.equal(launch.resolvedProviderType, 'codex-cli');
  assert.equal(launch.providerSessionId, 'provider-explicit');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'launch_cli');
  assert.equal(calls[0].args.cliType, 'codex-cli');

  const debugText = await meshReadDebug(ctx as any, { node_id: 'node-provider', session_id: 'runtime-explicit', tail: 12 });
  const debug = JSON.parse(debugText);
  assert.equal(debug.delivery, 'daemon_file');
  assert.equal(debug.savedPath, '/tmp/adhdev-chat-debug-runtime-explicit.json');
  assert.equal(calls[2].daemonId, 'daemon-source');
  assert.equal(calls[2].command, 'get_chat_debug_bundle');
  assert.deepEqual(calls[2].args, {
    sessionId: 'runtime-explicit',
    targetSessionId: 'runtime-explicit',
    workspace: '/repo',
    agentType: 'codex-cli',
    providerType: 'codex-cli',
    providerSessionId: 'provider-explicit',
    tailLimit: 12,
    delivery: 'daemon_file',
  });

  const approveText = await meshApprove(ctx as any, { node_id: 'node-provider', session_id: 'runtime-explicit', action: 'approve' });
  const approve = JSON.parse(approveText);
  assert.equal(approve.success, true);
  assert.equal(calls[3].daemonId, 'daemon-source');
  assert.equal(calls[3].command, 'resolve_action');
  assert.deepEqual(calls[3].args, {
    sessionId: 'runtime-explicit',
    targetSessionId: 'runtime-explicit',
    workspace: '/repo',
    agentType: 'codex-cli',
    providerType: 'codex-cli',
    providerSessionId: 'provider-explicit',
    action: 'approve',
  });
});

test('mesh_launch_session omitted type uses providerPriority detection and fails closed when none usable', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'detect_provider') {
      return { success: true, detected: args.providerType === 'hermes-cli', providerType: args.providerType };
    }
    if (command === 'launch_cli') {
      return { success: true, sessionId: 'runtime-auto', providerSessionId: 'provider-auto' };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const node = {
    id: 'node-provider',
    workspace: '/repo',
    repoRoot: '/repo',
    daemonId: 'daemon-source',
    userOverrides: {},
    policy: { providerPriority: ['codex-cli', 'hermes-cli'] },
  };
  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-provider-auto',
      name: 'Provider Auto',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [node],
    },
    transport,
  };

  const launchText = await meshLaunchSession(ctx as any, { node_id: 'node-provider' });
  const launch = JSON.parse(launchText);
  assert.equal(launch.sessionId, 'runtime-auto');
  assert.equal(launch.resolvedProviderType, 'hermes-cli');
  assert.deepEqual(calls.map(call => call.command), ['detect_provider', 'detect_provider', 'launch_cli', 'trigger_mesh_queue']);
  assert.equal(calls[0].args.providerType, 'codex-cli');
  assert.equal(calls[1].args.providerType, 'hermes-cli');
  assert.equal(calls[2].args.cliType, 'hermes-cli');

  calls.length = 0;
  node.policy.providerPriority = ['codex-cli'];
  const failedText = await meshLaunchSession(ctx as any, { node_id: 'node-provider' });
  const failed = JSON.parse(failedText);
  assert.equal(failed.success, false);
  assert.match(failed.error, /No usable provider detected/);
  assert.deepEqual(calls.map(call => call.command), ['detect_provider']);
});

test('mesh_status and mesh_list_nodes surface launch readiness when providerPriority is missing', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'git_status') {
      return { success: true, result: { success: true, result: { status: { isGitRepo: true, branch: 'main', modified: 0 } } } };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const ctx = {
    mesh: {
      id: 'mesh-readiness',
      name: 'Readiness Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'node-missing-policy', workspace: '/repo/missing', repoRoot: '/repo/missing', daemonId: 'daemon-missing', userOverrides: {}, policy: {} },
        { id: 'node-ready-policy', workspace: '/repo/ready', repoRoot: '/repo/ready', daemonId: 'daemon-ready', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
      ],
    },
    transport,
  };

  const statusText = await meshStatus(ctx as any);
  const status = JSON.parse(statusText);
  const missingStatus = status.nodes.find((node: any) => node.nodeId === 'node-missing-policy');
  const readyStatus = status.nodes.find((node: any) => node.nodeId === 'node-ready-policy');
  assert.equal(missingStatus.launchReady, false);
  assert.equal(missingStatus.launchBlockedReason, 'missing_provider_priority');
  assert.match(missingStatus.launchBlockedMessage, /pass type explicitly or configure node\.policy\.providerPriority/);
  assert.deepEqual(missingStatus.providerPriority, []);
  assert.equal(readyStatus.launchReady, true);
  assert.deepEqual(readyStatus.providerPriority, ['hermes-cli']);

  const listText = await meshListNodes(ctx as any);
  const listed = JSON.parse(listText);
  const missingList = listed.nodes.find((node: any) => node.nodeId === 'node-missing-policy');
  const readyList = listed.nodes.find((node: any) => node.nodeId === 'node-ready-policy');
  assert.equal(missingList.launchReady, false);
  assert.equal(missingList.launchBlockedReason, 'missing_provider_priority');
  assert.match(missingList.launchBlockedMessage, /pass type explicitly or configure node\.policy\.providerPriority/);
  assert.deepEqual(missingList.providerPriority, []);
  assert.equal(readyList.launchReady, true);
  assert.deepEqual(readyList.providerPriority, ['hermes-cli']);
});

test('mesh_status surfaces branch convergence follow-up for clean non-main branches and worktrees', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command, args = {}) => {
    if (command !== 'git_status') throw new Error(`unexpected mesh command: ${command}`);
    const workspace = String((args as any).workspace || '');
    if (workspace.endsWith('/main')) {
      return { success: true, result: { success: true, result: { status: { isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'fresh', ahead: 0, behind: 0, modified: 0 } } } };
    }
    if (workspace.endsWith('/feature')) {
      return { success: true, result: { success: true, result: { status: { isGitRepo: true, branch: 'fix/feature', upstream: 'origin/fix/feature', upstreamStatus: 'fresh', ahead: 0, behind: 0, modified: 0 } } } };
    }
    if (workspace.endsWith('/worktree')) {
      return { success: true, result: { success: true, result: { status: { isGitRepo: true, branch: 'fix/worktree', modified: 0 } } } };
    }
    throw new Error(`unexpected workspace: ${workspace}`);
  };

  const ctx = {
    mesh: {
      id: 'mesh-convergence',
      name: 'Convergence Mesh',
      repoIdentity: 'example/repo',
      defaultBranch: 'main',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'node-main', workspace: '/repo/main', repoRoot: '/repo/main', daemonId: 'daemon-main', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
        { id: 'node-feature', workspace: '/repo/feature', repoRoot: '/repo/feature', daemonId: 'daemon-feature', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
        { id: 'node-worktree', workspace: '/repo/worktree', repoRoot: '/repo/worktree', daemonId: 'daemon-worktree', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] }, isLocalWorktree: true, worktreeBranch: 'fix/worktree' },
      ],
    },
    transport,
  };

  const statusText = await meshStatus(ctx as any);
  const status = JSON.parse(statusText);
  const main = status.nodes.find((node: any) => node.nodeId === 'node-main');
  const feature = status.nodes.find((node: any) => node.nodeId === 'node-feature');
  const worktree = status.nodes.find((node: any) => node.nodeId === 'node-worktree');

  assert.equal(main.branchConvergence.status, 'merged_to_main');
  assert.equal(main.branchConvergence.needsConvergence, false);
  assert.equal(feature.branchConvergence.status, 'pushed_feature_branch_needs_merge');
  assert.equal(feature.branchConvergence.needsConvergence, true);
  assert.match(feature.branchConvergence.nextStep, /do not report the task as fully complete/);
  assert.equal(worktree.branchConvergence.status, 'cleanup_candidate');
  assert.equal(worktree.branchConvergence.needsConvergence, true);
  assert.match(worktree.branchConvergence.nextStep, /mesh_refine_node/);

  assert.equal(status.branchConvergenceSummary.needsFollowUp, true);
  assert.equal(status.branchConvergenceSummary.unresolvedCount, 2);
  assert.deepEqual(
    status.branchConvergenceSummary.followUps.map((item: any) => [item.nodeId, item.status]),
    [
      ['node-feature', 'pushed_feature_branch_needs_merge'],
      ['node-worktree', 'cleanup_candidate'],
    ],
  );
  assert.ok(feature.nextStepHints.some((hint: string) => hint.includes('merge branch')));
  assert.ok(worktree.nextStepHints.some((hint: string) => hint.includes('mesh_refine_node')));
});

test('mesh_status and mesh_git_status request refreshed upstream truth and block convergence when freshness is unverified', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command !== 'git_status') throw new Error(`unexpected mesh command: ${command}`);
    const workspace = String((args as any).workspace || '');
    if (workspace.endsWith('/main')) {
      return { success: true, result: { success: true, result: { status: { isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'stale', ahead: 0, behind: 0, upstreamFetchError: 'timeout', modified: 0 } } } };
    }
    if (workspace.endsWith('/feature')) {
      return { success: true, result: { success: true, result: { status: { isGitRepo: true, branch: 'fix/feature', upstream: 'origin/fix/feature', upstreamStatus: 'stale', ahead: 0, behind: 0, upstreamFetchError: 'timeout', modified: 0 } } } };
    }
    throw new Error(`unexpected workspace: ${workspace}`);
  };

  const ctx = {
    mesh: {
      id: 'mesh-upstream-freshness',
      name: 'Freshness Mesh',
      repoIdentity: 'example/repo',
      defaultBranch: 'main',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'node-main', workspace: '/repo/main', repoRoot: '/repo/main', daemonId: 'daemon-main', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
        { id: 'node-feature', workspace: '/repo/feature', repoRoot: '/repo/feature', daemonId: 'daemon-feature', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
      ],
    },
    transport,
  };

  const statusText = await meshStatus(ctx as any);
  const status = JSON.parse(statusText);
  const main = status.nodes.find((node: any) => node.nodeId === 'node-main');
  const feature = status.nodes.find((node: any) => node.nodeId === 'node-feature');

  assert.equal(main.branchConvergence.reason, 'default_branch_upstream_unverified');
  assert.equal(main.branchConvergence.status, 'blocked_review');
  assert.equal(feature.branchConvergence.reason, 'feature_branch_upstream_unverified');
  assert.equal(feature.branchConvergence.status, 'blocked_review');
  assert.ok(calls.filter(call => call.command === 'git_status').every(call => call.args.refreshUpstream === true));
});

test('mesh_git_status source requests refreshed upstream truth for cloud and local transport paths', () => {
  const source = readFileSync(join(process.cwd(), 'src/tools/mesh-tools.ts'), 'utf8');
  assert.match(source, /gitStatus\(node\.daemonId, node\.workspace, true, true\)/);
  assert.match(source, /refreshUpstream: true,/);
});



test('mesh_read_chat forwards cached provider metadata after launch', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'launch_cli') {
      return { success: true, id: 'runtime-cached', providerSessionId: 'provider-cached' };
    }
    if (command === 'read_chat') {
      return {
        success: true,
        result: {
          success: true,
          result: {
            requestId: 'msg-read-chat',
            success: true,
            source: 'mesh',
            status: 'idle',
            messages: [{ role: 'assistant', content: 'delegated result' }],
            providerSessionId: args.providerSessionId,
          },
        },
      };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const ctx = {
    localDaemonId: 'daemon-coordinator',
    mesh: {
      id: 'mesh-provider-cache',
      name: 'Provider Cache',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-provider',
        workspace: '/repo',
        repoRoot: '/repo',
        daemonId: 'daemon-source',
        userOverrides: {},
        policy: {},
      }],
    },
    transport,
  };

  await meshLaunchSession(ctx as any, { node_id: 'node-provider', type: 'hermes-cli' });
  const readText = await meshReadChat(ctx as any, { node_id: 'node-provider', session_id: 'runtime-cached', tail: 5 });
  const readPayload = JSON.parse(readText);
  const firstReadCall = calls.find((call) => call.command === 'read_chat');
  assert.ok(firstReadCall);
  assert.equal(firstReadCall.args.agentType, 'hermes-cli');
  assert.equal(firstReadCall.args.providerType, 'hermes-cli');
  assert.equal(firstReadCall.args.providerSessionId, 'provider-cached');
  assert.equal(firstReadCall.args.workspace, '/repo');
  assert.equal(firstReadCall.args.tailLimit, 5);
  assert.equal(readPayload.success, true);
  assert.equal(readPayload.status, 'idle');
  assert.deepEqual(readPayload.messages, [{ role: 'assistant', content: 'delegated result' }]);
  assert.equal(readPayload.providerSessionId, 'provider-cached');

  await meshReadChat(ctx as any, { node_id: 'node-provider', session_id: 'runtime-cached', provider_session_id: 'provider-explicit-read' });
  const readCalls = calls.filter((call) => call.command === 'read_chat');
  assert.equal(readCalls[1].args.providerSessionId, 'provider-explicit-read');
});

test('mesh_read_chat compact mode filters tool/internal chatter and returns the final assistant summary', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'read_chat') {
      return {
        success: true,
        result: {
          success: true,
          status: 'idle',
          messages: [
            { role: 'user', content: 'do the task' },
            { role: 'assistant', kind: 'tool', content: 'terminal output bubble' },
            { role: 'tool', content: 'raw tool result' },
            { role: 'assistant', kind: 'debug', content: 'internal status trace' },
            { role: 'assistant', content: 'Final summary: implemented V1 and tests pass' },
          ],
        },
      };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const ctx = {
    mesh: {
      id: 'mesh-compact-read',
      name: 'Compact Read',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-compact',
        workspace: '/repo',
        repoRoot: '/repo',
        daemonId: 'daemon-source',
        userOverrides: {},
        policy: {},
      }],
    },
    transport,
  };

  const readText = await meshReadChat(ctx as any, {
    node_id: 'node-compact',
    session_id: 'runtime-compact',
    compact: true,
  } as any);
  const payload = JSON.parse(readText);

  assert.equal(payload.compact, true);
  assert.equal(payload.totalMessages, 5);
  assert.equal(payload.messages.length, 1);
  assert.deepEqual(payload.messages.map((m: any) => m.content), [
    'do the task',
  ]);
  assert.equal(payload.summary, 'Final summary: implemented V1 and tests pass');
});

test('mesh_read_chat compact removed-node recovery returns ledger summary without duplicating it in messages', async () => {
  const meshId = `mesh-removed-summary-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const longSummary = `Recovered summary ${'x'.repeat(900)}`;
  appendLedgerEntry(meshId, {
    kind: 'task_completed',
    nodeId: 'node-removed',
    sessionId: 'session-finished',
    providerType: 'hermes-cli',
    payload: { providerSessionId: 'provider-finished', finalSummary: longSummary },
  });
  appendLedgerEntry(meshId, {
    kind: 'node_removed',
    nodeId: 'node-removed',
    payload: { sessionCleanupMode: 'stop_and_delete' },
  });

  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.command = async (command) => {
    if (command === 'get_mesh') {
      return { success: true, mesh: { id: meshId, name: 'Removed Read', nodes: [], updatedAt: new Date().toISOString() } };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };

  const text = await meshReadChat({
    mesh: {
      id: meshId,
      name: 'Removed Read',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [],
    },
    transport,
  } as any, { node_id: 'node-removed', session_id: 'session-finished', compact: true });
  const payload = JSON.parse(text);

  assert.equal(payload.success, true);
  assert.equal(payload.recoveredFromLedger, true);
  assert.equal(payload.summary, longSummary);
  assert.deepEqual(payload.messages, []);
  assert.equal(payload.providerSessionId, 'provider-finished');
});

test('mesh_read_chat returns recoverable completion context instead of throwing for removed node', async () => {
  const meshId = `mesh-removed-read-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  appendLedgerEntry(meshId, {
    kind: 'session_launched',
    nodeId: 'node-removed',
    sessionId: 'session-finished',
    providerType: 'hermes-cli',
    payload: { providerSessionId: 'provider-finished' },
  });
  appendLedgerEntry(meshId, {
    kind: 'task_completed',
    nodeId: 'node-removed',
    sessionId: 'session-finished',
    providerType: 'hermes-cli',
    payload: { providerSessionId: 'provider-finished' },
  });
  appendLedgerEntry(meshId, {
    kind: 'node_removed',
    nodeId: 'node-removed',
    payload: { sessionCleanupMode: 'stop_and_delete' },
  });

  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.command = async (command) => {
    if (command === 'get_mesh') {
      return { success: true, mesh: { id: meshId, name: 'Removed Read', nodes: [], updatedAt: new Date().toISOString() } };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };

  const text = await meshReadChat({
    mesh: {
      id: meshId,
      name: 'Removed Read',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [],
    },
    transport,
  } as any, { node_id: 'node-removed', session_id: 'session-finished', compact: true });
  const payload = JSON.parse(text);
  assert.equal(payload.success, false);
  assert.equal(payload.recoverable, true);
  assert.equal(payload.code, 'mesh_removed_node_transcript_unavailable');
  assert.equal(payload.nodeId, 'node-removed');
  assert.equal(payload.sessionId, 'session-finished');
  assert.equal(payload.ledger.taskCompletedFound, true);
  assert.equal(payload.ledger.nodeRemovedFound, true);
  assert.equal(payload.ledger.providerSessionId, 'provider-finished');
  assert.match(payload.nextSteps[0], /provider_session_id/);
});

test('mesh_send_task dedupes rapid identical node/session/message dispatch retries', async () => {
  const meshId = `mesh-dedupe-send-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  let agentCommandCalls = 0;
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'get_status_metadata') {
      return {
        success: true,
        result: {
          success: true,
          status: {
            sessions: [{
              id: 'session-a',
              providerType: 'hermes-cli',
              status: 'idle',
              settings: {
                meshNodeFor: meshId,
                meshNodeId: 'node-remote',
                meshCoordinatorDaemonId: 'daemon-local',
              },
            }],
          },
        },
      };
    }
    if (command === 'agent_command') {
      agentCommandCalls += 1;
      return { success: true };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };
  const ctx = {
    localDaemonId: 'daemon-local',
    mesh: {
      id: meshId,
      name: 'Dedupe Send',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-remote',
        workspace: '/repo',
        repoRoot: '/repo',
        daemonId: 'daemon-remote',
        userOverrides: {},
        policy: { providerPriority: ['hermes-cli'] },
      }],
    },
    transport,
  };

  const first = JSON.parse(await meshSendTask(ctx as any, { node_id: 'node-remote', session_id: 'session-a', message: 'same task' }));
  const second = JSON.parse(await meshSendTask(ctx as any, { node_id: 'node-remote', session_id: 'session-a', message: 'same task' }));

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.dispatched, false);
  assert.equal(agentCommandCalls, 1);
});

test('mesh_view_queue annotates stale assigned tasks and historical task metadata', async () => {
  const meshId = `mesh-stale-queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staleUpdatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const completedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const queuePath = join(getLedgerDir(), `${meshId}.queue.json`);
  writeFileSync(queuePath, JSON.stringify([
    {
      id: 'task-stale-assigned',
      meshId,
      message: 'old task still assigned',
      status: 'assigned',
      targetNodeId: 'node-old',
      targetSessionId: 'session-old',
      assignedNodeId: 'node-old',
      assignedSessionId: 'session-old',
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    },
    {
      id: 'task-live-assigned',
      meshId,
      message: 'live old task still assigned',
      status: 'assigned',
      targetNodeId: 'node-live',
      targetSessionId: 'session-live',
      assignedNodeId: 'node-live',
      assignedSessionId: 'session-live',
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    },
    {
      id: 'task-completed',
      meshId,
      message: 'done task',
      status: 'completed',
      targetNodeId: 'node-old',
      createdAt: completedAt,
      updatedAt: completedAt,
    },
  ], null, 2));

  const payload = JSON.parse(await meshViewQueue({
    mesh: {
      id: meshId,
      name: 'Stale Queue',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-live',
        workspace: '/repo',
        sessions: [{ id: 'session-live', status: 'idle' }],
        policy: {},
        userOverrides: {},
      }],
    },
    transport: {} as any,
  } as any, {}));

  assert.equal(payload.success, true);
  assert.deepEqual(payload.sourceOfTruth.activeStatuses, ['pending', 'assigned']);
  assert.deepEqual(payload.sourceOfTruth.historicalStatuses, ['completed', 'failed', 'cancelled']);
  assert.equal(payload.summary.totalCount, 3);
  assert.equal(payload.visibleSummary.totalCount, 3);
  assert.deepEqual(payload.activeCounts, { pending: 0, assigned: 2 });
  assert.deepEqual(payload.historicalCounts, { completed: 1, failed: 0, cancelled: 0 });
  assert.deepEqual(payload.visibleActiveCounts, { pending: 0, assigned: 2 });
  assert.deepEqual(payload.visibleHistoricalCounts, { completed: 1, failed: 0, cancelled: 0 });
  assert.equal(payload.activeCount, 2);
  assert.equal(payload.historicalCount, 1);
  assert.equal(payload.staleAssignedCount, 1);
  assert.equal(payload.staleAssignedTasks[0].id, 'task-stale-assigned');
  assert.equal(payload.queueMaintenance.readOnly, true);
  assert.equal(payload.queueMaintenance.mutationPerformed, false);
  assert.equal(payload.queueMaintenance.staleAssignedCount, 1);
  assert.equal(payload.queueMaintenance.oldHistoricalRecordCount, 1);
  assert.equal(payload.queueMaintenance.cleanupCandidateCount, 2);
  assert.deepEqual(payload.queueMaintenance.cleanupCandidates.map((task: any) => task.cleanupClass).sort(), ['old_historical_record', 'stale_assigned']);
  assert.equal(payload.queue[0].taskStatus, 'assigned');
  assert.equal(payload.queue[0].activeTaskId, 'task-stale-assigned');
  assert.equal(payload.queue[0].staleAssigned, true);
  assert.equal(payload.queue[1].taskStatus, 'assigned');
  assert.equal(payload.queue[1].staleAssigned, undefined);
  assert.equal(payload.queue[2].isHistorical, true);
  assert.equal(payload.queue[2].completedAt, completedAt);

  const filteredPayload = JSON.parse(await meshViewQueue({
    mesh: payload.filter ? {
      id: meshId,
      name: 'Stale Queue',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-live',
        workspace: '/repo',
        sessions: [{ id: 'session-live', status: 'idle' }],
        policy: {},
        userOverrides: {},
      }],
    } : undefined,
    transport: {} as any,
  } as any, { status: ['failed', 'completed'] }));
  assert.equal(filteredPayload.success, true);
  assert.deepEqual(filteredPayload.activeCounts, { pending: 0, assigned: 2 });
  assert.deepEqual(filteredPayload.visibleActiveCounts, { pending: 0, assigned: 0 });
  assert.deepEqual(filteredPayload.visibleHistoricalCounts, { completed: 1, failed: 0, cancelled: 0 });
  assert.equal(filteredPayload.staleAssignedCount, 1);
  assert.equal(filteredPayload.queue.length, 1);
  assert.equal(filteredPayload.historicalQueue.length, 1);
  assert.equal(filteredPayload.historicalQueue[0].id, 'task-completed');
});

test('mesh_clone_node upserts clone returned through payload-wrapped live relay shape before immediate resolver use', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  const staleSourceNode = { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} };
  const cloneNode = {
    id: 'node-live-worktree',
    workspace: '/repo-parent/.adhdev-worktrees/mesh/smoke-live-shape',
    repoRoot: '/repo-parent/.adhdev-worktrees/mesh/smoke-live-shape',
    daemonId: 'daemon-source',
    userOverrides: {},
    policy: {},
    isLocalWorktree: true,
    worktreeBranch: 'smoke/live-shape',
    clonedFromNodeId: 'node-source',
  };

  let daemonMeshNodes = [staleSourceNode];
  transport.command = async (command) => {
    if (command === 'get_mesh') {
      return {
        success: true,
        mesh: {
          id: 'mesh-live-payload-relay',
          name: 'Live Payload Relay',
          nodes: daemonMeshNodes,
          updatedAt: new Date().toISOString(),
        },
      };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'clone_mesh_node') {
      daemonMeshNodes = [staleSourceNode, cloneNode];
      return {
        success: true,
        result: {
          success: true,
          messageId: 'msg-live-clone',
          // Fresh cloud relay command_result payloads can expose the daemon
          // command payload under payload instead of another result key.
          payload: {
            requestId: 'req-live-clone',
            success: true,
            source: 'mesh',
            payload: {
              success: true,
              node: cloneNode,
              worktreePath: cloneNode.workspace,
              branch: 'smoke/live-shape',
            },
          },
        },
      };
    }
    if (command === 'git_status') return {
      success: true,
      result: { success: true, result: { status: { isGitRepo: true, branch: 'smoke/live-shape', modified: 0 } } },
    };
    if (command === 'git_diff_summary') return {
      success: true,
      result: { success: true, result: { diffSummary: { files: [], totalInsertions: 0, totalDeletions: 0 } } },
    };
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const mesh = {
    id: 'mesh-live-payload-relay',
    name: 'Live Payload Relay',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [staleSourceNode],
  };
  const ctx = { mesh, transport };

  const cloneText = await meshCloneNode(ctx as any, { source_node_id: 'node-source', branch: 'smoke/live-shape' });
  assert.equal(JSON.parse(cloneText).success, true);
  assert.ok(ctx.mesh.nodes.some(node => node.id === 'node-live-worktree'), 'clone response node should be live-upserted into ctx.mesh');

  const statusText = await meshGitStatus(ctx as any, { node_id: 'node-live-worktree' });
  const status = JSON.parse(statusText);
  assert.equal(status.nodeId, 'node-live-worktree', 'immediate mesh_git_status should resolve returned clone node without relying on stale get_mesh');
  assert.equal(status.status.branch, 'smoke/live-shape');
  assert.deepEqual(status.diff.files, []);
  assert.equal(calls[0].command, 'clone_mesh_node');
  assert.equal(calls[1].command, 'git_status');
  assert.equal(calls[2].command, 'git_diff_summary');
});

test('mesh_git_status and mesh_remove_node refresh ctx.mesh from daemon cache when node was added by clone in another MCP process', async () => {
  // Simulates the live bug: clone_mesh_node ran in a different MCP server process,
  // so the new node exists in the daemon's inlineMeshCache but not in this process's ctx.mesh.
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  const newNode = {
    id: 'node-worktree-new',
    workspace: '/repo/.adhdev-worktrees/mesh/test-branch',
    repoRoot: '/repo/.adhdev-worktrees/mesh/test-branch',
    daemonId: 'daemon-source',
    userOverrides: {},
    policy: {},
    isLocalWorktree: true,
    worktreeBranch: 'test/branch',
    clonedFromNodeId: 'node-source',
  };

  const meshCommands: string[] = [];
  // Daemon has the new node in its cache (get_mesh returns it)
  transport.command = async (cmd, args = {}) => {
    if (cmd === 'get_mesh') {
      return {
        success: true,
        mesh: {
          id: 'mesh-stale',
          name: 'Stale Mesh',
          nodes: [
            { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
            newNode,
          ],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    throw new Error(`unexpected direct command: ${cmd}`);
  };
  transport.meshCommand = async (daemonId, command) => {
    meshCommands.push(command);
    if (command === 'git_status') return {
      success: true,
      result: {
        success: true,
        result: {
          status: {
            workspace: '/repo/.adhdev-worktrees/mesh/test-branch',
            repoRoot: '/repo/.adhdev-worktrees/mesh/test-branch',
            isGitRepo: true,
            branch: 'test/branch',
            staged: 0,
            modified: 1,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            conflictFiles: [],
          },
        },
      },
    };
    if (command === 'git_diff_summary') return {
      success: true,
      result: {
        success: true,
        result: {
          diffSummary: { files: [{ path: 'changed.ts', status: 'modified' }], totalInsertions: 2, totalDeletions: 0 },
        },
      },
    };
    if (command === 'remove_mesh_node') return { success: true, removed: true };
    throw new Error(`unexpected mesh command: ${command}`);
  };

  // ctx.mesh does NOT have node-worktree-new (stale snapshot from process start)
  const mesh = {
    id: 'mesh-stale',
    name: 'Stale Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
    ],
  };
  const ctx = { mesh, transport };

  // mesh_status and mesh_list_nodes should refresh too; coordinators rely on
  // these surfaces to see/select a clone created by a previous MCP process.
  const statusText = await meshStatus(ctx as any);
  const status = JSON.parse(statusText);
  const statusNode = status.nodes.find((n: any) => n.nodeId === 'node-worktree-new');
  assert.ok(statusNode, 'mesh_status should include refreshed worktree node');
  assert.equal(statusNode.health, 'dirty', 'mesh_status should unwrap relayed git_status payload before deriving health');
  assert.equal(statusNode.branch, 'test/branch');
  assert.equal(statusNode.isDirty, true);
  assert.equal(statusNode.uncommittedChanges, 1);
  assert.ok(ctx.mesh.nodes.some(n => n.id === 'node-worktree-new'), 'ctx.mesh refreshed by mesh_status');

  const listText = await meshListNodes(ctx as any);
  const listed = JSON.parse(listText);
  assert.ok(listed.nodes.some((n: any) => n.nodeId === 'node-worktree-new'), 'mesh_list_nodes should include refreshed worktree node');

  // mesh_git_status on the new node should refresh and succeed
  const { meshGitStatus, meshRemoveNode } = await import('../src/tools/mesh-tools.js');
  const gitStatusText = await meshGitStatus(ctx, { node_id: 'node-worktree-new' });
  const gitStatus = JSON.parse(gitStatusText);
  assert.equal(gitStatus.nodeId, 'node-worktree-new', 'git_status should succeed after mesh refresh');
  assert.equal(gitStatus.status.branch, 'test/branch', 'git_status should unwrap nested relayed status payload');
  assert.equal(gitStatus.status.modified, 1);
  assert.deepEqual(gitStatus.diff.files, [{ path: 'changed.ts', status: 'modified' }]);
  // ctx.mesh should now include the new node
  assert.ok(ctx.mesh.nodes.some(n => n.id === 'node-worktree-new'), 'ctx.mesh refreshed with new node');

  // mesh_remove_node on the new node should also succeed
  const removeText = await meshRemoveNode(ctx, { node_id: 'node-worktree-new' });
  assert.equal(JSON.parse(removeText).success, true, 'remove_node should succeed after mesh refresh');
  assert.ok(!ctx.mesh.nodes.some(n => n.id === 'node-worktree-new'), 'node removed from ctx.mesh after remove');
  assert.ok(meshCommands.includes('remove_mesh_node'), 'remove_mesh_node relayed to daemon');
});

test('stale local worktree hits are revalidated against get_mesh before mesh_git_status uses them', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const directCommands: string[] = [];
  transport.command = async (command) => {
    directCommands.push(command);
    if (command === 'get_mesh') {
      return {
        success: true,
        mesh: {
          id: 'mesh-stale-removed',
          name: 'Stale Removed Mesh',
          nodes: [
            { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
          ],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => {
    throw new Error('meshCommand should not run for a removed worktree node');
  };

  const mesh = {
    id: 'mesh-stale-removed',
    name: 'Stale Removed Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        id: 'node-worktree-stale',
        workspace: '/repo/.adhdev-worktrees/mesh/stale',
        repoRoot: '/repo/.adhdev-worktrees/mesh/stale',
        daemonId: 'daemon-source',
        userOverrides: {},
        policy: {},
        isLocalWorktree: true,
        worktreeBranch: 'stale',
        clonedFromNodeId: 'node-source',
      },
      { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
    ],
  };
  const ctx = { mesh, transport };

  await assert.rejects(
    () => meshGitStatus(ctx as any, { node_id: 'node-worktree-stale' }),
    /not a member of mesh 'Stale Removed Mesh'/,
  );
  assert.deepEqual(directCommands, ['get_mesh']);
  assert.deepEqual(ctx.mesh.nodes.map(node => node.id), ['node-source']);
});

test('stale local worktree hits are revalidated before mesh_read_chat falls back to missing-node recovery', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.command = async (command) => {
    if (command === 'get_mesh') {
      return {
        success: true,
        mesh: {
          id: 'mesh-stale-read-chat',
          name: 'Stale Read Chat Mesh',
          nodes: [
            { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
          ],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => {
    throw new Error('meshCommand should not run for a removed worktree node');
  };

  const mesh = {
    id: 'mesh-stale-read-chat',
    name: 'Stale Read Chat Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        id: 'node-worktree-stale',
        workspace: '/repo/.adhdev-worktrees/mesh/stale',
        repoRoot: '/repo/.adhdev-worktrees/mesh/stale',
        daemonId: 'daemon-source',
        userOverrides: {},
        policy: {},
        isLocalWorktree: true,
        worktreeBranch: 'stale',
        clonedFromNodeId: 'node-source',
      },
      { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
    ],
  };
  const ctx = { mesh, transport };

  const chatText = await meshReadChat(ctx as any, { node_id: 'node-worktree-stale', session_id: 'sess-stale', compact: true });
  const chat = JSON.parse(chatText);
  assert.equal(chat.success, false);
  assert.equal(chat.code, 'mesh_removed_node_transcript_unavailable');
  assert.deepEqual(ctx.mesh.nodes.map(node => node.id), ['node-source']);
});

test('mesh status and git status include explicitly configured related repo freshness', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ command: string; workspace?: unknown }> = [];
  transport.command = async (command, args = {}) => {
    calls.push({ command, workspace: args.workspace });
    if (command === 'get_mesh') {
      return { success: false };
    }
    if (command === 'git_status') {
      const workspace = String(args.workspace);
      if (workspace === '/provider/repo') {
        return {
          success: true,
          status: {
            workspace,
            repoRoot: workspace,
            isGitRepo: true,
            branch: 'main',
            ahead: 1,
            behind: 2,
            modified: 1,
            staged: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            conflictFiles: [],
            headCommit: 'abc1234',
            headMessage: 'fix(provider): sample',
          },
        };
      }
      return {
        success: true,
        status: {
          workspace,
          repoRoot: workspace,
          isGitRepo: true,
          branch: 'main',
          ahead: 0,
          behind: 0,
          modified: 0,
          staged: 0,
          untracked: 0,
          deleted: 0,
          renamed: 0,
          hasConflicts: false,
          conflictFiles: [],
          headCommit: 'root123',
          headMessage: 'root commit',
        },
      };
    }
    if (command === 'git_diff_summary') {
      return { success: true, diffSummary: { files: [], totalInsertions: 0, totalDeletions: 0 } };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  transport.meshCommand = async () => {
    throw new Error('unexpected mesh command');
  };

  const mesh = {
    id: 'mesh-related',
    name: 'Related Repo Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        id: 'node-main',
        workspace: '/repo',
        repoRoot: '/repo',
        daemonId: 'daemon-main',
        userOverrides: {},
        policy: {
          relatedRepos: [{ label: 'providers', workspace: '/provider/repo' }],
        },
      },
    ],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-main' };

  const status = JSON.parse(await meshStatus(ctx as any));
  assert.equal(status.nodes[0].relatedRepos[0].label, 'providers');
  assert.equal(status.nodes[0].relatedRepos[0].branch, 'main');
  assert.equal(status.nodes[0].relatedRepos[0].ahead, 1);
  assert.equal(status.nodes[0].relatedRepos[0].behind, 2);
  assert.equal(status.nodes[0].relatedRepos[0].dirty, true);
  assert.equal(status.nodes[0].relatedRepos[0].head, 'abc1234');
  assert.equal(status.nodes[0].relatedRepos[0].lastCommitSummary, 'fix(provider): sample');

  const listed = JSON.parse(await meshListNodes(ctx as any));
  assert.deepEqual(listed.nodes[0].relatedRepos, [{ label: 'providers', workspace: '/provider/repo' }]);

  const gitStatus = JSON.parse(await meshGitStatus(ctx as any, { node_id: 'node-main' }));
  assert.equal(gitStatus.relatedRepos[0].label, 'providers');
  assert.ok(calls.some(call => call.command === 'git_status' && call.workspace === '/provider/repo'));
});

test('local IPC mesh_send_task with explicit session resolves providerType from live status before direct dispatch when cache is cold', async () => {
  const meshId = `mesh-ipc-send-${Date.now()}`;
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const directCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    directCalls.push({ command, args });
    if (command === 'get_status_metadata') {
      return {
        success: true,
        status: {
          sessions: [{ id: 'session-hermes', providerType: 'hermes-cli', providerSessionId: 'provider-1' }],
        },
      };
    }
    if (command === 'agent_command') {
      if (!args.agentType || !args.action) {
        throw new Error('agentType and action required');
      }
      return { success: true };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => {
    throw new Error('unexpected remote mesh command');
  };

  const mesh = {
    id: meshId,
    name: 'IPC Send Task Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-local',
      workspace: '/repo',
      repoRoot: '/repo',
      daemonId: 'daemon-local',
      userOverrides: {},
      policy: {},
    }],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-local' };

  const text = await meshSendTask(ctx as any, {
    node_id: 'node-local',
    session_id: 'session-hermes',
    message: 'run targeted task',
  });
  const result = JSON.parse(text);
  assert.equal(result.success, true);
  assert.equal(result.dispatched, true);
  assert.equal(directCalls.length, 2);
  assert.equal(directCalls[0].command, 'get_status_metadata');
  assert.equal(directCalls[1].command, 'agent_command');
  assert.equal(directCalls[1].args.targetSessionId, 'session-hermes');
  assert.equal(directCalls[1].args.agentType, 'hermes-cli');
  assert.equal(directCalls[1].args.cliType, 'hermes-cli');
  assert.equal(directCalls[1].args.action, 'send_chat');
  assert.equal(directCalls[1].args.message, 'run targeted task');

  const queued = getQueue(meshId);
  assert.equal(queued.length, 0);
});

test('mesh queue management tools cancel and requeue stale assignments without deleting entries', async () => {
  const meshId = `mesh-queue-admin-${Date.now()}`;
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.command = async (command) => {
    if (command === 'trigger_mesh_queue') return { success: true };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => {
    throw new Error('unexpected remote mesh command');
  };
  const ctx = {
    mesh: {
      id: meshId,
      name: 'Queue Admin Mesh',
      repoIdentity: 'example/repo',
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [{
        id: 'node-admin',
        workspace: '/repo-admin',
        repoRoot: '/repo-admin',
        daemonId: 'daemon-admin',
        userOverrides: {},
        policy: {},
      }],
    },
    transport,
  } as any;

  const cancelTarget = enqueueTask(meshId, 'cancel stale task', { targetNodeId: 'node-admin', targetSessionId: 'dead-session' });
  const assigned = enqueueTask(meshId, 'requeue stale task', { targetNodeId: 'node-admin', targetSessionId: 'dead-session' });
  claimNextTask(meshId, 'node-admin', 'dead-session');

  const cancelResult = JSON.parse(await meshQueueCancel(ctx, { task_id: cancelTarget.id, reason: 'dead session' }));
  assert.equal(cancelResult.success, true);
  assert.equal(cancelResult.task.status, 'cancelled');

  const requeueResult = JSON.parse(await meshQueueRequeue(ctx, { task_id: assigned.id, reason: 'retry fresh session' }));
  assert.equal(requeueResult.success, true);
  assert.equal(requeueResult.task.status, 'pending');
  assert.equal(requeueResult.task.assignedSessionId, undefined);
  assert.equal(requeueResult.task.targetSessionId, undefined);

  const queue = getQueue(meshId);
  assert.equal(queue.find(task => task.id === cancelTarget.id)?.status, 'cancelled');
  assert.equal(queue.find(task => task.id === assigned.id)?.status, 'pending');
});

test('mesh tool registry documents the 23 exposed mesh tools including queue cancel/requeue, read-debug, worktree clone/remove/refine, refine config planning, session cleanup, and reconcile-ledger', () => {
  assert.equal(ALL_MESH_TOOLS.length, 23);
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_read_debug'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_clone_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_remove_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_refine_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_refine_config_schema'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_validate_refine_config'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_suggest_refine_config'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_refine_plan'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_cleanup_sessions'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_queue_cancel'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_queue_requeue'));
});
