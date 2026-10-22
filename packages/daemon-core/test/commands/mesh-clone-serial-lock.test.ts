// R11: concurrent clone_mesh_node calls on one mesh raced on the mesh record and
// the source repo's `git worktree add`. The resolve → create → register section
// is serialized per mesh; remote forwarding runs outside the lock.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../src/commands/router'
import { meshNodeCloneHandlers, withMeshCloneLock } from '../../src/commands/med-family/mesh-node-clone.js'
import * as meshNodeCloneMod from '../../src/commands/med-family/mesh-node-clone.js'
import { bindMeshNoticeRuntime, type CoordinatorNotice } from '../../src/mesh/turn-ledger/deliver.js'
import { __clearLocalRecordsForTests, readLocalRecordsByKind } from '../../src/mesh/mesh-local-records.js'
import { MeshNodeLimitError } from '../../src/config/mesh-node-limit.js'

const tick = () => new Promise(r => setTimeout(r, 5))

afterEach(() => {
  bindMeshNoticeRuntime(null)
})

describe('withMeshCloneLock', () => {
  it('runs critical sections for one mesh one at a time, in arrival order', async () => {
    const log: string[] = []
    const section = (name: string) => withMeshCloneLock('mesh_1', async () => {
      log.push(`${name}:start`); await tick(); log.push(`${name}:end`); return name
    })
    const results = await Promise.all([section('a'), section('b'), section('c')])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('does not serialize different meshes and survives a failing section', async () => {
    const log: string[] = []
    const failing = withMeshCloneLock('mesh_x', async () => { await tick(); throw new Error('boom') })
    const other = withMeshCloneLock('mesh_y', async () => { log.push('y'); return 'y' })
    const after = withMeshCloneLock('mesh_x', async () => { log.push('x2'); return 'x2' })
    await expect(failing).rejects.toThrow('boom')
    expect(await other).toBe('y')
    expect(await after).toBe('x2')
    expect(log).toEqual(['y', 'x2'])
  })
})

describe('clone_mesh_node forwarding', () => {
  it('forwards to a remote source daemon without holding the mesh lock and subtracts remote forward budget margin', async () => {
    const mesh = { id: 'mesh_f', nodes: [{ id: 'node_base', workspace: '/repo', daemonId: 'daemon_other' }] }
    let reentered: unknown
    let forwardedArgs: any
    const ctx: any = {
      getMeshForCommand: async () => ({ mesh, inline: true, source: 'inline_cache' }),
      requireMeshHostMutationOwner: async () => null,
      deps: {
        statusInstanceId: 'daemon_self',
        // A legacy-form id routing back to this daemon re-enters the lock.
        dispatchMeshCommand: vi.fn(async (_daemonId: string, _cmd: string, args: any) => {
          forwardedArgs = args
          reentered = await withMeshCloneLock('mesh_f', async () => 'reentered')
          return { success: true, forwarded: true }
        }),
      },
    }
    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, {
      meshId: 'mesh_f',
      sourceNodeId: 'node_base',
      branch: 'feat/y',
      syncBudgetMs: 90_000,
    })
    expect(reentered).toBe('reentered')
    expect(result.success).not.toBe(false)
    // Clamped to MAX_CLONE_SYNC_BUDGET_MS (80_000), then minus CLONE_REMOTE_FORWARD_BUDGET_MARGIN_MS (10_000) = 70_000
    expect((meshNodeCloneMod as any).MAX_CLONE_SYNC_BUDGET_MS).toBe(80_000)
    expect(forwardedArgs?.syncBudgetMs).toBe(70_000)
  })

  it('returns an accepted/async response when worktree creation is queued behind a slow lock holder past syncBudgetMs', async () => {
    let releaseHolder!: () => void
    const holderReady = new Promise<void>(resolve => {
      void withMeshCloneLock('mesh_budget', async () => {
        resolve()
        await new Promise<void>(r => { releaseHolder = r })
      })
    })
    await holderReady

    const mesh = {
      id: 'mesh_budget',
      name: 'Budget Mesh',
      nodes: [{ id: 'node_base', workspace: '/repo', daemonId: 'daemon_self' }],
    }
    const ctx: any = {
      getMeshForCommand: async () => ({ mesh, inline: true, source: 'inline_cache' }),
      getCachedInlineMesh: () => mesh,
      requireMeshHostMutationOwner: async () => null,
      deps: { statusInstanceId: 'daemon_self' },
    }

    const startedAt = Date.now()
    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, {
      meshId: 'mesh_budget',
      sourceNodeId: 'node_base',
      branch: 'feat/budget-test',
      syncBudgetMs: 60,
    })
    const elapsedMs = Date.now() - startedAt
    releaseHolder()
    await withMeshCloneLock('mesh_budget', async () => undefined)
    await new Promise(r => setTimeout(r, 20))

    expect(elapsedMs).toBeLessThan(600)
    expect(result.success).toBe(true)
    expect(result.async).toBe(true)
    expect(result.status).toBe('accepted')
    expect(result.branch).toBe('feat/budget-test')
  })

  it('emits a coordinator-visible failure event and ledger record when background pipeline rejects or fails after syncBudgetMs', async () => {
    __clearLocalRecordsForTests('mesh_bg_fail')
    const notices: CoordinatorNotice[] = []
    bindMeshNoticeRuntime({
      notify: (notice) => {
        notices.push(notice)
        return { eventId: `evt_${notices.length}`, queued: true }
      },
      readNotices: () => [],
      controlNotices: () => [],
      retract: () => 0,
      hasUndelivered: () => false,
      hasLiveCliCoordinator: () => false,
      isSelfDaemon: () => true,
      replicationPending: () => false,
      counters: () => ({} as any),
    })

    let releaseHolder!: () => void
    const holderReady = new Promise<void>(resolve => {
      void withMeshCloneLock('mesh_bg_fail', async () => {
        resolve()
        await new Promise<void>(r => { releaseHolder = r })
      })
    })
    await holderReady

    const mesh = {
      id: 'mesh_bg_fail',
      name: 'BG Fail Mesh',
      nodes: [{ id: 'node_base', workspace: '/nonexistent-repo-for-bg-fail', daemonId: 'daemon_self' }],
    }
    const ctx: any = {
      getMeshForCommand: async () => {
        throw new Error('git worktree add failed in background')
      },
      getCachedInlineMesh: () => mesh,
      requireMeshHostMutationOwner: async () => null,
      deps: { statusInstanceId: 'daemon_self' },
    }

    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, {
      meshId: 'mesh_bg_fail',
      sourceNodeId: 'node_base',
      branch: 'feat/bg-fail',
      syncBudgetMs: 30,
    })
    expect(result.success).toBe(true)
    expect(result.status).toBe('accepted')

    releaseHolder()
    await withMeshCloneLock('mesh_bg_fail', async () => undefined)
    await new Promise(r => setTimeout(r, 40))

    const failNotice = notices.find(n => n.event === 'worktree_bootstrap_failed' && n.meshId === 'mesh_bg_fail')
    expect(failNotice).toBeDefined()
    expect(failNotice?.metadataEvent?.branch).toBe('feat/bg-fail')
    expect(String(failNotice?.metadataEvent?.error || '')).toContain('git worktree add failed in background')

    const ledgerRecords = readLocalRecordsByKind('mesh_bg_fail', ['node_cloned'])
    expect(ledgerRecords.length).toBeGreaterThanOrEqual(1)
    expect((ledgerRecords[0]?.payload as any)?.worktreeBootstrap?.status).toBe('failed')
    expect(String((ledgerRecords[0]?.payload as any)?.worktreeBootstrap?.error || '')).toContain('git worktree add failed in background')
  })

  it('carries actionable maxNodes refusal through the background failure event after syncBudgetMs', async () => {
    __clearLocalRecordsForTests('mesh_bg_limit')
    const notices: CoordinatorNotice[] = []
    bindMeshNoticeRuntime({
      notify: (notice) => {
        notices.push(notice)
        return { eventId: `evt_${notices.length}`, queued: true }
      },
      readNotices: () => [],
      controlNotices: () => [],
      retract: () => 0,
      hasUndelivered: () => false,
      hasLiveCliCoordinator: () => false,
      isSelfDaemon: () => true,
      replicationPending: () => false,
      counters: () => ({} as any),
    })

    let releaseHolder!: () => void
    const holderReady = new Promise<void>(resolve => {
      void withMeshCloneLock('mesh_bg_limit', async () => {
        resolve()
        await new Promise<void>(r => { releaseHolder = r })
      })
    })
    await holderReady

    const mesh = {
      id: 'mesh_bg_limit',
      name: 'BG Limit Mesh',
      nodes: [{ id: 'node_base', workspace: '/repo', daemonId: 'daemon_self' }],
    }
    const ctx: any = {
      getMeshForCommand: async () => {
        throw new MeshNodeLimitError({
          meshId: 'mesh_bg_limit',
          meshName: 'BG Limit Mesh',
          count: 2,
          limit: 2,
          baseNodes: 1,
          worktreeNodes: 1,
          limitIsOverride: true,
          worktrees: [{ nodeId: 'node_wt1', branch: 'feat/wt1' }],
        })
      },
      getCachedInlineMesh: () => mesh,
      requireMeshHostMutationOwner: async () => null,
      deps: { statusInstanceId: 'daemon_self' },
    }

    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, {
      meshId: 'mesh_bg_limit',
      sourceNodeId: 'node_base',
      branch: 'feat/bg-limit',
      syncBudgetMs: 30,
    })
    expect(result.status).toBe('accepted')

    releaseHolder()
    await withMeshCloneLock('mesh_bg_limit', async () => undefined)
    await new Promise(r => setTimeout(r, 40))

    const failNotice = notices.find(n => n.event === 'worktree_bootstrap_failed')
    expect(failNotice).toBeDefined()
    expect(failNotice?.metadataEvent?.code).toBe('mesh_node_limit_exceeded')
    expect(failNotice?.metadataEvent?.maxNodes).toBe(2)
    expect(failNotice?.metadataEvent?.currentCount).toBe(2)
    expect((failNotice?.metadataEvent?.nodeLimit as any)?.limit).toBe(2)
    expect((failNotice?.metadataEvent?.nodeLimit as any)?.count).toBe(2)
  })

  it('emits success event with registered node id when background clone completes after syncBudgetMs', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-bg-clone-ok-'))
    const repoDir = path.join(tmpRoot, 'repo')
    const wtBaseDir = path.join(tmpRoot, 'worktrees')
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir })
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir })

    try {
      __clearLocalRecordsForTests('mesh_bg_ok')
      const notices: CoordinatorNotice[] = []
      bindMeshNoticeRuntime({
        notify: (notice) => {
          notices.push(notice)
          return { eventId: `evt_${notices.length}`, queued: true }
        },
        readNotices: () => [],
        controlNotices: () => [],
        retract: () => 0,
        hasUndelivered: () => false,
        hasLiveCliCoordinator: () => false,
        isSelfDaemon: () => true,
        replicationPending: () => false,
        counters: () => ({} as any),
      })

      let releaseHolder!: () => void
      const holderReady = new Promise<void>(resolve => {
        void withMeshCloneLock('mesh_bg_ok', async () => {
          resolve()
          await new Promise<void>(r => { releaseHolder = r })
        })
      })
      await holderReady

      const mesh: any = {
        id: 'mesh_bg_ok',
        name: 'BG OK Mesh',
        policy: { worktreeBaseDir: wtBaseDir },
        nodes: [{ id: 'node_base', workspace: repoDir, repoRoot: repoDir, daemonId: 'daemon_self', policy: { initSubmodulesOnClone: false } }],
      }
      const ctx: any = {
        getMeshForCommand: async () => ({ mesh, inline: true, source: 'inline_cache' }),
        getCachedInlineMesh: () => mesh,
        updateInlineMeshNode: (_meshId: string, m: any, node: any) => {
          const idx = m.nodes.findIndex((n: any) => n.id === node.id)
          if (idx >= 0) m.nodes[idx] = node
          else m.nodes.push(node)
        },
        requireMeshHostMutationOwner: async () => null,
        deps: { statusInstanceId: 'daemon_self' },
      }

      const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, {
        meshId: 'mesh_bg_ok',
        sourceNodeId: 'node_base',
        branch: 'feat/bg-ok',
        syncBudgetMs: 25,
      })
      expect(result.status).toBe('accepted')

      releaseHolder()
      // Wait for background worktree creation + bootstrap to complete
      for (let i = 0; i < 40 && !notices.some(n => n.event === 'worktree_bootstrap_complete'); i++) {
        await new Promise(r => setTimeout(r, 50))
      }

      const okNotice = notices.find(n => n.event === 'worktree_bootstrap_complete')
      expect(okNotice).toBeDefined()
      const registeredNode = mesh.nodes.find((n: any) => n.worktreeBranch === 'feat/bg-ok')
      expect(registeredNode?.id).toBeTruthy()
      expect(okNotice?.nodeId).toBe(registeredNode.id)
      expect(okNotice?.metadataEvent?.nodeId).toBe(registeredNode.id)
      expect(okNotice?.metadataEvent?.branch).toBe('feat/bg-ok')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

