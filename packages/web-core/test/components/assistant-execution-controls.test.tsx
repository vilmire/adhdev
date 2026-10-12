// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AssistantExecutionControls from '../../src/components/dashboard/AssistantExecutionControls'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement
const choice = { meshId: 'mesh', targetSessionId: 'worker', action: 'approve', button: 'Accept', modalIdentity: 'exact-modal', label: 'Worker', message: 'Write file?' }
afterEach(async () => { if (root) await act(async () => root!.unmount()); container?.remove() })
async function render(sendCommand: any) {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    await act(async () => root!.render(<AssistantExecutionControls daemonId="daemon" sessionId="assistant" status="idle" sendCommand={sendCommand} />))
}
async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === label)!
    expect(button).toBeTruthy(); await act(async () => button.click())
}
it('owner controls toggle policy and send exact target/action/modal without JSON input; expiry is visible', async () => {
    let enabled = true
    const send = vi.fn(async (_daemon: string, command: string, args: any) => {
        if (command === 'assistant_execution_settings') { enabled = args.enabled; return { success: true } }
        if (command === 'send_chat') return { success: true, ownerActionExpiresAt: Date.now() + 120000 }
        return { success: true, executionEnabled: enabled, executionAvailable: enabled, restriction: 'enforced', choices: [choice], limitations: 'Local PTY permissions only.' }
    })
    await render(send); await click('Execution ON')
    expect(container.textContent).toContain('Restriction: enforced. Execution available.')
    await click('Turn execution OFF'); expect(send).toHaveBeenCalledWith('daemon', 'assistant_execution_settings', { enabled: false })
    await click('Turn execution ON')
    const select = container.querySelector('select')!
    await act(async () => { select.value = '0'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await click('Send owner direction')
    expect(send).toHaveBeenCalledWith('daemon', 'send_chat', expect.objectContaining({ targetSessionId: 'assistant',
        assistantOwnerAction: { meshId: 'mesh', targetSessionId: 'worker', action: 'approve', button: 'Accept' }, expectedOwnerModalIdentity: 'exact-modal' }))
    expect(container.querySelector('[role=status]')?.textContent).toContain('Consent expires')
    expect(container.querySelector('[role=status]')?.textContent).toContain('no automatic renewal')
})
it('prompt_only exposes its limits and cannot send an action; stale owner selections display the daemon refusal', async () => {
    let enforced = false
    const send = vi.fn(async (_daemon: string, command: string) => command === 'send_chat'
        ? { success: false, code: 'owner_modal_selection_changed' }
        : { success: true, executionEnabled: true, executionAvailable: enforced, restriction: enforced ? 'enforced' : 'prompt_only', choices: [choice], limitations: 'Remote and extension unavailable.' })
    await render(send); await click('Execution ON')
    expect(container.textContent).toContain('Restriction: prompt_only. Execution closed.')
    expect(container.querySelector('select')!.disabled).toBe(true)
    expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Send owner direction')!.disabled).toBe(true)
    enforced = true; await click('Refresh permissions')
    const select = container.querySelector('select')!
    await act(async () => { select.value = '0'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await click('Send owner direction'); expect(container.querySelector('[role=status]')?.textContent).toContain('owner_modal_selection_changed')
})
