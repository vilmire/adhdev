import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS } from '../../src/providers/cli-provider-instance-types.js'

// FALSE-IDLE-MIDTURN-COMPLETION (mission: fix/false-idle-midturn-completion-gate).
//
// The completion gate mistook a MID-TURN momentary idle for a finished turn and fired
// agent:generating_completed early, on two provider classes that the earlier rc.485
// (poll-static-idle harden) / rc.500 (background-cmd hold) defenses did NOT cover:
//
//  (A) antigravity / native-history: PTY carries NO assistant evidence
//      (finalAssistantEvidence.present=false, source=external-native). When a PTY-parser
//      idle blip lands mid-turn and the transcript's answer has not been written yet,
//      getCompletedFinalizationBlock USED TO `return null` for antigravity-cli — an
//      IMMEDIATE clean emit with zero transcript evidence. Now it HOLDS for the transcript
//      (non-terminal, bounded by 30s) and emits genuinely only once the assistant lands.
//
//  (B) codex / PTY-parsed: a partial sentence fragment on-screen satisfies
//      completionHasFinalAssistantMessage (present=true). When the FSM momentarily reads
//      idle and the last raw PTY output is very recent (turn still streaming), the gate
//      USED TO fall through to a clean emit. Now it HOLDS until a minimum QUIET DWELL has
//      elapsed since the last PTY output.
//
// Both holds are strictly stricter (only ever DELAY an emit, bounded) and preserve prompt
// emission for genuinely-finished turns.

const TURN_START = 1_700_000_000_000

function baseInstance(type: string): any {
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = type
  instance.instanceId = `sess-${type}`
  instance.workingDir = '/repo/worktree'
  instance.generatingStartedAt = TURN_START
  instance.busyEpoch = 7
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  // Mesh worker context so allowMissingAssistantTimeout / autonomous-session gating is live.
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

// ---------------------------------------------------------------------------
// (A) antigravity / native-history: no transcript evidence must HOLD, not emit.
// ---------------------------------------------------------------------------

function makeAntigravityFlush(opts: {
  externalMessages: unknown[]
  probeLastRole?: string
  probeContentLen?: number
}): { instance: any; emitted: any[]; reScheduled: number[] } {
  const emitted: any[] = []
  const reScheduled: number[] = []
  const instance = baseInstance('antigravity-cli')
  instance.provider = { name: 'Antigravity', settings: {}, nativeHistory: {} }
  instance.providerSessionId = ''
  instance.startedAt = 0
  instance.meshTaskInjectedAt = 0 // injectedTaskHasStartedGenerating fails-open (turn started)
  instance.completedDebouncePending = armedPending()

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

  // The native transcript read is stubbed; present/source are computed by the real gate.
  instance.readExternalCompletionMessages = () => opts.externalMessages
  instance.lastVisibleAssistantSummary = () => ''
  // The transcript probe the gate inspects for a landed assistant bubble.
  instance.lastExternalCompletionProbe = {
    readAt: Date.now(),
    msgCount: opts.externalMessages.length,
    lastRole: opts.probeLastRole ?? 'user',
    lastKind: null,
    contentLen: opts.probeContentLen ?? 0,
    sourcePath: null,
    sourceMtimeMs: null,
    mtimeAgeMs: null,
  }

  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { reScheduled.push(delayMs) }
  return { instance, emitted, reScheduled }
}

describe('FALSE-IDLE-MIDTURN (A) antigravity native-history: no transcript evidence must not early-fire', () => {
  it('HOLDS (no completion, re-scheduled) when present=false and the transcript tail is not an assistant reply', () => {
    // Mid-turn: the native transcript still tails a user/tool bubble — the assistant answer
    // has not landed. Previously antigravity clean-emitted here with zero evidence.
    const { instance, emitted, reScheduled } = makeAntigravityFlush({
      externalMessages: [{ role: 'user', content: 'the injected task', timestamp: TURN_START + 100 }],
      probeLastRole: 'user',
      probeContentLen: 0,
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    // Held → still pending and a retry was scheduled.
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(reScheduled.length).toBeGreaterThan(0)
  })

  it('EMITS once the transcript probe shows a landed assistant bubble (evidence arrived)', () => {
    // The same session one retry later: the assistant answer is now written to native-history,
    // so the probe tail is an assistant reply → the gate clears and a genuine completion fires.
    const { instance, emitted } = makeAntigravityFlush({
      externalMessages: [
        { role: 'user', content: 'the injected task', timestamp: TURN_START + 100 },
        { role: 'assistant', content: 'the real final answer', timestamp: TURN_START + 6_000 },
      ],
      probeLastRole: 'assistant',
      probeContentLen: 21,
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (B) codex / PTY-parsed: a fresh partial fragment must HOLD until the quiet dwell.
// ---------------------------------------------------------------------------

function makeCodexFlush(opts: {
  parsedMessages: unknown[]
  lastOutputAt: number
}): { instance: any; emitted: any[]; reScheduled: number[] } {
  const emitted: any[] = []
  const reScheduled: number[] = []
  const instance = baseInstance('codex-cli')
  instance.provider = { name: 'Codex', settings: {} }
  instance.completedDebouncePending = armedPending({ lastOutputAtArm: opts.lastOutputAt })

  instance.adapter = {
    chatMessagesOwnedExternally: false, // PTY-parsed provider
    currentTurnStartedAt: TURN_START,
    currentTurnScope: null,
    isWaitingForResponse: false,
    isProcessing: () => false,
    getPartialResponse: () => '',
    getStatus: () => ({ status: 'idle', lastOutputAt: opts.lastOutputAt }),
    getScriptParsedStatus: () => ({ status: 'idle', messages: opts.parsedMessages }),
    getScreenText: () => '',
  }

  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { reScheduled.push(delayMs) }
  return { instance, emitted, reScheduled }
}

function assistantMsg(text: string, timestampMs: number) {
  return { role: 'assistant', content: text, timestamp: timestampMs }
}

describe('FALSE-IDLE-MIDTURN (B) codex PTY-parsed: partial fragment + short quiet must not clean-emit', () => {
  it('HOLDS when the on-screen assistant "final" is fresh (last PTY output within the quiet dwell)', () => {
    // A partial fragment reads as a final assistant bubble (present=true), but the PTY printed
    // it moments ago — the turn is still streaming. Must hold, not clean-emit.
    const now = Date.now()
    const { instance, emitted, reScheduled } = makeCodexFlush({
      parsedMessages: [assistantMsg('작업을 계속 진행하겠습니다', TURN_START + 6_000)],
      lastOutputAt: now - Math.floor(PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS / 2), // still within dwell
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(reScheduled.length).toBeGreaterThan(0)
  })

  it('EMITS a genuine completion once the screen has been quiet past the dwell (turn stable)', () => {
    // Same parsed assistant, but the last PTY output is now well past the quiet dwell — the
    // turn's tail is stable. A real completion fires.
    const now = Date.now()
    const { instance, emitted } = makeCodexFlush({
      parsedMessages: [assistantMsg('작업을 모두 완료했습니다.', TURN_START + 6_000)],
      lastOutputAt: now - (PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS + 2_000), // quiet long enough
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
  })
})
