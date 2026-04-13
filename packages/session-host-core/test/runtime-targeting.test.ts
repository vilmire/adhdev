import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionHostRecord } from '../src/types.js'
import { resolveAttachableRuntimeRecord } from '../src/runtime-labels.js'

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
    surfaceKind: overrides.surfaceKind,
    writeOwner: overrides.writeOwner || null,
    attachedClients: overrides.attachedClients || [],
    buffer: overrides.buffer || { scrollbackBytes: 0, snapshotSeq: 0 },
    meta: overrides.meta || {},
    osPid: overrides.osPid,
  }
}

test('resolveAttachableRuntimeRecord returns a live runtime match', () => {
  const liveRecord = buildRecord({
    sessionId: 'live-1',
    runtimeKey: 'hermes-cli-remote-vs-4',
    lifecycle: 'running',
  })

  const result = resolveAttachableRuntimeRecord([liveRecord], 'hermes-cli-remote-vs-4')
  assert.equal(result.sessionId, 'live-1')
})

test('resolveAttachableRuntimeRecord rejects recovery snapshots with guidance to recover first', () => {
  const snapshotRecord = buildRecord({
    sessionId: 'snapshot-1',
    runtimeKey: 'hermes-cli-remote-vs',
    lifecycle: 'stopped',
    meta: {
      restoredFromStorage: true,
      runtimeRecoveryState: 'orphan_snapshot',
    },
  })

  assert.throws(
    () => resolveAttachableRuntimeRecord([snapshotRecord], 'hermes-cli-remote-vs'),
    /recovery snapshot, not a live attach target\. Resume or recover it first/i,
  )
})

test('resolveAttachableRuntimeRecord rejects inactive stopped records', () => {
  const inactiveRecord = buildRecord({
    sessionId: 'inactive-1',
    runtimeKey: 'hermes-cli-remote-vs-2',
    lifecycle: 'stopped',
  })

  assert.throws(
    () => resolveAttachableRuntimeRecord([inactiveRecord], 'hermes-cli-remote-vs-2'),
    /is stopped, not a live attach target/i,
  )
})
