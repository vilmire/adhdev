import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'
import { createWorktree, resolveWorktreePath, getDefaultWorktreeBaseDir } from '../../src/git/git-worktree'
import { resolveConfigDir } from '../../src/config/config-dir'
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
  // Managed worktrees now default to <home>/.adhdev/worktrees. Point tests at a
  // per-temp-dir base via the worktreeBaseDir override so they never pollute the
  // real home dir and the finally { rm(dir) } fully cleans up.
  const worktreeBaseDir = join(dir, 'worktrees')
  return { dir, repoRoot, worktreeBaseDir }
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

  // Per-temp-dir worktree base (see createTempGitRepo) so home stays clean.
  const worktreeBaseDir = join(dir, 'worktrees')
  return { dir, repoRoot, submoduleRoot, worktreeBaseDir }
}

function createRouter(overrides: Record<string, unknown> = {}, depsOverrides: Record<string, unknown> = {}) {
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
    ...depsOverrides,
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
    const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepoWithSubmodule('adhdev-mesh-submodule-worktree-')
    try {
      const branch = 'feat/submodule-worktree'
      const meshName = 'submodule-worktree-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir })
      await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'], { cwd: created.worktreePath })
      const inlineMesh = {
        id: 'mesh-submodule-worktree',
        name: meshName,
        policy: { worktreeBaseDir },
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
  }, 60000)

  it('idempotently recovers when a managed worktree was already de-registered from git but a directory residue remains', async () => {
    const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-mesh-residue-recover-')
    try {
      const branch = 'feat/residue-recover'
      const meshName = 'residue-recover-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir })
      expect(created.worktreePath).toBe(resolveWorktreePath(repoRoot, meshName, branch, worktreeBaseDir))
      // Simulate the post-force-fallback re-entry state: git no longer lists the
      // worktree (de-registered) but a leftover directory residue remains on disk.
      await execFileAsync('git', ['worktree', 'remove', '--force', created.worktreePath], { cwd: repoRoot })
      await mkdir(created.worktreePath, { recursive: true })
      await writeFile(join(created.worktreePath, 'residue.txt'), 'leftover\n')
      expect(existsSync(created.worktreePath)).toBe(true)

      const inlineMesh = {
        id: 'mesh-residue-recover',
        name: meshName,
        policy: { worktreeBaseDir },
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter()

      const result: any = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: true,
        removed: true,
        worktreeCleanup: {
          success: true,
          recovered: true,
          reason: 'worktree_unregistered_residue_recovered',
        },
      })
      // Best-effort removal cleared the residue, and the node is dropped from the mesh.
      expect(existsSync(created.worktreePath)).toBe(false)
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('drops the node from the mesh even when the worktree directory residue cannot be removed', async () => {
    const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-mesh-residue-degate-')
    try {
      const branch = 'feat/residue-degate'
      const meshName = 'residue-degate-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir })
      await execFileAsync('git', ['worktree', 'remove', '--force', created.worktreePath], { cwd: repoRoot })
      await mkdir(created.worktreePath, { recursive: true })
      await writeFile(join(created.worktreePath, 'stuck.txt'), 'cannot-remove\n')

      const inlineMesh = {
        id: 'mesh-residue-degate',
        name: meshName,
        policy: { worktreeBaseDir },
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter()
      // Simulate a Windows EINVAL-style un-removable residue: best-effort removal
      // reports the directory could not be deleted. Membership removal must NOT be
      // gated on this — the node should still be dropped from the mesh.
      ;(router as any).bestEffortRemoveWorktreeDir = vi.fn(async () => ({ removed: false, residue: true, error: 'simulated EINVAL: invalid argument' }))

      const result: any = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      expect(result.success).toBe(true)
      expect(result.removed).toBe(true)
      expect(typeof result.residueWarning).toBe('string')
      expect(result.residueWarning).toContain('could not be fully removed')
      expect(result.worktreeCleanup).toMatchObject({ success: true, residue: true })
      // Node is gone from the mesh registry even though the directory still exists.
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(false)
      expect(existsSync(created.worktreePath)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('blocks local worktree removal when the managed worktree has local changes AND leaves the delegated session untouched (precheck-first)', async () => {
    const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-mesh-dirty-worktree-')
    try {
      const branch = 'feat/dirty-worktree'
      const meshName = 'dirty-worktree-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir })
      await writeFile(join(created.worktreePath, 'dirty.txt'), 'uncommitted\n')
      const inlineMesh = {
        id: 'mesh-dirty-worktree',
        name: meshName,
        policy: { worktreeBaseDir },
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      expect(created.worktreePath).toBe(resolveWorktreePath(repoRoot, meshName, branch, worktreeBaseDir))
      // A live delegated session bound to the worktree workspace. The dirty-worktree
      // refusal must NOT stop/delete it — pre-fix, session cleanup ran first and
      // orphaned the session before the dirty check rejected the removal.
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'live-1', workspace: created.worktreePath, lifecycle: 'running' },
        ]),
      })

      const result = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      // The live-occupancy guard (WORKTREE-DELETED-WHILE-RUNNING) now refuses
      // FIRST — a busy worktree must not be removed even when its content is
      // safe, and the running session here is precisely what that guard exists
      // to protect. The property this test is really about is unchanged and
      // asserted below: the refusal happens BEFORE any session cleanup, so the
      // delegated session is left fully intact.
      expect(result).toMatchObject({
        success: false,
        removed: false,
        code: 'mesh_worktree_cleanup_live_session',
      })
      expect(String((result as any).error)).toContain('is still live in it')
      // The session was deliberately preserved: no stop/delete, and no sessionCleanup
      // key in the refusal response.
      expect(sessionHostControl.stopSession).not.toHaveBeenCalled()
      expect(sessionHostControl.deleteSession).not.toHaveBeenCalled()
      expect((result as any).sessionCleanup).toBeUndefined()
      expect(String((result as any).recoveryHint)).toContain('session was left running')
      expect(existsSync(created.worktreePath)).toBe(true)
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks removal of a DIRTY but IDLE worktree with the dirty code (no live session to mask it)', async () => {
    // Companion to the test above: with the worktree idle, the occupancy guard
    // passes and the dirty refusal is the one that fires, so the long-standing
    // dirty guard keeps direct coverage.
    const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-mesh-dirty-idle-')
    try {
      const branch = 'feat/dirty-idle-worktree'
      const meshName = 'dirty-idle-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir })
      await writeFile(join(created.worktreePath, 'dirty.txt'), 'uncommitted\n')
      const inlineMesh = {
        id: 'mesh-dirty-idle',
        name: meshName,
        policy: { worktreeBaseDir },
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter({ listSessions: vi.fn(async () => []) })

      const result = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: false,
        removed: false,
        code: 'mesh_worktree_cleanup_dirty',
      })
      expect(String((result as any).error)).toContain('Refusing to remove dirty worktree')
      expect(existsSync(created.worktreePath)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still removes a clean local worktree and cleans up its delegated session (precheck pass preserves the happy path)', async () => {
    const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-mesh-clean-worktree-')
    try {
      const branch = 'feat/clean-worktree'
      const meshName = 'clean-worktree-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir })
      expect(created.worktreePath).toBe(resolveWorktreePath(repoRoot, meshName, branch, worktreeBaseDir))
      const inlineMesh = {
        id: 'mesh-clean-worktree',
        name: meshName,
        policy: { worktreeBaseDir },
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      // A running session bound to the worktree → default worktree cleanup mode
      // (stop_and_delete) must stop AND delete it once the precheck passes.
      //
      // `force: true` is now required to reach that path with a LIVE session:
      // since WORKTREE-DELETED-WHILE-RUNNING the precheck refuses an occupied
      // worktree by default, because deleting one out from under a working
      // agent is what destroyed a worker's unpushed work. Forcing is the
      // documented operator override and is what this test needs in order to
      // keep covering the stop_and_delete + directory-removal behavior itself.
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'live-1', workspace: created.worktreePath, lifecycle: 'running' },
        ]),
      })

      const result: any = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
        force: true,
      })

      expect(result).toMatchObject({ success: true, removed: true, worktreeCleanup: { success: true } })
      // Default worktree cleanup mode is stop_and_delete: a live workspace-bound
      // session is force-deleted (it does not route through stopSession).
      expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('live-1', { force: true })
      expect(existsSync(created.worktreePath)).toBe(false)
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('removes a clean IDLE worktree with no force at all (the guards do not break normal cleanup)', async () => {
    // The counterweight to the occupancy guard: the ordinary case — nothing
    // running, nothing dirty — must still succeed without any override, or the
    // guards would have turned a safety fix into a workflow blocker.
    const { dir, repoRoot, worktreeBaseDir } = await createTempGitRepo('adhdev-mesh-idle-worktree-')
    try {
      const branch = 'feat/idle-worktree'
      const meshName = 'idle-worktree-mesh'
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir })
      const inlineMesh = {
        id: 'mesh-idle-worktree',
        name: meshName,
        policy: { worktreeBaseDir },
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter({ listSessions: vi.fn(async () => []) })

      const result: any = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-worktree',
        inlineMesh,
      })

      expect(result).toMatchObject({ success: true, removed: true, worktreeCleanup: { success: true } })
      expect(existsSync(created.worktreePath)).toBe(false)
      expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('refuses to remove the coordinator base node (same daemon, not a worktree) without force', async () => {
    const meshId = `mesh-base-guard-${Date.now()}`
    try {
      // statusInstanceId matches the node daemonId → this is the coordinator's
      // own local base node. It is NOT a worktree, so removing it would break
      // live mesh membership; the guard must reject without force.
      const { router } = createRouter({}, { statusInstanceId: 'coordinator-daemon-1' })
      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-base',
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-base', workspace: '/Users/me/Work/adhdev', daemonId: 'coordinator-daemon-1' }],
        },
      })
      expect(result).toMatchObject({
        success: false,
        removed: false,
        code: 'mesh_remove_coordinator_base_node_protected',
      })
      expect(String(result.error)).toContain("coordinator's own base node")
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('refuses to remove the coordinator base node when self-id and node.daemonId are different id-forms of the same machine', async () => {
    const meshId = `mesh-base-guard-canon-${Date.now()}`
    try {
      // CANON regression: a daemon answers to the same machine under interchangeable
      // id forms. Here the coordinator's statusInstanceId is the standalone form
      // (`standalone_mach_<core>`) while the stored node.daemonId is the cloud form
      // (`daemon_mach_<core>`) — SAME machine core, DIFFERENT string. A raw `===`
      // guard would miss this self-match and fail open, letting the coordinator delete
      // its own live base node. The form-safe daemonIdsEquivalent collapses both forms
      // to `mach_<core>` and rejects the removal.
      const { router } = createRouter({}, { statusInstanceId: 'standalone_mach_canonbase01' })
      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-base',
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-base', workspace: '/Users/me/Work/adhdev', daemonId: 'daemon_mach_canonbase01' }],
        },
      })
      expect(result).toMatchObject({
        success: false,
        removed: false,
        code: 'mesh_remove_coordinator_base_node_protected',
      })
      expect(String(result.error)).toContain("coordinator's own base node")
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('removes the coordinator base node when force:true is passed', async () => {
    const meshId = `mesh-base-force-${Date.now()}`
    try {
      const { router } = createRouter({}, { statusInstanceId: 'coordinator-daemon-1' })
      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-base',
        force: true,
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-base', workspace: '/Users/me/Work/adhdev', daemonId: 'coordinator-daemon-1' }],
        },
      })
      expect(result).toMatchObject({ success: true, removed: true })
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('cleans a workspace-only live session when removing a WORKTREE node (no longer orphans the chat)', async () => {
    // NODE-REMOVE-SESSION-ORPHAN regression: a worktree's node-binding is already
    // gone by removal time, so a still-live chat in that workspace matches only by
    // workspace path. The old guard conservatively SKIPPED it, orphaning the chat.
    // For a worktree removal that workspace-only-matched live session must now be
    // stopped+deleted instead of skipped.
    const meshId = `mesh-worktree-orphan-${Date.now()}`
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          // workspace-only live session (no meta.meshNodeId binding) — the orphan case
          { sessionId: 'orphan-live', workspace: '/repo/worktree-a', lifecycle: 'running' },
          // coordinator session in the same workspace — must STILL be protected
          { sessionId: 'coordinator-live', workspace: '/repo/worktree-a', lifecycle: 'running', meta: { meshCoordinatorFor: meshId } },
          // a live session bound to ANOTHER node — must still be skipped
          { sessionId: 'delegate-b', workspace: '/repo/worktree-a', lifecycle: 'running', meta: { meshNodeId: 'node-b', meshNodeFor: meshId } },
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
          // isLocalWorktree node whose workspace path does not exist on disk →
          // worktree cleanup is a no-op skip; session cleanup runs first.
          nodes: [{ id: 'node-a', workspace: '/repo/worktree-a', isLocalWorktree: true, worktreeBranch: 'feat/a', clonedFromNodeId: 'source' }],
        },
      })

      expect(result.success).toBe(true)
      expect(result.removed).toBe(true)
      // The previously-orphaned workspace-only live session is now force-deleted.
      expect(result.sessionCleanup.deletedSessionIds).toContain('orphan-live')
      expect(result.sessionCleanup.skippedSessionIds).not.toContain('orphan-live')
      expect(result.sessionCleanup.skippedLiveSessionIds).not.toContain('orphan-live')
      expect(result.sessionCleanup.actedLiveDelegateSessionIds).toContain('orphan-live')
      // Coordinator session is STILL protected on a worktree.
      expect(result.sessionCleanup.skippedCoordinatorSessionIds).toContain('coordinator-live')
      expect(result.sessionCleanup.skippedSessionIds).toContain('coordinator-live')
      // A session bound to another node is STILL skipped with the bound-other reason.
      expect(result.sessionCleanup.skippedSessionIds).toContain('delegate-b')
      const reasons = result.sessionCleanup.skippedLiveSessionReasons as Array<{ sessionId: string; reason: string }>
      expect(reasons.find(r => r.sessionId === 'delegate-b')?.reason).toBe('live_delegate_bound_to_other_node:node-b')
      // orphan-live force-deleted, coordinator/delegate-b never touched.
      expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('orphan-live', { force: true })
      expect(sessionHostControl.deleteSession).not.toHaveBeenCalledWith('coordinator-live', { force: true })
      expect(sessionHostControl.deleteSession).not.toHaveBeenCalledWith('delegate-b', { force: true })
      // delegate-b is bound to another node and legitimately survives → it is still a
      // remaining live session, so orphanedSessionsRemaining truthfully flags it (and ONLY it).
      expect(result.orphanedSessionsRemaining).toBe(true)
      expect(result.nextAction).toContain('delegate-b')
      expect(result.nextAction).not.toContain('orphan-live')
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('still SKIPS a workspace-only live session when removing a BASE node (shared-daemon guard unchanged)', async () => {
    // The worktree exception must NOT widen to base nodes: a base node shares its
    // workspace/daemon, so a workspace-only live session could belong to a sibling.
    const meshId = `mesh-base-orphan-guard-${Date.now()}`
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'ambient-live', workspace: '/repo/base', lifecycle: 'running' },
        ]),
      })

      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-base',
        sessionCleanupMode: 'stop_and_delete',
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          // NOT a worktree, and daemonId left unset so the coordinator-base guard
          // does not fire (statusInstanceId is undefined in this router).
          nodes: [{ id: 'node-base', workspace: '/repo/base' }],
        },
      })

      expect(result.success).toBe(true)
      expect(result.removed).toBe(true)
      // Unchanged base-node behavior: workspace-only live session is skipped.
      expect(result.sessionCleanup.skippedLiveSessionIds).toContain('ambient-live')
      const reasons = result.sessionCleanup.skippedLiveSessionReasons as Array<{ sessionId: string; reason: string }>
      expect(reasons.find(r => r.sessionId === 'ambient-live')?.reason).toBe('live_session_matched_by_workspace_only_no_node_binding')
      expect(sessionHostControl.deleteSession).not.toHaveBeenCalled()
      // A live session was skipped → orphanedSessionsRemaining surfaced with a nextAction.
      expect(result.orphanedSessionsRemaining).toBe(true)
      expect(typeof result.nextAction).toBe('string')
      expect(result.nextAction).toContain('ambient-live')
      expect(result.nextAction).toContain('mesh_cleanup_sessions')
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('defaults an OMITTED cleanup mode to stop_and_delete for a worktree node', async () => {
    // FIX(3): when the caller omits a mode and the node is a worktree, default to
    // stop_and_delete (not the policy 'preserve'), so a worktree chat does not survive.
    const meshId = `mesh-worktree-default-${Date.now()}`
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'orphan-live', workspace: '/repo/worktree-a', lifecycle: 'running' },
        ]),
      })

      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-a',
        // NO sessionCleanupMode passed, and policy is default (preserve).
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-a', workspace: '/repo/worktree-a', isLocalWorktree: true, worktreeBranch: 'feat/a', clonedFromNodeId: 'source' }],
        },
      })

      expect(result.success).toBe(true)
      expect(result.removed).toBe(true)
      // Defaulted to stop_and_delete → the live session is force-deleted, not preserved.
      expect(result.sessionCleanup.mode).toBe('stop_and_delete')
      expect(result.sessionCleanup.deletedSessionIds).toContain('orphan-live')
      expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('orphan-live', { force: true })
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('honors an explicit preserve mode on a worktree node (only the OMITTED case defaults)', async () => {
    const meshId = `mesh-worktree-explicit-preserve-${Date.now()}`
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'orphan-live', workspace: '/repo/worktree-a', lifecycle: 'running' },
        ]),
      })

      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-a',
        sessionCleanupMode: 'preserve',
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-a', workspace: '/repo/worktree-a', isLocalWorktree: true, worktreeBranch: 'feat/a', clonedFromNodeId: 'source' }],
        },
      })

      expect(result.success).toBe(true)
      expect(result.removed).toBe(true)
      // Explicit preserve honored: no session cleanup ran at all.
      expect(sessionHostControl.deleteSession).not.toHaveBeenCalled()
      expect(sessionHostControl.stopSession).not.toHaveBeenCalled()
      expect(result.orphanedSessionsRemaining).toBeFalsy()
    } finally {
      cleanupLedgerFile(meshId)
    }
  })

  it('does not guard a worktree node owned by the coordinator daemon', async () => {
    const meshId = `mesh-base-worktree-${Date.now()}`
    try {
      // Same daemon, but isLocalWorktree:true → safe to remove, no guard. The
      // worktree-cleanup path will run; for this inline node without a real
      // worktree on disk it simply removes the membership entry.
      const { router } = createRouter({}, { statusInstanceId: 'coordinator-daemon-1' })
      const result: any = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node-wt',
        sessionCleanupMode: 'preserve',
        inlineMesh: {
          id: meshId,
          name: 'Mesh',
          policy: {},
          nodes: [{ id: 'node-wt', workspace: '/repo/worktree-x', daemonId: 'coordinator-daemon-1', isLocalWorktree: true, worktreeBranch: 'feat/x', clonedFromNodeId: 'node-base' }],
        },
      })
      // The guard is NOT the thing that blocks here — it must not produce the
      // coordinator-base-node protection code for a worktree node.
      expect(result?.code).not.toBe('mesh_remove_coordinator_base_node_protected')
    } finally {
      cleanupLedgerFile(meshId)
    }
  })
})

describe('worktree base directory (home default + override + legacy back-compat)', () => {
  it('defaults the managed worktree base to <configDir>/worktrees', async () => {
    const { dir, repoRoot } = await createTempGitRepo('adhdev-mesh-wt-default-base-')
    // Unique mesh name so this test never collides across runs; the finally
    // block defensively removes + prunes the resulting worktree.
    const meshName = `default-base-mesh-${process.pid}-${dir.length}`
    const branch = 'feat/default-base'
    let created: Awaited<ReturnType<typeof createWorktree>> | undefined
    try {
      created = await createWorktree({ repoRoot, branch, meshName })
      // The physical worktree lives under the home base, NOT under the repo parent.
      expect(created.worktreePath).toBe(resolveWorktreePath(repoRoot, meshName, branch))
      expect(created.worktreePath.startsWith(getDefaultWorktreeBaseDir())).toBe(true)
      // Track/config-dir-derived, not the literal '.adhdev': the base now
      // honours ADHDEV_CONFIG_DIR, which setup-env.ts pins to a temp dir for
      // every test. Asserting '.adhdev' here previously only passed because the
      // base ignored that isolation and wrote into the developer's real ~/.adhdev.
      expect(created.worktreePath).toContain(join('worktrees', meshName, 'feat-default-base'))
      expect(created.worktreePath.startsWith(join(resolveConfigDir(), 'worktrees'))).toBe(true)
      // Cleanup via remove_mesh_node accepts and removes the home-based worktree.
      const inlineMesh = {
        id: 'mesh-default-base',
        name: meshName,
        policy: {},
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter()
      const result: any = await router.execute('remove_mesh_node', { meshId: inlineMesh.id, nodeId: 'node-worktree', inlineMesh })
      expect(result).toMatchObject({ success: true, removed: true, worktreeCleanup: { success: true } })
      expect(existsSync(created.worktreePath)).toBe(false)
    } finally {
      // Defensive: never leave residue in the real home dir if the assertions above
      // failed before remove_mesh_node cleaned it up. Also remove the now-empty
      // <home>/.adhdev/worktrees/<meshName> parent dir that createWorktree mkdir'd.
      if (created?.worktreePath && existsSync(created.worktreePath)) {
        await execFileAsync('git', ['worktree', 'remove', '--force', created.worktreePath], { cwd: repoRoot }).catch(() => {})
        await rm(created.worktreePath, { recursive: true, force: true }).catch(() => {})
      }
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => {})
      await rm(join(getDefaultWorktreeBaseDir(), meshName), { recursive: true, force: true }).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('honors a worktreeBaseDir override and cleanup accepts the overridden path', async () => {
    const { dir, repoRoot } = await createTempGitRepo('adhdev-mesh-wt-override-base-')
    try {
      const branch = 'feat/override-base'
      const meshName = 'override-base-mesh'
      const overrideBase = join(dir, 'custom-worktrees')
      const created = await createWorktree({ repoRoot, branch, meshName, worktreeBaseDir: overrideBase })
      // The override wins: the worktree lands under the custom base, not the home default.
      expect(created.worktreePath).toBe(resolveWorktreePath(repoRoot, meshName, branch, overrideBase))
      expect(created.worktreePath.startsWith(overrideBase)).toBe(true)
      expect(created.worktreePath.startsWith(getDefaultWorktreeBaseDir())).toBe(false)

      // Cleanup resolves the SAME override from mesh.policy.worktreeBaseDir, so the
      // guard accepts the overridden path (no unexpected_path refusal) and removes it.
      const inlineMesh = {
        id: 'mesh-override-base',
        name: meshName,
        policy: { worktreeBaseDir: overrideBase },
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: created.worktreePath, repoRoot: created.worktreePath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter()
      const result: any = await router.execute('remove_mesh_node', { meshId: inlineMesh.id, nodeId: 'node-worktree', inlineMesh })
      expect(result).toMatchObject({ success: true, removed: true, worktreeCleanup: { success: true } })
      expect(existsSync(created.worktreePath)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('cleanup guard removes a LEGACY <repoParent>/.adhdev-worktrees worktree (back-compat)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('adhdev-mesh-wt-legacy-base-')
    try {
      const branch = 'feat/legacy-base'
      const meshName = 'legacy-base-mesh'
      // Physically create the worktree at the OLD (pre-home-dir) location that
      // createWorktree no longer produces, then register a node pointing at it.
      const legacyPath = join(repoRoot, '..', '.adhdev-worktrees', meshName, 'feat-legacy-base')
      await execFileAsync('git', ['worktree', 'add', '-b', branch, legacyPath], { cwd: repoRoot })
      expect(existsSync(legacyPath)).toBe(true)
      // Sanity: this is NOT the current default base — it only removes via back-compat.
      expect(legacyPath.startsWith(getDefaultWorktreeBaseDir())).toBe(false)

      const inlineMesh = {
        id: 'mesh-legacy-base',
        name: meshName,
        policy: {},
        nodes: [
          { id: 'source', workspace: repoRoot, repoRoot },
          { id: 'node-worktree', workspace: legacyPath, repoRoot: legacyPath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
        ],
      }
      const { router } = createRouter()
      const result: any = await router.execute('remove_mesh_node', { meshId: inlineMesh.id, nodeId: 'node-worktree', inlineMesh })
      // The legacy path must NOT be rejected as an unexpected managed path.
      expect(result?.worktreeCleanup?.code).not.toBe('mesh_worktree_cleanup_unexpected_path')
      expect(result).toMatchObject({ success: true, removed: true, worktreeCleanup: { success: true } })
      expect(existsSync(legacyPath)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)
})
