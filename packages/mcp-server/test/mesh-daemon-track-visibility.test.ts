import { expect, it } from 'vitest';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshRestartDaemon, meshStatus } from '../src/tools/mesh-tools.js';
import { extractDaemonBuildInfo } from '../src/tools/mesh-tools-internal.js';

const cleanGit = {
  isGitRepo: true,
  isDirty: false,
  branch: 'main',
  headCommit: 'abc1234',
  ahead: 0,
  behind: 0,
  submodules: [],
};

function buildMesh() {
  return {
    id: 'mesh-track-visibility',
    name: 'Track visibility',
    repoIdentity: 'vilmire/adhdev',
    defaultBranch: 'main',
    policy: { schedulingStrategy: 'fitness' },
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-mainpc-stable',
      workspace: 'C:\\src\\adhdev',
      repoRoot: 'C:\\src\\adhdev',
      daemonId: 'daemon_mainpc_stable',
      machineId: 'machine-mainpc-stable',
      userOverrides: {},
      policy: { providerPriority: ['codex-cli'] },
    }],
  };
}

function makeIpcCtx(responder: (daemonId: string, command: string) => unknown) {
  const mesh = buildMesh();
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.command = async command => responder('daemon-coordinator-preview', command);
  transport.meshCommand = async (daemonId, command) => responder(daemonId, command);
  return {
    mesh,
    transport,
    localDaemonId: 'daemon-coordinator-preview',
    localMachineId: 'machine-coordinator-preview',
    coordinatorHostname: 'preview-host',
  };
}

it('mesh_status exposes the release track explicitly under daemonBuilds', async () => {
  const ctx = makeIpcCtx((_daemonId, command) => {
    if (command === 'get_mesh') return { success: true, mesh: buildMesh() };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'git_status') return { success: true, status: cleanGit };
    if (command === 'get_status_metadata') {
      return {
        success: true,
        status: { instanceId: 'daemon_mainpc_stable', sessions: [] },
        daemonBuild: {
          commit: 'abc1234abc1234',
          commitShort: 'abc1234',
          version: '1.0.49-rc.2',
          track: 'stable',
        },
      };
    }
    return { success: true };
  });

  const status = JSON.parse(await meshStatus(ctx as any));

  expect(status.daemonBuilds['daemon_mainpc_stable'].track).toBe('stable');
  // The rc suffix is deliberately present: track identity came from the daemon,
  // not from guessing based on its version string.
  expect(status.daemonBuilds['daemon_mainpc_stable'].version).toBe('1.0.49-rc.2');
});

it('a legacy daemon with no track is reported as unknown, never assumed stable', () => {
  const build = extractDaemonBuildInfo({
    daemonBuild: { commit: 'def5678def5678', commitShort: 'def5678', version: '1.0.49' },
  });

  expect(build?.track).toBe('unknown');
});

it('incident regression: stable mesh daemon vs preview upgrade target is loud and fail-open', async () => {
  const calls: Array<{ daemonId: string; command: string }> = [];
  const ctx = makeIpcCtx((daemonId, command) => {
    calls.push({ daemonId, command });
    if (command === 'get_mesh') return { success: true, mesh: buildMesh() };
    if (command === 'get_status_metadata') {
      return {
        success: true,
        status: { instanceId: 'daemon_mainpc_stable', sessions: [] },
        daemonBuild: {
          commit: 'stable123',
          commitShort: 'stable1',
          version: '1.0.49-rc.2',
          track: 'stable',
        },
      };
    }
    if (command === 'restart_daemon_node') {
      // Reproduce the observed split: mesh status came from the stable daemon,
      // while the lifecycle operation was accepted by the preview build.
      return {
        success: true,
        upgraded: true,
        outcome: 'scheduled',
        channel: 'preview',
        npmTag: 'next',
        restartTargetDaemon: {
          daemonId: 'daemon-coordinator-preview',
          track: 'preview',
          npmTag: 'next',
        },
      };
    }
    return { success: true };
  });

  const result = JSON.parse(await meshRestartDaemon(ctx as any, {
    node_id: 'node-mainpc-stable',
    mode: 'upgrade',
  }));

  expect(result.success, 'track mismatch must not block the upgrade').toBe(true);
  expect(result.outcome).toBe('scheduled');
  expect(result.meshAttachedDaemon).toEqual({
    daemonId: 'daemon_mainpc_stable',
    configuredDaemonId: 'daemon_mainpc_stable',
    track: 'stable',
  });
  expect(result.restartTargetDaemon).toEqual({
    daemonId: 'daemon-coordinator-preview',
    track: 'preview',
    npmTag: 'next',
  });
  expect(result.daemonMismatch).toBe(true);
  expect(result.trackMismatch).toBe(true);
  expect(result.trackWarning).toMatch(/DAEMON\/TRACK MISMATCH/);
  expect(result.trackWarning).toMatch(/stable/);
  expect(result.trackWarning).toMatch(/preview/);
  expect(calls.some(call => call.command === 'get_status_metadata'), 'restart must observe the mesh-attached daemon before acting').toBe(true);
  expect(calls.some(call => call.command === 'restart_daemon_node'), 'upgrade remains fail-open and is still issued').toBe(true);
});
