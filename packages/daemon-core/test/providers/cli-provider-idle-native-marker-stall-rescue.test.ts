import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// IDLE-NATIVE-MARKER-STALL-RESCUE — the "finished turn reported as a stall" class.
//
// THE INCIDENT THIS EXISTS FOR (2026-09-20, coordinator daemon log
// daemon-19223-2026-09-20.log, session 89b94ed3 / task 07cfa78a, codex-cli):
// a worker finished its turn and went IDLE (07:55:30 status report shows
// `codex-cli(idle)`), but the coordinator never received a completion. Instead,
// 63s later the stall watchdog fired `monitor:no_progress`, and the reconcile
// committed a TERMINAL FAILED for the task (`source=stall_reconcile`). The task
// had really succeeded — the coordinator only learned that by calling
// read_terminal by hand.
//
// THE ASYMMETRY THAT CAUSED IT. tryReconcileTranscriptCompletionForStall
// consulted the provider's own turn-terminal record — the strongest evidence the
// engine has — on exactly ONE of its two admission paths:
//
//   observedStatus === 'generating'  → FLOOR-TIMING-WEDGE: marker consulted.
//                                      A summary-less turn IS released (the
//                                      sibling suite pins this for the whole
//                                      floor class).
//   observedStatus === 'idle'        → marker NEVER consulted. For a
//                                      native-source provider the verdict came
//                                      solely from the `final_assistant_present`
//                                      signal, so a turn that ended on a tool
//                                      call or with an empty reply — 19.5% of
//                                      measured codex turns, per the module's own
//                                      comment — returned false and a FALSE
//                                      stall fired.
//
// So the harder case (wedged in `generating`) was rescued while the easy, common
// case (cleanly idle) was not. That is backwards: idle is strictly WEAKER
// evidence of a live turn than a stuck generating flag, so any turn the marker
// releases while generating must also be released while idle.
//
// WHY THIS IS A PERMANENT LOSS, NOT A DEFERRAL. The rescue is the last net
// before the watchdog fires. Once `monitor:no_progress` leads to a
// `task_stalled` ledger entry, the reconcile path takes
// `assigned_stranded_terminal_ledger` — "terminal evidence already exists" — and
// never re-reads the transcript. The completion has nowhere left to come from.
//
// These tests pin BOTH directions, mirroring the wedge suite:
//   (1) idle + the provider's own terminal record → reconciled (even with no text)
//   (2) idle + no terminal record + no summary    → NOT reconciled (real stall)
describe('IDLE-NATIVE-MARKER-STALL-RESCUE: an idle turn the provider recorded as finished', () => {
  function makeInstance(opts: {
    provider: any
    finalSummary?: string | undefined
    terminalMarker?: { receivedAt: number; outcome: 'completed' | 'aborted'; summary: string; turnId?: string } | null
    /**
     * The shared TranscriptSignalSource snapshot the watchdog already read this
     * tick. `final_assistant_present: false` is the live incident shape: a real,
     * available native read that found no assistant bubble because the turn
     * ended on a tool call.
     */
    signalFinalAssistantPresent?: boolean | null
    liveEvidence?: { pending: boolean; kind?: 'adapter' | 'modal' | 'transcript_tool' }
  }) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-idle-marker-1'
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
      // The idle signature: the adapter has already closed the turn.
      isWaitingForResponse: false,
      currentTurnScope: undefined,
      getScriptParsedStatus() { return { messages: [] } },
      getPartialResponse() { return '' },
    }
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    instance.completionFinalSummary = () => opts.finalSummary
    instance.nativeTurnTerminalMarker = () => opts.terminalMarker ?? null
    if (opts.liveEvidence) instance.getLiveTurnPendingEvidence = () => opts.liveEvidence
    const signals = {
      snapshot: {
        available: true,
        signals: {
          final_assistant_present: opts.signalFinalAssistantPresent ?? false,
          in_turn_progress: false,
          transcript_growing: false,
        },
        detail: { msgCount: 4, sourceMtimeMs: 8_000 },
      },
      messages: [],
    }
    return { instance, emitted, signals }
  }

  // Same floor class as the wedge suite — this is not a codex-specific patch.
  const FLOOR_PROVIDERS = [
    { type: 'codex-cli', transcriptAuthority: 'provider', requiresFinalAssistantBeforeIdle: true, nativeHistory: { source: { kind: 'jsonl' }, mode: 'native-source', completionSignal: { recordType: 'task_complete' } } },
    { type: 'kimi', transcriptAuthority: 'provider', requiresFinalAssistantBeforeIdle: true, nativeHistory: { source: { kind: 'jsonl' }, mode: 'native-source' }, tui: { transcriptPty: { scope: 'buffer' } } },
  ]

  for (const provider of FLOOR_PROVIDERS) {
    // (1) THE INCIDENT ITSELF. Pre-fix this returned false — the signal said
    // "no final assistant", and the idle path never asked the marker.
    it(`reconciles an idle turn the provider recorded as finished, with no assistant text (${provider.type})`, () => {
      const { instance, emitted, signals } = makeInstance({
        provider,
        finalSummary: undefined,
        signalFinalAssistantPresent: false,
        terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: '', turnId: 'turn-11' },
      })

      const result = instance.tryReconcileTranscriptCompletionForStall('idle', signals)

      // ★ The assertion is DELIVERY, not "did not drop": a completion event must
      // actually be emitted for this task, which is what the coordinator consumes.
      expect(result).toBe(true)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].event).toBe('agent:generating_completed')
      expect(emitted[0].taskId).toBe('task-1')
      expect(emitted[0].completionDiagnostic).toMatchObject({
        source: 'stall_idle_native_turn_end',
        nativeTurnOutcome: 'completed',
        nativeTurnId: 'turn-11',
      })
    })

    // The marker also supplies the payload when it carries text, so the
    // coordinator gets a real summary rather than an empty completion.
    it(`carries the marker's own summary into the emitted completion (${provider.type})`, () => {
      const { instance, emitted, signals } = makeInstance({
        provider,
        finalSummary: undefined,
        signalFinalAssistantPresent: false,
        terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: 'done: audited all drop paths' },
      })

      expect(instance.tryReconcileTranscriptCompletionForStall('idle', signals)).toBe(true)
      expect(emitted[0].finalSummary).toBe('done: audited all drop paths')
    })

    // (2) THE REGRESSION GUARD, opposite direction. This is the 2026-08-18 class:
    // a worker mid-turn in a quiet valley must NOT be force-completed. Without a
    // terminal record and without an in-turn final assistant there is no proof of
    // a turn end, so the real stall must still fire.
    it(`does NOT reconcile an idle-quiet session with no terminal record and no summary (${provider.type})`, () => {
      const { instance, emitted, signals } = makeInstance({
        provider,
        finalSummary: undefined,
        signalFinalAssistantPresent: false,
        terminalMarker: null,
      })

      expect(instance.tryReconcileTranscriptCompletionForStall('idle', signals)).toBe(false)
      expect(emitted).toHaveLength(0)
    })
  }

  // The marker must stay TURN-SCOPED. nativeTurnTerminalMarker already resolves
  // the scope (turn id first, turn-start boundary otherwise) and returns null for
  // a prior turn's marker — so a stale marker reaches this path as null and the
  // ANTIGRAVITY-PREMATURE-COMPLETION rule is preserved on the idle path too.
  it('does not reconcile when the marker belongs to a prior turn (resolved as null)', () => {
    const { instance, emitted, signals } = makeInstance({
      provider: FLOOR_PROVIDERS[0],
      finalSummary: undefined,
      signalFinalAssistantPresent: false,
      terminalMarker: null,
    })

    expect(instance.tryReconcileTranscriptCompletionForStall('idle', signals)).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  // MID-TURN-LIVE-STATE parity must still veto on the idle path: a parked modal
  // is a REAL pending user decision even when the FSM reads idle (flap/lag), and
  // trailing tool activity means the turn is still progressing. The marker does
  // not outrank live pending evidence here — the watchdog re-polls, so a veto
  // only defers the rescue.
  for (const kind of ['modal', 'transcript_tool'] as const) {
    it(`still refuses an idle session with live pending evidence (${kind}), even with a terminal record`, () => {
      const { instance, emitted, signals } = makeInstance({
        provider: FLOOR_PROVIDERS[0],
        signalFinalAssistantPresent: false,
        terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: 'done' },
        liveEvidence: { pending: true, kind },
      })

      expect(instance.tryReconcileTranscriptCompletionForStall('idle', signals)).toBe(false)
      expect(emitted).toHaveLength(0)
    })
  }

  // The existing shape path must keep working unchanged: an idle session WITH an
  // in-turn final assistant is reconciled off the signal, as before, and keeps
  // its historical diagnostic source so traces stay comparable.
  it('still reconciles the ordinary shape path (final assistant present, no marker)', () => {
    const { instance, emitted, signals } = makeInstance({
      provider: FLOOR_PROVIDERS[0],
      signalFinalAssistantPresent: true,
      terminalMarker: null,
    })
    // The signal is the verdict; the PAYLOAD is extracted from the same messages
    // the signal was normalized from (not completionFinalSummary, which this
    // branch deliberately bypasses), so the fixture must carry a real bubble.
    signals.messages = [
      { role: 'assistant', content: 'shape-path summary', timestamp: 9_500 },
    ] as any

    expect(instance.tryReconcileTranscriptCompletionForStall('idle', signals)).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].completionDiagnostic).toMatchObject({ source: 'stall_native_source_transcript_completion' })
  })

  // daemon-owned providers get real PTY turn events; their quiet is a genuine
  // anomaly the stall should surface. The idle marker path must not swallow it.
  it('never reconciles a daemon-owned provider, even idle with a terminal record', () => {
    const { instance, emitted, signals } = makeInstance({
      provider: { type: 'other', nativeHistory: undefined, tui: {} },
      terminalMarker: { receivedAt: 9_000, outcome: 'completed', summary: 'done' },
    })

    expect(instance.tryReconcileTranscriptCompletionForStall('idle', signals)).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})
