import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// KIMI-EMPTY-FINAL-CONTENT (rc.23 live repro): a kimi coverage task emitted
// agent:generating_completed via the CLEAN finalization path (getCompletedFinalizationBlock
// returned null — completionFinalAssistantEvidence already proved a genuine in-turn final
// assistant bubble present) after ~335s, but the emitted finalSummary was empty. A
// continuation completed again ~16s later with another empty bubble.
//
// Root cause: the clean-path emit re-derived finalSummary via a SECOND, independent read
// (this.completionFinalSummary(adapter.getScriptParsedStatus().messages, ...), which for a
// native-source (kimi: chatMessagesOwnedExternally) provider internally calls
// readExternalCompletionMessages() AGAIN) taken moments after the read that
// completionFinalAssistantEvidence used to prove present:true. kimi's on-disk wire.jsonl
// transcript (or the PTY transcriptPty buffer scrape it falls back to) can legitimately
// differ between the two reads — a rewrite, a truncated line mid-flush, or a terminal
// repaint scrolling the matched bubble out — so a turn PROVEN done could still emit with an
// EMPTY assistant bubble, because the content was extracted from a DIFFERENT snapshot than
// the one that justified the completion.
//
// Fix: getCompletedFinalizationBlock now caches the exact message array that proved
// `present:true` on `pending.resolvedFinalMessages`. The clean-path emit
// (cleanCompletionFinalSummary) extracts finalSummary from that cached snapshot first,
// falling back to a fresh read only when no snapshot was cached — never a genuinely
// nonempty-then-empty regression for any other provider class.
describe('CliProviderInstance — kimi native-source empty-final-content (clean completion path)', () => {
  function makeInstance() {
    return Object.create(CliProviderInstance.prototype) as CliProviderInstance & {
      adapter: any
      readExternalCompletionMessages(): unknown[] | null
      cleanCompletionFinalSummary(pending: any): string | undefined
      completionFinalSummary(messages: unknown, turnStartedAt?: number): string | undefined
    }
  }

  const TURN_STARTED_AT = 1_700_000_000_000
  const FINAL_ANSWER = 'Coverage inventory complete: 42 files, 3 gaps found (see matrix above).'

  it('REGRESSION (fails pre-fix): a clean completion with a cached proving snapshot must never emit empty content even when a LATER independent re-read of the transcript would yield nothing', () => {
    const instance = makeInstance()
    instance.adapter = { chatMessagesOwnedExternally: true }
    // The SECOND, independent read (what the OLD code path used) races the proving read and
    // comes back with nothing in-turn yet — simulating a wire.jsonl rewrite/truncation or a
    // PTY buffer repaint landing between the two reads.
    ;(instance as any).readExternalCompletionMessages = () => ([])
    // Simulate the parsed (PTY) screen also showing nothing useful at the moment of the
    // second read (kimi's parsed scrape is a live convenience only; nativeHistory is
    // authoritative).
    instance.adapter.getScriptParsedStatus = () => ({ status: 'idle', messages: [] })

    const pending = {
      chatTitle: '',
      duration: 335,
      timestamp: Date.now(),
      firstObservedAt: Date.now() - 335_000,
      previousStatus: 'generating',
      turnStartedAt: TURN_STARTED_AT,
      // This is what getCompletedFinalizationBlock caches BEFORE falling through to the
      // clean (block===null) verdict: the exact messages that proved present:true.
      resolvedFinalMessages: [
        { role: 'user', content: 'run the CLI coverage inventory', timestamp: TURN_STARTED_AT - 500 },
        { role: 'assistant', content: 'Let me check the provider list.', kind: 'standard', timestamp: TURN_STARTED_AT + 1_000 },
        { role: 'assistant', content: 'Bash', kind: 'tool', timestamp: TURN_STARTED_AT + 2_000 },
        { role: 'assistant', content: 'tool.result', kind: 'tool', timestamp: TURN_STARTED_AT + 3_000 },
        { role: 'assistant', content: FINAL_ANSWER, timestamp: TURN_STARTED_AT + 335_000 },
      ],
    }

    const summary = instance.cleanCompletionFinalSummary(pending as any)
    expect(summary).toBe(FINAL_ANSWER)
  })

  it('an empty interim assistant bubble in the proving snapshot cannot terminalize the completion (walks back to the real final answer, never fabricates content)', () => {
    const instance = makeInstance()
    instance.adapter = { chatMessagesOwnedExternally: true }
    ;(instance as any).readExternalCompletionMessages = () => ([])
    instance.adapter.getScriptParsedStatus = () => ({ status: 'idle', messages: [] })

    const pending = {
      chatTitle: '',
      duration: 16,
      timestamp: Date.now(),
      firstObservedAt: Date.now() - 16_000,
      previousStatus: 'generating',
      turnStartedAt: TURN_STARTED_AT,
      resolvedFinalMessages: [
        { role: 'user', content: 'continue the inventory', timestamp: TURN_STARTED_AT - 500 },
        { role: 'assistant', content: FINAL_ANSWER, timestamp: TURN_STARTED_AT + 16_000 },
      ],
    }

    const summary = instance.cleanCompletionFinalSummary(pending as any)
    expect(summary).toBe(FINAL_ANSWER)
    expect(summary).not.toBe('')
  })

  it('delayed content that lands in the SAME turn (post-dating turnStartedAt) still attaches correctly via the cached snapshot', () => {
    const instance = makeInstance()
    instance.adapter = { chatMessagesOwnedExternally: true }
    ;(instance as any).readExternalCompletionMessages = () => ([])
    instance.adapter.getScriptParsedStatus = () => ({ status: 'idle', messages: [] })

    const pending = {
      chatTitle: '',
      duration: 559,
      timestamp: Date.now(),
      firstObservedAt: Date.now() - 559_000,
      previousStatus: 'generating',
      turnStartedAt: TURN_STARTED_AT,
      resolvedFinalMessages: [
        { role: 'user', content: 'do the multi-step task', timestamp: TURN_STARTED_AT - 100 },
        { role: 'assistant', content: 'Writing the deterministic regression tests now.', kind: 'standard', timestamp: TURN_STARTED_AT + 10_000 },
        { role: 'assistant', content: 'Bash', kind: 'tool', timestamp: TURN_STARTED_AT + 20_000 },
        { role: 'assistant', content: 'tool.result', kind: 'tool', timestamp: TURN_STARTED_AT + 21_000 },
        { role: 'assistant', content: 'All 32 scoped tests pass and typecheck is clean.', kind: 'standard', timestamp: TURN_STARTED_AT + 550_000 },
      ],
    }

    const summary = instance.cleanCompletionFinalSummary(pending as any)
    expect(summary).toBe('All 32 scoped tests pass and typecheck is clean.')
  })

  it('never regresses a non-native-source provider (no cached snapshot): falls back to the live read exactly as before', () => {
    const instance = makeInstance()
    // Non-native adapter: chatMessagesOwnedExternally is undefined -> screen-parsed path.
    instance.adapter = {}
    instance.adapter.getScriptParsedStatus = () => ({
      status: 'idle',
      messages: [
        { role: 'user', content: 'dispatched task' },
        { role: 'assistant', content: 'Done — the reply.' },
      ],
    })

    const pending = {
      chatTitle: '',
      duration: 5,
      timestamp: Date.now(),
      firstObservedAt: Date.now() - 5_000,
      previousStatus: 'generating',
      // No resolvedFinalMessages cached (e.g. legacy call path) -> must fall back.
    }

    const summary = instance.cleanCompletionFinalSummary(pending as any)
    expect(summary).toBe('Done — the reply.')
  })

  it('an empty cached snapshot summary (genuinely no assistant text) falls back to the live re-read instead of freezing empty', () => {
    const instance = makeInstance()
    instance.adapter = { chatMessagesOwnedExternally: true }
    // The cached snapshot has no in-turn assistant bubble at all (edge case: cached right
    // before the bubble landed). The live re-read is genuinely more current this time and
    // has the real answer — the fallback must still be reachable, not disabled outright.
    ;(instance as any).readExternalCompletionMessages = () => ([
      { role: 'user', content: 'task', timestamp: TURN_STARTED_AT - 100 },
      { role: 'assistant', content: FINAL_ANSWER, timestamp: TURN_STARTED_AT + 1_000 },
    ])
    instance.adapter.getScriptParsedStatus = () => ({ status: 'idle', messages: [] })

    const pending = {
      chatTitle: '',
      duration: 5,
      timestamp: Date.now(),
      firstObservedAt: Date.now() - 5_000,
      previousStatus: 'generating',
      turnStartedAt: TURN_STARTED_AT,
      resolvedFinalMessages: [
        { role: 'user', content: 'task', timestamp: TURN_STARTED_AT - 100 },
      ],
    }

    const summary = instance.cleanCompletionFinalSummary(pending as any)
    expect(summary).toBe(FINAL_ANSWER)
  })
})

// End-to-end coverage through the real gate (getCompletedFinalizationBlock ->
// flushCompletedDebounceIfFinalized), for kimi's actual transcript-authority class
// ('floor' timing, native-source, busy-lease canary) rather than mocking the private
// helpers in isolation. This is the path that emits agent:generating_completed in
// production, so it is what proves the fix closes the live rc.23 defect end-to-end.
describe('CliProviderInstance — kimi end-to-end clean completion (flushCompletedDebounceIfFinalized)', () => {
  const TURN_START = 1_700_000_000_000

  function makeKimiFlush(opts: {
    provingMessages: unknown[]
    // The SECOND, independent read a TOCTOU race could return differently. Defaults to
    // empty to model the live defect (wire.jsonl rewrite / truncated flush / PTY repaint
    // losing the bubble between the two reads).
    secondReadMessages?: unknown[]
  }): { instance: any; emitted: any[] } {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.type = 'kimi'
    instance.instanceId = 'sess-kimi'
    instance.workingDir = '/repo/worktree'
    instance.generatingStartedAt = TURN_START
    instance.busyEpoch = 1
    instance.lastApprovalEventFingerprint = ''
    instance.autoApproveBusy = false
    instance.completedDebounceTimer = null
    instance.settings = {
      meshNodeFor: 'mesh-1',
      meshActiveTaskId: 'task-1',
      meshActiveAttemptId: 'attempt-1',
      meshActiveDispatchNonce: 7,
    }
    instance.shouldAutoApprove = () => false
    instance.completionTraceOn = () => false
    instance.isMeshWorkerSession = () => true
    // kimi manifest: transcriptAuthority:'provider' + nativeHistory -> native-source,
    // requiresFinalAssistantBeforeIdle:true -> timing 'floor'.
    instance.provider = {
      name: 'Kimi Code',
      settings: {},
      nativeHistory: { mode: 'native-source' },
      requiresFinalAssistantBeforeIdle: true,
    }
    instance.providerSessionId = 'session-kimi-1'
    instance.startedAt = 0
    instance.meshTaskInjectedAt = TURN_START - 1_000 // injectedTaskHasStartedGenerating -> true

    instance.completedDebouncePending = {
      chatTitle: 'worktree',
      duration: 335,
      timestamp: TURN_START + 335_000,
      firstObservedAt: TURN_START,
      previousStatus: 'generating',
      taskId: 'task-1',
      turnStartedAt: TURN_START,
      busyEpochAtArm: 1,
      lastOutputAtArm: TURN_START + 334_900,
    }

    instance.adapter = {
      chatMessagesOwnedExternally: true,
      currentTurnStartedAt: TURN_START,
      currentTurnScope: null,
      isWaitingForResponse: false,
      isProcessing: () => false,
      getPartialResponse: () => '',
      getStatus: () => ({ status: 'idle', lastOutputAt: TURN_START + 334_900 }),
      getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
      getScreenText: () => '',
    }

    // Called first by completionFinalAssistantEvidence (proves present:true) inside
    // getCompletedFinalizationBlock, THEN a second time (pre-fix) by the clean-path
    // emit's independent completionFinalSummary call. Model the real TOCTOU race: the
    // first call sees the finished turn, later calls see something else (or nothing).
    let callCount = 0
    instance.readExternalCompletionMessages = () => {
      callCount += 1
      return callCount === 1 ? opts.provingMessages : (opts.secondReadMessages ?? [])
    }
    instance.lastExternalCompletionProbe = {
      readAt: Date.now(),
      msgCount: opts.provingMessages.length,
      lastRole: 'assistant',
      lastKind: null,
      contentLen: 50,
      sourcePath: null,
      sourceMtimeMs: null,
      mtimeAgeMs: null,
    }

    instance.pushEvent = (e: any) => { emitted.push(e) }
    instance.scheduleCompletedDebounceFlush = () => { /* no-op: test asserts the immediate outcome */ }
    return { instance, emitted }
  }

  const FINAL_ANSWER = 'Coverage inventory complete: 42 files, 3 gaps found (see matrix above).'

  const PROVING_MESSAGES = [
    { role: 'user', content: 'run the CLI coverage inventory', timestamp: TURN_START - 500 },
    { role: 'assistant', content: 'Let me check the provider list.', kind: 'standard', timestamp: TURN_START + 1_000 },
    { role: 'assistant', content: 'Bash', kind: 'tool', timestamp: TURN_START + 2_000 },
    { role: 'assistant', content: 'tool.result', kind: 'tool', timestamp: TURN_START + 3_000 },
    { role: 'assistant', content: FINAL_ANSWER, timestamp: TURN_START + 335_000 },
  ]

  it('REGRESSION (fails pre-fix): emits generating_completed with the REAL final content, not an empty bubble, even when the independent second read races empty', () => {
    const { instance, emitted } = makeKimiFlush({
      provingMessages: PROVING_MESSAGES,
      secondReadMessages: [], // the race: second read finds nothing in-turn yet
    })

    instance.flushCompletedDebounceIfFinalized()

    const completions = emitted.filter((e) => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    expect(completions[0].finalSummary).toBe(FINAL_ANSWER)
    expect(completions[0].finalSummary).not.toBe('')
    expect(completions[0].evidenceLevel).toBe('transcript')
    expect(completions[0].completionDiagnostic).toMatchObject({
      cleanPath: true,
      evidenceWeak: false,
      finalAssistantPresent: true,
      finalAssistantEvidenceSource: 'external-native',
      transcriptEvidence: {
        version: 1,
        kind: 'final_assistant',
        cleanPath: true,
        weak: false,
        authorityClass: 'native-source',
        timing: 'floor',
        finalContentLength: FINAL_ANSWER.length,
        taskId: 'task-1',
        attemptId: 'attempt-1',
        dispatchNonce: 7,
        sessionId: 'sess-kimi',
      },
    })
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('a duplicate flush call after the pending was cleared does not re-emit (exactly-once completion preserved)', () => {
    const { instance, emitted } = makeKimiFlush({
      provingMessages: PROVING_MESSAGES,
      secondReadMessages: [],
    })

    instance.flushCompletedDebounceIfFinalized()
    expect(emitted.filter((e) => e.event === 'agent:generating_completed')).toHaveLength(1)

    // pending is now null; a second flush call (e.g. a stray timer fire) must be a no-op.
    instance.flushCompletedDebounceIfFinalized()
    expect(emitted.filter((e) => e.event === 'agent:generating_completed')).toHaveLength(1)
  })

  it('when both reads agree (no race), content is emitted exactly as before — no behavior change on the happy path', () => {
    const { instance, emitted } = makeKimiFlush({
      provingMessages: PROVING_MESSAGES,
      secondReadMessages: PROVING_MESSAGES,
    })

    instance.flushCompletedDebounceIfFinalized()

    const completions = emitted.filter((e) => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    expect(completions[0].finalSummary).toBe(FINAL_ANSWER)
  })
})
