import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// KIMI-RC30-COMPLETION-SUMMARY-NATIVE-SNAPSHOT (rc.30 live defect, delegated task
// 6cd1e458-0f42-4a44-a7c3-2ec3c8a475fc / kimi session 5c4d6f0a-…):
// After the rc.28/29 background-hold fix passed, the worker's completion was held
// correctly (background_task_active 22:25:40Z, bg cell ran 22:25:23–22:26:08Z) and
// exactly one task_completed landed at 22:27:41.518Z — but its finalSummary carried
// the STALE PTY/Todo snapshot ("Verify rc.30 identity… ○ Launch one bg cell…")
// instead of the genuine native final assistant ("KIMI-RC30-BACKGROUND-HOLD-PASS"
// + JSON) that mesh_read_chat already returned from wire.jsonl (~22:27:40Z).
// completionDiagnostic: blockReason=parsed_final_assistant_quiet_dwell,
// emittedAfterFinalizationTimeout=true, waitedMs=123760, maxWaitMs=30000,
// finalAssistantEvidenceSource=parsed, finalAssistantFromCachedSummary=false.
//
// Root cause: production kimi routes through ProviderCliAdapter (provider dir ships
// provider.v1.json, no spec.json), which does NOT set chatMessagesOwnedExternally —
// only SpecCliAdapter does. So the forced finalization-timeout emit's summary
// selection (completionFinalSummary) gated its native-transcript read on that
// adapter flag, never consulted kimi's authoritative wire.jsonl, and shipped the
// PTY transcriptPty scrape (a live-status convenience that renders Todo/progress
// bullets as assistant text) as the completion's finalSummary. Timing was fixed;
// summary PROVENANCE was stale.
//
// Fix: for a provider whose manifest declares canonical native-source history
// (isNativeSourceCanonicalHistory — the same authority signal read_chat uses),
// the completion summary selection prefers the turn-scoped native transcript's
// fresh final assistant over the parsed PTY snapshot, reuses the
// pending.resolvedFinalMessages external-native snapshot when the gate already
// proved with it (no second live-read TOCTOU), and fails closed against
// pre-turn/stale native bubbles. The background-task hold, quiet-dwell gate and
// exactly-once semantics are unchanged; non-native providers skip the read
// entirely.

const TURN_START = 1_700_000_000_000
const STALE_TODO = 'Verify rc.30 identity... ○ Launch one bg cell... ○ Await terminal notification'
const NATIVE_FINAL = 'KIMI-RC30-BACKGROUND-HOLD-PASS {"held":true,"emits":1,"source":"native"}'

function makeProductionKimiFlush(opts: {
  parsedMessages: unknown[]
  nativeMessages: unknown[] | null
  backgroundTaskActive?: boolean
  waitedMs: number
}): { instance: any; emitted: any[]; setBackgroundTaskActive(v: boolean): void; nativeReadCount(): number } {
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
  // requiresFinalAssistantBeforeIdle:true -> timing 'floor'. nativeHistory survives
  // ProviderLoader resolve (rc.29) even though the adapter flag does not.
  instance.provider = {
    name: 'Kimi Code',
    settings: {},
    nativeHistory: { mode: 'native-source' },
    requiresFinalAssistantBeforeIdle: true,
  }
  instance.providerSessionId = 'session-kimi-1'
  instance.startedAt = 0
  instance.meshTaskInjectedAt = TURN_START - 1_000 // injectedTaskHasStartedGenerating -> true

  const outAt = Date.now() // recent PTY output -> parsed_final_assistant_quiet_dwell engages
  instance.completedDebouncePending = {
    chatTitle: 'worktree',
    duration: 124,
    timestamp: Date.now(),
    firstObservedAt: Date.now() - opts.waitedMs,
    previousStatus: 'generating',
    taskId: 'task-1',
    turnStartedAt: TURN_START,
    busyEpochAtArm: 1,
    lastOutputAtArm: outAt,
  }

  let backgroundTaskActive = opts.backgroundTaskActive === true
  instance.adapter = {
    // PRODUCTION SHAPE (ProviderCliAdapter): no chatMessagesOwnedExternally —
    // that flag exists only on SpecCliAdapter. Everything else is identical.
    currentTurnStartedAt: TURN_START,
    currentTurnScope: null,
    isWaitingForResponse: false,
    isProcessing: () => false,
    getPartialResponse: () => '',
    getStatus: () => ({ status: 'idle', lastOutputAt: outAt }),
    getScriptParsedStatus: () => ({
      status: 'idle',
      messages: opts.parsedMessages,
      ...(backgroundTaskActive
        ? { backgroundTaskActive: true, backgroundTaskCount: 1, backgroundTaskIds: ['bash-ykh2h2g6'] }
        : {}),
    }),
    getScreenText: () => '',
  }

  let readCount = 0
  instance.readExternalCompletionMessages = () => {
    readCount += 1
    return opts.nativeMessages
  }
  instance.lastExternalCompletionProbe = {
    readAt: Date.now(),
    msgCount: Array.isArray(opts.nativeMessages) ? opts.nativeMessages.length : 0,
    lastRole: 'assistant',
    lastKind: null,
    contentLen: NATIVE_FINAL.length,
    sourcePath: null,
    sourceMtimeMs: null,
    mtimeAgeMs: null,
  }

  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.scheduleCompletedDebounceFlush = () => { /* no-op: test asserts the immediate outcome */ }
  return {
    instance,
    emitted,
    setBackgroundTaskActive: (v: boolean) => { backgroundTaskActive = v },
    nativeReadCount: () => readCount,
  }
}

const PARSED_TODO_MESSAGES = [
  { role: 'user', content: 'verify rc.30 background-hold completion provenance', timestamp: TURN_START - 500 },
  { role: 'assistant', content: STALE_TODO, timestamp: TURN_START + 60_000 },
]

const NATIVE_MESSAGES_WITH_FINAL = [
  { role: 'user', content: 'verify rc.30 background-hold completion provenance', timestamp: TURN_START - 500 },
  { role: 'assistant', content: 'Launching one background cell now.', kind: 'standard', timestamp: TURN_START + 1_000 },
  { role: 'assistant', content: 'tool.call run_in_background bash-ykh2h2g6', kind: 'tool', timestamp: TURN_START + 2_000 },
  { role: 'assistant', content: 'task.completed bash-ykh2h2g6', kind: 'tool', timestamp: TURN_START + 120_000 },
  { role: 'assistant', content: NATIVE_FINAL, timestamp: TURN_START + 123_000 },
]

describe('CliProviderInstance — kimi rc.30 forced-timeout completion uses the native final, never the stale PTY/Todo snapshot', () => {
  it('REGRESSION (fails pre-fix): background hold -> quiet-dwell forced emit carries the native final assistant, exactly once', () => {
    const { instance, emitted, setBackgroundTaskActive } = makeProductionKimiFlush({
      parsedMessages: PARSED_TODO_MESSAGES,
      nativeMessages: NATIVE_MESSAGES_WITH_FINAL,
      backgroundTaskActive: true, // bg cell bash-ykh2h2g6 still running (22:25:40Z hold)
      waitedMs: 123_760,
    })

    // Flush 1: the unresolved background task HOLDS the completion (rc.28 fix preserved).
    instance.flushCompletedDebounceIfFinalized()
    expect(emitted.filter((e) => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(typeof instance.completedDebouncePending.backgroundTaskHoldSince).toBe('number')

    // The background cell finishes; the provider consumes the terminal notification
    // and writes the genuine final assistant to wire.jsonl. The PTY screen still
    // shows the stale Todo bullet. waitedMs (123760) is already past the 30s
    // finalization cap, so the quiet-dwell block force-emits.
    setBackgroundTaskActive(false)
    instance.flushCompletedDebounceIfFinalized()

    const completions = emitted.filter((e) => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    expect(completions[0].finalSummary).toBe(NATIVE_FINAL)
    expect(completions[0].finalSummary).not.toBe(STALE_TODO)
    expect(completions[0].completionDiagnostic).toMatchObject({
      blockReason: 'parsed_final_assistant_quiet_dwell',
      emittedAfterFinalizationTimeout: true,
      maxWaitMs: 30_000,
    })
    expect(instance.completedDebouncePending).toBeNull()

    // Exactly-once: a stray timer fire after the emit is a no-op (no duplicate/reorder).
    instance.flushCompletedDebounceIfFinalized()
    expect(emitted.filter((e) => e.event === 'agent:generating_completed')).toHaveLength(1)
  })

  it('fail closed against pre-turn/stale native bubbles: a native tail predating turnStartedAt never becomes the finalSummary', () => {
    const STALE_NATIVE = 'PRIOR TURN ANSWER — not this turn'
    const { instance, emitted } = makeProductionKimiFlush({
      parsedMessages: PARSED_TODO_MESSAGES,
      nativeMessages: [
        { role: 'user', content: 'earlier task', timestamp: TURN_START - 500 },
        { role: 'assistant', content: STALE_NATIVE, timestamp: TURN_START - 100 },
      ],
      waitedMs: 123_760,
    })

    instance.flushCompletedDebounceIfFinalized()

    const completions = emitted.filter((e) => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    expect(completions[0].finalSummary).not.toBe(STALE_NATIVE)
    // No fresh in-turn native final -> the pre-fix parsed fallback applies unchanged.
    expect(completions[0].finalSummary).toBe(STALE_TODO)
  })

  it('background still active -> no completion at all (hold preserved past the 30s cap)', () => {
    const { instance, emitted } = makeProductionKimiFlush({
      parsedMessages: PARSED_TODO_MESSAGES,
      nativeMessages: NATIVE_MESSAGES_WITH_FINAL,
      backgroundTaskActive: true,
      waitedMs: 123_760,
    })

    instance.flushCompletedDebounceIfFinalized()

    expect(emitted.filter((e) => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(instance.completedDebouncePending.loggedBlockReason).toBe('background_task_active')
  })

  it('before the finalization cap the quiet-dwell hold does not promote stale PTY progress as final (no emit)', () => {
    const { instance, emitted } = makeProductionKimiFlush({
      parsedMessages: PARSED_TODO_MESSAGES,
      nativeMessages: NATIVE_MESSAGES_WITH_FINAL,
      waitedMs: 1_000, // well under COMPLETED_FINALIZATION_MAX_WAIT_MS
    })

    instance.flushCompletedDebounceIfFinalized()

    expect(emitted.filter((e) => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(instance.completedDebouncePending.loggedBlockReason).toBe('parsed_final_assistant_quiet_dwell')
  })

  it('non-native providers are unchanged: no transcript read is attempted and the parsed summary ships as before', () => {
    const { instance, emitted, nativeReadCount } = makeProductionKimiFlush({
      parsedMessages: [
        { role: 'user', content: 'task', timestamp: TURN_START - 500 },
        { role: 'assistant', content: 'Done — the PTY reply.', timestamp: TURN_START + 1_000 },
      ],
      nativeMessages: null,
      waitedMs: 123_760,
    })
    instance.type = 'plain-pty-provider'
    instance.provider = { name: 'Plain PTY', settings: {} } // no nativeHistory at all

    instance.flushCompletedDebounceIfFinalized()

    const completions = emitted.filter((e) => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    expect(completions[0].finalSummary).toBe('Done — the PTY reply.')
    expect(nativeReadCount()).toBe(0)
  })
})

describe('CliProviderInstance — kimi rc.30 snapshot reuse (external-native evidence, no second live-read TOCTOU)', () => {
  // SpecCliAdapter shape (chatMessagesOwnedExternally:true): the gate's evidence probe
  // already proved present:true from the native transcript and cached that exact
  // snapshot on pending.resolvedFinalMessages. When the native quiet-dwell block
  // (KIMI-POST-FINAL-WEDGE guard) is force-released past the 30s cap, the emit must
  // reuse THAT snapshot for finalSummary instead of taking a second, independent
  // live read that can race a wire.jsonl rewrite.
  it('forced emit after native_source_final_assistant_quiet_dwell reuses the proving snapshot (no second transcript read)', () => {
    const { instance, emitted, nativeReadCount } = makeProductionKimiFlush({
      parsedMessages: [], // lease-gated kimi skips the parsed short-circuit
      nativeMessages: NATIVE_MESSAGES_WITH_FINAL,
      waitedMs: 123_760,
    })
    instance.adapter.chatMessagesOwnedExternally = true
    // The native-source quiet-dwell guard reads the transcript mtime snapshot the
    // evidence probe published: fresh (100ms < dwell) -> non-terminal hold, which the
    // 123760ms wait force-releases.
    instance.lastTranscriptSignalSnapshot = {
      available: true,
      signals: {},
      detail: { ageMs: 100, msgCount: NATIVE_MESSAGES_WITH_FINAL.length },
    }

    instance.flushCompletedDebounceIfFinalized()

    const completions = emitted.filter((e) => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    expect(completions[0].finalSummary).toBe(NATIVE_FINAL)
    expect(completions[0].completionDiagnostic).toMatchObject({
      blockReason: 'native_source_final_assistant_quiet_dwell',
      emittedAfterFinalizationTimeout: true,
    })
    // Read #1: the gate's evidence probe. Read #2: the diagnostic's evidence probe.
    // The summary comes from the cached proving snapshot — NO third live read.
    expect(nativeReadCount()).toBe(2)
  })
})
