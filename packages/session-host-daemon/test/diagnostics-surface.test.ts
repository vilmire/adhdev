import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionHostServer } from '../src/server.js'
import type { SessionHostRecord } from '@adhdev/session-host-core'

function buildRecord(overrides: Partial<SessionHostRecord>): SessionHostRecord {
  const now = Date.now()
  return {
    sessionId: overrides.sessionId || `session-${Math.random()}`,
    runtimeKey: overrides.runtimeKey || 'runtime-key',
    displayName: overrides.displayName || 'Runtime',
    workspaceLabel: overrides.workspaceLabel || 'workspace',
    transport: 'pty',
    providerType: overrides.providerType || 'hermes-cli',
    category: overrides.category || 'cli',
    workspace: overrides.workspace || '/tmp/workspace',
    launchCommand: overrides.launchCommand || { command: '/bin/sh', args: ['-lc', 'echo hi'] },
    createdAt: overrides.createdAt || now,
    startedAt: overrides.startedAt,
    lastActivityAt: overrides.lastActivityAt || now,
    lifecycle: overrides.lifecycle || 'stopped',
    writeOwner: overrides.writeOwner || null,
    attachedClients: overrides.attachedClients || [],
    buffer: overrides.buffer || { scrollbackBytes: 0, snapshotSeq: 0 },
    meta: overrides.meta || {},
    osPid: overrides.osPid,
  }
}

test('getHostDiagnostics groups sessions into live runtimes, recovery snapshots, and inactive records', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-surface' })

  const liveRecord = buildRecord({
    sessionId: 'live-1',
    runtimeKey: 'live-runtime',
    lifecycle: 'running',
  })
  const recoveryRecord = buildRecord({
    sessionId: 'recovery-1',
    runtimeKey: 'recovery-runtime',
    lifecycle: 'stopped',
    meta: {
      restoredFromStorage: true,
      runtimeRecoveryState: 'orphan_snapshot',
    },
  })
  const inactiveRecord = buildRecord({
    sessionId: 'inactive-1',
    runtimeKey: 'inactive-runtime',
    lifecycle: 'stopped',
  })

  server.registry.restoreSession(liveRecord)
  server.registry.restoreSession(recoveryRecord)
  server.registry.restoreSession(inactiveRecord)
  ;(server as any).runtimes.set(liveRecord.sessionId, {})

  const diagnostics = (server as any).getHostDiagnostics({ includeSessions: true, limit: 10 })

  assert.equal(diagnostics.runtimeCount, 1)
  assert.equal(diagnostics.liveRuntimes.length, 1)
  assert.equal(diagnostics.recoverySnapshots.length, 1)
  assert.equal(diagnostics.inactiveRecords.length, 1)
  assert.equal(diagnostics.liveRuntimes[0].surfaceKind, 'live_runtime')
  assert.equal(diagnostics.recoverySnapshots[0].surfaceKind, 'recovery_snapshot')
  assert.equal(diagnostics.inactiveRecords[0].surfaceKind, 'inactive_record')
})
