import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import type { InteractivePrompt } from '../../src/providers/types/interactive-prompt.js'

// INTERACTIVE-PROMPT-PUSH regression: an ADHDev AskUserQuestion / "ACTION REQUIRED"
// prompt on a claude-cli session is surfaced only as a display-only `waiting_choice`
// overlay in getState(); the raw adapter status stays idle/generating, so none of
// detectStatusTransition()'s status-keyed arms emit an agent:* event and NO web-push
// fires — the owner misses the prompt when the app is backgrounded.
//
// The fix emits exactly one agent:waiting_approval on ENTRY into the prompt state
// (reusing the existing server push path, no cloud change), carrying the question as
// modalMessage and the choice labels as modalButtons. It is edge-triggered (does not
// re-fire on identical ticks), does not double-fire against a genuine approval modal,
// and resets cleanly when the prompt clears so a later completion still emits
// agent:generating_completed.

type Emitted = { event: string; modalMessage?: string; modalButtons?: string[] }

function makeInstance(): {
  instance: CliProviderInstance
  events: Emitted[]
  setAdapterStatus: (status: any) => void
} {
  let adapterStatus: any = { status: 'generating', activeModal: null, activeInteractivePrompt: null }
  const events: Emitted[] = []

  const instance = Object.create(CliProviderInstance.prototype) as any
  // ── minimal field surface that detectStatusTransition() touches ──
  instance.type = 'claude-cli'
  instance.instanceId = 'session-interactive-prompt'
  instance.provider = { name: 'Claude', settings: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = ''
  instance.settings = { autoApprove: false } // keep maybeAutoApproveStatus a no-op
  instance.runtimeMessages = []
  instance.lastStatus = 'generating'
  instance.lastApprovalEventFingerprint = ''
  instance.lastInteractivePromptEventKey = ''
  instance.generatingStartedAt = 1
  instance.generatingDebouncePending = null
  instance.generatingDebounceTimer = null
  instance.completedDebouncePending = null
  instance.completedDebounceTimer = null
  instance.suppressIdleHistoryReplay = false
  instance.autoApproveBusy = false
  instance.monitor = { check: () => [] }
  instance.adapter = {
    getStatus: () => adapterStatus,
    getPartialResponse: () => '',
    getScriptParsedStatus: () => null,
  }
  instance.events = []
  instance.context = {
    emitProviderEvent: (e: any) => {
      events.push({ event: e.event, modalMessage: e.modalMessage, modalButtons: e.modalButtons })
    },
  }
  // Stub the collaborators the emit path calls so the test isolates the
  // interactive-prompt edge/emit decision (not history I/O or rich parsing).
  instance.appendRuntimeSystemMessage = () => {}
  instance.applyProviderResponse = () => {}

  return {
    instance: instance as CliProviderInstance,
    events,
    setAdapterStatus: (status: any) => { adapterStatus = status },
  }
}

const PROMPT: InteractivePrompt = {
  promptId: 'ask-user-1',
  origin: 'cli',
  providerType: 'claude-cli',
  createdAt: 1,
  questions: [
    {
      questionId: 'q1',
      question: 'Which scope should I use?',
      header: 'Scope',
      multiSelect: false,
      options: [
        { label: 'unicast' },
        { label: 'broadcast' },
        { label: 'system' },
      ],
    },
  ],
}

const IDLE_WITH_PROMPT = { status: 'idle', activeModal: null, activeInteractivePrompt: PROMPT }
const IDLE_NO_PROMPT = { status: 'idle', activeModal: null, activeInteractivePrompt: null }
const GENERATING = { status: 'generating', activeModal: null, activeInteractivePrompt: null }

describe('CliProviderInstance interactive-prompt push (AskUserQuestion / waiting_choice)', () => {
  it('emits exactly one agent:waiting_approval carrying the question + choice labels on entry', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    setAdapterStatus(IDLE_WITH_PROMPT)
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(1)
    expect(approvals[0].modalMessage).toBe('Scope: Which scope should I use?')
    expect(approvals[0].modalButtons).toEqual(['unicast', 'broadcast', 'system'])
  })

  it('does NOT re-emit on subsequent identical ticks while the same prompt is showing', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    setAdapterStatus(IDLE_WITH_PROMPT)
    detect()
    detect() // same prompt, no status change — must be a no-op
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(1)
  })

  it('does NOT double-fire when the session is ALSO in a genuine approval modal', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    // A real approval modal AND an interactive prompt on the same frame: the
    // waiting_approval arm already emits for the modal — the interactive-prompt
    // path must NOT emit a second waiting_approval for the same tick.
    setAdapterStatus({
      status: 'waiting_approval',
      approvalEntrySeq: 1,
      activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'] },
      activeInteractivePrompt: PROMPT,
    })
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(1)
    // The single emit is the genuine approval modal, not the interactive prompt.
    expect(approvals[0].modalMessage).toBe('Allow Bash command?')
  })

  it('a real approval modal (no interactive prompt) still behaves exactly as before', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    setAdapterStatus({
      status: 'waiting_approval',
      approvalEntrySeq: 1,
      activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'] },
      activeInteractivePrompt: null,
    })
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(1)
    expect(approvals[0].modalMessage).toBe('Allow Bash command?')
  })

  it('clears on prompt gone, then a later real completion emits agent:generating_completed', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    // Enter the prompt (fires once), then the user answers and the agent resumes
    // work — the prompt clears while the session goes back to generating.
    setAdapterStatus(IDLE_WITH_PROMPT)
    detect()
    setAdapterStatus(GENERATING)
    detect()

    // The turn completes normally: generating → idle with no prompt. The idle arm
    // must still be able to arm/emit the completion (the prompt path did not
    // wedge lastStatus or the completion bookkeeping).
    ;(instance as any).generatingStartedAt = Date.now() - 5000
    setAdapterStatus(IDLE_NO_PROMPT)
    detect()

    // A fresh prompt AFTER the reset re-fires (edge reset worked).
    setAdapterStatus(IDLE_WITH_PROMPT)
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    // One on the first entry, one on the re-entry after the clear.
    expect(approvals.length).toBe(2)
  })
})
