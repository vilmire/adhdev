/**
 * MESH-CRUD-BOOTSTRAP-STAMP-REMAINING-PATH
 *
 * The mesh_forward_event HIGH-family handler was fixed (mesh-forward-event-bootstrap-stamp.test.ts)
 * to supply a bound router.markWorktreeBootstrapTerminalState so a forwarded
 * worktree_bootstrap_complete/_failed event stamps the coordinator's inline mesh
 * view instead of throwing on `components.router` being undefined.
 *
 * That fix left ONE remaining call site broken: `clone_mesh_node`'s
 * emitBootstrapEvent (mesh-crud.ts) runs on the WORKER daemon that owns the
 * cloned worktree and calls handleMeshForwardEvent in-process with the SAME
 * `{ instanceManager }`-only shim the old mesh_forward_event handler used — no
 * router. Live symptom (rc.38): `[ERR] [MeshQueue] Failed to stamp terminal
 * bootstrap state for node_... : Cannot read properties of undefined (reading
 * 'markWorktreeBootstrapTerminalState')`, logged on the worktree-owning daemon.
 *
 * Worse than a silent no-op: because the prior fix promoted the stamp failure
 * from WARN to a re-thrown ERROR (so it "surfaces loudly instead of being
 * swallowed"), the throw now escapes emitBootstrapEvent's `try` block BEFORE it
 * reaches the `queuePendingMeshCoordinatorEvent` fallback — so the event never
 * even reaches the pending-event queue the coordinator later pulls from. The
 * bootstrap completion is recovered only via the ~30-40min stale-running
 * backstop, never the intended event path.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'crypto'

import { DaemonCommandRouter } from '../../src/commands/router'
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../../src/mesh/mesh-events.js'
import { getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'

const execFileAsync = promisify(execFile)

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: async () => ({ success: false }) } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
      getByCategory: () => [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    statusInstanceId: 'daemon-local',
  })
}

async function createRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(dir, 'repo')
  await mkdir(repoRoot, { recursive: true })
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), 'hello\n')
  await execFileAsync('git', ['add', '.'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot })
  return { dir, repoRoot }
}

function bootstrapCompletePayload(meshId: string, nodeId: string, workspace: string) {
  return {
    event: 'worktree_bootstrap_complete' as const,
    meshId,
    nodeId,
    workspace,
    metadataEvent: {
      source: 'clone_mesh_node_bootstrap',
      nodeId,
      status: 'bootstrap_complete',
      worktreePath: workspace,
      durationMs: 5,
      bootstrapStatus: 'complete',
    },
  }
}

/**
 * Mirrors emitBootstrapEvent's control-flow SHAPE (single outer try wrapping both
 * the in-process handleMeshForwardEvent attempt and the queuePendingMeshCoordinatorEvent
 * fallback) exactly as it shipped in mesh-crud.ts before this fix — a throw from
 * handleMeshForwardEvent aborts before the fallback ever runs.
 */
function emitLikePreFix(components: any, payload: ReturnType<typeof bootstrapCompletePayload>, meshId: string, nodeId: string): void {
  try {
    const forwarded = handleMeshForwardEvent({ instanceManager: components.instanceManager } as any, payload as any)
    if (forwarded?.success === true) return
    queuePendingMeshCoordinatorEvent({
      event: payload.event,
      meshId,
      nodeLabel: nodeId,
      nodeId,
      workspace: payload.workspace,
      metadataEvent: payload.metadataEvent,
      queuedAt: Date.now(),
    })
  } catch { /* pre-fix: swallows the fallback too */ }
}

/**
 * Mirrors emitBootstrapEvent's control-flow shape AFTER this fix: the router
 * shim is supplied AND the handleMeshForwardEvent attempt is isolated in its own
 * try/catch, so any failure (thrown or not) still falls through to the queue
 * fallback.
 */
function emitLikePostFix(components: any, payload: ReturnType<typeof bootstrapCompletePayload>, meshId: string, nodeId: string, stamp: (...args: any[]) => void): void {
  try {
    try {
      const forwarded = handleMeshForwardEvent(
        { instanceManager: components.instanceManager, router: { markWorktreeBootstrapTerminalState: stamp } } as any,
        payload as any,
      )
      if (forwarded?.success === true) return
    } catch { /* falls through to the queue fallback below */ }
    queuePendingMeshCoordinatorEvent({
      event: payload.event,
      meshId,
      nodeLabel: nodeId,
      nodeId,
      workspace: payload.workspace,
      metadataEvent: payload.metadataEvent,
      queuedAt: Date.now(),
    })
  } catch { /* best-effort */ }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
}

describe('MESH-CRUD-BOOTSTRAP-STAMP-REMAINING-PATH — clone_mesh_node local emit lacked the router stamp', () => {
  beforeEach(() => {
    __resetMeshRuntimeStoreForTests()
  })
  afterEach(() => { vi.clearAllMocks() })

  it('red regression: the pre-fix {instanceManager}-only shim still throws on worktree_bootstrap_complete', () => {
    const meshId = `mesh_crud_red_prim_${randomUUID().slice(0, 8)}`
    try {
      const components = { instanceManager: { getInstance: vi.fn(() => undefined) } } as any
      expect(() => handleMeshForwardEvent(components, bootstrapCompletePayload(meshId, 'node_wt', `/repo/${meshId}`) as any))
        .toThrow(/markWorktreeBootstrapTerminalState/)
    } finally {
      cleanup(meshId)
    }
  })

  it('red regression: the pre-fix control-flow swallows the throw AND skips the queue fallback — the coordinator never learns', () => {
    const meshId = `mesh_crud_red_flow_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_wt_owned'
    const workspace = `/repo/${meshId}`
    try {
      const components = { instanceManager: { getInstance: vi.fn(() => undefined) } } as any
      emitLikePreFix(components, bootstrapCompletePayload(meshId, nodeId, workspace), meshId, nodeId)

      // The event never reached the pending queue at all — not the rich payload
      // handleMeshForwardEvent would have queued on success, nor the manual
      // fallback, because the throw escaped before either could run.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending.filter(e => e.event === 'worktree_bootstrap_complete')).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('green fix: the post-fix control-flow stamps via the bound router and still reaches the queue on success', () => {
    const meshId = `mesh_crud_green_flow_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_wt_owned'
    const workspace = `/repo/${meshId}`
    try {
      const stamp = vi.fn()
      const components = { instanceManager: { getInstance: vi.fn(() => undefined) } } as any
      emitLikePostFix(components, bootstrapCompletePayload(meshId, nodeId, workspace), meshId, nodeId, stamp)

      expect(stamp).toHaveBeenCalledWith(
        meshId,
        nodeId,
        'complete',
        expect.objectContaining({ workspace }),
      )
      // injectMeshSystemMessage's own tail queues every mesh coordinator event
      // unconditionally, so a successful in-process stamp still lands in the
      // pending queue the coordinator's reconcile loop pulls from.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending.some(e => e.event === 'worktree_bootstrap_complete')).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  it('green fix: the post-fix control-flow still reaches the queue fallback even if the stamp itself throws for an unrelated reason', () => {
    const meshId = `mesh_crud_green_resilient_${randomUUID().slice(0, 8)}`
    const nodeId = 'node_wt_owned'
    const workspace = `/repo/${meshId}`
    try {
      const stamp = vi.fn(() => { throw new Error('unrelated failure') })
      const components = { instanceManager: { getInstance: vi.fn(() => undefined) } } as any
      emitLikePostFix(components, bootstrapCompletePayload(meshId, nodeId, workspace), meshId, nodeId, stamp)

      expect(stamp).toHaveBeenCalled()
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending.some(e => e.event === 'worktree_bootstrap_complete')).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  it('green fix (end-to-end): clone_mesh_node through the real router queues worktree_bootstrap_complete instead of losing it', async () => {
    const { dir, repoRoot } = await createRepo('adhdev-mesh-crud-bootstrap-stamp-')
    const meshId = 'mesh-crud-bootstrap-remaining-path'
    try {
      const router = createRouter()
      const inlineMesh: any = {
        id: meshId,
        name: 'Bootstrap Remaining Path Mesh',
        repoIdentity: 'example/bootstrap-remaining-path',
        defaultBranch: 'main',
        policy: { worktreeBaseDir: join(dir, 'worktrees') },
        coordinator: {},
        nodes: [
          { id: 'node-source', workspace: repoRoot, repoRoot, daemonId: 'daemon-local', userOverrides: {}, policy: { providerPriority: ['codex-cli'], initSubmodulesOnClone: false } },
        ],
      }

      const result: any = await router.execute('clone_mesh_node', {
        meshId,
        sourceNodeId: 'node-source',
        branch: 'feat/bootstrap-remaining-path',
        inlineMesh,
      })

      expect(result.success).toBe(true)

      const pending = getPendingMeshCoordinatorEvents(meshId)
      const bootstrapEvents = pending.filter(e => e.event === 'worktree_bootstrap_complete' && e.nodeId === result.node.id)
      expect(bootstrapEvents.length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
