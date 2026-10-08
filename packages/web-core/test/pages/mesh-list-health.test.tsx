// @vitest-environment jsdom
//
// /mesh list card machine health. A real two-machine standalone mesh (Mac host,
// Linux member over Tailscale) showed "0/1 machines online" with a red dot
// while the detail view showed the member connected: the card read online
// state only from the dashboard's daemon list (standalone: just the local
// daemon), and the host's own node — which carries no daemon binding on
// standalone — was dropped as an "ungrouped" key. Health now comes from the
// coordinator's mesh_status nodes (shared store / mesh.status push).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoMeshNodeStatus, RepoMeshStatus } from '@adhdev/daemon-core'
import { MeshListView } from '../../src/pages/repo-mesh/MeshListView'
import { summarizeMeshListMachineHealth } from '../../src/pages/repo-mesh/mesh-list-health'
import { primeCoordinatorMeshStatus, resetCoordinatorMeshStatusStore } from '../../src/utils/coordinator-mesh-status-store'
import type { MeshEntry, MeshNode } from '../../src/pages/repo-mesh/types'

const HOST = 'standalone_mach_host'
const MEMBER = 'standalone_mach_linux'

// Standalone list_meshes nodes: the host's own checkout has no daemon binding,
// the paired member's node carries its daemon id.
const standaloneNodes = [
    { id: 'node_host', workspace: '/Users/me/repo' },
    { id: 'node_member', workspace: '/home/me/repo', daemonId: MEMBER },
] as unknown as MeshNode[]

const standaloneStatus = (memberState: 'connected' | 'disconnected') => [
    { nodeId: 'node_host', connection: { state: 'self' } },
    { nodeId: 'node_member', daemonId: MEMBER, connection: { state: memberState } },
] as unknown as RepoMeshNodeStatus[]

const connectedStatus = () => ({ meshId: 'mesh_1', nodes: standaloneStatus('connected') }) as unknown as RepoMeshStatus

describe('summarizeMeshListMachineHealth', () => {
    it('standalone: member known only to the coordinator counts online, host node counted', () => {
        expect(summarizeMeshListMachineHealth({
            nodes: standaloneNodes,
            daemons: [{ id: HOST, status: 'online' }],
            statusNodes: standaloneStatus('connected'),
            hostDaemonId: HOST,
        })).toEqual({ total: 2, online: 2 })
    })

    it('standalone: a disconnected member reads offline from the coordinator', () => {
        expect(summarizeMeshListMachineHealth({
            nodes: standaloneNodes,
            daemons: [{ id: HOST, status: 'online' }],
            statusNodes: standaloneStatus('disconnected'),
            hostDaemonId: HOST,
        })).toEqual({ total: 2, online: 1 })
    })

    it('standalone before the status lands: host from the daemon list, member unknown', () => {
        expect(summarizeMeshListMachineHealth({
            nodes: standaloneNodes,
            daemons: [{ id: HOST, status: 'online' }],
            statusNodes: null,
            hostDaemonId: HOST,
        })).toEqual({ total: 2, online: 1 })
    })

    it('worktree clones are not machines', () => {
        const nodes = [...standaloneNodes, { id: 'node_wt', workspace: '/tmp/wt', isLocalWorktree: true }] as unknown as MeshNode[]
        expect(summarizeMeshListMachineHealth({ nodes, daemons: [{ id: HOST }], statusNodes: standaloneStatus('connected'), hostDaemonId: HOST }).total).toBe(2)
    })

    it('cloud: every node bound, daemon list holds every machine (no status yet) — unchanged', () => {
        const nodes = [
            { id: 'n1', workspace: '/a', daemon_id: 'daemon_mach_a' },
            { id: 'n2', workspace: '/b', daemon_id: 'daemon_mach_b' },
            { id: 'n3', workspace: '/b2', daemon_id: 'daemon_mach_b' },
        ] as unknown as MeshNode[]
        const daemons = [
            { id: 'daemon_mach_a', status: 'online' },
            { id: 'daemon_mach_b', status: 'offline' },
        ]
        expect(summarizeMeshListMachineHealth({ nodes, daemons, statusNodes: null, hostDaemonId: 'daemon_mach_a' }))
            .toEqual({ total: 2, online: 1 })
    })

    it('cloud: coordinator status wins over a stale daemon entry; id forms of one machine merge', () => {
        const nodes = [
            { id: 'n1', workspace: '/a', daemon_id: 'daemon_mach_a' },
            { id: 'n2', workspace: '/b', daemon_id: 'mach_b' },
            { id: 'n3', workspace: '/b2', daemon_id: 'daemon_mach_b' },
        ] as unknown as MeshNode[]
        const daemons = [
            { id: 'daemon_mach_a', status: 'online' },
            { id: 'daemon_mach_b', status: 'offline' },
        ]
        const statusNodes = [
            { nodeId: 'n1', connection: { state: 'self' } },
            { nodeId: 'n2', connection: { state: 'connected' } },
        ] as unknown as RepoMeshNodeStatus[]
        expect(summarizeMeshListMachineHealth({ nodes, daemons, statusNodes, hostDaemonId: 'daemon_mach_a' }))
            .toEqual({ total: 2, online: 2 })
    })
})

describe('MeshListView card (standalone)', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => {
        resetCoordinatorMeshStatusStore()
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
        resetCoordinatorMeshStatusStore()
    })

    const mesh = { id: 'mesh_1', name: 'two-machines', repoIdentity: 'github.com/acme/repo', nodes: standaloneNodes, createdAt: '', updatedAt: '' } as MeshEntry

    function render(sendData = vi.fn().mockReturnValue(true)) {
        const noop = () => {}
        act(() => {
            root.render(
                <MeshListView
                    meshes={[mesh]}
                    loading={false}
                    error={null}
                    onDismissError={noop}
                    daemons={[{ id: HOST, status: 'online' }]}
                    features={{ createDaemonPicker: false }}
                    showCreate={false}
                    onToggleCreate={noop}
                    createName=""
                    onCreateNameChange={noop}
                    createRepoIdentity=""
                    onCreateRepoIdentityChange={noop}
                    createRepoRemoteUrl=""
                    onCreateRepoRemoteUrlChange={noop}
                    newMeshDaemonId=""
                    onNewMeshDaemonIdChange={noop}
                    newMeshWorkspace=""
                    onNewMeshWorkspaceChange={noop}
                    createPickerWorkspaces={[]}
                    createOnboardingPlan={null}
                    createPlanLoading={false}
                    creating={false}
                    createWarning={null}
                    onDismissCreateWarning={noop}
                    onSelectMesh={noop}
                    onCreate={noop}
                    onCancelCreate={noop}
                    sendData={sendData}
                />,
            )
        })
        return sendData
    }

    it('shows the coordinator-reported member as online (2/2, green)', () => {
        primeCoordinatorMeshStatus('mesh_1', connectedStatus(), HOST)
        const sendData = render()
        expect(container.textContent).toContain('2/2 machines online')
        expect(container.querySelector('.bg-green-400')).not.toBeNull()
        // The card subscribes to the coordinator's mesh.status push (no polling read).
        expect(sendData.mock.calls.some(([daemonId, data]) => daemonId === HOST && data?.topic === 'mesh.status' && data?.params?.meshId === 'mesh_1')).toBe(true)
    })

    it('a status push that arrives later updates the card', () => {
        render()
        expect(container.textContent).toContain('1/2 machines online')
        act(() => primeCoordinatorMeshStatus('mesh_1', connectedStatus(), HOST))
        expect(container.textContent).toContain('2/2 machines online')
    })
})
