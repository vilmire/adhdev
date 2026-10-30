/**
 * End to end through the router: the mesh.status lane is fed by the real
 * `mesh_status` command over the coordinator-held store (the same wiring
 * host-runtime.ts uses). An idle mesh must send zero bytes while observation freshness stays unchanged
 * (no per-call age / stamp fields leak into the diff). Expiring a held runtime
 * emits one real fresh-to-stale transition, a member's push of ONE node yields a delta for that node only, and
 * the coordinator sends its members nothing while they push.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { MESH_NODE_STATE_STALE_MS } from '../../src/mesh/mesh-node-git-refresher'
import { MeshNodeGitStateStore } from '../../src/mesh/mesh-node-git-state'
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender'
import { createDefaultGitCommandServices } from '../../src/git/git-commands'
import { TopicSubscriptionRegistry, type TopicSink } from '../../src/subscriptions/topic-registry'
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared'

const execFileAsync = promisify(execFile)
const MESH_ID = 'mesh_lane_idle'

async function createTempGitRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(dir, 'repo')
  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  return { dir, repoRoot }
}

function remoteGit(workspace: string, headCommit: string) {
  return {
    isGitRepo: true, workspace, repoRoot: workspace, branch: 'main', headCommit, upstream: 'origin/main', upstreamStatus: 'fresh',
    ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, deleted: 0, renamed: 0, hasConflicts: false, stashCount: 0, submodules: [],
  }
}

afterEach(resetMeshRuntimeStore)

describe('mesh.status lane over the real mesh_status (coordinator-held)', () => {
  it('idle mesh: zero bytes between freshness transitions; one member push changes only that node; no coordinator→member traffic', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-lane-idle-')
    let clock = Date.now()
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const store = new MeshNodeGitStateStore()
      const remotes = [
        { id: 'node_r1', daemonId: 'daemon_r1', workspace: '/remote/r1' },
        { id: 'node_r2', daemonId: 'daemon_r2', workspace: '/remote/r2' },
      ]
      for (const r of remotes) {
        store.recordObservation({ meshId: MESH_ID, nodeId: r.id, workspace: r.workspace, git: remoteGit(r.workspace, `${r.id}-head`), source: 'member_push', observedAt: clock })
        store.recordRuntimeObservation({ meshId: MESH_ID, nodeId: r.id, workspace: r.workspace, runtime: { daemonId: r.daemonId, sessions: [] }, source: 'member_push', observedAt: clock, daemonId: r.daemonId })
      }
      const dispatchMeshCommand = vi.fn(async () => ({ success: true, subscribed: true }))
      const onMeshStateChange = vi.fn()
      const router = new DaemonCommandRouter({
        commandHandler: {
          handle: vi.fn(async () => ({ success: false })),
          handleSpec: vi.fn(async (spec: any, args: any) => spec.run(createDefaultGitCommandServices(), args)),
        } as any,
        cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null, getByCategory: () => [] } as any,
        detectedIdes: { value: [] },
        sessionRegistry: {} as any,
        sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
        dispatchMeshCommand,
        onMeshStateChange,
        statusInstanceId: 'daemon_local',
        meshNodeGitStateStore: store,
      })
      const inlineMesh = {
        id: MESH_ID, name: 'Lane', repoIdentity: 'github.com/acme/lane', defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_local' }, policy: {},
        nodes: [
          { id: 'node_local', daemonId: 'daemon_local', workspace: repoRoot, repoRoot, providers: [], policy: {} },
          ...remotes.map((r) => ({ id: r.id, daemonId: r.daemonId, workspace: r.workspace, repoRoot: r.workspace, providers: [], policy: {} })),
        ],
      }
      await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh })
      await router.meshNodeGitRefresher.whenIdle()
      // Settle the first-build shape completion (local facts self-heal, the local
      // read's submodule scan) before measuring.
      for (let i = 0; i < 2; i += 1) {
        ;(router as any).invalidateAggregateMeshStatus(MESH_ID)
        await router.execute('mesh_status', { meshId: MESH_ID })
      }
      dispatchMeshCommand.mockClear()

      const frames: Array<{ bytes: number; update: any }> = []
      const sink: TopicSink = {
        send: (_c, _t, update) => { frames.push({ bytes: JSON.stringify(update).length, update }); return true },
        isDeliverable: () => true,
        isAlive: () => true,
      }
      const topics = new TopicSubscriptionRegistry(sink, {
        sources: {
          meshStatus: async (meshId) => {
            const result = await router.execute('mesh_status', { meshId }, 'internal', { inProcess: true })
            if (!result || result.success === false) return null
            const { interactionId: _i, ...status } = result as Record<string, unknown>
            return status
          },
        },
      })
      topics.subscribe('dash', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'mesh.status', key: `mesh:status:${MESH_ID}`, params: { meshId: MESH_ID } })
      await topics.flushNow('mesh.status', 'dash', `mesh:status:${MESH_ID}`)
      expect(frames).toHaveLength(1)
      expect(frames[0]!.update.mode).toBe('snapshot')
      const snapshotBytes = frames[0]!.bytes

      // Before freshness expires, repeated reads send no age/stamp-only deltas.
      const observedAt = clock
      clock = observedAt + MESH_NODE_STATE_STALE_MS - 1
      await topics.flushMeshStatus(MESH_ID)
      await topics.flushMeshStatus(MESH_ID)
      expect(frames).toHaveLength(1)

      // An unrefreshed observation becoming stale is a real status change.
      clock = observedAt + MESH_NODE_STATE_STALE_MS
      await topics.flushMeshStatus(MESH_ID)
      expect(frames).toHaveLength(2)
      const stale = frames[1]!.update.delta.collections.nodes.upsert
      expect(stale.map((n: any) => n.nodeId)).toEqual(['node_r1', 'node_r2'])
      expect(stale.every((n: any) => n.heldRuntime.freshness === 'stale')).toBe(true)

      // Another hour without a change sends zero further bytes.
      for (let i = 0; i < 12; i += 1) {
        clock += 5 * 60_000
        await topics.flushMeshStatus(MESH_ID)
      }
      const idle = frames.slice(2)
      expect(idle).toEqual([])
      expect(idle.reduce((sum, f) => sum + f.bytes, 0)).toBe(0)

      // One member pushes a new HEAD for its node.
      const pushed: any = await router.execute('mesh_node_git_report', {
        meshId: MESH_ID, nodeId: 'node_r2', workspace: '/remote/r2', git: remoteGit('/remote/r2', 'node_r2-moved'), observedAt: clock,
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_r2',
      }, 'mesh')
      expect(pushed).toMatchObject({ success: true, changed: true })
      await topics.flushMeshStatus(MESH_ID)
      expect(frames).toHaveLength(3)
      const delta = frames[2]!.update
      expect(delta.mode).toBe('delta')
      const touched = (delta.delta.collections?.nodes?.upsert ?? []).map((n: any) => n.nodeId)
      expect(touched).toEqual(['node_r2'])
      expect(delta.delta.collections.nodes.removed).toBeUndefined()
      expect(frames[2]!.bytes).toBeLessThan(snapshotBytes / 2)
      // The coordinator never contacted a member for any of this.
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
    } finally {
      dateSpy.mockRestore()
      await cleanupTempDir(dir)
    }
  })
})
