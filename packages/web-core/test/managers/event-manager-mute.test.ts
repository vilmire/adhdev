import { describe, expect, it } from 'vitest'
import { eventManager, type ToastConfig } from '../../src/managers/EventManager'
import { muteConversation } from '../../src/hooks/useMutedConversations'

// (d) A muted conversation must skip the toast/audio channels. The browser-notification
// and audio side effects are DOM-only and no-op in the node test env (guarded by
// try/catch and document checks); the observable, deterministic channel here is the toast.

function collectToasts(): { toasts: ToastConfig[]; stop: () => void } {
    const toasts: ToastConfig[] = []
    const stop = eventManager.onToast(t => toasts.push(t))
    return { toasts, stop }
}

describe('EventManager mute suppression', () => {
    it('emits a completion toast for an unmuted conversation', () => {
        const { toasts, stop } = collectToasts()
        eventManager.handleRawEvent({
            event: 'agent:generating_completed',
            timestamp: 1000,
            targetSessionId: 'em-unmuted',
            providerSessionId: 'em-unmuted',
            duration: 3,
        } as any, 'p2p')
        stop()
        expect(toasts.some(t => t.message.includes('completed'))).toBe(true)
    })

    it('suppresses the completion toast for a muted conversation', () => {
        muteConversation({ providerSessionId: 'em-muted' })
        const { toasts, stop } = collectToasts()
        eventManager.handleRawEvent({
            event: 'agent:generating_completed',
            timestamp: 2000,
            targetSessionId: 'em-muted',
            providerSessionId: 'em-muted',
            duration: 3,
        } as any, 'p2p')
        stop()
        expect(toasts.length).toBe(0)
    })

    it('suppresses the approval toast for a muted conversation', () => {
        muteConversation({ providerSessionId: 'em-muted-approval' })
        const { toasts, stop } = collectToasts()
        eventManager.handleRawEvent({
            event: 'agent:waiting_approval',
            timestamp: 3000,
            targetSessionId: 'em-muted-approval',
            providerSessionId: 'em-muted-approval',
            modalMessage: 'Run this command?',
            modalButtons: ['Run', 'Cancel'],
        } as any, 'p2p')
        stop()
        expect(toasts.length).toBe(0)
    })
})
