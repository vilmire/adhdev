import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { dispatchMeshOneshotWithAckRetry, __setReconnectWaitMsForTests } from '../../src/commands/mesh-oneshot-retry.js'
import { P2pRelayFailureError } from '../../src/mesh/p2p-relay-failure.js'

// Shrink the reconnect wait so "peer never reconnects" cases run in ms, not 25s.
beforeEach(() => { __setReconnectWaitMsForTests(200, 20) })
afterEach(() => { __setReconnectWaitMsForTests() })

// RETRY-BOUNDS (0-retry extreme, live 2026-10-10): an ops script fired
// restart_daemon_node ONCE at a node whose ICE link had just dropped. The
// node's own ICE-disconnect detection takes 15-30s to recover; the P2P ACK
// timeout is a flat 10s — so a command landing in that window always times
// out even though the node is healthy again well within the ACK deadline.
// With zero retries, that single shot was gone for good.
//
// dispatchMeshOneshotWithAckRetry closes this WITHOUT becoming a blanket
// retry-everything wrapper: restart_daemon_node is not idempotent, so it only
// retries the ONE failure mode that provably never reached a working handler
// (ACK_TIMEOUT) — see the module header for the full rationale.

function ackTimeoutError() {
  return new P2pRelayFailureError('not acknowledged', { command: 'restart_daemon_node', targetDaemonId: 'daemon_x', meshCode: 'ACK_TIMEOUT' })
}
function requestTimeoutError() {
  return new P2pRelayFailureError('timed out', { command: 'restart_daemon_node', targetDaemonId: 'daemon_x', meshCode: 'REQUEST_TIMEOUT' })
}

describe('dispatchMeshOneshotWithAckRetry — the 0-retry extreme', () => {
  it('retries on ACK_TIMEOUT (provably never reached a handler) and succeeds once the peer is back', async () => {
    let calls = 0
    const dispatch = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw ackTimeoutError()
      return { success: true }
    })
    const getConnectionStatus = vi.fn(() => ({ state: 'connected' }))

    const result = await dispatchMeshOneshotWithAckRetry(dispatch, {
      command: 'restart_daemon_node', daemonId: 'daemon_x', getConnectionStatus,
    })

    expect(result).toEqual({ success: true })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on REQUEST_TIMEOUT — the peer may already be processing it (not idempotency-safe)', async () => {
    const dispatch = vi.fn(async () => { throw requestTimeoutError() })

    await expect(
      dispatchMeshOneshotWithAckRetry(dispatch, { command: 'restart_daemon_node', daemonId: 'daemon_x' }),
    ).rejects.toThrow('timed out')
    // Exactly ONE attempt — a non-ACK failure is terminal on first try, by design.
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on an arbitrary non-mesh error (e.g. a thrown string/plain Error)', async () => {
    const dispatch = vi.fn(async () => { throw new Error('some unrelated failure') })
    await expect(
      dispatchMeshOneshotWithAckRetry(dispatch, { command: 'restart_daemon_node', daemonId: 'daemon_x' }),
    ).rejects.toThrow('some unrelated failure')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('is bounded: repeated ACK_TIMEOUT does not retry forever', async () => {
    const dispatch = vi.fn(async () => { throw ackTimeoutError() })
    const getConnectionStatus = vi.fn(() => null) // never reconnects

    await expect(
      dispatchMeshOneshotWithAckRetry(dispatch, {
        command: 'restart_daemon_node', daemonId: 'daemon_x', getConnectionStatus,
      }),
    ).rejects.toThrow('not acknowledged')
    // 1 initial attempt + MAX_EXTRA_ATTEMPTS(2) = 3 total, never unbounded.
    expect(dispatch).toHaveBeenCalledTimes(3)
  })

  it('without a connection-status getter (older daemon), still retries ACK_TIMEOUT rather than refusing', async () => {
    let calls = 0
    const dispatch = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw ackTimeoutError()
      return { success: true }
    })
    const result = await dispatchMeshOneshotWithAckRetry(dispatch, { command: 'restart_daemon_node', daemonId: 'daemon_x' })
    expect(result).toEqual({ success: true })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('the final attempt propagates its ACK_TIMEOUT unchanged when the budget is exhausted (terminal state is reported, not swallowed)', async () => {
    const dispatch = vi.fn(async () => { throw ackTimeoutError() })
    let rejection: unknown
    try {
      await dispatchMeshOneshotWithAckRetry(dispatch, { command: 'restart_daemon_node', daemonId: 'daemon_x', getConnectionStatus: () => null })
    } catch (e) {
      rejection = e
    }
    expect(rejection).toBeInstanceOf(P2pRelayFailureError)
    expect((rejection as P2pRelayFailureError).meshCode).toBe('ACK_TIMEOUT')
  })
})
