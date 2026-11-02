// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadMetadata = vi.fn(async (_id: string) => undefined)
let ides: any[] = []

vi.mock('../../../src/hooks/useDaemonMetadataLoader', () => ({ useDaemonMetadataLoader: () => loadMetadata }))
vi.mock('../../../src/context/BaseDaemonContext', () => ({ useBaseDaemons: () => ({ ides }) }))
vi.mock('../../../src/context/TransportContext', () => ({ useTransport: () => ({ sendCommand: vi.fn(), sendData: vi.fn() }) }))

import { ProjectTransferSection } from '../../../src/components/settings/ProjectTransferSection'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function setValue(el: HTMLSelectElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
}
const send = vi.fn(async (_id: string, cmd: string) => cmd === 'project_transfer_list' ? { success: true, transfers: [] } : { success: true, supported: true, reasons: [], entries: [] })

describe('ProjectTransferSection metadata subscription', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => {
        loadMetadata.mockClear()
        ides = [
            { id: 'daemon_a', type: 'adhdev-daemon', status: 'online', machine: { hostname: 'alpha' } },
            { id: 'daemon_b', type: 'adhdev-daemon', status: 'online', machine: { hostname: 'beta' } },
        ]
        container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    })
    afterEach(() => { act(() => root.unmount()); container.remove() })
    const q = (id: string) => container.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!
    const render = async () => { await act(async () => { root.render(<ProjectTransferSection sendCommand={send as any} pollMs={60_000} />); await flush() }) }

    it('subscribes the selected source and target machines and fills the project picker once workspaces arrive', async () => {
        await render()
        expect(loadMetadata).not.toHaveBeenCalled()
        await act(async () => { setValue(q('project-transfer-from-machine'), 'daemon_a'); await flush() })
        expect(loadMetadata).toHaveBeenCalledWith('daemon_a')
        await act(async () => { setValue(q('project-transfer-to-machine'), 'daemon_b'); await flush() })
        expect(loadMetadata).toHaveBeenCalledWith('daemon_b')
        expect(q('project-transfer-from-project').options.length).toBe(1) // placeholder only

        ides = [{ ...ides[0], workspaces: [{ id: 'ws1', path: '/opt/p', label: 'proj' }] }, ides[1]]
        await render()
        expect(q('project-transfer-from-project').options.length).toBe(2)
    })

    it('does not subscribe when machines are injected through props', async () => {
        await act(async () => {
            root.render(<ProjectTransferSection machines={[
                { id: 'x', name: 'X', online: true, workspaces: [] }, { id: 'y', name: 'Y', online: true, workspaces: [] },
            ]} sendCommand={send as any} pollMs={60_000} />); await flush()
        })
        await act(async () => { setValue(q('project-transfer-from-machine'), 'x'); await flush() })
        expect(loadMetadata).not.toHaveBeenCalled()
    })
})
