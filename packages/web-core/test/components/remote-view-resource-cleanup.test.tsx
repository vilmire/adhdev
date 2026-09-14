// @vitest-environment jsdom
/**
 * D1#5 / D1#7 regression — RemoteView must release the resources it attaches.
 *
 * Two leaks, both only observable when the component goes away before the
 * resource resolves itself:
 *
 *  - The mobile fill-zoom effect attaches an img `load` listener with
 *    {once:true}. That self-removes only AFTER the event fires, so unmounting
 *    while the screenshot is still decoding left a listener on a detached node
 *    that later called setZoom on an unmounted tree.
 *  - The ripple effects each schedule a 600ms expiry setTimeout whose handle was
 *    never stored, so a click right before unmount left a pending timer calling
 *    setRipples on a dead tree.
 *
 * Both are asserted via spies on the real APIs (addEventListener/removeEventListener,
 * setTimeout/clearTimeout) rather than internals.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import RemoteView from '../../src/components/RemoteView'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    window.matchMedia = window.matchMedia || ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

function render(props: Partial<Parameters<typeof RemoteView>[0]> = {}) {
    act(() => root.render(
        <RemoteView
            onAction={vi.fn(async () => ({ success: true }))}
            addLog={vi.fn()}
            connState="connected"
            connScreenshot={null}
            {...props}
        />,
    ))
}

const SCREENSHOT = 'data:image/png;base64,iVBORw0KGgo='

describe('RemoteView resource cleanup (D1#5)', () => {
    it('removes the pending img load listener when unmounted mid-load', () => {
        // Force the mobile branch so the fill-zoom effect runs and attaches.
        window.matchMedia = ((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia

        const added: Array<[string, EventListenerOrEventListenerObject]> = []
        const removed: Array<[string, EventListenerOrEventListenerObject]> = []
        const realAdd = HTMLImageElement.prototype.addEventListener
        const realRemove = HTMLImageElement.prototype.removeEventListener
        vi.spyOn(HTMLImageElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLImageElement, type: string, listener: any, opts?: any) {
            if (type === 'load') added.push([type, listener])
            return realAdd.call(this, type, listener, opts)
        } as typeof HTMLImageElement.prototype.addEventListener)
        vi.spyOn(HTMLImageElement.prototype, 'removeEventListener').mockImplementation(function (this: HTMLImageElement, type: string, listener: any, opts?: any) {
            if (type === 'load') removed.push([type, listener])
            return realRemove.call(this, type, listener, opts)
        } as typeof HTMLImageElement.prototype.removeEventListener)

        // React attaches its own bound dispatchEvent delegate; only the component's
        // named onLoad closure is ours to account for.
        const ours = (entries: typeof added) => entries.filter(([, fn]) => (fn as any)?.name === 'onLoad')

        // jsdom never fires `load` for a data URI, so the listener stays pending —
        // exactly the mid-load unmount this guards.
        render({ connScreenshot: SCREENSHOT })
        expect(ours(added)).toHaveLength(1)
        expect(ours(removed)).toHaveLength(0)

        act(() => root.unmount())

        // The component's pending load listener must have been detached.
        expect(ours(removed).map(([, fn]) => fn)).toEqual(ours(added).map(([, fn]) => fn))
    })

    /**
     * Drive a real click so a ripple timer is actually scheduled, then unmount
     * while it is still pending. Asserting on the live fake-timer count is what
     * makes this fail when the cleanup is reverted — a leaked 600ms timer is
     * still queued after unmount.
     */
    async function clickImageThenUnmount(): Promise<{ pendingAfterClick: number; pendingAfterUnmount: number }> {
        const onAction = vi.fn(async () => ({ success: true }))
        act(() => root.render(
            <RemoteView
                onAction={onAction}
                addLog={vi.fn()}
                connState="connected"
                connScreenshot={SCREENSHOT}
            />,
        ))

        const img = container.querySelector('img')
        expect(img).toBeTruthy()
        // Give the image a real box so the click resolves to a coordinate.
        img!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => {} }) as DOMRect

        await act(async () => {
            img!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
            await vi.advanceTimersByTimeAsync(0)
        })

        const pendingAfterClick = vi.getTimerCount()
        act(() => root.unmount())
        return { pendingAfterClick, pendingAfterUnmount: vi.getTimerCount() }
    }

    it('clears the pending ripple expiry timer on unmount', async () => {
        vi.useFakeTimers()

        const { pendingAfterClick, pendingAfterUnmount } = await clickImageThenUnmount()

        // The click scheduled a 600ms ripple expiry...
        expect(pendingAfterClick).toBeGreaterThan(0)
        // ...and unmount must have cleared it rather than leaving it queued to
        // call setRipples on a dead tree.
        expect(pendingAfterUnmount).toBeLessThan(pendingAfterClick)
    })

    it('does not warn about state updates after unmount when ripple timers elapse', async () => {
        vi.useFakeTimers()
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await clickImageThenUnmount()
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

        const unmountedUpdateWarnings = errorSpy.mock.calls.filter(([first]) =>
            typeof first === 'string' && /unmounted|not wrapped in act/i.test(first),
        )
        expect(unmountedUpdateWarnings).toEqual([])
    })
})
