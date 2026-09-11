// @vitest-environment jsdom
import * as fs from 'node:fs'
import * as path from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MagiKindPanelEditor from '../../src/components/MeshGraph/MagiKindPanelEditor'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

/**
 * ★ MAGI-PANEL-GATE-DECOUPLE REGRESSION.
 *
 * `MeshDetailView.tsx` used to wrap the whole MAGI section in
 * `{displayedMeshStatus && (...)}`. `displayedMeshStatus` is the mesh_status
 * direct-peer-truth response, which comes back null whenever any mesh peer
 * fails to answer (e.g. one machine is powered off) — even though the daemon
 * connection the operator is actually using is fine. That made the entire
 * MAGI settings surface vanish, even though `MagiKindPanelEditor` never reads
 * anything off `status` that it can't do without: every derived value
 * (`liveNodes`, `knownNodeIds`, `nodeLabelById`, `providersByNode`) already
 * falls back to `[]`/`{}` via `status?.nodes ?? []`, and the daemon commands
 * (`magi_kind_panel_list/set/remove`) only need `daemonId` + `sendDaemonCommand`
 * (`canCommand`) plus an explicit `meshId`.
 *
 * The fix removed the `displayedMeshStatus &&` gate in MeshDetailView.tsx and
 * added an explicit `meshId` prop to MagiKindPanelEditor (mirroring
 * MeshMissionsSection's `meshId` prop) so mesh-scoping survives status being
 * null. This test pins that the editor renders its full CRUD surface with
 * `status={null}`, and that MeshDetailView.tsx no longer gates the MAGI
 * Section behind `displayedMeshStatus`.
 */
describe('MagiKindPanelEditor — renders and functions with status=null', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        // jsdom does not implement matchMedia; MagiKindPanelEditor pulls
        // useTheme(), which reads it on mount to resolve 'system' preference.
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
        act(() => root.unmount())
        container.remove()
    })

    function render(status: null, overrides: Partial<React.ComponentProps<typeof MagiKindPanelEditor>> = {}) {
        act(() => {
            root.render(
                <MagiKindPanelEditor
                    status={status}
                    daemonId="daemon_1"
                    meshId="mesh_1"
                    sendDaemonCommand={vi.fn(async () => ({ success: true, kindPanels: {} }))}
                    {...overrides}
                />,
            )
        })
    }

    it('renders the per-kind CRUD editors (not blank/null) when status is null', () => {
        render(null)
        expect(container.textContent).not.toBe('')
        // Task-kind hint codes are raw literals (not i18n-dependent), so they're a
        // reliable signal the per-kind cards actually rendered.
        expect(container.textContent).toContain('rca')
        expect(container.textContent).toContain('design')
        expect(container.textContent).toContain('claim_audit')
        expect(container.textContent).toContain('freeform')
    })

    it('does not disable commanding (canCommand) when status is null — only daemonId/sendDaemonCommand gate it', () => {
        render(null)
        const addButtons = Array.from(container.querySelectorAll('button')).filter(b => b.textContent?.match(/add/i))
        expect(addButtons.length).toBeGreaterThan(0)
        for (const btn of addButtons) expect(btn.disabled).toBe(false)
    })

    it('still calls magi_kind_panel_list to load bindings on mount even with status=null', async () => {
        const sendDaemonCommand = vi.fn(async () => ({ success: true, kindPanels: {} }))
        await act(async () => {
            render(null, { sendDaemonCommand })
        })
        expect(sendDaemonCommand).toHaveBeenCalledWith('daemon_1', 'magi_kind_panel_list', { meshId: 'mesh_1' })
    })

    it('renders normally when status is a populated RepoMeshStatus (no regression)', () => {
        const status = {
            meshId: 'mesh_1',
            nodes: [{ nodeId: 'node_1', machineLabel: 'Node One', providers: ['claude-cli'] }],
        } as any
        act(() => {
            root.render(
                <MagiKindPanelEditor
                    status={status}
                    daemonId="daemon_1"
                    sendDaemonCommand={vi.fn(async () => ({ success: true, kindPanels: {} }))}
                />,
            )
        })
        expect(container.textContent).toContain('rca')
    })
})

describe('MeshDetailView.tsx — MAGI Section is no longer gated behind displayedMeshStatus', () => {
    it('the MAGI Section render is not wrapped in a `displayedMeshStatus &&` guard', () => {
        const source = read('../../src/pages/repo-mesh/MeshDetailView.tsx')
        const marker = 'MAGI task_kind → panel binding editor'
        const idx = source.indexOf(marker)
        expect(idx).toBeGreaterThan(-1)
        const sectionStart = source.indexOf('<Section title={t(\'mesh.detail.magiTitle\')}', idx)
        expect(sectionStart).toBeGreaterThan(-1)
        // The 200 chars immediately preceding the Section open tag must not contain
        // a `displayedMeshStatus &&` gate reintroduced around it.
        const preamble = source.slice(Math.max(0, sectionStart - 200), sectionStart)
        expect(preamble).not.toMatch(/displayedMeshStatus\s*&&/)
    })

    it('MagiKindPanelEditor is invoked with an explicit meshId prop', () => {
        const source = read('../../src/pages/repo-mesh/MeshDetailView.tsx')
        const idx = source.indexOf('<MagiKindPanelEditor')
        expect(idx).toBeGreaterThan(-1)
        const invocation = source.slice(idx, source.indexOf('/>', idx))
        expect(invocation).toMatch(/meshId=\{selectedMesh\.id\}/)
    })
})
