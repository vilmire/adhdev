import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// TRANSCRIPT-COMPLETION-STALL-RESCUE (P2 of the transcript-authority unification):
// tryReconcileTranscriptCompletionForStall(). Historically two class-enumerated
// copies — KIMI-PURE-PTY-COMPLETION-EMIT (Fix 3) and KIMI-NATIVE-SOURCE-
// COMPLETION-EMIT — with identical bodies. A finished worker whose
// agent:generating_completed never emitted (idle→idle collapse) sits at a static
// idle prompt; the status-agnostic no-progress watchdog (checkMeshWorkerStall)
// would misread that quiet as a wedge and false-fire monitor:no_progress. This
// guard, run just before the fire, emits the missing completion from the
// class-appropriate transcript evidence (completionFinalSummary picks: native
// history for a native-source provider, the PTY parse otherwise) and suppresses
// the stall. daemon-owned providers, mid-turn workers, and workers with no final
// assistant are left to the real stall path.

describe('CliProviderInstance.tryReconcileTranscriptCompletionForStall', () => {
  function makeInstance(opts: {
    provider: any
    settings: Record<string, any>
    turnStartedAt: number
    meshTaskInjectedAt: number
    finalSummary: string | undefined
    hasPending?: boolean
    lastEmittedCompletion?: { taskId: string; at: number; weak?: boolean; emittedAtEpoch?: number } | null
  }) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-1'
    instance.type = 'kimi'
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'prov-sess-1'
    instance.provider = opts.provider
    instance.settings = opts.settings
    instance.events = []
    instance.startedAt = 1_000
    instance.meshTaskInjectedAt = opts.meshTaskInjectedAt
    instance.lastCompletionSummary = null
    instance.lastEmittedCompletion = opts.lastEmittedCompletion ?? null
    const adapter = {
      currentTurnTaskId: undefined as string | undefined,
      currentTurnStartedAt: opts.turnStartedAt,
      isWaitingForResponse: false,
      currentTurnScope: undefined,
      getScriptParsedStatus() { return { messages: [] } },
      getPartialResponse() { return opts.hasPending ? 'still typing' : '' },
    }
    instance.adapter = adapter
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    // Stub the turn-scoped final-summary resolution (the real path reads the
    // class-appropriate transcript; the evidence GATE is what we exercise here).
    instance.completionFinalSummary = () => opts.finalSummary
    return { instance, emitted, adapter }
  }

  const purePtyProvider = {
    type: 'kimi',
    nativeHistory: undefined,
    tui: { transcriptPty: { scope: 'buffer' } },
  }
  const nativeSourceProvider = {
    type: 'kimi',
    transcriptAuthority: 'provider',
    nativeHistory: { source: { kind: 'jsonl' } },
    tui: { transcriptPty: { scope: 'buffer' } },
  }
  // daemon-owned: no provider authority, no native history, and NOT the
  // buffer-scope pure-PTY shape — real PTY turn events are expected, so the
  // rescue must never swallow its stall.
  const daemonOwnedProvider = {
    type: 'other',
    nativeHistory: undefined,
    tui: {},
  }
  const meshSettings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }

  it('emits the missing completion (and returns true) for a finished pure-PTY idle worker', () => {
    const { instance, emitted } = makeInstance({
      provider: purePtyProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done: committed and pushed',
    })
    const result = instance.tryReconcileTranscriptCompletionForStall('idle')
    expect(result).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('agent:generating_completed')
    expect(emitted[0].taskId).toBe('task-1')
    expect(emitted[0].finalSummary).toBe('done: committed and pushed')
    expect(emitted[0].evidenceLevel).toBe('transcript')
    // Telemetry keeps the historical per-class source string.
    expect(emitted[0].completionDiagnostic).toMatchObject({ source: 'stall_pure_pty_transcript_completion' })
  })

  it('emits the missing completion (and returns true) for a finished native-source idle worker', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done: implemented and committed',
    })
    const result = instance.tryReconcileTranscriptCompletionForStall('idle')
    expect(result).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('agent:generating_completed')
    expect(emitted[0].finalSummary).toBe('done: implemented and committed')
    expect(emitted[0].completionDiagnostic).toMatchObject({ source: 'stall_native_source_transcript_completion' })
  })

  it('returns false (real stall fires) for a daemon-owned provider — the only excluded class', () => {
    const { instance, emitted } = makeInstance({
      provider: daemonOwnedProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
    })
    expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  for (const [label, provider] of [['pure-PTY', purePtyProvider], ['native-source', nativeSourceProvider]] as const) {
    it(`returns false when the worker is NOT idle (${label} — mid-turn, let the real stall path evaluate)`, () => {
      const { instance, emitted } = makeInstance({
        provider,
        settings: meshSettings,
        meshTaskInjectedAt: 2_000,
        turnStartedAt: 3_000,
        finalSummary: 'done',
      })
      expect(instance.tryReconcileTranscriptCompletionForStall('generating')).toBe(false)
      expect(emitted).toHaveLength(0)
    })

    it(`returns false when the adapter still has a pending response (${label} — turn not over)`, () => {
      const { instance, emitted } = makeInstance({
        provider,
        settings: meshSettings,
        meshTaskInjectedAt: 2_000,
        turnStartedAt: 3_000,
        finalSummary: 'done',
        hasPending: true,
      })
      expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(false)
      expect(emitted).toHaveLength(0)
    })

    it(`returns false when there is no in-turn final assistant evidence (${label} — genuine wedge → real stall)`, () => {
      const { instance, emitted } = makeInstance({
        provider,
        settings: meshSettings,
        meshTaskInjectedAt: 2_000,
        turnStartedAt: 3_000,
        finalSummary: undefined,
      })
      expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(false)
      expect(emitted).toHaveLength(0)
    })

    it(`returns false when this turn completion already fired (${label} — double-emit guard)`, () => {
      const { instance, emitted } = makeInstance({
        provider,
        settings: meshSettings,
        meshTaskInjectedAt: 2_000,
        turnStartedAt: 3_000,
        finalSummary: 'done',
        lastEmittedCompletion: { taskId: 'task-1', at: 5_000 },
      })
      expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(false)
      expect(emitted).toHaveLength(0)
    })

    it(`returns false when the injected task never actually started its turn (${label} — stale tail)`, () => {
      const { instance, emitted } = makeInstance({
        provider,
        settings: meshSettings,
        meshTaskInjectedAt: 5_000,
        turnStartedAt: 3_000, // turn start PREDATES injection → this task never ran
        finalSummary: 'stale tail from a prior task',
      })
      expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(false)
      expect(emitted).toHaveLength(0)
    })
  }
})
