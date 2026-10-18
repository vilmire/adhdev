// @vitest-environment jsdom
/** "Following N": the projects the assistant follows, and stopping one (2026-10-18). */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantWatchedProjects from '../../src/components/dashboard/AssistantWatchedProjects'

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('AssistantWatchedProjects', () => {
    it('is hidden while the assistant follows nothing', async () => {
        const send = vi.fn(async () => ({ success: true, threads: [] }))
        act(() => root.render(<AssistantWatchedProjects daemonId="d" sendCommand={send} />))
        await flush()
        expect(container.querySelector('.assistant-watched')).toBeNull()
    })

    it('lists followed projects and stops following one', async () => {
        let threads = [
            { meshId: 'm1', project: 'adhdev-cloud', openedAt: 1, lastSendAt: Date.now() - 60_000 },
            { meshId: 'm2', project: 'batrp', openedAt: 1, lastSendAt: Date.now() - 120_000 },
        ]
        const send = vi.fn(async (_d: string, command: string, args: any) => {
            if (command === 'assistant_thread_close') { threads = threads.filter(t => t.meshId !== args.meshId); return { success: true, closed: true } }
            return { success: true, threads }
        })
        act(() => root.render(<AssistantWatchedProjects daemonId="d" sendCommand={send} />))
        await flush()
        const badge = container.querySelector<HTMLButtonElement>('.assistant-watched-badge')!
        expect(badge.textContent).toContain('Following 2')
        act(() => badge.click())
        await flush()
        expect(container.textContent).toContain('adhdev-cloud')
        const stopButtons = [...container.querySelectorAll<HTMLButtonElement>('li button')]
        await act(async () => { stopButtons[0]!.click() })
        await flush()
        expect(send).toHaveBeenCalledWith('d', 'assistant_thread_close', { meshId: 'm1' })
        expect(container.querySelector('.assistant-watched-badge')?.textContent).toContain('Following 1')
    })
})
