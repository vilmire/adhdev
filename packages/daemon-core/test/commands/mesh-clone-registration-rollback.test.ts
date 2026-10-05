import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { DaemonCommandRouter } from '../../src/commands/router'

afterEach(resetMeshRuntimeStore)

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    statusInstanceId: 'daemon-local',
  })
}

/**
 * clone_mesh_node runs `git worktree add` BEFORE registering the node, and the
 * registration can still refuse ("Maximum 10 nodes per mesh"). The refused
 * clone used to leave the worktree directory and its branch behind with no mesh
 * node pointing at them (2026-10-05 provider matrix: grok coordinator on a full
 * mesh). The clone now rolls the worktree back.
 */
describe('clone_mesh_node rolls back the worktree when registration refuses', () => {
  it('leaves no worktree or branch behind on a full mesh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-clone-rollback-'))
    const repo = join(root, 'repo')
    const worktrees = join(root, 'worktrees')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = join(root, 'config')
    try {
      execFileSync('git', ['init', '-q', repo])
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo })
      execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
      writeFileSync(join(repo, 'README.md'), 'init\n')
      execFileSync('git', ['add', '.'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({ name: 'Full', repoIdentity: 'example/full', defaultBranch: 'main', policy: { worktreeBaseDir: worktrees } } as any)
      const source = addNode(mesh.id, { workspace: repo, repoRoot: repo } as any)!
      for (let i = 0; i < 9; i += 1) addNode(mesh.id, { workspace: join(root, `other-${i}`), repoRoot: join(root, `other-${i}`) } as any)

      const router = createRouter()
      let result: any
      try {
        result = await router.execute('clone_mesh_node', { meshId: mesh.id, sourceNodeId: source.id, branch: 'mesh/rollback-check' })
      } catch (error: any) {
        result = { success: false, error: error?.message }
      }
      expect(result.success).toBe(false)
      expect(String(result.error)).toContain('Maximum 10 nodes')

      const leftovers = existsSync(worktrees) ? readdirSync(worktrees, { recursive: true } as any) : []
      expect(leftovers.filter((p: any) => String(p).includes('rollback-check'))).toEqual([])
      const branches = execFileSync('git', ['branch', '--list', 'mesh/rollback-check'], { cwd: repo, encoding: 'utf8' })
      expect(branches.trim()).toBe('')
      const worktreeList = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })
      expect(worktreeList).not.toContain('rollback-check')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  })
})
