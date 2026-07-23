import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS } from '../../src/providers/cli-provider-instance-types.js'

// FIX 2 (primary) — CANON-C early-emit min-elapsed floor.
//
// The CANON-C transcript-evidence gate (allowTimeout missing_final_assistant blocks) emits its
// decoupled-immediate completion at ANY waitedMs. For a native-source provider whose transcript
// write merely trails the idle transition, that would be tolerable — but a block only REACHES the
// finalization gate here when the transcript probe found NO in-turn assistant reply (a landed
// assistant write returns null earlier for a clean emit). So every missing_final_assistant block
// that gets this far has genuinely no answer yet — for codex-cli / kimi that is routinely a
// mid-tool-call quiet valley (the turn is still running, `Working (` momentarily off-screen), and
// an immediate emit at the ~13s first-poll waitedMs stamps a weak evidenceLevel=insufficient
// completion while the worker is still generating (mission f2f6da1b, defect A). FIX: the codex/kimi
// external-native missing_final_assistant block now carries noExternalTranscriptSource and must
// observe the CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS floor — hold under it, emit once met.
// claude-cli's write-lag native-source block is deliberately UN-flagged (owner decision): its
// transcript merely trails a finished idle transition, so its decoupled-immediate emit is preserved.

const NOW = 1_000_000

type FlushOutcome = { emitted: boolean; heldReason: string | null; scheduledRetry: boolean }

function makeInstance(opts: { type: string; block: any; waitedMs: number }): { instance: any; outcome: FlushOutcome } {
  const outcome: FlushOutcome = { emitted: false, heldReason: null, scheduledRetry: false }
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = opts.type
  instance.instanceId = 'sess-floor'
  instance.busyEpoch = 0
  instance.generatingStartedAt = NOW - opts.waitedMs
  instance.lastApprovalEventFingerprint = ''
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }

  instance.adapter = {
    getStatus: () => ({ status: 'idle', lastOutputAt: NOW }),
    getScriptParsedStatus: () => ({ messages: [] }),
    getPartialResponse: () => '',
    isProcessing: () => false,
    isWaitingForResponse: false,
    currentTurnScope: null,
  }

  instance.completedDebouncePending = {
    firstObservedAt: NOW - opts.waitedMs,
    turnStartedAt: NOW - opts.waitedMs,
    busyEpochAtArm: 0,
    previousStatus: 'generating',
    chatTitle: '',
    duration: 1,
    timestamp: NOW,
    taskId: 'task-1',
    loggedBlockReason: undefined,
  }
  instance.completedDebounceTimer = null

  // Pin the block decision — the finalization-evidence machinery is exercised by its own tests.
  instance.getCompletedFinalizationBlock = () => opts.block
  instance.shouldAutoApprove = () => false
  instance.autoApproveBusy = false
  instance.shouldSuppressStaleParsedBusyStatus = () => false
  instance.antigravityHoldPtyStillActive = () => false

  instance.isMeshWorkerSession = () => false
  instance.completionTraceOn = () => false
  instance.recordCompletionGateTrace = () => {}
  instance.meshTraceCtx = () => ({})

  instance.scheduleCompletedDebounceFlush = () => { outcome.scheduledRetry = true }
  instance.emitGeneratingCompleted = () => { outcome.emitted = true }
  instance.buildCompletedFinalizationDiagnostic = () => ({})
  instance.completionFinalSummary = () => ''
  instance.cachedInTurnCompletionSummaryContent = () => ''

  const realNow = Date.now
  ;(instance as any).__restoreNow = () => { Date.now = realNow }
  Date.now = () => NOW

  const pending = instance.completedDebouncePending
  let heldReason: string | null = null
  Object.defineProperty(pending, 'loggedBlockReason', {
    get() { return heldReason },
    set(v) { heldReason = v; outcome.heldReason = v },
  })

  return { instance, outcome }
}

function runFlush(h: { instance: any; outcome: FlushOutcome }): FlushOutcome {
  try {
    ;(CliProviderInstance.prototype as any).flushCompletedDebounceIfFinalized.call(h.instance)
  } finally {
    h.instance.__restoreNow()
  }
  return h.outcome
}

// A codex-shaped no-external-transcript missing_final_assistant block (the RCA target).
const NO_TRANSCRIPT_BLOCK = {
  reason: 'missing_final_assistant',
  terminal: true,
  allowTimeout: true,
  noExternalTranscriptSource: true,
}
// A legacy native-source block WITHOUT the floor flag. After the f2f6da1b fix, no live block
// omits noExternalTranscriptSource once it reaches the finalization gate (both the codex/kimi
// external-native path and the PTY-parsed path stamp it), so this shape only exercises the
// still-immediate CANON-C emit for the theoretical un-flagged block.
const NATIVE_SOURCE_BLOCK = {
  reason: 'missing_final_assistant',
  terminal: true,
  allowTimeout: true,
}

describe('CliProviderInstance — CANON-C min-elapsed floor', () => {
  it('(b, floor NOT met) holds a no-transcript missing_final_assistant emit under the floor', () => {
    const h = makeInstance({
      type: 'codex-cli',
      block: NO_TRANSCRIPT_BLOCK,
      waitedMs: CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS - 5_000, // ~13s-style early poll
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(false)
    expect(out.scheduledRetry).toBe(true)
    expect(out.heldReason).toBe('canon_c_min_elapsed_floor')
  })

  it('(b, floor met) emits the no-transcript missing_final_assistant completion at/after the floor', () => {
    const h = makeInstance({
      type: 'codex-cli',
      block: NO_TRANSCRIPT_BLOCK,
      waitedMs: CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS + 1_000,
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })

  it('does NOT floor a claude-cli write-lag native-source block — immediate CANON-C emit preserved', () => {
    // claude-cli's external-native missing_final_assistant block is deliberately UN-flagged
    // (owner decision, mission f2f6da1b): its transcript write merely trails the finished idle
    // transition, so the decoupled-immediate emit must still fire at a tiny waitedMs (upgraded by
    // the reconcile). Only codex/kimi's mid-tool-call block carries noExternalTranscriptSource.
    const h = makeInstance({
      type: 'claude-cli',
      block: NATIVE_SOURCE_BLOCK,
      waitedMs: 500, // well under the floor
    })
    const out = runFlush(h)
    expect(out.emitted).toBe(true)
    expect(out.scheduledRetry).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// f2f6da1b defect A regression: the external-native missing_final_assistant block that codex-cli
// / kimi produce (transcript probed, NO in-turn assistant reply) must now carry
// noExternalTranscriptSource so it is subject to the CANON-C min-elapsed floor — previously it was
// emitted at the first ~13s poll while the worker was still generating between tool calls.
// ---------------------------------------------------------------------------

const TURN_START = 1_700_000_000_000

function codexExternalNativeInstance(opts: { probeLastRole: string; probeContentLen: number; type?: string; requiresFinalAssistantBeforeIdle?: boolean }): any {
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = opts.type ?? 'codex-cli'
  instance.instanceId = 'sess-codex-en'
  instance.workingDir = '/repo/worktree'
  instance.generatingStartedAt = TURN_START
  instance.busyEpoch = 3
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  // Mesh worker context so allowMissingAssistantTimeout is live (allowTimeout set on the block).
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
  // SPEC-DRIVEN FLOOR: the floor decision reads the provider manifest's
  // requiresFinalAssistantBeforeIdle flag (NOT a hardcoded provider name). codex-cli / kimi /
  // cursor-cli / opencode declare it (=true → floored); claude-cli leaves it undeclared
  // (write-lag native source → immediate emit). Default the fixture to a codex-shaped spec that
  // declares the flag so it reflects the real manifest.
  instance.provider = { name: 'Codex', settings: {}, nativeHistory: {}, requiresFinalAssistantBeforeIdle: opts.requiresFinalAssistantBeforeIdle ?? true }
  instance.providerSessionId = 'codex-conv-1'
  instance.startedAt = 0
  instance.meshTaskInjectedAt = 0
  instance.shouldAutoApprove = () => false
  instance.completionTraceOn = () => false
  instance.isMeshWorkerSession = () => true

  // SpecCliAdapter always owns messages externally; the transcript read yields the external-native
  // source. The probe tail is a non-assistant bubble → present=false, source='external-native'.
  instance.adapter = {
    chatMessagesOwnedExternally: true,
    currentTurnStartedAt: TURN_START,
    currentTurnScope: null,
    isWaitingForResponse: false,
    isProcessing: () => false,
    getPartialResponse: () => '',
    getStatus: () => ({ status: 'idle', lastOutputAt: TURN_START + 4_900 }),
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
    getScreenText: () => '',
  }
  instance.readExternalCompletionMessages = () => [
    { role: 'user', content: 'the investigation task', timestamp: TURN_START + 100 },
  ]
  instance.lastVisibleAssistantSummary = () => ''
  instance.lastExternalCompletionProbe = {
    readAt: Date.now(),
    msgCount: 1,
    lastRole: opts.probeLastRole,
    lastKind: null,
    contentLen: opts.probeContentLen,
    sourcePath: null,
    sourceMtimeMs: null,
    mtimeAgeMs: null,
  }
  instance.injectedTaskHasStartedGenerating = () => true
  return instance
}

describe('CANON-C floor — codex/kimi external-native missing_final_assistant carries the floor flag', () => {
  it('stamps noExternalTranscriptSource on the external-native missing_final_assistant block (mid-tool-call quiet)', () => {
    const instance = codexExternalNativeInstance({ probeLastRole: 'user', probeContentLen: 0 })
    const pending = {
      chatTitle: 'worktree',
      duration: 5,
      timestamp: TURN_START + 5_000,
      firstObservedAt: TURN_START + 5_000,
      previousStatus: 'generating',
      turnStartedAt: TURN_START,
      busyEpochAtArm: 3,
      lastOutputAtArm: TURN_START + 4_900,
    }
    const block = (CliProviderInstance.prototype as any).getCompletedFinalizationBlock.call(
      instance,
      'idle',
      pending,
    )
    expect(block).not.toBeNull()
    expect(block.reason).toBe('missing_final_assistant')
    expect(block.allowTimeout).toBe(true)
    // The RCA fix: this block must now be subject to the min-elapsed floor.
    expect(block.noExternalTranscriptSource).toBe(true)
  })

  // SPEC-DRIVEN FLOOR partition (name-driven → manifest-driven). The floor decision at the
  // external-native missing_final_assistant block now reads the provider's
  // requiresFinalAssistantBeforeIdle manifest flag instead of `this.type === 'claude-cli'`.
  // The two sides of the partition:
  //   • DECLARED (=true): codex-cli / kimi / cursor-cli / opencode → "idle without a final
  //     assistant is not a genuine turn-end" → floored (noExternalTranscriptSource).
  //   • UNDECLARED: claude-cli → its idle is authoritative, transcript merely trails (write-lag
  //     native source) → immediate CANON-C emit, NOT floored.
  function blockFor(opts: { type: string; requiresFinalAssistantBeforeIdle?: boolean }) {
    const instance = codexExternalNativeInstance({
      probeLastRole: 'user',
      probeContentLen: 0,
      type: opts.type,
      requiresFinalAssistantBeforeIdle: opts.requiresFinalAssistantBeforeIdle,
    })
    const pending = {
      chatTitle: 'worktree',
      duration: 5,
      timestamp: TURN_START + 5_000,
      firstObservedAt: TURN_START + 5_000,
      previousStatus: 'generating',
      turnStartedAt: TURN_START,
      busyEpochAtArm: 3,
      lastOutputAtArm: TURN_START + 4_900,
    }
    return (CliProviderInstance.prototype as any).getCompletedFinalizationBlock.call(instance, 'idle', pending)
  }

  it('DECLARED requiresFinalAssistantBeforeIdle (codex/kimi) → floored (noExternalTranscriptSource)', () => {
    for (const type of ['codex-cli', 'kimi', 'cursor-cli', 'opencode']) {
      const block = blockFor({ type, requiresFinalAssistantBeforeIdle: true })
      expect(block?.reason, type).toBe('missing_final_assistant')
      expect(block?.noExternalTranscriptSource, type).toBe(true)
    }
  })

  it('UNDECLARED requiresFinalAssistantBeforeIdle (claude-cli write-lag native source) → NOT floored (immediate emit)', () => {
    // claude-cli does not declare the flag → its idle is authoritative → no floor. The block is
    // still terminal, but WITHOUT noExternalTranscriptSource so the CANON-C decoupled path emits
    // immediately (upgraded later by the reconcile once the trailing transcript write lands).
    const block = blockFor({ type: 'claude-cli', requiresFinalAssistantBeforeIdle: false })
    expect(block?.reason).toBe('missing_final_assistant')
    expect(block?.terminal).toBe(true)
    expect(block?.noExternalTranscriptSource).toBeUndefined()
  })

  it('a third-party provider that declares the flag is floored too (no hardcoded name gate)', () => {
    // The refactor removes the provider-name hardcode, so a NON-builtin provider that declares
    // requiresFinalAssistantBeforeIdle also gets the floor — the behaviour the name gate missed.
    const block = blockFor({ type: 'some-thirdparty-cli', requiresFinalAssistantBeforeIdle: true })
    expect(block?.noExternalTranscriptSource).toBe(true)
  })
})
