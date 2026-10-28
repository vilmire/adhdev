// Mesh Artifacts tab: mission → task grouping, "used by" join from inputArtifactIds,
// kind filter + search, and click-to-open in the fullscreen viewer with prev/next.
// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { artifactPreviewLine, buildMeshArtifactsView, shortMeshRefId } from '../../src/components/MeshGraph/meshArtifactsModel'
import MeshArtifactsTab from '../../src/components/MeshGraph/MeshArtifactsTab'
import { clearArtifactReadCache, getCachedArtifactPayload, buildArtifactCacheKey } from '../../src/hooks/useArtifactRead'
import { clearThumbnailState, THUMBNAIL_MAX_CONCURRENT } from '../../src/utils/mesh-artifact-thumbnail'

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

describe('labels and previews', () => {
    it('never yields a bare prefix: short ids strip known prefixes', () => {
        expect(shortMeshRefId('mission_abcdef1234567890')).toBe('34567890')
        expect(shortMeshRefId('mesh_queue:task_betaa1b2c3d4')).toBe('a1b2c3d4')
        expect(shortMeshRefId('task_ab')).toBe('ab')
        const view = buildMeshArtifactsView({
            attachments: [att('x1', { taskId: 'task_zzzz', missionId: 'mission_zzzz' })], tasks: [], missions: [], kind: 'all', query: '',
        })
        // Titles stay empty (UI renders a localized "Task …id" fallback), never "#task_zz".
        expect(view.missions[0]!.title).toBe('')
        expect(view.missions[0]!.tasks[0]!.title).toBe('')
    })

    it('prefers mission and task titles from mesh data', () => {
        const view = buildMeshArtifactsView({ attachments: data, tasks, missions, kind: 'all', query: '' })
        expect(view.missions[0]!.title).toBe('Report mission')
        expect(view.missions[0]!.tasks[0]!.title).toBe('Write the report')
    })

    it('summarises diff, json and text previews', () => {
        const diff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-old\n+new\n+newer'
        expect(artifactPreviewLine('diff', diff)).toBe('+2 −1 · src/app.ts')
        expect(artifactPreviewLine('json', '{"status":"ok","items":[1]}')).toBe('{ status, items }')
        expect(artifactPreviewLine('json', '{"status":"ok","ite')).toBe('{"status":"ok","ite')
        expect(artifactPreviewLine('markdown', '#\n\n# Real title\nbody')).toBe('Real title')
        expect(artifactPreviewLine('text', '\n  hello  \nworld')).toBe('hello')
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

    it('localizes the producer role badge and shows readable group headers', async () => {
        await mount(makeSend())
        const first = container.querySelector('[data-testid="mesh-artifact-task"]')!
        expect(first.textContent).toContain('worker')
        const heads = [...container.querySelectorAll('h3, [data-testid="mesh-artifact-task"] > div:first-child')].map(n => n.textContent)
        expect(heads.join('|')).not.toMatch(/#mission_|#task_/)
    })

    it('shows a change summary preview and opens from a click anywhere on the row', async () => {
        const send = makeSend()
        await mount(send)
        const row = container.querySelectorAll('[data-testid="mesh-artifact-row"]')[0] as HTMLElement
        expect(row.querySelector('[data-testid="mesh-artifact-preview"]')?.textContent).toBe('quarterly numbers')
        await act(async () => { row.click() })
        await flush()
        expect(document.querySelector('[data-testid="artifact-fullscreen-viewer"]')).not.toBeNull()
        expect(send).toHaveBeenCalledWith('host-daemon', 'artifact_fetch', expect.objectContaining({ artifactId: 'a1' }))
    })

    it('rapid clicks open only the latest artifact', async () => {
        const resolvers = new Map<string, () => void>()
        const base = makeSend()
        const send = vi.fn(async (d: string, type: string, payload: any) => {
            if (type === 'artifact_fetch') await new Promise<void>(res => resolvers.set(payload.artifactId, res))
            return base(d, type, payload)
        })
        await mount(send as any)
        const buttons = container.querySelectorAll('[data-testid="mesh-artifact-open"]')
        await act(async () => { (buttons[0] as HTMLButtonElement).click(); (buttons[1] as HTMLButtonElement).click() })
        await act(async () => { resolvers.get('a2')!(); await new Promise(r => setTimeout(r, 0)) })
        await act(async () => { resolvers.get('a1')!(); await new Promise(r => setTimeout(r, 0)) })
        expect(document.querySelector('[data-testid="artifact-fullscreen-title"]')?.textContent).toBe('Data')
    })

    function failingFetchSend(over: Record<string, unknown>, gate?: { resolve?: () => void }) {
        const base = makeSend()
        return vi.fn(async (d: string, type: string, payload: any) => {
            if (type === 'artifact_fetch') {
                if (gate) await new Promise<void>(res => { gate.resolve = res })
                return { success: false, ...over }
            }
            return base(d, type, payload)
        })
    }
    const openButtons = () => container.querySelectorAll('[data-testid="mesh-artifact-open"]')

    it('shows opening feedback on the row being opened while the fetch is slow', async () => {
        const gate: { resolve?: () => void } = {}
        await mount(failingFetchSend({ code: 'artifact_not_found', error: 'x (artifact_not_found)' }, gate) as any)
        await act(async () => { (openButtons()[0] as HTMLButtonElement).click() })
        const rows = container.querySelectorAll('[data-testid="mesh-artifact-row"]')
        expect(rows[0]!.getAttribute('aria-busy')).toBe('true')
        expect(rows[0]!.querySelector('[data-testid="mesh-artifact-opening"]')?.textContent).toContain('Opening')
        expect(rows[1]!.getAttribute('aria-busy')).toBeNull()
        await act(async () => { gate.resolve!(); await new Promise(r => setTimeout(r, 0)) })
        expect(rows[0]!.getAttribute('aria-busy')).toBeNull()
        expect(container.querySelector('[data-testid="mesh-artifact-opening"]')).toBeNull()
    })

    it('renders a localized open error inline on the failed row and clears it on the next open', async () => {
        const send = vi.fn(async (d: string, type: string, payload: any) => {
            if (type === 'artifact_fetch' && payload.artifactId === 'a2') {
                return { success: false, code: 'artifact_not_found', error: 'Artifact file not found: missing.md (artifact_not_found)' }
            }
            return makeSend()(d, type, payload)
        })
        await mount(send as any)
        await act(async () => { (openButtons()[1] as HTMLButtonElement).click() })
        await flush()
        const rows = container.querySelectorAll('[data-testid="mesh-artifact-row"]')
        const alert = rows[1]!.querySelector('[role="alert"]')!
        expect(alert.textContent).toContain('no longer present')
        expect(alert.textContent).not.toContain('artifact_not_found')
        expect(alert.getAttribute('title')).toContain('Artifact file not found: missing.md')
        expect(container.querySelectorAll('[role="alert"]').length).toBe(1)
        // Another open starts: the old error clears.
        await act(async () => { (openButtons()[0] as HTMLButtonElement).click() })
        await flush()
        expect(container.querySelector('[data-testid="mesh-artifact-open-error"]')).toBeNull()
    })

    it('maps a timed-out origin to the offline message', async () => {
        const send = vi.fn(async (d: string, type: string, payload: any) => {
            if (type === 'artifact_fetch') throw new Error('Command artifact_fetch timed out')
            return makeSend()(d, type, payload)
        })
        await mount(send as any)
        await act(async () => { (openButtons()[0] as HTMLButtonElement).click() })
        await flush()
        expect(container.querySelector('[data-testid="mesh-artifact-open-error"]')?.textContent).toContain('offline')
    })

    it('puts the full title on the open button as a tooltip', async () => {
        await mount(makeSend())
        expect(openButtons()[0]!.getAttribute('title')).toBe('Title a1')
    })

    it('hints that more artifacts exist when a filter is active and pages are unloaded', async () => {
        const base = makeSend()
        const send = vi.fn(async (d: string, type: string, payload: any) => {
            if (type === 'artifact_list') return { success: true, attachments: data, hasMore: true, nextCursor: 'c1' }
            return base(d, type, payload)
        })
        await mount(send as any)
        expect(container.querySelector('[data-testid="mesh-artifacts-more-hint"]')).toBeNull()
        const input = container.querySelector('input[type="search"]') as HTMLInputElement
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'zzz-no-such')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(container.querySelector('[data-testid="mesh-artifact-row"]')).toBeNull()
        expect(container.querySelector('[data-testid="mesh-artifacts-more-hint"]')).not.toBeNull()
        await act(async () => { (container.querySelector('[data-testid="mesh-artifacts-load-more"]') as HTMLButtonElement).click() })
        expect(send.mock.calls.filter(c => c[1] === 'artifact_list').length).toBe(2)
    })

    it('shows the loaded total as "N+" in the viewer when more pages exist', async () => {
        const base = makeSend()
        const send = vi.fn(async (d: string, type: string, payload: any) => {
            if (type === 'artifact_list') return { success: true, attachments: data, hasMore: true, nextCursor: 'c1' }
            return base(d, type, payload)
        })
        await mount(send as any)
        await act(async () => { (openButtons()[0] as HTMLButtonElement).click() })
        await flush()
        expect(document.querySelector('[data-testid="artifact-fullscreen-position"]')?.textContent).toBe('1/4+')
    })

    it('focuses the row open button when the row whitespace is clicked, so closing returns focus there', async () => {
        await mount(makeSend())
        const row = container.querySelectorAll('[data-testid="mesh-artifact-row"]')[0] as HTMLElement
        await act(async () => { row.click() })
        await flush()
        expect(document.activeElement).not.toBe(openButtons()[0])
        await act(async () => { (document.querySelector('[data-testid="artifact-fullscreen-close"]') as HTMLButtonElement).click() })
        expect(document.activeElement).toBe(openButtons()[0])
    })

    it('mesh switch clears the previous mesh list immediately', async () => {
        const send = makeSend()
        await mount(send)
        expect(container.querySelectorAll('[data-testid="mesh-artifact-row"]').length).toBe(4)
        const pending = new Promise(() => {})
        const slow = vi.fn(async () => pending)
        await act(async () => {
            root.render(React.createElement(MeshArtifactsTab, {
                status: { meshId: 'mesh-2', nodes: [], queue: { tasks: [] }, missions: [] } as any,
                daemonId: 'host-daemon', sendDaemonCommand: slow as any, active: true,
            }))
        })
        expect(container.querySelectorAll('[data-testid="mesh-artifact-row"]').length).toBe(0)
    })

    describe('thumbnails', () => {
        const OrigIO = (globalThis as any).IntersectionObserver
        let observers: Array<{ cb: (e: any[]) => void; el: Element; disconnected: boolean }> = []
        const origCreate = URL.createObjectURL
        const origRevoke = URL.revokeObjectURL
        let created = 0
        beforeEach(() => {
            clearThumbnailState()
            observers = []
            created = 0
            ;(globalThis as any).IntersectionObserver = class {
                rec: any
                constructor(cb: any) { this.rec = { cb, el: null, disconnected: false }; observers.push(this.rec) }
                observe(el: Element) { this.rec.el = el }
                disconnect() { this.rec.disconnected = true }
            }
            URL.createObjectURL = vi.fn(() => `blob:t${++created}`) as any
            URL.revokeObjectURL = vi.fn() as any
        })
        afterEach(() => {
            ;(globalThis as any).IntersectionObserver = OrigIO
            URL.createObjectURL = origCreate
            URL.revokeObjectURL = origRevoke
        })
        const imgs = Array.from({ length: 6 }, (_, i) => att(`img${i}`, {
            kind: 'image', mime: 'image/png', filename: `i${i}.png`, title: `Img ${i}`, taskId: undefined, missionId: undefined, createdAt: 9000 - i,
        }))
        function imageSend(gate: { open: boolean; waiters: Array<() => void> }) {
            let active = 0
            let peak = 0
            const fn = vi.fn(async (_d: string, type: string, payload: any) => {
                if (type === 'artifact_list') return { success: true, attachments: imgs, hasMore: false, nextCursor: null }
                active += 1; peak = Math.max(peak, active)
                await new Promise<void>(res => gate.waiters.push(res))
                active -= 1
                const found = imgs.find(d => d.artifactId === payload.artifactId)!
                return {
                    success: true, artifactId: found.artifactId, sessionId: payload.sessionId, kind: 'image', mime: 'image/png',
                    filename: found.filename, title: found.title, sizeBytes: 3, sha256: found.sha256, registeredSha256: found.sha256,
                    sha256Changed: false, hashChanged: false, encoding: 'base64', content: 'AAEC', createdAt: 1, updatedAt: 1,
                }
            })
            return Object.assign(fn, { peak: () => peak })
        }
        const mountImgs = async (send: any, token = 0) => {
            await act(async () => {
                root.render(React.createElement(MeshArtifactsTab, {
                    status: { meshId: 'mesh-1', nodes: [], queue: { tasks: [] }, missions: [] } as any,
                    daemonId: 'host-daemon', sendDaemonCommand: send, active: true, refreshToken: token,
                }))
            })
            await flush()
        }
        const reveal = async () => { await act(async () => { observers.filter(o => !o.disconnected && o.el).forEach(o => o.cb([{ isIntersecting: true }])) }) }

        it('limits concurrent thumbnail fetches and keeps them out of the shared chat cache', async () => {
            const gate = { open: false, waiters: [] as Array<() => void> }
            const send = imageSend(gate)
            await mountImgs(send)
            await reveal()
            const fetches = () => send.mock.calls.filter(c => c[1] === 'artifact_fetch').length
            expect(fetches()).toBe(THUMBNAIL_MAX_CONCURRENT)
            // Finish one at a time; the queue feeds the rest.
            for (let i = 0; i < 6; i++) {
                await act(async () => { gate.waiters.shift()?.(); await new Promise(r => setTimeout(r, 0)) })
            }
            expect(fetches()).toBe(6)
            expect(send.peak()).toBeLessThanOrEqual(THUMBNAIL_MAX_CONCURRENT)
            const key = buildArtifactCacheKey({ daemonId: 'host-daemon', sessionId: 'sess-1', meshCoordinatorDaemonId: 'host-daemon', artifactId: 'img0', sha256: 'sha-img0', updatedAt: 1000 })
            expect(key && getCachedArtifactPayload(key)).toBeFalsy()
        })

        it('does not fetch rows that scrolled away before their turn', async () => {
            const gate = { open: false, waiters: [] as Array<() => void> }
            const send = imageSend(gate)
            await mountImgs(send)
            await reveal()
            // Rows 3-5 are queued; scroll them out of view.
            await act(async () => { observers.slice(3).forEach(o => o.cb([{ isIntersecting: false }])) })
            for (let i = 0; i < 6; i++) await act(async () => { gate.waiters.shift()?.(); await new Promise(r => setTimeout(r, 0)) })
            expect(send.mock.calls.filter(c => c[1] === 'artifact_fetch').length).toBe(3)
        })

        it('keeps thumbnails valid across a refresh (no revoked object URL left in src)', async () => {
            const gate = { open: false, waiters: [] as Array<() => void> }
            const send = imageSend(gate)
            await mountImgs(send)
            await reveal()
            for (let i = 0; i < 6; i++) await act(async () => { gate.waiters.shift()?.(); await new Promise(r => setTimeout(r, 0)) })
            const before = container.querySelectorAll('[data-testid="mesh-artifact-thumb"]').length
            expect(before).toBeGreaterThan(0)
            const revokedBefore = (URL.revokeObjectURL as any).mock.calls.length
            await mountImgs(send, 1) // refreshToken bump -> new attachment objects
            const srcs = [...container.querySelectorAll('[data-testid="mesh-artifact-thumb"]')].map(i => i.getAttribute('src'))
            const revoked = new Set((URL.revokeObjectURL as any).mock.calls.map((c: any[]) => c[0]))
            for (const src of srcs) expect(revoked.has(src)).toBe(false)
            expect((URL.revokeObjectURL as any).mock.calls.length).toBe(revokedBefore)
        })
    })
})
