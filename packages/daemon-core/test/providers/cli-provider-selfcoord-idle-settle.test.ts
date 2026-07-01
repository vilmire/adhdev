import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// (FALSE-IDLE self-coordinator settle) On a self-coordinating daemon (worker + coordinator
// on the SAME daemon) the coordinator's OWN claude-cli session carries meshCoordinatorFor
// but NONE of the worker markers (meshNodeFor / meshActiveTaskId / meshNodeId /
// launchedByCoordinator). The native-history flushDelay computation only granted the
// NATIVE_HISTORY_MESH_IDLE_SETTLE_MS settle window when isMeshWorkerSession() was true, so
// the coordinator's own turn flushed at delay=0 — no settle window at all.
//
// With flushDelay=0 the busyEpoch/lastOutputAt continuity guard (a flush-time point-check)
// has no window in which to observe the ~0.5s inter-approval auto-approve valley (busy→idle
// blip→generating re-entry). The first idle sample flushes synchronously and the guard reads
// the pre-valley epoch, so a mid-turn "next-step" sentence was emitted as a finalSummary.
//
// The fix widens the settle-window condition from isMeshWorkerSession() to
// isAutonomousMeshSession() = worker OR self-coordinator (meshCoordinatorFor). These tests
// assert the scheduled flush DELAY across the three session shapes: self-coordinator now gets
// the settle window, mesh worker is UNCHANGED, and a genuinely non-mesh session still flushes
// immediately (delay=0).

function makeTransitionInstance(opts: { settings: Record<string, unknown> }): {
  instance: any
  scheduledDelays: number[]
} {
  const scheduledDelays: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-selfcoord'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = opts.settings

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

describe('CliProviderInstance — FALSE-IDLE self-coordinator native-history idle settle window', () => {
  it('schedules a NON-ZERO settle window for a SELF-COORDINATOR native-history session (meshCoordinatorFor, no worker markers)', () => {
    // The coordinator's own claude-cli session: meshCoordinatorFor set, but NONE of the
    // worker markers. Previously flushDelay=0 here (bug). Now it gets the settle window.
    const { instance, scheduledDelays } = makeTransitionInstance({
      settings: { meshCoordinatorFor: 'mesh-1' },
    })

    ;(instance as any).detectStatusTransition()

    expect(scheduledDelays).toHaveLength(1)
    expect(scheduledDelays[0]).toBeGreaterThan(0)
    // A completion is now PENDING (held for the settle window) so the continuity guard can
    // absorb the auto-approve valley, rather than fired immediately on the first idle sample.
    expect(instance.completedDebouncePending).not.toBeNull()
  })

  it('leaves the mesh WORKER settle window UNCHANGED (still non-zero) — regression guard', () => {
    const { instance, scheduledDelays } = makeTransitionInstance({
      settings: { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' },
    })

    ;(instance as any).detectStatusTransition()

    expect(scheduledDelays).toHaveLength(1)
    expect(scheduledDelays[0]).toBeGreaterThan(0)
    expect(instance.completedDebouncePending).not.toBeNull()
  })

  it('keeps flushDelay=0 (immediate flush) for a GENUINELY non-mesh native-history session (neither worker nor self-coordinator)', () => {
    const { instance, scheduledDelays } = makeTransitionInstance({ settings: {} })

    ;(instance as any).detectStatusTransition()

    expect(scheduledDelays).toHaveLength(1)
    expect(scheduledDelays[0]).toBe(0)
  })
})
