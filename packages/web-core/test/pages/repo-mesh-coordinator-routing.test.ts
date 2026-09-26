/**
 * The mesh pages talk to the COORDINATOR only.
 *
 *  - The queue is read from the coordinator's mesh_status (`queue.tasks`).
 *  - The mesh list fan-out only discovers meshes; each mesh's record is the
 *    host's copy, never "whichever daemon answered first".
 *  - Delete / wizard writes resolve the host from the mesh's pin.
 *  - Node sessions / reachability / providers come from the coordinator's
 *    mesh_status node; member data is a fallback only.
 *  - Node git history is read through the coordinator (mesh_node_git_log);
 *    without a coordinator there is no request at all.
 *  - SessionInfoDialog asks the coordinator (not the session's own daemon) and
 *    takes quota from the coordinator-held node facts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readMeshQueueFromStatus } from '../../src/pages/repo-mesh/useMeshQueue'
import { mergeMeshListAnswers } from '../../src/pages/repo-mesh/useMeshList'
import { resolveMeshHostDaemonId } from '../../src/pages/repo-mesh/host-seed'
import { collectMeshProviderInventory, resolveNodeAvailableProviders } from '../../src/pages/repo-mesh/node-providers'
import { getCoordinatorNodeSessions, readCoordinatorNodeMachineStatus } from '../../src/pages/repo-mesh/node-runtime'
import { groupNodesByMachine } from '../../src/pages/repo-mesh/MeshNodeList'
import { resolveGitLogRequest } from '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers'
import { joinMeshNodeForSession, resolveSessionMeshCoordinatorDaemonId } from '../../src/components/dashboard/session-info-data'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, '../../src', rel), 'utf8')

const daemon = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'adhdev-daemon', ...extra }) as any

describe('queue from the coordinator mesh_status', () => {
    it('reads queue.tasks off the status', () => {
        const queue = readMeshQueueFromStatus({
            meshId: 'm', nodes: [],
            queue: { tasks: [{ id: 't1', message: 'x', status: 'assigned', assignedNodeId: 'n1' }], summary: {} },
        } as any)
        expect(queue.map(task => task.id)).toEqual(['t1'])
    })

    it('an absent queue is an empty (stable) list', () => {
        expect(readMeshQueueFromStatus(null)).toBe(readMeshQueueFromStatus({ meshId: 'm', nodes: [] } as any))
        expect(readMeshQueueFromStatus(null)).toEqual([])
    })
})

describe('mesh list: discovery fan-out, record from the host', () => {
    const hostPinned = (name: string) => ({
        id: 'mesh_1',
        name,
        meshHost: { hostDaemonId: 'daemon_host', hostNodeId: 'node_host' },
        nodes: [{ id: 'node_host', daemon_id: 'daemon_host', workspace: '/r' }],
    }) as any

    it("uses the host daemon's copy even when a member answered first", () => {
        const merged = mergeMeshListAnswers([
            { daemonId: 'daemon_member', meshes: [hostPinned('stale member copy')] },
            { daemonId: 'daemon_host', meshes: [hostPinned('host copy')] },
        ], [daemon('daemon_member'), daemon('daemon_host')])
        expect(merged).toHaveLength(1)
        expect(merged[0].name).toBe('host copy')
    })

    it("falls back to a member's copy only when the host did not answer", () => {
        const merged = mergeMeshListAnswers([
            { daemonId: 'daemon_member', meshes: [hostPinned('member copy')] },
        ], [daemon('daemon_member'), daemon('daemon_host')])
        expect(merged[0].name).toBe('member copy')
    })

    it('resolveMeshHostDaemonId: pin → connected equivalent id; synthesized pin → unresolved; single daemon → it', () => {
        expect(resolveMeshHostDaemonId(hostPinned('x'), [daemon('daemon_member'), daemon('daemon_host')])).toBe('daemon_host')
        expect(resolveMeshHostDaemonId({ meshHost: { hostDaemonId: 'daemon_member', hostSynthesized: true }, nodes: [] } as any,
            [daemon('daemon_member'), daemon('daemon_host')])).toBe('')
        expect(resolveMeshHostDaemonId({ nodes: [] } as any, [daemon('only')])).toBe('only')
    })

    it('no __sourceDaemonId routing survives in the mesh hooks / wizard', () => {
        for (const file of ['pages/repo-mesh/useMeshList.ts', 'pages/repo-mesh/useMeshNodeActions.ts', 'components/setup-wizard/SetupWizard.tsx']) {
            expect(read(file)).not.toContain('__sourceDaemonId')
        }
    })
})

describe('node runtime from the coordinator', () => {
    const statusNode = {
        nodeId: 'node_remote',
        workspace: '/remote',
        daemonId: 'daemon_remote',
        machineLabel: 'remote',
        health: 'online',
        providers: [],
        activeSessions: ['s1'],
        activeSessionDetails: [{ sessionId: 's1', providerType: 'codex-cli', state: 'generating', chatStatus: 'generating' }],
        connection: { state: 'failed' },
        gitObservation: { source: 'member_push', observedAt: 1, refreshing: false, unreachableSince: 5 },
        providerVersions: { 'codex-cli': '1.2.3' },
        nodeFacts: { schemaVersion: 1, reportedAt: 1, machineNickname: 'Remote Box', providerEnablement: { 'codex-cli': { enabled: true, quotaEnabled: true } } },
    } as any
    const listNode = { id: 'node_remote', daemon_id: 'daemon_remote', workspace: '/remote', status: 'enabled' } as any

    it('sessions come from the coordinator node, not the connected daemon session lists', () => {
        expect(getCoordinatorNodeSessions(statusNode)).toEqual([{ id: 's1', provider: 'codex-cli', status: 'generating' }])
        expect(read('pages/repo-mesh/MeshMachineNodeGroup.tsx')).not.toContain('cliSessions')
    })

    it("reachability uses the coordinator's view (unreachableSince / connection), overriding the member daemon status", () => {
        expect(readCoordinatorNodeMachineStatus(statusNode)).toBe('offline')
        expect(readCoordinatorNodeMachineStatus({ ...statusNode, machineStatus: 'online' })).toBe('online')
        expect(readCoordinatorNodeMachineStatus({ nodeId: 'x' } as any)).toBeNull()
        // The member daemon says online; the coordinator says unreachable → offline tab dot.
        const groups = groupNodesByMachine([listNode], [daemon('daemon_remote', { status: 'online' })], [statusNode])
        expect(groups[0]).toMatchObject({ online: false, label: 'Remote Box' })
        // No coordinator answer → member daemon status is the fallback.
        expect(groupNodesByMachine([listNode], [daemon('daemon_remote', { status: 'online' })], [])[0].online).toBe(true)
    })

    it('provider inventory: coordinator-detected set wins; member data only decorates / falls back', () => {
        const memberInventory = new Map([['daemon_remote', [
            { type: 'codex-cli', label: 'Codex', statusLabel: 'Detected on this machine' },
            { type: 'claude-cli', label: 'Claude', statusLabel: 'Detected on this machine' },
        ]]])
        // Coordinator says only codex is detected there → member's claude is dropped.
        expect(resolveNodeAvailableProviders(listNode, memberInventory, statusNode).map(p => p.type)).toEqual(['codex-cli'])
        expect(resolveNodeAvailableProviders(listNode, memberInventory, statusNode)[0].label).toBe('Codex')
        // Coordinator silent → member inventory as before.
        expect(resolveNodeAvailableProviders(listNode, memberInventory, null).map(p => p.type)).toEqual(['codex-cli', 'claude-cli'])
        // Coordinator knows, member has nothing → still rendered from the coordinator.
        expect(resolveNodeAvailableProviders(listNode, new Map(), statusNode).map(p => p.type)).toEqual(['codex-cli'])
        // A held inventory on the coordinator wins outright.
        const held = { ...statusNode, nodeFacts: { ...statusNode.nodeFacts, availableProviders: [{ type: 'kimi', category: 'cli', installed: true, displayName: 'Kimi' }] } }
        expect(resolveNodeAvailableProviders(listNode, memberInventory, held).map(p => p.type)).toEqual(['kimi'])
    })

    it('auto-approve inventory prefers the coordinator-held provider list (autoApproveModes ride along)', () => {
        const held = { ...statusNode, heldRuntime: { source: 'member_push', observedAt: 1, refreshing: false, sessions: [], availableProviders: [{ type: 'kimi', category: 'cli', autoApproveModes: ['yolo'] }] } }
        const inventory = collectMeshProviderInventory([listNode], [daemon('daemon_remote', { availableProviders: [{ type: 'codex-cli', category: 'cli' }] })], [held])
        expect(inventory.providers.map(p => p.type)).toEqual(['kimi'])
        expect(inventory.providers[0].autoApproveModes).toEqual(['yolo'])
        // Without a held list, the member's inventory is the fallback.
        const fallback = collectMeshProviderInventory([listNode], [daemon('daemon_remote', { availableProviders: [{ type: 'codex-cli', category: 'cli' }] })], [statusNode])
        expect(fallback.providers.map(p => p.type)).toEqual(['codex-cli'])
    })
})

describe('node git history / heal go through the coordinator only', () => {
    const selectedNodeStatus = { nodeId: 'node_peer', daemonId: 'daemon_peer', workspace: '/remote/repo', providers: [], activeSessions: [] } as any

    it('with a coordinator → mesh_node_git_log to the coordinator', () => {
        expect(resolveGitLogRequest({ coordinatorDaemonId: 'coord', selectedNodeStatus, selectedSessionEntry: null, selectedGraphNode: null }))
            .toEqual({ daemonId: 'coord', workspace: '/remote/repo', nodeId: 'node_peer' })
    })

    it("without a coordinator → no request (never the node's own daemon)", () => {
        expect(resolveGitLogRequest({ coordinatorDaemonId: null, selectedNodeStatus, selectedSessionEntry: null, selectedGraphNode: null })).toBeNull()
        const surface = read('components/MeshGraph/MeshObservabilitySurface.tsx')
        expect(surface).toContain('const selectedHealDaemonId = daemonId || null')
        expect(surface).not.toContain("'git_log'")
    })
})

describe('SessionInfoDialog asks the coordinator', () => {
    const workerConv = { settings: { meshNodeFor: 'm', meshNodeId: 'node_w', meshCoordinatorDaemonId: 'coord_stamp' } } as any

    it('resolves the coordinator — never the session (member) daemon for a worker', () => {
        expect(resolveSessionMeshCoordinatorDaemonId({ conv: workerConv, sessionDaemonId: 'member' })).toBe('coord_stamp')
        expect(resolveSessionMeshCoordinatorDaemonId({ conv: workerConv, sessionDaemonId: 'member', heldCoordinatorDaemonId: 'coord_held' })).toBe('coord_held')
        expect(resolveSessionMeshCoordinatorDaemonId({ conv: { settings: { meshNodeFor: 'm' } } as any, sessionDaemonId: 'member', reportedCoordinatorDaemonId: 'coord_rep' })).toBe('coord_rep')
        expect(resolveSessionMeshCoordinatorDaemonId({ conv: { settings: { meshNodeFor: 'm' } } as any, sessionDaemonId: 'member' })).toBeNull()
        // The coordinator's own session: its daemon IS the coordinator.
        expect(resolveSessionMeshCoordinatorDaemonId({ conv: { coordinator: { meshId: 'm' } } as any, sessionDaemonId: 'coord' })).toBe('coord')
        const dialog = read('components/dashboard/SessionInfoDialog.tsx')
        expect(dialog).not.toContain('loadMeshStatus(daemonId, meshId')
    })

    it('joins the node quota from the coordinator-held facts', () => {
        const quota = { 'claude-cli': { provider: 'claude-cli', status: 'ok', session: null, weekly: null, updatedAt: 1, error: null } }
        const joined = joinMeshNodeForSession({
            meshId: 'm', meshName: 'M', repoIdentity: 'r', refreshedAt: '2026-09-27T00:00:00.000Z',
            nodes: [{ nodeId: 'node_w', workspace: '/w', machineLabel: 'w', health: 'online', providers: [], activeSessions: [], nodeFacts: { schemaVersion: 1, reportedAt: 1, quota } }],
        }, 'node_w')
        expect(joined?.quota).toEqual(quota)
    })
})

describe('RepoMesh.tsx — coordinator-only triggers, refresh:false on automatic reads', () => {
    const source = read('pages/RepoMesh.tsx')

    it('the revision hook watches the coordinator daemon only (no member daemon ids)', () => {
        const start = source.indexOf('useMeshStateRevisionRefresh({')
        const block = source.slice(start, source.indexOf('onRevisionAdvance', start))
        expect(block).toContain('[resolvedActiveDaemonId].filter(Boolean)')
        expect(source).not.toContain('meshNodeDaemonIds')
        expect(source).not.toContain('extraDaemonIds')
    })

    it('background / revision / mesh-switch reads are refresh:false; only the Refresh button is refresh:true', () => {
        expect(source).toContain('void Promise.resolve(loadGraphRef.current(resolvedActiveDaemonId, selectedMeshId, false))')
        expect(source).toContain('void loadGraph(resolvedActiveDaemonId, selectedMeshId, false)')
        const trueCalls = source.split('\n').filter(line => /loadGraph(Ref\.current)?\([^)]*,\s*true\)/.test(line))
        expect(trueCalls).toHaveLength(1)
        const refreshButton = source.slice(source.indexOf('onRefreshGraph={() => {'), source.indexOf('onRefreshGraph={() => {') + 200)
        expect(refreshButton).toContain('void loadGraph(resolvedActiveDaemonId, selectedMeshId, true)')
    })

    it('the page graph loader has no settle/retry escalation of its own', () => {
        const graphHook = read('pages/repo-mesh/useMeshGraph.ts')
        expect(graphHook).toContain('loadCoordinatorMeshStatus({')
        expect(graphHook).not.toContain('settledReloadInFlight')
        expect(graphHook).not.toContain('retryProfile')
    })
})
