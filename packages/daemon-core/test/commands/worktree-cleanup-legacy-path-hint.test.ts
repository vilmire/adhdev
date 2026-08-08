import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

// Route homedir() to a per-test tmp dir so the legacy-path detection
// (<homedir>/.adhdev/worktrees, <homedir>/.adhdev-preview/worktrees) can be
// exercised without touching the real home directory. Scoped to this file
// only — mesh-session-cleanup.test.ts relies on the REAL homedir() for its
// own getDefaultWorktreeBaseDir()/resolveConfigDir() assertions.
let fakeHome = ''
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => fakeHome }
})

const execFileAsync = promisify(execFile)

const cleanups: string[] = []
afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function createTempGitRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  const repoRoot = join(dir, 'repo')
  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  return { dir, repoRoot }
}

function createRouter() {
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
  }

  return { sessionHostControl }
}

async function buildRouter() {
  const { DaemonCommandRouter } = await import('../../src/commands/router')
  const { sessionHostControl } = createRouter()
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
    sessionHostControl: sessionHostControl as any,
  })
}

describe('mesh_remove_node unexpected-path recoveryHint', () => {
  it('adds a legacy-path recovery hint when the workspace sits under a known track worktrees dir', async () => {
    const { dir, repoRoot } = await createTempGitRepo('adhdev-legacy-track-path-')
    fakeHome = dir

    const branch = 'feat/legacy-track-path'
    // Simulate a worktree created before oss c24ae254 by a preview daemon that
    // hard-coded '.adhdev' instead of the track-aware config dir: physically
    // under <home>/.adhdev/worktrees, which the CURRENT (fixed) resolver for
    // this track never produces.
    const legacyPath = join(fakeHome, '.adhdev', 'worktrees', 'some-mesh', 'feat-legacy-track-path')
    await execFileAsync('git', ['worktree', 'add', '-b', branch, legacyPath], { cwd: repoRoot })
    expect(existsSync(legacyPath)).toBe(true)

    const inlineMesh = {
      id: 'mesh-legacy-track-path',
      name: 'some-mesh',
      policy: {},
      nodes: [
        { id: 'source', workspace: repoRoot, repoRoot },
        { id: 'node-worktree', workspace: legacyPath, repoRoot: legacyPath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
      ],
    }
    const router = await buildRouter()
    const result: any = await router.execute('remove_mesh_node', { meshId: inlineMesh.id, nodeId: 'node-worktree', inlineMesh })

    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_worktree_cleanup_unexpected_path')
    // The guard itself must still refuse — this test only asserts the message.
    expect(existsSync(legacyPath)).toBe(true)
    expect(inlineMesh.nodes.some(node => node.id === 'node-worktree')).toBe(true)
    expect(result.recoveryHint).toContain('git worktree remove --force')
    expect(result.recoveryHint).toContain(legacyPath)
    expect(result.recoveryHint).toContain('legacy')
  })

  it('does NOT add the legacy-path hint for an unmanaged path outside any track worktrees dir', async () => {
    const { dir, repoRoot } = await createTempGitRepo('adhdev-unmanaged-path-')
    fakeHome = dir

    const branch = 'feat/unmanaged-path'
    const unmanagedPath = join(dir, 'not-managed-worktree')
    await execFileAsync('git', ['worktree', 'add', unmanagedPath, '-b', branch], { cwd: repoRoot })

    const inlineMesh = {
      id: 'mesh-unmanaged-path',
      name: 'Unmanaged Path Mesh',
      policy: {},
      nodes: [
        { id: 'source', workspace: repoRoot, repoRoot },
        { id: 'node-worktree', workspace: unmanagedPath, repoRoot: unmanagedPath, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'source' },
      ],
    }
    const router = await buildRouter()
    const result: any = await router.execute('remove_mesh_node', { meshId: inlineMesh.id, nodeId: 'node-worktree', inlineMesh })

    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_worktree_cleanup_unexpected_path')
    expect(result.recoveryHint).not.toContain('git worktree remove --force')
    expect(result.recoveryHint).not.toContain('legacy')
  })
})
