import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import {
  cleanCompletionFinalSummary,
  completionFinalSummary,
  NATIVE_SUMMARY_WRITE_WAIT_MAX_MS,
  type EvidenceHost,
} from '../../src/providers/completion/evidence.js'
import { evaluateFinalizationBlock, type CompletionSignalReader } from '../../src/providers/completion/completion-engine.js'
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js'

const TEST_TIMESTAMP = 1_700_000_000_000

// (SUMMARY-SCRAPE-FALLBACK) The completion summary of a native-source provider (claude-cli:
// chatMessagesOwnedExternally) is resolved from the provider's append-only on-disk transcript.
// When the completion flushes BEFORE that transcript has been written, the resolution falls
// back to the PTY viewport scrape — and the terminal wraps/scrolls/clips, so that scrape is an
// arbitrary partial prefix of the turn. Emitted as-is it reads like a finished sentence, and
// unlike the sibling turn-boundary race (which emits '' and is upgraded by mesh reconcile)
// nothing downstream ever repairs a prefix.
//
// Two entry points reach the scrape, and BOTH are covered here:
//   1. completionFinalSummary's own fallback branch (external read yields '' for the turn).
//   2. cleanCompletionFinalSummary's snapshot extraction — the dominant claude-cli path, where
//      completionFinalAssistantEvidence took its `parsed` short-circuit, the verdict came out
//      CLEAN, and the summary is extracted from that parsed snapshot without ever passing
//      through completionFinalSummary's fallback at all.
//
// Fix A (race reduction) is the bounded `native_summary_write_pending` hold in
// evaluateFinalizationBlock; fix B (defence) is completionDiagnostic.finalSummaryMayBeTruncated.
describe('completion finalSummary — PTY scrape fallback for a native-source provider', () => {
  const TURN_STARTED_AT = 1_700_000_000_000

  // The live shape: the terminal clipped the reply mid-sentence.
  const FULL_REPLY = 'Fixed the race by holding the completion until the transcript lands, and flagged the fallback so the coordinator can tell.'
  const CLIPPED_REPLY = 'Fixed the race by holding the completion until the transcript lands, and flagged the fallb'

  function makeHost(overrides: Partial<EvidenceHost> = {}): EvidenceHost {
    return {
      type: 'claude-cli',
      instanceId: 'sess_1',
      workingDir: '/tmp/wd',
      startedAt: TURN_STARTED_AT - 10_000,
      provider: {} as any,
      adapter: {
        // Native-source provider: its transcript, not the screen, is canonical history.
        chatMessagesOwnedExternally: true,
        getStatus: () => ({}),
        getScriptParsedStatus: () => ({ messages: [] }),
      } as any,
      lastExternalCompletionProbe: null,
      lastCompletionSummary: null,
      lastFinalSummaryProvenance: null,
      hasAdapterPendingResponse: () => false,
      isModalParked: () => false,
      probeNativeTranscriptSignals: () => null,
      busyLeaseGateEnabled: () => false,
      injectedTaskHasStartedGenerating: () => true,
      publishTranscriptSignalObservation: () => {},
      spawnedEnvOverrides: () => undefined,
      lastVisibleAssistantSummaryDetail: () => ({ content: '' }),
      completionHasFinalAssistantMessage: (messages: unknown) => {
        const list = Array.isArray(messages) ? messages : []
        const last = list[list.length - 1] as any
        return last?.role === 'assistant' && !!last?.content
      },
      // The transcript has NOT been written for this turn yet — the race.
      readExternalCompletionMessages: () => [],
      completionFinalSummary: (parsed: unknown, turnStartedAt?: number) =>
        completionFinalSummary(host, parsed, turnStartedAt),
      ...overrides,
    } as unknown as EvidenceHost
  }
  let host: EvidenceHost

  it('flags the summary as possibly-truncated when it falls back to the screen scrape', () => {
    host = makeHost()
    const summary = completionFinalSummary(
      host,
      [{ role: 'assistant', content: CLIPPED_REPLY, timestamp: TURN_STARTED_AT + 500 }],
      TURN_STARTED_AT,
    )
    // The value is still returned — withholding it would be worse than flagging it.
    expect(summary).toBe(CLIPPED_REPLY)
    // ...but it is now marked, which is what stops the coordinator trusting a half sentence.
    expect(host.lastFinalSummaryProvenance).toEqual({
      source: 'parsed_screen_fallback',
      mayBeTruncated: true,
      contentLength: CLIPPED_REPLY.length,
    })
  })

  it('does NOT flag the summary when the native transcript supplied it', () => {
    host = makeHost({
      readExternalCompletionMessages: () => [
        { role: 'assistant', content: FULL_REPLY, timestamp: TURN_STARTED_AT + 500 },
      ],
    })
    const summary = completionFinalSummary(host, [], TURN_STARTED_AT)
    expect(summary).toBe(FULL_REPLY)
    expect(host.lastFinalSummaryProvenance).toMatchObject({
      source: 'native_transcript',
      mayBeTruncated: false,
    })
  })

  it('does NOT flag a screen-only provider — its screen IS the canonical history', () => {
    host = makeHost({ adapter: { getStatus: () => ({}), getScriptParsedStatus: () => ({ messages: [] }) } as any })
    const summary = completionFinalSummary(
      host,
      [{ role: 'assistant', content: CLIPPED_REPLY, timestamp: TURN_STARTED_AT + 500 }],
      TURN_STARTED_AT,
    )
    expect(summary).toBe(CLIPPED_REPLY)
    expect(host.lastFinalSummaryProvenance).toMatchObject({
      source: 'parsed_screen',
      mayBeTruncated: false,
    })
  })

  // The dominant claude-cli path: the CLEAN verdict extracts the summary from the parsed
  // evidence snapshot, never touching completionFinalSummary's fallback branch. Before the fix
  // this returned the clipped text with no provenance recorded at all.
  it('flags a CLEAN-path summary extracted from a parsed evidence snapshot', () => {
    host = makeHost()
    const summary = cleanCompletionFinalSummary(host, {
      turnStartedAt: TURN_STARTED_AT,
      resolvedFinalMessages: [{ role: 'assistant', content: CLIPPED_REPLY, timestamp: TURN_STARTED_AT + 500 }],
      resolvedFinalEvidenceSource: 'parsed',
    } as any)
    expect(summary).toBe(CLIPPED_REPLY)
    expect(host.lastFinalSummaryProvenance).toMatchObject({
      source: 'parsed_screen_fallback',
      mayBeTruncated: true,
    })
  })

  it('does NOT flag a CLEAN-path summary whose snapshot came from the native transcript', () => {
    host = makeHost()
    const summary = cleanCompletionFinalSummary(host, {
      turnStartedAt: TURN_STARTED_AT,
      resolvedFinalMessages: [{ role: 'assistant', content: FULL_REPLY, timestamp: TURN_STARTED_AT + 500 }],
      resolvedFinalEvidenceSource: 'external-native',
    } as any)
    expect(summary).toBe(FULL_REPLY)
    expect(host.lastFinalSummaryProvenance).toMatchObject({
      source: 'native_transcript',
      mayBeTruncated: false,
    })
  })
})

// Fix A: the gate holds an otherwise-CLEAN verdict briefly so the ordinary flush retry can pick
// up the complete transcript text instead of settling for the scrape.
describe('evaluateFinalizationBlock — bounded native-summary write hold', () => {
  const NOW = 1_700_000_000_000

  const POLICY = {
    finalizationRetryMs: 1_000,
    finalizationMaxWaitMs: 30_000,
    backgroundTaskHoldMaxMs: 300_000,
    canonCMinElapsedFloorMs: 20_000,
    transcriptGrowthQuietMs: 60_000,
    holdClassHardCapMs: 300_000,
    ptyParsedFinalAssistantQuietDwellMs: 1_200,
    terminalBlockHardCapMs: 600_000,
    nativeSummaryWriteWaitMaxMs: NATIVE_SUMMARY_WRITE_WAIT_MAX_MS,
  }

  function makeReader(overrides: Partial<CompletionSignalReader> = {}): CompletionSignalReader {
    return {
      now: () => NOW,
      visibleStatus: () => 'idle',
      busyEpoch: () => 1,
      lastOutputAt: () => undefined,
      adapterWaitingForResponse: () => false,
      adapterTurnScopeActive: () => false,
      adapterAnyPending: () => false,
      partialResponsePending: () => false,
      parsedStatus: () => ({ ok: true, status: 'idle', modalActive: false, messages: [] }),
      staleParsedBusySuppressed: () => false,
      backgroundTask: () => ({ active: false }),
      // The turn is provably over, but only the SCREEN proves it (the `parsed` short-circuit).
      finalAssistantEvidence: () => ({ present: true, source: 'parsed', messages: [] }),
      externalNativeTailProbe: () => null,
      transcriptGrowth: () => null,
      busyLeaseGateEnabled: () => false,
      busyLease: () => null,
      transcriptAgeMs: () => undefined,
      inApprovalResumeGrace: () => false,
      hasApprovalResolutionEvidence: () => true,
      screenTailShowsApprovalPrompt: () => false,
      holdClassPtyStillActive: () => false,
      // Native-source provider.
      ownsExternalHistory: () => true,
      authorityTiming: () => 'immediate',
      allowMissingAssistantTimeout: () => true,
      // The complete turn text is NOT on disk yet.
      nativeSummaryOnDisk: () => false,
      ...overrides,
    } as CompletionSignalReader
  }

  it('holds non-terminally while the transcript write is still pending, inside the bound', () => {
    const { block } = evaluateFinalizationBlock(
      { firstObservedAt: NOW - 500, previousStatus: 'generating' },
      makeReader(),
      POLICY,
    )
    expect(block).toMatchObject({ reason: 'native_summary_write_pending', terminal: false })
  })

  // The hold must not be marked holdForTranscript: that flag lets a HOLD-class provider
  // (antigravity) extend a hold past the 30s cap toward the 300s hard cap while its PTY is
  // active. This hold's whole safety argument is its own small bound; inheriting that one would
  // let a 2.5s summary wait stretch into minutes.
  it('does not carry holdForTranscript, so it can never inherit the hold-class hard cap', () => {
    const { block } = evaluateFinalizationBlock(
      { firstObservedAt: NOW - 500, previousStatus: 'generating' },
      makeReader({ authorityTiming: () => 'hold', holdClassPtyStillActive: () => true }),
      POLICY,
    )
    expect(block).toMatchObject({ reason: 'native_summary_write_pending', terminal: false })
    expect((block as Record<string, unknown>).holdForTranscript).toBeUndefined()
  })

  it('releases (clean) once the bound lapses, so the completion is never withheld', () => {
    const { block } = evaluateFinalizationBlock(
      { firstObservedAt: NOW - (NATIVE_SUMMARY_WRITE_WAIT_MAX_MS + 1), previousStatus: 'generating' },
      makeReader(),
      POLICY,
    )
    expect(block).toBeNull()
  })

  it('does not hold once the transcript holds this turn (the wait is satisfied)', () => {
    const { block } = evaluateFinalizationBlock(
      { firstObservedAt: NOW - 500, previousStatus: 'generating' },
      makeReader({ nativeSummaryOnDisk: () => true }),
      POLICY,
    )
    expect(block).toBeNull()
  })

  it('does not hold for a screen-only provider — it has no transcript to wait for', () => {
    const { block } = evaluateFinalizationBlock(
      { firstObservedAt: NOW - 500, previousStatus: 'generating' },
      makeReader({ ownsExternalHistory: () => false, nativeSummaryOnDisk: () => undefined }),
      POLICY,
    )
    expect(block).toBeNull()
  })

  // The distinction that keeps the established signal-absence fail-open intact
  // (cli-provider-kimi-parsed-race case 4): a transcript that is NOT RESOLVABLE — no session
  // pinned, file never written, typed fail-closed attribution — is not a transcript that is
  // about to land. Waiting for it would turn "unresolved native + parsed answer must EMIT"
  // into a hold. The instance-side signal reports undefined for that case, never false; only a
  // readable transcript with no in-turn bubble yet is the write-lag race.
  it('does not hold when the transcript is unresolvable rather than merely unwritten', () => {
    const { block } = evaluateFinalizationBlock(
      { firstObservedAt: NOW - 500, previousStatus: 'generating' },
      makeReader({ nativeSummaryOnDisk: () => undefined }),
      POLICY,
    )
    expect(block).toBeNull()
  })

  // Fail-closed: a reader that predates the signal (every existing test double, and any
  // caller that never implements it) must behave exactly as before the fix.
  it('does not hold when the signal cannot tell', () => {
    const { block } = evaluateFinalizationBlock(
      { firstObservedAt: NOW - 500, previousStatus: 'generating' },
      makeReader({ nativeSummaryOnDisk: undefined }),
      POLICY,
    )
    expect(block).toBeNull()
  })
})

// Part B's last mile on the emit side: the diagnostic field only rides an event whose
// provenance actually matches the summary being emitted.
describe('finalSummaryProvenanceDiagnostic', () => {
  function makeInstance() {
    return Object.create(CliProviderInstance.prototype) as CliProviderInstance & {
      lastFinalSummaryProvenance: unknown
      finalSummaryProvenanceDiagnostic(summary: string | undefined): Record<string, unknown>
    }
  }

  it('stamps the truncation flag for a scrape-fallback summary', () => {
    const instance = makeInstance()
    instance.lastFinalSummaryProvenance = {
      source: 'parsed_screen_fallback',
      mayBeTruncated: true,
      contentLength: 5,
    }
    expect(instance.finalSummaryProvenanceDiagnostic('hello')).toEqual({
      finalSummarySource: 'parsed_screen_fallback',
      finalSummaryMayBeTruncated: true,
    })
  })

  it('omits the flag for a native-transcript summary', () => {
    const instance = makeInstance()
    instance.lastFinalSummaryProvenance = {
      source: 'native_transcript',
      mayBeTruncated: false,
      contentLength: 5,
    }
    expect(instance.finalSummaryProvenanceDiagnostic('hello')).toEqual({
      finalSummarySource: 'native_transcript',
    })
  })

  // The weak path's chain can be won by an earlier source that short-circuits before
  // completionFinalSummary runs, leaving a PREVIOUS turn's provenance behind. Stamping it would
  // mislabel a good native summary as a possibly-truncated scrape.
  it('stamps nothing when the recorded provenance does not describe the emitted summary', () => {
    const instance = makeInstance()
    instance.lastFinalSummaryProvenance = {
      source: 'parsed_screen_fallback',
      mayBeTruncated: true,
      contentLength: 5,
    }
    expect(instance.finalSummaryProvenanceDiagnostic('a different, longer summary')).toEqual({})
  })

  it('stamps nothing when no provenance was ever recorded', () => {
    const instance = makeInstance()
    instance.lastFinalSummaryProvenance = null
    expect(instance.finalSummaryProvenanceDiagnostic('hello')).toEqual({})
  })
})

// Part B, last mile: the flag has to be VISIBLE to the coordinator, not merely present on the
// event. Without this the diagnostic would ride the wire and never be read by anyone.
describe('buildMeshSystemMessage — surfaces the truncation flag', () => {
  const CLIPPED = 'Fixed the race by holding the completion until the transcript lands, and flagged the fallb'

  it('tells the coordinator the surfaced summary may be truncated', () => {
    const msg = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_child_1'",
      metadataEvent: {
        sessionId: 'sess-1',
        timestamp: TEST_TIMESTAMP,
        finalSummary: CLIPPED,
        completionDiagnostic: {
          source: 'clean_final_assistant',
          finalSummarySource: 'parsed_screen_fallback',
          finalSummaryMayBeTruncated: true,
        },
      },
    })
    expect(msg).toContain(CLIPPED)
    expect(msg).toContain('final_summary=may_be_truncated')
  })

  it('says nothing about truncation for a native-transcript summary', () => {
    const msg = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_child_1'",
      metadataEvent: {
        sessionId: 'sess-1',
        timestamp: TEST_TIMESTAMP,
        finalSummary: 'All done.',
        completionDiagnostic: {
          source: 'clean_final_assistant',
          finalSummarySource: 'native_transcript',
        },
      },
    })
    expect(msg).not.toContain('may_be_truncated')
  })
})
