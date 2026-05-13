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
      expect(classified.nextAction).toContain('P2P');
      expect(classified.noFallbackReason).toContain('WS/REST');
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
    expect(payload.nextAction).toContain('bounded retry');
    expect(payload.noFallbackReason).toContain('P2P-only');
    expect(payload.targetDaemonId).toBe('daemon-remote');
    expect(payload.command).toBe('agent_command');
  });
});
