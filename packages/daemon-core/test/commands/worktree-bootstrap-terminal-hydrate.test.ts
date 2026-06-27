import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Keep the detached local-config persist (void import('../config/mesh-config.js')) off real
// ~/.adhdev state — it reads getConfigDir(); a temp dir with no meshes.json is a harmless no-op.
const testTmpDir = path.join(tmpdir(), `adhdev-bootstrap-hydrate-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
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

describe('Fix (3) — markWorktreeBootstrapTerminalState', () => {
  afterEach(() => {
    vi.clearAllMocks()
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('stamps the terminal status onto an existing inline worktree node', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_wt'
    // Seed an inline mesh whose worktree node is still 'running'.
    router.getCachedInlineMesh(meshId, {
      id: meshId,
      nodes: [{ id: nodeId, nodeId, isLocalWorktree: true, workspace: '/repo/wt', worktreeBootstrap: { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' } }],
    })

    router.markWorktreeBootstrapTerminalState(meshId, nodeId, 'complete')

    const node = findNode(router, meshId, nodeId)
    expect(node?.worktreeBootstrap?.status).toBe('complete')
    // No duplicate node was appended.
    expect(router.getCachedInlineMesh(meshId).nodes.filter((n: any) => (n.id === nodeId || n.nodeId === nodeId)).length).toBe(1)
  })

  it('HYDRATE-ON-MISS: upserts the node from the event payload when the inline view lacks it', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_missing_wt'
    // No inline mesh exists for this id at all — the clone reply never reached this daemon.
    expect(router.getCachedInlineMesh(meshId)).toBeUndefined()

    router.markWorktreeBootstrapTerminalState(meshId, nodeId, 'complete', { workspace: '/repo/wt-hydrated' })

    const node = findNode(router, meshId, nodeId)
    expect(node).toBeTruthy()
    expect(node.isLocalWorktree).toBe(true)
    expect(node.workspace).toBe('/repo/wt-hydrated')
    expect(node.worktreeBootstrap?.status).toBe('complete')
  })

  it('HYDRATE-ON-MISS: upserts into an existing inline mesh that is missing only this node', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    // Inline mesh holds the base node only — the worktree node is absent.
    router.getCachedInlineMesh(meshId, { id: meshId, nodes: [{ id: 'node_base', workspace: '/repo/main' }] })

    router.markWorktreeBootstrapTerminalState(meshId, 'node_late_wt', 'failed', { workspace: '/repo/wt-late' })

    const nodes = router.getCachedInlineMesh(meshId).nodes
    expect(nodes.find((n: any) => n.id === 'node_base')).toBeTruthy() // base preserved
    const hydrated = nodes.find((n: any) => n.id === 'node_late_wt' || n.nodeId === 'node_late_wt')
    expect(hydrated?.worktreeBootstrap?.status).toBe('failed')
    expect(hydrated?.workspace).toBe('/repo/wt-late')
  })

  it('does not gate-open prematurely: a still-running node that already matches is left running on a no-op same-status call', () => {
    const router: any = createRouter()
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_wt'
    router.getCachedInlineMesh(meshId, {
      id: meshId,
      nodes: [{ id: nodeId, nodeId, isLocalWorktree: true, worktreeBootstrap: { status: 'running' } }],
    })
    // Re-stamping 'running' is not a terminal transition — calling with the SAME status as
    // present is a no-op (no hydrate, since the node already exists and matches).
    router.markWorktreeBootstrapTerminalState(meshId, nodeId, 'complete')
    expect(findNode(router, meshId, nodeId)?.worktreeBootstrap?.status).toBe('complete')
    expect(router.getCachedInlineMesh(meshId).nodes.length).toBe(1)
  })
})
