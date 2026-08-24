import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
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
      // get_pending_mesh_events → resolveCoordinatorDrainDeliverability →
      // findLiveCoordinators iterates the live CLI instances; no coordinator here.
      getByCategory: () => [],
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

// Safety net: close the process-wide mesh runtime sqlite store after every test so
// a test that throws before its own finally can't leak an open handle (which would
// EBUSY the next test's temp-dir removal on win32) or a stale singleton into the
// next test.
afterEach(resetMeshRuntimeStore)

describe('mesh_status', () => {
  it('surfaces slots-derived providerPriority instead of a stale raw value', async () => {
    const { router } = createRouter({ statusInstanceId: 'daemon-local' })

    const result = await router.execute('mesh_status', {
      meshId: 'mesh-provider-priority-sot',
      inlineMesh: {
        id: 'mesh-provider-priority-sot',
        name: 'Provider Priority SoT',
        repoIdentity: 'github.com/acme/provider-priority-sot',
        policy: {},
        coordinator: { preferredNodeId: 'node-local' },
        nodes: [{
          id: 'node-local',
          daemonId: 'daemon-local',
          workspace: '/missing/provider-priority-sot',
          providers: ['kimi', 'claude-cli', 'codex-cli'],
          policy: {
            providerPriority: ['kimi'],
            slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }],
          },
        }],
      },
    }) as any

    expect(result.success).toBe(true)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].providerPriority).toEqual(['claude-cli', 'codex-cli'])
  })

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
      await cleanupTempDir(configDir)
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
      await cleanupTempDir(configDir)
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
      await cleanupTempDir(configDir)
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
      await cleanupTempDir(dir)
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
      // Since the 2026-08-24 label-axis change, locally-hosted records get the
      // coordinator hostname stamped BEFORE the identity probe, so the verdict
      // upgrades from the positional 'selected coordinator node' fallback to
      // hostname-evidence — still same_machine, now with proof.
      localityReason: 'matched coordinator hostname',
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
      await cleanupTempDir(dir)
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
      // Freshness marker (additive): the self coordinator node reads as live local
      // truth; the remote node whose git probe has not run yet reads as pending —
      // never conflated with an unreachable/empty peer.
      expect(result.nodes.find((node: any) => node.nodeId === 'node-local').dataFreshness).toEqual(expect.objectContaining({
        dataSource: 'self',
        probeOk: true,
        reachable: true,
        staleness: 'fresh',
      }))
      expect(result.nodes.find((node: any) => node.nodeId === 'node-remote').dataFreshness).toEqual(expect.objectContaining({
        dataSource: 'pending',
        probeOk: false,
        reachable: null,
        lastProbeAt: '2026-05-17T05:01:00.000Z',
      }))
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('marks a freshly P2P-probed remote node as live truth', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-live-marker-')
    try {
      const dispatchMeshCommand = vi.fn(async () => ({
        status: {
          workspace: '/missing/remote',
          repoRoot: '/missing/remote',
          isGitRepo: true,
          branch: 'main',
          head: 'abcd1234',
          upstream: 'origin/main',
          upstreamStatus: 'fresh',
          ahead: 0,
          behind: 0,
          dirty: false,
          hasConflicts: false,
          lastCheckedAt: Date.parse('2026-06-20T07:02:58.779Z'),
        },
      }))
      const getMeshPeerConnectionStatus = vi.fn((daemonId: string) => daemonId === 'machine-remote'
        ? {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: 'connected',
            transport: 'direct',
            reported: true,
            reason: 'Connected directly peer-to-peer.',
            lastStateChangeAt: '2026-06-20T07:00:06.000Z',
          }
        : null)
      const { router } = createRouter({ dispatchMeshCommand, getMeshPeerConnectionStatus })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-live-marker',
        refresh: true,
        inlineMesh: {
          id: 'mesh-live-marker',
          name: 'Live Marker Mesh',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            { id: 'node-local', daemonId: 'machine-local', machineLabel: 'Local', workspace: repoRoot, providers: ['hermes-cli'], policy: { providerPriority: ['hermes-cli'] } },
            { id: 'node-remote', daemonId: 'machine-remote', machineLabel: 'Remote', workspace: '/missing/remote', providers: ['hermes-cli'], policy: { providerPriority: ['hermes-cli'] } },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      const remote = result.nodes.find((node: any) => node.nodeId === 'node-remote')
      expect(remote.dataFreshness).toEqual(expect.objectContaining({
        dataSource: 'live',
        probeOk: true,
        reachable: true,
        staleness: 'fresh',
        lastProbeAt: '2026-06-20T07:02:58.779Z',
      }))
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('marks a disconnected peer with no held truth as unreachable, not idle/empty', async () => {
    const { router } = createRouter({
      statusInstanceId: 'machine-local',
      getMeshPeerConnectionStatus: vi.fn((daemonId: string) => daemonId === 'machine-remote'
        ? {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: 'disconnected',
            transport: 'unknown',
            reported: true,
            reason: 'Mesh DataChannel closed.',
            lastStateChangeAt: '2026-06-20T00:00:00.000Z',
          }
        : null),
    })

    const result = await router.execute('mesh_status', {
      meshId: 'mesh-unreachable',
      inlineMesh: {
        id: 'mesh-unreachable',
        name: 'Unreachable Mesh',
        repoIdentity: 'repo',
        policy: {},
        coordinator: { preferredNodeId: 'node-local' },
        nodes: [
          {
            id: 'node-local',
            daemonId: 'machine-local',
            machineLabel: 'Local',
            workspace: '/missing/local',
            providers: ['hermes-cli'],
            policy: { providerPriority: ['hermes-cli'] },
          },
          {
            // Remote peer the coordinator cannot reach: P2P disconnected, no
            // cachedStatus/lastGit held truth. The legacy fields would render this
            // identically to an idle/empty node (health 'unknown', no sessions);
            // the freshness marker must call it out as unreachable.
            id: 'node-remote',
            daemonId: 'machine-remote',
            machineLabel: 'Remote',
            workspace: '/missing/remote',
            providers: ['codex-cli'],
            policy: { providerPriority: ['codex-cli'] },
          },
        ],
      },
    }) as any

    expect(result.success).toBe(true)
    const remote = result.nodes.find((node: any) => node.nodeId === 'node-remote')
    expect(remote.gitProbePending).toBeUndefined()
    expect(remote.dataFreshness).toEqual(expect.objectContaining({
      dataSource: 'unreachable',
      probeOk: false,
      reachable: false,
    }))
    // Self node stays reachable/live — the marker is additive and does not regress
    // normal node rendering.
    const local = result.nodes.find((node: any) => node.nodeId === 'node-local')
    expect(local.dataFreshness).toEqual(expect.objectContaining({
      dataSource: 'self',
      reachable: true,
    }))
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
      await cleanupTempDir(dir)
    }
  })

  it('omits preview freshness for a repo without a configured preview pipeline (F15)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-preview-unconfigured-')
    try {
      // No .adhdev/preview-deploy.json, no scripts/preview-freshness.mjs, and no
      // deploy:preview npm script — an external repo joined to a mesh. The private
      // release-pipeline guidance must not leak into the coordinator surface.
      const { router } = createRouter()

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-preview-unconfigured',
        refresh: true,
        inlineMesh: {
          id: 'mesh-preview-unconfigured',
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
      expect(result.previewFreshness).toBeUndefined()
      expect(result.deployFreshness).toBeUndefined()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('surfaces preview freshness when the deploy:preview npm script is configured but no record exists (F15)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-preview-npm-script-')
    try {
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
      await writeFile(join(repoRoot, 'package.json'), JSON.stringify({
        name: 'demo',
        scripts: { 'deploy:preview': 'node scripts/deploy-preview-local.mjs' },
      }))
      const { router } = createRouter()

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-preview-npm-script',
        refresh: true,
        inlineMesh: {
          id: 'mesh-preview-npm-script',
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
        status: 'unknown',
        lastPreviewCommit: null,
        currentMainCommit: head,
        currentMainCommitSource: 'HEAD',
        recordPath: '.adhdev/preview-deploy.json',
      }))
      expect(result.deployFreshness).toEqual(result.previewFreshness)
    } finally {
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
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
            upstreamStatus: 'fresh',
            ahead: 0,
            behind: 5,
            dirty: false,
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
        // Standing-state model: per-node remote git probe + retry only fires on
        // an explicit refresh; the default load returns held truth without it.
        refresh: true,
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
      // The bounded retry re-reads the peer connection across attempts: a pre-attempt
      // liveness gate fast-fails offline/dropped peers, the between-attempt gate decides
      // whether to retry, and the warmup deadline samples it while a cold channel opens.
      // The EXACT read count is therefore an implementation detail that varies with
      // dispatch/timer ordering (observed 3–5 across platforms) — pinning it made this a
      // cross-platform flake. Assert the invariant the retry actually depends on instead:
      // the connection is consulted more than once (so the between-attempt re-check ran),
      // always scoped to the remote peer, and the surfaced connection/git truth below
      // proves the probe recovered after the telemetry flipped to `connected`.
      expect(getMeshPeerConnectionStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(getMeshPeerConnectionStatus).toHaveBeenCalledWith('machine-remote')
      const remoteNode = result.nodes.find((node: any) => node.nodeId === 'node-remote')
      expect(remoteNode?.gitProbePending).toBeUndefined()
      expect(remoteNode).toEqual(expect.objectContaining({
        health: 'online',
        launchReady: true,
        machineStatus: 'online',
        providers: ['hermes-cli'],
        lastSeenAt: '2026-05-20T07:00:23.000Z',
        updatedAt: '2026-05-20T07:02:58.779Z',
        autoFastForwardEligible: true,
        suggestedAction: 'auto_fast_forward',
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
        upstreamStatus: 'fresh',
        ahead: 0,
        behind: 5,
        branchConvergence: expect.objectContaining({
          status: 'blocked_review',
          reason: 'default_branch_not_even_with_upstream',
        }),
      }))
    } finally {
      await cleanupTempDir(dir)
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
      // The requireDirectPeerTruth refresh confirms remote git via the bootstrap
      // hydrate, which lands on node.lastGit; the render loop reads that as held
      // (cached) truth. lastProbeAt/staleness reflect the peer's AUTHENTIC git-check
      // time (2026-05-21 here), so a snapshot whose underlying git is old is correctly
      // flagged stale rather than masquerading as fresh just because it was re-fetched.
      // The reachable flag flips true once the live peer-git connection is synthesized.
      expect(refreshed.nodes.find((node: any) => node.nodeId === 'node_303a1ded96a859540d7bf608448d1fcc').dataFreshness).toEqual(expect.objectContaining({
        dataSource: 'cached',
        probeOk: false,
        reachable: true,
        lastProbeAt: '2026-05-21T14:10:00.000Z',
        staleness: 'stale',
      }))
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
      // The default (non-refresh) load renders the same node from held standing
      // truth — explicitly marked cached so the coordinator reads the data as
      // possibly-stale rather than a fresh probe. The git lastCheckedAt drives
      // lastProbeAt/staleness.
      expect(cached.nodes.find((node: any) => node.nodeId === 'node_303a1ded96a859540d7bf608448d1fcc').dataFreshness).toEqual(expect.objectContaining({
        dataSource: 'cached',
        probeOk: false,
        lastProbeAt: '2026-05-21T14:10:00.000Z',
      }))
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
      expect(sessionHostControl.listSessions).not.toHaveBeenCalled()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('does not reuse cached mesh_status after queue storage changes outside the router', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-queue-cache-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-queue-revision-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const { enqueueTask, __resetMeshRuntimeStoreForTests } = await import('../../src/mesh/mesh-work-queue.js')
      __resetMeshRuntimeStoreForTests()

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
      enqueueTask(mesh.id, 'queue task created by another mesh process', { difficulty: 'medium' })

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
      const { __resetMeshRuntimeStoreForTests } = await import('../../src/mesh/mesh-work-queue.js')
      __resetMeshRuntimeStoreForTests()
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
    }
  })

  it('surfaces pending coordinator events through mesh_status (peek only — drain requires get_pending_mesh_events)', async () => {
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

      // mesh_status is peek-only — events are NOT consumed; still present for drain.
      expect(drainPendingMeshCoordinatorEvents(mesh.id)).toHaveLength(1)

      // After explicit drain via get_pending_mesh_events, mesh_status no longer surfaces them.
      await router.execute('get_pending_mesh_events', { meshId: mesh.id })
      const cachedAfterDrain = await router.execute('mesh_status', { meshId: mesh.id }) as any
      expect(cachedAfterDrain.success).toBe(true)
      expect(cachedAfterDrain.pendingCoordinatorEvents).toBeUndefined()
      expect(cachedAfterDrain.asyncRefineJobs).toEqual(withEvent.asyncRefineJobs)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
    }
  })

  // ★LEDGER-KIND-TAIL-BLINDSPOT: asyncRefineLedgerEntries used to be a bare
  // `readLedgerEntries(meshId, { tail: 100 })` — a bare tail window can be crowded out by
  // unrelated mesh traffic while an in-flight refine job's task_dispatched row is still
  // running (a refine pass runs typecheck/test/build for minutes). The fix reads with an
  // explicit kind filter and no tail, so the accepted refine job must still surface in
  // asyncRefineJobs even when buried under 200+ unrelated entries.
  it('★surfaces an accepted refine job even when its dispatch row is buried beyond the 100-entry tail window', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-status-refine-crowding-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-refine-crowding-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({
        name: 'Refine Crowding Mesh',
        repoIdentity: 'github.com/acme/refine-crowding',
        defaultBranch: 'master',
      })
      addNode(mesh.id, { workspace: repoRoot, repoRoot })
      const { router } = createRouter()

      appendLedgerEntry(mesh.id, {
        kind: 'task_dispatched',
        nodeId: 'node-buried',
        payload: {
          source: 'refine_mesh_node_async_job',
          refineJob: {
            jobId: 'refine_buried_under_noise',
            interactionId: 'ix-buried',
            status: 'accepted',
            meshId: mesh.id,
            nodeId: 'node-buried',
            workspace: repoRoot,
            startedAt: '2026-05-29T00:00:00.000Z',
          },
          async: true,
        },
      })

      // Bury the dispatch under far more than 100 unrelated ledger entries.
      for (let i = 0; i < 150; i++) {
        appendLedgerEntry(mesh.id, {
          kind: 'session_launched',
          nodeId: 'node-other',
          payload: { source: 'unrelated_traffic', seq: i },
        })
      }

      const result = await router.execute('mesh_status', { meshId: mesh.id, refresh: true }) as any
      expect(result.success).toBe(true)
      expect(result.asyncRefineJobs).toEqual([
        expect.objectContaining({
          jobId: 'refine_buried_under_noise',
          status: 'accepted',
          targetNodeId: 'node-buried',
        }),
      ])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
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
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
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
      // Standing-state model: a stale pending cache no longer auto-triggers a
      // blocking peer fan-out on a default load — only an explicit refresh does.
      const refreshed = await router.execute('mesh_status', {
        meshId: 'mesh_stale_pending_cache',
        inlineMesh,
        requireDirectPeerTruth: true,
        refresh: true,
      }) as any

      expect(refreshed.success).toBe(true)
      expect(refreshed.sourceOfTruth.aggregateSnapshot).toMatchObject({
        cached: false,
        refreshReason: 'explicit_refresh',
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
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
    }
  })

  // NODE-MEMBERSHIP-SHRINK-ON-MERGE: this test previously asserted that a
  // cache-only node vanishes from membership the moment ANY later inline
  // snapshot omits it (title: "drops cached inline nodes..."). That was the
  // exact anti-pattern root-caused by mesh RCA 2026-07-25 — a client snapshot
  // omitting a node is NOT evidence the node was intentionally removed (the
  // client may simply not have learned about it yet), and treating it as such
  // silently destroyed live worktree-clone membership (37 node_cloned events
  // over two days, only 3 base nodes survived). reconcileInlineMeshCache now
  // merges as a union: a cache-only node survives unless it carries positive
  // removal evidence (an explicit remove_mesh_node tombstone). A node whose
  // workspace has genuinely gone missing on disk is still correctly flagged as
  // direct-peer-truth-UNAVAILABLE (visible via unavailableNodeIds) rather than
  // silently dropped from the membership list — this is the actionable signal
  // callers should key off, not quiet deletion.
  it('keeps a cached inline node in membership (flagged unavailable, not dropped) when absent from a newer live inline snapshot', async () => {
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

      // requireDirectPeerTruth is a separate, pre-existing, intentional gate:
      // a non-worktree node whose direct truth cannot be confirmed correctly
      // fails THIS specific call (unrelated to the membership-merge fix under
      // test here). What this test asserts is that the node's MEMBERSHIP
      // itself is preserved (visible via unavailableNodeIds) rather than
      // silently vanishing from the mesh's node list.
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

      expect(result.success).toBe(false)
      expect(result.code).toBe('mesh_direct_peer_truth_unavailable')
      expect(result.sourceOfTruth.directPeerTruth).toMatchObject({
        required: true,
        satisfied: false,
        localConfirmedCount: 1,
        peerAttemptedCount: 0,
        unavailableNodeIds: ['node_removed'],
      })

      // The membership-merge fix under test: a plain (non-gated) read must
      // still show the cache-only node as a live member — preserved, not
      // silently dropped — with mesh_status's own per-node evidence marking
      // it unresolved rather than membership pretending it never existed.
      const plainRead = await router.execute('mesh_status', {
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
            { id: 'node_7', daemonId: 'daemon_7', machineLabel: 'Local', workspace: repoRoot, repoRoot, policy: { providerPriority: ['hermes-cli'] }, lastSeenAt: new Date().toISOString() },
          ],
        },
      }) as any
      expect(plainRead.success).toBe(true)
      expect(plainRead.nodes.map((node: any) => node.nodeId).sort()).toEqual(['node_7', 'node_removed'])

      // Explicit removal (positive evidence) must still actually drop the node
      // from membership — union-by-default does not block genuine removal.
      const removed = await router.execute('remove_mesh_node', {
        meshId: 'mesh_prune_inline_cache',
        nodeId: 'node_removed',
        force: true,
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
      }) as any
      expect(removed.success).toBe(true)

      const afterRemoval = await router.execute('mesh_status', {
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
          ],
        },
      }) as any
      expect(afterRemoval.nodes.map((node: any) => node.nodeId)).toEqual(['node_7'])
    } finally {
      await cleanupTempDir(dir)
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
      await cleanupTempDir(primary.dir)
      await cleanupTempDir(sibling.dir)
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
      await cleanupTempDir(dir)
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

      // Standing-state model: the hard fail-closed on an unreachable peer is
      // reserved for an explicit refresh that actually attempts the fan-out.
      const result = await router.execute('mesh_status', {
        meshId: 'mesh_303',
        requireDirectPeerTruth: true,
        refresh: true,
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
      // The `failed` peer is still ATTEMPTED (peerAttemptedCount: 2) and classified
      // unavailable, but its git_status probe is now SKIPPED before dispatch — a
      // definitively-down transport (state: 'failed') no longer burns a 25s probe
      // window that would stall the graph cold-open. So only the one reachable peer
      // (daemon_303) actually dispatches git_status.
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('default (non-refresh) load renders the graph from held standing-state truth without fanning out to a slow peer', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-standing-state-default-')
    try {
      const remoteWorkspace = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
      // Any fan-out would call this and (like a slow/TURN-relayed peer) hang or
      // throw. The default load must not call it at all.
      const dispatchMeshCommand = vi.fn(async () => {
        throw new Error('default load must not fan out a blocking git_status probe')
      })
      const { router } = createRouter({ dispatchMeshCommand })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_standing_default',
        requireDirectPeerTruth: true,
        // No refresh: the held standing state is returned immediately.
        inlineMesh: {
          id: 'mesh_standing_default',
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
              // A slow peer with NO held git truth yet — must not block the graph.
              id: 'node_slow',
              daemonId: 'daemon_slow',
              machineLabel: 'Slow peer',
              workspace: remoteWorkspace,
              repoRoot: remoteWorkspace,
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      // Graph renders: success, the local node carries live git, and the slow
      // peer is simply pending (setup inventory) rather than fatal.
      expect(result.success).toBe(true)
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
      expect(result.sourceOfTruth.coordinatorOwnsLiveTruth).toBe(true)
      const localNode = result.nodes.find((node: any) => node.nodeId === 'node_7')
      expect(localNode.git).toMatchObject({ isGitRepo: true })
      const slowNode = result.nodes.find((node: any) => node.nodeId === 'node_slow')
      expect(slowNode.gitProbePending).toBe(true)
    } finally {
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
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
      await cleanupTempDir(dir)
    }
  })
})

describe('mesh_status dead local worktree exclusion', () => {
  it('does not let a dead local worktree node (workspace deleted) block direct peer truth on refresh', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-dead-worktree-')
    try {
      const deadWorkspace = join(dir, 'gone', 'node_7ebd')
      // Self-daemon: the coordinator owns both the healthy local node and the
      // dead worktree node. statusInstanceId matches the dead node's daemonId.
      const dispatchMeshCommand = vi.fn(async () => {
        throw new Error('no remote peer should be probed for a dead local worktree')
      })
      const { router } = createRouter({ dispatchMeshCommand, statusInstanceId: 'daemon_self' })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_dead_worktree',
        requireDirectPeerTruth: true,
        refresh: true,
        inlineMesh: {
          id: 'mesh_dead_worktree',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_self' },
          policy: {},
          nodes: [
            {
              id: 'node_self',
              daemonId: 'daemon_self',
              machineLabel: 'Local',
              workspace: repoRoot,
              repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node_7ebd',
              daemonId: 'daemon_self',
              machineLabel: 'Stale worktree',
              isLocalWorktree: true,
              workspace: deadWorkspace,
              repoRoot: deadWorkspace,
              worktreeBranch: 'feature/gone',
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.code).not.toBe('mesh_direct_peer_truth_unavailable')
      expect(result.sourceOfTruth.directPeerTruth).toMatchObject({
        required: true,
        satisfied: true,
      })
      expect(result.sourceOfTruth.directPeerTruth.unavailableNodeIds).not.toContain('node_7ebd')
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('still fails closed for a genuinely unavailable remote peer (dead-worktree guard does not over-apply)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-dead-worktree-remote-')
    try {
      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
        expect(command).toBe('git_status')
        if (daemonId === 'daemon_remote') {
          throw new Error('P2P probe failed for remote peer')
        }
        throw new Error(`unexpected daemon ${daemonId}`)
      })
      const getMeshPeerConnectionStatus = vi.fn((daemonId: string) => {
        if (daemonId === 'daemon_remote') {
          return { state: 'connected', transport: 'direct', reported: true }
        }
        return null
      })
      const { router } = createRouter({ dispatchMeshCommand, getMeshPeerConnectionStatus, statusInstanceId: 'daemon_self' })

      const deadWorkspace = join(dir, 'gone', 'node_dead')
      const result = await router.execute('mesh_status', {
        meshId: 'mesh_dead_plus_remote',
        requireDirectPeerTruth: true,
        refresh: true,
        inlineMesh: {
          id: 'mesh_dead_plus_remote',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_self' },
          policy: {},
          nodes: [
            {
              id: 'node_self',
              daemonId: 'daemon_self',
              machineLabel: 'Local',
              workspace: repoRoot,
              repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node_dead',
              daemonId: 'daemon_self',
              machineLabel: 'Stale worktree',
              isLocalWorktree: true,
              workspace: deadWorkspace,
              repoRoot: deadWorkspace,
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node_remote',
              daemonId: 'daemon_remote',
              machineLabel: 'Remote (no live truth)',
              workspace: '/remote/adhdev',
              repoRoot: '/remote/adhdev',
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(false)
      expect(result.code).toBe('mesh_direct_peer_truth_unavailable')
      expect(result.sourceOfTruth.directPeerTruth.unavailableNodeIds).toContain('node_remote')
      expect(result.sourceOfTruth.directPeerTruth.unavailableNodeIds).not.toContain('node_dead')
      // The dead worktree was never probed; only the genuine remote peer was
      // (the remote may be retried, so assert the target rather than the count).
      expect(dispatchMeshCommand).toHaveBeenCalledWith('daemon_remote', 'git_status', expect.anything())
      for (const call of dispatchMeshCommand.mock.calls) {
        expect(call[0]).not.toBe('daemon_self')
      }
    } finally {
      await cleanupTempDir(dir)
    }
  })
})

describe('inline mesh node tombstone', () => {
  it('does not resurrect a removed inline node when the dashboard re-echoes it (workspace still gone)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-tombstone-')
    try {
      const { router } = createRouter({ statusInstanceId: 'daemon_self' })
      const deadWorkspace = join(dir, 'gone', 'node_wt')
      const inlineMesh = (updatedAt?: string) => ({
        id: 'mesh_tombstone',
        name: 'ADHDev',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_self' },
        policy: {},
        ...(updatedAt ? { updatedAt } : {}),
        nodes: [
          {
            id: 'node_self',
            daemonId: 'daemon_self',
            machineLabel: 'Local',
            workspace: repoRoot,
            repoRoot,
            providers: ['hermes-cli'],
            policy: { providerPriority: ['hermes-cli'] },
          },
          {
            id: 'node_wt',
            daemonId: 'daemon_self',
            machineLabel: 'Worktree',
            isLocalWorktree: true,
            workspace: deadWorkspace,
            repoRoot: deadWorkspace,
            providers: [],
            policy: { providerPriority: ['hermes-cli'] },
            // Transient node truth forces reconcileInlineMeshCache to MERGE the
            // echo (the genuine resurrection path) rather than ignore it.
            cachedStatus: { health: 'unknown', gitProbePending: true },
          },
        ],
      })

      // Seed the inline cache with both nodes.
      await router.execute('get_mesh', { meshId: 'mesh_tombstone', inlineMesh: inlineMesh() })

      // Remove the worktree node (force, since the workspace is already gone).
      const removed = await router.execute('remove_mesh_node', {
        meshId: 'mesh_tombstone',
        nodeId: 'node_wt',
        force: true,
        inlineMesh: inlineMesh(),
      }) as any
      expect(removed.success).toBe(true)
      expect(removed.removed).toBe(true)

      // Dashboard re-echoes the removed node on the next command, stamped newer
      // than the cache so reconcile's membership-preservation would otherwise
      // keep it. It must still NOT come back: the tombstone drops it because its
      // workspace is absent from disk.
      const afterEcho = await router.execute('get_mesh', {
        meshId: 'mesh_tombstone',
        inlineMesh: inlineMesh('2999-01-01T00:00:00.000Z'),
      }) as any
      expect(afterEcho.success).toBe(true)
      const echoedIds = (afterEcho.mesh?.nodes ?? []).map((n: any) => n.id ?? n.nodeId)
      expect(echoedIds).toContain('node_self')
      expect(echoedIds).not.toContain('node_wt')
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('allows genuine re-registration of a tombstoned node once its workspace is back on disk', async () => {
    const primary = await createTempGitRepo('mesh-tombstone-revive-primary-')
    const reborn = await createTempGitRepo('mesh-tombstone-revive-reborn-')
    try {
      const { router } = createRouter({ statusInstanceId: 'daemon_self' })
      const deadWorkspace = join(primary.dir, 'gone', 'node_wt')
      const baseNodes = (worktreeWorkspace: string) => [
        {
          id: 'node_self',
          daemonId: 'daemon_self',
          machineLabel: 'Local',
          workspace: primary.repoRoot,
          repoRoot: primary.repoRoot,
          providers: ['hermes-cli'],
          policy: { providerPriority: ['hermes-cli'] },
        },
        {
          id: 'node_wt',
          daemonId: 'daemon_self',
          machineLabel: 'Worktree',
          isLocalWorktree: true,
          workspace: worktreeWorkspace,
          repoRoot: worktreeWorkspace,
          providers: [],
          policy: { providerPriority: ['hermes-cli'] },
          cachedStatus: { health: 'unknown', gitProbePending: true },
        },
      ]
      const meshWith = (worktreeWorkspace: string, updatedAt?: string) => ({
        id: 'mesh_revive',
        name: 'ADHDev',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_self' },
        policy: {},
        ...(updatedAt ? { updatedAt } : {}),
        nodes: baseNodes(worktreeWorkspace),
      })

      await router.execute('get_mesh', { meshId: 'mesh_revive', inlineMesh: meshWith(deadWorkspace) })
      const removed = await router.execute('remove_mesh_node', {
        meshId: 'mesh_revive',
        nodeId: 'node_wt',
        force: true,
        inlineMesh: meshWith(deadWorkspace),
      }) as any
      expect(removed.removed).toBe(true)

      // Re-register the same nodeId with a workspace that exists on disk. The
      // re-echo is stamped newer than the cache so reconcile's membership-
      // preservation keeps the incoming node; the tombstone must clear (workspace
      // is back on disk) and not drop it.
      const revived = await router.execute('get_mesh', {
        meshId: 'mesh_revive',
        inlineMesh: meshWith(reborn.repoRoot, '2999-01-01T00:00:00.000Z'),
      }) as any
      expect(revived.success).toBe(true)
      const ids = (revived.mesh?.nodes ?? []).map((n: any) => n.id ?? n.nodeId)
      expect(ids).toContain('node_wt')
    } finally {
      await cleanupTempDir(primary.dir)
      await cleanupTempDir(reborn.dir)
    }
  })

  it('serves the held cached aggregate on a non-requireDirectPeerTruth detail-open even when a node is still gitProbePending (SWR: no forced live rebuild)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-swr-plain-')
    try {
      // Remote node with online machineStatus but no held git truth and no
      // dispatchMeshCommand wired → the render loop marks it gitProbePending.
      const { router, sessionHostControl } = createRouter({})
      const inlineMesh = {
        id: 'mesh_swr_plain',
        name: 'SWR Plain',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_local' },
        policy: {},
        nodes: [
          { id: 'node_local', daemonId: 'daemon_local', machineLabel: 'Local', workspace: repoRoot, repoRoot, providers: ['hermes-cli'], policy: {} },
          {
            id: 'node_remote_pending',
            daemonId: 'daemon_remote',
            machineLabel: 'Remote',
            workspace: '/Users/moltbot/does-not-exist-locally/repo',
            repoRoot: '/Users/moltbot/does-not-exist-locally/repo',
            machineStatus: 'online',
            providers: [],
            policy: {},
          },
        ],
      }

      // Cold cache miss → live build; remembers a snapshot whose remote node is
      // gitProbePending (no held truth, no probe possible).
      const first = await router.execute('mesh_status', {
        meshId: 'mesh_swr_plain',
        inlineMesh,
        refresh: false,
      }) as any
      expect(first.success).toBe(true)
      expect(first.sourceOfTruth.aggregateSnapshot).toMatchObject({ cached: false })
      expect(first.nodes.find((n: any) => n.nodeId === 'node_remote_pending')?.gitProbePending).toBe(true)

      sessionHostControl.listSessions.mockClear()

      // Second identical plain (no requireDirectPeerTruth) detail-open must be
      // served from the held cache — NOT forced into a fresh live rebuild — even
      // though a node is still gitProbePending.
      const second = await router.execute('mesh_status', {
        meshId: 'mesh_swr_plain',
        inlineMesh,
        refresh: false,
      }) as any
      expect(second.success).toBe(true)
      expect(second.sourceOfTruth.aggregateSnapshot).toMatchObject({
        owner: 'coordinator_daemon_memory',
        cached: true,
        refreshReason: 'memory_cache_hit',
      })
      // A cache hit does not re-collect live session records.
      expect(sessionHostControl.listSessions).not.toHaveBeenCalled()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('SWR stale-serves the cached aggregate to a requireDirectPeerTruth detail-open and coalesces one background freshen instead of a synchronous rebuild', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-swr-truth-')
    try {
      const { router, sessionHostControl } = createRouter({})
      const inlineMesh = {
        id: 'mesh_swr_truth',
        name: 'SWR Truth',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_local' },
        policy: {},
        nodes: [
          { id: 'node_local', daemonId: 'daemon_local', machineLabel: 'Local', workspace: repoRoot, repoRoot, providers: [], policy: {} },
          {
            id: 'node_remote_pending',
            daemonId: 'daemon_remote',
            machineLabel: 'Remote',
            workspace: '/Users/moltbot/does-not-exist-locally/repo',
            repoRoot: '/Users/moltbot/does-not-exist-locally/repo',
            machineStatus: 'online',
            providers: [],
            policy: {},
          },
        ],
      }

      // Seed the cache with a snapshot that still has a gitProbePending node.
      const seed = await router.execute('mesh_status', {
        meshId: 'mesh_swr_truth',
        inlineMesh,
        refresh: false,
      }) as any
      expect(seed.success).toBe(true)
      expect(seed.nodes.find((n: any) => n.nodeId === 'node_remote_pending')?.gitProbePending).toBe(true)

      sessionHostControl.listSessions.mockClear()

      // requireDirectPeerTruth:true + refresh:false. Pre-change this MISSED the
      // cache (shouldRefreshStalePendingAggregate) and forced a full synchronous
      // live rebuild. Now it stale-serves the held snapshot immediately and kicks
      // ONE background freshen.
      const stale = await router.execute('mesh_status', {
        meshId: 'mesh_swr_truth',
        inlineMesh,
        requireDirectPeerTruth: true,
        refresh: false,
      }) as any
      expect(stale.success).toBe(true)
      expect(stale.sourceOfTruth.aggregateSnapshot).toMatchObject({
        owner: 'coordinator_daemon_memory',
        cached: true,
      })

      // Let the fire-and-forget background freshen run. It rebuilds live (calls
      // listSessions). It must fire exactly once (coalesced), not per-call.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(sessionHostControl.listSessions).toHaveBeenCalledTimes(1)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('parallel local per-node probe degrades a single broken-workspace node without failing the aggregate', async () => {
    const good = await createTempGitRepo('mesh-status-parallel-good-')
    const alsoGood = await createTempGitRepo('mesh-status-parallel-good2-')
    try {
      const { router } = createRouter({})
      // node_broken points at a path that exists as a directory but is NOT a git
      // repo, so its local getGitRepoStatus resolves isGitRepo:false → that node
      // degrades to 'degraded' health while the two real repos stay healthy.
      const brokenWorkspace = good.dir // the temp dir itself is not a git repo (repo is under dir/repo)
      const inlineMesh = {
        id: 'mesh_parallel',
        name: 'Parallel',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        coordinator: { preferredNodeId: 'node_good' },
        policy: {},
        nodes: [
          { id: 'node_good', daemonId: 'daemon_good', machineLabel: 'Good', workspace: good.repoRoot, repoRoot: good.repoRoot, providers: [], policy: {} },
          { id: 'node_broken', daemonId: 'daemon_broken', machineLabel: 'Broken', workspace: brokenWorkspace, repoRoot: brokenWorkspace, providers: [], policy: {} },
          { id: 'node_good2', daemonId: 'daemon_good2', machineLabel: 'Good2', workspace: alsoGood.repoRoot, repoRoot: alsoGood.repoRoot, providers: [], policy: {} },
        ],
      }

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_parallel',
        inlineMesh,
        refresh: false,
      }) as any

      // The whole aggregate never fails just because one node's probe degraded.
      expect(result.success).toBe(true)
      expect(result.nodes).toHaveLength(3)
      const good1 = result.nodes.find((n: any) => n.nodeId === 'node_good')
      const good2 = result.nodes.find((n: any) => n.nodeId === 'node_good2')
      const broken = result.nodes.find((n: any) => n.nodeId === 'node_broken')
      expect(good1?.git?.isGitRepo).toBe(true)
      expect(good2?.git?.isGitRepo).toBe(true)
      // The broken node is present with degraded (non-online) health — degraded
      // for THAT node only, not dropped and not fatal to the aggregate.
      expect(broken).toBeDefined()
      expect(broken?.git?.isGitRepo).toBe(false)
      expect(broken?.health).toBe('degraded')
    } finally {
      await cleanupTempDir(good.dir)
      await cleanupTempDir(alsoGood.dir)
    }
  })
})

describe('mesh_status machine ⊃ nodes label axes', () => {
  it('gives every locally-hosted checkout the SAME machine label and a distinct node label', async () => {
    // Owner axiom 2026-08-24: a machine hosts one base checkout + N worktrees.
    // machineLabel is the MACHINE axis (identical across all three, never
    // branch-derived — the pre-08-24 builder titled worktrees like separate
    // machines); nodeLabel is the CHECKOUT axis (⎇ branch / basename). The
    // labels are produced at the source now, so no relabel post-pass exists.
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-axes-')
    try {
      const { router } = createRouter()
      const result = await router.execute('mesh_status', {
        meshId: 'mesh_axes',
        refresh: true,
        inlineMesh: {
          id: 'mesh_axes',
          name: 'Axes',
          repoIdentity: 'repo',
          defaultBranch: 'main',
          policy: {},
          coordinator: { preferredNodeId: 'node_base' },
          nodes: [
            { id: 'node_base', workspace: repoRoot, repoRoot, policy: {} },
            {
              id: 'node_wt_a',
              workspace: '/missing/worktrees/adhdev/fix-a',
              repoRoot: '/missing/worktrees/adhdev/fix-a',
              isLocalWorktree: true,
              worktreeBranch: 'fix/a',
              policy: {},
            },
            {
              id: 'node_wt_b',
              workspace: '/missing/worktrees/adhdev/fix-b',
              repoRoot: '/missing/worktrees/adhdev/fix-b',
              isLocalWorktree: true,
              worktreeBranch: 'fix/b',
              policy: {},
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      const byId = new Map<string, any>(result.nodes.map((node: any) => [node.nodeId, node]))
      const base = byId.get('node_base')
      const wtA = byId.get('node_wt_a')
      const wtB = byId.get('node_wt_b')
      expect(base && wtA && wtB).toBeTruthy()
      // MACHINE axis: one machine, one label — and never a branch/dir name.
      expect(wtA.machineLabel).toBe(base.machineLabel)
      expect(wtB.machineLabel).toBe(base.machineLabel)
      expect(String(base.machineLabel)).not.toContain('fix-a')
      expect(String(base.machineLabel)).not.toContain('fix/b')
      // NODE axis: each checkout keeps its own identity.
      expect(wtA.nodeLabel).toBe('⎇ fix/a')
      expect(wtB.nodeLabel).toBe('⎇ fix/b')
      expect(base.nodeLabel).toBe(repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop())
    } finally {
      await cleanupTempDir(dir)
    }
  })
})
