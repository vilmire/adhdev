import { describe, expect, it, vi } from 'vitest'
import { installTopModalEscapeHandler } from '../../src/utils/modal-escape'

type Listener = { fn: (event: FakeKeyEvent) => void; capture: boolean }

interface FakeKeyEvent {
    key: string
    propagationStopped: boolean
    stopPropagation: () => void
}

function createKeyEvent(key: string): FakeKeyEvent {
    return {
        key,
        propagationStopped: false,
        stopPropagation() { this.propagationStopped = true },
    }
}

/**
 * Minimal window stand-in reproducing the DOM listener ordering relevant here:
 * capture-phase listeners run before bubble-phase listeners, and a stopped
 * event never reaches the bubble phase.
 */
function createFakeWindow() {
    const listeners: Listener[] = []
    return {
        listeners,
        addEventListener(_type: string, fn: (event: FakeKeyEvent) => void, capture = false) {
            listeners.push({ fn, capture: capture === true })
        },
        removeEventListener(_type: string, fn: (event: FakeKeyEvent) => void) {
            const index = listeners.findIndex(listener => listener.fn === fn)
            if (index >= 0) listeners.splice(index, 1)
        },
        dispatchKeyDown(event: FakeKeyEvent) {
            for (const listener of [...listeners]) {
                if (listener.capture && !event.propagationStopped) listener.fn(event)
            }
            for (const listener of [...listeners]) {
                if (!listener.capture && !event.propagationStopped) listener.fn(event)
            }
        },
    }
}

// RC32: the mesh overview DetailModal stacks above DashboardMeshGraphDialog,
// which registered its own bubble-phase window Escape listener first. A bubble
// listener in the child would fire AFTER the parent already closed, tearing
// down both levels with one keypress.
describe('installTopModalEscapeHandler', () => {
    it('closes only the top modal level when a parent shell also listens for Escape', () => {
        const fakeWindow = createFakeWindow()
        // Parent shell (DashboardMeshGraphDialog) — bubble phase, registered first.
        const parentClose = vi.fn()
        fakeWindow.addEventListener('keydown', (event: FakeKeyEvent) => {
            if (event.key === 'Escape') parentClose()
        })
        // Child modal (DetailModal) via the shared handler.
        const childClose = vi.fn()
        installTopModalEscapeHandler(fakeWindow as unknown as Window, childClose)

        fakeWindow.dispatchKeyDown(createKeyEvent('Escape'))

        expect(childClose).toHaveBeenCalledTimes(1)
        expect(parentClose).not.toHaveBeenCalled()
    })

    it('registers in the capture phase and stops propagation', () => {
        const fakeWindow = createFakeWindow()
        installTopModalEscapeHandler(fakeWindow as unknown as Window, () => {})

        expect(fakeWindow.listeners).toHaveLength(1)
        expect(fakeWindow.listeners[0].capture).toBe(true)

        const event = createKeyEvent('Escape')
        fakeWindow.dispatchKeyDown(event)
        expect(event.propagationStopped).toBe(true)
    })

    it('ignores non-Escape keys', () => {
        const fakeWindow = createFakeWindow()
        const onClose = vi.fn()
        installTopModalEscapeHandler(fakeWindow as unknown as Window, onClose)

        fakeWindow.dispatchKeyDown(createKeyEvent('Enter'))

        expect(onClose).not.toHaveBeenCalled()
    })

    it('unregisters on cleanup', () => {
        const fakeWindow = createFakeWindow()
        const onClose = vi.fn()
        const cleanup = installTopModalEscapeHandler(fakeWindow as unknown as Window, onClose)

        cleanup()
        fakeWindow.dispatchKeyDown(createKeyEvent('Escape'))

        expect(onClose).not.toHaveBeenCalled()
        expect(fakeWindow.listeners).toHaveLength(0)
    })
})
