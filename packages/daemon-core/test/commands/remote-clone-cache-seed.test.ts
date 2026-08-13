import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Keep the detached local-config persist chain off real ~/.adhdev state (same pattern as
// worktree-bootstrap-terminal-hydrate.test.ts): a temp dir with no meshes.json is a no-op.
const testTmpDir = path.join(tmpdir(), `adhdev-remote-clone-seed-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'coordinator-machine' } as any),
}))

import { DaemonCommandRouter } from '../../src/commands/router.js'

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { handleCliCommand: vi.fn(async () => ({ success: true })) } as any,
    cdpManagers: new Map(),
    providerLoader: { resolve: vi.fn(() => undefined), getMeta: vi.fn(() => undefined) } as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    packageName: 'adhdev',
    statusVersion: '0.9.71',
  })
}

const findNode = (router: any, meshId: string, nodeId: string) =>
  (router.getCachedInlineMesh(meshId)?.nodes || []).find((n: any) => n.id === nodeId || n.nodeId === nodeId)

/**
 * The node object a REMOTE daemon returns in its clone_mesh_node reply. It carries the full
 * scheduling identity — this is exactly what the coordinator used to discard.
 */
const remoteClonedNode = (nodeId: string) => ({
  id: nodeId,
  workspace: '/remote/wt/feature-x',
  repoRoot: '/remote/wt/feature-x',
  daemonId: 'daemon_remote_machine',
  machineId: 'machine_remote',
  userOverrides: { platform: 'win32' },
  policy: { providerPriority: ['claude'], maxConcurrentSessions: 1 },
  isLocalWorktree: true,
  worktreeBranch: 'feature-x',
  clonedFromNodeId: 'node_base_remote',
  worktreeBootstrap: { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
})

describe('REMOTE-CLONE-CACHE-SEED — seedRemoteClonedWorktreeNode', () => {
  afterEach(() => {
    vi.clearAllMocks()
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('seeds the remotely-cloned node into the coordinator cache immediately (no event needed)', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_remote_wt'
    // The coordinator holds only the base node; the clone ran on another machine.
    router.getCachedInlineMesh(meshId, { id: meshId, nodes: [{ id: 'node_base_remote', workspace: '/remote/main' }] })

    expect(router.seedRemoteClonedWorktreeNode(meshId, remoteClonedNode(nodeId))).toBe(true)

    const node = findNode(router, meshId, nodeId)
    expect(node).toBeTruthy()
    // The scheduling identity the passive-cache scheduler needs must all be present.
    expect(node.daemonId).toBe('daemon_remote_machine')
    expect(node.machineId).toBe('machine_remote')
    expect(node.policy?.providerPriority).toEqual(['claude'])
    expect(node.workspace).toBe('/remote/wt/feature-x')
    expect(node.worktreeBranch).toBe('feature-x')
    expect(node.isLocalWorktree).toBe(true)
    // The base node is preserved.
    expect(findNode(router, meshId, 'node_base_remote')).toBeTruthy()
  })

  it('seeds into a mesh the coordinator has no inline cache for at all', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    expect(router.getCachedInlineMesh(meshId)).toBeUndefined()

    expect(router.seedRemoteClonedWorktreeNode(meshId, remoteClonedNode('node_remote_wt'))).toBe(true)

    expect(findNode(router, meshId, 'node_remote_wt')?.daemonId).toBe('daemon_remote_machine')
  })

  // ---- Race with the bootstrap-complete event, BOTH orderings ----

  it('RACE seed-then-event: the later terminal stamp keeps every seeded scheduling field', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_remote_wt'
    router.seedRemoteClonedWorktreeNode(meshId, remoteClonedNode(nodeId))

    // worktree_bootstrap_complete arrives afterwards.
    router.markWorktreeBootstrapTerminalState(meshId, nodeId, 'complete', { workspace: '/remote/wt/feature-x' })

    const node = findNode(router, meshId, nodeId)
    // Gate opened...
    expect(node.worktreeBootstrap?.status).toBe('complete')
    // ...and the event did NOT strip the identity down to a hydrate shell.
    expect(node.daemonId).toBe('daemon_remote_machine')
    expect(node.machineId).toBe('machine_remote')
    expect(node.policy?.providerPriority).toEqual(['claude'])
    expect(router.getCachedInlineMesh(meshId).nodes.length).toBe(1)
  })

  it('RACE event-then-seed: the late clone reply must NOT reopen the gate by reverting to running', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_remote_wt'

    // The event wins the race and hydrates a MINIMAL shell carrying the terminal status.
    router.markWorktreeBootstrapTerminalState(meshId, nodeId, 'complete', { workspace: '/remote/wt/feature-x' })
    expect(findNode(router, meshId, nodeId)?.daemonId).toBeUndefined() // shell has no identity

    // The clone reply lands late, carrying the now-stale 'running' bootstrap state.
    router.seedRemoteClonedWorktreeNode(meshId, remoteClonedNode(nodeId))

    const node = findNode(router, meshId, nodeId)
    // The terminal status must survive — reverting to 'running' would make
    // shouldDeferDispatchForBootstrap defer every claim forever (the original stall).
    expect(node.worktreeBootstrap?.status).toBe('complete')
    // And the reply's scheduling identity must now be filled in on that same entry.
    expect(node.daemonId).toBe('daemon_remote_machine')
    expect(node.machineId).toBe('machine_remote')
    expect(node.policy?.providerPriority).toEqual(['claude'])
    expect(router.getCachedInlineMesh(meshId).nodes.length).toBe(1)
  })

  it('RACE event-then-seed with a FAILED bootstrap: terminal failure is not reverted either', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_remote_wt'
    router.markWorktreeBootstrapTerminalState(meshId, nodeId, 'failed', { workspace: '/remote/wt/feature-x' })

    router.seedRemoteClonedWorktreeNode(meshId, remoteClonedNode(nodeId))

    expect(findNode(router, meshId, nodeId)?.worktreeBootstrap?.status).toBe('failed')
    expect(findNode(router, meshId, nodeId)?.daemonId).toBe('daemon_remote_machine')
  })

  it('a non-terminal existing entry does NOT block the reply bootstrap state', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_remote_wt'
    // An entry that is still 'running' carries no advanced state worth preserving.
    router.getCachedInlineMesh(meshId, {
      id: meshId,
      nodes: [{ id: nodeId, nodeId, isLocalWorktree: true, worktreeBootstrap: { status: 'running' } }],
    })

    const node = remoteClonedNode(nodeId)
    node.worktreeBootstrap = { status: 'complete', startedAt: '2026-01-01T00:00:00.000Z' } as any
    router.seedRemoteClonedWorktreeNode(meshId, node)

    expect(findNode(router, meshId, nodeId)?.worktreeBootstrap?.status).toBe('complete')
  })

  it('re-seeding the same node is idempotent (no duplicate entries)', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_remote_wt'
    router.seedRemoteClonedWorktreeNode(meshId, remoteClonedNode(nodeId))
    router.seedRemoteClonedWorktreeNode(meshId, remoteClonedNode(nodeId))

    expect(router.getCachedInlineMesh(meshId).nodes.filter(
      (n: any) => n.id === nodeId || n.nodeId === nodeId,
    ).length).toBe(1)
  })

  it('an unidentifiable node is rejected rather than polluting the cache', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    expect(router.seedRemoteClonedWorktreeNode(meshId, { workspace: '/wt/no-id' })).toBe(false)
    expect(router.seedRemoteClonedWorktreeNode(meshId, undefined)).toBe(false)
    expect(router.seedRemoteClonedWorktreeNode('', remoteClonedNode('node_x'))).toBe(false)
    expect(router.getCachedInlineMesh(meshId)).toBeUndefined()
  })

  it('identity is canonicalized so claim-path id matching resolves the seeded node', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    // A reply that serializes identity as `nodeId` only still lands addressably.
    router.seedRemoteClonedWorktreeNode(meshId, {
      nodeId: 'node_alt_form',
      workspace: '/remote/wt/alt',
      daemonId: 'daemon_remote_machine',
      isLocalWorktree: true,
    })
    const node = findNode(router, meshId, 'node_alt_form')
    expect(node).toBeTruthy()
    expect(node.id).toBe('node_alt_form')
    expect(node.nodeId).toBe('node_alt_form')
  })
})
