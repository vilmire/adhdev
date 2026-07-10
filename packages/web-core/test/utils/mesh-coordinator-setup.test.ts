import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MeshCoordinatorManualSetupPanel from '../../src/components/MeshCoordinatorManualSetupPanel'
import {
  buildManualCoordinatorSetup,
  normalizeManualCoordinatorSetup,
} from '../../src/utils/mesh-coordinator-setup'

describe('mesh coordinator setup UI helpers', () => {
  it('renders provider-declared manual MCP setup with mesh placeholders filled', () => {
    const setup = buildManualCoordinatorSetup({
      supported: true,
      mcpConfig: {
        mode: 'manual',
        format: 'hermes_config_yaml',
        serverName: 'adhdev-mesh',
        configPathCommand: 'hermes config path',
        requiresRestart: true,
        instructions: 'Add this MCP server to Hermes config.',
        template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - --repo-mesh\n      - {{meshId}}\n',
      },
    }, {
      meshId: 'mesh_test',
      adhdevMcpCommand: 'adhdev-mcp',
    })

    expect(setup).toEqual(expect.objectContaining({
      serverName: 'adhdev-mesh',
      configFormat: 'hermes_config_yaml',
      configPathCommand: 'hermes config path',
      requiresRestart: true,
    }))
    expect(setup?.template).toContain('mesh_test')
    expect(setup?.template).not.toContain('{{meshId}}')

    const html = renderToStaticMarkup(
      React.createElement(MeshCoordinatorManualSetupPanel, {
        setup,
        providerName: 'Hermes CLI',
      }),
    )

    expect(html).toContain('Manual MCP setup required for Hermes CLI')
    expect(html).toContain('Add this MCP server to Hermes config.')
    expect(html).toContain('hermes_config_yaml')
    expect(html).toContain('hermes config path')
    expect(html).toContain('mesh_test')
  })

  it('normalizes backend manual setup responses without treating them as generic errors', () => {
    const setup = normalizeManualCoordinatorSetup({
      serverName: 'adhdev-mesh',
      instructions: 'Manual setup required',
      template: 'mcp_servers:\n  adhdev-mesh: {}\n',
      requiresRestart: true,
    })

    expect(setup).toEqual(expect.objectContaining({
      serverName: 'adhdev-mesh',
      instructions: 'Manual setup required',
      requiresRestart: true,
    }))
  })

  it('suppresses panel for single-line cli_command templates (codex-style) — mirrors daemon reclassification', () => {
    // Codex provider.v1.json uses mode:'manual' but a single-line template the daemon auto-runs via PTY.
    // buildManualCoordinatorSetup must return null so the pre-launch panel is not shown.
    const setup = buildManualCoordinatorSetup({
      supported: true,
      mcpConfig: {
        mode: 'manual',
        instructions: 'Register this server.',
        template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}',
      },
    }, {
      meshId: 'mesh_local',
      adhdevMcpCommand: 'adhdev',
      adhdevMcpArgs: 'mcp --mode local --repo-mesh mesh_local --port 3847',
    })

    expect(setup).toBeNull()
  })

  it('does not suppress panel for multi-line templates (hermes-style truly-manual configs)', () => {
    const setup = buildManualCoordinatorSetup({
      supported: true,
      mcpConfig: {
        mode: 'manual',
        format: 'hermes_config_yaml',
        serverName: 'adhdev-mesh',
        instructions: 'Add this MCP server to Hermes config.',
        template: 'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args: []\n',
      },
    }, {
      meshId: 'mesh_local',
      adhdevMcpCommand: 'adhdev-mcp',
    })

    expect(setup).not.toBeNull()
    expect(setup?.template).toContain('\n')
  })
})
