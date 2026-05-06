import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
        command: process.execPath,
        args: [realpathSync(mcpEntry), '--mode', 'ipc', '--repo-mesh', 'mesh_123'],
        env: {
          ADHDEV_INLINE_MESH: JSON.stringify(inlineMesh),
          ADHDEV_MCP_TRANSPORT: 'ipc',
        },
      })
      expect(mcpConfig.mcpServers['adhdev-mesh'].command).not.toBe('adhdev-mcp')
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
})
