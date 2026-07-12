import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { commandForNode } from '../src/tools/mesh-tools-internal.js';
import { argsCarryStatusProbeMarker, STATUS_PROBE_ARG_KEY } from '@adhdev/mesh-shared';

// OFFLINE-NODE-STATUS-REFRESH: a status-origin probe (explicit_refresh / mesh_status) must
// stamp the status-probe marker into the relayed args so the daemon-cloud relay handler
// grants the SHORT connect-wait budget for an offline peer. A non-status-origin relay must
// NOT carry the marker (it keeps the full connect deadline). Local-transport calls never
// carry the marker (no relay / no connect wait). This pins commandForNode's behaviour.

function makeCtx() {
  const mesh = {
    id: 'mesh-status-probe',
    name: 'Status Probe',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
  };
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const meshCalls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  const localCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.meshCommand = async (daemonId, command, args = {}) => {
    meshCalls.push({ daemonId, command, args });
    return { success: true, status: { isGitRepo: true } };
  };
  transport.command = async (command, args = {}) => {
    localCalls.push({ command, args });
    return { success: true, status: { isGitRepo: true } };
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' };
  return { ctx, meshCalls, localCalls };
}

// A REMOTE node (daemonId !== localDaemonId) → relayed via meshCommand.
const remoteNode = {
  id: 'node-remote',
  workspace: '/remote/repo',
  repoRoot: '/remote/repo',
  daemonId: 'daemon_mach_remote',
  machineId: 'machine-remote',
  userOverrides: {},
  policy: { providerPriority: ['claude-cli'] },
  sessions: [],
};

test('commandForNode({ statusProbe: true }) relays git_status WITH the status-origin marker', async () => {
  const { ctx, meshCalls } = makeCtx();
  await commandForNode(ctx as any, remoteNode as any, 'git_status', { workspace: '/remote/repo', refreshUpstream: true }, { statusProbe: true });
  assert.equal(meshCalls.length, 1);
  assert.equal(meshCalls[0].command, 'git_status');
  assert.equal(argsCarryStatusProbeMarker(meshCalls[0].args), true);
  // Real args survive alongside the marker.
  assert.equal(meshCalls[0].args.workspace, '/remote/repo');
  assert.equal(meshCalls[0].args.refreshUpstream, true);
});

test('commandForNode without the flag relays WITHOUT the marker (full connect deadline preserved)', async () => {
  const { ctx, meshCalls } = makeCtx();
  await commandForNode(ctx as any, remoteNode as any, 'git_status', { workspace: '/remote/repo' });
  assert.equal(meshCalls.length, 1);
  assert.equal(argsCarryStatusProbeMarker(meshCalls[0].args), false);
  assert.equal(STATUS_PROBE_ARG_KEY in meshCalls[0].args, false);
});

test('commandForNode does not mutate the caller-supplied args object', async () => {
  const { ctx } = makeCtx();
  const args = { workspace: '/remote/repo', refreshUpstream: true };
  await commandForNode(ctx as any, remoteNode as any, 'git_status', args, { statusProbe: true });
  assert.equal(STATUS_PROBE_ARG_KEY in args, false);
});
