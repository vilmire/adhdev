import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS } from '../../src/providers/cli-provider-instance-types.js'

// TX-FSM Stage 2.1 — KIMI-PARSED-RACE.
//
// Root cause (RCA, real captured kimi wire.jsonl sessions): kimi is a native-source
// provider (nativeHistory.mode=native-source, transcriptAuthority=provider) that ALSO
// ships a legacy tui.transcriptPty scrape for LIVE status convenience (like opencode /
// cursor-cli — "Chat is authoritative from nativeHistory; this PTY extraction only keeps
// live status available"). completionFinalAssistantEvidence used to check that screen-
// scraped `parsedMessages` FIRST and return present=true immediately on a match — but the
// scrape has NO notion of tool activity (no kind:'tool' bubbles), so an interim narration
// bullet kimi renders just before firing a tool call ("Actually, I can't confirm that yet
// — the first command was interrupted...", observed live, tool.call landing ~50s later)
// satisfied it exactly like a genuine final answer, and the early-return fired BEFORE the
// richer native transcript below was ever consulted — the declared-completion-while-PTY-
// continued defect.
//
// The fix (cli-provider-instance.ts + kimi provider.v1.json):
//  1. For the busy-lease canary (kimi/codex-cli; codex ships no transcriptPty so this is a
//     no-op for it) the parsed short-circuit is skipped — the native transcript is judged
//     first, falling back to parsed only when native is unresolved (fail-open).
//  2. kimi's nativeHistory now maps tool.call/tool.result records to kind:'tool' bubbles, so
//     a trailing-tool-activity veto (mirroring the coordinator's hasTrailingToolActivity­
//     AfterFinalAssistant, ledger 84594b15) can reject an interim bubble once the tool call
//     has actually landed.
//  3. A quiet-dwell mirror (same PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS bound as the
//     existing codex/PTY dwell) covers the narrow window BEFORE the tool call lands, using
//     raw PTY output recency — independent of the FSM's own (momentarily wrong) status.
//
// Every hold below is non-terminal and bounded by the existing COMPLETED_FINALIZATION_MAX_
// WAIT_MS (30s) retry/cap machinery — this can only ever DELAY a completion, never wedge one
// permanently, and a transcript-absent/unresolved session falls back to the pre-Stage-2.1
// signal-absence-fail-open behaviour unchanged.

const TURN_START = 1_700_000_000_000

function kimiInstance(): any {
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'kimi'
  instance.instanceId = 'sess-kimi'
  instance.workingDir = '/repo/worktree'
  instance.generatingStartedAt = TURN_START
  instance.busyEpoch = 7
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.provider = {
    name: 'Kimi Code',
    settings: {},
    nativeHistory: { mode: 'native-source' },
    requiresFinalAssistantBeforeIdle: true,
    transcriptAuthority: 'provider',
  }
  instance.providerSessionId = 'session-1'
  instance.meshTaskInjectedAt = 0 // injectedTaskHasStartedGenerating fails open (turn started)
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
  instance.shouldAutoApprove = () => false
  instance.completionTraceOn = () => false
  instance.isMeshWorkerSession = () => true
  return instance
}

function armedPending(overrides: Record<string, unknown> = {}) {
  return {
    chatTitle: 'worktree',
    duration: 5,
    timestamp: TURN_START + 5_000,
    firstObservedAt: Date.now(),
    previousStatus: 'generating',
    turnStartedAt: TURN_START,
    busyEpochAtArm: 7,
    lastOutputAtArm: TURN_START + 4_900,
    ...overrides,
  }
}

function assistantMsg(text: string, timestampMs: number) {
  return { role: 'assistant', content: text, timestamp: timestampMs }
}

function toolMsg(timestampMs: number) {
  return { role: 'assistant', content: '↗ Bash: echo hi', kind: 'tool', timestamp: timestampMs }
}

function makeKimiFlush(opts: {
  parsedMessages: unknown[]
  externalMessages: unknown[] | null
  lastOutputAt: number
}): { instance: any; emitted: any[]; reScheduled: number[] } {
  const emitted: any[] = []
  const reScheduled: number[] = []
  const instance = kimiInstance()
  instance.completedDebouncePending = armedPending({ lastOutputAtArm: opts.lastOutputAt })

  instance.adapter = {
    chatMessagesOwnedExternally: true,
    currentTurnStartedAt: TURN_START,
    currentTurnScope: null,
    isWaitingForResponse: false,
    isProcessing: () => false,
    getPartialResponse: () => '',
    getStatus: () => ({ status: 'idle', lastOutputAt: opts.lastOutputAt }),
    getScriptParsedStatus: () => ({ status: 'idle', messages: opts.parsedMessages }),
    getScreenText: () => '',
  }

  instance.readExternalCompletionMessages = () => opts.externalMessages
  instance.lastVisibleAssistantSummaryDetail = () => ({ content: '', timestampMs: undefined })

  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { reScheduled.push(delayMs) }
  return { instance, emitted, reScheduled }
}

function completedEvents(emitted: any[]) {
  return emitted.filter(e => e.event === 'agent:generating_completed')
}

describe('CliProviderInstance — kimi parsed-scrape/native-transcript race (TX-FSM Stage 2.1)', () => {
  it('(1) interim narration + PTY still active (recent output): HOLDS, does not early-fire', () => {
    // The exact live defect: an interim assistant bubble with no trailing tool activity YET
    // (the tool.call has not landed in the transcript) and the PTY printed something moments
    // ago (spinner repaint) — no structural veto is possible yet, so the quiet-dwell mirror
    // must be the one holding this.
    const { instance, emitted, reScheduled } = makeKimiFlush({
      parsedMessages: [assistantMsg("Actually, I can't confirm that yet", TURN_START + 6_000)],
      externalMessages: [assistantMsg("Actually, I can't confirm that yet", TURN_START + 6_000)],
      lastOutputAt: Date.now() - Math.floor(PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS / 2),
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(completedEvents(emitted)).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(reScheduled.length).toBeGreaterThan(0)
  })

  it('(2) interim narration + tool.call already landed: HOLDS via the trailing-tool-activity veto (even PTY-quiet)', () => {
    // The tool call has now been recorded in the (post-fix) tool-aware native transcript —
    // definitive structural proof the bubble was narration, not a final answer. The PTY is
    // long quiet here (past the dwell) to prove the VETO — not the dwell — is what holds.
    const { instance, emitted, reScheduled } = makeKimiFlush({
      parsedMessages: [assistantMsg("Actually, I can't confirm that yet", TURN_START + 6_000)],
      externalMessages: [
        assistantMsg("Actually, I can't confirm that yet", TURN_START + 6_000),
        toolMsg(TURN_START + 6_500),
      ],
      lastOutputAt: Date.now() - (PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS + 5_000),
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(completedEvents(emitted)).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(reScheduled.length).toBeGreaterThan(0)
  })

  it('(3) true final answer, PTY quiet past the dwell, no trailing tool activity: EMITS', () => {
    const { instance, emitted } = makeKimiFlush({
      parsedMessages: [assistantMsg('Both commands have now run successfully.', TURN_START + 12_000)],
      externalMessages: [assistantMsg('Both commands have now run successfully.', TURN_START + 12_000)],
      lastOutputAt: Date.now() - (PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS + 5_000),
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(completedEvents(emitted)).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('(4) native transcript unresolved but the legacy parsed scrape has the final answer: fails OPEN and EMITS', () => {
    // Signal-absence fail-open: the native transcript is simply not resolvable yet (no
    // session pinned / file not written). The provider's own (pre-Stage-2.1) parsed evidence
    // must still be trusted rather than reporting present:false forever.
    const { instance, emitted } = makeKimiFlush({
      parsedMessages: [assistantMsg('Both commands have now run successfully.', TURN_START + 12_000)],
      externalMessages: null,
      lastOutputAt: Date.now() - (PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS + 5_000),
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(completedEvents(emitted)).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('(5) transcript absent AND no parsed evidence either: holds (missing_final_assistant floor), never wedges — unchanged pre-Stage-2.1 bounded behaviour', () => {
    // Neither source has an answer yet. This must fall through to the EXISTING
    // missing_final_assistant / floor machinery (untouched by Stage 2.1) rather than crash or
    // silently do nothing — a genuinely answerless turn still force-emits at the existing 30s
    // cap (exercised by cli-provider-canon-c-min-elapsed-floor.test.ts); here we just pin that
    // it HOLDS (does not emit) on the very first poll rather than wedging OR falsely emitting.
    const { instance, emitted, reScheduled } = makeKimiFlush({
      parsedMessages: [],
      externalMessages: null,
      lastOutputAt: Date.now() - (PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS + 5_000),
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(completedEvents(emitted)).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(reScheduled.length).toBeGreaterThan(0)
  })

  it('(6) does not engage for a provider outside the busy-lease canary (identical interim shape emits unchanged)', () => {
    // cursor-cli also ships transcriptPty + nativeHistory but is NOT in the Stage-2 canary —
    // the parsed short-circuit must stay exactly as it was pre-Stage-2.1 for it.
    const instance = kimiInstance()
    instance.type = 'cursor-cli'
    instance.provider = {
      name: 'Cursor Agent',
      settings: {},
      nativeHistory: { mode: 'native-source' },
      requiresFinalAssistantBeforeIdle: true,
      transcriptAuthority: 'provider',
    }
    instance.completedDebouncePending = armedPending({ lastOutputAtArm: Date.now() })
    const emitted: any[] = []
    const reScheduled: number[] = []
    instance.adapter = {
      chatMessagesOwnedExternally: true,
      currentTurnStartedAt: TURN_START,
      currentTurnScope: null,
      isWaitingForResponse: false,
      isProcessing: () => false,
      getPartialResponse: () => '',
      getStatus: () => ({ status: 'idle', lastOutputAt: Date.now() }),
      getScriptParsedStatus: () => ({ status: 'idle', messages: [assistantMsg('interim narration', TURN_START + 6_000)] }),
      getScreenText: () => '',
    }
    instance.readExternalCompletionMessages = () => [
      assistantMsg('interim narration', TURN_START + 6_000),
      toolMsg(TURN_START + 6_500),
    ]
    instance.lastVisibleAssistantSummaryDetail = () => ({ content: '', timestampMs: undefined })
    instance.pushEvent = (e: any) => { emitted.push(e) }
    instance.scheduleCompletedDebounceFlush = (delayMs: number) => { reScheduled.push(delayMs) }

    ;(instance as any).flushCompletedDebounceIfFinalized()

    // Unchanged pre-Stage-2.1 behaviour for a non-canary provider: the parsed scrape's
    // "present" verdict short-circuits and fires immediately, exactly as before.
    expect(completedEvents(emitted)).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
  })
})
