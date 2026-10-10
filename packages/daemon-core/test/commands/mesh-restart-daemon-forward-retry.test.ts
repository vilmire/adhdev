import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * RETRY-BOUNDS (0-retry extreme, live 2026-10-10): restart_daemon_node forwarded
 * to a REMOTE node's owning daemon used to make exactly ONE dispatchMeshCommand
 * call and surface whatever it got — including an ACK_TIMEOUT from a node whose
 * ICE link had just dropped and would have reconnected well within the retry's
 * own bounded wait. This file exercises the actual mesh-restart.ts forward
 * branch (not just the standalone mesh-oneshot-retry.ts unit), proving the
 * wiring is live: ACK_TIMEOUT retries (and can succeed), REQUEST_TIMEOUT does
 * not (idempotency), and the retry count is bounded either way.
 */

let configDir = ''

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => configDir,
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))

const { daemonUpgrade, daemonRestart } = vi.hoisted(() => ({
  daemonUpgrade: vi.fn(async () => ({ success: true, upgraded: false, alreadyLatest: true }) as any),
  daemonRestart: vi.fn(async () => ({ success: true, restarted: true, restarting: true, mode: 'restart' }) as any),
}))
vi.mock('../../src/commands/low-family/daemon-lifecycle.js', () => ({
  daemonLifecycleHandlers: { daemon_upgrade: daemonUpgrade, daemon_restart: daemonRestart },
}))

import { meshRestartHandlers } from '../../src/commands/med-family/mesh-restart.js'
import { __setReconnectWaitMsForTests } from '../../src/commands/mesh-oneshot-retry.js'
import { P2pRelayFailureError } from '../../src/mesh/p2p-relay-failure.js'

const MESH_ID = 'mesh-restart-forward-test'
const SELF_DAEMON_ID = 'daemon_mach_self'
const REMOTE_DAEMON_ID = 'daemon_mach_remote'

function ackTimeoutError() {
  return new P2pRelayFailureError('not acknowledged', { command: 'restart_daemon_node', targetDaemonId: REMOTE_DAEMON_ID, meshCode: 'ACK_TIMEOUT' })
}
function requestTimeoutError() {
  return new P2pRelayFailureError('timed out', { command: 'restart_daemon_node', targetDaemonId: REMOTE_DAEMON_ID, meshCode: 'REQUEST_TIMEOUT' })
}

function makeCtx(dispatchMeshCommand: any, getMeshPeerConnectionStatus?: any) {
  return {
    deps: {
      statusInstanceId: SELF_DAEMON_ID,
      dispatchMeshCommand,
      getMeshPeerConnectionStatus,
    },
    getMeshForCommand: vi.fn(async () => ({
      mesh: { nodes: [{ id: 'node-remote', daemonId: REMOTE_DAEMON_ID }] },
      inline: true,
      source: 'inline_cache',
    })),
  } as any
}

// No _meshDirectDispatch flag here — this is what makes the handler take the
// FORWARD branch (isRemote) instead of executing locally.
function remoteArgs(extra: Record<string, unknown> = {}) {
  return { meshId: MESH_ID, nodeId: 'node-remote', ...extra }
}

const call = (ctx: any, args: any) => meshRestartHandlers.restart_daemon_node(ctx, args) as Promise<any>

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'adhdev-mesh-restart-forward-test-'))
  daemonUpgrade.mockClear()
  daemonRestart.mockClear()
  __setReconnectWaitMsForTests(50, 10)
})
afterEach(() => {
  __setReconnectWaitMsForTests()
  if (configDir && existsSync(configDir)) rmSync(configDir, { recursive: true, force: true })
  configDir = ''
})

describe('restart_daemon_node — remote forward retries ACK_TIMEOUT but not REQUEST_TIMEOUT', () => {
  it('ACK_TIMEOUT on the first forward attempt retries and succeeds once the peer answers', async () => {
    let calls = 0
    const dispatchMeshCommand = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw ackTimeoutError()
      return { payload: { success: true, restarted: true, mode: 'upgrade' } }
    })
    const getMeshPeerConnectionStatus = vi.fn(() => ({ state: 'connected' }))

    const result = await call(makeCtx(dispatchMeshCommand, getMeshPeerConnectionStatus), remoteArgs())

    expect(dispatchMeshCommand).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ success: true, restarted: true })
    // Confirms the forward actually targeted the remote daemon, both times.
    for (const callArgs of dispatchMeshCommand.mock.calls) {
      expect(callArgs[0]).toBe(REMOTE_DAEMON_ID)
      expect(callArgs[1]).toBe('restart_daemon_node')
    }
  })

  it('REQUEST_TIMEOUT propagates immediately — no retry, because the peer may already be restarting', async () => {
    const dispatchMeshCommand = vi.fn(async () => { throw requestTimeoutError() })

    await expect(call(makeCtx(dispatchMeshCommand), remoteArgs())).rejects.toThrow('timed out')
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
  })

  it('persistent ACK_TIMEOUT is bounded — the forward does not retry forever', async () => {
    const dispatchMeshCommand = vi.fn(async () => { throw ackTimeoutError() })
    const getMeshPeerConnectionStatus = vi.fn(() => null) // never reconnects

    await expect(call(makeCtx(dispatchMeshCommand, getMeshPeerConnectionStatus), remoteArgs())).rejects.toThrow('not acknowledged')
    // 1 initial + 2 extra = 3 total, matching mesh-oneshot-retry's MAX_EXTRA_ATTEMPTS.
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(3)
  })

  it('a healthy single-shot forward is unaffected (no retry overhead on the common path)', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({ payload: { success: true, restarted: false, alreadyLatest: true } }))
    const result = await call(makeCtx(dispatchMeshCommand), remoteArgs())
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, restarted: false })
  })
})
