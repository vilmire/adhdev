// @vitest-environment jsdom
/**
 * A message sent while the assistant/pty session has no session id yet (still being created) is not
 * sent into the void: handleSendChat returns false (the composer keeps the text) and says why.
 */
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useDashboardConversationCommands } from '../../src/hooks/useDashboardConversationCommands'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function mount(conv: any) {
    const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true, sent: true })
    let latest: any = null
    function Harness() {
        latest = useDashboardConversationCommands({ sendDaemonCommand, activeConv: conv, setActionLogs: () => {}, isStandalone: false })
        return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Harness />))
    return { sendDaemonCommand, get: () => latest, unmount: () => act(() => root.unmount()) }
}

describe('handleSendChat during session startup', () => {
    it('keeps the text and reports not-ready for a pty session without a session id', async () => {
        const h = mount({ tabKey: 't', routeId: 'd:', daemonId: 'd', transport: 'pty', status: 'starting' })
        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleSendChat('hello') })
        expect(accepted).toBe(false)
        expect(h.sendDaemonCommand).not.toHaveBeenCalled()
        expect(h.get().sendFeedbackMessage).toMatch(/starting up/i)
        h.unmount()
    })

    it('sends normally once the session id exists', async () => {
        const h = mount({ tabKey: 't', routeId: 'd:s1', daemonId: 'd', sessionId: 's1', transport: 'pty', status: 'idle' })
        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleSendChat('hello') })
        expect(accepted).toBe(true)
        expect(h.sendDaemonCommand.mock.calls.some(c => c[1] === 'send_chat')).toBe(true)
        h.unmount()
    })
})
