// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSingleFlightAction, type SingleFlightAction } from '../../src/hooks/useSingleFlightAction'

function deferred<T = void>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

describe('useSingleFlightAction', () => {
    let container: HTMLDivElement
    let root: Root
    let flight: SingleFlightAction

    function Harness() {
        flight = useSingleFlightAction()
        return <span data-pending={flight.pendingKey ?? ''} />
    }

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        act(() => root.render(<Harness />))
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    const pendingAttr = () => container.querySelector('span')!.getAttribute('data-pending')

    it('runs one action at a time and drops taps while one is in flight', async () => {
        const first = deferred()
        const a = vi.fn(() => first.promise)
        const b = vi.fn()

        let started = false
        act(() => { started = flight.run('a', a) })
        expect(started).toBe(true)
        expect(pendingAttr()).toBe('a')

        let second = true
        act(() => { second = flight.run('b', b) })
        expect(second).toBe(false)
        expect(b).not.toHaveBeenCalled()
        // A repeat tap on the same key is dropped as well.
        act(() => { flight.run('a', a) })
        expect(a).toHaveBeenCalledTimes(1)

        await act(async () => { first.resolve(); await first.promise })
        expect(pendingAttr()).toBe('')

        act(() => { flight.run('b', b) })
        expect(b).toHaveBeenCalledTimes(1)
    })

    it('a synchronous action never latches', () => {
        const a = vi.fn()
        act(() => { flight.run('a', a) })
        expect(pendingAttr()).toBe('')
        act(() => { flight.run('a', a) })
        expect(a).toHaveBeenCalledTimes(2)
    })

    it('cancel aborts the signal, releases the latch at once, and a late settle cannot clear a newer flight', async () => {
        const first = deferred()
        let firstSignal: AbortSignal | null = null
        act(() => {
            flight.run('a', signal => { firstSignal = signal; return first.promise })
        })
        expect(pendingAttr()).toBe('a')

        act(() => flight.cancel())
        expect(firstSignal!.aborted).toBe(true)
        expect(pendingAttr()).toBe('')

        const second = deferred()
        act(() => { flight.run('b', () => second.promise) })
        expect(pendingAttr()).toBe('b')

        // The abandoned first action settles late — it must not clear 'b'.
        await act(async () => { first.resolve(); await first.promise })
        expect(pendingAttr()).toBe('b')

        await act(async () => { second.resolve(); await second.promise })
        expect(pendingAttr()).toBe('')
    })

    it('releases the latch when the action rejects', async () => {
        const first = deferred()
        act(() => { flight.run('a', () => first.promise) })
        await act(async () => {
            first.reject(new Error('boom'))
            await first.promise.catch(() => undefined)
        })
        expect(pendingAttr()).toBe('')
    })

    it('a synchronous throw releases the latch and is not swallowed silently', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        act(() => { flight.run('a', () => { throw new Error('sync boom') }) })
        expect(pendingAttr()).toBe('')
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })
})
