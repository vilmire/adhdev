// @vitest-environment jsdom
//
// (SHELL-FRESHNESS) Banner behaviour for "the shell running in this tab is
// older than what is deployed".
//
// Two opposite regressions matter, and both look reasonable in a diff:
//   - not showing when the build genuinely moved leaves the user reading a
//     stale dashboard with no way to know (the reported defect);
//   - showing on a current build survives the reload it asks for, which trains
//     the user to ignore the banner permanently.
// So both directions are asserted, plus the request-level guarantees that keep
// the check itself from going stale (`cache: 'no-store'`) or chatty.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ShellFreshnessBanner from '../../src/components/ShellFreshnessBanner'

let container: HTMLDivElement
let root: Root

const RUNNING_COMMIT = 'aaaaaaaaaaaa1111'

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // The running shell's identity travels with the document, exactly as
    // `insertBuildIdentityMeta` stamps it at build time.
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'adhdev-build-commit')
    meta.setAttribute('content', RUNNING_COMMIT)
    document.head.appendChild(meta)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.head.querySelectorAll('meta[name="adhdev-build-commit"]').forEach((el) => el.remove())
})

function buildInfoFetch(body: Record<string, unknown>) {
    return vi.fn(async () => ({
        ok: true,
        json: async () => body,
    })) as unknown as typeof fetch
}

async function render(fetchImpl: typeof fetch): Promise<void> {
    await act(async () => {
        root.render(<ShellFreshnessBanner fetchImpl={fetchImpl} />)
    })
    // Let the in-flight build-info promise settle and re-render.
    await act(async () => { await Promise.resolve() })
}

describe('ShellFreshnessBanner', () => {
    it('★ shows a reload prompt when the deployed commit differs', async () => {
        await render(buildInfoFetch({ commit: 'bbbbbbbbbbbb2222', packageVersion: '9.9.9' }))
        expect(container.textContent).toContain('A new version')
        expect(container.querySelector('button')?.textContent).toContain('Reload')
    })

    it('★ renders nothing when the deployed build matches the running one', async () => {
        await render(buildInfoFetch({ commit: RUNNING_COMMIT, packageVersion: '1.0.0' }))
        expect(container.textContent).toBe('')
    })

    it('renders nothing when build-info cannot be fetched', async () => {
        // Offline / 5xx must never be surfaced as an update prompt.
        const failing = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
        await render(failing)
        expect(container.textContent).toBe('')
    })

    it('★ requests build-info with cache: no-store', async () => {
        // Without this the freshness check can itself be served from cache and
        // report "current" forever — the same bug one level down.
        const fetchImpl = buildInfoFetch({ commit: 'bbbbbbbbbbbb2222' })
        await render(fetchImpl)
        const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(init).toMatchObject({ cache: 'no-store' })
    })

    it('★ never reloads on its own — the reload is only ever a click', async () => {
        // A forced reload would discard the user's in-flight work (an unsent
        // message, a scrolled transcript). Staleness is hours old by the time
        // it is detected and never outranks that.
        const reloadImpl = vi.fn()
        await act(async () => {
            root.render(
                <ShellFreshnessBanner
                    fetchImpl={buildInfoFetch({ commit: 'bbbbbbbbbbbb2222' })}
                    reloadImpl={reloadImpl}
                />,
            )
        })
        await act(async () => { await Promise.resolve() })

        expect(container.textContent).toContain('A new version')
        expect(reloadImpl).not.toHaveBeenCalled()

        const reloadButton = Array.from(container.querySelectorAll('button'))
            .find((b) => b.textContent?.includes('Reload'))
        act(() => { reloadButton?.click() })
        expect(reloadImpl).toHaveBeenCalledTimes(1)
    })

    it('can be dismissed without reloading', async () => {
        await render(buildInfoFetch({ commit: 'bbbbbbbbbbbb2222' }))
        const later = Array.from(container.querySelectorAll('button'))
            .find((b) => b.textContent?.includes('Later'))
        act(() => { later?.click() })
        expect(container.textContent).toBe('')
    })
})
