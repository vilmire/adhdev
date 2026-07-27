import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import type { InteractivePrompt } from '../../src/providers/types/interactive-prompt.js'

// INTERACTIVE-PROMPT-PUSH regression: an ADHDev AskUserQuestion / "ACTION REQUIRED"
// prompt on a claude-cli session is surfaced only as a display-only `waiting_choice`
// overlay in getState(); the raw adapter status stays idle/generating, so none of
// detectStatusTransition()'s status-keyed arms emit an agent:* event and NO web-push
// fires — the owner misses the prompt when the app is backgrounded.
//
// The fix (mission f1d25e11) emits exactly one agent:waiting_choice on ENTRY into the
// prompt state — a DISTINCT event from agent:waiting_approval, because a multi-choice
// QUESTION is answered with mesh_answer_question, NOT mesh_approve. It carries the FULL
// InteractivePrompt payload (promptId + questions + options) plus a modalMessage/
// modalButtons projection for the server push path. It is edge-triggered (does not
// re-fire on identical ticks), does not fire against a genuine approval modal (that
// arm emits agent:waiting_approval and this arm yields — the two are mutually
// exclusive), and resets cleanly when the prompt clears so a later completion still
// emits agent:generating_completed.

type Emitted = {
  event: string
  modalMessage?: string
  modalButtons?: string[]
  interactivePrompt?: InteractivePrompt
  promptId?: string
  multiSelect?: boolean
}

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
      events.push({
        event: e.event,
        modalMessage: e.modalMessage,
        modalButtons: e.modalButtons,
        interactivePrompt: e.interactivePrompt,
        promptId: e.promptId,
        multiSelect: e.multiSelect,
      })
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
  it('emits exactly one agent:waiting_choice carrying the FULL prompt payload on entry (NOT waiting_approval)', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    setAdapterStatus(IDLE_WITH_PROMPT)
    detect()

    // A question must NOT be surfaced as an approval — that would drive the coordinator
    // to mesh_approve, which cannot answer a question (mission f1d25e11).
    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(0)

    const choices = events.filter((e) => e.event === 'agent:waiting_choice')
    expect(choices.length).toBe(1)
    // Push-notification projection (server push path reads these).
    expect(choices[0].modalMessage).toBe('Scope: Which scope should I use?')
    expect(choices[0].modalButtons).toEqual(['unicast', 'broadcast', 'system'])
    // Authoritative structured payload the coordinator renders + answers against.
    expect(choices[0].promptId).toBe('ask-user-1')
    expect(choices[0].multiSelect).toBe(false)
    expect(choices[0].interactivePrompt).toBeTruthy()
    expect(choices[0].interactivePrompt?.promptId).toBe('ask-user-1')
    expect(choices[0].interactivePrompt?.questions[0].question).toBe('Which scope should I use?')
    expect(choices[0].interactivePrompt?.questions[0].options.map((o) => o.label))
      .toEqual(['unicast', 'broadcast', 'system'])
  })

  it('does NOT re-emit on subsequent identical ticks while the same prompt is showing', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    setAdapterStatus(IDLE_WITH_PROMPT)
    detect()
    detect() // same prompt, no status change — must be a no-op
    detect()

    const choices = events.filter((e) => e.event === 'agent:waiting_choice')
    expect(choices.length).toBe(1)
  })

  it('waiting_choice and waiting_approval are mutually exclusive: a genuine approval modal wins, no waiting_choice fires', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    // A real approval modal AND an interactive prompt on the same frame: the
    // waiting_approval arm emits for the modal — the interactive-prompt path must
    // NOT ALSO emit a waiting_choice for the same tick (owner requirement: the two
    // never both trigger).
    setAdapterStatus({
      status: 'waiting_approval',
      approvalEntrySeq: 1,
      activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'] },
      activeInteractivePrompt: PROMPT,
    })
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    const choices = events.filter((e) => e.event === 'agent:waiting_choice')
    expect(approvals.length).toBe(1)
    expect(choices.length).toBe(0)
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

  it('rc.19 core: an FSM picker modal (kind picker, raw waiting_approval) with a captured prompt emits waiting_choice — NEVER waiting_approval', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    // The exact rc.19 misroute input: the claude FSM sits in its picker state
    // (statusForState maps ANY modal to 'approval'), so the adapter reports raw
    // waiting_approval with kind='picker' buttons Continue/Abort/… while the
    // interactive prompt capture holds the question. This must surface as ONE
    // agent:waiting_choice carrying the promptId — and must NOT enter the
    // approval flow (mesh_approve cannot answer a question).
    setAdapterStatus({
      status: 'waiting_approval',
      approvalEntrySeq: 7,
      activeModal: {
        message: 'Picker open',
        buttons: ['Continue', 'Abort', 'Type something.', 'Chat about this'],
        kind: 'picker',
      },
      activeInteractivePrompt: PROMPT,
    })
    detect()

    const approvals = events.filter((e) => e.event === 'agent:waiting_approval')
    expect(approvals.length).toBe(0)

    const choices = events.filter((e) => e.event === 'agent:waiting_choice')
    expect(choices.length).toBe(1)
    expect(choices[0].promptId).toBe('ask-user-1')
    expect(choices[0].interactivePrompt?.promptId).toBe('ask-user-1')

    // A repeat tick of the same picker frame re-emits nothing (edge-triggered).
    detect()
    expect(events.filter((e) => e.event === 'agent:waiting_choice').length).toBe(1)
    expect(events.filter((e) => e.event === 'agent:waiting_approval').length).toBe(0)
  })

  it('picker answer resume: the approval_resolving transient emits no spurious approval, and a later genuine approval still emits', () => {
    const { instance, events, setAdapterStatus } = makeInstance()
    const detect = (instance as any).detectStatusTransition.bind(instance)

    // Enter the picker (fires waiting_choice once).
    setAdapterStatus({
      status: 'waiting_approval',
      approvalEntrySeq: 7,
      activeModal: { message: 'Picker open', buttons: ['Continue', 'Abort'], kind: 'picker' },
      activeInteractivePrompt: PROMPT,
    })
    detect()
    expect(events.filter((e) => e.event === 'agent:waiting_choice').length).toBe(1)

    // The answer lands: the FSM drains through approval_resolving — raw
    // waiting_approval with NO modal — while the held prompt clears on its own
    // grace. This transient is the picker resolving, NOT a fresh consent: no
    // agent:waiting_approval (with an empty modal) may fire.
    setAdapterStatus({ status: 'waiting_approval', activeModal: null, activeInteractivePrompt: null })
    detect()
    expect(events.filter((e) => e.event === 'agent:waiting_approval').length).toBe(0)

    // The turn resumes generating on the SAME attempt — no new events at all.
    setAdapterStatus({ status: 'generating', activeModal: null, activeInteractivePrompt: null })
    detect()
    expect(events.filter((e) => e.event === 'agent:waiting_approval').length).toBe(0)
    expect(events.filter((e) => e.event === 'agent:waiting_choice').length).toBe(1)

    // A subsequent GENUINE approval (kind approval) still flows through the
    // approval arm unchanged.
    setAdapterStatus({
      status: 'waiting_approval',
      approvalEntrySeq: 8,
      activeModal: { message: 'Allow Bash command?', buttons: ['Yes', 'No'], kind: 'approval' },
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

    const choices = events.filter((e) => e.event === 'agent:waiting_choice')
    // One on the first entry, one on the re-entry after the clear.
    expect(choices.length).toBe(2)
  })
})
