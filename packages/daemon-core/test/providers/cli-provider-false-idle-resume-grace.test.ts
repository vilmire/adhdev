import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// (FALSE-IDLE, Fix 1) An autonomous AUTO-APPROVING mesh worker auto-resolves a modal; the
// engine flips straight to 'generating' and the resumed turn falls briefly silent in the
// inter-approval quiet valley BEFORE the next tool/approval. Unlike the SETTLE-VALLEY case,
// this valley arrives with previousStatus==='generating' AND a recorded mid-turn assistant
// bubble (finalAssistantPresent=true), so every downstream gate is clean and the CLEAN emit
// path fires an early agent:generating_completed mid-turn (live: the same session re-enters
// waiting_approval ~13s later).
//
// Fix 1 HOLDS that completion (terminal:false, reason='approval_resume_grace') while inside
// the post-approval resume grace, so:
//   (1) no early completion is emitted during the valley,
//   (2) the retry loop's resume guard cancels when the worker resumes, and
//   (3) once the grace lapses (a turn that truly ended after an approval) it emits normally.
// Scoped by inApprovalResumeGrace to autonomous auto-approving sessions with a recent
// resolveModal — a plain/non-auto-approve turn is never held (regression guard below).

const GRACE_MS = 18_000

type FlushHarness = {
  instance: any
  events: any[]
  rescheduleCalls: number[]
}

function makeFlushInstance(opts: {
  evidencePresent: boolean
  previousStatus: 'generating' | 'waiting_approval'
  autoApprove: boolean
  autonomousMesh: boolean
  approvalResolvedAgoMs: number | null // null = never resolved
  adapterStatus?: string
  finalSummary?: string
}): FlushHarness {
  const events: any[] = []
  const rescheduleCalls: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-false-idle'
  instance.provider = { name: 'Claude', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = 'psess-1'
  instance.settings = opts.autonomousMesh ? { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' } : {}
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
    previousStatus: opts.previousStatus,
  }

  const adapterStatus = opts.adapterStatus ?? 'idle'
  const resolvedAt = opts.approvalResolvedAgoMs === null ? 0 : Date.now() - opts.approvalResolvedAgoMs
  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider (claude-cli)
    getStatus: () => ({ status: adapterStatus }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
    getScreenText: () => '',
    isWaitingForResponse: false,
    lastApprovalResolvedAt: resolvedAt,
  }

  instance.shouldAutoApprove = () => opts.autoApprove
  instance.isAutonomousMeshSession = () => opts.autonomousMesh
  instance.hasApprovalResolutionEvidence = () => true
  // Exercise the REAL inApprovalResumeGrace via the prototype (not stubbed) — it reads
  // shouldAutoApprove / isAutonomousMeshSession / adapter.lastApprovalResolvedAt above.
  instance.completionFinalAssistantEvidence = () => ({
    present: opts.evidencePresent,
    messages: [],
    source: 'external-native',
  })
  instance.completionFinalSummary = () => opts.finalSummary
  instance.recordPendingTranscriptProbe = () => null
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { rescheduleCalls.push(delayMs) }

  instance.context = { emitProviderEvent: (e: any) => events.push(e) }
  instance.events = []

  return { instance, events, rescheduleCalls }
}

describe('CliProviderInstance — FALSE-IDLE post-approval resume grace (Fix 1)', () => {
  it('(1) HOLDS an early completion for an auto-approving mesh worker in the inter-approval valley (generating→idle, mid-turn bubble, recent auto-approve)', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: true, // mid-turn assistant bubble satisfies the finalization gate
      previousStatus: 'generating', // resolveModal flipped to generating, not waiting_approval
      autoApprove: true,
      autonomousMesh: true,
      approvalResolvedAgoMs: 3_000, // well inside the 18s grace (the ~13s observed gap)
      finalSummary: 'partial mid-turn text',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0) // no early completion during the valley
    expect(rescheduleCalls.length).toBeGreaterThan(0) // held with a bounded retry
    expect((instance as any).completedDebouncePending).not.toBeNull()
  })

  it('(2) emits normally once the grace window has lapsed (turn genuinely ended after an approval)', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: true,
      previousStatus: 'generating',
      autoApprove: true,
      autonomousMesh: true,
      approvalResolvedAgoMs: GRACE_MS + 2_000, // past the resume grace — real silence
      finalSummary: 'the real final answer',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    expect(events[0].finalSummary).toBe('the real final answer')
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('(2b) cancels the pending completion when the worker RESUMES during the grace hold', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: true,
      previousStatus: 'generating',
      autoApprove: true,
      autonomousMesh: true,
      approvalResolvedAgoMs: 3_000,
      adapterStatus: 'generating', // worker resumed into the next turn
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0)
    expect(rescheduleCalls).toEqual([])
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('(3) REGRESSION: a plain non-auto-approve mesh turn (no recent approval) emits immediately — never held', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: true,
      previousStatus: 'generating',
      autoApprove: false, // auto-approve OFF → not an autonomous auto-approving valley
      autonomousMesh: true,
      approvalResolvedAgoMs: null, // never resolved a modal this turn
      finalSummary: 'done',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('agent:generating_completed')
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('(3b) REGRESSION: an auto-approving worker with NO recent approval emits immediately (recency window is the gate, not the flag)', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: true,
      previousStatus: 'generating',
      autoApprove: true,
      autonomousMesh: true,
      approvalResolvedAgoMs: null, // auto-approve intent, but no modal was resolved
      finalSummary: 'done',
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(rescheduleCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect((instance as any).completedDebouncePending).toBeNull()
  })

  it('(4) REGRESSION: the existing waiting_approval SETTLE-VALLEY hold still fires (evidence absent)', () => {
    const { instance, events, rescheduleCalls } = makeFlushInstance({
      evidencePresent: false, // transcript not yet written
      previousStatus: 'waiting_approval',
      autoApprove: true,
      autonomousMesh: true,
      approvalResolvedAgoMs: 3_000,
      finalSummary: "I'll verify...",
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(events).toHaveLength(0)
    expect(rescheduleCalls.length).toBeGreaterThan(0)
    expect((instance as any).completedDebouncePending).not.toBeNull()
  })
})
