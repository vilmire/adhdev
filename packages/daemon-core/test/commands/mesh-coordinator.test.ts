import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
        args: ['/opt/adhdev/vendor/mcp-server/index.js', '--repo-mesh', 'mesh_123'],
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
    const router = new DaemonCommandRouter({
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

    try {
      const result = await router.execute('launch_mesh_coordinator', {
        meshId: 'mesh_123',
        cliType: 'claude-cli',
        inlineMesh: {
          id: 'mesh_123',
          name: 'Test Mesh',
          repoIdentity: 'example/repo',
          nodes: [{ id: 'node-1', workspace, policy: {} }],
          policy: {},
          coordinator: {},
        },
      })

      expect(result).toMatchObject({ success: true, sessionId: 'session-1' })
      const mcpConfig = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf-8'))
      expect(mcpConfig.mcpServers['adhdev-mesh']).toEqual({
        command: process.execPath,
        args: [realpathSync(mcpEntry), '--repo-mesh', 'mesh_123'],
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
})
