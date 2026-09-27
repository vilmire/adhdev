// @vitest-environment jsdom
//
// Failure toasts (UI simplification 2026-09-27): a short localized message for
// everyone, the raw daemon/transport error behind a "Details" expander.
// Opening Details pins the toast so auto-dismiss does not pull it away while
// it is being read.
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import ToastContainer from '../../../src/components/dashboard/ToastContainer'
import { BaseDaemonProvider, useBaseDaemons, type Toast } from '../../../src/context/BaseDaemonContext'
import { describeToastError, eventManager, type ToastConfig } from '../../../src/managers/EventManager'

describe('toast "Details" expander', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    let latest: Toast[] = []
    function Host({ initial }: { initial: Toast[] }) {
        const { toasts, setToasts } = useBaseDaemons()
        useEffect(() => { setToasts(initial) }, [initial, setToasts])
        latest = toasts
        return <ToastContainer toasts={toasts} onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))} />
    }

    async function render(initial: Toast[]) {
        await act(async () => {
            root.render(<BaseDaemonProvider><Host initial={initial} /></BaseDaemonProvider>)
            await Promise.resolve()
        })
    }

    it('shows only the short message; the raw error opens behind Details and pins the toast', async () => {
        await render([{ id: 1, message: "Couldn't launch Claude", type: 'warning', timestamp: 1, details: 'spawn ENOENT /usr/bin/claude' }])
        expect(container.textContent).toContain("Couldn't launch Claude")
        expect(container.textContent).not.toContain('spawn ENOENT')

        const details = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Details'))!
        expect(details.getAttribute('aria-expanded')).toBe('false')
        await act(async () => { details.click(); await Promise.resolve() })
        expect(details.getAttribute('aria-expanded')).toBe('true')
        expect(container.querySelector('pre')?.textContent).toBe('spawn ENOENT /usr/bin/claude')
        expect(latest[0].pinned).toBe(true)
    })

    it('renders no Details control when the toast has no raw detail', async () => {
        await render([{ id: 2, message: 'Nickname saved', type: 'success', timestamp: 1 }])
        expect(container.textContent).toContain('Nickname saved')
        expect(container.textContent).not.toContain('Details')
    })

    it('showErrorToast sends the short message with the raw error as details', () => {
        const seen: ToastConfig[] = []
        const unsubscribe = eventManager.onToast(toast => { seen.push(toast) })
        eventManager.showErrorToast('Provider update failed', new Error('DIGEST_MISMATCH: kimi'))
        eventManager.showErrorToast('Couldn’t stop', { error: 'session not found' })
        eventManager.showErrorToast('Same text', 'Same text')
        unsubscribe()
        expect(seen[0]).toMatchObject({ message: 'Provider update failed', type: 'warning', details: 'DIGEST_MISMATCH: kimi' })
        expect(seen[1].details).toBe('session not found')
        expect(seen[2].details).toBeUndefined()
        expect(describeToastError(undefined)).toBeUndefined()
    })
})
