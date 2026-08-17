import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// MID-TURN-LIVE-STATE parity on the stall-rescue emit paths (M1-deletion
// prerequisite — docs/design/2026-08-17-mesh-hold-absorption.md).
//
// Historically tryReconcileTranscriptCompletionForStall gated only on the
// ADAPTER axis (hasAdapterPendingResponse); a parked modal or trailing
// transcript-tool activity could slip a synthetic completion out, and the
// delivery-time mesh gate (MID-TURN-LIVE-STATE-GATE in mesh-event-forwarding)
// existed to catch exactly that. These tests pin the source-side vetoes so the
// mesh-layer hold can eventually be deleted:
//   • kind 'modal'           → veto (a real pending user decision)
//   • kind 'transcript_tool' → veto (the turn is still progressing)
//   • kind 'adapter'         → NOT vetoed by the parity check (the idle path
//     already gates on hasAdapterPendingResponse; for the wedged-generating
//     admission the stuck adapter flag IS the wedge being cleared)
// The watchdog re-polls, so a veto only defers the rescue — asserted via the
// unmarked once-per-turn guard on the startup-grace synth path.

describe('stall-rescue MID-TURN-LIVE-STATE parity vetoes', () => {
  function makeInstance(opts: {
    finalSummary: string | undefined
    liveEvidence?: { pending: boolean; kind?: 'adapter' | 'modal' | 'transcript_tool' }
    terminalMarker?: Record<string, unknown> | null
    adapterWaiting?: boolean
  }) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-parity-1'
    instance.type = 'kimi'
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'prov-sess-1'
    instance.provider = {
      type: 'kimi',
      transcriptAuthority: 'provider',
      nativeHistory: { source: { kind: 'jsonl' } },
      tui: { transcriptPty: { scope: 'buffer' } },
    }
    instance.settings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }
    instance.events = []
    instance.startedAt = 1_000
    instance.meshTaskInjectedAt = 2_000
    instance.lastCompletionSummary = null
    instance.lastEmittedCompletion = null
    instance.adapter = {
      currentTurnTaskId: undefined as string | undefined,
      currentTurnStartedAt: 3_000,
      isWaitingForResponse: opts.adapterWaiting ?? false,
      currentTurnScope: undefined,
      getScriptParsedStatus() { return { messages: [] } },
      getPartialResponse() { return '' },
    }
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    instance.completionFinalSummary = () => opts.finalSummary
    if (opts.liveEvidence !== undefined) {
      instance.getLiveTurnPendingEvidence = () => opts.liveEvidence
    }
    if (opts.terminalMarker !== undefined) {
      instance.nativeTurnTerminalMarker = () => opts.terminalMarker
    }
    return { instance, emitted }
  }

  it('control: with no live pending evidence the idle rescue still emits', () => {
    const { instance, emitted } = makeInstance({
      finalSummary: 'done: implemented and committed',
      liveEvidence: { pending: false },
    })
    expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('agent:generating_completed')
  })

  it('vetoes the idle rescue while a modal is parked (kind=modal)', () => {
    const { instance, emitted } = makeInstance({
      finalSummary: 'done: implemented and committed',
      liveEvidence: { pending: true, kind: 'modal' },
    })
    expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('vetoes the idle rescue while trailing transcript tools are active (kind=transcript_tool)', () => {
    const { instance, emitted } = makeInstance({
      finalSummary: 'done: implemented and committed',
      liveEvidence: { pending: true, kind: 'transcript_tool' },
    })
    expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('does NOT veto on kind=adapter — that axis stays owned by hasAdapterPendingResponse', () => {
    const { instance, emitted } = makeInstance({
      finalSummary: 'done: implemented and committed',
      liveEvidence: { pending: true, kind: 'adapter' },
    })
    expect(instance.tryReconcileTranscriptCompletionForStall('idle')).toBe(true)
    expect(emitted).toHaveLength(1)
  })

  it('vetoes the wedged-generating admission when a modal is parked over the wedge', () => {
    const { instance, emitted } = makeInstance({
      finalSummary: 'done: implemented and committed',
      terminalMarker: { status: 'completed' },
      adapterWaiting: true, // the stuck flag IS the wedge — never a veto by itself
      liveEvidence: { pending: true, kind: 'modal' },
    })
    expect(instance.tryReconcileTranscriptCompletionForStall('generating')).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  it('wedged-generating control: adapter-pending alone still reconciles once the marker proves the turn ended', () => {
    const { instance, emitted } = makeInstance({
      finalSummary: 'done: implemented and committed',
      terminalMarker: { status: 'completed' },
      adapterWaiting: true,
      liveEvidence: { pending: true, kind: 'adapter' },
    })
    expect(instance.tryReconcileTranscriptCompletionForStall('generating')).toBe(true)
    expect(emitted).toHaveLength(1)
  })
})

describe('startup-grace synth MID-TURN-LIVE-STATE parity veto', () => {
  function makeSynthInstance(opts: {
    liveEvidence?: { pending: boolean; kind?: 'adapter' | 'modal' | 'transcript_tool' }
  }) {
    const emitted: any[] = []
    const pushed: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-synth-1'
    instance.type = 'kimi'
    instance.provider = { type: 'kimi', tui: {} }
    instance.settings = { meshNodeFor: 'mesh-abc', meshActiveTaskId: 'task-1' }
    instance.generatingStartedAt = 0
    instance.generatingDebouncePending = null
    instance.fastCollapseSynthesizedTaskId = null
    instance.meshTaskInjectedAt = 2_000
    instance.adapter = {
      currentTurnTaskId: 'task-1',
      currentTurnStartedAt: 3_000,
      isWaitingForResponse: false,
      getScriptParsedStatus() { return { messages: [] } },
      getPartialResponse() { return '' },
    }
    instance.completionFinalAssistantEvidence = () => ({ source: 'parsed', messages: [] })
    instance.completionTraceOn = () => false
    instance.isMeshWorkerSession = () => false
    instance.pushEvent = (e: any) => pushed.push(e)
    instance.emitGeneratingCompleted = (e: any) => emitted.push(e)
    if (opts.liveEvidence !== undefined) {
      instance.getLiveTurnPendingEvidence = () => opts.liveEvidence
    }
    return { instance, emitted, pushed }
  }

  it('control: with no live pending evidence the fast-collapse synth fires and marks the turn', () => {
    const { instance, emitted, pushed } = makeSynthInstance({ liveEvidence: { pending: false } })
    expect(instance.maybeSynthesizeStartupGraceCollapse('chat', 10_000, 'startup_grace_fast_collapse')).toBe(true)
    expect(pushed.some((e) => e.event === 'agent:generating_started')).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(instance.fastCollapseSynthesizedTaskId).toBe('task-1')
  })

  it('vetoes the synth while a modal is parked, leaving the turn UNMARKED for a later retry', () => {
    const { instance, emitted, pushed } = makeSynthInstance({ liveEvidence: { pending: true, kind: 'modal' } })
    expect(instance.maybeSynthesizeStartupGraceCollapse('chat', 10_000, 'startup_grace_fast_collapse')).toBe(false)
    expect(pushed).toHaveLength(0)
    expect(emitted).toHaveLength(0)
    // Unmarked ⇒ the steady idle re-poll retries once the modal clears.
    expect(instance.fastCollapseSynthesizedTaskId).toBe(null)
  })

  it('vetoes the synth on trailing transcript-tool activity', () => {
    const { instance, emitted } = makeSynthInstance({ liveEvidence: { pending: true, kind: 'transcript_tool' } })
    expect(instance.maybeSynthesizeStartupGraceCollapse('chat', 10_000, 'startup_grace_fast_collapse')).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})
