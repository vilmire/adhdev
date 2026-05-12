import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshApprove, meshCheckpoint, meshCloneNode, meshLaunchSession, meshReadChat, meshReadDebug, meshRemoveNode, meshSendTask, meshStatus, meshListNodes, meshGitStatus, meshQueueCancel, meshQueueRequeue, ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { enqueueTask, getQueue, claimNextTask } from '@adhdev/daemon-core';

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
  const ctx = { mesh, transport };

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
    launchedByCoordinator: true,
  });

  const removeText = await meshRemoveNode(ctx, { node_id: 'node-worktree' });
  assert.equal(JSON.parse(removeText).success, true);
  assert.ok(!ctx.mesh.nodes.some(node => node.id === 'node-worktree'));
  assert.equal(calls[3].daemonId, 'daemon-source');
  assert.equal(calls[3].command, 'remove_mesh_node');
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
  assert.equal(calls[2].command, 'read_chat');
  assert.equal(calls[2].args.agentType, 'hermes-cli');
  assert.equal(calls[2].args.providerType, 'hermes-cli');
  assert.equal(calls[2].args.providerSessionId, 'provider-cached');
  assert.equal(calls[2].args.workspace, '/repo');
  assert.equal(calls[2].args.tailLimit, 5);
  assert.equal(readPayload.success, true);
  assert.equal(readPayload.status, 'idle');
  assert.deepEqual(readPayload.messages, [{ role: 'assistant', content: 'delegated result' }]);
  assert.equal(readPayload.providerSessionId, 'provider-cached');

  await meshReadChat(ctx as any, { node_id: 'node-provider', session_id: 'runtime-cached', provider_session_id: 'provider-explicit-read' });
  assert.equal(calls[3].args.providerSessionId, 'provider-explicit-read');
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
  assert.equal(payload.messages.length, 2);
  assert.deepEqual(payload.messages.map((m: any) => m.content), [
    'do the task',
    'Final summary: implemented V1 and tests pass',
  ]);
  assert.equal(payload.summary, 'Final summary: implemented V1 and tests pass');
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

  transport.command = async (command) => {
    if (command === 'get_mesh') {
      return {
        success: true,
        mesh: {
          id: 'mesh-live-payload-relay',
          name: 'Live Payload Relay',
          nodes: [staleSourceNode],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'clone_mesh_node') {
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

test('local IPC mesh_send_task with explicit session pushes directly instead of stranding a targeted queue item', async () => {
  const meshId = `mesh-ipc-send-${Date.now()}`;
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const directCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    directCalls.push({ command, args });
    if (command === 'agent_command') return { success: true };
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
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].command, 'agent_command');
  assert.equal(directCalls[0].args.targetSessionId, 'session-hermes');
  assert.equal(directCalls[0].args.action, 'send_chat');
  assert.equal(directCalls[0].args.message, 'run targeted task');

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

test('mesh tool registry documents the 18 exposed mesh tools including queue cancel/requeue, read-debug, worktree clone/remove/refine, and session cleanup', () => {
  assert.equal(ALL_MESH_TOOLS.length, 18);
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_read_debug'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_clone_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_remove_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_refine_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_cleanup_sessions'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_queue_cancel'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_queue_requeue'));
});
