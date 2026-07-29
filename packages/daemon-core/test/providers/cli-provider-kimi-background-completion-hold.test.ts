import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { BACKGROUND_TASK_HOLD_MAX_MS } from '../../src/providers/cli-provider-instance-types.js'

// (rc.27 delegated-background-work premature completion — kimi class) A kimi mesh worker
// launched a background exec cell, ended its model turn with progress prose, and the point-
// sample read 'idle' → a false agent:generating_completed fired while the cell was still
// running, prematurely completing the delegated queue task. The kimi wire.jsonl detector
// (background-task-detector.ts) surfaces the durable signal as backgroundTaskActive on
// getScriptParsedStatus(); flushCompletedDebounceIfFinalized's FOURTH hold condition
// re-arms instead of emitting while it is set, releases exactly once when the provider
// consumes the cell's result into the final answer, and is bounded by
// BACKGROUND_TASK_HOLD_MAX_MS so a wedged cell can never pin the session forever.
//
// Mirror of cli-provider-background-task-hold.test.ts (claude-cli class) for the kimi
// native-source class, plus the exactly-once release contract.

type FlushHarness = {
  instance: any
  events: any[]
  rescheduleCalls: number[]
  parsed: any
}

function makeKimiFlushInstance(opts: {
  backgroundTaskActive: boolean
  backgroundTaskCount?: number
  holdSince?: number
}): FlushHarness {
  const events: any[] = []
  const rescheduleCalls: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'kimi'
  instance.instanceId = 'sess-kimi-bg'
  instance.provider = { name: 'Kimi', settings: {}, nativeHistory: { mode: 'native-source' } }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'session_d3f014e8-7c09-4b97-b3dd-a7acbb46db10'
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

  const parsed: any = { status: 'idle', messages: [], backgroundTaskSupport: 'tracked' }
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
  instance.completionFinalSummary = () => 'Deploy finished: all checks green.'
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { rescheduleCalls.push(delayMs) }

  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []

  return { instance, events, rescheduleCalls, parsed }
}

describe('CliProviderInstance — kimi background-cell completion hold (rc.27)', () => {
  it('HOLDS (does not emit) while the kimi background cell is still running', () => {
    const { instance, events, rescheduleCalls } = makeKimiFlushInstance({ backgroundTaskActive: true })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0)
    expect(rescheduleCalls.length).toBeGreaterThan(0)
    expect((instance as any).completedDebouncePending).not.toBeNull()
    expect(typeof (instance as any).completedDebouncePending.backgroundTaskHoldSince).toBe('number')
  })

  it('releases EXACTLY ONCE when the cell resolves and is consumed (backgroundTaskActive clears)', () => {
    const { instance, events, parsed } = makeKimiFlushInstance({ backgroundTaskActive: true })

    // Phase 1: cell running → held.
    ;(instance as any).flushCompletedDebounceIfFinalized()
    expect(events).toHaveLength(0)

    // Phase 2: cell exited + result consumed into the final answer → flag clears → emit.
    delete parsed.backgroundTaskActive
    delete parsed.backgroundTaskCount
    ;(instance as any).flushCompletedDebounceIfFinalized()
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    expect((instance as any).completedDebouncePending).toBeNull()

    // Phase 3: a later flush (reconcile tick, duplicate idle sample) must NOT re-emit.
    ;(instance as any).flushCompletedDebounceIfFinalized()
    expect(events).toHaveLength(1)
  })

  it('RELEASES to normal finalization once the hold cap is exceeded (a wedged cell never pins forever)', () => {
    const { instance, events, rescheduleCalls } = makeKimiFlushInstance({
      backgroundTaskActive: true,
      holdSince: Date.now() - BACKGROUND_TASK_HOLD_MAX_MS - 1000,
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
  })

  it('claude-cli control: the existing background bash hold is unchanged', () => {
    const { instance, events, rescheduleCalls } = makeKimiFlushInstance({ backgroundTaskActive: true })
    instance.type = 'claude-cli'
    instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0)
    expect(rescheduleCalls.length).toBeGreaterThan(0)
  })
})
