import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'

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

function createRouter() {
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
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    statusInstanceId: 'daemon-local',
  })
  return { router }
}

afterEach(resetMeshRuntimeStore)

/**
 * CLONE-AFTER-IDLE-REMINDER guard, wired through the REAL router/handler
 * (not just the pure cloneRequiresIdleReminderReason function unit-tested in
 * mesh-idle-reminder.test.ts). Confirms the guard actually intercepts
 * `clone_mesh_node` at the command-router level: a reminder having just fired
 * for the mesh blocks a bare clone, a `reason` or `taskId` unblocks it, and a
 * clone made outside the guard window is entirely unaffected.
 *
 * ★2026-09-24 incident this guards: a coordinator autonomously cloned two
 * worktrees in direct response to the idle-mission reminder's nudge, which
 * only ever intended "check state and report".
 */
describe('clone_mesh_node — CLONE-AFTER-IDLE-REMINDER guard (router-level)', () => {
  async function setup() {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-clone-idle-guard-config-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-clone-idle-guard-repo-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = configDir

    const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
    const mesh = createMesh({ name: 'Idle Guard Mesh', repoIdentity: 'github.com/acme/idle-guard-mesh', defaultBranch: 'main' })
    const sourceNode = addNode(mesh.id, { workspace: repoRoot, repoRoot, daemonId: 'daemon-local' })
    const { router } = createRouter()

    const cleanup = async () => {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
    }
    return { mesh, sourceNode: sourceNode!, router, dir, cleanup }
  }

  it('blocks a bare clone right after an idle reminder fired for this mesh', async () => {
    const { mesh, sourceNode, router, cleanup } = await setup()
    try {
      const { MeshRuntimeStore } = await import('../../src/mesh/mesh-runtime-store.js')
      MeshRuntimeStore.getInstance().setIdleReminderState(mesh.id, { emittedAt: Date.now(), missionSetHash: 'm1' })

      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode.id,
        branch: 'feature/blocked-by-guard',
      }) as any

      expect(clone.success).toBe(false)
      expect(clone.code).toBe('clone_requires_reason_after_idle_reminder')
    } finally {
      await cleanup()
    }
  })

  it('allows the clone through when a `reason` is supplied', async () => {
    const { mesh, sourceNode, router, dir, cleanup } = await setup()
    try {
      const { MeshRuntimeStore } = await import('../../src/mesh/mesh-runtime-store.js')
      MeshRuntimeStore.getInstance().setIdleReminderState(mesh.id, { emittedAt: Date.now(), missionSetHash: 'm1' })

      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode.id,
        branch: 'feature/allowed-with-reason',
        reason: 'mission plan step 3 needs a parallel worker node',
        inlineMesh: {
          id: mesh.id, name: mesh.name, repoIdentity: mesh.repoIdentity, defaultBranch: 'main',
          policy: { worktreeBaseDir: join(dir, 'worktrees') },
          nodes: [{ id: sourceNode.id, daemonId: 'daemon-local', workspace: sourceNode.workspace, repoRoot: sourceNode.repoRoot, policy: {} }],
        },
      }) as any

      expect(clone.code).not.toBe('clone_requires_reason_after_idle_reminder')
      expect(clone.success).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('allows the clone through when a `taskId` justification is supplied', async () => {
    const { mesh, sourceNode, router, dir, cleanup } = await setup()
    try {
      const { MeshRuntimeStore } = await import('../../src/mesh/mesh-runtime-store.js')
      MeshRuntimeStore.getInstance().setIdleReminderState(mesh.id, { emittedAt: Date.now(), missionSetHash: 'm1' })

      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode.id,
        branch: 'feature/allowed-with-taskid',
        taskId: 'task_123',
        inlineMesh: {
          id: mesh.id, name: mesh.name, repoIdentity: mesh.repoIdentity, defaultBranch: 'main',
          policy: { worktreeBaseDir: join(dir, 'worktrees') },
          nodes: [{ id: sourceNode.id, daemonId: 'daemon-local', workspace: sourceNode.workspace, repoRoot: sourceNode.repoRoot, policy: {} }],
        },
      }) as any

      expect(clone.code).not.toBe('clone_requires_reason_after_idle_reminder')
      expect(clone.success).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('does not block a clone when no idle reminder has fired for this mesh', async () => {
    const { mesh, sourceNode, router, dir, cleanup } = await setup()
    try {
      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode.id,
        branch: 'feature/no-reminder-fired',
        inlineMesh: {
          id: mesh.id, name: mesh.name, repoIdentity: mesh.repoIdentity, defaultBranch: 'main',
          policy: { worktreeBaseDir: join(dir, 'worktrees') },
          nodes: [{ id: sourceNode.id, daemonId: 'daemon-local', workspace: sourceNode.workspace, repoRoot: sourceNode.repoRoot, policy: {} }],
        },
      }) as any

      expect(clone.code).not.toBe('clone_requires_reason_after_idle_reminder')
      expect(clone.success).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('does not block a clone once the guard window has elapsed', async () => {
    const { mesh, sourceNode, router, dir, cleanup } = await setup()
    try {
      const { MeshRuntimeStore } = await import('../../src/mesh/mesh-runtime-store.js')
      const { CLONE_AFTER_IDLE_REMINDER_GUARD_MS } = await import('../../src/mesh/mesh-idle-reminder.js')
      MeshRuntimeStore.getInstance().setIdleReminderState(mesh.id, {
        emittedAt: Date.now() - CLONE_AFTER_IDLE_REMINDER_GUARD_MS - 1000,
        missionSetHash: 'm1',
      })

      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode.id,
        branch: 'feature/window-elapsed',
        inlineMesh: {
          id: mesh.id, name: mesh.name, repoIdentity: mesh.repoIdentity, defaultBranch: 'main',
          policy: { worktreeBaseDir: join(dir, 'worktrees') },
          nodes: [{ id: sourceNode.id, daemonId: 'daemon-local', workspace: sourceNode.workspace, repoRoot: sourceNode.repoRoot, policy: {} }],
        },
      }) as any

      expect(clone.code).not.toBe('clone_requires_reason_after_idle_reminder')
      expect(clone.success).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
