// Mesh Artifacts tab: mission → task grouping, "used by" join from inputArtifactIds,
// kind filter + search, and click-to-open in the fullscreen viewer with prev/next.
// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMeshArtifactsView } from '../../src/components/MeshGraph/meshArtifactsModel'
import MeshArtifactsTab from '../../src/components/MeshGraph/MeshArtifactsTab'
import { clearArtifactReadCache } from '../../src/hooks/useArtifactRead'

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const att = (id: string, over: Record<string, unknown> = {}) => ({
    artifactId: id, kind: 'markdown', mime: 'text/markdown', filename: `${id}.md`, title: `Title ${id}`,
    sizeBytes: 12, sha256: `sha-${id}`, createdAt: 1000, updatedAt: 1000,
    originSessionId: 'sess-1', taskId: 't1', missionId: 'm1', producerRole: 'worker', ...over,
}) as any

const tasks = [
    { id: 't1', meshId: 'x', message: '# Write the report\nmore', status: 'completed', missionId: 'm1' },
    { id: 't2', meshId: 'x', message: 'Review the report', status: 'completed', missionId: 'm1', inputArtifactIds: ['a1'] },
    { id: 't3', meshId: 'x', message: 'Solo task', status: 'completed' },
] as any
const missions = [{ id: 'm1', title: 'Report mission' }] as any

const data = [
    att('a1', { createdAt: 3000, previewText: 'quarterly numbers' }),
    att('a2', { createdAt: 2000, kind: 'json', mime: 'application/json', filename: 'a2.json', title: 'Data' }),
    att('a3', { createdAt: 1000, taskId: 't3', missionId: undefined, title: 'Loose' }),
    att('a4', { createdAt: 500, taskId: undefined, missionId: undefined, title: 'Orphan' }),
]

describe('buildMeshArtifactsView', () => {
    it('groups by mission then producing task, unassigned last', () => {
        const view = buildMeshArtifactsView({ attachments: data, tasks, missions, kind: 'all', query: '' })
        expect(view.missions.map(m => m.missionId)).toEqual(['m1', null])
        expect(view.missions[0]!.title).toBe('Report mission')
        expect(view.missions[0]!.tasks.map(g => [g.taskId, g.title, g.items.length])).toEqual([['t1', 'Write the report', 2]])
        // t3 has no mission on the artifact but the task has none either -> unassigned; its group precedes the no-task group.
        expect(view.missions[1]!.tasks.map(g => g.taskId)).toEqual(['t3', null])
        expect(view.ordered.map(i => i.attachment.artifactId)).toEqual(['a1', 'a2', 'a3', 'a4'])
    })

    it('joins consumers from inputArtifactIds', () => {
        const view = buildMeshArtifactsView({ attachments: data, tasks, missions, kind: 'all', query: '' })
        const a1 = view.ordered.find(i => i.attachment.artifactId === 'a1')!
        expect(a1.usedBy).toEqual([{ taskId: 't2', title: 'Review the report' }])
        expect(view.ordered.find(i => i.attachment.artifactId === 'a2')!.usedBy).toEqual([])
    })

    it('filters by kind and by title/path/preview text', () => {
        expect(buildMeshArtifactsView({ attachments: data, tasks, missions, kind: 'json', query: '' }).ordered.map(i => i.attachment.artifactId)).toEqual(['a2'])
        expect(buildMeshArtifactsView({ attachments: data, tasks, missions, kind: 'all', query: 'QUARTERLY' }).ordered.map(i => i.attachment.artifactId)).toEqual(['a1'])
        expect(buildMeshArtifactsView({ attachments: data, tasks, missions, kind: 'all', query: 'a2.json' }).ordered.map(i => i.attachment.artifactId)).toEqual(['a2'])
    })
})

describe('MeshArtifactsTab', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => {
        clearArtifactReadCache()
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

    function makeSend() {
        return vi.fn(async (_daemon: string, type: string, payload: any) => {
            if (type === 'artifact_list') return { success: true, attachments: data, hasMore: false, nextCursor: null }
            const found = data.find(d => d.artifactId === payload.artifactId)!
            return {
                success: true, artifactId: found.artifactId, sessionId: payload.sessionId, kind: found.kind, mime: found.mime,
                filename: found.filename, title: found.title, sizeBytes: found.sizeBytes, sha256: found.sha256,
                registeredSha256: found.sha256, sha256Changed: false, hashChanged: false,
                encoding: 'utf8', content: `body ${found.artifactId}`, createdAt: found.createdAt, updatedAt: found.updatedAt,
            }
        })
    }

    async function mount(send: ReturnType<typeof makeSend>) {
        await act(async () => {
            root.render(React.createElement(MeshArtifactsTab, {
                status: { meshId: 'mesh-1', nodes: [], queue: { tasks }, missions } as any,
                daemonId: 'host-daemon',
                sendDaemonCommand: send as any,
                active: true,
            }))
        })
        await flush()
    }

    it('lists via the owner mesh command on the host daemon and renders groups + used-by chips', async () => {
        const send = makeSend()
        await mount(send)
        expect(send).toHaveBeenCalledWith('host-daemon', 'artifact_list', expect.objectContaining({ meshId: 'mesh-1' }))
        expect(container.querySelectorAll('[data-testid="mesh-artifact-mission"]').length).toBe(2)
        expect(container.querySelectorAll('[data-testid="mesh-artifact-row"]').length).toBe(4)
        const usedBy = container.querySelector('[data-testid="mesh-artifact-used-by"]')
        expect(usedBy?.textContent).toContain('Review the report')
    })

    it('kind filter and search narrow the list', async () => {
        await mount(makeSend())
        await act(async () => { (container.querySelector('[data-testid="mesh-artifact-kind-json"]') as HTMLButtonElement).click() })
        expect(container.querySelectorAll('[data-testid="mesh-artifact-row"]').length).toBe(1)
        await act(async () => { (container.querySelector('[data-testid="mesh-artifact-kind-all"]') as HTMLButtonElement).click() })
        const input = container.querySelector('input[type="search"]') as HTMLInputElement
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
            setter.call(input, 'orphan')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(container.querySelectorAll('[data-testid="mesh-artifact-row"]').length).toBe(1)
    })

    it('clicking an artifact opens the viewer, with prev/next across the filtered list', async () => {
        const send = makeSend()
        await mount(send)
        await act(async () => { (container.querySelectorAll('[data-testid="mesh-artifact-open"]')[0] as HTMLButtonElement).click() })
        await flush()
        expect(send).toHaveBeenCalledWith('host-daemon', 'artifact_fetch', expect.objectContaining({ artifactId: 'a1', meshCoordinatorDaemonId: 'host-daemon', sessionId: 'sess-1' }))
        const pos = document.querySelector('[data-testid="artifact-fullscreen-position"]')
        expect(pos?.textContent).toBe('1/4')
        await act(async () => { (document.querySelector('[data-testid="artifact-fullscreen-next"]') as HTMLButtonElement).click() })
        await flush()
        expect(document.querySelector('[data-testid="artifact-fullscreen-position"]')?.textContent).toBe('2/4')
        expect(send).toHaveBeenCalledWith('host-daemon', 'artifact_fetch', expect.objectContaining({ artifactId: 'a2' }))
    })
})
