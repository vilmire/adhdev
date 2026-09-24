import { afterEach, describe, expect, it } from 'vitest'
import { pushEvent, type ProviderEventsHost } from '../../src/providers/cli-provider-events.js'
import {
  __resetWorkerSessionBindsForTest,
  mintWorkerSessionBind,
} from '../../src/runtime-defaults.js'

// WORKER-BIND-IDLE-DETACH (2026-09-24, same false-idle class as
// RESTART-REBOUND): a worker session with a LIVE worker-MCP bind can still
// call report_completion for the task it is stamped with, so its own
// generating_completed/agent:stopped must not strip meshActiveTaskId out from
// under a report that has not landed yet. A session with NO bind (no worker
// MCP declared, e.g. a legacy/non-isolated provider) keeps the exact
// pre-existing unconditional detach.

function host(overrides: Partial<ProviderEventsHost> = {}): ProviderEventsHost & { detachCalls: number } {
  const state: any = {
    instanceId: 'sess-1',
    type: 'claude-code',
    workingDir: '/work/repo',
    provider: { controls: {} } as any,
    providerSessionId: undefined,
    settings: { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-A', launchedByCoordinator: true },
    context: null,
    lifecyclePort: { emit: () => {} } as any,
    adapter: {},
    appliedEffectKeys: new Set<string>(),
    controlValues: {},
    summaryMetadata: undefined,
    suppressIdleHistoryReplay: false,
    runtimeMessages: [],
    lastPersistedHistoryMessages: [],
    generatingStartedAt: 0,
    completedDebouncePending: null,
    generatingDebouncePending: null,
    detachCalls: 0,
    isMeshWorkerSession: () => true,
    completingTurnTaskId: () => 'task-A',
    detachMeshAssignment() { state.detachCalls++; state.settings = {}; },
    promoteProviderSessionId: () => {},
    appendRuntimeMessage: () => {},
    pushEvent(event: any) { pushEvent(state, event); },
    ...overrides,
  }
  return state
}

describe('pushEvent — worker-bind idle-detach withholding', () => {
  afterEach(() => __resetWorkerSessionBindsForTest())

  it('a session with a LIVE bind does NOT detach on its own generating_completed', () => {
    const h = host()
    mintWorkerSessionBind({ meshId: 'mesh-1', sessionId: h.instanceId })

    pushEvent(h, { event: 'agent:generating_completed', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(0)
    expect(h.settings.meshActiveTaskId).toBe('task-A')
  })

  it('a session with a LIVE bind does NOT detach on agent:stopped either', () => {
    const h = host()
    mintWorkerSessionBind({ meshId: 'mesh-1', sessionId: h.instanceId })

    pushEvent(h, { event: 'agent:stopped', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(0)
    expect(h.settings.meshActiveTaskId).toBe('task-A')
  })

  it('a session WITHOUT a bind keeps the pre-existing unconditional detach', () => {
    const h = host()
    // No mintWorkerSessionBind call — this session never got a worker MCP config.

    pushEvent(h, { event: 'agent:generating_completed', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(1)
  })

  it('a bind for a DIFFERENT session does not withhold this session\'s detach', () => {
    const h = host()
    mintWorkerSessionBind({ meshId: 'mesh-1', sessionId: 'some-other-session' })

    pushEvent(h, { event: 'agent:generating_completed', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(1)
  })

  it('agent:ready with a live bind is still governed by the existing turn-in-flight guard, not the bind', () => {
    // agent:ready's own guard (readyWithTurnInFlight) is independent of the
    // bind gate — a bind must not relax or replace it. With no turn in
    // flight, agent:ready detaches exactly as it always has, bind or not.
    const h = host()
    mintWorkerSessionBind({ meshId: 'mesh-1', sessionId: h.instanceId })

    pushEvent(h, { event: 'agent:ready', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(1)
  })

  it('a revoked bind no longer withholds the detach', () => {
    const h = host()
    const binding = mintWorkerSessionBind({ meshId: 'mesh-1', sessionId: h.instanceId })
    // Simulate the owner revoking the bind (mesh/turn-ledger revoke path) —
    // the module-level test reset below is a full flush; here we just mint
    // then let a later event on a fresh registry state prove the false path.
    void binding
    __resetWorkerSessionBindsForTest()

    pushEvent(h, { event: 'agent:generating_completed', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(1)
  })
})
