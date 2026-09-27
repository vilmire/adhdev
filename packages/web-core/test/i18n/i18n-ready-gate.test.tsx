// @vitest-environment jsdom
//
// I18nReadyGate holds the first paint until the boot locale's catalog is in, so
// a ko/ja/… user never sees an English frame; an already-ready (en) boot renders
// children on the very first pass.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const i18nState = vi.hoisted(() => {
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    return { ready: false, promise, resolve: () => resolve() }
})

vi.mock('../../src/i18n/config', () => ({
    isI18nReady: () => i18nState.ready,
    whenI18nReady: () => i18nState.promise,
}))

import { I18nReadyGate } from '../../src/i18n/I18nReadyGate'

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

describe('I18nReadyGate', () => {
    it('renders the fallback until the locale is ready, then the app', async () => {
        await act(async () => {
            root.render(<I18nReadyGate fallback={<p>boot-loading</p>}><p>app</p></I18nReadyGate>)
        })
        expect(container.textContent).toBe('boot-loading')

        await act(async () => {
            i18nState.ready = true
            i18nState.resolve()
            await i18nState.promise
        })
        expect(container.textContent).toBe('app')
    })

    it('renders children immediately when already ready', () => {
        i18nState.ready = true
        act(() => {
            root.render(<I18nReadyGate fallback={<p>boot-loading</p>}><p>app</p></I18nReadyGate>)
        })
        expect(container.textContent).toBe('app')
    })
})
