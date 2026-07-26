import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { TranscriptSignalSource } from '../../src/providers/transcript-signal-source.js'

// NATIVE-TRAILING-TOOL-GATE (rc.16 follow-up) — hasLiveTurnPendingEvidence().
//
// Verified live defect: Claude background shell tasks continued while interim narration
// emitted a native agent:generating_completed TWICE (final emitted once, 3 task_completed
// rows for one task). hasLiveTurnPendingEvidence() was false at the false fires because it
// only consulted hasAdapterPendingResponse()/isModalParked() — the adapter-state discriminators
// — while the independently-sampled native transcript (TranscriptSignalSource) demonstrably
// showed the turn still executing (trailing tool/terminal activity after the latest
// final-looking assistant bubble). claude-cli is a write-lag native-source class
// (noExternalTranscriptSource deliberately omitted, mission f2f6da1b owner decision) so the
// growth-hold/busy-lease protections in getCompletedFinalizationBlock never engage for it —
// this is an independent gap in the SEPARATE hasLiveTurnPendingEvidence() discriminator that
// mesh-event-forwarding's MID-TURN-LIVE-STATE-GATE (and isTransientToolConsent) rely on.
//
// Fix under test: hasLiveTurnPendingEvidence() additionally probes the native transcript
// (probeNativeTranscriptSignals — the SAME bounded, already-performed read other completion
// judgments use) and applies hasTrailingToolActivityAfterFinalAssistant — the SAME veto the
// transcript-synth causal admission choke point (evaluateTranscriptSynthAdmission) already
// uses. Structural/causal only: message ROLE/KIND classification (tool vs. assistant bubble),
// never message content/language. Fail-open: a non-native-source class, an unresolved
// transcript, or a probe error never fabricates pending evidence.

function makeInstance(opts: {
  adapterPending?: boolean
  modalParked?: boolean
  nativeSample: { msgCount: number; sourceMtimeMs: number } | null
  messages: unknown[] | null
}): any {
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.instanceId = 'sess-trailing-tool'

  instance.adapter = {
    isWaitingForResponse: opts.adapterPending === true,
    currentTurnScope: null,
    isProcessing: () => false,
    getPartialResponse: () => '',
  }
  instance.isModalParked = () => opts.modalParked === true

  const signalSource = new TranscriptSignalSource({
    label: 'claude-cli',
    profile: { class: 'native-source', timing: 'immediate', providerOwnsTranscript: true, emitsPtyTurnEvents: false },
    finalAssistantPresent: () => true,
    growthQuietMs: 60_000,
  })
  instance.probeNativeTranscriptSignals = () => {
    if (!opts.nativeSample) return null
    return {
      snapshot: signalSource.buildSnapshot({ messages: opts.messages ?? [], probe: opts.nativeSample }, Date.now()),
      messages: opts.messages,
    }
  }

  return instance
}

function callHasLiveTurnPendingEvidence(instance: any): boolean {
  return (CliProviderInstance.prototype as any).hasLiveTurnPendingEvidence.call(instance)
}

// Message shapes: a tool bubble trailing a final-LOOKING assistant bubble (interim narration,
// turn still executing) vs. a genuinely finished turn (final assistant last, no trailing tool).
const NARRATION_THEN_TOOL_MESSAGES = [
  { role: 'user', content: 'do the multi-step background task', kind: 'standard' },
  { role: 'assistant', content: 'Let me kick off the background sleep and report back.', kind: 'standard' },
  { role: 'assistant', content: '', kind: 'tool' },
]

const GENUINE_FINAL_MESSAGES = [
  { role: 'user', content: 'do the multi-step background task', kind: 'standard' },
  { role: 'assistant', content: '', kind: 'tool' },
  { role: 'assistant', content: 'All steps finished; final report attached.', kind: 'standard' },
]

describe('CliProviderInstance.hasLiveTurnPendingEvidence — native trailing-tool-activity veto', () => {
  it('reports PENDING when the adapter itself is mid-response (unchanged prior behavior)', () => {
    const instance = makeInstance({ adapterPending: true, nativeSample: null, messages: null })
    expect(callHasLiveTurnPendingEvidence(instance)).toBe(true)
  })

  it('reports PENDING when modal-parked (unchanged prior behavior)', () => {
    const instance = makeInstance({ modalParked: true, nativeSample: null, messages: null })
    expect(callHasLiveTurnPendingEvidence(instance)).toBe(true)
  })

  it('NEW: reports PENDING when the adapter is idle-looking but the native transcript shows trailing tool activity after the final-looking bubble (background shell task still running)', () => {
    const instance = makeInstance({
      adapterPending: false,
      modalParked: false,
      nativeSample: { msgCount: NARRATION_THEN_TOOL_MESSAGES.length, sourceMtimeMs: Date.now() },
      messages: NARRATION_THEN_TOOL_MESSAGES,
    })
    expect(callHasLiveTurnPendingEvidence(instance)).toBe(true)
  })

  it('reports NOT PENDING for a genuinely finished turn (final assistant last, no trailing tool activity)', () => {
    const instance = makeInstance({
      adapterPending: false,
      modalParked: false,
      nativeSample: { msgCount: GENUINE_FINAL_MESSAGES.length, sourceMtimeMs: Date.now() },
      messages: GENUINE_FINAL_MESSAGES,
    })
    expect(callHasLiveTurnPendingEvidence(instance)).toBe(false)
  })

  it('fails OPEN for a non-native-source class (probe returns null) — never fabricates pending evidence', () => {
    const instance = makeInstance({ adapterPending: false, modalParked: false, nativeSample: null, messages: null })
    expect(callHasLiveTurnPendingEvidence(instance)).toBe(false)
  })

  it('fails OPEN when the probe throws — a diagnostic error must never fabricate pending evidence', () => {
    const instance = makeInstance({ adapterPending: false, modalParked: false, nativeSample: null, messages: null })
    instance.probeNativeTranscriptSignals = () => { throw new Error('probe boom') }
    expect(callHasLiveTurnPendingEvidence(instance)).toBe(false)
  })

  it('fails OPEN when the snapshot is unavailable (unresolved transcript)', () => {
    const instance = makeInstance({ adapterPending: false, modalParked: false, nativeSample: null, messages: NARRATION_THEN_TOOL_MESSAGES })
    // Simulate an unresolved snapshot alongside present messages (defensive shape).
    instance.probeNativeTranscriptSignals = () => ({ snapshot: { available: false }, messages: NARRATION_THEN_TOOL_MESSAGES })
    expect(callHasLiveTurnPendingEvidence(instance)).toBe(false)
  })
})
