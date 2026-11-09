/**
 * Pull-adopt: a worktree node that lives only on a MEMBER daemon (cloned after the
 * member's once-per-coordinator-boot report, or via the MCP clone that goes straight to
 * the member) must not be dispatched to blind from the host.
 *
 *  - mesh_dispatch_route no longer trusts the caller's description of a node the host
 *    roster lacks: it asks the claimed owner, adopts the node durably (owner-gated), or
 *    refuses with a clear error.
 *  - mesh_adopt_member_worktree does the same right after a remote clone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { DaemonCommandRouter } from '../../src/commands/router'

const COORD = 'daemon-coordinator'
const REMOTE = 'daemon-remote'
const WT_ID = 'node_member_only_worktree'
const WT_WORKSPACE = '/nonexistent/remote/wt/direct-target'

function createRouter(dispatchMeshCommand: any) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []), resolveHostBootId: () => 'fixture-host-boot' } as any,
    statusInstanceId: COORD,
    dispatchMeshCommand,
  } as any) as any
}

function ownedNode(overrides: Record<string, unknown> = {}) {
  return {
    id: WT_ID, workspace: WT_WORKSPACE, repoRoot: WT_WORKSPACE, daemonId: REMOTE, machineId: 'machine-remote',
    isLocalWorktree: true, worktreeBranch: 'direct-target', clonedFromNodeId: 'node_base', userOverrides: {}, policy: {},
    ...overrides,
  }
}

let configDir = ''
let previousConfigDir: string | undefined
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'pull-adopt-'))
  previousConfigDir = process.env.ADHDEV_CONFIG_DIR
  process.env.ADHDEV_CONFIG_DIR = configDir
})
afterEach(async () => {
  resetMeshRuntimeStore()
  if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
  await cleanupTempDir(configDir)
})

async function seedMesh() {
  const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
  const mesh = createMesh({ name: 'Pull Adopt Mesh', repoIdentity: 'github.com/acme/pull-adopt', defaultBranch: 'main', hostDaemonId: COORD })
  addNode(mesh.id, { id: 'node_coord', workspace: '/nonexistent/coord/main', repoRoot: '/nonexistent/coord/main', daemonId: COORD } as any)
  addNode(mesh.id, { id: 'node_base', workspace: '/nonexistent/remote/main', repoRoot: '/nonexistent/remote/main', daemonId: REMOTE, machineId: 'machine-remote' } as any)
  return mesh.id
}

async function configNodeIds(meshId: string): Promise<string[]> {
  const { getMesh } = await import('../../src/config/mesh-config.js')
  return (getMesh(meshId)?.nodes ?? []).map((n: any) => n.id)
}

const ownerAnswers = (nodes: unknown[]) => vi.fn(async (_d: string, command: string) =>
  command === 'mesh_member_worktree_nodes' ? { success: true, nodes } : { success: false })

describe('mesh_dispatch_route — a node the host roster lacks', () => {
  it('learns the node from its owner, persists it, and routes it remote (never blind)', async () => {
    const meshId = await seedMesh()
    const dispatch = ownerAnswers([ownedNode()])
    const router = createRouter(dispatch)

    const route: any = await router.execute('mesh_dispatch_route', {
      meshId, nodeId: WT_ID, node: { id: WT_ID, daemonId: REMOTE, workspace: WT_WORKSPACE },
    }, 'ipc')

    expect(route).toMatchObject({ success: true, route: 'remote', ownerDaemonId: REMOTE })
    expect(dispatch.mock.calls[0][0]).toBe(REMOTE)
    expect(await configNodeIds(meshId)).toContain(WT_ID)
  })

  it('refuses (mesh_node_unknown, actionable) when the claimed owner does not hold the node', async () => {
    const meshId = await seedMesh()
    const router = createRouter(ownerAnswers([]))
    const route: any = await router.execute('mesh_dispatch_route', {
      meshId, nodeId: WT_ID, node: { id: WT_ID, daemonId: REMOTE, workspace: WT_WORKSPACE },
    }, 'ipc')
    expect(route).toMatchObject({ success: false, code: 'mesh_node_unknown' })
    expect(route.error).toContain('owner_does_not_own_node')
    expect(typeof route.action).toBe('string')
    expect(await configNodeIds(meshId)).not.toContain(WT_ID)
  })

  it('refuses when the caller names no owner (no trust in the description alone)', async () => {
    const meshId = await seedMesh()
    const dispatch = ownerAnswers([ownedNode()])
    const router = createRouter(dispatch)
    const route: any = await router.execute('mesh_dispatch_route', { meshId, nodeId: WT_ID, node: { id: WT_ID, workspace: WT_WORKSPACE } }, 'ipc')
    expect(route).toMatchObject({ success: false, code: 'mesh_node_unknown' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not adopt a record the owner does not own, nor from a daemon that is not a mesh member', async () => {
    const meshId = await seedMesh()
    // Owner answers with a node claiming a third daemon.
    let router = createRouter(ownerAnswers([ownedNode({ daemonId: 'daemon-other' })]))
    let route: any = await router.execute('mesh_dispatch_route', { meshId, nodeId: WT_ID, node: { id: WT_ID, daemonId: REMOTE } }, 'ipc')
    expect(route.success).toBe(false)
    // A daemon with no node on this roster is never asked, let alone trusted.
    const dispatch = ownerAnswers([ownedNode({ daemonId: 'daemon-stranger' })])
    router = createRouter(dispatch)
    route = await router.execute('mesh_dispatch_route', { meshId, nodeId: WT_ID, node: { id: WT_ID, daemonId: 'daemon-stranger' } }, 'ipc')
    expect(route).toMatchObject({ success: false, code: 'mesh_node_unknown' })
    expect(route.error).toContain('owner_not_a_mesh_member')
    expect(dispatch).not.toHaveBeenCalled()
    expect(await configNodeIds(meshId)).not.toContain(WT_ID)
  })

  it('a rostered node routes as before without asking anyone', async () => {
    const meshId = await seedMesh()
    const dispatch = ownerAnswers([])
    const router = createRouter(dispatch)
    const route: any = await router.execute('mesh_dispatch_route', { meshId, nodeId: 'node_base' }, 'ipc')
    expect(route).toMatchObject({ success: true, route: 'remote' })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('mesh_adopt_member_worktree / mesh_member_worktree_nodes', () => {
  it('adopts right after a remote clone, and a mesh peer cannot invoke the tool-side command', async () => {
    const meshId = await seedMesh()
    const router = createRouter(ownerAnswers([ownedNode()]))
    const adopted: any = await router.execute('mesh_adopt_member_worktree', { meshId, nodeId: WT_ID, ownerDaemonId: REMOTE }, 'ipc')
    expect(adopted).toMatchObject({ success: true, adopted: true, nodeId: WT_ID })
    expect(await configNodeIds(meshId)).toContain(WT_ID)
    const viaMesh: any = await router.execute('mesh_adopt_member_worktree', { meshId, nodeId: WT_ID, ownerDaemonId: REMOTE }, 'mesh')
    expect(viaMesh.success).toBe(false)
  })

  it('the member lists only the worktree nodes it owns', async () => {
    const meshId = await seedMesh()
    const { addNode } = await import('../../src/config/mesh-config.js')
    addNode(meshId, { ...ownedNode({ id: 'node_mine', workspace: '/nonexistent/coord/wt', daemonId: COORD }) } as any)
    addNode(meshId, { ...ownedNode({ id: 'node_theirs', workspace: '/nonexistent/other/wt', daemonId: REMOTE }) } as any)
    const router = createRouter(vi.fn())
    const answer: any = await router.readOwnWorktreeNodes(meshId)
    expect(answer.map((n: any) => n.id)).toEqual(['node_mine'])
  })
})
