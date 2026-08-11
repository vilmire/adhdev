// ---------------------------------------------------------------------------
// TOMBSTONE-LEDGER-BRIDGE — session-host tombstone → mesh ledger.
//
// The gap under test: an externally-killed mesh session (SIGTERM from outside
// the mesh) used to leave NO ledger entry, so the death read as an unexplained
// blank stretch in the record. The only `session_stopped` writer was the
// operator-cleanup path, so "the mesh stopped it" and "something killed it"
// were indistinguishable from the ledger alone.
//
// The load-bearing assertion is the LAST describe block: reading only the
// ledger, an operator cleanup and an external kill must be separable.
//
// Reference incident (2026-08-11): coordinator session 249e9979 —
//   exitCode 143, signal 0, previousLifecycle 'running',
//   terminatedAt 05:06:34.099Z, lastOutputAt 05:06:33.986Z (113ms silent).
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import type { SessionTermination } from '@adhdev/session-host-core'

// Isolate ledger file I/O to a per-run temp dir.
const testTmpDir = path.join(tmpdir(), `adhdev-termination-bridge-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-host-machine' }),
}))

import {
  buildMeshTerminationStopPayload,
  classifyMeshTerminationStop,
  recordMeshSessionTerminationStop,
  resolveMeshTerminationBinding,
  resolveTerminationSignal,
} from '../../src/mesh/mesh-termination-bridge.js'
import { appendLedgerEntry, isIntentionalCleanupStopEntry, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

/** The real 249e9979 tombstone, field for field. */
const SIGTERM_TERMINATION: SessionTermination = {
  exitCode: 143,
  signal: 0,
  reason: 'failed',
  lifecycle: 'failed',
  terminatedAt: Date.parse('2026-08-11T05:06:34.099Z'),
  previousLifecycle: 'running',
  lastOutputAt: Date.parse('2026-08-11T05:06:33.986Z'),
}

describe('resolveTerminationSignal', () => {
  it('decodes a 128+N exit code when signal is 0 (the 143 → SIGTERM case)', () => {
    // This is the whole reason the ledger can say SIGTERM: node-pty reported
    // signal 0 and encoded the signal in the exit code instead.
    expect(resolveTerminationSignal(SIGTERM_TERMINATION)).toBe(15)
  })

  it('prefers an explicit non-zero signal over the exit code', () => {
    expect(resolveTerminationSignal({ ...SIGTERM_TERMINATION, signal: 9 })).toBe(9)
  })

  it('does not read an ordinary failure exit code as a signal', () => {
    expect(resolveTerminationSignal({ ...SIGTERM_TERMINATION, exitCode: 1 })).toBeNull()
    // 128 itself is not a signal encoding, and >159 is out of the band.
    expect(resolveTerminationSignal({ ...SIGTERM_TERMINATION, exitCode: 128 })).toBeNull()
    expect(resolveTerminationSignal({ ...SIGTERM_TERMINATION, exitCode: 200 })).toBeNull()
  })
})

describe('classifyMeshTerminationStop', () => {
  it('classifies an external SIGTERM as unintentional external_signal', () => {
    const classified = classifyMeshTerminationStop(SIGTERM_TERMINATION)
    expect(classified.reason).toBe('external_signal')
    expect(classified.intentional).toBe(false)
    expect(classified.signal).toBe(15)
    expect(classified.signalName).toBe('SIGTERM')
  })

  it('treats a host-requested stop as intentional', () => {
    // requestedStop is the actual discriminator — session-host stamps it ONLY
    // when the death followed a stop/delete/restart/prune through its own API.
    const classified = classifyMeshTerminationStop({ ...SIGTERM_TERMINATION, requestedStop: 'stop' })
    expect(classified.reason).toBe('host_requested_stop')
    expect(classified.intentional).toBe(true)
  })

  it('separates unknown, self-exit and plain-failure terminations', () => {
    expect(classifyMeshTerminationStop({ ...SIGTERM_TERMINATION, exitCode: null, signal: null }).reason)
      .toBe('unknown_termination')
    expect(classifyMeshTerminationStop({ ...SIGTERM_TERMINATION, exitCode: 0, signal: null, reason: 'exit', lifecycle: 'stopped' }).reason)
      .toBe('self_exit')
    expect(classifyMeshTerminationStop({ ...SIGTERM_TERMINATION, exitCode: 1, signal: null }).reason)
      .toBe('unexpected_exit')
  })

  it('never reports an unrequested termination as intentional', () => {
    for (const exitCode of [143, 137, 1, 0, null]) {
      const classified = classifyMeshTerminationStop({ ...SIGTERM_TERMINATION, exitCode, signal: null })
      expect(classified.intentional).toBe(false)
    }
  })
})

describe('buildMeshTerminationStopPayload', () => {
  const payload = buildMeshTerminationStopPayload({
    meshId: 'mesh_x',
    sessionId: '249e9979',
    isCoordinator: true,
    workspace: '/repo',
    termination: SIGTERM_TERMINATION,
  })

  it('carries every field the investigation needed from the tombstone', () => {
    expect(payload.intentional).toBe(false)
    expect(payload.reason).toBe('external_signal')
    expect(payload.exitCode).toBe(143)
    expect(payload.signal).toBe(15)
    expect(payload.signalName).toBe('SIGTERM')
    expect(payload.previousLifecycle).toBe('running')
    expect(payload.terminatedAt).toBe('2026-08-11T05:06:34.099Z')
    expect(payload.lastOutputAt).toBe('2026-08-11T05:06:33.986Z')
  })

  it('derives the silent gap that distinguishes an abrupt kill from a wind-down', () => {
    expect(payload.silentForMs).toBe(113)
  })

  it('marks the writer and the coordinator role', () => {
    expect(payload.source).toBe('session_host_tombstone')
    expect(payload.coordinatorSession).toBe(true)
  })

  it('preserves the host classification verbatim alongside its own', () => {
    expect(payload.terminationReason).toBe('failed')
    expect(payload.lifecycle).toBe('failed')
  })
})

describe('resolveMeshTerminationBinding', () => {
  it('binds a worker session by meshNodeFor + meshNodeId', () => {
    expect(resolveMeshTerminationBinding({ meshNodeFor: 'mesh_a', meshNodeId: 'node_1' }))
      .toEqual({ meshId: 'mesh_a', nodeId: 'node_1', isCoordinator: false })
  })

  it('binds a coordinator session by meshCoordinatorFor', () => {
    // The 249e9979 death WAS the coordinator — resolving only the worker stamp
    // would miss precisely the session whose loss blanked the ledger.
    expect(resolveMeshTerminationBinding({ meshCoordinatorFor: 'mesh_b' }))
      .toEqual({ meshId: 'mesh_b', isCoordinator: true })
  })

  it('returns null for a session with no mesh binding', () => {
    expect(resolveMeshTerminationBinding({ autoApprove: true })).toBeNull()
    expect(resolveMeshTerminationBinding(undefined)).toBeNull()
    expect(resolveMeshTerminationBinding({ meshNodeFor: '   ' })).toBeNull()
  })
})

describe('recordMeshSessionTerminationStop', () => {
  it('appends a session_stopped entry carrying the termination', async () => {
    const meshId = `mesh_rec_${randomUUID().slice(0, 8)}`
    await recordMeshSessionTerminationStop({
      meshId,
      sessionId: '249e9979',
      providerType: 'claude-cli',
      isCoordinator: true,
      termination: SIGTERM_TERMINATION,
    })

    const stops = readLedgerEntries(meshId).filter(e => e.kind === 'session_stopped')
    expect(stops).toHaveLength(1)
    expect(stops[0].sessionId).toBe('249e9979')
    expect(stops[0].providerType).toBe('claude-cli')
    expect(stops[0].payload.exitCode).toBe(143)
    expect(stops[0].payload.signalName).toBe('SIGTERM')
  })

  it('writes nothing when meshId or sessionId is missing', async () => {
    const meshId = `mesh_skip_${randomUUID().slice(0, 8)}`
    await recordMeshSessionTerminationStop({ meshId, sessionId: '', termination: SIGTERM_TERMINATION })
    await recordMeshSessionTerminationStop({ meshId: '', sessionId: 's1', termination: SIGTERM_TERMINATION })
    expect(readLedgerEntries(meshId).filter(e => e.kind === 'session_stopped')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The actual goal criterion: reading ONLY the ledger, can an operator cleanup
// be told apart from an unobserved external kill? Before this bridge the
// external kill produced no row at all, so the answer was no.
// ---------------------------------------------------------------------------
describe('ledger-only discrimination of intentional vs. external stop', () => {
  it('separates operator cleanup from an external kill using only ledger rows', async () => {
    const meshId = `mesh_disc_${randomUUID().slice(0, 8)}`

    // (1) The existing intentional path, byte-for-byte as
    //     recordIntentionalMeshSessionStop writes it. Left untouched by this fix.
    appendLedgerEntry(meshId, {
      kind: 'session_stopped',
      nodeId: 'node_9c22',
      sessionId: '9c22c895',
      payload: {
        intentional: true,
        reason: 'operator_cleanup',
        intentionalStopReason: 'operator_cleanup',
        source: 'mesh_remove_node',
        cleanupMode: 'delete',
        action: 'delete_session_force',
      },
    })

    // (2) The newly-bridged external kill.
    await recordMeshSessionTerminationStop({
      meshId,
      sessionId: '249e9979',
      isCoordinator: true,
      termination: SIGTERM_TERMINATION,
    })

    const stops = readLedgerEntries(meshId).filter(e => e.kind === 'session_stopped')
    expect(stops).toHaveLength(2)

    const cleanup = stops.find(e => e.sessionId === '9c22c895')!
    const killed = stops.find(e => e.sessionId === '249e9979')!

    // The discriminator the existing reader already uses.
    expect(isIntentionalCleanupStopEntry(cleanup)).toBe(true)
    expect(isIntentionalCleanupStopEntry(killed)).toBe(false)

    // And the external kill is not merely "not intentional" — it says why,
    // which is what made the original incident un-diagnosable from the ledger.
    expect(killed.payload.reason).toBe('external_signal')
    expect(killed.payload.exitCode).toBe(143)
    expect(killed.payload.signalName).toBe('SIGTERM')
    expect(killed.payload.previousLifecycle).toBe('running')
  })

  it('an external kill is never mistaken for an intentional cleanup entry', async () => {
    const meshId = `mesh_noconf_${randomUUID().slice(0, 8)}`
    await recordMeshSessionTerminationStop({
      meshId,
      sessionId: 'sess_kill',
      termination: SIGTERM_TERMINATION,
    })
    const [entry] = readLedgerEntries(meshId).filter(e => e.kind === 'session_stopped')
    expect(entry.payload.intentional).toBe(false)
    expect(entry.payload.source).not.toBe('mesh_remove_node')
    expect(entry.payload.source).not.toBe('mesh_cleanup_sessions')
    expect(entry.payload.reason).not.toBe('operator_cleanup')
  })
})
