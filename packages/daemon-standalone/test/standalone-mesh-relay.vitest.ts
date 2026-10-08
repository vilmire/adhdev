/**
 * Standalone `mesh_relay_command` contract (src/standalone-mesh-relay.ts): the
 * same result shapes the cloud IPC relay gives mcp-server. The end-to-end relay
 * over a real WS link is covered by standalone-mesh-two-daemons.vitest.ts.
 */
import { describe, expect, it, vi } from 'vitest';

// Before daemon-core loads: its logger resolves the config dir at import time.
vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-mesh-relay-'));
});

import { P2pRelayFailureError } from '@adhdev/daemon-core';
import { runStandaloneMeshRelay, readMeshRelayRequest } from '../src/standalone-mesh-relay.js';

const LOCAL = 'standalone_mach_aaaa';
const PEER = 'standalone_mach_bbbb';

function deps(overrides: Partial<Parameters<typeof runStandaloneMeshRelay>[0]> = {}) {
  return {
    localDaemonId: LOCAL,
    executeLocal: vi.fn(async (command: string) => ({ success: true, ranOn: 'local', command })),
    dispatchRemote: vi.fn(async (daemonId: string, command: string) => ({ success: true, ranOn: daemonId, command })),
    ...overrides,
  };
}

describe('runStandaloneMeshRelay', () => {
  it('sends a remote target over the mesh link with the relayed args', async () => {
    const d = deps();
    const result = await runStandaloneMeshRelay(d, { targetDaemonId: PEER, command: 'git_status', args: { workspace: '/w' } });
    expect(result).toEqual({ success: true, ranOn: PEER, command: 'git_status' });
    expect(d.dispatchRemote).toHaveBeenCalledWith(PEER, 'git_status', { workspace: '/w' });
    expect(d.executeLocal).not.toHaveBeenCalled();
  });

  it('runs a self target (any id form) locally instead of self-dialing', async () => {
    const d = deps();
    for (const form of [LOCAL, 'daemon_mach_aaaa', 'mach_aaaa']) {
      const result = await runStandaloneMeshRelay(d, { targetDaemonId: form, command: 'read_chat', args: { sessionId: 's' } });
      expect(result).toMatchObject({ ranOn: 'local', command: 'read_chat' });
    }
    expect(d.dispatchRemote).not.toHaveBeenCalled();
  });

  it('keeps a remote failure a failure (never wrapped as success)', async () => {
    const d = deps({ dispatchRemote: vi.fn(async () => ({ success: false, error: 'Live session not found' })) });
    expect(await runStandaloneMeshRelay(d, { targetDaemonId: PEER, command: 'read_chat' }))
      .toEqual({ success: false, error: 'Live session not found' });
  });

  it('wraps a non-object remote result like the cloud relay', async () => {
    const d = deps({ dispatchRemote: vi.fn(async () => 'ok') });
    expect(await runStandaloneMeshRelay(d, { targetDaemonId: PEER, command: 'x' })).toEqual({ success: true, result: 'ok' });
  });

  it('turns a typed transport failure into the structured relay-failure payload', async () => {
    const d = deps({
      dispatchRemote: vi.fn(async () => {
        throw new P2pRelayFailureError('Mesh peer not connected', { code: 'p2p_not_connected', meshCode: 'PEER_NOT_CONNECTED' });
      }),
    });
    const result = await runStandaloneMeshRelay(d, { targetDaemonId: PEER, command: 'git_status' });
    expect(result).toMatchObject({
      success: false,
      transport: 'p2p',
      code: 'p2p_not_connected',
      recoverable: true,
      command: 'git_status',
      targetDaemonId: PEER,
      meshCode: 'PEER_NOT_CONNECTED',
    });
  });

  it('rethrows an untyped failure and refuses without a mesh link', async () => {
    await expect(runStandaloneMeshRelay(deps({ dispatchRemote: vi.fn(async () => { throw new Error('boom'); }) }), { targetDaemonId: PEER, command: 'x' }))
      .rejects.toThrow('boom');
    await expect(runStandaloneMeshRelay(deps({ dispatchRemote: null }), { targetDaemonId: PEER, command: 'x' }))
      .rejects.toThrow(/no mesh link/);
  });
});

describe('readMeshRelayRequest', () => {
  it('requires a target and a command, defaults args, and refuses a nested relay', () => {
    expect(() => readMeshRelayRequest({ command: 'x' })).toThrow(/requires targetDaemonId and command/);
    expect(() => readMeshRelayRequest({ targetDaemonId: PEER })).toThrow(/requires targetDaemonId and command/);
    expect(readMeshRelayRequest({ targetDaemonId: PEER, command: 'x' })).toEqual({ targetDaemonId: PEER, command: 'x', args: {} });
    expect(() => readMeshRelayRequest({ targetDaemonId: PEER, command: 'mesh_relay_command' })).toThrow(/cannot relay itself/);
  });
});
