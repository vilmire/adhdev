import { describe, expect, it } from 'vitest';

import {
  buildP2pRelayFailurePayload,
  classifyP2pRelayFailure,
  isP2pRelayTransportFailure,
} from '../../src/mesh/p2p-relay-failure.js';

describe('P2P relay failure classification', () => {
  it('classifies unavailable/closed/timeout relay errors as recoverable P2P transport failures', () => {
    const cases = [
      new Error('P2P Mesh is not available (node-datachannel missing). Strict P2P mode requires native dependencies.'),
      new Error("P2P DataChannel command 'launch_cli' to daemon-remote timed out after 30s"),
      new Error('P2P state changed to closed'),
      new Error('DataChannel is not connected'),
      new Error('No route to target daemon over P2P relay'),
      { error: 'target daemon offline during mesh_relay_command' },
    ];

    for (const error of cases) {
      const classified = classifyP2pRelayFailure(error, { command: 'launch_cli', targetDaemonId: 'daemon-target' });
      expect(classified.recoverable).toBe(true);
      expect(classified.retryRecommended).toBe(true);
      expect(classified.transport).toBe('p2p');
      expect(classified.nextAction).toContain('connection');
      expect(classified.noFallbackReason).toContain('no cloud/WS relay fallback');
      expect(isP2pRelayTransportFailure(error)).toBe(true);
    }
  });

  it('does not classify provider or validation logic errors as recoverable P2P failures', () => {
    const cases = [
      new Error('provider launch failed: no inference provider configured'),
      new Error('mesh_relay_command requires targetDaemonId and command'),
      new Error('Node policy providerPriority is empty'),
      new Error('Permission denied while creating git worktree'),
    ];

    for (const error of cases) {
      const classified = classifyP2pRelayFailure(error, { command: 'launch_cli' });
      expect(classified.recoverable).toBe(false);
      expect(classified.retryRecommended).toBe(false);
      expect(classified.code).toBe('mesh_logic_or_provider_failure');
      expect(isP2pRelayTransportFailure(error)).toBe(false);
    }
  });

  it('builds a coordinator-facing failure payload with explicit no-fallback guidance', () => {
    const payload = buildP2pRelayFailurePayload(
      new Error("P2P DataChannel command 'agent_command' to daemon-remote timed out after 30s"),
      { command: 'agent_command', targetDaemonId: 'daemon-remote' },
    );

    expect(payload.success).toBe(false);
    expect(payload.recoverable).toBe(true);
    expect(payload.code).toBe('p2p_timeout');
    expect(payload.transport).toBe('p2p');
    expect(payload.retryRecommended).toBe(true);
    expect(payload.nextAction).toContain('recoverable');
    expect(payload.noFallbackReason).toContain('no cloud/WS relay fallback');
    expect(payload.targetDaemonId).toBe('daemon-remote');
    expect(payload.command).toBe('agent_command');
  });

  it('keeps compatibility with the exact legacy 2000ms probe-race text', () => {
    const classified = classifyP2pRelayFailure(
      new Error('Peer daemon_abc not connected within 2000ms (probe gave up; background reconnect continues)'),
    );
    expect(classified).toEqual(expect.objectContaining({
      code: 'p2p_not_connected',
      transport: 'p2p',
      recoverable: true,
      retryRecommended: true,
    }));
  });

  it('prefers structured P2P fields over failure prose', () => {
    const classified = classifyP2pRelayFailure({
      message: 'opaque relay rejection',
      code: 'p2p_daemon_offline',
      reason: 'daemon_mesh_target_offline',
      transport: 'p2p',
      recoverable: true,
      retryRecommended: true,
      meshCode: 'SIGNAL_TARGET_OFFLINE',
    });
    expect(classified).toEqual(expect.objectContaining({
      code: 'p2p_daemon_offline',
      reason: 'daemon_mesh_target_offline',
      transport: 'p2p',
      recoverable: true,
      retryRecommended: true,
    }));
  });

  it('classifies bare local daemon IPC timeouts as recoverable local_ipc timeouts (never P2P disconnect or unrecoverable logic failure)', () => {
    const ipcErr = Object.assign(
      new Error("Daemon IPC command='git_status' workspace='/Users/dev/worktree' timed out after 45s (requestId=mcp_1792434165424_abc123)"),
      { ipcTimeout: true },
    );
    const classified = classifyP2pRelayFailure(ipcErr, { command: 'git_status' });
    expect(classified).toEqual(expect.objectContaining({
      code: 'ipc_command_timeout',
      reason: 'local_daemon_ipc_timeout',
      transport: 'local_ipc',
      recoverable: true,
      retryRecommended: true,
    }));
    expect(classified.noFallbackReason).toContain('Do not treat this timeout as a P2P disconnection, an offline node, or a dirty working tree');
    expect(isP2pRelayTransportFailure(ipcErr)).toBe(false);

    // Relayed P2P timeout over IPC still classifies as p2p_timeout on p2p transport
    const relayedErr = Object.assign(
      new Error("Daemon IPC command='mesh_relay_command' relayedCommand='git_status' targetDaemonId='daemon_remote' timed out after 120s (requestId=mcp_1792434165424_rel456)"),
      { ipcTimeout: true, ipcCommand: 'mesh_relay_command', ipcRelayedCommand: 'git_status', ipcTargetDaemonId: 'daemon_remote' },
    );
    const relayedClassified = classifyP2pRelayFailure(relayedErr, { command: 'git_status', targetDaemonId: 'daemon_remote' });
    expect(relayedClassified.code).toBe('p2p_timeout');
    expect(relayedClassified.transport).toBe('p2p');
    expect(isP2pRelayTransportFailure(relayedErr)).toBe(true);
  });

  it('does not misclassify local IPC timeouts as P2P when workspace or nodeId paths contain substrings like "ice", "peer", or "p2p"', () => {
    for (const workspace of [
      '/Users/dev/monorepo/services',
      '/Users/dev/peer-tools/workspace',
      '/Users/dev/webrtc-p2p-datachannel-lab',
    ]) {
      const ipcErr = Object.assign(
        new Error(`Daemon IPC command='git_status' nodeId='node_peer_service' workspace='${workspace}' timed out after 45s (requestId=mcp_1792434165424_path)`),
        { ipcTimeout: true, ipcCommand: 'git_status' },
      );
      const classified = classifyP2pRelayFailure(ipcErr, { command: 'git_status' });
      expect(classified.code).toBe('ipc_command_timeout');
      expect(classified.transport).toBe('local_ipc');
      expect(isP2pRelayTransportFailure(ipcErr)).toBe(false);

      // Even if custom Error properties are stripped across a serialization boundary,
      // diagnostic workspace/nodeId tokens in the message must not trigger P2P classification.
      const serializedErr = new Error(ipcErr.message);
      const classifiedFromMessage = classifyP2pRelayFailure(serializedErr, { command: 'git_status' });
      expect(classifiedFromMessage.code).toBe('ipc_command_timeout');
      expect(classifiedFromMessage.transport).toBe('local_ipc');
    }
  });
});
