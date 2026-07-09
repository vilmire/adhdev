import { describe, expect, it } from 'vitest'
import { eventManager, type ToastConfig } from '../../src/managers/EventManager'

// (d) A muted conversation must skip the toast/audio channels. Mute is now
// daemon-owned: EventManager reads the `muted` flag off the owning session entry
// (fed via setIdes, mirroring the daemon status snapshot) rather than a
// per-browser localStorage set. The browser-notification and audio side effects
// are DOM-only and no-op in the node test env; the observable, deterministic
// channel here is the toast.

function collectToasts(): { toasts: ToastConfig[]; stop: () => void } {
    const toasts: ToastConfig[] = []
    const stop = eventManager.onToast(t => toasts.push(t))
    return { toasts, stop }
}

// A muted conversation is surfaced to EventManager as a session entry carrying
// muted:true (top-level session or a child session), keyed by targetSessionId.
function seedMutedSession(sessionId: string) {
    eventManager.setIdes([
        { id: sessionId, sessionId, type: 'claude-cli', muted: true } as any,
    ])
}

describe('EventManager mute suppression (daemon-owned muted flag)', () => {
    it('emits a completion toast for an unmuted conversation', () => {
        eventManager.setIdes([{ id: 'em-unmuted', sessionId: 'em-unmuted', type: 'claude-cli' } as any])
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
        seedMutedSession('em-muted')
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
        seedMutedSession('em-muted-approval')
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
