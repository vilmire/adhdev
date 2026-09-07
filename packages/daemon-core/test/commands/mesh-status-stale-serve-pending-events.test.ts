import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { DaemonCommandRouter } from '../../src/commands/router'

/**
 * mesh_status stale-serve while coordinator events are pending.
 *
 * Live symptom: opening the mesh overview took tens of seconds. Root cause was
 * the cache gate — a single undrained coordinator event skipped BOTH the strict
 * cache serve AND the SWR stale serve, dropping every opener straight into a
 * full synchronous rebuild whose per-node peer probe is bounded only by a 25s
 * timeout (x2 with the retry). One dead / TURN-relayed peer therefore held the
 * whole aggregate, for every concurrent opener.
 *
 * Fix: `pendingCoordinatorEventCount === 0` gates ONLY the strict serve. The SWR
 * stale serve runs regardless, because pending events are never part of the
 * cached snapshot — they are stripped before caching and re-attached at return
 * time. So the caller gets STALE NODE HEALTH + FRESH pending events.
 *
 * These tests pin the three correctness properties:
 *   (a) node health may come from the cached snapshot,
 *   (b) pendingCoordinatorEvents ride along FRESH (not from the cache),
 *   (c) a genuine queue mutation (queueRevision change) still forces a rebuild.
 */

const STALE_MARKER = 'cached-node-health-marker'

function createRouter(statusInstanceId = 'daemon-local') {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    statusInstanceId,
  })
}

/**
 * Seed the aggregate cache with a snapshot whose single node still has a pending
 * peer-git probe — i.e. exactly the snapshot the strict serve rejects and only
 * the SWR (allowStalePending) serve will return.
 */
function seedStalePendingAggregate(router: any, meshId: string, queueRevision: string) {
  router.aggregateMeshStatusCache.set(meshId, {
    builtAt: Date.now(),
    snapshot: {
      success: true,
      meshId,
      staleMarker: STALE_MARKER,
      nodes: [
        {
          nodeId: 'node_stale',
          workspace: '/tmp/stale-workspace',
          gitProbePending: true,
          machineStatus: 'online',
          dataFreshness: { projection: 'cached', directPeerTruthSatisfied: false },
        },
      ],
    },
    queueRevision,
  })
}

afterEach(resetMeshRuntimeStore)

describe('mesh_status serves the stale aggregate while coordinator events are pending', () => {
  it('(a)(b) stale-serves cached node health but re-attaches FRESH pending events, without a full rebuild', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-stale-pending-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')
      const { queuePendingMeshCoordinatorEvent, getPendingMeshCoordinatorEvents } =
        await import('../../src/mesh/mesh-events.js')
      const { getMeshQueueRevision } = await import('../../src/mesh/mesh-work-queue.js')

      const mesh = createMesh({ name: 'StaleServe', repoIdentity: 'github.com/acme/stale-serve', defaultBranch: 'main' })
      addNode(mesh.id, { workspace: '/tmp/stale-workspace', repoRoot: '/tmp/stale-workspace' })

      // A locally-emitted pending event is stamped with THIS machine's id as its
      // target coordinator, so the daemon must present the same id for the peek
      // to see it (that scoping is the B3 fix, unrelated to this change).
      const { loadConfig } = await import('../../src/config/config.js')
      const selfDaemonId = loadConfig().machineId || 'daemon-local'

      const router: any = createRouter(selfDaemonId)
      router.getCachedInlineMesh(mesh.id, getMesh(mesh.id))
      seedStalePendingAggregate(router, mesh.id, getMeshQueueRevision(mesh.id))

      // An undrained coordinator event addressed to this daemon — the condition
      // that used to force the full synchronous rebuild.
      expect(queuePendingMeshCoordinatorEvent({
        event: 'agent:ready',
        meshId: mesh.id,
        nodeLabel: 'node_stale',
        metadataEvent: { timestamp: Date.now() },
        queuedAt: Date.now(),
      } as any)).toBe(true)
      expect(getPendingMeshCoordinatorEvents(mesh.id, selfDaemonId).length).toBeGreaterThan(0)

      // Never let the real background freshen run during the assertions — it
      // would rewrite the cache we are inspecting. The SWR kick is the ONLY
      // caller of `execute` from this path (we drive the handler directly via
      // executeDaemonCommand), so stubbing it is safe and also proves the kick
      // happened.
      const freshenCalls: any[] = []
      vi.spyOn(router, 'execute').mockImplementation(async (...callArgs: any[]) => {
        freshenCalls.push(callArgs)
        return { success: true } as any
      })

      const result: any = await router.executeDaemonCommand('mesh_status', { meshId: mesh.id })
      await new Promise(resolve => setTimeout(resolve, 0)) // let the fire-and-forget kick land

      // (a) node health came from the cached snapshot — not a live rebuild.
      expect(result.success).toBe(true)
      expect(result.staleMarker).toBe(STALE_MARKER)
      expect(result.sourceOfTruth?.aggregateSnapshot?.cached).toBe(true)
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0].nodeId).toBe('node_stale')

      // (b) the pending events ride along FRESH — they are never in the cached
      // snapshot, so their presence proves the return-time re-attach ran on the
      // stale path too. Reverting the fix drops this path entirely (full rebuild),
      // and the staleMarker assertion above goes red.
      expect(Array.isArray(result.pendingCoordinatorEvents)).toBe(true)
      expect(result.pendingCoordinatorEvents.length).toBeGreaterThan(0)
      expect(result.pendingCoordinatorEvents[0].event).toBe('agent:ready')
      // The cached snapshot itself must stay free of them (no poisoning).
      expect(router.aggregateMeshStatusCache.get(mesh.id).snapshot.pendingCoordinatorEvents).toBeUndefined()
      // The other never-cached live extras are re-attached on this path as well.
      expect(result.meshProtocolV2Counters).toBeTruthy()
      expect(result.pendingRetentionCounters).toBeTruthy()
      expect(result.turnPresentationCounters).toBeTruthy()

      // The revalidate half of stale-while-revalidate: exactly ONE coalesced
      // background freshen was kicked, so the next poll gets fresh node health.
      expect(freshenCalls).toHaveLength(1)
      expect(freshenCalls[0][0]).toBe('mesh_status')
      expect(freshenCalls[0][1]?.refresh).toBe(true)
      expect(freshenCalls[0][2]).toBe('mesh_status_swr_freshen')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('(b2) event-derived state (asyncRefineJobs) is recomputed on the stale path, not taken from the cache', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-stale-refine-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')
      const { queuePendingMeshCoordinatorEvent } = await import('../../src/mesh/mesh-events.js')
      const { appendLedgerEntry } = await import('../../src/mesh/mesh-ledger.js')
      const { getMeshQueueRevision } = await import('../../src/mesh/mesh-work-queue.js')
      const { loadConfig } = await import('../../src/config/config.js')

      const mesh = createMesh({ name: 'StaleRefine', repoIdentity: 'github.com/acme/stale-refine', defaultBranch: 'main' })
      addNode(mesh.id, { workspace: '/tmp/stale-workspace', repoRoot: '/tmp/stale-workspace' })

      const router: any = createRouter(loadConfig().machineId || 'daemon-local')
      router.getCachedInlineMesh(mesh.id, getMesh(mesh.id))
      // The cached snapshot predates the refine job entirely.
      seedStalePendingAggregate(router, mesh.id, getMeshQueueRevision(mesh.id))
      vi.spyOn(router, 'execute').mockImplementation(async () => ({ success: true }) as any)

      appendLedgerEntry(mesh.id, {
        kind: 'task_dispatched',
        nodeId: 'node_stale',
        payload: {
          source: 'refine_mesh_node_async_job',
          refineJob: {
            jobId: 'refine_stale_serve',
            interactionId: 'ix-stale-serve',
            status: 'accepted',
            meshId: mesh.id,
            nodeId: 'node_stale',
            workspace: '/tmp/stale-workspace',
            startedAt: '2026-05-29T00:00:00.000Z',
          },
          async: true,
        },
      } as any)
      queuePendingMeshCoordinatorEvent({
        event: 'refine:completed',
        meshId: mesh.id,
        nodeLabel: 'node_stale',
        nodeId: 'node_stale',
        workspace: '/tmp/stale-workspace',
        metadataEvent: {
          source: 'refine_mesh_node_async_job',
          jobId: 'refine_stale_serve',
          status: 'completed',
          result: { success: true, merged: true },
        },
        queuedAt: Date.now(),
      } as any)

      const result: any = await router.executeDaemonCommand('mesh_status', { meshId: mesh.id })

      // Served from cache (node health stale)…
      expect(result.staleMarker).toBe(STALE_MARKER)
      // …yet the refine job the just-arrived event completed IS visible. Taking
      // asyncRefineJobs from the cached snapshot would have shown nothing — the
      // exact "state changed but the overview doesn't show it" failure.
      expect(result.asyncRefineJobs).toEqual([
        expect.objectContaining({ jobId: 'refine_stale_serve', status: 'completed' }),
      ])
      // The recompute is also written back, so the terminal status survives the
      // coordinator draining the event (the ledger alone only says 'accepted').
      expect(router.aggregateMeshStatusCache.get(mesh.id).snapshot.asyncRefineJobs).toEqual([
        expect.objectContaining({ jobId: 'refine_stale_serve', status: 'completed' }),
      ])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('(c) a real queue mutation (queueRevision change) still forces a live rebuild, pending events notwithstanding', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-queue-rev-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')
      const { queuePendingMeshCoordinatorEvent } = await import('../../src/mesh/mesh-events.js')

      const mesh = createMesh({ name: 'QueueRev', repoIdentity: 'github.com/acme/queue-rev', defaultBranch: 'main' })
      addNode(mesh.id, { workspace: '/tmp/queue-rev-workspace', repoRoot: '/tmp/queue-rev-workspace' })

      const { loadConfig } = await import('../../src/config/config.js')
      const router: any = createRouter(loadConfig().machineId || 'daemon-local')
      router.getCachedInlineMesh(mesh.id, getMesh(mesh.id))
      // Snapshot held under a revision that no longer matches the live queue —
      // this is what a genuine enqueue/mutation produces.
      seedStalePendingAggregate(router, mesh.id, 'revision-from-before-the-mutation')

      queuePendingMeshCoordinatorEvent({
        event: 'agent:ready',
        meshId: mesh.id,
        nodeLabel: 'node_stale',
        metadataEvent: { timestamp: Date.now() },
        queuedAt: Date.now(),
      } as any)

      const result: any = await router.executeDaemonCommand('mesh_status', { meshId: mesh.id })

      // The stale snapshot was NOT served: the queueRevision guard is untouched by
      // the fix, so real state changes are always rebuilt from truth. This is the
      // "state changed but the UI kept showing the old thing" guard.
      expect(result.staleMarker).toBeUndefined()
      expect(result.sourceOfTruth?.aggregateSnapshot?.cached).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
