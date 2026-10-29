/**
 * Item 4 (cursor-cli live defect): when neither the PTY parse nor the native
 * transcript yields a final assistant, a settled-idle screen's answer block
 * finalizes the turn instead of forcing `missing_final_assistant`.
 */
import { describe, expect, it } from 'vitest'
import { completionFinalAssistantEvidence, type EvidenceHost } from '../../src/providers/completion/evidence.js'

const TURN = 1_700_000_000_000
const ANSWER = [{ role: 'assistant', kind: 'standard', content: 'Created hello.txt and verified it contains hi.' }]

function host(screenFinal?: () => unknown[]): EvidenceHost {
  return {
    type: 'cursor-cli', instanceId: 's1', workingDir: '/tmp/wd', startedAt: TURN - 10_000,
    provider: {} as any,
    adapter: {
      chatMessagesOwnedExternally: true,
      getStatus: () => ({}),
      getScriptParsedStatus: () => ({ messages: [] }),
      ...(screenFinal ? { readSettledScreenFinalAssistant: screenFinal } : {}),
    } as any,
    lastExternalCompletionProbe: null, lastCompletionSummary: null, lastFinalSummaryProvenance: null,
    hasAdapterPendingResponse: () => false, isModalParked: () => false,
    probeNativeTranscriptSignals: () => null, busyLeaseGateEnabled: () => false,
    publishTranscriptSignalObservation: () => {}, spawnedEnvOverrides: () => undefined,
    lastVisibleAssistantSummaryDetail: () => ({ content: '' }),
    completionHasFinalAssistantMessage: (m: unknown) => {
      const last = (Array.isArray(m) ? m : []).slice(-1)[0] as any
      return last?.role === 'assistant' && !!last?.content
    },
    // native binding lost: history empty -> not provider-native
    readExternalCompletionMessages: () => null,
    completionFinalSummary: () => undefined,
  } as unknown as EvidenceHost
}

describe('completion evidence — settled-screen final assistant fallback', () => {
  it('native unresolved + parsed empty + settled screen answer → present (parsed), not unavailable', () => {
    const ev = completionFinalAssistantEvidence(host(() => ANSWER), [], TURN)
    expect(ev.present).toBe(true)
    expect(ev.source).toBe('parsed')
    expect(ev.messages).toEqual(ANSWER)
  })

  it('no settled answer on screen (busy / no footer) → still unavailable (weak path unchanged)', () => {
    const ev = completionFinalAssistantEvidence(host(() => []), [], TURN)
    expect(ev.present).toBe(false)
    expect(ev.source).toBe('unavailable')
    expect(completionFinalAssistantEvidence(host(), [], TURN).source).toBe('unavailable')
  })

  it('a turn the adapter still reports pending is never finalized from the screen', () => {
    const h = host(() => ANSWER)
    ;(h as any).hasAdapterPendingResponse = () => true
    expect(completionFinalAssistantEvidence(h, [], TURN).present).toBe(false)
  })
})
