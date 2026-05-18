import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRoot, 'oss'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: repoRoot })

  return { dir, repoRoot, submoduleRoot }
}

function createRouter(overrides: Record<string, unknown> = {}) {
  const { getMeshPeerConnectionStatus, ...sessionHostOverrides } = overrides as Record<string, unknown>
  const sessionHostControl = {
    listSessions: vi.fn(async () => []),
    ...sessionHostOverrides,
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
    getMeshPeerConnectionStatus: typeof getMeshPeerConnectionStatus === 'function'
      ? getMeshPeerConnectionStatus as (daemonId: string) => Record<string, unknown> | null
      : undefined,
  })

  return { router, sessionHostControl }
}

describe('mesh_status', () => {
  it('reports live local runtimes and cached remote active sessions', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-')
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'sess-live', workspace: repoRoot, lifecycle: 'running', providerType: 'hermes-cli', meta: { meshNodeId: 'node-local' } },
          { sessionId: 'sess-stopped', workspace: repoRoot, lifecycle: 'stopped', providerType: 'hermes-cli', meta: { meshNodeId: 'node-local' } },
        ]),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-1',
        inlineMesh: {
          id: 'mesh-1',
          name: 'Mesh',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node-remote',
              daemonId: 'machine-remote',
              machineLabel: 'Remote',
              workspace: '/missing/remote',
              providers: ['codex-cli'],
              policy: { providerPriority: ['codex-cli'] },
              cachedStatus: {
                machineStatus: 'online',
                lastSeenAt: '2026-05-17T05:00:00.000Z',
                updatedAt: '2026-05-17T05:01:00.000Z',
                activeSession: { id: 'sess-remote', provider: 'codex-cli', status: 'running' },
                git: {
                  workspace: '/missing/remote',
                  repoRoot: '/missing/remote',
                  isGitRepo: true,
                  branch: 'main',
                  ahead: 0,
                  behind: 0,
                  staged: 0,
                  modified: 0,
                  untracked: 0,
                  deleted: 0,
                  renamed: 0,
                  hasConflicts: false,
                  conflictFiles: [],
                  stashCount: 0,
                  submodules: [
                    {
                      path: 'oss',
                      commit: 'abc1234',
                      repoPath: '/missing/remote/oss',
                      dirty: false,
                      outOfSync: true,
                      lastCheckedAt: 1715882400000,
                    },
                  ],
                },
              },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(sessionHostControl.listSessions).toHaveBeenCalledTimes(1)
      expect(result.nodes.find((node: any) => node.nodeId === 'node-local')).toEqual(expect.objectContaining({
        activeSessions: ['sess-live'],
        health: 'online',
        launchReady: true,
        providerPriority: ['hermes-cli'],
        connection: expect.objectContaining({
          state: 'self',
          transport: 'local',
        }),
      }))
      expect(result.nodes.find((node: any) => node.nodeId === 'node-remote')).toEqual(expect.objectContaining({
        activeSessions: ['sess-remote'],
        health: 'degraded',
        launchReady: true,
        providerPriority: ['codex-cli'],
        lastSeenAt: '2026-05-17T05:00:00.000Z',
        updatedAt: '2026-05-17T05:01:00.000Z',
        connection: expect.objectContaining({
          source: 'not_reported',
          state: 'unknown',
          transport: 'unknown',
          reported: false,
        }),
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces selected-coordinator mesh connection telemetry when reported', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-telemetry-')
    try {
      const { router } = createRouter({
        getMeshPeerConnectionStatus: vi.fn((daemonId: string) => daemonId === 'machine-remote'
          ? {
              perspective: 'selected_coordinator',
              source: 'mesh_peer_status',
              state: 'connected',
              transport: 'relay',
              reported: true,
              reason: 'Connected over TURN relay.',
              lastStateChangeAt: '2026-05-17T06:00:00.000Z',
              lastConnectedAt: '2026-05-17T06:00:00.000Z',
              lastCommandAt: '2026-05-17T06:00:30.000Z',
            }
          : null),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-telemetry',
        inlineMesh: {
          id: 'mesh-telemetry',
          name: 'Mesh Telemetry',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node-remote',
              daemonId: 'machine-remote',
              machineLabel: 'Remote',
              workspace: '/missing/remote',
              providers: ['codex-cli'],
              policy: { providerPriority: ['codex-cli'] },
              cachedStatus: {
                machineStatus: 'online',
                health: 'online',
                git: {
                  workspace: '/missing/remote',
                  repoRoot: '/missing/remote',
                  isGitRepo: true,
                  branch: 'main',
                  ahead: 0,
                  behind: 0,
                  staged: 0,
                  modified: 0,
                  untracked: 0,
                  deleted: 0,
                  renamed: 0,
                  hasConflicts: false,
                  conflictFiles: [],
                  stashCount: 0,
                },
              },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes.find((node: any) => node.nodeId === 'node-remote')).toEqual(expect.objectContaining({
        health: 'online',
        launchReady: true,
        connection: expect.objectContaining({
          source: 'mesh_peer_status',
          state: 'connected',
          transport: 'relay',
          reported: true,
          reason: 'Connected over TURN relay.',
          lastConnectedAt: '2026-05-17T06:00:00.000Z',
          lastCommandAt: '2026-05-17T06:00:30.000Z',
        }),
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats local submodule drift as parent dirty health for local workspaces', async () => {
    const { dir, repoRoot } = await createTempGitRepoWithSubmodule('mesh-status-submodule-')
    try {
      await writeFile(join(repoRoot, 'oss', 'submodule.txt'), 'submodule changed\n')

      const { router } = createRouter()
      const result = await router.execute('mesh_status', {
        meshId: 'mesh-1',
        inlineMesh: {
          id: 'mesh-1',
          name: 'Mesh',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes[0]).toEqual(expect.objectContaining({
        nodeId: 'node-local',
        health: 'dirty',
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prefers the live coordinator runtime workspace over stale node.workspace', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-live-workspace-')
    try {
      const { router } = createRouter({
        listSessions: vi.fn(async () => [
          {
            sessionId: 'coord-live',
            workspace: repoRoot,
            lifecycle: 'running',
            providerType: 'hermes-cli',
            meta: { meshCoordinatorFor: 'mesh-live-workspace' },
          },
        ]),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-live-workspace',
        inlineMesh: {
          id: 'mesh-live-workspace',
          name: 'Mesh Live Workspace',
          repoIdentity: 'repo',
          policy: {},
          coordinator: { preferredNodeId: 'node-local' },
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: '/missing/deleted-worktree',
              repoRoot: '/missing/deleted-worktree',
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes[0]).toEqual(expect.objectContaining({
        nodeId: 'node-local',
        workspace: repoRoot,
        activeSessions: ['coord-live'],
      }))
      expect(result.nodes[0].git).toEqual(expect.objectContaining({
        workspace: repoRoot,
        isGitRepo: true,
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
