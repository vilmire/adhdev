// @vitest-environment jsdom
import * as fs from 'node:fs'
import * as path from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMeshNodeActions } from '../../src/pages/repo-mesh/useMeshNodeActions'
import type { MeshEntry } from '../../src/pages/repo-mesh/types'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

/**
 * RepoMesh.tsx's mesh-selection effect is page-scale (heavy context deps,
 * impractical to mount in a unit test) — pinned at the source level, same
 * convention as repo-mesh-create-hang-regression.test.ts.
 */
describe('RepoMesh.tsx — G5-1 mesh-selection queue load has no dead-flag guard', () => {
    it('the queue-load effect calls loadQueue with no queueSection (or any) guard in front of it', () => {
        const source = read('../../src/pages/RepoMesh.tsx')
        const marker = 'Auto-load queue on mesh selection'
        const idx = source.indexOf(marker)
        expect(idx).toBeGreaterThan(-1)
        const effect = source.slice(idx, source.indexOf('loadQueue(selectedMeshId)', idx) + 'loadQueue(selectedMeshId)'.length)
        expect(effect).not.toContain('queueSection')
        expect(effect).not.toMatch(/if\s*\(/)
    })

    it('RepoMeshFeatures no longer declares a queueSection flag anywhere in web-core', () => {
        const context = read('../../src/context/RepoMeshContext.tsx')
        expect(context).not.toContain('queueSection')
    })

    it('useMeshNodeActions.ts has no queueSection-gated loadQueue call', () => {
        const source = read('../../src/pages/repo-mesh/useMeshNodeActions.ts')
        expect(source).not.toContain('queueSection')
        // Both post-mutation refresh call sites must call loadQueue directly,
        // not behind a conditional.
        const calls = source.split('\n').filter(line => line.includes('loadQueue('))
        expect(calls.length).toBeGreaterThanOrEqual(2)
        for (const line of calls) {
            expect(line).not.toMatch(/if\s*\(/)
        }
    })
})

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

/**
 * ★ G5-1 THE PERMANENT-"NO-ACTIVE-ASSIGNMENT" REGRESSION.
 *
 * `queueSection` used to be a feature flag that was `true` on BOTH platforms
 * (never actually toggled), yet `useMeshNodeActions` gated its post-mutation
 * `loadQueue()` refresh behind `if (!queueSection) await loadQueue(...)` — so
 * that refresh never fired anywhere, and `RepoMesh.tsx`'s mesh-selection
 * effect had the identical inverted guard (`if (features.queueSection)
 * return`), so the *initial* load never fired either. The net effect: the
 * `meshQueue` array backing `MeshMachineNodeGroup`'s "active assigned queue
 * task" diagnostic never populated, so every node — including ones running
 * live tasks — showed "No active assigned queue task" unconditionally.
 *
 * The fix removed the `queueSection` flag/param entirely and calls
 * `loadQueue` unconditionally. This test pins that `handleRemoveNode` (one of
 * the two call sites) actually invokes `loadQueue` post-mutation.
 *
 * ── Red/green injection ────────────────────────────────────────────────────
 * Reintroduce a `queueSection`-gated `if (!queueSection) await loadQueue(...)`
 * (or any other guard around the call) and this test goes red — `loadQueue`
 * stops being called.
 */
describe('useMeshNodeActions — G5-1 loadQueue is not gated behind a dead feature flag', () => {
    function harness(overrides: Partial<Parameters<typeof useMeshNodeActions>[0]> = {}) {
        const loadQueue = vi.fn(async () => {})
        const loadMeshes = vi.fn(async () => {})
        const sendCommand = vi.fn(async () => ({ success: true }))
        const unwrapResult = vi.fn((raw: any) => raw)
        const setError = vi.fn()
        const mesh: MeshEntry = { id: 'mesh_1', name: 'Test Mesh', nodes: [] } as any

        let latest: ReturnType<typeof useMeshNodeActions> | null = null
        function Harness() {
            latest = useMeshNodeActions({
                selectedMesh: mesh,
                selectedMeshId: mesh.id,
                primaryDaemonId: 'daemon_1',
                activeDaemonId: 'daemon_1',
                daemons: [],
                availableCliProviders: [],
                sendCommand,
                unwrapResult,
                resolveCommandTarget: (() => ({ targetDaemonId: 'daemon_1' })) as any,
                launchCoordinator: (async () => ({ message: 'ok' })) as any,
                features: { addNodeDaemonPicker: false },
                loadMeshes,
                loadQueue,
                setError,
                confirmAction: async () => true,
                ...overrides,
            })
            return null
        }
        act(() => { root.render(<Harness />) })
        // `hook` is exposed as a getter (not destructured) so every access
        // re-reads the latest render's closure — required because
        // handleAddNode reads `nodeWorkspace` from hook state, and a
        // destructured snapshot would freeze it at its pre-update value.
        return { get hook() { return latest! }, loadQueue, loadMeshes, sendCommand, setError }
    }

    it('handleRemoveNode calls loadQueue unconditionally after a successful removal', async () => {
        const harnessResult = harness()
        await act(async () => {
            await harnessResult.hook.handleRemoveNode('node_1')
        })
        expect(harnessResult.loadQueue).toHaveBeenCalledTimes(1)
        expect(harnessResult.loadQueue).toHaveBeenCalledWith('mesh_1')
    })

    it('handleAddNode calls loadQueue unconditionally after a successful add', async () => {
        const sendCommand = vi.fn(async (_daemonId: string, type: string) => {
            if (type === 'plan_mesh_onboarding') return { success: true, discovery: { repoRoot: '/repo' } }
            if (type === 'add_mesh_node') return { success: true }
            return { success: true }
        })
        const harnessResult = harness({ sendCommand: sendCommand as any })
        act(() => { harnessResult.hook.setNodeWorkspace('/repo') })
        await act(async () => {
            await harnessResult.hook.handleAddNode()
        })
        expect(harnessResult.loadQueue).toHaveBeenCalledTimes(1)
        expect(harnessResult.loadQueue).toHaveBeenCalledWith('mesh_1')
    })

    it('useMeshNodeActions no longer accepts (or requires) a queueSection option', () => {
        const harnessResult = harness()
        // TypeScript already enforces this at compile time (no queueSection
        // field in UseMeshNodeActionsOptions); this runtime check pins that
        // the hook doesn't silently read a `queueSection` off `features` or
        // elsewhere to gate behavior.
        expect(harnessResult.hook).not.toHaveProperty('queueSection')
    })
})
