import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'
import { createWorktree, resolveWorktreePath } from '../../src/git/git-worktree'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger'

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

function cleanupLedgerFile(meshId: string) {
  const ledgerPath = join(getLedgerDir(), `${meshId}.jsonl`)
  if (existsSync(ledgerPath)) unlinkSync(ledgerPath)
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

  it('stops a live delegate session explicitly bound to the node being removed even on a shared daemon', async () => {
    const meshId = `mesh-delegate-stop-${Date.now()}`
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          // delegate launched FOR node-a on the shared daemon — must be stopped+deleted
          { sessionId: 'delegate-a', workspace: '/repo/worktree-a', lifecycle: 'running', meta: { meshNodeId: 'node-a', meshNodeFor: meshId, launchedByCoordinator: true } },
          // coordinator session in the same workspace — must be protected
          { sessionId: 'coordinator-live', workspace: '/repo/worktree-a', lifecycle: 'running', meta: { meshCoordinatorFor: meshId } },
          // a live session bound to a different node — must be skipped with a reason
          { sessionId: 'delegate-b', workspace: '/repo/worktree-a', lifecycle: 'running', meta: { meshNodeId: 'node-b', meshNodeFor: meshId } },
          // a live session matched only by workspace (no node binding) — conservative skip with reason
          { sessionId: 'ambient-live', workspace: '/repo/worktree-a', lifecycle: 'running' },
        ]),
      })

      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-a',
        sessionCleanupMode: 'stop_and_delete',
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
        },
      })

      expect(result).toMatchObject({
        success: true,
        removed: true,
        sessionCleanup: {
          deletedSessionIds: ['delegate-a'],
          actedLiveDelegateSessionIds: ['delegate-a'],
          skippedCoordinatorSessionIds: ['coordinator-live'],
        },
      })
      // delegate-a stopped+deleted; coordinator + other-node + ambient all skipped
      expect(result.sessionCleanup.skippedSessionIds).toEqual(
        expect.arrayContaining(['coordinator-live', 'delegate-b', 'ambient-live']),
      )
      expect(result.sessionCleanup.skippedSessionIds).not.toContain('delegate-a')
      expect(result.sessionCleanup.skippedLiveSessionIds).toEqual(
        expect.arrayContaining(['delegate-b', 'ambient-live']),
      )
      // clear, machine-readable skip reasons instead of an unexplained skip
      const reasons = result.sessionCleanup.skippedLiveSessionReasons as Array<{ sessionId: string; reason: string }>
      expect(reasons.find(r => r.sessionId === 'delegate-b')?.reason).toBe('live_delegate_bound_to_other_node:node-b')
      expect(reasons.find(r => r.sessionId === 'ambient-live')?.reason).toBe('live_session_matched_by_workspace_only_no_node_binding')
      // delegate-a actually force-deleted; coordinator/other never touched
      expect(sessionHostControl.deleteSession).toHaveBeenCalledTimes(1)
      expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('delegate-a', { force: true })
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('preserves a live bound delegate under delete_stopped mode with a clear reason (stop/stop_and_delete required)', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'delegate-a', workspace: '/repo/worktree-a', lifecycle: 'running', meta: { meshNodeId: 'node-a', meshNodeFor: 'mesh-1' } },
      ]),
    })

    const result: any = await router.execute('cleanup_mesh_sessions', {
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

    expect(result.skippedLiveSessionIds).toContain('delegate-a')
    expect((result.skippedLiveSessionReasons as Array<{ sessionId: string; reason: string }>)
      .find(r => r.sessionId === 'delegate-a')?.reason)
      .toBe('live_delegate_preserved_by_delete_stopped_mode_use_stop_or_stop_and_delete')
    expect(sessionHostControl.deleteSession).not.toHaveBeenCalled()
    expect(sessionHostControl.stopSession).not.toHaveBeenCalled()
  })

  it('protects coordinator sessions from broad remove-node cleanup even when they are no longer live runtimes', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        {
          sessionId: 'coordinator-inactive',
          workspace: '/repo/worktree-a',
          lifecycle: 'stopped',
          surfaceKind: 'inactive_record',
          meta: { meshCoordinatorFor: 'mesh-1' },
        },
        {
          sessionId: 'worker-stopped',
          workspace: '/repo/worktree-a',
          lifecycle: 'stopped',
        },
      ]),
    })

    const result = await router.execute('remove_mesh_node', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      sessionCleanupMode: 'stop_and_delete',
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      removed: true,
      sessionCleanup: {
        deletedSessionIds: ['worker-stopped'],
        skippedSessionIds: ['coordinator-inactive'],
        skippedCoordinatorSessionIds: ['coordinator-inactive'],
      },
    })
    expect(sessionHostControl.deleteSession).toHaveBeenCalledTimes(1)
    expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('worker-stopped', { force: true })
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
    cleanupLedgerFile('mesh-1')
  })

  it('records operator cleanup stop intent before stopping live sessions', async () => {
    const meshId = `mesh-cleanup-intent-${Date.now()}`
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'duplicate-live', workspace: '/repo/worktree-a', lifecycle: 'running' },
        ]),
      })

      const result = await router.execute('cleanup_mesh_sessions', {
        meshId,
        nodeId: 'node-a',
        mode: 'stop',
        sessionIds: ['duplicate-live'],
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
        },
      })

      expect(result).toMatchObject({ success: true, stoppedSessionIds: ['duplicate-live'] })
      expect(sessionHostControl.stopSession).toHaveBeenCalledWith('duplicate-live')
      const entries = readLedgerEntries(meshId)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'session_stopped',
        nodeId: 'node-a',
        sessionId: 'duplicate-live',
        payload: {
          intentional: true,
          reason: 'operator_cleanup',
          source: 'mesh_cleanup_sessions',
          cleanupMode: 'stop',
          action: 'stop_session',
          workspace: '/repo/worktree-a',
        },
      })
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('records remove-node cleanup as intentional stop before force deleting non-completed sessions', async () => {
    const meshId = `mesh-remove-intent-${Date.now()}`
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'remove-live', workspace: '/repo/worktree-a', lifecycle: 'created' },
        ]),
      })
      const inlineMesh = {
        id: meshId,
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      }

      const result = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-a',
        sessionCleanupMode: 'stop_and_delete',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: true,
        removed: true,
        sessionCleanup: { deletedSessionIds: ['remove-live'] },
      })
      expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('remove-live', { force: true })
      const stopIntent = readLedgerEntries(meshId).find(entry => entry.kind === 'session_stopped')
      expect(stopIntent).toMatchObject({
        nodeId: 'node-a',
        sessionId: 'remove-live',
        payload: {
          intentional: true,
          reason: 'operator_cleanup',
          source: 'mesh_remove_node',
          cleanupMode: 'stop_and_delete',
          action: 'delete_session_force',
        },
      })
    } finally {
      cleanupLedgerFile(meshId)
    }
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
