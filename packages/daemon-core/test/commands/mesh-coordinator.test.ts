import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs'
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

function nodeSupportsWebSocket(command: string): boolean {
  try {
    execFileSync(command, ['-e', 'process.exit(typeof WebSocket === "function" ? 0 : 1)'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function findWebSocketNode(): string {
  const candidates = [
    process.env.ADHDEV_MCP_NODE_EXECUTABLE,
    process.env.ADHDEV_NODE_EXECUTABLE,
    process.env.npm_node_execpath,
    ...String(process.env.PATH || '').split(':').filter(Boolean).map((entry) => join(entry, 'node')),
    '/Users/vilmire/.nvm/versions/node/v22.17.0/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    process.execPath,
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()))

  for (const candidate of candidates) {
    if (nodeSupportsWebSocket(candidate)) return candidate
  }
  throw new Error('No WebSocket-capable Node runtime available for Repo Mesh MCP test')
}

function resolveHermesCoordinatorHomeForTest(meshId: string, workspace: string): string {
  const key = `${meshId || 'mesh'}\n${resolve(workspace || tmpdir())}`
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(tmpdir(), `adhdev-hermes-mesh-coordinator-${hash}`)
}

describe('resolveMeshCoordinatorSetup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns auto-import config that launches MCP through Node and an absolute entrypoint, not a PATH bin shim', () => {
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
      nodeExecutable: '/usr/local/bin/node',
      adhdevMcpEntryPath: '/opt/adhdev/vendor/mcp-server/index.js',
    })).toEqual({
      kind: 'auto_import',
      serverName: 'adhdev-mesh',
      configPath: '/repo/.mcp.json',
      configFormat: 'claude_mcp_json',
      mcpServer: {
        command: '/usr/local/bin/node',
        args: ['/opt/adhdev/vendor/mcp-server/index.js', '--mode', 'ipc', '--repo-mesh', 'mesh_123'],
      },
    })
  })

  it('can target a standalone local MCP transport and custom port', () => {
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
      nodeExecutable: '/usr/local/bin/node',
      adhdevMcpEntryPath: '/opt/adhdev/vendor/mcp-server/index.js',
      adhdevMcpTransport: 'local',
      adhdevMcpPort: 3957,
    })).toEqual(expect.objectContaining({
      kind: 'auto_import',
      mcpServer: {
        command: '/usr/local/bin/node',
        args: ['/opt/adhdev/vendor/mcp-server/index.js', '--mode', 'local', '--repo-mesh', 'mesh_local', '--port', '3957'],
      },
    }))
  })

  it('honors an explicit MCP Node override after verifying it can run WebSocket IPC', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mcp-node-runtime-'))
    const goodBin = join(root, 'good-bin')
    mkdirSync(goodBin, { recursive: true })
    const goodNode = join(goodBin, 'node')
    const mcpEntry = join(root, 'mcp-server.js')
    symlinkSync(findWebSocketNode(), goodNode)
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    chmodSync(goodNode, 0o755)
    const previousNodeOverride = process.env.ADHDEV_MCP_NODE_EXECUTABLE
    process.env.ADHDEV_MCP_NODE_EXECUTABLE = goodNode

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

    try {
      expect(resolveMeshCoordinatorSetup({
        provider,
        meshId: 'mesh_node_runtime',
        workspace: '/repo',
        adhdevMcpEntryPath: mcpEntry,
      })).toMatchObject({
        kind: 'auto_import',
        mcpServer: {
          command: realpathSync(goodNode),
          args: [realpathSync(mcpEntry), '--mode', 'ipc', '--repo-mesh', 'mesh_node_runtime'],
        },
      })
    } finally {
      if (previousNodeOverride === undefined) delete process.env.ADHDEV_MCP_NODE_EXECUTABLE
      else process.env.ADHDEV_MCP_NODE_EXECUTABLE = previousNodeOverride
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the sibling mcp-server workspace dist when standalone runs from a source checkout', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'adhdev-mcp-workspace-'))
    const standaloneSrc = join(repoRoot, 'packages', 'daemon-standalone', 'src')
    const mcpDist = join(repoRoot, 'packages', 'mcp-server', 'dist')
    mkdirSync(standaloneSrc, { recursive: true })
    mkdirSync(mcpDist, { recursive: true })
    const standaloneEntry = join(standaloneSrc, 'index.ts')
    const mcpEntry = join(mcpDist, 'index.js')
    writeFileSync(standaloneEntry, '// standalone dev entry\n', 'utf-8')
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    const previousArgv1 = process.argv[1]
    process.argv[1] = standaloneEntry

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

    try {
      expect(resolveMeshCoordinatorSetup({
        provider,
        meshId: 'mesh_dev_checkout',
        workspace: '/repo',
        nodeExecutable: '/usr/local/bin/node',
      })).toEqual({
        kind: 'auto_import',
        serverName: 'adhdev-mesh',
        configPath: '/repo/.mcp.json',
        configFormat: 'claude_mcp_json',
        mcpServer: {
          command: '/usr/local/bin/node',
          args: [realpathSync(mcpEntry), '--mode', 'ipc', '--repo-mesh', 'mesh_dev_checkout'],
        },
      })
    } finally {
      process.argv[1] = previousArgv1
      rmSync(repoRoot, { recursive: true, force: true })
    }
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
          template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - --repo-mesh\n      - {{meshId}}\n',
        },
      },
    }

    expect(resolveMeshCoordinatorSetup({
      provider,
      meshId: 'mesh_456',
      workspace: '/repo',
      adhdevMcpCommand: '/repo/node_modules/.bin/adhdev-mcp',
    })).toEqual({
      kind: 'manual',
      serverName: 'adhdev-mesh',
      configFormat: 'hermes_config_yaml',
      configPathCommand: 'hermes config path',
      requiresRestart: true,
      instructions: 'Add this server to Hermes config.',
      template: 'mcp_servers:\n  adhdev-mesh:\n    command: /repo/node_modules/.bin/adhdev-mcp\n    args:\n      - --repo-mesh\n      - mesh_456\n',
    })
  })

  it('surfaces unsupported providers explicitly', () => {
    expect(resolveMeshCoordinatorSetup({ provider: baseProvider, meshId: 'mesh_789', workspace: '/repo' })).toEqual({
      kind: 'unsupported',
      reason: 'Provider does not declare Repo Mesh coordinator support',
    })
  })

  function createAutoImportRouter(provider: ProviderModule, cliManager: { handleCliCommand: ReturnType<typeof vi.fn> }) {
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
      packageName: 'adhdev',
      statusVersion: '0.9.71',
    })
  }

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

  it('writes Claude MCP config with a Node-launched absolute MCP server entrypoint instead of adhdev-mcp on PATH', async () => {
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
        command: expect.any(String),
        args: [realpathSync(mcpEntry), '--mode', 'ipc', '--repo-mesh', 'mesh_123'],
        env: {
          ADHDEV_INLINE_MESH: JSON.stringify(inlineMesh),
          ADHDEV_MCP_TRANSPORT: 'ipc',
        },
      })
      expect(mcpConfig.mcpServers['adhdev-mesh'].command).not.toBe('adhdev-mcp')
      expect(mcpConfig.mcpServers['adhdev-mesh'].command).toMatch(/^\//)
      expect(nodeSupportsWebSocket(mcpConfig.mcpServers['adhdev-mesh'].command)).toBe(true)
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
          template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - --repo-mesh\n      - {{meshId}}\n    enabled: true\n',
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
          template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - --repo-mesh\n      - {{meshId}}\n    enabled: true\n',
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
        health: 'online',
        workspace: '/Users/remote/.worktrees/adhdev',
        daemonId: 'daemon_remote',
        machineId: 'machine_remote',
      })
      expect(remote.git).toMatchObject({
        repoRoot: '/Users/remote/.worktrees/adhdev',
        branch: 'main',
        headCommit: 'abc1234',
        isGitRepo: true,
      })
      expect(remote.git.submodules).toMatchObject([
        {
          path: 'oss',
          commit: 'def5678',
          repoPath: '/Users/remote/.worktrees/adhdev/oss',
          outOfSync: true,
        },
      ])
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

      expect(result).toMatchObject({ success: true, meshId: inlineMesh.id, meshName: 'Inline Preferred Mesh' })
      expect(((result as any).nodes as any[]).map(node => node.nodeId)).toContain('node-remote')
      expect(((result as any).nodes as any[]).map(node => node.nodeId)).not.toContain('node-local-stale')
      const remote = ((result as any).nodes as any[]).find(node => node.nodeId === 'node-remote')
      expect(remote).toMatchObject({ health: 'online', daemonId: 'daemon_remote', machineId: 'machine_remote' })
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
})
