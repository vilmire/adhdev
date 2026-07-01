import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// DEFECT 1 (FALSE-IDLE premature completion): a momentary busy→idle blip inside an
// inter-approval valley (auto-approved tool turns) triggered a `generating_completed` emit
// while the turn was still in flight — carrying a STALE mid-turn assistant summary. The
// resume-guard failed because it was a SINGLE point-sample of status at flush time (it could
// not see a generating phase that opened AND closed within the settle window), and the
// finalization gate was satisfied by a stale mid-turn assistant that predated the turn.
//
// The fix strengthens the guard on two axes, exercised here:
//   (a) Continuity: the debounce snapshots a busyEpoch + raw PTY lastOutputAt at arm time.
//       The flush cancels (never emits) if either changed — proving a busy re-entry / new
//       PTY output happened during the settle window.
//   (b) Turn-boundary evidence: the confirming final-assistant bubble must POST-DATE the
//       producing turn's start, so a stale mid-turn assistant cannot satisfy the gate.

// A realistic epoch-ms anchor (> 10_000_000_000) so the seconds-vs-ms heuristic in
// readChatMessageTimestampMs treats these as milliseconds, not seconds.
const TURN_START = 1_700_000_000_000

function makeFlushInstance(opts: {
  pending: any
  parsedMessages: any[]
  currentBusyEpoch: number
  currentLastOutputAt?: number
}): { instance: any; emitted: any[]; reScheduled: number[] } {
  const emitted: any[] = []
  const reScheduled: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-continuity'
  instance.provider = { name: 'Claude', settings: {}, requiresFinalAssistantBeforeIdle: true }
  instance.workingDir = '/repo/worktree'
  // Mesh worker context so the finalization gate path (native-native / allowTimeout) is live.
  instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
  instance.generatingStartedAt = TURN_START
  instance.busyEpoch = opts.currentBusyEpoch
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = opts.pending

  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider (claude-cli)
    getStatus: () => ({ status: 'idle', lastOutputAt: opts.currentLastOutputAt }),
    getPartialResponse: () => '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: opts.parsedMessages }),
    getScreenText: () => '',
    isWaitingForResponse: false,
  }

  instance.shouldAutoApprove = () => false
  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { reScheduled.push(delayMs) }
  // readExternalCompletionMessages falls back to the parsed messages so the turn-boundary
  // gate is exercised against a single, controllable message set.
  instance.readExternalCompletionMessages = () => opts.parsedMessages

  return { instance, emitted, reScheduled }
}

function assistantMsg(text: string, timestampMs: number) {
  return { role: 'assistant', content: text, timestamp: timestampMs }
}

function armedPending(overrides: Record<string, unknown> = {}) {
  return {
    chatTitle: 'Claude · worktree',
    duration: 5,
    timestamp: TURN_START + 5_000,
    firstObservedAt: TURN_START + 5_000,
    previousStatus: 'generating',
    turnStartedAt: TURN_START,
    busyEpochAtArm: 7,
    lastOutputAtArm: TURN_START + 4_900,
    ...overrides,
  }
}

describe('CliProviderInstance — FALSE-IDLE continuity + turn-boundary guard (Defect 1)', () => {
  it('CANCELS (no completion) when a busy phase re-entered during the settle window (epoch bumped)', () => {
    // Session read idle at flush time, but busyEpoch advanced 7→8 since arming: a generating
    // blip opened+closed inside the settle window. Must cancel, not emit a stale completion.
    const { instance, emitted } = makeFlushInstance({
      pending: armedPending({ busyEpochAtArm: 7 }),
      parsedMessages: [assistantMsg('fresh reply', TURN_START + 6_000)],
      currentBusyEpoch: 8,
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('CANCELS when new PTY output arrived during the settle window (lastOutputAt advanced)', () => {
    const { instance, emitted } = makeFlushInstance({
      pending: armedPending({ lastOutputAtArm: TURN_START + 4_900 }),
      parsedMessages: [assistantMsg('fresh reply', TURN_START + 6_000)],
      currentBusyEpoch: 7, // epoch unchanged...
      currentLastOutputAt: TURN_START + 5_500, // ...but the PTY kept printing
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('EMITS normally for a genuinely-idle-through-settle turn with a FRESH final assistant', () => {
    // Continuous idle (epoch unchanged, no new output) AND the final assistant post-dates the
    // turn start → a real completion.
    const { instance, emitted } = makeFlushInstance({
      pending: armedPending(),
      parsedMessages: [assistantMsg('the real turn result', TURN_START + 6_000)],
      currentBusyEpoch: 7,
      currentLastOutputAt: TURN_START + 4_900, // unchanged since arm
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    const completions = emitted.filter(e => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('a STALE mid-turn assistant (predating turnStartedAt) does NOT satisfy the finalization gate', () => {
    // Continuity passes (no busy re-entry, no new output) but the ONLY assistant bubble predates
    // the turn start — it is a stale mid-turn summary. The turn-boundary gate must NOT treat it
    // as a finalized turn: instead of a CLEAN completion frozen on the stale text, the gate marks
    // the completion WEAK (missing_final_assistant) and its turn-scoped finalSummary excludes the
    // stale bubble (so the reconcile loop later upgrades it once a real in-turn bubble lands).
    const now = Date.now()
    const { instance, emitted } = makeFlushInstance({
      pending: armedPending({ firstObservedAt: now }),
      parsedMessages: [assistantMsg('stale mid-turn summary', TURN_START - 2_000)],
      currentBusyEpoch: 7,
      currentLastOutputAt: TURN_START + 4_900,
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    // No CLEAN (finalized) completion: the stale bubble was rejected by the turn-boundary gate.
    const cleanCompletions = emitted.filter(e =>
      e.event === 'agent:generating_completed'
      && (!e.completionDiagnostic || !e.completionDiagnostic.blockReason))
    expect(cleanCompletions).toHaveLength(0)
    // A WEAK completion is emitted instead, flagged missing_final_assistant — proving the stale
    // bubble did NOT satisfy the gate — and it never carries the stale summary text.
    const weak = emitted.filter(e =>
      e.event === 'agent:generating_completed'
      && e.completionDiagnostic?.blockReason === 'missing_final_assistant')
    expect(weak).toHaveLength(1)
    expect(weak[0].finalSummary || '').not.toContain('stale mid-turn summary')
  })
})
