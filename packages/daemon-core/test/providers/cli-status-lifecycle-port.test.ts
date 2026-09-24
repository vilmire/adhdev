import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { SpecCliAdapter } from '../../src/providers/spec/cli-adapter.js'
import { promptFingerprint } from '../../src/providers/provider-event-port.js'
import type { SessionEventPort } from '../../src/sessions/session-port.js'
import type { AdapterChangeCause } from '../../src/cli-adapter-types.js'
import type { InteractivePrompt } from '../../src/providers/types/interactive-prompt.js'

// Wiring-unification B2: the CLI status-transition tick is the single
// diff-and-emit point for the lifecycle port. These pin (1) status edges carry
// the REAL prev/next and the cause of the edge (question picker / auto-approve
// mask / adapter change), (2) prompt emission is fingerprint-gated so a
// re-render never re-emits, and (3) the adapter's notifyChange cause reaches
// the tick.

type Call =
  | { kind: 'status'; sessionId: string; prev: string; next: string; cause: string; providerType?: string }
  | { kind: 'modal'; sessionId: string; modal: any }
  | { kind: 'prompt'; sessionId: string; prompt: InteractivePrompt | null; transport: string | null }
  | { kind: 'providerEvent'; sessionId: string; event: any }

function recordingPort(): { port: SessionEventPort; calls: Call[] } {
  const calls: Call[] = []
  const port: SessionEventPort = {
    status: (sessionId, prev, next, cause, providerType) => { calls.push({ kind: 'status', sessionId, prev, next, cause, providerType }) },
    modal: (sessionId, modal) => { calls.push({ kind: 'modal', sessionId, modal }) },
    prompt: (sessionId, prompt, transport) => { calls.push({ kind: 'prompt', sessionId, prompt, transport }) },
    signal: () => {},
    providerEvent: (sessionId, event) => { calls.push({ kind: 'providerEvent', sessionId, event }) },
    exited: () => {},
  }
  return { port, calls }
}

const live: any[] = []

function makeInstance(initial: { lastStatus: string; adapterStatus: any }) {
  let adapterStatus: any = initial.adapterStatus
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.instanceId = 'sess-b2'
  instance.provider = { name: 'Claude', settings: {} }
  instance.workingDir = '/repo/worktree'
  instance.providerSessionId = ''
  instance.settings = { autoApprove: false }
  instance.runtimeMessages = []
  instance.lastStatus = initial.lastStatus
  instance.lastApprovalEventFingerprint = ''
  instance.lastInteractivePromptEventKey = ''
  instance.lastPromptFingerprint = ''
  instance.lastModalFingerprint = ''
  instance.generatingStartedAt = 1
  instance.generatingDebouncePending = null
  instance.generatingDebounceTimer = null
  instance.completedDebouncePending = null
  instance.completedDebounceTimer = null
  instance.suppressIdleHistoryReplay = false
  instance.autoApproveBusy = false
  instance.busyEpoch = 0
  instance.monitor = { check: () => [] }
  instance.adapter = {
    getStatus: () => adapterStatus,
    getScriptParsedStatus: () => null,
    getInteractivePromptTransport: () => (adapterStatus?.activeInteractivePrompt ? 'tui' : null),
  }
  instance.events = []
  instance.context = { emitProviderEvent: () => {} }
  instance.appendRuntimeSystemMessage = () => {}
  instance.applyProviderResponse = () => {}
  const { port, calls } = recordingPort()
  instance.setSessionEventPort(port)
  live.push(instance)
  const tick = (cause?: AdapterChangeCause) => instance.detectStatusTransition(cause)
  return { instance, calls, tick, setAdapterStatus: (s: any) => { adapterStatus = s } }
}

afterEach(() => {
  for (const instance of live.splice(0)) {
    if (instance.generatingDebounceTimer) clearTimeout(instance.generatingDebounceTimer)
    if (instance.completedDebounceTimer) clearTimeout(instance.completedDebounceTimer)
  }
})

const statusCalls = (calls: Call[]) => calls.filter((c) => c.kind === 'status')

const PROMPT: InteractivePrompt = {
  promptId: 'ask-1',
  origin: 'cli',
  providerType: 'claude-cli',
  createdAt: 1,
  questions: [
    { questionId: 'q1', question: 'Pick one', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] },
  ],
}

describe('CLI status tick → lifecycle port status edges', () => {
  it('emits the real prev/next with cause fsm_state for an FSM-driven edge', () => {
    const { calls, tick } = makeInstance({ lastStatus: 'idle', adapterStatus: { status: 'generating', activeModal: null } })
    tick('fsm_state')
    expect(statusCalls(calls)).toEqual([
      { kind: 'status', sessionId: 'sess-b2', prev: 'idle', next: 'generating', cause: 'fsm_state', providerType: 'claude-cli' },
    ])
  })

  it('labels a PTY exit edge pty_exit and a latched failure edge provider_failure', () => {
    const exit = makeInstance({ lastStatus: 'generating', adapterStatus: { status: 'stopped', activeModal: null } })
    exit.tick('pty_exit')
    expect(statusCalls(exit.calls)).toEqual([
      expect.objectContaining({ prev: 'generating', next: 'stopped', cause: 'pty_exit' }),
    ])

    const failure = makeInstance({ lastStatus: 'generating', adapterStatus: { status: 'error', errorReason: 'auth', activeModal: null } })
    failure.tick('provider_failure')
    expect(statusCalls(failure.calls)).toEqual([
      expect.objectContaining({ prev: 'generating', next: 'error', cause: 'provider_failure' }),
    ])
  })

  it('labels the question-picker fold waiting_approval → waiting_choice question_picker, prompt first', () => {
    const { calls, tick } = makeInstance({
      lastStatus: 'idle',
      adapterStatus: {
        status: 'waiting_approval',
        activeModal: { message: 'Pick one', buttons: ['a', 'b'], kind: 'picker' },
        activeInteractivePrompt: PROMPT,
      },
    })
    tick('prompt_captured')
    expect(statusCalls(calls)).toEqual([
      expect.objectContaining({ prev: 'idle', next: 'waiting_choice', cause: 'question_picker' }),
    ])
    const kinds = calls.map((c) => c.kind)
    expect(kinds.indexOf('prompt')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('prompt')).toBeLessThan(kinds.indexOf('status'))
    expect(calls.find((c) => c.kind === 'prompt')).toEqual(
      expect.objectContaining({ prompt: PROMPT, transport: 'tui' }),
    )
  })

  it('labels an auto-approved consent (masked to generating) auto_approve_mask and hides the modal', () => {
    const { instance, calls, tick } = makeInstance({
      lastStatus: 'idle',
      adapterStatus: { status: 'waiting_approval', activeModal: { message: 'Allow Bash?', buttons: ['Yes', 'No'], kind: 'approval' } },
    })
    // F2 (2026-09-25): the mask now exempts a session where no turn has EVER
    // started this boot (adapter.currentTurnTaskId unset) — that startup-only
    // case is covered by status-transition-startup-mask-turn-evidence.test.ts.
    // This test is about a MID-SESSION consent (the ordinary blip-protection
    // case the mask still owns unconditionally), so stamp currentTurnTaskId to
    // say a real turn is/was underway, exactly like a genuine onTurnStarted.
    instance.adapter.currentTurnTaskId = 'task-mid-session'
    instance.maybeAutoApproveStatus = () => true
    tick('fsm_state')
    expect(statusCalls(calls)).toEqual([
      expect.objectContaining({ prev: 'idle', next: 'generating', cause: 'auto_approve_mask' }),
    ])
    expect(calls.some((c) => c.kind === 'modal')).toBe(false)
  })

  it('labels the auto-approve idle hold (raw idle held as generating) auto_approve_mask', () => {
    const { instance, calls, tick } = makeInstance({ lastStatus: 'idle', adapterStatus: { status: 'idle', activeModal: null } })
    // F2 (2026-09-25): same as above — this is the mid-session idle-hold case,
    // not the startup-with-no-turn exemption, so stamp currentTurnTaskId.
    instance.adapter.currentTurnTaskId = 'task-mid-session'
    // The 2 s post-fire busy window; the gate itself is stubbed so a disabled
    // auto-approve mode does not reset the window before the hold is read.
    instance.maybeAutoApproveStatus = () => false
    instance.autoApproveBusy = true
    tick('fsm_state')
    expect(statusCalls(calls)).toEqual([
      expect.objectContaining({ prev: 'idle', next: 'generating', cause: 'auto_approve_mask' }),
    ])
  })

  it('emits nothing for a tick without a status edge, and nothing at all without a port', () => {
    const { instance, calls, tick } = makeInstance({ lastStatus: 'generating', adapterStatus: { status: 'generating', activeModal: null } })
    tick('fsm_state')
    expect(calls).toEqual([])

    instance.setSessionEventPort(null)
    instance.lastStatus = 'idle'
    tick('fsm_state')
    expect(instance.lastStatus).toBe('generating')
    expect(calls).toEqual([])
  })

  it('emits a consent modal once and clears it with null', () => {
    const modal = { message: 'Allow Bash?', buttons: ['Yes', 'No'], kind: 'approval' }
    const { calls, tick, setAdapterStatus } = makeInstance({ lastStatus: 'waiting_approval', adapterStatus: { status: 'waiting_approval', activeModal: modal } })
    tick('fsm_state')
    tick('fsm_state')
    setAdapterStatus({ status: 'waiting_approval', activeModal: null })
    tick('fsm_state')
    const modals = calls.filter((c) => c.kind === 'modal') as Array<{ modal: any }>
    expect(modals).toHaveLength(2)
    expect(modals[0].modal).toEqual(expect.objectContaining({ id: 'sess-b2', activeModal: modal }))
    expect(modals[1].modal).toBeNull()
  })
})

describe('CLI status tick → prompt fingerprint dedupe', () => {
  it('fingerprint is promptId + one multiSelect bit per question', () => {
    expect(promptFingerprint(null)).toBe('')
    expect(promptFingerprint(PROMPT)).toBe('ask-1:0')
    expect(promptFingerprint({ ...PROMPT, questions: [{ ...PROMPT.questions[0], multiSelect: true }, { ...PROMPT.questions[0] }] })).toBe('ask-1:10')
  })

  it('a re-render of the same prompt never re-emits; an in-place multiSelect upgrade and a clear do', () => {
    const prompt: InteractivePrompt = JSON.parse(JSON.stringify(PROMPT))
    const { calls, tick, setAdapterStatus } = makeInstance({
      lastStatus: 'idle',
      adapterStatus: { status: 'idle', activeModal: null, activeInteractivePrompt: prompt },
    })
    tick('prompt_captured')
    // Re-render: same prompt object, new option text, fresh pokes.
    prompt.questions[0].options[0].label = 'a (focused)'
    tick('fsm_state')
    tick('prompt_captured')
    expect(calls.filter((c) => c.kind === 'prompt')).toHaveLength(1)

    // In-place upgrade (same promptId, same object) — what the Claude TUI does.
    prompt.questions[0].multiSelect = true
    tick('prompt_updated')
    tick('prompt_updated')
    // Cleared.
    setAdapterStatus({ status: 'idle', activeModal: null, activeInteractivePrompt: null })
    tick('prompt_cleared')
    tick('fsm_state')

    const prompts = calls.filter((c) => c.kind === 'prompt') as Array<{ prompt: InteractivePrompt | null; transport: string | null }>
    expect(prompts.map((p) => (p.prompt ? promptFingerprint(p.prompt) : null))).toEqual(['ask-1:0', 'ask-1:1', null])
    expect(prompts.map((p) => p.transport)).toEqual(['tui', 'tui', null])
  })
})

describe('adapter notifyChange → tick', () => {
  function makeAdapter(extra: Record<string, unknown> = {}) {
    const adapter = Object.create(SpecCliAdapter.prototype) as any
    adapter.cliType = 'test-cli'
    adapter.spec = {}
    adapter.activeInteractivePrompt = null
    adapter.interactivePromptTransport = null
    adapter.statusCallback = null
    adapter.changeCallback = null
    adapter.runtimeSettings = {}
    adapter.driver = { snapshot: () => '' }
    Object.assign(adapter, extra)
    return adapter
  }

  it('each site reports its cause to setOnChange and still pokes the legacy status callback', () => {
    const adapter = makeAdapter()
    const causes: AdapterChangeCause[] = []
    let legacyPokes = 0
    adapter.setOnChange((cause: AdapterChangeCause) => causes.push(cause))
    adapter.setOnStatusChange(() => { legacyPokes++ })

    adapter.handleEvent({ kind: 'state_changed', state: { id: 's', label: 'idle', title: null, status: 'idle' }, modal: null })
    adapter.handleEvent({ kind: 'exit', exit_code: 0 })
    adapter.latchAuthBillingFailure({ reason: 'auth', message: 'login required' }, 'test')

    expect(causes).toEqual(['fsm_state', 'pty_exit', 'provider_failure'])
    expect(legacyPokes).toBe(3)
  })

  it('the kimi wire refresh reports prompt_cleared when its held prompt disappears', () => {
    const adapter = makeAdapter({
      cliType: 'kimi',
      spec: { interactive_prompts: { scheme: 'kimi_wire' } },
      activeInteractivePrompt: { ...PROMPT, promptId: 'kimi-1' },
      latestState: { id: 'idle', label: 'idle', title: null, status: 'idle' },
    })
    const causes: AdapterChangeCause[] = []
    adapter.setOnChange((cause: AdapterChangeCause) => causes.push(cause))
    expect(adapter.getInteractivePromptTransport()).toBe('wire')
    adapter.refreshWirePendingQuestion()
    expect(causes).toEqual(['prompt_cleared'])
    expect(adapter.getInteractivePromptTransport()).toBeNull()
  })

  it('init wires setOnChange (not setOnStatusChange) and the cause lands on the emitted edge', async () => {
    const { port, calls } = recordingPort()
    let onChange: ((cause: AdapterChangeCause) => void) | null = null
    let legacyRegistered = false
    let adapterStatus: any = { status: 'generating', activeModal: null }
    const instance = Object.create(CliProviderInstance.prototype) as any
    Object.assign(instance, {
      type: 'claude-cli', instanceId: 'sess-init', provider: { name: 'Claude', settings: {} },
      workingDir: '/repo', providerSessionId: '', runtimeMessages: [], lastStatus: 'generating',
      lastApprovalEventFingerprint: '', lastInteractivePromptEventKey: '', lastPromptFingerprint: '',
      lastModalFingerprint: '', lifecyclePort: null, generatingStartedAt: 1, generatingDebouncePending: null,
      generatingDebounceTimer: null, completedDebouncePending: null, completedDebounceTimer: null,
      suppressIdleHistoryReplay: false, autoApproveBusy: false, busyEpoch: 0, events: [],
      monitor: { check: () => [], updateConfig: () => {} },
      adapter: {
        getStatus: () => adapterStatus,
        getScriptParsedStatus: () => null,
        setOnChange: (cb: any) => { onChange = cb },
        setOnStatusChange: () => { legacyRegistered = true },
        spawn: async () => {},
        getRuntimeMetadata: () => null,
      },
    })
    instance.enforceFreshSessionLaunchIfNeeded = async () => {}
    instance.applyInitialThinkingLevelViaControl = async () => {}
    instance.maybeAppendRuntimeRecoveryMessage = () => {}
    instance.appendRuntimeSystemMessage = () => {}
    instance.applyProviderResponse = () => {}
    live.push(instance)

    await instance.init({ settings: {}, lifecycle: port, emitProviderEvent: () => {} })
    expect(legacyRegistered).toBe(false)
    expect(onChange).toBeTypeOf('function')

    adapterStatus = { status: 'stopped', activeModal: null }
    onChange!('pty_exit')
    expect(statusCalls(calls)).toEqual([
      { kind: 'status', sessionId: 'sess-init', prev: 'generating', next: 'stopped', cause: 'pty_exit', providerType: 'claude-cli' },
    ])
  })
})
