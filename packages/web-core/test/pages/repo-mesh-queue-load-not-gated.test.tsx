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
describe('RepoMesh.tsx — the queue is read from the coordinator mesh_status', () => {
    it('RepoMesh.tsx derives meshQueue from the coordinator status — no per-daemon queue load', () => {
        const source = read('../../src/pages/RepoMesh.tsx')
        expect(source).toContain('useMeshQueue({ status: meshGraphStatus })')
        expect(source).not.toContain('loadQueue')
        expect(source).not.toContain("'get_mesh_queue'")
    })

    it('useMeshQueue.ts never sends a command (no daemons[0] / primaryDaemonId queue read)', () => {
        const source = read('../../src/pages/repo-mesh/useMeshQueue.ts')
        expect(source).not.toContain('sendCommand')
        expect(source).not.toContain('get_mesh_queue')
        expect(source).not.toContain('primaryDaemonId')
    })

    it('RepoMeshFeatures no longer declares a queueSection flag anywhere in web-core', () => {
        const context = read('../../src/context/RepoMeshContext.tsx')
        expect(context).not.toContain('queueSection')
    })

    it('useMeshNodeActions.ts has no queueSection gate and no direct queue load', () => {
        const source = read('../../src/pages/repo-mesh/useMeshNodeActions.ts')
        expect(source).not.toContain('queueSection')
        expect(source).not.toContain('loadQueue')
        // Both post-mutation refresh call sites re-read the coordinator status
        // directly, not behind a conditional.
        const calls = source.split('\n').filter(line => line.includes('await reloadMeshStatus()'))
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
describe('useMeshNodeActions — post-mutation status reload + coordinator-routed writes', () => {
    function harness(overrides: Partial<Parameters<typeof useMeshNodeActions>[0]> = {}) {
        const reloadMeshStatus = vi.fn(async () => {})
        const loadMeshes = vi.fn(async () => {})
        const sendCommand = vi.fn(async () => ({ success: true }))
        const unwrapResult = vi.fn((raw: any) => raw)
        const setError = vi.fn()
        // The list record carries the daemon that happened to LIST it (a member);
        // writes must ignore it and go to the resolved coordinator.
        const mesh: MeshEntry = { id: 'mesh_1', name: 'Test Mesh', nodes: [], __sourceDaemonId: 'daemon_member' } as any

        let latest: ReturnType<typeof useMeshNodeActions> | null = null
        function Harness() {
            latest = useMeshNodeActions({
                selectedMesh: mesh,
                selectedMeshId: mesh.id,
                activeDaemonId: 'daemon_coord',
                daemons: [],
                availableCliProviders: [],
                sendCommand,
                unwrapResult,
                resolveCommandTarget: (() => ({ targetDaemonId: 'daemon_1' })) as any,
                launchCoordinator: (async () => ({ message: 'ok' })) as any,
                features: { addNodeDaemonPicker: false },
                loadMeshes,
                reloadMeshStatus,
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
        return { get hook() { return latest! }, reloadMeshStatus, loadMeshes, sendCommand, setError }
    }

    it('handleRemoveNode re-reads the coordinator status after a successful removal, sent to the coordinator', async () => {
        const harnessResult = harness()
        await act(async () => {
            await harnessResult.hook.handleRemoveNode('node_1')
        })
        expect(harnessResult.reloadMeshStatus).toHaveBeenCalledTimes(1)
        expect(harnessResult.sendCommand).toHaveBeenCalledWith('daemon_coord', 'remove_mesh_node', { meshId: 'mesh_1', nodeId: 'node_1' })
        expect(harnessResult.sendCommand.mock.calls.some(call => (call as unknown[])[0] === 'daemon_member')).toBe(false)
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
        expect(harnessResult.reloadMeshStatus).toHaveBeenCalledTimes(1)
        const addCall = sendCommand.mock.calls.find(call => call[1] === 'add_mesh_node')
        expect(addCall?.[0]).toBe('daemon_coord')
    })

    it('every mesh write (policy / slots / tags / prompts) goes to the coordinator, never the listing daemon', async () => {
        const harnessResult = harness()
        const node = { id: 'node_1', workspace: '/repo' } as any
        await act(async () => {
            await harnessResult.hook.handleUpdatePolicy({ schedulingStrategy: 'in_order' })
            await harnessResult.hook.handleUpdateNodeSlots(node, [])
            await harnessResult.hook.handleUpdateNodeCapabilities(node, ['gpu'])
            await harnessResult.hook.handleSaveCoordinatorPrompt()
            await harnessResult.hook.handleSaveNodeSystemPrompt(node)
        })
        const targets = harnessResult.sendCommand.mock.calls.map(call => (call as unknown[])[0])
        expect(targets.length).toBe(5)
        expect(new Set(targets)).toEqual(new Set(['daemon_coord']))
    })

    it('with no resolved coordinator, a write is refused (error shown) instead of sent anywhere', async () => {
        const harnessResult = harness({ activeDaemonId: '' })
        await act(async () => {
            await harnessResult.hook.handleUpdatePolicy({ schedulingStrategy: 'in_order' })
            await harnessResult.hook.handleRemoveNode('node_1')
        })
        expect(harnessResult.sendCommand).not.toHaveBeenCalled()
        expect(harnessResult.setError).toHaveBeenCalled()
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
