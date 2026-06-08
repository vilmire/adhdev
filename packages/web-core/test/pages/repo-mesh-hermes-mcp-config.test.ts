import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RepoMeshHermesMcpConfig, getNodeActiveAssignments, describeNodeActiveAssignmentLabel } from '../../src/pages/RepoMesh'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

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

describe('RepoMesh graph detail affordances', () => {
  it('routes standalone Repo Mesh through the shared observability surface with live daemon wiring', () => {
    const source = readSource('pages/RepoMesh.tsx')

    expect(source).toContain('extractRepoMeshStatus(res)')
    expect(source).toContain('useMeshGraphMetadataSubscription({')
    expect(source).toContain('sendData,')
    expect(source).toContain('status: meshGraphStatus')
    expect(source).toContain('status={displayedMeshGraphStatus}')
    expect(source).toContain('<MeshObservabilitySurface')
    expect(source).toContain('daemonId={daemonId}')
    expect(source).toContain('sendDaemonCommand={sendCommand}')
    expect(source).toContain('queue activity, sessions, node drift, and mesh topology from this standalone daemon')
  })

  it('preserves provider priority when provider inventory is unavailable and marks worktree-local policy', () => {
    const source = readSource('pages/RepoMesh.tsx')

    expect(source).toContain('const requestedPriority = nodeProviderPriorityDrafts[node.id] || readNodeProviderPriority(node)')
    expect(source).toContain('availableCliProviders.length > 0')
    expect(source).toContain('normalizeProviderPriority(requestedPriority)')
    expect(source).toContain('providerPriority,')
    expect(source).toContain('function isWorktreeNode(node: MeshNode): boolean')
    expect(source).toContain('Provider priority saved here is node-local and disappears when this worktree node is removed.')
  })
})
