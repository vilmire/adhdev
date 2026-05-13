import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'
import { createWorktree, resolveWorktreePath } from '../../src/git/git-worktree'

const execFileAsync = promisify(execFile)

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

async function createTempGitRepoWithSubmodule(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const submoduleRoot = join(dir, 'submodule')
  const repoRoot = join(dir, 'repo')

  await execFileAsync('git', ['init', submoduleRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: submoduleRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: submoduleRoot })
  await writeFile(join(submoduleRoot, 'submodule.txt'), 'submodule\n')
  await execFileAsync('git', ['add', 'submodule.txt'], { cwd: submoduleRoot })
  await execFileAsync('git', ['commit', '-m', 'submodule init'], { cwd: submoduleRoot })

  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRoot, 'vendor/submodule'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: repoRoot })

  return { dir, repoRoot, submoduleRoot }
}

function createRouter(overrides: Record<string, unknown> = {}) {
  const sessionHostControl = {
    listSessions: vi.fn(async () => []),
    stopSession: vi.fn(async (sessionId: string) => ({ sessionId })),
    deleteSession: vi.fn(async (sessionId: string) => ({ sessionId, deleted: true })),
    getDiagnostics: vi.fn(async () => ({})),
    resumeSession: vi.fn(async (sessionId: string) => ({ sessionId })),
    restartSession: vi.fn(async (sessionId: string) => ({ sessionId })),
    sendSignal: vi.fn(async (sessionId: string) => ({ sessionId })),
    forceDetachClient: vi.fn(async (sessionId: string) => ({ sessionId })),
    pruneDuplicateSessions: vi.fn(async () => ({ prunedSessionIds: [] })),
    acquireWrite: vi.fn(async () => ({ sessionId: 'session-write' })),
    releaseWrite: vi.fn(async () => ({ sessionId: 'session-release' })),
    ...overrides,
  }

  const router = new DaemonCommandRouter({
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
    sessionHostControl: sessionHostControl as any,
  })

  return { router, sessionHostControl }
}

describe('mesh session cleanup', () => {
  it('deletes only completed sessions for the target node workspace by default-safe mode', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'done-1', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
        { sessionId: 'failed-1', workspace: '/repo/worktree-a', lifecycle: 'failed' },
        { sessionId: 'running-1', workspace: '/repo/worktree-a', lifecycle: 'running' },
        { sessionId: 'other-1', workspace: '/repo/other', lifecycle: 'stopped' },
      ]),
    })

    const result = await router.execute('cleanup_mesh_sessions', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      mode: 'delete_stopped',
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      mode: 'delete_stopped',
      matchedCount: 3,
      deletedSessionIds: ['done-1', 'failed-1'],
      skippedSessionIds: ['running-1'],
    })
    expect(sessionHostControl.deleteSession).toHaveBeenCalledTimes(2)
    expect(sessionHostControl.deleteSession).toHaveBeenNthCalledWith(1, 'done-1', { force: false })
    expect(sessionHostControl.deleteSession).toHaveBeenNthCalledWith(2, 'failed-1', { force: false })
    expect(sessionHostControl.stopSession).not.toHaveBeenCalled()
  })

  it('falls back to stopping live sessions when delete_session is unsupported by an older session host', async () => {
    const unsupported = new Error('Unsupported session host request: delete_session')
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'running-1', workspace: '/repo/worktree-a', lifecycle: 'running' },
        { sessionId: 'done-1', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
      ]),
      deleteSession: vi.fn(async () => { throw unsupported }),
    })

    const result = await router.execute('cleanup_mesh_sessions', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      mode: 'stop_and_delete',
      sessionIds: ['running-1', 'done-1'],
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      mode: 'stop_and_delete',
      matchedCount: 2,
      stoppedSessionIds: ['running-1'],
      deletedSessionIds: [],
      skippedSessionIds: ['running-1', 'done-1'],
      deleteUnsupportedSessionIds: ['running-1', 'done-1'],
    })
    expect(sessionHostControl.deleteSession).toHaveBeenCalledTimes(2)
    expect(sessionHostControl.stopSession).toHaveBeenCalledTimes(1)
    expect(sessionHostControl.stopSession).toHaveBeenCalledWith('running-1')
  })

  it('protects live runtimes from broad workspace cleanup unless explicit session IDs are requested', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'coordinator-live', workspace: '/repo/worktree-a', lifecycle: 'running' },
        { sessionId: 'smoke-stopped', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
      ]),
    })

    const result = await router.execute('cleanup_mesh_sessions', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      mode: 'stop_and_delete',
      dryRun: true,
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      mode: 'stop_and_delete',
      dryRun: true,
      matchedCount: 2,
      matchedBySurfaceKind: {
        live_runtime: 1,
        recovery_snapshot: 0,
        inactive_record: 1,
      },
      deletedSessionIds: ['smoke-stopped'],
      skippedSessionIds: ['coordinator-live'],
      skippedLiveSessionIds: ['coordinator-live'],
    })
    expect(sessionHostControl.stopSession).not.toHaveBeenCalled()
    expect(sessionHostControl.deleteSession).not.toHaveBeenCalled()
  })

  it('allows explicit session IDs to target live runtimes during manual cleanup', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'smoke-live', workspace: '/repo/worktree-a', lifecycle: 'running' },
      ]),
    })

    const result = await router.execute('cleanup_mesh_sessions', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      mode: 'stop',
      sessionIds: ['smoke-live'],
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      stoppedSessionIds: ['smoke-live'],
      skippedLiveSessionIds: [],
    })
    expect(sessionHostControl.stopSession).toHaveBeenCalledWith('smoke-live')
  })

  it('reports older hosts with unsupported delete as stopped-only with records remaining', async () => {
    const unsupported = new Error('Unsupported session host request: delete_session')
    const { router } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'done-1', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
        { sessionId: 'snapshot-1', workspace: '/repo/worktree-a', lifecycle: 'failed', meta: { restoredFromStorage: true } },
      ]),
      deleteSession: vi.fn(async () => { throw unsupported }),
    })

    const result = await router.execute('cleanup_mesh_sessions', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      mode: 'delete_stopped',
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      deleteUnsupported: true,
      effectiveCleanup: 'delete_unsupported_records_remain',
      deleteUnsupportedSessionIds: ['done-1', 'snapshot-1'],
      recordsRemainSessionIds: ['done-1', 'snapshot-1'],
      matchedBySurfaceKind: {
        live_runtime: 0,
        recovery_snapshot: 1,
        inactive_record: 1,
      },
    })
  })

  it('applies mesh policy cleanup before removing a node', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'done-1', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
      ]),
    })

    const result = await router.execute('remove_mesh_node', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: { sessionCleanupOnNodeRemove: 'delete_stopped' },
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      removed: true,
      sessionCleanup: {
        mode: 'delete_stopped',
        deletedSessionIds: ['done-1'],
      },
    })
    expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('done-1', { force: false })
  })

  it('blocks local worktree removal when the path is not the managed worktree path', async () => {
    const { dir, repoRoot } = await createTempGitRepo('adhdev-mesh-unsafe-path-')
    try {
      const branch = 'feat/safe-path'
      const unsafePath = join(dir, 'not-managed-worktree')
      await execFileAsync('git', ['worktree', 'add', unsafePath, '-b', branch], { cwd: repoRoot })
      const inlineMesh = {
        id: 'mesh-safe-path',
        name: 'Safe Path Mesh',
        policy: {},
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: unsafePath, repoRoot: unsafePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter()

      const result = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: false,
        removed: false,
        code: 'mesh_worktree_cleanup_unexpected_path',
      })
      expect(existsSync(unsafePath)).toBe(true)
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses a force fallback for clean managed worktrees that contain checked-out submodules', async () => {
    const { dir, repoRoot } = await createTempGitRepoWithSubmodule('adhdev-mesh-submodule-worktree-')
    try {
      const branch = 'feat/submodule-worktree'
      const meshName = 'submodule-worktree-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName })
      await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'], { cwd: created.worktreePath })
      const inlineMesh = {
        id: 'mesh-submodule-worktree',
        name: meshName,
        policy: {},
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter()

      const result = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: true,
        removed: true,
        worktreeCleanup: {
          success: true,
          fallback: 'git_worktree_remove_force_submodule',
          forced: true,
          reason: 'working_trees_containing_submodules',
        },
      })
      expect(existsSync(created.worktreePath)).toBe(false)
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks local worktree removal when the managed worktree has local changes', async () => {
    const { dir, repoRoot } = await createTempGitRepo('adhdev-mesh-dirty-worktree-')
    try {
      const branch = 'feat/dirty-worktree'
      const meshName = 'dirty-worktree-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName })
      await writeFile(join(created.worktreePath, 'dirty.txt'), 'uncommitted\n')
      const inlineMesh = {
        id: 'mesh-dirty-worktree',
        name: meshName,
        policy: {},
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      expect(created.worktreePath).toBe(resolveWorktreePath(repoRoot, meshName, branch))
      const { router } = createRouter()

      const result = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: false,
        removed: false,
      })
      expect(String((result as any).error)).toContain('Refusing to remove dirty worktree')
      expect(existsSync(created.worktreePath)).toBe(true)
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
