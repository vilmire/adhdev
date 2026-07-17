import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// NOTIF Defect-B: the completion evidence probe (completionFinalAssistantEvidence)
// is a POINT-SAMPLE. On a native-source provider (antigravity) the parsed screen and
// the native transcript can BOTH momentarily yield no in-turn final assistant at the
// exact instant the finalization gate fires — source='unavailable',
// finalAssistantPresent=false — even though a PRIOR poll already read the real answer
// off native-history and cached it in lastCompletionSummary (the same value
// mesh_read_chat.summary shows). buildCompletedFinalizationDiagnostic must credit that
// cache as evidence: flip finalAssistantPresent to true, drop the
// blockReason='missing_final_assistant' (so the coordinator log reads
// completion_diagnostic=present and isWeakCompletionEvidence no longer flags it), and
// preserve the original reason under originalBlockReason.
describe('buildCompletedFinalizationDiagnostic — cached-summary evidence (Defect-B)', () => {
  function makeInstance(opts: {
    parsedMessages: unknown[]
    externalMessages: unknown[] | null
    cachedSummary: string | null
  }) {
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.type = 'antigravity-cli'
    instance.instanceId = 'sess-1'
    instance.providerSessionId = 'prov-1'
    instance.workingDir = '/work/repo'
    instance.generatingStartedAt = 0
    instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
    instance.lastCompletionSummary = opts.cachedSummary
      ? { content: opts.cachedSummary, receivedAt: 1_000 }
      : null
    // Native-source adapter: assistant answer lives in native-history, not the PTY parse.
    instance.adapter = {
      chatMessagesOwnedExternally: true,
      getScriptParsedStatus: () => ({ status: 'idle', messages: opts.parsedMessages }),
      // No pending response — turn is closed (hasAdapterPendingResponse() false).
      isWaitingForResponse: false,
      currentTurnScope: null,
      isProcessing: () => false,
      getPartialResponse: () => '',
    }
    // The external-native transcript at THIS instant has no in-turn final assistant.
    instance.readExternalCompletionMessages = () => opts.externalMessages
    // recordPendingTranscriptProbe is called for external-native; stub it.
    instance.recordPendingTranscriptProbe = () => null
    return instance
  }

  const pending = {
    chatTitle: 'antigravity · repo',
    duration: 19,
    timestamp: 2_000,
    firstObservedAt: 1_500,
    previousStatus: 'generating',
    transcriptProbeHistory: [],
  }

  function buildDiag(instance: any) {
    return instance.buildCompletedFinalizationDiagnostic({
      blockReason: 'missing_final_assistant',
      latestStatus: { status: 'idle' },
      latestVisibleStatus: 'idle',
      waitedMs: 19_000,
      pending,
      emittedAfterFinalizationTimeout: false,
    }) as Record<string, unknown>
  }

  it('credits lastCompletionSummary as evidence when the live probe is unavailable', () => {
    // Live probe: parsed empty AND external transcript empty → source='unavailable',
    // present=false. But the answer was cached on a prior poll.
    const instance = makeInstance({
      parsedMessages: [],
      externalMessages: [],
      cachedSummary: 'The task is done. nextAction: none.',
    })
    const diag = buildDiag(instance)
    expect(diag.finalAssistantPresent).toBe(true)
    expect(diag.finalAssistantFromCachedSummary).toBe(true)
    expect(diag.finalAssistantEvidenceSource).toBe('cached-summary')
    // blockReason cleared so completion_diagnostic reads present (not missing_final_assistant).
    expect(diag.blockReason).toBeUndefined()
    expect(diag.originalBlockReason).toBe('missing_final_assistant')
  })

  it('leaves the missing-evidence diagnostic unchanged when there is no cached summary', () => {
    const instance = makeInstance({
      parsedMessages: [],
      externalMessages: [],
      cachedSummary: null,
    })
    const diag = buildDiag(instance)
    expect(diag.finalAssistantPresent).toBe(false)
    expect(diag.finalAssistantFromCachedSummary).toBe(false)
    expect(diag.blockReason).toBe('missing_final_assistant')
    expect(diag.originalBlockReason).toBeUndefined()
  })

  it('does not touch the cache path when the live evidence is genuinely present', () => {
    // Parsed screen already carries the confirmed final assistant for the turn.
    const instance = makeInstance({
      parsedMessages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: 'Live confirmed reply.' },
      ],
      externalMessages: null,
      cachedSummary: 'a stale cache value that must NOT be used',
    })
    const diag = buildDiag(instance)
    expect(diag.finalAssistantPresent).toBe(true)
    expect(diag.finalAssistantFromCachedSummary).toBe(false)
    expect(diag.finalAssistantEvidenceSource).toBe('parsed')
    // A genuine present keeps the caller's original blockReason untouched.
    expect(diag.blockReason).toBe('missing_final_assistant')
    expect(diag.originalBlockReason).toBeUndefined()
  })
})
