import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTurnEvidence } from '@adhdev/mesh-shared'

// mesh-event-forwarding after wiring-unification C (C-W3): a mesh session's
// `agent:*` provider event becomes ONE content-free TurnEvidence observed
// through the turn ledger — the reducer is the single writer of turn state, so
// forwarding never flips a queue / dispatch / delivery row itself (the
// WARMUPGAP / MISROUTE sibling-sweep classes cannot recur). Text stays LOCAL in
// the evidence envelope, or rides `mesh.<id>.handoff` for a remote owner.
// Non-turn events (refine, worktree bootstrap) become coordinator notices.

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(() => undefined),
  listMeshes: vi.fn(() => []),
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { setupMeshEventForwarding, buildProviderEvidence } from '../../src/mesh/mesh-event-forwarding.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { bindMeshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js'
import { captureNotices } from '../helpers/notice-capture.js'
import { withMeshForwardingBus } from './helpers/mesh-forwarding-bus-fixture.js'

const MESH = 'mesh_fwd_evidence'
const SESSION = 'worker-session-1'
const SENTINEL = 'SENTINEL-final-summary-text'

function worker(settings: Record<string, unknown> = {}) {
  return {
    category: 'cli',
    getState: () => ({ instanceId: SESSION, workspace: '/repo/wt', status: 'idle', settings: { meshNodeFor: MESH, meshNodeId: 'node_1', ...settings } }),
    onEvent: vi.fn(),
  }
}

function setup(opts: { settings?: Record<string, unknown> } = {}) {
  meshConfigMocks.getMesh.mockReturnValue({ id: MESH, nodes: [{ id: 'node_1', workspace: '/repo/wt' }], policy: {} })
  const source = worker(opts.settings)
  const observed: Array<{ evidence: any; opts: any }> = []
  const ledger = {
    selfDaemonId: 'daemon_self',
    observe: vi.fn((evidence: any, o: any) => { observed.push({ evidence, opts: o }); return { verdict: 'applied', attempt: null, effects: [] } }),
  }
  const components = withMeshForwardingBus({
    instanceManager: {
      getInstance: (id: string) => (id === SESSION ? source : undefined),
      getByCategory: (c: string) => (c === 'cli' ? [source] : []),
    },
    router: { markWorktreeBootstrapTerminalState: vi.fn(), getCachedInlineMesh: vi.fn(() => undefined) },
    turnLedger: ledger,
    statusInstanceId: 'daemon_self',
  } as any)
  const capture = captureNotices()
  const off = setupMeshEventForwarding(components)
  return { components, observed, ledger, capture, off }
}

afterEach(() => {
  bindMeshNoticeRuntime(null)
  vi.clearAllMocks()
})

describe('forwarding → turn evidence', () => {
  it('a genuine completion becomes turn_end{genuine} with the summary LOCAL in the envelope; no queue/dispatch row is touched', () => {
    const { components, observed, off } = setup()
    const store = MeshRuntimeStore.getInstance()
    const dispatchSpy = vi.spyOn(store, 'updateDirectDispatchStatus')
    components.emit({ event: 'agent:generating_completed', instanceId: SESSION, targetSessionId: SESSION, providerType: 'codex-cli', finalSummary: SENTINEL, timestamp: 1_000 })
    expect(observed).toHaveLength(1)
    const { evidence, opts } = observed[0]!
    expect(isTurnEvidence(evidence)).toBe(true)
    expect(evidence).toMatchObject({ kind: 'turn_end', strength: 'genuine', sessionId: SESSION, at: 1_000, observedBy: 'daemon_self' })
    expect(JSON.stringify(evidence)).not.toContain(SENTINEL)
    expect(opts.envelope.finalSummary).toBe(SENTINEL)
    expect(opts.envelope.notice.nodeLabel).toBeTruthy()
    expect(opts.owner).toBeUndefined()
    expect(dispatchSpy).not.toHaveBeenCalled()
    off()
  })

  it('the same provider event observed twice carries the same eventId (the ledger PK collapses it)', () => {
    const { components, observed, off } = setup()
    const event = { event: 'agent:generating_started', instanceId: SESSION, targetSessionId: SESSION, timestamp: 2_000, taskId: 't1' }
    components.emit(event)
    components.emit(event)
    expect(observed).toHaveLength(2)
    expect(observed[0]!.evidence.eventId).toBe(observed[1]!.evidence.eventId)
    expect(observed[0]!.evidence).toMatchObject({ kind: 'turn_started', retro: false, taskId: 't1' })
    off()
  })

  it('weak / forced-timeout / hollow completions carry their flags (the reducer decides R10 / R13b / R33)', () => {
    const base = { eventName: 'agent:generating_completed', sessionId: SESSION, settings: {}, nodeId: 'n', nodeLabel: 'n', observedBy: 'd' }
    const weak = buildProviderEvidence({ ...base, event: { evidenceLevel: 'insufficient', reviewRecommended: true, timestamp: 1 } })!
    expect(weak.evidence).toMatchObject({ kind: 'turn_end', strength: 'weak' })
    const forced = buildProviderEvidence({ ...base, event: { evidenceLevel: 'insufficient', completionDiagnostic: { emittedAfterFinalizationTimeout: true }, timestamp: 1 } })!
    expect(forced.evidence).toMatchObject({ afterFinalizationTimeout: true })
    const hollow = buildProviderEvidence({ ...base, event: { evidenceLevel: 'insufficient', completionDiagnostic: { finalAssistantContentLength: 0 }, timestamp: 1 } })!
    expect(hollow.evidence).toMatchObject({ hollow: true })
    for (const b of [weak, forced, hollow]) expect(isTurnEvidence(b.evidence)).toBe(true)
  })

  it('suspension / resolution / stop / stall map to their evidence kinds, text only in the envelope', () => {
    const base = { sessionId: SESSION, settings: {}, nodeId: 'n', nodeLabel: 'n', observedBy: 'd' }
    const choice = buildProviderEvidence({ ...base, eventName: 'agent:waiting_choice', event: { timestamp: 1, promptId: 'p1', interactivePrompt: { questions: [{ question: SENTINEL, options: [{ label: 'yes' }] }] } } })!
    expect(choice.evidence).toMatchObject({ kind: 'suspension', modal: 'choice' })
    expect(JSON.stringify(choice.evidence)).not.toContain(SENTINEL)
    expect((choice.envelope!.notice as any).questions[0].question).toBe(SENTINEL)
    expect(buildProviderEvidence({ ...base, eventName: 'agent:approval_resolved', event: { timestamp: 1, resolution: 'approved', source: 'auto_approve' } })!.evidence)
      .toMatchObject({ kind: 'suspension_resolved', resolution: 'approved', via: 'auto_approve' })
    expect(buildProviderEvidence({ ...base, eventName: 'agent:stopped', event: { timestamp: 1, errorReason: 'auth_failed' } })!.evidence)
      .toMatchObject({ kind: 'process_exit', providerFailure: 'auth_failed', exitCode: null })
    expect(buildProviderEvidence({ ...base, eventName: 'monitor:no_progress', event: { timestamp: 1, stalledMs: 200_000, observedStatus: 'generating' } })!.evidence)
      .toMatchObject({ kind: 'no_progress', stalledMs: 200_000, observedStatus: 'generating' })
    // agent:ready WITHOUT completion evidence is an input_state fact, not evidence.
    expect(buildProviderEvidence({ ...base, eventName: 'agent:ready', event: { timestamp: 1 } })).toBeNull()
  })

  it('a worker reporting to ANOTHER daemon forwards with owner + attemptRef; its text rides the handoff topic', async () => {
    const ref = { topic: `mesh.${MESH}.handoff`, writer: 'w-self', seq: 5 }
    const { components, observed, off } = setup({ settings: { meshCoordinatorDaemonId: 'daemon_coord', meshAttemptRef: { attemptId: 'a1', generation: 2 } } })
    const appendHandoff = vi.fn(async () => ref)
    const runtime = (await import('../../src/mesh/turn-ledger/deliver.js')).meshNoticeRuntime.current()!
    ;(runtime as any).appendHandoff = appendHandoff
    components.emit({ event: 'agent:generating_completed', instanceId: SESSION, targetSessionId: SESSION, finalSummary: SENTINEL, timestamp: 3_000 })
    await new Promise((r) => setImmediate(r))
    expect(appendHandoff).toHaveBeenCalledWith(MESH, 'turn.evidence.text', expect.objectContaining({ text: SENTINEL }))
    expect(observed).toHaveLength(1)
    expect(observed[0]!.opts.owner).toEqual({ daemonId: 'daemon_coord', meshId: MESH })
    expect(observed[0]!.evidence).toMatchObject({ kind: 'turn_end', attemptRef: { attemptId: 'a1', generation: 2 }, summary: ref })
    expect(JSON.stringify(observed[0]!.evidence)).not.toContain(SENTINEL)
    off()
  })

  it('worktree bootstrap / refine events become coordinator notices, not evidence', () => {
    const { components, observed, capture, off } = setup()
    components.emit({ event: 'worktree_bootstrap_complete', instanceId: SESSION, targetSessionId: SESSION, worktreePath: '/repo/wt', timestamp: 4_000 })
    expect(observed).toHaveLength(0)
    expect(capture.pending(MESH).map((n) => n.event)).toEqual(['worktree_bootstrap_complete'])
    expect((components as any).router.markWorktreeBootstrapTerminalState).toHaveBeenCalledWith(MESH, 'node_1', 'complete', expect.objectContaining({ workspace: '/repo/wt' }))
    off()
  })
})
