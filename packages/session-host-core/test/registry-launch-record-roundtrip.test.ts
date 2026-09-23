import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionHostRegistry } from '../src/registry.js'

// Phase E (wiring-unification §7 E1): the daemon persists a session's launch
// provenance in the session-host record meta (`meta.launchRecord`) so a hosted
// runtime re-attached after a daemon restart can recover it. The session-host
// daemon outlives the daemon, so this record is the only copy that survives.

const launchRecord = {
  sessionId: 'rt-1',
  providerType: 'claude-cli',
  launchedBy: 'dashboard',
  launchedAt: 100,
  model: { requested: 'sonnet', source: 'remembered', launchValue: 'sonnet', history: [{ at: 100, value: 'sonnet', via: 'launch' }] },
  thinkingLevel: { source: 'unspecified', history: [] },
}

function create(registry: SessionHostRegistry, meta: Record<string, unknown>) {
  return registry.createSession({
    sessionId: 'rt-1',
    providerType: 'claude-cli',
    category: 'cli',
    workspace: '/tmp/ws',
    launchCommand: { command: '/bin/sh', args: [] },
    meta,
  } as any)
}

test('launchRecord seeded at create survives meta patches and listing', () => {
  const registry = new SessionHostRegistry()
  create(registry, { launchRecord })
  registry.updateSessionMeta('rt-1', { providerSessionId: 'prov-1' })
  const [listed] = registry.listSessions()
  assert.deepEqual(listed.meta.launchRecord, launchRecord)
  assert.equal(listed.meta.providerSessionId, 'prov-1')
})

test('launchRecord stamped post-spawn (updateSessionMeta) survives a JSON round-trip + restoreSession', () => {
  const registry = new SessionHostRegistry()
  create(registry, {})
  registry.updateSessionMeta('rt-1', { launchRecord })
  const wire = JSON.parse(JSON.stringify(registry.getSession('rt-1')))
  const restoredRegistry = new SessionHostRegistry()
  restoredRegistry.restoreSession(wire)
  assert.deepEqual(restoredRegistry.getSession('rt-1')?.meta.launchRecord, launchRecord)
})

test('a caller mutating a returned record cannot reach the registry copy of launchRecord', () => {
  const registry = new SessionHostRegistry()
  create(registry, { launchRecord: structuredClone(launchRecord) })
  const returned = registry.getSession('rt-1')!
  ;(returned.meta.launchRecord as any).model.source = 'user'
  assert.equal((registry.getSession('rt-1')!.meta.launchRecord as any).model.source, 'remembered')
})
