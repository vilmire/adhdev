import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonCommandRouter } from '../../src/commands/router.js'
import { resolveMeshCoordinatorSetup } from '../../src/commands/mesh-coordinator.js'
import type { ProviderModule } from '../../src/providers/contracts.js'

const baseProvider: ProviderModule = {
  type: 'test-cli',
  name: 'Test CLI',
  category: 'cli',
  spawn: { command: 'test' },
}

function resolveHermesCoordinatorHomeForTest(meshId: string, workspace: string): string {
  const key = `${meshId || 'mesh'}\n${resolve(workspace || tmpdir())}`
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(tmpdir(), `adhdev-hermes-mesh-coordinator-${hash}`)
}

function createAutoImportRouter(
  provider: ProviderModule,
  cliManager: { handleCliCommand: ReturnType<typeof vi.fn> },
  sessionHostControl?: { listSessions?: ReturnType<typeof vi.fn> },
) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: cliManager as any,
    cdpManagers: new Map(),
    providerLoader: {
      resolve: vi.fn(() => provider),
      getMeta: vi.fn(() => provider),
    } as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: {
      listSessions: vi.fn(async () => []),
      ...(sessionHostControl || {}),
    } as any,
    packageName: 'adhdev',
    statusVersion: '0.9.71',
  })
}

describe('resolveMeshCoordinatorSetup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns auto-import config that launches the published adhdev mcp entrypoint', () => {
    const provider: ProviderModule = {
      ...baseProvider,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }

    expect(resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_123',
      workspace: '/repo',
    })).toEqual({
      kind: 'auto_import',
      serverName: 'adhdev-mesh',
      configPath: '/repo/.mcp.json',
      configFormat: 'claude_mcp_json',
      mcpServer: {
        command: 'adhdev',
        args: ['mcp', '--mode', 'ipc', '--repo-mesh', 'mesh_123'],
      },
    })
  })

  it('can target a standalone local MCP transport and custom port through adhdev mcp', () => {
    const provider: ProviderModule = {
      ...baseProvider,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }

    expect(resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_local',
      workspace: '/repo',
      adhdevMcpTransport: 'local',
      adhdevMcpPort: 3957,
    })).toEqual(expect.objectContaining({
      kind: 'auto_import',
      mcpServer: {
        command: 'adhdev',
        args: ['mcp', '--mode', 'local', '--repo-mesh', 'mesh_local', '--port', '3957'],
      },
    }))
  })

  it('honors an explicit adhdev command override while keeping the mcp subcommand contract', () => {
    const provider: ProviderModule = {
      ...baseProvider,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'hermes_config_yaml',
          path: '~/hermes-config.yaml',
          serverName: 'adhdev-mesh',
        },
      },
    }

    expect(resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_custom_command',
      workspace: '/repo',
      adhdevMcpCommand: '/custom/bin/adhdev',
    })).toMatchObject({
      kind: 'auto_import',
      mcpServer: {
        command: '/custom/bin/adhdev',
        args: ['mcp', '--mode', 'ipc', '--repo-mesh', 'mesh_custom_command'],
      },
    })
  })

  it('materializes Hermes manual setup templates without pretending launch succeeded', () => {
    const provider: ProviderModule = {
      ...baseProvider,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          format: 'hermes_config_yaml',
          serverName: 'adhdev-mesh',
          configPathCommand: 'hermes config path',
          requiresRestart: true,
          instructions: 'Add this server to Hermes config.',
          template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - mcp\n      - --mode\n      - ipc\n      - --repo-mesh\n      - {{meshId}}\n',
        },
      },
    }

    expect(resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_456',
      workspace: '/repo',
      adhdevMcpCommand: '/repo/node_modules/.bin/adhdev',
    })).toEqual({
      kind: 'manual',
      serverName: 'adhdev-mesh',
      configFormat: 'hermes_config_yaml',
      configPathCommand: 'hermes config path',
      requiresRestart: true,
      instructions: 'Add this server to Hermes config.',
      template: 'mcp_servers:\n  adhdev-mesh:\n    command: /repo/node_modules/.bin/adhdev\n    args:\n      - mcp\n      - --mode\n      - ipc\n      - --repo-mesh\n      - mesh_456\n',
    })
  })

  it('surfaces unsupported providers explicitly', () => {
    expect(resolveMeshCoordinatorSetup({ provider: baseProvider, meshId: 'mesh_789', workspace: '/repo' })).toEqual({
      kind: 'unsupported',
      reason: 'Provider does not declare Repo Mesh coordinator support',
    })
  })

  it('resolves antigravity-cli coordinator as cli_command using agy mcp add template', () => {
    const provider: ProviderModule = {
      ...baseProvider,
      type: 'antigravity-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          serverName: 'adhdev-mesh',
          requiresRestart: true,
          instructions: 'ADHDev will register the adhdev-mesh MCP server in Antigravity CLI via `agy mcp add` before launching a fresh coordinator session. You can verify with `agy mcp list`.',
          template: 'agy mcp add {{serverName}} -- {{adhdevMcpCommand}} mcp --mode ipc --repo-mesh {{meshId}}',
        },
      },
    }

    const result = resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_agy_coord',
      workspace: '/repo',
    })

    expect(result.kind).toBe('cli_command')
    if (result.kind !== 'cli_command') throw new Error('expected cli_command')
    expect(result.serverName).toBe('adhdev-mesh')
    expect(result.command).toBe('agy mcp add adhdev-mesh -- adhdev mcp --mode ipc --repo-mesh mesh_agy_coord')
    expect(result.requiresRestart).toBe(true)
    expect(result.instructions).toContain('agy mcp add')
  })

  it('resolves antigravity-cli coordinator with a custom adhdevMcpCommand', () => {
    const provider: ProviderModule = {
      ...baseProvider,
      type: 'antigravity-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          serverName: 'adhdev-mesh',
          requiresRestart: true,
          instructions: 'Register via agy mcp add.',
          template: 'agy mcp add {{serverName}} -- {{adhdevMcpCommand}} mcp --mode ipc --repo-mesh {{meshId}}',
        },
      },
    }

    const result = resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_agy_custom',
      workspace: '/repo',
      adhdevMcpCommand: '/usr/local/bin/adhdev',
    })

    expect(result.kind).toBe('cli_command')
    if (result.kind !== 'cli_command') throw new Error('expected cli_command')
    expect(result.command).toContain('/usr/local/bin/adhdev')
    expect(result.command).toContain('mesh_agy_custom')
  })

  it('codex-cli coordinator setup is unaffected after adding antigravity-cli support', () => {
    const provider: ProviderModule = {
      ...baseProvider,
      type: 'codex-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          serverName: 'adhdev-mesh',
          requiresRestart: true,
          instructions: 'ADHDev will register the adhdev-mesh MCP server in Codex via `codex mcp add` before launching a fresh coordinator session. You can verify with `codex mcp list`.',
          template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} mcp --mode ipc --repo-mesh {{meshId}}',
        },
      },
    }

    const result = resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_codex_unaffected',
      workspace: '/repo',
    })

    expect(result.kind).toBe('cli_command')
    if (result.kind !== 'cli_command') throw new Error('expected cli_command')
    expect(result.serverName).toBe('adhdev-mesh')
    expect(result.command).toContain('codex mcp add')
    expect(result.command).toContain('mesh_codex_unaffected')
  })

  it('launch_mesh_coordinator prefers live session-host workspace over stale node workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-coordinator-live-workspace-'))
    const liveRepo = join(root, 'repo')
    const deletedWorktree = join(root, 'deleted-worktree')
    initGitRepo(liveRepo)
    const mcpEntry = join(root, 'mcp-server.js')
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry

    const provider: ProviderModule = {
      ...baseProvider,
      type: 'claude-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'coordinator-live-session' })),
    }
    const router = createAutoImportRouter(provider, cliManager, {
      listSessions: vi.fn(async () => [
        {
          sessionId: 'coord-runtime-live',
          workspace: liveRepo,
          lifecycle: 'running',
          providerType: 'claude-cli',
          meta: { meshCoordinatorFor: 'mesh-live-workspace' },
        },
      ]),
    })

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh-live-workspace',
        cliType: 'claude-cli',
        inlineMesh: {
          id: 'mesh-live-workspace',
          name: 'Live Workspace Mesh',
          repoIdentity: 'example/repo',
          policy: {},
          coordinator: { preferredNodeId: 'node-local' },
          nodes: [
            {
              id: 'node-local',
              daemonId: 'daemon-local',
              machineId: 'machine-local',
              workspace: deletedWorktree,
              repoRoot: deletedWorktree,
              providers: ['claude-cli'],
              policy: { providerPriority: ['claude-cli'] },
            },
          ],
        },
      }) as any

      expect(result).toMatchObject({
        success: true,
        workspace: liveRepo,
        sessionId: 'coordinator-live-session',
      })
      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('launch_cli', expect.objectContaining({
        cliType: 'claude-cli',
        dir: liveRepo,
        settings: { meshCoordinatorFor: 'mesh-live-workspace' },
      }))
    } finally {
      if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
      else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
      rmSync(root, { recursive: true, force: true })
    }
  })

  function initGitRepo(repo: string) {
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), 'init\n', 'utf-8')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  }

  it('clones and removes worktree nodes from cached inline meshes without local meshes.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-inline-mesh-worktree-'))
    const repo = join(root, 'repo')
    initGitRepo(repo)
    const mcpEntry = join(root, 'mcp-server.js')
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry

    const provider: ProviderModule = {
      ...baseProvider,
      type: 'claude-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'coordinator-session' })),
    }
    const router = createAutoImportRouter(provider, cliManager)
    const inlineMesh = {
      id: 'mesh_inline_worktree',
      name: 'Inline Mesh',
      repoIdentity: 'example/repo',
      nodes: [{ id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'daemon-source', machineId: 'mreg-source', policy: { canPush: true } }],
      policy: {},
      coordinator: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    try {
      await expect(router.execute('launch_mesh_coordinator', {
        meshId: inlineMesh.id,
        cliType: 'claude-cli',
        inlineMesh,
      })).resolves.toMatchObject({ success: true })

      const cloned: any = await router.execute('clone_mesh_node', {
        meshId: inlineMesh.id,
        sourceNodeId: 'node-source',
        branch: 'mesh/worktree-smoke',
      })

      expect(cloned).toMatchObject({ success: true, branch: 'mesh/worktree-smoke' })
      expect(cloned.node).toMatchObject({
        isLocalWorktree: true,
        worktreeBranch: 'mesh/worktree-smoke',
        clonedFromNodeId: 'node-source',
        daemonId: 'daemon-source',
        machineId: 'mreg-source',
        policy: { canPush: true },
      })

      const cachedAfterClone: any = await router.execute('get_mesh', { meshId: inlineMesh.id })
      expect(cachedAfterClone.success).toBe(true)
      expect(cachedAfterClone.mesh.nodes.some((node: any) => node.id === cloned.node.id)).toBe(true)

      const removed: any = await router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: cloned.node.id,
      })
      expect(removed).toMatchObject({ success: true, removed: true })
      const cachedAfterRemove: any = await router.execute('get_mesh', { meshId: inlineMesh.id })
      expect(cachedAfterRemove.mesh.nodes.some((node: any) => node.id === cloned.node.id)).toBe(false)
    } finally {
      if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
      else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers a newer cached inline mesh snapshot for get_mesh when persisted membership is stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-inline-mesh-refresh-'))
    const repo = join(root, 'repo')
    const configDir = join(root, 'config')
    initGitRepo(repo)

    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = configDir

    try {
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const localMesh = createMesh({
        name: 'Persisted Mesh',
        repoIdentity: 'example/repo',
      })
      const sourceNode = addNode(localMesh.id, {
        workspace: repo,
        repoRoot: repo,
        daemonId: 'daemon-source',
        machineId: 'mreg-source',
        policy: { canPush: true },
      })
      expect(sourceNode).toBeTruthy()
      if (!sourceNode) throw new Error('expected persisted source node')

      const router = createAutoImportRouter(baseProvider, {
        handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
      })

      const cachedInlineMesh = {
        ...localMesh,
        nodes: [
          sourceNode,
          {
            id: 'node_worktree_cached',
            workspace: join(root, 'worktree'),
            repoRoot: join(root, 'worktree'),
            daemonId: 'daemon-source',
            machineId: 'mreg-source',
            userOverrides: {},
            policy: { canPush: true },
            isLocalWorktree: true,
            worktreeBranch: 'feat/cached',
            clonedFromNodeId: sourceNode!.id,
          },
        ],
        updatedAt: new Date().toISOString(),
      }

      router.getCachedInlineMesh(localMesh.id, cachedInlineMesh)

      const result: any = await router.execute('get_mesh', { meshId: localMesh.id })
      expect(result).toMatchObject({ success: true })
      expect(result.mesh.nodes.map((node: any) => node.id)).toEqual([
        sourceNode!.id,
        'node_worktree_cached',
      ])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes Claude MCP config with the published adhdev mcp entrypoint', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-coordinator-'))
    const mcpEntry = join(workspace, 'mcp-server.js')
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry

    const provider: ProviderModule = {
      ...baseProvider,
      type: 'claude-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'session-1' })),
    }
    const router = createAutoImportRouter(provider, cliManager)

    const inlineMesh = {
      id: 'mesh_123',
      name: 'Test Mesh',
      repoIdentity: 'example/repo',
      nodes: [{ id: 'node-1', workspace, policy: {} }],
      policy: {},
      coordinator: {},
    }

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh_123',
        cliType: 'claude-cli',
        inlineMesh,
      })

      expect(result).toMatchObject({ success: true, sessionId: 'session-1' })
      const mcpConfig = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf-8'))
      expect(mcpConfig.mcpServers['adhdev-mesh']).toEqual({
        command: 'adhdev',
        args: ['mcp', '--mode', 'ipc', '--repo-mesh', 'mesh_123'],
        env: {
          ADHDEV_INLINE_MESH: JSON.stringify(inlineMesh),
          ADHDEV_MCP_TRANSPORT: 'ipc',
        },
      })
      expect(mcpConfig.mcpServers['adhdev-mesh'].command).toBe('adhdev')
      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('launch_cli', expect.objectContaining({
        cliType: 'claude-cli',
        dir: workspace,
      }))
    } finally {
      if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
      else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed for non-Hermes manual MCP coordinator setup instead of launching', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-manual-coordinator-'))
    const provider: ProviderModule = {
      ...baseProvider,
      type: 'other-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          format: 'hermes_config_yaml',
          serverName: 'adhdev-mesh',
          requiresRestart: true,
          instructions: 'Manual setup required.',
          template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'session-should-not-launch' })),
    }
    const router = createAutoImportRouter(provider, cliManager)
    const inlineMesh = {
      id: 'mesh_manual_non_hermes',
      name: 'Manual Mesh',
      repoIdentity: 'example/repo',
      nodes: [{ id: 'node-1', workspace, policy: {} }],
      policy: {},
      coordinator: {},
    }

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh_manual_non_hermes',
        cliType: 'other-cli',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: false,
        code: 'mesh_coordinator_manual_mcp_setup_required',
        cliType: 'other-cli',
      })
      expect(cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('writes Hermes MCP YAML config and launches Hermes even when provider metadata still says manual setup', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-hermes-coordinator-'))
    const configDir = join(workspace, '.hermes')
    const configPath = join(configDir, 'config.yaml')
    const mcpEntry = join(workspace, 'mcp-server.js')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    writeFileSync(configPath, 'model:\n  provider: openrouter\nmcp_servers:\n  existing:\n    command: existing-server\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    const previousHome = process.env.HOME
    const previousHermesHome = process.env.HERMES_HOME
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry
    process.env.HOME = workspace
    delete process.env.HERMES_HOME
    writeFileSync(join(configDir, '.env'), 'OPENROUTER_API_KEY=***', 'utf-8')
    writeFileSync(join(configDir, 'auth.json'), '{"providers":{}}\n', 'utf-8')

    const provider: ProviderModule = {
      ...baseProvider,
      type: 'hermes-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          format: 'hermes_config_yaml',
          serverName: 'adhdev-mesh',
          configPathCommand: 'hermes config path',
          requiresRestart: true,
          instructions: 'Hermes CLI does not auto-import repo-local .mcp.json. Add this MCP server to Hermes config under mcp_servers, then start a fresh Hermes session.',
          template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - mcp\n      - --mode\n      - ipc\n      - --repo-mesh\n      - {{meshId}}\n    enabled: true\n',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'hermes-session-1' })),
    }
    const router = createAutoImportRouter(provider, cliManager)
    const inlineMesh = {
      id: 'mesh_hermes',
      name: 'Hermes Mesh',
      repoIdentity: 'example/repo',
      nodes: [{ id: 'node-1', workspace, policy: {} }],
      policy: {},
      coordinator: {},
    }

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh_hermes',
        cliType: 'hermes-cli',
        inlineMesh,
      })

      expect(result).toMatchObject({ success: true, sessionId: 'hermes-session-1', mcpConfigWritten: true })
      const configText = readFileSync(configPath, 'utf-8')
      expect(configText).toBe('model:\n  provider: openrouter\nmcp_servers:\n  existing:\n    command: existing-server\n')

      const launchCall = (cliManager.handleCliCommand as any).mock.calls[0]?.[1] as any
      expect(launchCall).toBeTruthy()
      expect(launchCall).toEqual(expect.objectContaining({
        cliType: 'hermes-cli',
        dir: workspace,
        cliArgs: undefined,
        env: expect.objectContaining({
          HERMES_EPHEMERAL_SYSTEM_PROMPT: expect.stringContaining('Repo Mesh'),
          HERMES_IGNORE_USER_CONFIG: '',
          HERMES_HOME: expect.stringContaining('adhdev-hermes-mesh-coordinator-'),
        }),
      }))
      const isolatedConfigPath = join(String(launchCall.env.HERMES_HOME), 'config.yaml')
      expect(isolatedConfigPath).not.toBe(configPath)
      const isolatedConfigText = readFileSync(isolatedConfigPath, 'utf-8')
      expect(isolatedConfigText).toContain('mcp_servers:')
      expect(isolatedConfigText).toContain('model:')
      expect(isolatedConfigText).toContain('provider: openrouter')
      expect(isolatedConfigText).not.toContain('existing:')
      expect(isolatedConfigText).toContain('adhdev-mesh:')
      expect(isolatedConfigText).toContain('ADHDEV_MCP_TRANSPORT: ipc')
      expect(isolatedConfigText).toContain('ADHDEV_INLINE_MESH:')
      expect(isolatedConfigText).toContain('mesh_hermes')
      expect(isolatedConfigText).not.toContain('mcpServers')
      expect(existsSync(join(String(launchCall.env.HERMES_HOME), '.env'))).toBe(true)
      expect(existsSync(join(String(launchCall.env.HERMES_HOME), 'auth.json'))).toBe(true)
    } finally {
      if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
      else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = previousHermesHome
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not let a stale Hermes coordinator temp config override the user Hermes model/provider', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-hermes-coordinator-stale-'))
    const configDir = join(workspace, '.hermes')
    const configPath = join(configDir, 'config.yaml')
    const mcpEntry = join(workspace, 'mcp-server.js')
    const meshId = 'mesh_hermes_stale_model'
    const staleCoordinatorHome = resolveHermesCoordinatorHomeForTest(meshId, workspace)
    const staleCoordinatorConfigPath = join(staleCoordinatorHome, 'config.yaml')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(staleCoordinatorHome, { recursive: true })
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    writeFileSync(configPath, 'model:\n  provider: kilocode\n  default: kilo-auto/frontier\nmcp_servers:\n  existing:\n    command: existing-server\n', 'utf-8')
    writeFileSync(staleCoordinatorConfigPath, 'model:\n  provider: openai-codex\n  default: gpt-5.5\nmcp_servers:\n  stale:\n    command: stale-server\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    const previousHome = process.env.HOME
    const previousHermesHome = process.env.HERMES_HOME
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry
    process.env.HOME = workspace
    delete process.env.HERMES_HOME

    const provider: ProviderModule = {
      ...baseProvider,
      type: 'hermes-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          format: 'hermes_config_yaml',
          serverName: 'adhdev-mesh',
          configPathCommand: 'hermes config path',
          requiresRestart: true,
          instructions: 'Hermes CLI does not auto-import repo-local .mcp.json. Add this MCP server to Hermes config under mcp_servers, then start a fresh Hermes session.',
          template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - mcp\n      - --mode\n      - ipc\n      - --repo-mesh\n      - {{meshId}}\n    enabled: true\n',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'hermes-session-stale-model' })),
    }
    const router = createAutoImportRouter(provider, cliManager)
    const inlineMesh = {
      id: meshId,
      name: 'Hermes Mesh Stale Model',
      repoIdentity: 'example/repo',
      nodes: [{ id: 'node-1', workspace, policy: {} }],
      policy: {},
      coordinator: {},
    }

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId,
        cliType: 'hermes-cli',
        inlineMesh,
      })

      expect(result).toMatchObject({ success: true, sessionId: 'hermes-session-stale-model', mcpConfigWritten: true })
      const launchCall = (cliManager.handleCliCommand as any).mock.calls[0]?.[1] as any
      expect(launchCall).toBeTruthy()
      expect(launchCall.env.HERMES_HOME).toBe(staleCoordinatorHome)
      const isolatedConfigText = readFileSync(staleCoordinatorConfigPath, 'utf-8')
      expect(isolatedConfigText).toContain('provider: kilocode')
      expect(isolatedConfigText).toContain('default: kilo-auto/frontier')
      expect(isolatedConfigText).not.toContain('provider: openai-codex')
      expect(isolatedConfigText).not.toContain('default: gpt-5.5')
      expect(launchCall.cliArgs).toBeUndefined()
      expect(launchCall.env).not.toHaveProperty('HERMES_MODEL')
      expect(launchCall.env).not.toHaveProperty('HERMES_PROVIDER')
    } finally {
      if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
      else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = previousHermesHome
      rmSync(workspace, { recursive: true, force: true })
      rmSync(staleCoordinatorHome, { recursive: true, force: true })
    }
  })

  it('fails closed instead of launching with a fallback prompt when coordinator prompt generation fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-coordinator-fail-closed-'))
    const mcpEntry = join(workspace, 'mcp-server.js')
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry

    const provider: ProviderModule = {
      ...baseProvider,
      type: 'claude-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'session-should-not-launch' })),
    }
    const router = createAutoImportRouter(provider, cliManager)
    const inlineMesh: any = {
      id: 'mesh_prompt_failure',
      name: 'Prompt Failure Mesh',
      repoIdentity: 'example/repo',
      nodes: [{ id: 'node-1', workspace, policy: {} }],
      coordinator: {},
      get policy() {
        throw new Error('broken inline mesh policy')
      },
      toJSON() {
        return {
          id: this.id,
          name: this.name,
          repoIdentity: this.repoIdentity,
          nodes: this.nodes,
          policy: {},
          coordinator: this.coordinator,
        }
      },
    }

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh_prompt_failure',
        cliType: 'claude-cli',
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: false,
        code: 'mesh_coordinator_prompt_failed',
        meshId: 'mesh_prompt_failure',
        cliType: 'claude-cli',
      })
      expect(String((result as any).error)).toContain('broken inline mesh policy')
      expect(cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
      else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('reuses cached cloud node status when an inline mesh workspace is not local to the selected coordinator', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-inline-'))
    const router = createAutoImportRouter(baseProvider, {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
    })
    const inlineMesh: any = {
      id: 'mesh_status_cached_remote',
      name: 'Cached Remote Status Mesh',
      repoIdentity: 'example/repo',
      nodes: [
        { id: 'node-local', workspace, policy: {} },
        {
          id: 'node-remote',
          workspace: '/Users/remote/.worktrees/adhdev',
          daemonId: 'daemon_remote',
          machineId: 'machine_remote',
          cachedStatus: {
            machineStatus: 'online',
            health: 'online',
            git: {
              workspace: '/Users/remote/.worktrees/adhdev',
              repoRoot: '/Users/remote/.worktrees/adhdev',
              isGitRepo: true,
              branch: 'main',
              headCommit: 'abc1234',
              headMessage: 'remote ok',
              upstream: 'origin/main',
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
                  commit: 'def5678',
                  repoPath: '/Users/remote/.worktrees/adhdev/oss',
                  dirty: false,
                  outOfSync: true,
                  lastCheckedAt: 123,
                },
              ],
            },
          },
          policy: {},
        },
      ],
      policy: {},
      coordinator: {},
    }

    try {
      const result = await router.execute('mesh_status', {
        meshId: inlineMesh.id,
        inlineMesh,
      })

      expect(result).toMatchObject({ success: true, meshId: inlineMesh.id })
      const remote = ((result as any).nodes as any[]).find(node => node.nodeId === 'node-remote')
      expect(remote).toMatchObject({
        health: 'unknown',
        gitProbePending: true,
        workspace: '/Users/remote/.worktrees/adhdev',
        daemonId: 'daemon_remote',
        machineId: 'machine_remote',
        machineStatus: 'online',
      })
      expect(remote.git).toBeUndefined()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('preserves live local submodule status in mesh_status so dialog graph normalization can emit subrepo nodes', async () => {
    const submoduleRepo = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-submodule-child-'))
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-submodule-parent-'))
    const router = createAutoImportRouter(baseProvider, {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
    })

    try {
      execFileSync('git', ['init'], { cwd: submoduleRepo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: submoduleRepo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'ADHDev Test'], { cwd: submoduleRepo, stdio: 'ignore' })
      writeFileSync(join(submoduleRepo, 'child.txt'), 'child\n')
      execFileSync('git', ['add', 'child.txt'], { cwd: submoduleRepo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'child init'], { cwd: submoduleRepo, stdio: 'ignore' })

      execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'ADHDev Test'], { cwd: workspace, stdio: 'ignore' })
      writeFileSync(join(workspace, 'README.md'), 'parent\n')
      execFileSync('git', ['add', 'README.md'], { cwd: workspace, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'parent init'], { cwd: workspace, stdio: 'ignore' })
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRepo, 'oss'], { cwd: workspace, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'add oss submodule'], { cwd: workspace, stdio: 'ignore' })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_status_live_submodules',
        inlineMesh: {
          id: 'mesh_status_live_submodules',
          name: 'Live Submodule Mesh',
          repoIdentity: 'example/repo',
          nodes: [{ id: 'node-local', workspace, policy: {} }],
          policy: {},
          coordinator: {},
        },
      })

      expect(result).toMatchObject({ success: true, meshId: 'mesh_status_live_submodules' })
      const local = ((result as any).nodes as any[]).find(node => node.nodeId === 'node-local')
      expect(local.git.submodules).toMatchObject([
        {
          path: 'oss',
          repoPath: realpathSync(join(workspace, 'oss')),
          outOfSync: false,
        },
      ])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(submoduleRepo, { recursive: true, force: true })
    }
  })

  it('prefers inline mesh snapshots over a same-id local meshes.json entry when computing mesh status', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-inline-preferred-'))
    const configDir = mkdtempSync(join(tmpdir(), 'adhdev-mesh-config-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = configDir
    writeFileSync(join(configDir, 'meshes.json'), JSON.stringify({
      meshes: [{
        id: 'mesh_status_inline_preferred',
        name: 'Local Stale Mesh',
        repoIdentity: 'example/repo',
        nodes: [{ id: 'node-local-stale', workspace: '/Users/local/stale', policy: {} }],
        policy: {},
        coordinator: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }, null, 2), 'utf-8')

    const router = createAutoImportRouter(baseProvider, {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
    })
    const inlineMesh: any = {
      id: 'mesh_status_inline_preferred',
      name: 'Inline Preferred Mesh',
      repoIdentity: 'example/repo',
      nodes: [
        { id: 'node-local', workspace, policy: {} },
        {
          id: 'node-remote',
          workspace: '/Users/remote/.worktrees/adhdev',
          daemonId: 'daemon_remote',
          machineId: 'machine_remote',
          cachedStatus: {
            machineStatus: 'online',
            health: 'online',
            git: {
              workspace: '/Users/remote/.worktrees/adhdev',
              repoRoot: '/Users/remote/.worktrees/adhdev',
              isGitRepo: true,
              branch: 'main',
              headCommit: 'abc1234',
              headMessage: 'inline preferred',
              upstream: 'origin/main',
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
          policy: {},
        },
      ],
      policy: {},
      coordinator: {},
    }

    try {
      const result = await router.execute('mesh_status', {
        meshId: inlineMesh.id,
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: true,
        meshId: inlineMesh.id,
        meshName: 'Inline Preferred Mesh',
        sourceOfTruth: {
          membership: 'inline_bootstrap_snapshot',
          coordinatorOwnsLiveTruth: true,
        },
      })
      expect(((result as any).nodes as any[]).map(node => node.nodeId)).toContain('node-remote')
      expect(((result as any).nodes as any[]).map(node => node.nodeId)).not.toContain('node-local-stale')
      const remote = ((result as any).nodes as any[]).find(node => node.nodeId === 'node-remote')
      expect(remote).toMatchObject({
        health: 'unknown',
        gitProbePending: true,
        daemonId: 'daemon_remote',
        machineId: 'machine_remote',
        machineStatus: 'online',
      })
      expect(remote.git).toBeUndefined()
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not let a warmed inline mesh cache shadow same-id local mesh commands without inlineMesh', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-inline-shadow-'))
    const configDir = mkdtempSync(join(tmpdir(), 'adhdev-mesh-config-shadow-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = configDir
    writeFileSync(join(configDir, 'meshes.json'), JSON.stringify({
      meshes: [{
        id: 'mesh_status_inline_preferred',
        name: 'Local Mesh',
        repoIdentity: 'example/repo',
        nodes: [{ id: 'node-local-stale', workspace: '/Users/local/stale', policy: {} }],
        policy: {},
        coordinator: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }, null, 2), 'utf-8')

    const router = createAutoImportRouter(baseProvider, {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
    })
    const inlineMesh: any = {
      id: 'mesh_status_inline_preferred',
      name: 'Inline Preferred Mesh',
      repoIdentity: 'example/repo',
      nodes: [
        { id: 'node-local', workspace, policy: {} },
        {
          id: 'node-remote',
          workspace: '/Users/remote/.worktrees/adhdev',
          daemonId: 'daemon_remote',
          machineId: 'machine_remote',
          cachedStatus: {
            machineStatus: 'online',
            health: 'online',
            git: {
              workspace: '/Users/remote/.worktrees/adhdev',
              repoRoot: '/Users/remote/.worktrees/adhdev',
              isGitRepo: true,
              branch: 'main',
              headCommit: 'abc1234',
            },
          },
          policy: {},
        },
      ],
      policy: {},
      coordinator: {},
    }

    try {
      await expect(router.execute('mesh_status', {
        meshId: inlineMesh.id,
        inlineMesh,
      })).resolves.toMatchObject({ success: true })

      await expect(router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-local-stale',
      })).resolves.toMatchObject({ success: true, removed: true })
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not resurrect removed live nodes when the same stale cloud bootstrap inline mesh is sent again', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-inline-live-cache-'))
    const router = createAutoImportRouter(baseProvider, {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
    })
    const inlineMesh: any = {
      id: 'mesh_status_inline_live_cache',
      name: 'Inline Live Cache Mesh',
      repoIdentity: 'example/repo',
      nodes: [
        { id: 'node-local', workspace, policy: {} },
        {
          id: 'node-remote',
          workspace: '/Users/remote/.worktrees/adhdev',
          daemonId: 'daemon_remote',
          machineId: 'machine_remote',
          cachedStatus: {
            machineStatus: 'online',
            health: 'online',
            git: {
              workspace: '/Users/remote/.worktrees/adhdev',
              repoRoot: '/Users/remote/.worktrees/adhdev',
              isGitRepo: true,
              branch: 'main',
              headCommit: 'abc1234',
            },
          },
          policy: {},
        },
      ],
      policy: {},
      coordinator: {},
    }

    try {
      await expect(router.execute('mesh_status', {
        meshId: inlineMesh.id,
        inlineMesh,
      })).resolves.toMatchObject({
        success: true,
        sourceOfTruth: { membership: 'inline_bootstrap_snapshot' },
      })

      await expect(router.execute('remove_mesh_node', {
        meshId: inlineMesh.id,
        nodeId: 'node-remote',
      })).resolves.toMatchObject({ success: true, removed: true })

      const result = await router.execute('mesh_status', {
        meshId: inlineMesh.id,
        inlineMesh,
      })

      expect(result).toMatchObject({
        success: true,
        sourceOfTruth: {
          membership: 'coordinator_inline_mesh_cache',
          coordinatorOwnsLiveTruth: true,
        },
      })
      expect(((result as any).nodes as any[]).map(node => node.nodeId)).toContain('node-local')
      expect(((result as any).nodes as any[]).map(node => node.nodeId)).not.toContain('node-remote')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('strips stale transited git/orphan snapshot fields from cached inline mesh membership before mesh_status reuses it', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-stale-inline-fields-'))
    initGitRepo(workspace)
    const router = createAutoImportRouter(baseProvider, {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
    })
    const staleInlineMesh: any = {
      id: 'mesh_status_stale_inline_fields',
      name: 'Stale Inline Fields Mesh',
      repoIdentity: 'example/repo',
      nodes: [
        { id: 'node-local', workspace, policy: {} },
        {
          id: 'node-remote',
          workspace: '/Users/remote/.worktrees/adhdev',
          daemonId: 'daemon_remote',
          machineId: 'machine_remote',
          cachedStatus: {
            machineStatus: 'online',
            health: 'degraded',
            error: 'Workspace must be an existing directory',
            git: {
              workspace: '/Users/remote/.worktrees/adhdev',
              repoRoot: '/Users/remote/.worktrees/adhdev',
              isGitRepo: false,
              branch: null,
              headCommit: null,
            },
          },
          policy: {},
        },
      ],
      policy: {},
      coordinator: {},
    }
    const refreshedInlineMesh: any = {
      id: 'mesh_status_stale_inline_fields',
      name: 'Stale Inline Fields Mesh',
      repoIdentity: 'example/repo',
      nodes: [
        { id: 'node-local', workspace, policy: {} },
        {
          id: 'node-remote',
          workspace: '/Users/remote/.worktrees/adhdev',
          daemonId: 'daemon_remote',
          machineId: 'machine_remote',
          policy: {},
        },
      ],
      policy: {},
      coordinator: {},
    }

    try {
      const cached: any = router.getCachedInlineMesh(staleInlineMesh.id, staleInlineMesh)
      expect(cached.nodes[1]).not.toHaveProperty('cachedStatus')

      const result = await router.execute('mesh_status', {
        meshId: refreshedInlineMesh.id,
        inlineMesh: refreshedInlineMesh,
      })

      expect(result).toMatchObject({
        success: true,
        sourceOfTruth: {
          membership: 'coordinator_inline_mesh_cache',
          coordinatorOwnsLiveTruth: true,
        },
      })
      const remote = ((result as any).nodes as any[]).find(node => node.nodeId === 'node-remote')
      expect(remote).toBeTruthy()
      expect(remote.error).toBeUndefined()
      expect(remote.git).toBeUndefined()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('prefers fresher live peer git telemetry over stale cached orphan snapshot state when mesh_status falls back to inline node truth', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-status-live-git-truth-'))
    initGitRepo(workspace)
    const router = createAutoImportRouter(baseProvider, {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'unused-session' })),
    })
    const meshId = 'mesh_status_live_git_truth'
    const remoteWorkspace = '/Users/remote/.worktrees/adhdev'

    ;(router as any).inlineMeshCache.set(meshId, {
      id: meshId,
      name: 'Live Git Truth Mesh',
      repoIdentity: 'example/repo',
      nodes: [
        { id: 'node-local', workspace, policy: {} },
        {
          id: 'node-remote',
          workspace: remoteWorkspace,
          daemonId: 'daemon_remote',
          machineId: 'machine_remote',
          cachedStatus: {
            machineStatus: 'online',
            health: 'degraded',
            error: 'Workspace must be an existing directory',
            git: {
              workspace: remoteWorkspace,
              repoRoot: remoteWorkspace,
              isGitRepo: false,
              branch: null,
              headCommit: null,
            },
          },
          lastGit: {
            status: {
              workspace: remoteWorkspace,
              repoRoot: remoteWorkspace,
              isGitRepo: true,
              branch: 'main',
              headCommit: 'abc1234',
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
          policy: {},
        },
      ],
      policy: {},
      coordinator: {},
    })

    try {
      const result = await router.execute('mesh_status', { meshId })

      expect(result).toMatchObject({
        success: true,
        sourceOfTruth: {
          membership: 'coordinator_inline_mesh_cache',
          coordinatorOwnsLiveTruth: true,
        },
      })
      const remote = ((result as any).nodes as any[]).find(node => node.nodeId === 'node-remote')
      expect(remote).toBeTruthy()
      expect(remote.git).toEqual(expect.objectContaining({
        isGitRepo: true,
        branch: 'main',
        headCommit: 'abc1234',
      }))
      expect(remote.health).toBe('online')
      expect(remote.error).toBeUndefined()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('claude-cli coordinator provider capability', () => {
  it('claude-cli meshCoordinator config resolves to auto_import with .mcp.json path', () => {
    const claudeProvider: ProviderModule = {
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude' },
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }

    const result = resolveMeshCoordinatorSetup({
      provider: claudeProvider,
      cliType: 'claude-cli',
      meshId: 'mesh_claude_coord',
      workspace: '/repo/workspace',
    })

    expect(result.kind).toBe('auto_import')
    if (result.kind !== 'auto_import') throw new Error('expected auto_import')
    expect(result.configPath).toBe('/repo/workspace/.mcp.json')
    expect(result.configFormat).toBe('claude_mcp_json')
    expect(result.serverName).toBe('adhdev-mesh')
    expect(result.mcpServer.command).toBe('adhdev')
    expect(result.mcpServer.args).toContain('--repo-mesh')
    expect(result.mcpServer.args).toContain('mesh_claude_coord')
  })

  it('provider without meshCoordinator field resolves to unsupported', () => {
    const bareProvider: ProviderModule = {
      type: 'bare-cli',
      name: 'Bare CLI',
      category: 'cli',
      spawn: { command: 'bare' },
    }

    const result = resolveMeshCoordinatorSetup({
      provider: bareProvider,
      cliType: 'bare-cli',
      meshId: 'mesh_bare',
      workspace: '/repo',
    })

    expect(result.kind).toBe('unsupported')
  })

  it('launch_mesh_coordinator includes --mcp-config and --append-system-prompt for claude-cli', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-claude-coord-args-'))
    const mcpEntry = join(workspace, 'mcp-server.js')
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry

    const provider: ProviderModule = {
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude' },
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    }
    const cliManager = {
      handleCliCommand: vi.fn(async () => ({ success: true, sessionId: 'claude-coord-session' })),
    }
    const router = createAutoImportRouter(provider, cliManager)
    const inlineMesh = {
      id: 'mesh_claude_args',
      name: 'Claude Args Mesh',
      repoIdentity: 'example/repo',
      nodes: [{ id: 'node-1', workspace, policy: {} }],
      policy: {},
      coordinator: {},
    }

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh_claude_args',
        cliType: 'claude-cli',
        inlineMesh,
      })

      expect(result).toMatchObject({ success: true, cliType: 'claude-cli' })
      const launchCall = (cliManager.handleCliCommand as any).mock.calls[0]?.[1] as any
      expect(launchCall.cliType).toBe('claude-cli')
      expect(launchCall.settings).toEqual({ meshCoordinatorFor: 'mesh_claude_args' })
      const cliArgs: string[] = launchCall.cliArgs || []
      expect(cliArgs).toContain('--mcp-config')
      const mcpConfigIndex = cliArgs.indexOf('--mcp-config')
      expect(cliArgs[mcpConfigIndex + 1]).toContain('.mcp.json')
      expect(cliArgs).toContain('--append-system-prompt')
      const promptIndex = cliArgs.indexOf('--append-system-prompt')
      expect(cliArgs[promptIndex + 1]).toContain('Repo Mesh Coordinator')
    } finally {
      if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
      else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
