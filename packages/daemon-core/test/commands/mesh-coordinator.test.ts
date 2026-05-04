import { describe, expect, it } from 'vitest'
import { resolveMeshCoordinatorSetup } from '../../src/commands/mesh-coordinator.js'
import type { ProviderModule } from '../../src/providers/contracts.js'

const baseProvider: ProviderModule = {
  type: 'test-cli',
  name: 'Test CLI',
  category: 'cli',
  spawn: { command: 'test' },
}

describe('resolveMeshCoordinatorSetup', () => {
  it('returns auto-import config path and server name for Claude-style providers', () => {
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

    expect(resolveMeshCoordinatorSetup({ provider, meshId: 'mesh_123', workspace: '/repo' })).toEqual({
      kind: 'auto_import',
      serverName: 'adhdev-mesh',
      configPath: '/repo/.mcp.json',
      configFormat: 'claude_mcp_json',
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
})
