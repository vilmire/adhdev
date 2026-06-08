import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'
import { drainPendingMeshCoordinatorEvents, queuePendingMeshCoordinatorEvent } from '../../src/mesh/mesh-events'
import { appendLedgerEntry } from '../../src/mesh/mesh-ledger'

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
  const { getMeshPeerConnectionStatus, dispatchMeshCommand, statusInstanceId, ...sessionHostOverrides } = overrides as Record<string, unknown>
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
    dispatchMeshCommand: typeof dispatchMeshCommand === 'function'
      ? dispatchMeshCommand as (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>
      : undefined,
    getMeshPeerConnectionStatus: typeof getMeshPeerConnectionStatus === 'function'
      ? getMeshPeerConnectionStatus as (daemonId: string) => Record<string, unknown> | null
      : undefined,
    statusInstanceId: typeof statusInstanceId === 'string' ? statusInstanceId : undefined,
  })

  return { router, sessionHostControl }
}

describe('mesh_status', () => {
  it('persists standalone manual Mesh Host pairing config without storing the raw token', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-host-pairing-config-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({ name: 'Standalone Mesh', repoIdentity: 'github.com/acme/repo' })
      const { router } = createRouter()

      const configured = await router.execute('configure_mesh_host_pairing', {
        meshId: mesh.id,
        hostAddress: ' http://127.0.0.1:3847 ',
        token: 'join-token-secret',
      }) as any

      expect(configured).toEqual(expect.objectContaining({
        success: true,
        meshId: mesh.id,
        hostAddress: 'http://127.0.0.1:3847',
        code: 'mesh_host_pairing_pending',
      }))
      expect(configured.meshHost).toEqual(expect.objectContaining({
        role: 'member',
        hostAddress: 'http://127.0.0.1:3847',
        pairing: expect.objectContaining({
          status: 'pairing',
          tokenId: expect.stringMatching(/^tok_[a-f0-9]{16}$/),
        }),
      }))

      const rawConfig = await readFile(join(configDir, 'meshes.json'), 'utf8')
      expect(rawConfig).toContain('http://127.0.0.1:3847')
      expect(rawConfig).not.toContain('join-token-secret')

      const fetched = await router.execute('get_mesh_host_pairing', { meshId: mesh.id }) as any
      expect(fetched).toEqual(expect.objectContaining({
        success: true,
        meshId: mesh.id,
        hostAddress: 'http://127.0.0.1:3847',
        code: 'mesh_host_pairing_pending',
      }))
      expect(fetched.meshHost.pairing.tokenId).toBe(configured.meshHost.pairing.tokenId)
      expect(fetched.manualPairing).toEqual(expect.objectContaining({
        status: 'pairing',
        joinImplemented: true,
        protocol: 'standalone_command_direct_v1',
      }))
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })


  it('applies a member join to a host mesh via command dispatch and persists paired status without raw token', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-host-join-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, createMeshHostPairingToken, addNode, configureMeshHostPairing, getMesh } = await import('../../src/config/mesh-config.js')
      const hostMesh = createMesh({ name: 'Host Mesh', repoIdentity: 'github.com/acme/repo' })
      const memberMesh = createMesh({ name: 'Member Mesh', repoIdentity: 'github.com/acme/repo-member' })
      const hostToken = createMeshHostPairingToken(hostMesh.id, { token: 'join-token-secret' })
      expect(hostToken?.tokenId).toMatch(/^tok_[a-f0-9]{16}$/)
      addNode(memberMesh.id, { workspace: '/tmp/member-workspace', daemonId: 'daemon-member', role: 'member', policy: { providerPriority: ['hermes-cli'] } })
      configureMeshHostPairing(memberMesh.id, { hostAddress: 'http://127.0.0.1:3847', token: 'join-token-secret' })

      let routerRef: any
      const created = createRouter({
        dispatchMeshCommand: vi.fn(async (_daemonId: string, command: string, payload: Record<string, unknown>) => routerRef.execute(command, payload)),
      })
      routerRef = created.router
      const { router } = created

      const joined = await router.execute('join_mesh_host_pairing', {
        meshId: memberMesh.id,
        hostMeshId: hostMesh.id,
        hostDaemonId: 'daemon-host',
        token: 'join-token-secret',
      }) as any

      expect(joined.success).toBe(true)
      expect(joined.code).toBe('mesh_host_join_applied')
      expect(joined.transport).toBe('mesh_command_dispatch')
      expect(joined.meshHost).toEqual(expect.objectContaining({
        role: 'member',
        pairing: expect.objectContaining({ status: 'paired', tokenId: hostToken?.tokenId }),
      }))
      const persistedMember = getMesh(memberMesh.id)
      expect(persistedMember?.meshHost?.pairing?.status).toBe('paired')
      const persistedHost = getMesh(hostMesh.id)
      expect(persistedHost?.meshHost?.role).toBe('host')
      expect(persistedHost?.nodes).toHaveLength(1)
      expect(persistedHost?.nodes[0]).toEqual(expect.objectContaining({
        workspace: '/tmp/member-workspace',
        daemonId: 'daemon-member',
        role: 'member',
      }))
      const rawConfig = await readFile(join(configDir, 'meshes.json'), 'utf8')
      expect(rawConfig).not.toContain('join-token-secret')

      const reloadedRouter = createRouter().router
      const fetched = await reloadedRouter.execute('get_mesh_host_pairing', { meshId: memberMesh.id }) as any
      expect(fetched.meshHost.pairing.status).toBe('paired')
      const status = await reloadedRouter.execute('mesh_status', { meshId: memberMesh.id }) as any
      expect(status.success).toBe(true)
      expect(status.meshHost).toEqual(expect.objectContaining({
        role: 'member',
        pairing: expect.objectContaining({ status: 'paired' }),
      }))
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid join tokens and keeps member daemons from mutating the host-owned queue', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-host-join-invalid-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, createMeshHostPairingToken, addNode, configureMeshHostPairing, getMesh } = await import('../../src/config/mesh-config.js')
      const hostMesh = createMesh({ name: 'Host Mesh', repoIdentity: 'github.com/acme/repo' })
      const memberMesh = createMesh({ name: 'Member Mesh', repoIdentity: 'github.com/acme/repo-member' })
      createMeshHostPairingToken(hostMesh.id, { token: 'good-token' })
      addNode(memberMesh.id, { workspace: '/tmp/member-workspace', daemonId: 'daemon-member', role: 'member' })
      configureMeshHostPairing(memberMesh.id, { hostAddress: 'http://127.0.0.1:3847', token: 'bad-token' })

      let routerRef: any
      const created = createRouter({
        dispatchMeshCommand: vi.fn(async (_daemonId: string, command: string, payload: Record<string, unknown>) => routerRef.execute(command, payload)),
      })
      routerRef = created.router
      const { router } = created

      const rejected = await router.execute('join_mesh_host_pairing', {
        meshId: memberMesh.id,
        hostMeshId: hostMesh.id,
        hostDaemonId: 'daemon-host',
        token: 'bad-token',
      }) as any
      expect(rejected.success).toBe(false)
      expect(rejected.code).toBe('mesh_host_join_rejected')
      expect(getMesh(hostMesh.id)?.nodes).toHaveLength(0)

      const guarded = await router.execute('cancel_mesh_queue_task', {
        meshId: memberMesh.id,
        taskId: 'task_missing',
      }) as any
      expect(guarded.success).toBe(false)
      expect(guarded.code).toBe('mesh_host_required')
      expect(guarded.meshHost).toEqual(expect.objectContaining({ role: 'member', canOwnQueue: false }))
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('surfaces Mesh Host ownership metadata from inline mesh records', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-host-metadata-')
    try {
      const { router } = createRouter()

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-hosted',
        inlineMesh: {
          id: 'mesh-hosted',
          name: 'Hosted Mesh',
          repoIdentity: 'repo',
          policy: {},
          meshHost: {
            role: 'member',
            hostDaemonId: 'daemon-host',
            hostAddress: 'http://127.0.0.1:3847',
            pairing: { status: 'paired', tokenId: 'tok_redacted' },
          },
          nodes: [
            {
              id: 'node-member',
              daemonId: 'daemon-member',
              machineLabel: 'Member',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              role: 'member',
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.meshHost).toEqual(expect.objectContaining({
        role: 'member',
        hostDaemonId: 'daemon-host',
        hostAddress: 'http://127.0.0.1:3847',
        canOwnCoordinator: false,
        canOwnQueue: false,
      }))
      expect(result.nodes[0]).toEqual(expect.objectContaining({
        nodeId: 'node-member',
        role: 'member',
      }))
      expect(result.sourceOfTruth.meshHost).toEqual(expect.objectContaining({
        owner: 'mesh_host_daemon',
        localRole: 'member',
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces machine identity locality evidence in mesh_status nodes', async () => {
    const { router } = createRouter({ statusInstanceId: 'daemon-local' })

    const result = await router.execute('mesh_status', {
      meshId: 'mesh-machine-identity-status',
      inlineMesh: {
        id: 'mesh-machine-identity-status',
        name: 'Machine Identity Status',
        repoIdentity: 'repo',
        policy: {},
        coordinator: { preferredNodeId: 'node-local' },
        nodes: [
          {
            id: 'node-local',
            daemonId: 'daemon-local',
            machineId: 'machine-local',
            machineName: 'Local Developer Mac',
            workspace: '/missing/local',
            providers: ['hermes-cli'],
            policy: { providerPriority: ['hermes-cli'] },
          },
          {
            id: 'node-remote',
            daemonId: 'daemon-remote',
            machineName: 'Remote Build Box',
            workspace: '/missing/remote',
            providers: ['claude-cli'],
            policy: { providerPriority: ['claude-cli'] },
          },
          {
            id: 'node-unknown',
            workspace: '/missing/unknown',
            providers: ['codex-cli'],
            policy: { providerPriority: ['codex-cli'] },
          },
        ],
      },
    }) as any

    expect(result.success).toBe(true)
    const local = result.nodes.find((node: any) => node.nodeId === 'node-local')
    const remote = result.nodes.find((node: any) => node.nodeId === 'node-remote')
    const unknown = result.nodes.find((node: any) => node.nodeId === 'node-unknown')

    expect(local.machine).toEqual(expect.objectContaining({
      daemonId: 'daemon-local',
      machineId: 'machine-local',
      machineName: 'Local Developer Mac',
      sameMachine: true,
      locality: 'same_machine',
      localityReason: 'matched coordinator daemon id',
    }))
    expect(remote.machine).toEqual(expect.objectContaining({
      daemonId: 'daemon-remote',
      machineName: 'Remote Build Box',
      sameMachine: false,
      locality: 'remote_known',
    }))
    expect(remote.machine.localityReason).toContain('known remote/other machine identity')
    expect(remote.machine.identityEvidence).toContain('machineName:Remote Build Box')
    expect(unknown.machine).toEqual(expect.objectContaining({
      sameMachine: false,
      locality: 'remote_or_unknown',
      localityReason: 'no useful machine identity evidence available',
    }))
  })

  it('treats sparse configured coordinator node as same-machine in mesh_status', async () => {
    const { router } = createRouter({ statusInstanceId: 'daemon-local' })

    const result = await router.execute('mesh_status', {
      meshId: 'mesh-sparse-local-coordinator',
      inlineMesh: {
        id: 'mesh-sparse-local-coordinator',
        name: 'Sparse Local Coordinator',
        repoIdentity: 'repo',
        policy: {},
        coordinator: {},
        nodes: [
          {
            id: 'node-local',
            workspace: '/missing/local',
            providers: ['codex-cli'],
            policy: { providerPriority: ['codex-cli'] },
          },
          {
            id: 'node-unknown',
            workspace: '/missing/unknown',
            providers: ['codex-cli'],
            policy: { providerPriority: ['codex-cli'] },
          },
        ],
      },
    }) as any

    expect(result.success).toBe(true)
    const local = result.nodes.find((node: any) => node.nodeId === 'node-local')
    const unknown = result.nodes.find((node: any) => node.nodeId === 'node-unknown')
    expect(local.machine).toEqual(expect.objectContaining({
      sameMachine: true,
      locality: 'same_machine',
      localityReason: 'selected coordinator node',
    }))
    expect(unknown.machine).toEqual(expect.objectContaining({
      sameMachine: false,
      locality: 'remote_or_unknown',
    }))
  })

  it('blocks coordinator launch from explicit member daemons', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-coordinator-member-block-')
    try {
      const { router } = createRouter()

      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh-member',
        cliType: 'hermes-cli',
        inlineMesh: {
          id: 'mesh-member',
          name: 'Member Mesh',
          repoIdentity: 'repo',
          policy: {},
          meshHost: { role: 'member', hostDaemonId: 'daemon-host' },
          nodes: [
            {
              id: 'node-member',
              daemonId: 'daemon-member',
              machineLabel: 'Member',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(false)
      expect(result.code).toBe('mesh_host_required')
      expect(result.meshHost).toEqual(expect.objectContaining({
        role: 'member',
        hostDaemonId: 'daemon-host',
        canOwnCoordinator: false,
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

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
        health: 'unknown',
        gitProbePending: true,
        launchReady: true,
        providerPriority: ['codex-cli'],
        machineStatus: 'online',
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

  it('surfaces preview freshness from the local deploy record', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-preview-freshness-')
    try {
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
      await mkdir(join(repoRoot, '.adhdev'))
      await writeFile(join(repoRoot, '.adhdev', 'preview-deploy.json'), JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-05-29T00:00:00.000Z',
        lastPreviewCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        target: 'all',
      }))
      const { router } = createRouter()

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-preview',
        refresh: true,
        inlineMesh: {
          id: 'mesh-preview',
          name: 'Preview Mesh',
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
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.previewFreshness).toEqual(expect.objectContaining({
        status: 'stale',
        lastPreviewCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        currentMainCommit: head,
        currentMainCommitSource: 'HEAD',
        recordPath: '.adhdev/preview-deploy.json',
        lastTarget: 'all',
      }))
      expect(result.deployFreshness).toEqual(result.previewFreshness)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores unrelated live sessions that only share a workspace with the mesh node', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-unrelated-workspace-')
    try {
      const { router } = createRouter({
        listSessions: vi.fn(async () => [
          {
            sessionId: 'sess-mesh',
            workspace: repoRoot,
            lifecycle: 'running',
            providerType: 'hermes-cli',
            createdAt: Date.parse('2026-06-08T00:00:00.000Z'),
            startedAt: Date.parse('2026-06-08T00:00:05.000Z'),
            lastActivityAt: Date.parse('2026-06-08T00:01:00.000Z'),
            meta: { meshNodeId: 'node-local', meshNodeFor: 'mesh-1', chatStatus: 'generating', role: 'worker' },
          },
          {
            sessionId: 'sess-unrelated',
            workspace: repoRoot,
            lifecycle: 'running',
            providerType: 'codex-cli',
            meta: {},
          },
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
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes[0]).toEqual(expect.objectContaining({
        nodeId: 'node-local',
        activeSessions: ['sess-mesh'],
      }))
      expect(result.nodes[0].activeSessionDetails).toEqual([
        expect.objectContaining({
          sessionId: 'sess-mesh',
          providerType: 'hermes-cli',
          chatStatus: 'generating',
          role: 'worker',
          createdAt: '2026-06-08T00:00:00.000Z',
          startedAt: '2026-06-08T00:00:05.000Z',
          lastActivityAt: '2026-06-08T00:01:00.000Z',
        }),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('marks sampled self coordinator session status so the graph does not imply live generation precision', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-self-coordinator-session-')
    try {
      const { router } = createRouter({
        listSessions: vi.fn(async () => [
          {
            sessionId: 'sess-coordinator',
            workspace: repoRoot,
            lifecycle: 'running',
            status: 'idle',
            providerType: 'codex-cli',
            meta: { meshCoordinatorFor: 'mesh-self' },
          },
        ]),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-self',
        inlineMesh: {
          id: 'mesh-self',
          name: 'Self Mesh',
          repoIdentity: 'repo',
          policy: {},
          coordinator: { preferredNodeId: 'node-main' },
          nodes: [
            {
              id: 'node-main',
              daemonId: 'machine-local',
              machineLabel: 'Coordinator',
              workspace: repoRoot,
              providers: ['codex-cli'],
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes[0].activeSessionDetails).toEqual([
        expect.objectContaining({
          sessionId: 'sess-coordinator',
          providerType: 'codex-cli',
          state: 'idle',
          role: 'coordinator',
          isSelfCoordinator: true,
          statusNote: expect.stringContaining('sampled from the session host'),
        }),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not attach a live session to an unrelated or nonexistent worktree node by stale node id', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-stale-node-session-')
    const missingWorktree = join(dir, 'missing-worktree')
    try {
      const { router } = createRouter({
        listSessions: vi.fn(async () => [
          {
            sessionId: 'sess-root-runtime',
            workspace: repoRoot,
            lifecycle: 'running',
            providerType: 'codex-cli',
            meta: { meshNodeId: 'node-missing', meshNodeFor: 'mesh-1' },
          },
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
              id: 'node-root',
              daemonId: 'machine-local',
              machineLabel: 'Root',
              workspace: repoRoot,
              providers: ['codex-cli'],
              policy: { providerPriority: ['codex-cli'] },
            },
            {
              id: 'node-missing',
              daemonId: 'machine-local',
              machineLabel: 'Missing worktree',
              workspace: missingWorktree,
              isLocalWorktree: true,
              providers: ['codex-cli'],
              policy: { providerPriority: ['codex-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      const rootNode = result.nodes.find((node: any) => node.nodeId === 'node-root')
      const missingNode = result.nodes.find((node: any) => node.nodeId === 'node-missing')
      expect(rootNode.activeSessions).toEqual([])
      expect(missingNode.activeSessions).toEqual([])
      expect(result.historicalSessions).toEqual(expect.objectContaining({
        count: 1,
        sessions: [
          expect.objectContaining({
            sessionId: 'sess-root-runtime',
            historical: true,
            meshNodeId: 'node-missing',
          }),
        ],
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
      const remoteNode = result.nodes.find((node: any) => node.nodeId === 'node-remote')
      expect(remoteNode).toEqual(expect.objectContaining({
        health: 'unknown',
        gitProbePending: true,
        launchReady: true,
        lastSeenAt: '2026-05-17T06:00:30.000Z',
        updatedAt: '2026-05-17T06:00:30.000Z',
        machineStatus: 'online',
      }))
      expect(remoteNode?.connection).toEqual(expect.objectContaining({
        source: 'mesh_peer_status',
        state: 'connected',
        transport: 'relay',
        reported: true,
        reason: 'Connected over TURN relay.',
        lastConnectedAt: '2026-05-17T06:00:00.000Z',
        lastCommandAt: '2026-05-17T06:00:30.000Z',
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('retries remote git probe after peer telemetry flips to connected and surfaces live remote git truth', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-retry-')
    try {
      const dispatchMeshCommand = vi.fn(async () => {
        if (dispatchMeshCommand.mock.calls.length === 1) {
          throw new Error('timeout')
        }
        return {
          status: {
            workspace: '/missing/remote',
            repoRoot: '/missing/remote',
            isGitRepo: true,
            branch: 'main',
            head: '710e11de',
            upstream: 'origin/main',
            ahead: 0,
            behind: 5,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            conflictFiles: [],
            stashCount: 0,
            branchConvergence: {
              status: 'blocked_review',
              reason: 'default_branch_not_even_with_upstream',
            },
            lastCheckedAt: Date.parse('2026-05-20T07:02:58.779Z'),
            submodules: [
              {
                path: 'oss',
                commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a',
                repoPath: '/missing/remote/oss',
                dirty: false,
                outOfSync: false,
                lastCheckedAt: Date.parse('2026-05-20T07:02:58.779Z'),
              },
            ],
          },
        }
      })
      const getMeshPeerConnectionStatus = vi.fn((daemonId: string) => daemonId === 'machine-remote'
        ? {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: getMeshPeerConnectionStatus.mock.calls.length >= 2 ? 'connected' : 'connecting',
            transport: 'direct',
            reported: true,
            reason: getMeshPeerConnectionStatus.mock.calls.length >= 2
              ? 'Connected directly peer-to-peer.'
              : 'Waiting for mesh DataChannel to open.',
            lastStateChangeAt: '2026-05-20T07:00:06.000Z',
            lastConnectedAt: '2026-05-20T07:00:06.000Z',
            lastCommandAt: '2026-05-20T07:00:23.000Z',
          }
        : null)

      const { router } = createRouter({
        dispatchMeshCommand,
        getMeshPeerConnectionStatus,
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-retry',
        inlineMesh: {
          id: 'mesh-retry',
          name: 'Mesh Retry',
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
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
              cachedStatus: {
                machineStatus: 'online',
                lastSeenAt: '2026-05-20T06:59:00.000Z',
                updatedAt: '2026-05-20T06:59:00.000Z',
              },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(2)
      expect(getMeshPeerConnectionStatus).toHaveBeenCalledTimes(2)
      const remoteNode = result.nodes.find((node: any) => node.nodeId === 'node-remote')
      expect(remoteNode?.gitProbePending).toBeUndefined()
      expect(remoteNode).toEqual(expect.objectContaining({
        health: 'online',
        launchReady: true,
        machineStatus: 'online',
        providers: ['hermes-cli'],
        lastSeenAt: '2026-05-20T07:00:23.000Z',
        updatedAt: '2026-05-20T07:02:58.779Z',
      }))
      expect(remoteNode?.connection).toEqual(expect.objectContaining({
        source: 'mesh_peer_status',
        state: 'connected',
        transport: 'direct',
        reported: true,
        reason: 'Connected directly peer-to-peer.',
        lastConnectedAt: '2026-05-20T07:00:06.000Z',
        lastCommandAt: '2026-05-20T07:00:23.000Z',
      }))
      expect(remoteNode?.git).toEqual(expect.objectContaining({
        workspace: '/missing/remote',
        repoRoot: '/missing/remote',
        isGitRepo: true,
        branch: 'main',
        head: '710e11de',
        upstream: 'origin/main',
        ahead: 0,
        behind: 5,
        branchConvergence: expect.objectContaining({
          status: 'blocked_review',
          reason: 'default_branch_not_even_with_upstream',
        }),
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns cached coordinator-owned aggregate mesh_status without refreshing peer git on default requests', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-cache-')
    try {
      const remoteWorkspace = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
      const dispatchMeshCommand = vi.fn(async (_daemonId: string, command: string) => {
        expect(command).toBe('git_status')
        return {
          success: true,
          status: {
            isGitRepo: true,
            workspace: remoteWorkspace,
            repoRoot: remoteWorkspace,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            headCommit: 'cb6fda78',
            ahead: 2,
            behind: 14,
            staged: 0,
            modified: 1,
            untracked: 1,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            stashCount: 2,
            lastCheckedAt: Date.parse('2026-05-21T14:10:00.000Z'),
            submodules: [
              { path: 'adhdev-providers', repoPath: `${remoteWorkspace}/adhdev-providers`, commit: 'provider-sha', dirty: false, outOfSync: false },
              { path: 'oss', repoPath: `${remoteWorkspace}/oss`, commit: 'oss-sha', dirty: false, outOfSync: false },
            ],
          },
        }
      })
      const { router, sessionHostControl } = createRouter({ dispatchMeshCommand })
      const inlineMesh = {
        id: 'mesh_303_cache',
        name: 'ADHDev',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_7' },
        policy: {},
        nodes: [
          { id: 'node_7', daemonId: 'daemon_7', machineLabel: 'Local', workspace: repoRoot, repoRoot, providers: ['hermes-cli'], policy: { providerPriority: ['hermes-cli'] } },
          {
            id: 'node_303a1ded96a859540d7bf608448d1fcc',
            daemonId: 'daemon_303',
            machineLabel: 'node_303',
            workspace: remoteWorkspace,
            repoRoot: remoteWorkspace,
            providers: [],
            policy: { providerPriority: ['hermes-cli'] },
            cachedStatus: {
              health: 'unknown',
              gitProbePending: true,
              error: 'waiting for live peer git snapshot',
              git: { isGitRepo: false, branch: null, upstream: null, headCommit: null },
            },
          },
        ],
      }

      const refreshed = await router.execute('mesh_status', {
        meshId: 'mesh_303_cache',
        inlineMesh,
        requireDirectPeerTruth: true,
        refresh: true,
      }) as any

      expect(refreshed.success).toBe(true)
      expect(refreshed.sourceOfTruth.aggregateSnapshot).toMatchObject({
        owner: 'coordinator_daemon_memory',
        cached: false,
        refreshReason: 'explicit_refresh',
      })
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
      expect(sessionHostControl.listSessions).toHaveBeenCalledTimes(1)

      dispatchMeshCommand.mockClear()
      sessionHostControl.listSessions.mockClear()

      const cached = await router.execute('mesh_status', {
        meshId: 'mesh_303_cache',
        inlineMesh,
        requireDirectPeerTruth: true,
        refresh: false,
      }) as any

      expect(cached.success).toBe(true)
      expect(cached.sourceOfTruth.aggregateSnapshot).toMatchObject({
        owner: 'coordinator_daemon_memory',
        cached: true,
        refreshReason: 'memory_cache_hit',
      })
      expect(cached.sourceOfTruth.aggregateSnapshot.ageMs).toEqual(expect.any(Number))
      expect(cached.nodes.find((node: any) => node.nodeId === 'node_303a1ded96a859540d7bf608448d1fcc')).toMatchObject({
        git: expect.objectContaining({ branch: 'main', upstream: 'origin/main', headCommit: 'cb6fda78' }),
      })
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
      expect(sessionHostControl.listSessions).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not reuse cached mesh_status after queue storage changes outside the router', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-queue-cache-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-queue-revision-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const { enqueueTask, __resetBeadsDBForTests } = await import('../../src/mesh/mesh-work-queue.js')
      __resetBeadsDBForTests()

      const mesh = createMesh({
        name: 'Queue Cache Mesh',
        repoIdentity: 'github.com/acme/queue-cache',
        defaultBranch: 'master',
      })
      addNode(mesh.id, { workspace: repoRoot, repoRoot })

      const { router, sessionHostControl } = createRouter()
      const initial = await router.execute('mesh_status', { meshId: mesh.id, refresh: true }) as any
      expect(initial.success).toBe(true)
      expect(initial.queue.summary.total).toBe(0)
      expect(initial.sourceOfTruth.aggregateSnapshot.cached).toBe(false)

      sessionHostControl.listSessions.mockClear()
      enqueueTask(mesh.id, 'queue task created by another mesh process')

      const afterQueueChange = await router.execute('mesh_status', { meshId: mesh.id }) as any

      expect(afterQueueChange.success).toBe(true)
      expect(afterQueueChange.queue.summary.total).toBe(1)
      expect(afterQueueChange.queue.tasks).toHaveLength(1)
      expect(afterQueueChange.queue.tasks[0]).toEqual(expect.objectContaining({
        message: 'queue task created by another mesh process',
        status: 'pending',
      }))
      expect(afterQueueChange.sourceOfTruth.aggregateSnapshot).toMatchObject({
        cached: false,
        refreshReason: 'stale_pending_cache_refresh',
      })
      expect(sessionHostControl.listSessions).toHaveBeenCalledTimes(1)
    } finally {
      const { __resetBeadsDBForTests } = await import('../../src/mesh/mesh-work-queue.js')
      __resetBeadsDBForTests()
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces and drains pending coordinator events through mesh_status instead of requiring chat polling', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-pending-events-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-pending-events-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({
        name: 'Pending Event Mesh',
        repoIdentity: 'github.com/acme/pending-events',
        defaultBranch: 'master',
      })
      addNode(mesh.id, { workspace: repoRoot, repoRoot })
      const { router, sessionHostControl } = createRouter()

      const initial = await router.execute('mesh_status', { meshId: mesh.id, refresh: true }) as any
      expect(initial.success).toBe(true)
      expect(initial.pendingCoordinatorEvents).toBeUndefined()

      queuePendingMeshCoordinatorEvent({
        event: 'refine:completed',
        meshId: mesh.id,
        nodeLabel: 'node-pending',
        nodeId: 'node-pending',
        workspace: repoRoot,
        metadataEvent: {
          source: 'refine_mesh_node_async_job',
          jobId: 'refine_status_visible',
          status: 'completed',
          result: { success: true, merged: true },
        },
        queuedAt: Date.now(),
      })
      appendLedgerEntry(mesh.id, {
        kind: 'task_dispatched',
        nodeId: 'node-pending',
        payload: {
          source: 'refine_mesh_node_async_job',
          refineJob: {
            jobId: 'refine_status_visible',
            interactionId: 'ix-status-visible',
            status: 'accepted',
            meshId: mesh.id,
            nodeId: 'node-pending',
            workspace: repoRoot,
            startedAt: '2026-05-29T00:00:00.000Z',
          },
          async: true,
        },
      })

      sessionHostControl.listSessions.mockClear()
      const withEvent = await router.execute('mesh_status', { meshId: mesh.id }) as any
      expect(withEvent.success).toBe(true)
      expect(withEvent.sourceOfTruth.aggregateSnapshot.refreshReason).toBe('pending_coordinator_events')
      expect(withEvent.pendingCoordinatorEvents).toEqual([
        expect.objectContaining({
          event: 'refine:completed',
          meshId: mesh.id,
          nodeId: 'node-pending',
        }),
      ])
      expect(withEvent.asyncRefineJobs).toEqual([
        expect.objectContaining({
          jobId: 'refine_status_visible',
          interactionId: 'ix-status-visible',
          status: 'completed',
          targetNodeId: 'node-pending',
          workspace: repoRoot,
          instruction: expect.stringContaining('completed'),
        }),
      ])
      expect(sessionHostControl.listSessions).toHaveBeenCalledTimes(1)
      expect(drainPendingMeshCoordinatorEvents(mesh.id)).toEqual([])

      const cachedAfterDrain = await router.execute('mesh_status', { meshId: mesh.id }) as any
      expect(cachedAfterDrain.success).toBe(true)
      expect(cachedAfterDrain.pendingCoordinatorEvents).toBeUndefined()
      expect(cachedAfterDrain.asyncRefineJobs).toEqual(withEvent.asyncRefineJobs)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('separates live session-host records for removed mesh nodes from normal node active sessions', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-removed-sessions-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-removed-sessions-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({
        name: 'Removed Session Mesh',
        repoIdentity: 'github.com/acme/removed-session',
        defaultBranch: 'master',
      })
      addNode(mesh.id, { workspace: repoRoot, repoRoot })
      const { router } = createRouter({
        listSessions: vi.fn(async () => [
          {
            sessionId: 'sess-removed-node',
            providerType: 'hermes-cli',
            lifecycle: 'running',
            workspace: join(dir, 'removed-worktree'),
            updatedAt: Date.now(),
            meta: {
              meshNodeFor: mesh.id,
              meshNodeId: 'node-removed-worktree',
            },
          },
        ]),
      })

      const result = await router.execute('mesh_status', { meshId: mesh.id, refresh: true }) as any
      expect(result.success).toBe(true)
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0].activeSessions).toEqual([])
      expect(result.historicalSessions).toMatchObject({
        count: 1,
        sessions: [
          {
            sessionId: 'sess-removed-node',
            classification: 'removedNode',
            historical: true,
            meshNodeId: 'node-removed-worktree',
          },
        ],
      })
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refreshes instead of returning a stale pending cache hit when direct peer truth is required', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-stale-cache-refresh-')
    try {
      const remoteWorkspace = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
      let allowRemoteGit = false
      const dispatchMeshCommand = vi.fn(async (_daemonId: string, command: string) => {
        expect(command).toBe('git_status')
        if (!allowRemoteGit) return { success: false, error: 'not ready' }
        return {
          success: true,
          status: {
            isGitRepo: true,
            workspace: remoteWorkspace,
            repoRoot: remoteWorkspace,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            headCommit: 'live-after-stale-cache',
            ahead: 0,
            behind: 10,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
          },
        }
      })
      const { router, sessionHostControl } = createRouter({ dispatchMeshCommand })
      const inlineMesh = {
        id: 'mesh_stale_pending_cache',
        name: 'ADHDev',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_7' },
        nodes: [
          { id: 'node_7', daemonId: 'daemon_7', machineLabel: 'Local', workspace: repoRoot, repoRoot, providers: ['hermes-cli'], policy: { providerPriority: ['hermes-cli'] } },
          {
            id: 'node_303',
            daemonId: 'daemon_303',
            machineLabel: 'node_303',
            workspace: remoteWorkspace,
            repoRoot: remoteWorkspace,
            providers: [],
            policy: { providerPriority: ['hermes-cli'] },
            cachedStatus: {
              health: 'unknown',
              gitProbePending: true,
              error: 'waiting for live peer git snapshot',
            },
          },
        ],
      }

      const stale = await router.execute('mesh_status', {
        meshId: 'mesh_stale_pending_cache',
        inlineMesh,
        refresh: true,
      }) as any
      expect(stale.success).toBe(true)
      const staleNode303 = stale.nodes.find((node: any) => node.nodeId === 'node_303')
      expect(staleNode303).toMatchObject({ gitProbePending: true })
      expect(staleNode303.git ?? null).toBeNull()

      allowRemoteGit = true
      dispatchMeshCommand.mockClear()
      sessionHostControl.listSessions.mockClear()
      const refreshed = await router.execute('mesh_status', {
        meshId: 'mesh_stale_pending_cache',
        inlineMesh,
        requireDirectPeerTruth: true,
        refresh: false,
      }) as any

      expect(refreshed.success).toBe(true)
      expect(refreshed.sourceOfTruth.aggregateSnapshot).toMatchObject({
        cached: false,
        refreshReason: 'stale_pending_cache_refresh',
      })
      expect(dispatchMeshCommand).toHaveBeenCalled()
      expect(sessionHostControl.listSessions).toHaveBeenCalledTimes(1)
      const node303 = refreshed.nodes.find((node: any) => node.nodeId === 'node_303')
      expect(node303).toMatchObject({
        health: 'online',
        launchReady: true,
        connection: expect.objectContaining({ state: 'connected', transport: 'direct', reported: true }),
        git: expect.objectContaining({ branch: 'main', upstream: 'origin/main', headCommit: 'live-after-stale-cache' }),
      })
      expect(node303).not.toHaveProperty('gitProbePending')
      expect(node303).not.toHaveProperty('error')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('hydrates a cached pending aggregate from later inline live git truth before returning cache hits', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-cache-hydrate-')
    try {
      const remoteWorkspace = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
      const { router, sessionHostControl } = createRouter()
      const pendingInlineMesh = {
        id: 'mesh_cache_hydrate',
        name: 'ADHDev',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_7' },
        policy: {},
        nodes: [
          { id: 'node_7', daemonId: 'daemon_7', machineLabel: 'Local', workspace: repoRoot, repoRoot, providers: ['hermes-cli'], policy: { providerPriority: ['hermes-cli'] } },
          {
            id: 'node_303',
            daemonId: 'daemon_303',
            machineLabel: 'node_303',
            workspace: remoteWorkspace,
            repoRoot: remoteWorkspace,
            policy: { providerPriority: ['hermes-cli'] },
            cachedStatus: {
              health: 'unknown',
              gitProbePending: true,
              error: 'waiting for live peer git snapshot',
              git: { isGitRepo: false, branch: null, upstream: null, headCommit: null },
            },
          },
        ],
      }

      const stale = await router.execute('mesh_status', {
        meshId: 'mesh_cache_hydrate',
        inlineMesh: pendingInlineMesh,
        refresh: true,
      }) as any
      expect(stale.success).toBe(true)
      expect(stale.nodes.find((node: any) => node.nodeId === 'node_303')).toMatchObject({
        gitProbePending: true,
        health: 'unknown',
      })

      sessionHostControl.listSessions.mockClear()
      const liveInlineMesh = {
        ...pendingInlineMesh,
        nodes: [
          pendingInlineMesh.nodes[0],
          {
            ...pendingInlineMesh.nodes[1],
            lastGit: {
              status: { isGitRepo: false, branch: null, upstream: null, headCommit: null, error: 'pending_git' },
              result: {
                status: {
                  isGitRepo: true,
                  workspace: remoteWorkspace,
                  repoRoot: remoteWorkspace,
                  branch: 'main',
                  upstream: 'origin/main',
                  upstreamStatus: 'fresh',
                  headCommit: 'live303',
                  ahead: 0,
                  behind: 0,
                  staged: 0,
                  modified: 0,
                  untracked: 0,
                  deleted: 0,
                  renamed: 0,
                  hasConflicts: false,
                },
              },
            },
          },
        ],
      }

      const cached = await router.execute('mesh_status', {
        meshId: 'mesh_cache_hydrate',
        inlineMesh: liveInlineMesh,
        refresh: false,
      }) as any
      const node303 = cached.nodes.find((node: any) => node.nodeId === 'node_303')
      expect(cached.sourceOfTruth.aggregateSnapshot).toMatchObject({ cached: true, refreshReason: 'memory_cache_hit' })
      expect(node303).toMatchObject({
        health: 'online',
        git: expect.objectContaining({ branch: 'main', upstream: 'origin/main', headCommit: 'live303' }),
      })
      expect(node303).not.toHaveProperty('gitProbePending')
      expect(node303).not.toHaveProperty('error')
      expect(sessionHostControl.listSessions).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops cached inline nodes that are absent from a newer live inline snapshot before direct truth gating', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-prune-inline-cache-')
    try {
      const { router } = createRouter()

      await router.execute('mesh_status', {
        meshId: 'mesh_prune_inline_cache',
        refresh: true,
        inlineMesh: {
          id: 'mesh_prune_inline_cache',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_7' },
          policy: {},
          nodes: [
            { id: 'node_7', daemonId: 'daemon_7', machineLabel: 'Local', workspace: repoRoot, repoRoot, policy: { providerPriority: ['hermes-cli'] } },
            { id: 'node_removed', daemonId: 'daemon_removed', machineLabel: 'Removed', workspace: '/missing/removed/worktree', repoRoot: '/missing/removed/worktree', policy: { providerPriority: ['hermes-cli'] } },
          ],
        },
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_prune_inline_cache',
        requireDirectPeerTruth: true,
        refresh: true,
        inlineMesh: {
          id: 'mesh_prune_inline_cache',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_7' },
          policy: {},
          nodes: [
            { id: 'node_7', daemonId: 'daemon_7', machineLabel: 'Local', workspace: repoRoot, repoRoot, policy: { providerPriority: ['hermes-cli'] }, lastSeenAt: new Date().toISOString() },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes.map((node: any) => node.nodeId)).toEqual(['node_7'])
      expect(result.sourceOfTruth.directPeerTruth).toMatchObject({
        required: true,
        satisfied: true,
        localConfirmedCount: 1,
        peerAttemptedCount: 0,
        unavailableNodeIds: [],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts selected-coordinator local filesystem git as direct truth for non-self local worktree nodes', async () => {
    const primary = await createTempGitRepo('mesh-status-local-direct-primary-')
    const sibling = await createTempGitRepo('mesh-status-local-direct-sibling-')
    try {
      const dispatchMeshCommand = vi.fn(async () => {
        throw new Error('local workspace should not need P2P dispatch')
      })
      const { router } = createRouter({ dispatchMeshCommand })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_local_worktree_direct_truth',
        requireDirectPeerTruth: true,
        refresh: true,
        inlineMesh: {
          id: 'mesh_local_worktree_direct_truth',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_primary' },
          policy: {},
          nodes: [
            { id: 'node_primary', daemonId: 'daemon_primary', machineLabel: 'Primary', workspace: primary.repoRoot, repoRoot: primary.repoRoot, policy: { providerPriority: ['hermes-cli'] } },
            { id: 'node_local_worktree', daemonId: 'daemon_local_worktree', machineLabel: 'Local worktree', workspace: sibling.repoRoot, repoRoot: sibling.repoRoot, policy: { providerPriority: ['hermes-cli'] } },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.code).not.toBe('mesh_direct_peer_truth_unavailable')
      expect(result.sourceOfTruth.directPeerTruth).toMatchObject({
        required: true,
        satisfied: true,
        localConfirmedCount: 2,
        peerAttemptedCount: 0,
        peerConfirmedCount: 0,
        unavailableNodeIds: [],
      })
      const localWorktree = result.nodes.find((node: any) => node.nodeId === 'node_local_worktree')
      expect(localWorktree).toMatchObject({
        health: 'online',
        git: expect.objectContaining({ isGitRepo: true, branch: expect.any(String) }),
      })
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
    } finally {
      await rm(primary.dir, { recursive: true, force: true })
      await rm(sibling.dir, { recursive: true, force: true })
    }
  })

  it('does not fail cached/default loads when no remote direct peer probe was attempted', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-no-peer-attempt-')
    try {
      const { router } = createRouter()

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_no_peer_attempt',
        requireDirectPeerTruth: true,
        refresh: false,
        inlineMesh: {
          id: 'mesh_no_peer_attempt',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_7' },
          policy: {},
          nodes: [
            {
              id: 'node_7',
              daemonId: 'daemon_7',
              machineLabel: 'Local',
              workspace: repoRoot,
              repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node_303',
              daemonId: 'daemon_303',
              machineLabel: 'Remote',
              workspace: '/missing/node_303/adhdev',
              repoRoot: '/missing/node_303/adhdev',
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
              cachedStatus: {
                health: 'unknown',
                gitProbePending: true,
                error: 'waiting for live peer git snapshot',
              },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.code).not.toBe('mesh_direct_peer_truth_unavailable')
      expect(String(result.error ?? '')).not.toContain('Selected coordinator could not confirm direct mesh truth yet')
      expect(result.sourceOfTruth).toMatchObject({
        coordinatorOwnsLiveTruth: true,
        currentStatus: 'live_git_and_session_probes',
        directPeerTruth: expect.objectContaining({
          required: true,
          satisfied: true,
          localConfirmedCount: 1,
          peerAttemptedCount: 0,
          peerConfirmedCount: 0,
          unavailableNodeIds: [],
        }),
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when a direct peer remains unavailable even if another peer has live git truth', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-single-aggregate-')
    try {
      const remoteWorkspace = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
      const failedDaemonId = '9f061b89ce435a06666a3e70db28d6230b1b3081b370fbd5766e631ea0a6e78d'
      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string, args: Record<string, unknown>) => {
        expect(command).toBe('git_status')
        if (daemonId === 'daemon_303') {
          expect(args).toMatchObject({ workspace: remoteWorkspace })
          return {
            success: true,
            status: {
              isGitRepo: true,
              workspace: remoteWorkspace,
              repoRoot: remoteWorkspace,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: '083fe011',
              ahead: 0,
              behind: 8,
              staged: 0,
              modified: 1,
              untracked: 1,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              stashCount: 2,
              lastCheckedAt: Date.parse('2026-05-21T13:24:47.000Z'),
              submodules: [
                { path: 'adhdev-providers', repoPath: `${remoteWorkspace}/adhdev-providers`, commit: 'provider-sha', dirty: false, outOfSync: false },
                { path: 'oss', repoPath: `${remoteWorkspace}/oss`, commit: 'oss-sha', dirty: false, outOfSync: false },
              ],
            },
          }
        }
        if (daemonId === failedDaemonId) {
          throw new Error('P2P state changed to failed after remote_desc_duplicate_ignored on mesh_p2p_answer')
        }
        throw new Error(`unexpected daemon ${daemonId}`)
      })
      const getMeshPeerConnectionStatus = vi.fn((daemonId: string) => {
        if (daemonId === 'daemon_303') {
          return {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: 'connected',
            transport: 'direct',
            reported: true,
            reason: 'Connected directly peer-to-peer.',
            lastConnectedAt: '2026-05-21T13:22:47.000Z',
            lastCommandAt: '2026-05-21T13:24:47.000Z',
          }
        }
        if (daemonId === failedDaemonId) {
          return {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: 'failed',
            transport: 'unknown',
            reported: true,
            reason: 'P2P state changed to failed after remote_desc_duplicate_ignored on mesh_p2p_answer',
            lastCommandAt: '2026-05-21T13:21:07.119Z',
          }
        }
        return null
      })
      const { router } = createRouter({ dispatchMeshCommand, getMeshPeerConnectionStatus })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_303',
        requireDirectPeerTruth: true,
        inlineMesh: {
          id: 'mesh_303',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_7' },
          policy: {},
          nodes: [
            {
              id: 'node_7',
              daemonId: 'daemon_7',
              machineLabel: 'Local',
              workspace: repoRoot,
              repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node_303',
              daemonId: 'daemon_303',
              machineLabel: 'Remote',
              workspace: remoteWorkspace,
              repoRoot: remoteWorkspace,
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
              cachedStatus: {
                health: 'unknown',
                gitProbePending: true,
                error: 'waiting for live peer git snapshot',
              },
            },
            {
              id: 'node_9f061_timeout_peer',
              daemonId: failedDaemonId,
              machineLabel: 'Failed peer',
              workspace: '/missing/9f061/Prefex',
              repoRoot: '/missing/9f061/Prefex',
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result).toMatchObject({
        success: false,
        code: 'mesh_direct_peer_truth_unavailable',
        sourceOfTruth: {
          membership: 'inline_bootstrap_snapshot',
          coordinatorOwnsLiveTruth: false,
          currentStatus: 'direct_peer_truth_unavailable',
          directPeerTruth: expect.objectContaining({
            required: true,
            satisfied: false,
            peerAttemptedCount: 2,
            peerConfirmedCount: 1,
            unavailableNodeIds: ['node_9f061_timeout_peer'],
          }),
        },
      })
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps direct mesh truth satisfied when a removed worktree residue cannot be probed', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-missing-worktree-direct-truth-')
    try {
      const dispatchMeshCommand = vi.fn(async () => {
        throw new Error('workspace path no longer exists')
      })
      const { router } = createRouter({ dispatchMeshCommand })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_missing_worktree_direct_truth',
        requireDirectPeerTruth: true,
        refresh: true,
        inlineMesh: {
          id: 'mesh_missing_worktree_direct_truth',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_primary' },
          policy: {},
          nodes: [
            { id: 'node_primary', daemonId: 'daemon_primary', machineLabel: 'Primary', workspace: repoRoot, repoRoot, policy: { providerPriority: ['hermes-cli'] } },
            {
              id: 'node_removed_worktree',
              daemonId: 'daemon_removed',
              machineLabel: 'Removed worktree',
              workspace: '/missing/removed/worktree',
              repoRoot: '/missing/removed/worktree',
              isLocalWorktree: true,
              worktreeBranch: 'fix/already-refined',
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.code).not.toBe('mesh_direct_peer_truth_unavailable')
      expect(result.sourceOfTruth).toMatchObject({
        coordinatorOwnsLiveTruth: true,
        currentStatus: 'live_git_and_session_probes',
        directPeerTruth: expect.objectContaining({
          required: true,
          satisfied: true,
          directEvidenceCount: 1,
          localConfirmedCount: 1,
          peerAttemptedCount: 1,
          peerConfirmedCount: 0,
          unavailableNodeIds: ['node_removed_worktree'],
          partialNodeFailures: ['node_removed_worktree'],
        }),
      })
      const removedWorktree = result.nodes.find((node: any) => node.nodeId === 'node_removed_worktree')
      expect(removedWorktree).toMatchObject({
        nodeId: 'node_removed_worktree',
        workspace: '/missing/removed/worktree',
        isLocalWorktree: true,
        gitProbePending: true,
        health: 'unknown',
      })
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
