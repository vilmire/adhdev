import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// KIMI-PURE-PTY-COMPLETION-EMIT (Fix 3): tryReconcilePurePtyCompletionForStall().
// A finished pure-PTY worker (kimi and kin — tui.transcriptPty.scope 'buffer', NO
// nativeHistory, NOT transcriptAuthority:'provider') sits at a static idle prompt
// after rendering its answer. Because it never emitted agent:generating_completed
// (the onTurnStarted idle→idle collapse Fix 1 addresses at the source), the
// status-agnostic no-progress watchdog (checkMeshWorkerStall) would misread that
// quiet as a wedge and false-fire monitor:no_progress. This guard, run just before
// the fire, emits the missing completion from PTY transcript evidence and suppresses
// the stall. Native-source providers, mid-turn workers, and workers with no final
// assistant are left to the real stall path.

describe('CliProviderInstance.tryReconcilePurePtyCompletionForStall', () => {
  function makeInstance(opts: {
    provider: any
    settings: Record<string, any>
    observedStatus?: string
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
    // Stub the turn-scoped final-summary resolution (the real path reads the PTY
    // transcript; the evidence GATE is what we exercise here, not the parser).
    instance.completionFinalSummary = () => opts.finalSummary
    return { instance, emitted, adapter }
  }

  const purePtyProvider = {
    type: 'kimi',
    nativeHistory: undefined,
    tui: { transcriptPty: { scope: 'buffer' } },
  }
  const nativeSourceProvider = {
    type: 'antigravity',
    nativeHistory: { format: 'jsonl' },
    tui: { transcriptPty: { scope: 'buffer' } },
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
    const result = instance.tryReconcilePurePtyCompletionForStall('idle')
    expect(result).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('agent:generating_completed')
    expect(emitted[0].taskId).toBe('task-1')
    expect(emitted[0].finalSummary).toBe('done: committed and pushed')
    expect(emitted[0].evidenceLevel).toBe('transcript')
    expect(emitted[0].completionDiagnostic).toMatchObject({ source: 'stall_pure_pty_transcript_completion' })
  })

  it('returns false (real stall fires) for a native-source provider — handled by the native reconcile', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
    })
    expect(instance.tryReconcilePurePtyCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when the worker is NOT idle (mid-turn — let the real stall path evaluate)', () => {
    const { instance, emitted } = makeInstance({
      provider: purePtyProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
    })
    expect(instance.tryReconcilePurePtyCompletionForStall('generating')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when the adapter still has a pending response (turn not over)', () => {
    const { instance, emitted } = makeInstance({
      provider: purePtyProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
      hasPending: true,
    })
    expect(instance.tryReconcilePurePtyCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when there is no in-turn final assistant evidence (genuine wedge → real stall)', () => {
    const { instance, emitted } = makeInstance({
      provider: purePtyProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: undefined,
    })
    expect(instance.tryReconcilePurePtyCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when this turn completion already fired (double-emit guard)', () => {
    const { instance, emitted } = makeInstance({
      provider: purePtyProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
      lastEmittedCompletion: { taskId: 'task-1', at: 5_000 },
    })
    expect(instance.tryReconcilePurePtyCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when the injected task never actually started its turn (stale tail)', () => {
    const { instance, emitted } = makeInstance({
      provider: purePtyProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 5_000,
      turnStartedAt: 3_000, // turn start PREDATES injection → this task never ran
      finalSummary: 'stale tail from a prior task',
    })
    expect(instance.tryReconcilePurePtyCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})

// KIMI-NATIVE-SOURCE-COMPLETION-EMIT (Fix 3): tryReconcileNativeSourceCompletionForStall().
// The mirror of the pure-PTY guard for the NATIVE-SOURCE class (transcriptAuthority='provider'
// + nativeHistory — e.g. kimi's wire.jsonl). A finished native-source worker whose transcript
// has gone static (sampleNativeTranscriptProgress stopped re-arming) sits at a quiet idle prompt
// and, having never emitted agent:generating_completed, is misread as a wedge by the watchdog.
// The pure-PTY guard is a no-op for this class (isPurePtyTranscriptProvider is false for a
// native-source provider), so this fallback emits the missing completion off the authoritative
// native transcript (via completionFinalSummary) and suppresses the stall.
describe('CliProviderInstance.tryReconcileNativeSourceCompletionForStall', () => {
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
    // Stub the final-summary resolution — the native method reads the native transcript via
    // completionFinalSummary; the evidence GATE is what we exercise here, not the reader.
    instance.completionFinalSummary = () => opts.finalSummary
    return { instance, emitted, adapter }
  }

  const nativeSourceProvider = {
    type: 'kimi',
    transcriptAuthority: 'provider',
    nativeHistory: { source: { kind: 'jsonl' } },
    tui: { transcriptPty: { scope: 'buffer' } },
  }
  const purePtyProvider = {
    type: 'kimi',
    nativeHistory: undefined,
    tui: { transcriptPty: { scope: 'buffer' } },
  }
  const meshSettings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }

  it('emits the missing completion (and returns true) for a finished native-source idle worker', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done: implemented and committed',
    })
    const result = instance.tryReconcileNativeSourceCompletionForStall('idle')
    expect(result).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('agent:generating_completed')
    expect(emitted[0].taskId).toBe('task-1')
    expect(emitted[0].finalSummary).toBe('done: implemented and committed')
    expect(emitted[0].evidenceLevel).toBe('transcript')
    expect(emitted[0].completionDiagnostic).toMatchObject({ source: 'stall_native_source_transcript_completion' })
  })

  it('returns false (real stall / pure-PTY path handles it) for a pure-PTY provider', () => {
    const { instance, emitted } = makeInstance({
      provider: purePtyProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
    })
    expect(instance.tryReconcileNativeSourceCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when the worker is NOT idle (mid-turn — let the real stall path evaluate)', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
    })
    expect(instance.tryReconcileNativeSourceCompletionForStall('generating')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when the adapter still has a pending response (turn not over)', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
      hasPending: true,
    })
    expect(instance.tryReconcileNativeSourceCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when there is no in-turn final assistant evidence (genuine wedge → real stall)', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: undefined,
    })
    expect(instance.tryReconcileNativeSourceCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when this turn completion already fired (double-emit guard)', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 2_000,
      turnStartedAt: 3_000,
      finalSummary: 'done',
      lastEmittedCompletion: { taskId: 'task-1', at: 5_000 },
    })
    expect(instance.tryReconcileNativeSourceCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('returns false when the injected task never actually started its turn (stale tail)', () => {
    const { instance, emitted } = makeInstance({
      provider: nativeSourceProvider,
      settings: meshSettings,
      meshTaskInjectedAt: 5_000,
      turnStartedAt: 3_000, // turn start PREDATES injection → this task never ran
      finalSummary: 'stale tail from a prior task',
    })
    expect(instance.tryReconcileNativeSourceCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})
