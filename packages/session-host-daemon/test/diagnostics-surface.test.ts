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

test('writeEnvelopeSafely drops sockets that fail asynchronously with EPIPE', async () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-surface-epipe' }) as any
  let destroyed = false
  const socket = {
    destroyed: false,
    writable: true,
    writableEnded: false,
    write: (_payload: string, cb?: (error?: Error | null) => void) => {
      queueMicrotask(() => cb?.(new Error('write EPIPE')))
      return true
    },
    destroy: () => { destroyed = true },
  }

  server.sockets.add(socket)
  server.writeEnvelopeSafely(socket, { kind: 'event', event: { type: 'host_log', entry: { timestamp: 1, level: 'warn', message: 'boom' } } })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(server.sockets.has(socket), false)
  assert.equal(destroyed, true)
})

test('writeEnvelopeSafely ignores already-ended sockets immediately', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-surface-ended' }) as any
  let writeCalled = false
  const socket = {
    destroyed: false,
    writable: true,
    writableEnded: true,
    write: () => { writeCalled = true; return true },
    destroy: () => {},
  }

  server.sockets.add(socket)
  server.writeEnvelopeSafely(socket, { kind: 'event', event: { type: 'host_log', entry: { timestamp: 1, level: 'warn', message: 'noop' } } })

  assert.equal(server.sockets.has(socket), false)
  assert.equal(writeCalled, false)
})

test('session-scoped output events are only written to sockets subscribed to that session', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-surface-fanout' }) as any
  const writes: Record<string, string[]> = { a: [], b: [], c: [] }
  const makeSocket = (id: 'a' | 'b' | 'c') => ({
    destroyed: false,
    writable: true,
    writableEnded: false,
    write: (payload: string, cb?: (error?: Error | null) => void) => {
      writes[id].push(payload)
      cb?.(null)
      return true
    },
    destroy: () => {},
  })
  const socketA = makeSocket('a')
  const socketB = makeSocket('b')
  const socketC = makeSocket('c')
  server.sockets.add(socketA)
  server.sockets.add(socketB)
  server.sockets.add(socketC)
  server.subscribeSocketToSession(socketA, 'session-a')
  server.subscribeSocketToSession(socketB, 'session-b')

  server.emitEvent({ type: 'session_output', sessionId: 'session-a', seq: 1, data: 'hello' })

  assert.equal(writes.a.length, 1)
  assert.equal(writes.b.length, 0)
  assert.equal(writes.c.length, 0)
})

test('getHostDiagnostics strips launch env from diagnostics records to keep payloads lightweight', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-surface-sanitized' })
  const record = buildRecord({
    sessionId: 'recovery-heavy-1',
    lifecycle: 'stopped',
    meta: {
      restoredFromStorage: true,
      runtimeRecoveryState: 'orphan_snapshot',
    },
    launchCommand: {
      command: '/bin/zsh',
      args: ['-lc', 'echo heavy'],
      env: {
        HUGE_ONE: 'x'.repeat(4096),
        HUGE_TWO: 'y'.repeat(4096),
      },
    },
  })

  server.registry.restoreSession(record)
  const diagnostics = (server as any).getHostDiagnostics({ includeSessions: true, limit: 10 })

  assert.equal(diagnostics.sessions.length, 1)
  assert.equal(diagnostics.sessions[0].launchCommand.command, '/bin/zsh')
  assert.deepEqual(diagnostics.sessions[0].launchCommand.args, ['-lc', 'echo heavy'])
  assert.equal(diagnostics.sessions[0].launchCommand.env, undefined)
  assert.equal(record.launchCommand.env?.HUGE_ONE?.length, 4096)
})
