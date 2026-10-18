// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import i18n from 'i18next'
import AssistantExecutionControls from '../../src/components/dashboard/AssistantExecutionControls'

const roster = vi.hoisted(() => ({ ides: [] as any[], connectionStates: { daemon: 'connected' } as Record<string, string> }))
vi.mock('../../src/compat', () => ({ useDaemons: () => roster }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement
const buttons = ['Always allow', 'Yes', 'No']
const approval = { source: 'provider_modal', type: 'tool_permission', evidence: 'live', lifecycle: 'pending', resolvedAt: null,
    modalKey: 'modal-one', attemptId: 'attempt-one', generation: 7, actionable: true, sessionId: 'worker', meshId: 'mesh', buttons }
const choices = buttons.map(button => ({ meshId: 'mesh', targetSessionId: 'worker', action: button === 'No' ? 'reject' : 'approve', button, modalIdentity: 'exact-modal', label: 'Worker', message: 'Write file?' }))
const state = (overrides = {}) => ({ success: true, executionEnabled: true, executionAvailable: true, restriction: 'enforced', choices,
    limitations: 'Local PTY provider permissions only. Staged writes require owner Inbox ratification.', ...overrides })
const worker = (resource: any = approval) => ({ daemonId: 'daemon', machineId: 'daemon', sessionId: 'worker', transport: 'pty', hostname: 'Mac',
    surfaceHidden: true, muted: true, status: 'waiting_approval', activeChat: { title: 'Worker task', status: 'waiting_approval', providerApproval: resource, activeModal: { message: 'Write file?', buttons } } })
const success = () => ({ success: true, ownerActionExpiresAt: Date.now() + 120000 })
const sender = (answer: any = success()) => vi.fn(async (_daemon: string, command: string) => command === 'send_chat' ? answer : state())
beforeEach(() => { roster.ides = [worker()]; roster.connectionStates = { daemon: 'connected' } })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); await i18n.changeLanguage('en') })
async function render(sendCommand: any, props = {}) {
    if (!root) { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) }
    await act(async () => root!.render(<AssistantExecutionControls daemonId="daemon" sessionId="assistant" status="idle" sendCommand={sendCommand} {...props} />))
}
async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === label)!
    expect(button).toBeTruthy(); await act(async () => button.click())
}
async function open(send: any) { await render(send); await click('Assistant actions: on') }
async function choose(label = 'Yes') {
    const input = [...container.querySelectorAll('label')].find(el => el.textContent === label)!.querySelector('input')!
    await act(async () => input.click())
}
// The send button is hidden while there is no request to answer (2026-10-18
// panel restyle); hidden counts as "cannot send", the property these tests check.
const sendButton = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Send response to assistant') ?? ({ disabled: true } as HTMLButtonElement)
const labels = () => [...container.querySelectorAll('label')].map(el => el.textContent)

it('separates real session/machine/request and provider options, puts the narrow option first without selecting it', async () => {
    const send = sender(); await open(send)
    expect(labels()).toEqual(['Yes', 'No', 'Always allow'])
    expect(container.querySelector('input:checked')).toBeNull()
    expect(sendButton().disabled).toBe(true)
    expect([...container.querySelectorAll('dt')].map(el => el.textContent)).toEqual(['Session', 'Machine', 'Request'])
    expect([...container.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['worker', 'Mac', 'Write file?'])
    expect(container.querySelector('dl')?.className).toContain('gap-x-3')
    expect(container.querySelector('[role=group]')?.className).toContain('gap-2')
    expect(container.querySelector('[role=dialog]')?.className).toContain('overflow-y-auto')
    expect(container.textContent).not.toMatch(/PTY|enforced|staged|ratification|prompt_only/i)
    expect(send.mock.calls.some(call => call[1] === 'send_chat')).toBe(false)
    await choose(); await click('Send response to assistant')
    expect(send).toHaveBeenCalledWith('daemon', 'send_chat', { targetSessionId: 'assistant', message: 'Approve the selected permission for Worker.',
        assistantOwnerAction: { meshId: 'mesh', targetSessionId: 'worker', action: 'approve', button: 'Yes' }, expectedOwnerModalIdentity: 'exact-modal' })
    expect(send.mock.calls.some(call => call[1] === 'resolve_action')).toBe(false)
    expect(container.querySelector('[role=status]')?.textContent).toContain('does not renew automatically')
    expect(container.querySelector('[role=status]')?.textContent).toContain('not yet confirmed')
    // Consent issuance does not mean the provider has resolved the permission.
    expect(labels()).toContain('Yes')
})
it('keeps persistent permission an explicit choice and never saves an auto-approval setting', async () => {
    const send = sender(); await open(send); await choose('Always allow')
    expect(container.textContent).toContain(i18n.t('approval.alwaysAllowWarning'))
    expect(send.mock.calls.some(call => call[1] === 'send_chat')).toBe(false)
    await click('Send response to assistant')
    expect(send).toHaveBeenCalledWith('daemon', 'send_chat', expect.objectContaining({ assistantOwnerAction: expect.objectContaining({ button: 'Always allow' }) }))
    expect(send.mock.calls.every(call => ['assistant_execution_state', 'send_chat'].includes(call[1]))).toBe(true)
})
it('retains the exact rejection and owner execution toggle contracts', async () => {
    let enabled = true
    const send = vi.fn(async (_daemon: string, command: string, args: any) => {
        if (command === 'assistant_execution_settings') { enabled = args.enabled; return { success: true } }
        if (command === 'send_chat') return success()
        return state({ executionEnabled: enabled, executionAvailable: enabled })
    })
    await open(send); await click('Turn assistant actions off')
    expect(send).toHaveBeenCalledWith('daemon', 'assistant_execution_settings', { enabled: false })
    // Off: no request form at all, so nothing can be consented to.
    expect(container.querySelector('fieldset')).toBeNull()
    expect(container.textContent).toContain('Off. Turn it on')
    await click('Turn assistant actions on'); await choose('No'); await click('Send response to assistant')
    expect(send).toHaveBeenCalledWith('daemon', 'send_chat', expect.objectContaining({ assistantOwnerAction: expect.objectContaining({ action: 'reject', button: 'No' }) }))
})
it('never enables consent when execution is unavailable even with live roster evidence', async () => {
    const send = vi.fn(async () => state({ executionAvailable: false, restriction: 'prompt_only' }))
    await render(send)
    // A CLI that can never act (prompt_only): the control is not shown at all,
    // so there is no request form and no send button to consent with.
    expect(container.querySelector('.assistant-execution-toggle')).toBeNull()
    expect(container.querySelector('fieldset')).toBeNull()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Send response to assistant')).toBe(false)
    expect(container.textContent).not.toContain('prompt_only')
})
it('excludes unavailable, status-only, setup/trust, resolved, mismatched and missing resources', async () => {
    const send = sender(); await open(send)
    for (const resource of [null, undefined, { ...approval, evidence: 'unavailable' }, { ...approval, evidence: 'cached' },
        { ...approval, source: 'status_only' }, { ...approval, type: 'provider_setup' }, { ...approval, type: 'directory_trust' },
        { ...approval, lifecycle: 'resolved' }, { ...approval, resolvedAt: 123 }, { ...approval, sessionId: 'other' },
        { ...approval, modalKey: null }, { ...approval, buttons: [] }]) {
        roster.ides = [worker(resource)]; if (resource === undefined) roster.ides[0].activeChat.providerApproval = undefined
        await render(send); expect(labels()).toEqual([]); expect(sendButton().disabled).toBe(true)
    }
    roster.ides = [worker()]; roster.connectionStates = {}; await render(send); expect(labels()).toEqual([])
    roster.connectionStates = { daemon: 'connected' }
    for (const status of ['idle', 'starting', 'waiting_choice', 'stopped']) {
        roster.ides = [worker()]; roster.ides[0].activeChat.status = status
        await render(send); expect(labels()).toEqual([])
    }
    roster.ides = [worker()]; roster.ides[0].status = 'stopped'
    await render(send); expect(labels()).toEqual([])
    roster.ides = [worker()]; roster.ides[0].activeInteractivePrompt = { promptId: 'question' }
    await render(send); expect(labels()).toEqual([])
    expect(send.mock.calls.some(call => call[1] === 'send_chat')).toBe(false)
})
it('corroborates exact live modal text and buttons and deduplicates mirrored hidden workers', async () => {
    const send = sender(); roster.ides = [worker(), worker()]; await open(send)
    expect(container.querySelectorAll('fieldset')).toHaveLength(1)
    roster.ides = [worker()]; roster.ides[0].activeChat.activeModal.message = 'Different request'
    await render(send); expect(labels()).toEqual([])
    roster.ides = [worker()]; roster.ides[0].activeChat.activeModal.buttons = []
    await render(send); expect(labels()).toEqual([])
})
it('invalidates selection on exact episode changes even if the modal text/hash stays the same', async () => {
    const send = sender(); await open(send)
    for (const change of [{ generation: 8 }, { attemptId: 'attempt-two' }, { modalKey: 'modal-two' }]) {
        await choose(); expect(sendButton().disabled).toBe(false)
        roster.ides = [worker({ ...roster.ides[0].activeChat.providerApproval, ...change })]
        await render(send); expect(sendButton().disabled).toBe(true); expect(container.querySelector('input:checked')).toBeNull()
    }
    await choose(); roster.ides = [worker({ ...approval, lifecycle: 'resolved' })]
    await render(send); expect(labels()).toEqual([])
    roster.ides = [worker()]; await render(send); expect(sendButton().disabled).toBe(true)
    expect(send.mock.calls.some(call => call[1] === 'send_chat')).toBe(false)
})
it('dismisses explicit stale/resolved refusals for that episode, but not a new generation', async () => {
    for (const answer of [{ success: false, code: 'owner_modal_selection_changed' }, { success: true, stalePrompt: true }, { success: true, alreadyResolved: true }]) {
        const send = sender(answer); await open(send); await choose(); await click('Send response to assistant')
        expect(labels()).toEqual([])
        expect(container.querySelector('[role=status]')?.textContent).toContain('changed or already ended')
        await render(send, { status: 'generating' }); expect(labels()).toEqual([])
        await render(send); expect(labels()).toEqual([])
        roster.ides = [worker({ ...approval, generation: 8 })]; await render(send)
        expect(labels()).toContain('Yes'); expect(sendButton().disabled).toBe(true)
        await act(async () => root!.unmount()); root = undefined; container.remove(); roster.ides = [worker()]
    }
})
it('false stale flags and ordinary failure do not dismiss a still-live request or expose raw errors', async () => {
    const send = sender({ success: false, stalePrompt: false, alreadyResolved: false, error: 'PTY enforced ratification' })
    await open(send); await choose(); await click('Send response to assistant')
    expect(labels()).toContain('Yes'); expect(sendButton().disabled).toBe(true)
    expect(container.querySelector('[role=status]')?.textContent).toContain('Could not authorize')
    expect(container.textContent).not.toContain('ratification')
})
it('clears selection immediately on refresh and ignores out-of-order execution-state answers', async () => {
    const pending: Array<(value: any) => void> = []
    const send = vi.fn((_daemon: string, command: string) => command === 'assistant_execution_state' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(success()))
    await render(send)
    await act(async () => pending.shift()!(state()))
    await click('Assistant actions: on')
    await act(async () => pending.shift()!(state()))
    await choose(); await click('Refresh requests')
    expect(sendButton().disabled).toBe(true); expect(labels()).toEqual([])
    await click('Refresh requests')
    const [old, newest] = pending.splice(0)
    await act(async () => newest(state()))
    await act(async () => old(state({ choices: [] })))
    expect(labels()).toContain('Yes'); expect(sendButton().disabled).toBe(true)
})
it('ignores consent completion from a previous assistant session', async () => {
    let finish: (value: any) => void = () => {}
    const send = vi.fn(async (_daemon: string, command: string) => command === 'send_chat' ? new Promise(resolve => { finish = resolve }) : state())
    await open(send); await choose(); await click('Send response to assistant')
    await render(send, { sessionId: 'new-assistant' })
    await act(async () => finish(success()))
    expect(container.querySelector('[role=status]')).toBeNull()
    expect(sendButton().disabled).toBe(true)
})
it('does not let a late execution-state answer replace the current assistant session', async () => {
    let finish: (value: any) => void = () => {}
    const send = vi.fn((_daemon: string, _command: string, args: any) => args.assistantSessionId === 'assistant'
        ? new Promise(resolve => { finish = resolve }) : Promise.resolve(state()))
    await render(send)
    await render(send, { sessionId: 'new-assistant' })
    await click('Assistant actions: on')
    await act(async () => finish(state({ executionEnabled: false, choices: [] })))
    expect(labels()).toContain('Yes')
    expect(container.querySelector('button')?.textContent).toBe('Assistant actions: on')
})
it('renders plain Korean copy and keeps all five locale permission labels complete and free of implementation jargon', async () => {
    const catalogs = ['en', 'ko', 'ja', 'zh-CN', 'es'].map(lang => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, `../../src/i18n/locales/${lang}/common.json`), 'utf8')).assistantExecution)
    for (const copy of catalogs) {
        expect(Object.keys(copy).sort()).toEqual(Object.keys(catalogs[0]).sort())
        expect(Object.values(copy).join(' ')).not.toMatch(/PTY|enforced|prompt_only|staged|ratification/i)
        expect(copy.directionSent).toContain('{{expiresAt}}')
        expect(copy.toggleLabel).toContain('{{state}}')
    }
    const ko = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../src/i18n/locales/ko/common.json'), 'utf8'))
    i18n.addResourceBundle('ko', 'common', ko, true, true); await i18n.changeLanguage('ko')
    const send = sender(); await render(send); await click('비서 작업: 켜짐')
    expect(container.textContent).toContain('선택한 응답을 비서에게 보내기')
    expect([...container.querySelectorAll('dt')].map(el => el.textContent)).toEqual(['세션', '머신', '요청 내용'])
    expect(container.textContent).not.toMatch(/PTY|enforced|ratification|Restriction:/)
})

it('binds consent to the daemon-stated provider episode and drops choices from another episode', async () => {
    const episodeChoices = choices.map(c => ({ ...c, modalKey: 'modal-one', attemptId: 'attempt-one', generation: 7 }))
    const send = vi.fn(async (_daemon: string, command: string) => command === 'send_chat' ? success() : state({ choices: episodeChoices }))
    await open(send); await choose('Yes'); await click('Send response to assistant')
    expect(send).toHaveBeenCalledWith('daemon', 'send_chat', expect.objectContaining({
        assistantOwnerAction: { meshId: 'mesh', targetSessionId: 'worker', action: 'approve', button: 'Yes' },
        expectedOwnerApprovalTarget: { modalKey: 'modal-one', attemptId: 'attempt-one', generation: 7 } }))
})
it('hides choices whose daemon-stated generation differs from the live roster episode', async () => {
    const staleChoices = choices.map(c => ({ ...c, modalKey: 'modal-one', attemptId: 'attempt-one', generation: 6 }))
    const send = vi.fn(async () => state({ choices: staleChoices }))
    await open(send)
    expect(labels()).toEqual([])
})

it('says "not supported" when an enforced assistant cannot act right now', async () => {
    const send = vi.fn(async () => state({ executionAvailable: false, restriction: 'enforced' }))
    await render(send); await click('Assistant actions: not supported')
    expect(container.textContent).toContain('On, but this assistant cannot use it')
    expect(container.querySelector('fieldset')).toBeNull()
})

it('a prompt-only CLI that can act shows the panel with a prompt-only note (2026-10-18)', async () => {
    const send = vi.fn(async () => state({ executionAvailable: true, restriction: 'prompt_only' }))
    await open(send)
    expect(container.textContent).toContain('restricted by its system prompt only')
    expect(container.querySelector('fieldset')).toBeTruthy()
})
