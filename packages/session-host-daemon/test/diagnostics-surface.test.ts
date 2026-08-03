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

test('send_input records a diagnostic when a runtime write produces no output', async () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-send-input-no-output' }) as any
  const record = buildRecord({ sessionId: 'wedged-hermes', lifecycle: 'running' })
  const writes: string[] = []

  server.registry.restoreSession(record)
  server.runtimes.set(record.sessionId, { write: (data: string) => writes.push(data) })

  const response = await server.handleRequest({
    type: 'send_input',
    payload: { sessionId: record.sessionId, clientId: 'dashboard', data: 'hello' },
  })
  await new Promise((resolve) => setTimeout(resolve, 350))

  const diagnostics = server.getHostDiagnostics({ includeSessions: false, limit: 20 })
  const warning = diagnostics.recentLogs.find((entry: any) => entry.message.includes('send_input produced no terminal output'))

  assert.equal(response.success, true)
  assert.deepEqual(writes, ['hello'])
  assert.equal(warning?.level, 'warn')
  assert.equal(warning?.sessionId, record.sessionId)
  assert.equal(warning?.data?.clientId, 'dashboard')
  assert.equal(warning?.data?.inputLength, 5)
  assert.equal(warning?.data?.beforeSnapshotSeq, 0)
  assert.equal(warning?.data?.afterSnapshotSeq, 0)
  assert.equal(warning?.data?.input, undefined)
})

test('send_input no-output diagnostic is suppressed when terminal output advances', async () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-send-input-output' }) as any
  const record = buildRecord({ sessionId: 'healthy-hermes', lifecycle: 'running' })

  server.registry.restoreSession(record)
  server.runtimes.set(record.sessionId, {
    write: (data: string) => server.registry.appendOutput(record.sessionId, data),
  })

  const response = await server.handleRequest({
    type: 'send_input',
    payload: { sessionId: record.sessionId, clientId: 'dashboard', data: 'hello' },
  })
  await new Promise((resolve) => setTimeout(resolve, 350))

  const diagnostics = server.getHostDiagnostics({ includeSessions: false, limit: 20 })

  assert.equal(response.success, true)
  assert.equal(
    diagnostics.recentLogs.some((entry: any) => entry.message.includes('send_input produced no terminal output')),
    false,
  )
})

test('getHostDiagnostics applies limit to recovery and inactive session groups without dropping live runtimes', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-surface-limit' })

  // listSessions() sorts by lastActivityAt descending (most recent first, see
  // registry.ts). Pin explicit, well-separated timestamps here instead of
  // relying on buildRecord's Date.now() default: two records built back to
  // back can land on the same millisecond or tick over into the next one,
  // which nondeterministically flips which record sorts first and made this
  // test flaky (~1/12 runs). The "-1" record in each pair must sort ahead of
  // its "-2" sibling, so give it a strictly larger lastActivityAt.
  const baseActivity = Date.now()
  const liveOne = buildRecord({ sessionId: 'live-1', lifecycle: 'running', lastActivityAt: baseActivity + 40 })
  const liveTwo = buildRecord({ sessionId: 'live-2', lifecycle: 'running', lastActivityAt: baseActivity + 30 })
  const recoveryOne = buildRecord({
    sessionId: 'recovery-1',
    lifecycle: 'stopped',
    meta: { restoredFromStorage: true, runtimeRecoveryState: 'orphan_snapshot' },
    lastActivityAt: baseActivity + 20,
  })
  const recoveryTwo = buildRecord({
    sessionId: 'recovery-2',
    lifecycle: 'stopped',
    meta: { restoredFromStorage: true, runtimeRecoveryState: 'orphan_snapshot' },
    lastActivityAt: baseActivity + 10,
  })
  const inactiveOne = buildRecord({ sessionId: 'inactive-1', lifecycle: 'stopped', lastActivityAt: baseActivity + 2 })
  const inactiveTwo = buildRecord({ sessionId: 'inactive-2', lifecycle: 'stopped', lastActivityAt: baseActivity + 1 })

  for (const record of [liveOne, liveTwo, recoveryOne, recoveryTwo, inactiveOne, inactiveTwo]) {
    server.registry.restoreSession(record)
  }
  ;(server as any).runtimes.set(liveOne.sessionId, {})
  ;(server as any).runtimes.set(liveTwo.sessionId, {})

  const diagnostics = (server as any).getHostDiagnostics({ includeSessions: true, limit: 1 })

  assert.deepEqual(diagnostics.liveRuntimes.map((record: SessionHostRecord) => record.sessionId), ['live-1', 'live-2'])
  assert.deepEqual(diagnostics.recoverySnapshots.map((record: SessionHostRecord) => record.sessionId), ['recovery-1'])
  assert.deepEqual(diagnostics.inactiveRecords.map((record: SessionHostRecord) => record.sessionId), ['inactive-1'])
  assert.deepEqual(diagnostics.sessions.map((record: SessionHostRecord) => record.sessionId), ['live-1', 'live-2', 'recovery-1', 'inactive-1'])
})

test('persistNow reports storage failures without throwing out of the session host', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-persist-failure' }) as any
  const record = buildRecord({ sessionId: 'persist-failure', lifecycle: 'running' })
  server.registry.restoreSession(record)
  server.storage.save = () => {
    const error = new Error('no space left on device') as NodeJS.ErrnoException
    error.code = 'ENOSPC'
    throw error
  }

  const originalError = console.error
  const messages: string[] = []
  console.error = (message?: unknown) => { messages.push(String(message)) }
  try {
    assert.doesNotThrow(() => server.persistNow(record.sessionId))
  } finally {
    console.error = originalError
  }

  assert.equal(messages.length, 1)
  assert.match(messages[0], /Persist failed/)
  assert.match(messages[0], /ENOSPC/)
})
