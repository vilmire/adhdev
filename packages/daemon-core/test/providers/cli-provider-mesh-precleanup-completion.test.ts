import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// KIMI-MESH-COMPLETION-EMIT (axis 2): flushMeshCompletionBeforeCleanup(). A mesh
// DELEGATED worker whose PTY exits (e.g. killed by a false stall) AFTER finishing
// its task but BEFORE the FSM emitted the completion event would leave the
// coordinator waiting for the ~180s reconcile transcript-poll. The cli-manager
// exit monitor calls this method right before removeInstance closes the emit
// window: if the native transcript proves the turn finished and no completion
// already fired, it emits one last completion. Guards: mesh-worker-only, a
// double-emit guard (never re-emit a turn whose completion already fired), and an
// evidence gate (in-turn final assistant summary required).

describe('CliProviderInstance.flushMeshCompletionBeforeCleanup', () => {
  function makeInstance(opts: {
    settings: Record<string, any>
    turnStartedAt: number
    meshTaskInjectedAt: number
    finalSummary: string | undefined
    lastEmittedCompletion?: { taskId: string; at: number } | null
  }) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-1'
    instance.type = 'kimi'
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'prov-sess-1'
    instance.settings = opts.settings
    instance.events = []
    instance.startedAt = 1_000
    instance.meshTaskInjectedAt = opts.meshTaskInjectedAt
    instance.lastCompletionSummary = null
    instance.lastEmittedCompletion = opts.lastEmittedCompletion ?? null
    const adapter = {
      currentTurnTaskId: undefined as string | undefined,
      currentTurnStartedAt: opts.turnStartedAt,
      getScriptParsedStatus() { return { messages: [] } },
    }
    instance.adapter = adapter
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    // Stub the turn-scoped final-summary resolution (the real path reads the native
    // transcript; the evidence GATE is what we exercise here, not the parser).
    instance.completionFinalSummary = () => opts.finalSummary
    return { instance, emitted, adapter }
  }

  const meshSettings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }

  it('emits a completion when a mesh worker finished (transcript evidence) but never emitted one', () => {
    const { instance, emitted } = makeInstance({
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000, // turn started AFTER injection → injected task genuinely ran
      finalSummary: 'done: committed and pushed',
    })
    const result = instance.flushMeshCompletionBeforeCleanup()
    expect(result).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('agent:generating_completed')
    expect(emitted[0].taskId).toBe('task-1')
    expect(emitted[0].finalSummary).toBe('done: committed and pushed')
    expect(emitted[0].evidenceLevel).toBe('transcript')
    // Double-emit guard is now armed for this task.
    expect(instance.lastEmittedCompletion).toEqual({ taskId: 'task-1', at: expect.any(Number) })
  })

  it('does NOT re-emit when this turn completion already fired (double-emit guard)', () => {
    const { instance, emitted } = makeInstance({
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
      lastEmittedCompletion: { taskId: 'task-1', at: 5_000 },
    })
    const result = instance.flushMeshCompletionBeforeCleanup()
    expect(result).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('does NOT emit for a non-mesh session', () => {
    const { instance, emitted } = makeInstance({
      settings: {}, // no mesh markers
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
    })
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('does NOT emit when there is no in-turn transcript evidence (unfinished worker → leave to reclaim)', () => {
    const { instance, emitted } = makeInstance({
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: undefined, // no final assistant summary
    })
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('does NOT emit when the injected task never actually started its turn', () => {
    const { instance, emitted } = makeInstance({
      settings: meshSettings,
      meshTaskInjectedAt: 5_000,
      turnStartedAt: 3_000, // turn start PREDATES injection → this task never ran
      finalSummary: 'stale tail from a prior task',
    })
    expect(instance.flushMeshCompletionBeforeCleanup()).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})
