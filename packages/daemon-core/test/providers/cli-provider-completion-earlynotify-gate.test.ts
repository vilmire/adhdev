import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import {
  clearDebugTrace,
  configureDebugTraceStore,
  getRecentDebugTrace,
} from '../../src/logging/debug-trace.js'
import { resetDebugRuntimeConfig, setDebugRuntimeConfig } from '../../src/logging/debug-config.js'

// COMPLETION-EARLYNOTIFY — the completion gate must NOT fire an early
// agent:generating_completed while a turn is still in flight, and the trace hooks
// must record the gate's decisions.
//
//   FixA — a waiting_approval→idle "resolved" completion whose adapter still reports a
//          pending response (auto-approve resolved the modal, the agent RESUMED) must be
//          HELD, not fired. Previously the previousStatus==='waiting_approval' bypass
//          skipped the pending checks and fired mid-turn.
//   FixB — completionFinalAssistantEvidence requires an UPPER-bound turn-end signal
//          (!hasAdapterPendingResponse(): turn-scope closed, no in-flight tool, no partial)
//          in addition to the final-assistant content check, so the first assistant bubble
//          of a still-running tool turn is not mistaken for the last.
//   Trace — the fire / hold / cancel decisions land in the shared debug-trace ring under
//          category 'completion-gate' (content-free payloads).
//
// These drive the private flush/gate methods via Object.create (skipping the native PTY),
// mirroring cli-provider-false-idle-continuity.test.ts.

const TURN_START = 1_700_000_000_000

type AdapterOverrides = {
  status?: string
  isWaitingForResponse?: boolean
  currentTurnScope?: unknown
  isProcessing?: () => boolean
  partial?: string
  parsedMessages?: any[]
  seq?: { approvalEntrySeq?: number; lastResolvedEntrySeq?: number }
  lastOutputAt?: number
}

function assistantMsg(text: string, timestampMs: number) {
  return { role: 'assistant', content: text, timestamp: timestampMs }
}

function makeInstance(opts: {
  pending: any
  adapter?: AdapterOverrides
  busyEpoch?: number
  meshContext?: boolean
  traceOn?: boolean
}): { instance: any; emitted: any[]; reScheduled: number[] } {
  const a = opts.adapter ?? {}
  const emitted: any[] = []
  const reScheduled: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any

  instance.type = 'claude-cli'
  instance.instanceId = 'sess-earlynotify'
  instance.provider = { name: 'Claude', settings: {}, requiresFinalAssistantBeforeIdle: true }
  instance.workingDir = '/repo/worktree'
  instance.settings = opts.meshContext === false ? {} : { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
  instance.generatingStartedAt = TURN_START
  instance.busyEpoch = opts.busyEpoch ?? (opts.pending?.busyEpochAtArm ?? 0)
  instance.lastApprovalEventFingerprint = ''
  instance.autoApproveBusy = false
  instance.completedDebounceTimer = null
  instance.completedDebouncePending = opts.pending

  const parsedMessages = a.parsedMessages ?? [assistantMsg('the real turn result', TURN_START + 6_000)]
  instance.adapter = {
    chatMessagesOwnedExternally: true,
    getStatus: () => ({ status: a.status ?? 'idle', lastOutputAt: a.lastOutputAt, ...(a.seq ?? {}) }),
    getPartialResponse: () => a.partial ?? '',
    getScriptParsedStatus: () => ({ status: 'idle', messages: parsedMessages }),
    getScreenText: () => '',
    isWaitingForResponse: a.isWaitingForResponse ?? false,
    ...(a.currentTurnScope !== undefined ? { currentTurnScope: a.currentTurnScope } : {}),
    ...(a.isProcessing ? { isProcessing: a.isProcessing } : {}),
  }

  instance.shouldAutoApprove = () => false
  instance.pushEvent = (e: any) => { emitted.push(e) }
  instance.scheduleCompletedDebounceFlush = (delayMs: number) => { reScheduled.push(delayMs) }
  instance.readExternalCompletionMessages = () => parsedMessages

  return { instance, emitted, reScheduled }
}

function armedPending(overrides: Record<string, unknown> = {}) {
  return {
    chatTitle: 'Claude · worktree',
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

describe('COMPLETION-EARLYNOTIFY gate', () => {
  // ── t1: pending tool_use ⇒ no early fire ────────────────────────────────────
  it('t1a: HOLDS (no fire) when the adapter still has a pending response at flush (tool in flight)', () => {
    const { instance, emitted, reScheduled } = makeInstance({
      pending: armedPending({ busyEpochAtArm: 7 }),
      busyEpoch: 7,
      adapter: {
        currentTurnScope: { turnId: 'in-flight' }, // tool call mid-turn
        parsedMessages: [assistantMsg('first bubble of a still-running turn', TURN_START + 1_000)],
      },
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    // Held, not cancelled: the pending completion stays armed and a retry is scheduled.
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(reScheduled.length).toBeGreaterThan(0)
  })

  it('t1b: completionFinalAssistantEvidence gates present on turn-end (FixB) — a final bubble with a tool in flight is NOT present', () => {
    const { instance } = makeInstance({ pending: armedPending() })
    const messages = [assistantMsg('looks final but a tool is still running', TURN_START + 6_000)]

    // Tool in flight → not a turn end.
    instance.adapter.isProcessing = () => true
    expect((instance as any).completionFinalAssistantEvidence(messages, TURN_START).present).toBe(false)

    // Turn genuinely closed → present.
    instance.adapter.isProcessing = () => false
    expect((instance as any).completionFinalAssistantEvidence(messages, TURN_START).present).toBe(true)
  })

  // ── t2: approval resolved but adapter still pending ⇒ non-terminal hold ──────
  it('t2: approval-resolved idle with a pending response HOLDS non-terminally (FixA), does not fire', () => {
    const pending = armedPending({ previousStatus: 'waiting_approval' })
    const { instance, emitted, reScheduled } = makeInstance({
      pending,
      adapter: { isWaitingForResponse: true }, // auto-approve resolved, agent resumed
    })

    // Block is non-terminal so it is bounded (30s force-fire) rather than a permanent wedge...
    const block = (instance as any).getCompletedFinalizationBlock('idle', pending)
    expect(block).toEqual({ reason: 'adapter_waiting_for_response', terminal: false })

    // ...and the flush holds (no emit) while within the finalization window.
    ;(instance as any).flushCompletedDebounceIfFinalized()
    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)
    expect(instance.completedDebouncePending).not.toBeNull()
    expect(reScheduled.length).toBeGreaterThan(0)
  })

  it('t2-control: a non-approval pending response keeps its terminal hold', () => {
    const pending = armedPending({ previousStatus: 'generating' })
    const { instance } = makeInstance({ pending, adapter: { isWaitingForResponse: true } })
    const block = (instance as any).getCompletedFinalizationBlock('idle', pending)
    expect(block).toEqual({ reason: 'adapter_waiting_for_response', terminal: true })
  })

  // ── t3: genuine completion still fires exactly once ─────────────────────────
  it('t3: a genuinely-finished turn (idle, no pending, fresh final assistant) fires exactly once', () => {
    const { instance, emitted } = makeInstance({
      pending: armedPending(),
      busyEpoch: 7,
      adapter: {
        lastOutputAt: TURN_START + 4_900,
        parsedMessages: [assistantMsg('the real turn result', TURN_START + 6_000)],
      },
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()

    const completions = emitted.filter(e => e.event === 'agent:generating_completed')
    expect(completions).toHaveLength(1)
    // Clean fire — no weak blockReason.
    expect(completions[0].completionDiagnostic?.blockReason).toBeUndefined()
    expect(instance.completedDebouncePending).toBeNull()
  })

  it('t3-approval: an approval-resolved turn that is genuinely done (not pending, evidence present) still fires', () => {
    const { instance, emitted } = makeInstance({
      pending: armedPending({ previousStatus: 'waiting_approval' }),
      busyEpoch: 7,
      adapter: {
        lastOutputAt: TURN_START + 4_900,
        seq: { approvalEntrySeq: 1, lastResolvedEntrySeq: 1 }, // resolution evidence present
        parsedMessages: [assistantMsg('done after approval', TURN_START + 6_000)],
      },
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()
    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(1)
    expect(instance.completedDebouncePending).toBeNull()
  })
})

// ── t4: trace hooks record fire/hold under 'completion-gate' ───────────────────
describe('COMPLETION-EARLYNOTIFY trace hooks', () => {
  beforeEach(() => {
    // traceContent:true so the assertions can read the raw stage/blockReason strings.
    // (With traceContent:false the secret-safe sanitizer summarizes every string value
    // to `[N chars]` — that redaction is exercised by debug-trace.test.ts.)
    setDebugRuntimeConfig({
      logLevel: 'debug',
      collectDebugTrace: true,
      traceContent: true,
      traceBufferSize: 200,
      traceCategories: [],
    })
    configureDebugTraceStore()
    clearDebugTrace()
  })
  afterEach(() => {
    clearDebugTrace()
    resetDebugRuntimeConfig()
    configureDebugTraceStore()
  })

  it('t4a: a clean fire records a completion-gate "fire" trace (session-keyed, content-free)', () => {
    const { instance, emitted } = makeInstance({
      pending: armedPending(),
      busyEpoch: 7,
      adapter: { lastOutputAt: TURN_START + 4_900 },
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()
    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(1)

    const fires = getRecentDebugTrace({ category: 'completion-gate' }).filter(t => t.stage === 'fire')
    expect(fires.length).toBe(1)
    expect(fires[0].sessionId).toBe('sess-earlynotify')
    expect(fires[0].providerType).toBe('claude-cli')
    expect(fires[0].payload?.path).toBe('clean')
    // Content-free: the payload carries no message/screen text keys.
    expect(Object.keys(fires[0].payload ?? {})).not.toContain('content')
    expect(Object.keys(fires[0].payload ?? {})).not.toContain('finalSummary')
  })

  it('t4b: a held completion records a completion-gate "hold" trace', () => {
    const { instance, emitted } = makeInstance({
      pending: armedPending({ busyEpochAtArm: 7 }),
      busyEpoch: 7,
      adapter: { currentTurnScope: { turnId: 'in-flight' } },
    })

    ;(instance as any).flushCompletedDebounceIfFinalized()
    expect(emitted.filter(e => e.event === 'agent:generating_completed')).toHaveLength(0)

    const holds = getRecentDebugTrace({ category: 'completion-gate' }).filter(t => t.stage === 'hold')
    expect(holds.length).toBe(1)
    expect(holds[0].payload?.blockReason).toBe('adapter_turn_scope_active')
  })

  it('t4c: records nothing when the category is not collected', () => {
    resetDebugRuntimeConfig()
    configureDebugTraceStore()
    clearDebugTrace()

    const { instance } = makeInstance({
      pending: armedPending(),
      busyEpoch: 7,
      adapter: { lastOutputAt: TURN_START + 4_900 },
    })
    ;(instance as any).flushCompletedDebounceIfFinalized()

    expect(getRecentDebugTrace({ category: 'completion-gate' })).toHaveLength(0)
  })
})
