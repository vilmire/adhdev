import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionHostRecord } from '@adhdev/session-host-core'
import {
  formatMuxRuntimeListHeader,
  formatMuxRuntimeListLine,
} from '../src/runtime-list.js'

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

test('formatMuxRuntimeListHeader warns that adhmux list is raw session-host visibility', () => {
  assert.match(formatMuxRuntimeListHeader(), /raw session-host records/i)
  assert.match(formatMuxRuntimeListHeader(), /recovery snapshots/i)
})

test('formatMuxRuntimeListLine labels live runtimes with attach guidance', () => {
  const line = formatMuxRuntimeListLine(buildRecord({
    runtimeKey: 'hermes-cli-live',
    lifecycle: 'running',
  }))

  assert.match(line, /live runtime/i)
  assert.match(line, /next=attach/i)
})

test('formatMuxRuntimeListLine labels recovery snapshots with recover guidance', () => {
  const line = formatMuxRuntimeListLine(buildRecord({
    runtimeKey: 'hermes-cli-remote-vs',
    lifecycle: 'stopped',
    meta: {
      restoredFromStorage: true,
      runtimeRecoveryState: 'orphan_snapshot',
    },
  }))

  assert.match(line, /recovery snapshot/i)
  assert.match(line, /next=recover/i)
})

test('formatMuxRuntimeListLine labels inactive records with restart guidance', () => {
  const line = formatMuxRuntimeListLine(buildRecord({
    runtimeKey: 'hermes-cli-old',
    lifecycle: 'failed',
  }))

  assert.match(line, /inactive record/i)
  assert.match(line, /next=restart/i)
})
