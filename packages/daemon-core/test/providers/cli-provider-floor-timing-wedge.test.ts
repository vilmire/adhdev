import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// FLOOR-TIMING-WEDGE — the "completed turn stuck in `generating` forever" class.
//
// A floor-timing provider (requiresFinalAssistantBeforeIdle: codex-cli / kimi /
// opencode / cursor-cli) cannot close a turn from PTY parsing alone; finishResponse()
// only closes it once the native transcript PROVES the turn ended. When that proof
// cannot be resolved (providerSessionId unbound, or the timeboxed rollout lookup
// misses), the adapter's blocked path early-returns WITHOUT resetActiveTurnState(),
// so currentStatus stays 'generating' permanently (cli-state-engine.ts:162-182).
//
// The stall-path rescue could have reconciled exactly that session from the native
// transcript — but it was gated on `observedStatus === 'idle'`, a state the wedged
// session can never reach. The rescue demanded as a precondition the very state it
// existed to repair, so all that remained was a cosmetic monitor:no_progress.
//
// These tests pin BOTH directions of the relaxed gate, across the FLOOR CLASS
// generally (not codex alone — every provider below rides the same chain):
//   (1) wedged 'generating' + provider's own turn-terminal record  → reconciled
//   (2) genuinely mid-turn (no terminal record)                     → NOT reconciled
describe('FLOOR-TIMING-WEDGE: stall rescue for a session wedged in generating', () => {
  function makeInstance(opts: {
    provider: any
    finalSummary?: string | undefined
    terminalMarker?: { receivedAt: number; outcome: 'completed' | 'aborted'; summary: string; turnId?: string } | null
    hasPending?: boolean
  }) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-wedge-1'
    instance.type = opts.provider.type
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'prov-sess-1'
    instance.provider = opts.provider
    instance.settings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }
    instance.events = []
    instance.startedAt = 1_000
    instance.meshTaskInjectedAt = 2_000
    instance.lastCompletionSummary = null
    instance.lastEmittedCompletion = null
    instance.adapter = {
      currentTurnTaskId: 'task-1',
      currentTurnStartedAt: 3_000,
      // The wedge signature: the adapter still believes a turn is in flight,
      // because the blocked finish never ran resetActiveTurnState().
      isWaitingForResponse: opts.hasPending ?? true,
      currentTurnScope: opts.hasPending ?? true ? {} : undefined,
      getScriptParsedStatus() { return { messages: [] } },
      getPartialResponse() { return opts.hasPending ?? true ? 'still generating' : '' },
    }
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    instance.completionFinalSummary = () => opts.finalSummary
    // The provider's own turn-terminal record (codex task_complete and any provider
    // declaring nativeHistory.completionSignal). null = the provider has NOT recorded
    // this turn as over.
    instance.nativeTurnTerminalMarker = () => opts.terminalMarker ?? null
    return { instance, emitted }
  }

  // Every floor-timing provider: same requiresFinalAssistantBeforeIdle chain, so the
  // fix must hold for all of them — this is not a codex-specific patch.
  const FLOOR_PROVIDERS = [
    { type: 'codex-cli', transcriptAuthority: 'provider', requiresFinalAssistantBeforeIdle: true, nativeHistory: { source: { kind: 'jsonl' }, completionSignal: { recordType: 'task_complete' } } },
    { type: 'kimi', transcriptAuthority: 'provider', requiresFinalAssistantBeforeIdle: true, nativeHistory: { source: { kind: 'jsonl' } }, tui: { transcriptPty: { scope: 'buffer' } } },
    { type: 'opencode', transcriptAuthority: 'provider', requiresFinalAssistantBeforeIdle: true, nativeHistory: { source: { kind: 'jsonl' } }, tui: { transcriptPty: { scope: 'buffer' } } },
    { type: 'cursor-cli', transcriptAuthority: 'provider', requiresFinalAssistantBeforeIdle: true, nativeHistory: { source: { kind: 'jsonl' } }, tui: { transcriptPty: { scope: 'buffer' } } },
  ]

  for (const provider of FLOOR_PROVIDERS) {
    // (1) THE WEDGE ITSELF. Pre-fix this returned false for every provider here,
    // because observedStatus was 'generating' — the state the wedge guarantees.
    it(`reconciles a wedged 'generating' turn the provider recorded as finished (${provider.type})`, () => {
      const { instance, emitted } = makeInstance({
        provider,
        terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: 'done: committed b50e91ee', turnId: 'turn-7' },
      })

      const result = instance.tryReconcileTranscriptCompletionForStall('generating')

      expect(result).toBe(true)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].event).toBe('agent:generating_completed')
      expect(emitted[0].taskId).toBe('task-1')
      expect(emitted[0].finalSummary).toBe('done: committed b50e91ee')
      expect(emitted[0].completionDiagnostic).toMatchObject({
        source: 'stall_wedged_generating_native_turn_end',
        wedgedObservedStatus: 'generating',
        nativeTurnOutcome: 'completed',
        nativeTurnId: 'turn-7',
      })
    })

    // (2) THE REGRESSION GUARD, opposite direction. A session that is ACTUALLY still
    // working looks identical to the wedge on every PTY/adapter axis — same
    // 'generating', same stuck-looking pending flag. Only the absence of the
    // provider's terminal record separates them, so this is what stops the relaxed
    // gate from force-completing live work.
    it(`does NOT reconcile a genuinely mid-turn session with no terminal record (${provider.type})`, () => {
      const { instance, emitted } = makeInstance({
        provider,
        terminalMarker: null,
        finalSummary: 'an interim narration bubble that is not a turn end',
      })

      expect(instance.tryReconcileTranscriptCompletionForStall('generating')).toBe(false)
      expect(emitted).toHaveLength(0)
    })
  }

  // A turn-terminated-by-tool-call / empty-reply turn writes NO assistant text
  // (19.5% of measured codex turns). Shape inference can never judge it, so the
  // marker must release it on its own — otherwise the summary-less turns stay
  // wedged and the fix would only cover the easy half of the class.
  it('reconciles a marker-proven turn that carries no assistant text at all', () => {
    const { instance, emitted } = makeInstance({
      provider: FLOOR_PROVIDERS[0],
      finalSummary: undefined,
      terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: '' },
    })

    expect(instance.tryReconcileTranscriptCompletionForStall('generating')).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].completionDiagnostic).toMatchObject({ source: 'stall_wedged_generating_native_turn_end' })
  })

  // An aborted turn is genuinely over — it will never receive a final assistant, so
  // leaving it 'generating' is the same permanent wedge with a different cause.
  it('reconciles an aborted turn (never receives a final assistant)', () => {
    const { instance, emitted } = makeInstance({
      provider: FLOOR_PROVIDERS[0],
      terminalMarker: { receivedAt: 9_000, outcome: 'aborted', summary: '' },
    })

    expect(instance.tryReconcileTranscriptCompletionForStall('generating')).toBe(true)
    expect(emitted[0].completionDiagnostic).toMatchObject({ nativeTurnOutcome: 'aborted' })
  })

  // The gate was OPENED for 'generating', not removed for everything. A parked
  // approval carries a REAL pending user decision; force-completing it would discard
  // that decision, which is strictly worse than the wedge (the same reasoning that
  // excludes guard (a) from the adapter-side hard cap).
  for (const status of ['waiting_approval', 'waiting_choice', 'starting', 'unknown']) {
    it(`still refuses to reconcile status='${status}' even with a terminal record`, () => {
      const { instance, emitted } = makeInstance({
        provider: FLOOR_PROVIDERS[0],
        terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: 'done' },
      })

      expect(instance.tryReconcileTranscriptCompletionForStall(status)).toBe(false)
      expect(emitted).toHaveLength(0)
    })
  }

  // daemon-owned providers get real PTY turn events; their quiet is a genuine
  // anomaly the stall should surface. The relaxed gate must not swallow it.
  it('never reconciles a daemon-owned provider, even wedged with a terminal record', () => {
    const { instance, emitted } = makeInstance({
      provider: { type: 'other', nativeHistory: undefined, tui: {} },
      terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: 'done' },
    })

    expect(instance.tryReconcileTranscriptCompletionForStall('generating')).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})
