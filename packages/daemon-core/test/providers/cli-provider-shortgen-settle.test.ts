import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// (FALSE-IDLE short-generating settle) The "short-generating" branch of detectStatusTransition
// fires when a generating phase lasted less than the 3s generating-debounce window (i.e.
// generatingDebouncePending is still armed). It was a POINT-SAMPLE: a single idle read that
// emitted agent:generating_completed INLINE/SYNCHRONOUSLY with zero continuity backing. For a
// mesh worker/coordinator this fired a FALSE "completed/idle" notification while the worker was
// merely mid-turn between two tool calls (a sub-3s dip that re-enters generating ~0.5s later) —
// a completion the coordinator can never correct.
//
// The fix routes the short-generating completion through the SAME settle + continuity machinery
// as the normal completedDebounce branch, but ONLY for autonomous mesh sessions
// (isAutonomousMeshSession() = worker OR self-coordinator). Instead of an inline fire it arms
// completedDebouncePending (busyEpochAtArm + lastOutputAtArm) and schedules a settle flush, so
// flushCompletedDebounceIfFinalized() re-verifies CONTINUOUS idle before emitting — a busy
// re-entry or new PTY output within the window cancels the false completion. Non-mesh interactive
// sessions keep the inline fast-path (no coordinator to falsely notify; dashboard UX latency).
//
// These tests drive detectStatusTransition() directly and assert:
//   (1) a sub-3s generating dip with source='unavailable' for a mesh session does NOT
//       synchronously fire generating_completed — it arms the settle window instead.
//   (2) the armed settle window is then cancelable by a subsequent busy re-entry (epoch bump).
//   (3) a non-mesh short-gen dip still fires inline (fast-path preserved).

function makeShortGenInstance(opts: {
  settings: Record<string, unknown>
  evidenceSource?: 'parsed' | 'external-native' | 'unavailable'
  finalSummary?: string
  lastOutputAt?: number
}): { instance: any; emitted: any[]; scheduledDelays: number[] } {
  const emitted: any[] = []
  const scheduledDelays: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-shortgen'
  // claude-cli does NOT set requiresFinalAssistantBeforeIdle — so a source='unavailable'
  // dip only becomes missing-evidence via the fix's folded 'unavailable' clause.
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = opts.settings

  // A generating→idle transition whose generating phase was SHORTER than the 3s debounce,
  // so generatingDebouncePending is still armed → the short-generating branch is taken.
  instance.lastStatus = 'generating'
  instance.generatingStartedAt = Date.now() - 800 // <3s generating dip
  instance.generatingDebouncePending = { chatTitle: 'Claude · worktree', timestamp: Date.now() - 800 }
  instance.generatingDebounceTimer = setTimeout(() => {}, 3000)
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = null
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.busyEpoch = 3

  const lastOutputAt = opts.lastOutputAt ?? Date.now() - 500
  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider (claude-cli)
    getStatus: () => ({ status: 'idle', lastOutputAt }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
    getScreenText: () => '',
    isWaitingForResponse: false,
    currentTurnStartedAt: Date.now() - 800,
    currentTurnTaskId: typeof opts.settings.meshActiveTaskId === 'string'
      ? opts.settings.meshActiveTaskId
      : undefined,
  }

  // No-op the surrounding machinery so the transition handler runs in isolation.
  instance.maybeAutoApproveStatus = () => false
  instance.promoteProviderSessionId = () => {}
  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.maybeEmitApprovalEvent = () => {}
  instance.updateNoProgressWatchdog = () => {}
  instance.maybeAttachMeshOnGenerating = () => {}
  instance.applyProviderResponse = () => {}
  instance.monitor = { check: () => [] }
  // Control the short-gen evidence: source='unavailable' with no final summary is the
  // zero-evidence mid-turn dip that must NOT fire a genuine completion.
  instance.completionFinalAssistantEvidence = () => ({
    present: !!opts.finalSummary,
    messages: [],
    source: opts.evidenceSource ?? 'unavailable',
  })
  // Capture the flush schedule — routing through settle instead of inline fire.
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { scheduledDelays.push(delayMs) }

  return { instance, emitted, scheduledDelays }
}

describe('CliProviderInstance — FALSE-IDLE short-generating settle routing', () => {
  it('a sub-3s generating dip with source=unavailable for a MESH WORKER does NOT fire inline — it arms the settle window', () => {
    const { instance, emitted, scheduledDelays } = makeShortGenInstance({
      settings: { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' },
    })

    ;(instance as any).detectStatusTransition()

    // No synchronous/inline generating_completed — the false-idle bug.
    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    // A completion is PENDING (held for the settle window) with a non-zero delay so the
    // continuity guard can cancel it when the worker resumes its next tool call.
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(scheduledDelays).toHaveLength(1)
    expect(scheduledDelays[0]).toBeGreaterThan(0)
  })

  it('the SELF-COORDINATOR (meshCoordinatorFor) short-gen dip also arms the settle window, not an inline fire', () => {
    const { instance, emitted, scheduledDelays } = makeShortGenInstance({
      settings: { meshCoordinatorFor: 'mesh-1' },
    })

    ;(instance as any).detectStatusTransition()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(scheduledDelays[0]).toBeGreaterThan(0)
  })

  it('the armed short-gen settle completion is CANCELABLE by a subsequent busy re-entry (worker resumes)', () => {
    const { instance, emitted } = makeShortGenInstance({
      settings: { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' },
    })

    // 1) short-gen dip → arms the settle window.
    ;(instance as any).detectStatusTransition()
    expect(instance.completedDebouncePending).not.toBeNull()
    const epochAtArm = instance.completedDebouncePending.busyEpochAtArm
    expect(typeof epochAtArm).toBe('number')

    // 2) the worker resumes its next tool call: a busy re-entry bumps busyEpoch. The flush
    //    guard must then CANCEL the pending completion (proving it was a mid-turn dip).
    instance.busyEpoch = epochAtArm + 1
    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('a GENUINELY non-mesh short-gen dip still fires INLINE (fast-path preserved, no settle)', () => {
    const { instance, emitted, scheduledDelays } = makeShortGenInstance({
      settings: {},
      // Non-mesh + missing evidence would be SUPPRESSED (no mesh context). Give it a real
      // summary so the inline fire path is exercised and asserted.
      evidenceSource: 'parsed',
      finalSummary: 'the quick reply',
    })
    // With a real summary the branch reads evidence.messages via extractFinalSummaryFromMessages;
    // stub it to return the summary deterministically.
    instance.completionFinalAssistantEvidence = () => ({
      present: true,
      messages: [{ role: 'assistant', content: 'the quick reply', timestamp: Date.now() }],
      source: 'parsed',
    })

    ;(instance as any).detectStatusTransition()

    // Inline fire: a completion was emitted synchronously and NO settle flush was scheduled.
    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
    expect(scheduledDelays).toHaveLength(0)
  })
})
