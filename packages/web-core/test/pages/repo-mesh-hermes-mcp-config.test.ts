import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RepoMeshHermesMcpConfig, getNodeActiveAssignments, describeNodeActiveAssignmentLabel } from '../../src/pages/RepoMesh'

describe('RepoMeshHermesMcpConfig', () => {
  it('shows Hermes YAML setup without advertising Claude auto-import config', () => {
    const html = renderToStaticMarkup(
      React.createElement(RepoMeshHermesMcpConfig, {
        meshId: 'mesh_test',
        availableCliAgents: [
          {
            id: 'claude-cli',
            name: 'Claude Code',
            meshCoordinator: {
              supported: true,
              mcpConfig: {
                mode: 'auto_import',
                format: 'mcp_json',
              },
            },
          },
          {
            id: 'hermes-cli',
            name: 'Hermes CLI',
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
          },
        ],
      }),
    )

    expect(html).toContain('Hermes MCP Config')
    expect(html).toContain('Manual MCP setup required for Hermes CLI')
    expect(html).toContain('mcp_servers:')
    expect(html).toContain('mesh_test')
    expect(html).toContain('hermes config path')
    expect(html).toContain('Start a fresh CLI session after editing config.')
    expect(html).not.toContain('mcpServers')
    expect(html).not.toContain('Claude')
  })
})

describe('RepoMesh node active assignment helpers', () => {
  it('selects assigned queue entries for the node and produces a concise UI label', () => {
    const assignments = getNodeActiveAssignments(
      { id: 'node-a', workspace: '/repo/worktree-a', userOverrides: {}, policy: {} } as any,
      [
        { id: 'task-1', status: 'assigned', message: 'Fix queue lifecycle', assignedNodeId: 'node-a', assignedSessionId: 'session-a' },
        { id: 'task-2', status: 'pending', message: 'Pending', targetNodeId: 'node-a' },
        { id: 'task-3', status: 'assigned', message: 'Other node', assignedNodeId: 'node-b', assignedSessionId: 'session-b' },
      ] as any,
    )

    expect(assignments).toHaveLength(1)
    expect(assignments[0].id).toBe('task-1')
    expect(describeNodeActiveAssignmentLabel(assignments[0])).toContain('session-a')
    expect(describeNodeActiveAssignmentLabel(assignments[0])).toContain('Fix queue lifecycle')
  })
})
