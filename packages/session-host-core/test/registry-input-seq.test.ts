import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionHostRegistry } from '../src/registry.js'

// SUBMIT-UNCONFIRMED-RECLAIM (review R7): the host's per-runtime input counter
// is the authoritative input boundary a daemon proves composer ownership from.

function create(registry: SessionHostRegistry, sessionId = 'in-1') {
  return registry.createSession({
    sessionId,
    providerType: 'claude-cli',
    category: 'cli',
    workspace: '/tmp/ws',
    launchCommand: { command: '/bin/sh', args: [] },
  } as any)
}

test('a new record starts at inputSeq 0 and counts every accepted input, monotonically', () => {
  const registry = new SessionHostRegistry()
  assert.equal(create(registry).inputSeq, 0)
  assert.equal(registry.recordInput('in-1'), 1)
  assert.equal(registry.recordInput('in-1'), 2)
  assert.equal(registry.getSession('in-1')?.inputSeq, 2)
})

test('a record persisted by a host that predates inputSeq restores at 0; a counted record keeps its count', () => {
  const registry = new SessionHostRegistry()
  const { inputSeq: _drop, ...legacy } = create(registry, 'old-1')
  const restored = new SessionHostRegistry().restoreSession(JSON.parse(JSON.stringify(legacy)))
  assert.equal(restored.inputSeq, 0)
  registry.recordInput('old-1')
  const kept = new SessionHostRegistry().restoreSession(JSON.parse(JSON.stringify(registry.getSession('old-1'))))
  assert.equal(kept.inputSeq, 1)
})

test('inputEpoch (review R8-2): kept by an in-place restore with its count intact, changed by a rewound count or a new host process', () => {
  const registry = new SessionHostRegistry()
  const rec = create(registry, 'ep-1')
  registry.recordInput('ep-1')
  const e0 = registry.getInputState('ep-1').inputEpoch
  // resize-style in-place restore: same lifetime
  registry.restoreSession({ ...registry.getSession('ep-1')!, meta: { ...rec.meta, sessionHostCols: 100 } })
  assert.equal(registry.getInputState('ep-1').inputEpoch, e0)
  // a rewound count: a new lifetime
  registry.restoreSession({ ...registry.getSession('ep-1')!, inputSeq: 0 })
  const e1 = registry.getInputState('ep-1').inputEpoch
  assert.notEqual(e1, e0)
  // the same record loaded by another host process: a new lifetime
  const persisted = JSON.parse(JSON.stringify(registry.getSession('ep-1')))
  const other = new SessionHostRegistry()
  other.restoreSession(persisted)
  assert.notEqual(other.getInputState('ep-1').inputEpoch, e1)
})
