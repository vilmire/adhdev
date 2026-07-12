import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// ANTIGRAVITY-PREMATURE-COMPLETION-EVENT-RECUR (mission 21c15f8c).
//
// A reused-idle antigravity-cli worker session fires agent:generating_completed for a
// newly-injected task BEFORE that task's generation has even started. Live ordering
// (2026-07-12): dispatch → generating_completed → generating_started (5s AFTER the
// "completion"). Root cause: on task injection into a reused-idle session, a completion-gate
// poll runs BEFORE the new turn's onTurnStarted fires; readExternalCompletionMessages() reads
// antigravity native-history via the pin/floor fallback and returns the PRIOR turn's
// final-assistant bubble; completionHasFinalAssistantMessage accepts it (turnStartedAt 0/stale
// → fails open or passes on the prior bubble).
//
// FIX: gate acceptance of external-native completion evidence on the CURRENTLY-injected task
// having genuinely entered generating — a turn that STARTED after the injection
// (currentTurnStartedAt > meshTaskInjectedAt). Fail CLOSED pre-onTurnStarted (no completion
// before generating_started); still fire once the injected turn genuinely completes.

const PRIOR_TURN_ASSISTANT = [
  { role: 'user', content: 'prior task prompt', timestamp: 1_000 },
  { role: 'assistant', content: 'prior task final answer', timestamp: 2_000 },
]

function makeAntigravityInstance(opts: {
  meshTaskInjectedAt: number
  currentTurnStartedAt: number
  currentTurnTaskId?: string
  meshActiveTaskId?: string
  externalMessages: unknown[]
}): any {
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'antigravity-cli'
  instance.instanceId = 'sess-agy'
  instance.provider = { name: 'Antigravity', settings: {}, nativeHistory: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = '' // antigravity takes no --session-id
  instance.startedAt = 0
  instance.settings = {
    meshNodeFor: 'mesh-1',
    ...(opts.meshActiveTaskId ? { meshActiveTaskId: opts.meshActiveTaskId } : {}),
  }
  instance.meshTaskInjectedAt = opts.meshTaskInjectedAt
  instance.adapter = {
    chatMessagesOwnedExternally: true, // native-source provider
    currentTurnStartedAt: opts.currentTurnStartedAt,
    currentTurnTaskId: opts.currentTurnTaskId ?? null,
    isWaitingForResponse: false,
    currentTurnScope: null,
    isProcessing: () => false,
    getPartialResponse: () => '',
  }
  // Stub only the native-history read — the real gate + present-check run.
  instance.readExternalCompletionMessages = () => opts.externalMessages
  instance.lastVisibleAssistantSummary = () => ''
  return instance
}

describe('CliProviderInstance — ANTIGRAVITY-PREMATURE-COMPLETION gate', () => {
  it('does NOT accept the PRIOR turn native-history tail before the injected task has started generating (fails closed pre-onTurnStarted)', () => {
    // Injected at t=10_000; the only turn start on record is the PRIOR turn (t=2_000 < inject).
    // onTurnStarted for the new task has not fired → currentTurnStartedAt still predates inject.
    const instance = makeAntigravityInstance({
      meshTaskInjectedAt: 10_000,
      currentTurnStartedAt: 2_000, // prior turn's start — no new turn yet
      currentTurnTaskId: 'task-new', // forceSendMessage pre-binds this at inject time
      meshActiveTaskId: 'task-new',
      externalMessages: PRIOR_TURN_ASSISTANT,
    })

    // The gate must reject: the injected task has not begun generating.
    expect(instance.injectedTaskHasStartedGenerating()).toBe(false)
    const evidence = instance.completionFinalAssistantEvidence(null)
    expect(evidence.source).toBe('external-native')
    // present=false → no generating_completed can fire before generating_started.
    expect(evidence.present).toBe(false)
  })

  it('accepts the completion once the injected task has genuinely entered generating (rc.480/481 win preserved)', () => {
    // onTurnStarted has now fired for the injected task: currentTurnStartedAt (t=12_000)
    // POST-dates the injection (t=10_000), and the transcript tail is the CURRENT turn's
    // final assistant bubble (t=13_000 > turn start).
    const CURRENT_TURN_ASSISTANT = [
      { role: 'user', content: 'new task prompt', timestamp: 12_500 },
      { role: 'assistant', content: 'new task final answer', timestamp: 13_000 },
    ]
    const instance = makeAntigravityInstance({
      meshTaskInjectedAt: 10_000,
      currentTurnStartedAt: 12_000, // new turn started AFTER injection
      currentTurnTaskId: 'task-new',
      meshActiveTaskId: 'task-new',
      externalMessages: CURRENT_TURN_ASSISTANT,
    })

    expect(instance.injectedTaskHasStartedGenerating()).toBe(true)
    const evidence = instance.completionFinalAssistantEvidence(null)
    expect(evidence.source).toBe('external-native')
    // Genuine completion still fires.
    expect(evidence.present).toBe(true)
  })

  it('a non-mesh (no injected task) session is unaffected — plain turn-started check governs', () => {
    // No mesh task injected since boot (meshTaskInjectedAt=0): the gate falls back to the
    // plain "a turn has started" check so ad-hoc/dashboard completion is not regressed.
    const instance = makeAntigravityInstance({
      meshTaskInjectedAt: 0,
      currentTurnStartedAt: 5_000,
      externalMessages: [
        { role: 'user', content: 'chat', timestamp: 5_500 },
        { role: 'assistant', content: 'reply', timestamp: 6_000 },
      ],
    })
    delete instance.settings.meshNodeFor
    delete instance.settings.meshActiveTaskId

    expect(instance.injectedTaskHasStartedGenerating()).toBe(true)
    const evidence = instance.completionFinalAssistantEvidence(null)
    expect(evidence.present).toBe(true)
  })
})
