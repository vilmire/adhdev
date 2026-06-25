import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// (FALSEIDLE-BGCHILD-a) A native-history mesh worker turn that spawns a BACKGROUND child
// (e.g. `npm test &`) can paint a burst of child output, fall quiet, and have the screen
// parser read a prior/intermediate standard assistant as if the turn were done — firing a
// FALSE idle while the agent is still generating (e.g. mid-commit). Native-history providers
// normally flush the completion immediately (flushDelay=0), so there is no window for the
// resume guard in flushCompletedDebounceIfFinalized to see the agent pick the turn back up.
//
// The fix gives a native-history MESH WORKER session a short non-zero settle window on the
// generating→idle transition, restoring the resume guard. A non-mesh native-history session
// keeps the immediate flush. These tests assert the scheduled flush DELAY for both.

function makeTransitionInstance(opts: { meshContext: boolean }): {
  instance: any
  scheduledDelays: number[]
} {
  const scheduledDelays: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-bgchild'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = opts.meshContext ? { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' } : {}

  // The generating→idle transition the handler reacts to.
  instance.lastStatus = 'generating'
  instance.generatingStartedAt = Date.now() - 5_000
  instance.generatingDebouncePending = null
  instance.generatingDebounceTimer = null
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = null
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false

  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider (claude-cli)
    getStatus: () => ({ status: 'idle' }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
    getScreenText: () => '',
    isWaitingForResponse: false,
  }

  // No-op the surrounding machinery so the transition handler runs in isolation.
  instance.maybeAutoApproveStatus = () => false
  instance.promoteProviderSessionId = () => {}
  instance.pushEvent = () => {}
  instance.maybeEmitApprovalEvent = () => {}
  instance.updateNoProgressWatchdog = () => {}
  instance.maybeAttachMeshOnGenerating = () => {}
  instance.applyProviderResponse = () => {}
  instance.completionHasFinalAssistantMessage = () => false
  instance.monitor = { check: () => [] }
  // Capture the flush schedule — the unit under test.
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { scheduledDelays.push(delayMs) }

  return { instance, scheduledDelays }
}

describe('CliProviderInstance — FALSEIDLE-BGCHILD-a native-history idle settle window', () => {
  it('schedules a NON-ZERO settle window for a native-history MESH WORKER generating→idle', () => {
    const { instance, scheduledDelays } = makeTransitionInstance({ meshContext: true })

    ;(instance as any).detectStatusTransition()

    expect(scheduledDelays).toHaveLength(1)
    expect(scheduledDelays[0]).toBeGreaterThan(0)
    // A completion is now PENDING (held for the settle window) rather than fired immediately.
    expect(instance.completedDebouncePending).not.toBeNull()
  })

  it('keeps flushDelay=0 (immediate flush) for a non-mesh native-history generating→idle', () => {
    const { instance, scheduledDelays } = makeTransitionInstance({ meshContext: false })

    ;(instance as any).detectStatusTransition()

    expect(scheduledDelays).toHaveLength(1)
    expect(scheduledDelays[0]).toBe(0)
  })
})
