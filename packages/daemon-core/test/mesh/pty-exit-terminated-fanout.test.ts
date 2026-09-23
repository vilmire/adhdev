// ---------------------------------------------------------------------------
// PTY-EXIT → terminated FAN-OUT (wiring-unification B4, plan §6.3).
//
// One PTY death must reach every consumer of "this session is gone" EXACTLY
// once, through ONE bus event — even when the exit races an explicit stop and
// the 5 s auto-clean (both call registry.terminate too). Before B4 these were
// four separate code paths (a neutral sink for the ledger, direct cli-manager
// calls for the coordinator registry, a registry-reading closure for the claim
// liveness, and nothing at all for worker binds or the transcript maps).
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import type { SessionTermination } from '@adhdev/session-host-core'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { createSessionEventPort } from '../../src/sessions/session-port.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { subscribeMeshTermination } from '../../src/mesh/mesh-termination-bridge.js'
import {
  getCoordinatorForSession,
  registerMeshCoordinator,
  subscribeCoordinatorRegistryRemoval,
  unregisterMeshCoordinator,
} from '../../src/mesh/coordinator-registry.js'
import {
  mintWorkerSessionBind,
  subscribeWorkerBindRevocation,
  verifyWorkerSessionBind,
} from '../../src/mesh/worker-mcp-isolation.js'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { subscribeLiveSessions } from '../../src/boot/live-sessions.js'
import { subscribeTranscriptProjection } from '../../src/seqscribe/transcript-bus-subscriber.js'

const KILL_9: SessionTermination = {
  exitCode: null,
  signal: 9,
  reason: 'failed',
  lifecycle: 'failed',
  terminatedAt: Date.now(),
  previousLifecycle: 'running',
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

function harness() {
  const bus = createSessionLifecycleBus()
  const registry = new SessionRegistry(bus)
  const port = createSessionEventPort(bus, registry)
  const transcript = { markDirty: vi.fn(), startPolling: vi.fn(), stopPolling: vi.fn(), forgetSession: vi.fn() }
  const live = subscribeLiveSessions(bus)
  const offs = [
    subscribeMeshTermination(bus),
    subscribeCoordinatorRegistryRemoval(bus),
    subscribeWorkerBindRevocation(bus),
    subscribeTranscriptProjection(bus, transcript),
  ]
  const terminated: any[] = []
  bus.on('terminated', e => { terminated.push(e) }, { name: 'test.observer' })
  return { bus, registry, port, transcript, live, offs, terminated }
}

let cleanup: Array<() => void> = []
afterEach(() => { for (const f of cleanup.splice(0)) f() })

describe('one terminated{pty_exit} fans out to every session-gone consumer exactly once', () => {
  it('kill -9 of a mesh coordinator: ledger row, registry entry, bind, claim liveness, transcript maps', async () => {
    const h = harness()
    cleanup.push(() => { for (const off of h.offs) off(); h.live.unsubscribe(); h.bus.close() })
    const meshId = `mesh_fanout_${randomUUID().slice(0, 8)}`
    const sessionId = `sess_${randomUUID().slice(0, 8)}`
    cleanup.push(() => unregisterMeshCoordinator(sessionId))

    h.registry.register({ sessionId, parentSessionId: null, providerType: 'claude-cli', transport: 'pty', instanceKey: sessionId, workspace: '/tmp/ws' }, 'launch')
    registerMeshCoordinator({ meshId, sessionId, startedAt: Date.now(), cliType: 'claude-cli' })
    const bind = mintWorkerSessionBind({ meshId, sessionId })
    expect(h.live.has(sessionId)).toBe(true)
    expect(getCoordinatorForSession(sessionId)).toBeTruthy()
    expect(verifyWorkerSessionBind(bind.bind)).toBeTruthy()

    // The PTY dies (kill -9 shape), and the explicit stop + auto-clean race it.
    const runtimeSettings = { meshCoordinatorFor: meshId }
    h.port.exited(sessionId, KILL_9, runtimeSettings)
    h.registry.terminate(sessionId, 'stop_requested')
    h.registry.terminateByInstanceKey(sessionId, 'auto_clean')
    h.port.exited(sessionId, KILL_9, runtimeSettings)
    await flush()

    expect(h.terminated).toHaveLength(1)
    expect(h.terminated[0]).toMatchObject({ sessionId, cause: 'pty_exit', providerType: 'claude-cli', workspace: '/tmp/ws' })
    // mesh-termination subscriber → exactly one session_stopped row
    const stops = readLedgerEntries(meshId).filter(e => e.kind === 'session_stopped')
    expect(stops).toHaveLength(1)
    expect(stops[0].payload).toMatchObject({ reason: 'external_signal', signalName: 'SIGKILL', coordinatorSession: true })
    // coordinator-registry subscriber
    expect(getCoordinatorForSession(sessionId)).toBeUndefined()
    // worker-bind subscriber
    expect(verifyWorkerSessionBind(bind.bind)).toBeNull()
    // transcript-claim liveness set
    expect(h.live.has(sessionId)).toBe(false)
    // transcript subscriber (C9 forget)
    expect(h.transcript.forgetSession).toHaveBeenCalledTimes(1)
    expect(h.transcript.forgetSession).toHaveBeenCalledWith(sessionId)
    expect(h.bus.stats().handlerErrors).toBe(0)
  })

  it('daemon_shutdown keeps the persisted coordinator entry and writes no ledger row', async () => {
    const h = harness()
    cleanup.push(() => { for (const off of h.offs) off(); h.live.unsubscribe(); h.bus.close() })
    const meshId = `mesh_fanout_sd_${randomUUID().slice(0, 8)}`
    const sessionId = `sess_${randomUUID().slice(0, 8)}`
    cleanup.push(() => unregisterMeshCoordinator(sessionId))

    h.registry.register({ sessionId, parentSessionId: null, providerType: 'claude-cli', transport: 'pty', instanceKey: sessionId }, 'launch')
    registerMeshCoordinator({ meshId, sessionId, startedAt: Date.now() })
    h.registry.beginShutdown()
    h.port.exited(sessionId, KILL_9, { meshCoordinatorFor: meshId })
    await flush()

    expect(h.terminated).toHaveLength(1)
    expect(h.terminated[0].cause).toBe('daemon_shutdown')
    // A coordinator torn down with the daemon must re-attach after restart.
    expect(getCoordinatorForSession(sessionId)).toBeTruthy()
    expect(readLedgerEntries(meshId).filter(e => e.kind === 'session_stopped')).toHaveLength(0)
  })
})
