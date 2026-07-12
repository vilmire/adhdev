import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { BACKGROUND_TASK_HOLD_MAX_MS } from '../../src/providers/cli-provider-instance-types.js'

// (FALSE-IDLE-BACKGROUND-CMD) claude-cli's idle/generating judgment is PTY-screen-derived and
// blind to its own run_in_background bash jobs. When such a job is launched and the parent turn
// returns to a ready prompt, the point-sample reads 'idle' → a false agent:generating_completed
// would fire while the background job is still running. The native-history transcript surfaces
// the durable signal (a background bash tool_use with no matching tool_result), exposed on
// getScriptParsedStatus() as backgroundTaskActive. flushCompletedDebounceIfFinalized adds a
// FOURTH hold condition: HOLD (re-arm) while backgroundTaskActive is true, then emit once it
// clears — bounded by BACKGROUND_TASK_HOLD_MAX_MS so a killed/never-finishing job cannot pin
// the session in generating forever.

type FlushHarness = {
  instance: any
  events: any[]
  rescheduleCalls: number[]
}

function makeFlushInstance(opts: {
  backgroundTaskActive: boolean
  backgroundTaskCount?: number
  holdSince?: number
}): FlushHarness {
  const events: any[] = []
  const rescheduleCalls: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-bg'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
  instance.lastStatus = 'generating'
  instance.generatingStartedAt = 1000
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = {
    chatTitle: 'task',
    duration: 5,
    timestamp: 111,
    firstObservedAt: Date.now(), // waitedMs ≈ 0 — well under the 30s force-emit cap
    previousStatus: 'generating',
    backgroundTaskHoldSince: opts.holdSince,
  }

  const parsed: any = { status: 'idle', messages: [] }
  if (opts.backgroundTaskActive) {
    parsed.backgroundTaskActive = true
    parsed.backgroundTaskCount = opts.backgroundTaskCount ?? 1
  }
  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider
    getStatus: () => ({ status: 'idle' }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => parsed,
    getScreenText: () => '',
    isWaitingForResponse: false,
  }

  instance.shouldAutoApprove = () => false
  // Force a clean-emit path when NOT holding on background: no finalization block.
  instance.getCompletedFinalizationBlock = () => null
  instance.completionFinalSummary = () => 'done'
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { rescheduleCalls.push(delayMs) }

  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []

  return { instance, events, rescheduleCalls }
}

describe('CliProviderInstance — FALSE-IDLE-BACKGROUND-CMD completion hold', () => {
  it('HOLDS (does not emit) while a background bash job is unresolved', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({ backgroundTaskActive: true })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0)
    expect(rescheduleCalls.length).toBeGreaterThan(0)
    expect((instance as any).completedDebouncePending).not.toBeNull()
    // The hold marker was stamped so the cap window is tracked.
    expect(typeof (instance as any).completedDebouncePending.backgroundTaskHoldSince).toBe('number')
  })

  it('EMITS once the background job clears (backgroundTaskActive false)', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({ backgroundTaskActive: false })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('RELEASES to normal finalization once the hold cap is exceeded (never wedges forever)', () => {
    // The background job never cleared, but the hold started longer ago than the cap.
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      backgroundTaskActive: true,
      holdSince: Date.now() - BACKGROUND_TASK_HOLD_MAX_MS - 1000,
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    // Cap exceeded → fall through to normal finalization (getCompletedFinalizationBlock=null → clean emit).
    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    expect((instance as any).completedDebouncePending).toBeNull()
  })
})
