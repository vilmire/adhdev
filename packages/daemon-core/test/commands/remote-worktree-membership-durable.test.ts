/**
 * Coordinator-held membership of REMOTE worktree nodes (owner principle: clients
 * talk only to the coordinator daemon, which holds every node).
 *
 *  - REMOTE-CLONE-DURABLE: a clone forwarded to another machine is persisted into
 *    the coordinator's meshes.json (not only its in-memory inline cache), so a
 *    coordinator restart does not leave the node known only to the member.
 *  - MEMBER-WORKTREE-RECONCILE: a member's state push lists the worktree nodes it
 *    owns once per coordinator boot; the coordinator adopts the ones it lost,
 *    owner-gated, and never resurrects a removed node.
 *
 * A "restart" is a fresh DaemonCommandRouter over the same config dir: the inline
 * cache and removal tombstones are per-process, meshes.json is what survives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { DaemonCommandRouter } from '../../src/commands/router'
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender'
import { MeshNodeStatePusher } from '../../src/mesh/mesh-node-state-pusher'

const COORD = 'daemon-coordinator'
const REMOTE = 'daemon-remote'
const WT_ID = 'node_remote_worktree'
const WT_WORKSPACE = '/nonexistent/remote/wt/feature-x'

function createRouter(dispatchMeshCommand: any = vi.fn(() => new Promise<unknown>(() => {}))) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    statusInstanceId: COORD,
    dispatchMeshCommand,
  } as any) as any
}

function remoteWorktreeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: WT_ID,
    workspace: WT_WORKSPACE,
    repoRoot: WT_WORKSPACE,
    daemonId: REMOTE,
    machineId: 'machine-remote',
    machineNickname: 'remote-box',
    userOverrides: {},
    policy: { providerPriority: ['claude-cli'] },
    isLocalWorktree: true,
    worktreeBranch: 'feature-x',
    clonedFromNodeId: 'node_base',
    worktreeBootstrap: { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  }
}

let configDir = ''
let previousConfigDir: string | undefined

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'remote-wt-membership-'))
  previousConfigDir = process.env.ADHDEV_CONFIG_DIR
  process.env.ADHDEV_CONFIG_DIR = configDir
})

afterEach(async () => {
  resetMeshRuntimeStore()
  if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
  await cleanupTempDir(configDir)
})

/** Coordinator config: a mesh hosted here whose base node lives on the REMOTE machine. */
async function seedCoordinatorMesh(opts: { role?: 'host' | 'member' } = {}) {
  const { createMesh, addNode, updateMesh } = await import('../../src/config/mesh-config.js')
  const mesh = createMesh({ name: 'Remote WT Mesh', repoIdentity: 'github.com/acme/remote-wt', defaultBranch: 'main', hostDaemonId: COORD })
  addNode(mesh.id, { id: 'node_coord', workspace: '/nonexistent/coord/main', repoRoot: '/nonexistent/coord/main', daemonId: COORD } as any)
  addNode(mesh.id, { id: 'node_base', workspace: '/nonexistent/remote/main', repoRoot: '/nonexistent/remote/main', daemonId: REMOTE, machineId: 'machine-remote' } as any)
  if (opts.role === 'member') updateMesh(mesh.id, { meshHost: { ...(mesh.meshHost as any), role: 'member', hostDaemonId: 'daemon-elsewhere' } })
  return mesh.id
}

async function configNodeIds(meshId: string): Promise<string[]> {
  const { getMesh } = await import('../../src/config/mesh-config.js')
  return (getMesh(meshId)?.nodes ?? []).map((n: any) => n.id)
}

async function rosterAfterRestart(meshId: string): Promise<string[]> {
  const restarted = createRouter()
  const record = await restarted.getMeshForCommand(meshId, undefined, { preferInline: true })
  return (record?.mesh?.nodes ?? []).map((n: any) => n.id)
}

function report(router: any, meshId: string, extra: Record<string, unknown>, sender = REMOTE) {
  return router.execute('mesh_node_git_report', {
    meshId,
    nodeId: 'node_base',
    workspace: '/nonexistent/remote/main',
    runtime: { daemonId: REMOTE, sessions: [] },
    runtimeObservedAt: Date.now(),
    [MESH_SENDER_DAEMON_ID_ARG]: sender,
    ...extra,
  }, 'mesh') as Promise<any>
}

describe('REMOTE-CLONE-DURABLE — a forwarded clone is persisted on the coordinator', () => {
  it('survives a simulated coordinator restart, with the member identity (not the coordinator nickname)', async () => {
    const meshId = await seedCoordinatorMesh()
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, async: true, status: 'accepted', node: remoteWorktreeNode() }))
    const router = createRouter(dispatchMeshCommand)

    const result = await router.execute('clone_mesh_node', { meshId, sourceNodeId: 'node_base', branch: 'feature-x' })
    expect(result?.success).toBe(true)
    expect(dispatchMeshCommand.mock.calls[0][0]).toBe(REMOTE)

    const { getMesh } = await import('../../src/config/mesh-config.js')
    const persisted: any = getMesh(meshId)?.nodes.find((n: any) => n.id === WT_ID)
    expect(persisted).toMatchObject({
      daemonId: REMOTE,
      machineId: 'machine-remote',
      machineNickname: 'remote-box',
      isLocalWorktree: true,
      worktreeBranch: 'feature-x',
      workspace: WT_WORKSPACE,
      policy: { providerPriority: ['claude-cli'] },
    })

    // The restarted coordinator knows the node with zero member calls.
    expect(await rosterAfterRestart(meshId)).toContain(WT_ID)
  })

  it('is idempotent (a repeated persist neither duplicates nor fails)', async () => {
    const meshId = await seedCoordinatorMesh()
    const router = createRouter()
    expect(await router.persistRemoteClonedWorktreeNode(meshId, remoteWorktreeNode())).toBe('persisted')
    expect(await router.persistRemoteClonedWorktreeNode(meshId, remoteWorktreeNode())).toBe('already_present')
    expect((await configNodeIds(meshId)).filter(id => id === WT_ID)).toHaveLength(1)
  })

  it('a removed node is not resurrected by a late bootstrap event or a late clone reply, before or after restart', async () => {
    const meshId = await seedCoordinatorMesh()
    const dispatchMeshCommand = vi.fn(async (_daemonId: string, command: string) => command === 'clone_mesh_node'
      ? { success: true, async: true, status: 'accepted', node: remoteWorktreeNode() }
      : { success: true, removed: true, worktreeCleanup: { success: true } })
    const router = createRouter(dispatchMeshCommand)
    await router.execute('clone_mesh_node', { meshId, sourceNodeId: 'node_base', branch: 'feature-x' })
    expect(await configNodeIds(meshId)).toContain(WT_ID)

    const removed: any = await router.execute('remove_mesh_node', { meshId, nodeId: WT_ID })
    expect(removed.success).toBe(true)
    expect(await configNodeIds(meshId)).not.toContain(WT_ID)

    // Late one-shot events for the removed node.
    router.markWorktreeBootstrapTerminalState(meshId, WT_ID, 'complete', { workspace: WT_WORKSPACE, daemonId: REMOTE })
    expect(await router.persistRemoteClonedWorktreeNode(meshId, remoteWorktreeNode())).toBe('tombstoned')
    await new Promise(resolve => setTimeout(resolve, 20)) // the terminal stamp's detached config chain
    expect(await configNodeIds(meshId)).not.toContain(WT_ID)
    expect(await rosterAfterRestart(meshId)).not.toContain(WT_ID)
  })
})

describe('MEMBER-WORKTREE-RECONCILE — the coordinator adopts worktree nodes a member reports', () => {
  it('adopts a sender-owned worktree node it lost, persists it, and holds it across a restart', async () => {
    const meshId = await seedCoordinatorMesh()
    const router = createRouter()
    const ack = await report(router, meshId, { memberWorktreeNodes: [remoteWorktreeNode()] })
    expect(ack).toMatchObject({ success: true, accepted: true, worktreeNodesReconciled: true, adoptedNodeIds: [WT_ID] })
    expect(typeof ack.coordinatorBootId).toBe('string')
    expect(await configNodeIds(meshId)).toContain(WT_ID)
    expect(await rosterAfterRestart(meshId)).toContain(WT_ID)

    // A repeat report is a no-op (idempotent).
    const again = await report(router, meshId, { memberWorktreeNodes: [remoteWorktreeNode()] })
    expect(again.adoptedNodeIds).toBeUndefined()
    expect((await configNodeIds(meshId)).filter(id => id === WT_ID)).toHaveLength(1)
  })

  it('adopts ONLY owner-gated worktree nodes', async () => {
    const meshId = await seedCoordinatorMesh()
    const router = createRouter()
    const ack = await report(router, meshId, {
      memberWorktreeNodes: [
        remoteWorktreeNode(),
        // Owned by a third daemon — the sender cannot vouch for it.
        remoteWorktreeNode({ id: 'node_foreign_wt', workspace: '/nonexistent/foreign/wt', daemonId: 'daemon-other' }),
        // Claims the coordinator's own daemon.
        remoteWorktreeNode({ id: 'node_claims_coord', workspace: '/nonexistent/claims/coord', daemonId: COORD }),
        // Not a worktree (a base node is never adopted from a member report).
        remoteWorktreeNode({ id: 'node_not_worktree', workspace: '/nonexistent/remote/base2', isLocalWorktree: false }),
        // Same workspace + owner as a node the coordinator already holds under another id.
        remoteWorktreeNode({ id: 'node_dup_workspace', workspace: '/nonexistent/remote/main' }),
      ],
    })
    expect(ack.adoptedNodeIds).toEqual([WT_ID])
    const ids = await configNodeIds(meshId)
    expect(ids).toContain(WT_ID)
    for (const rejected of ['node_foreign_wt', 'node_claims_coord', 'node_not_worktree', 'node_dup_workspace']) {
      expect(ids).not.toContain(rejected)
    }
  })

  it('a daemon that does not host the mesh adopts nothing', async () => {
    const meshId = await seedCoordinatorMesh({ role: 'member' })
    const router = createRouter()
    const ack = await report(router, meshId, { memberWorktreeNodes: [remoteWorktreeNode()] })
    expect(ack.success).toBe(true)
    expect(ack.adoptedNodeIds).toBeUndefined()
    expect(await configNodeIds(meshId)).not.toContain(WT_ID)
  })

  it('a stale report that raced a removal does not resurrect the removed node', async () => {
    const meshId = await seedCoordinatorMesh()
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, removed: true, worktreeCleanup: { success: true } }))
    const router = createRouter(dispatchMeshCommand)
    await report(router, meshId, { memberWorktreeNodes: [remoteWorktreeNode()] })
    const removed: any = await router.execute('remove_mesh_node', { meshId, nodeId: WT_ID })
    expect(removed.success).toBe(true)

    const stale = await report(router, meshId, { memberWorktreeNodes: [remoteWorktreeNode()] })
    expect(stale.adoptedNodeIds).toBeUndefined()
    expect(await configNodeIds(meshId)).not.toContain(WT_ID)
  })

  it('opens a bootstrap gate the coordinator still holds running when the member reports it complete', async () => {
    const meshId = await seedCoordinatorMesh()
    const router = createRouter()
    await router.persistRemoteClonedWorktreeNode(meshId, remoteWorktreeNode())
    const ack = await report(router, meshId, {
      memberWorktreeNodes: [remoteWorktreeNode({ worktreeBootstrap: { status: 'complete', completedAt: '2026-01-01T00:05:00.000Z' } })],
    })
    expect(ack.bootstrapHealedNodeIds).toEqual([WT_ID])
    await new Promise(resolve => setTimeout(resolve, 20))
    const { getMesh } = await import('../../src/config/mesh-config.js')
    expect((getMesh(meshId)?.nodes.find((n: any) => n.id === WT_ID) as any)?.worktreeBootstrap?.status).toBe('complete')
  })
})

describe('MEMBER-WORKTREE-RECONCILE — member pusher reports its worktree nodes once per coordinator boot', () => {
  it('carries the list on the first push, not again for the same boot id, and again after the coordinator restarts', async () => {
    let bootId = 'boot-1'
    const sent: any[] = []
    const pusher = new MeshNodeStatePusher({
      dispatch: async (_daemonId, _cmd, args) => {
        sent.push(args)
        return { success: true, accepted: true, coordinatorBootId: bootId }
      },
      readGit: async () => ({ isGitRepo: true, branch: 'main', headCommit: 'abc', lastCheckedAt: Date.now() }),
      readWorktreeNodes: async () => [remoteWorktreeNode(), { id: 'not-a-worktree', workspace: '/x', daemonId: REMOTE }],
      startTimer: () => ({ stop() {} }),
      heartbeatMs: 0,
    })
    pusher.register({ coordinatorDaemonId: COORD, meshId: 'mesh_a', nodeId: 'node_base', workspace: '/nonexistent/remote/main' })

    await pusher.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].memberWorktreeNodes.map((n: any) => n.id)).toEqual([WT_ID])

    await pusher.tick()
    expect(sent).toHaveLength(2)
    expect(sent[1].memberWorktreeNodes).toBeUndefined()

    // The coordinator restarted: the next plain push sees a new boot id and one
    // follow-up push re-reports the list right away.
    bootId = 'boot-2'
    await pusher.tick()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent[2].memberWorktreeNodes).toBeUndefined()
    expect(sent).toHaveLength(4)
    expect(sent[3].memberWorktreeNodes.map((n: any) => n.id)).toEqual([WT_ID])

    await pusher.tick()
    expect(sent[4].memberWorktreeNodes).toBeUndefined()
    pusher.stop()
  })
})
