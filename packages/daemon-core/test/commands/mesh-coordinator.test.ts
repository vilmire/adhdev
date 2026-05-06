import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
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

  it('honors an explicit MCP Node override after verifying it can run WebSocket IPC', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mcp-node-runtime-'))
    const goodBin = join(root, 'good-bin')
    mkdirSync(goodBin, { recursive: true })
    const goodNode = join(goodBin, 'node')
    const mcpEntry = join(root, 'mcp-server.js')
    writeFileSync(goodNode, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, 'utf-8')
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
      nodes: [{ id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'daemon-source', policy: { canPush: true } }],
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

  it('writes Hermes MCP YAML config and launches Hermes with an ephemeral coordinator prompt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-hermes-coordinator-'))
    const configPath = join(workspace, 'hermes-config.yaml')
    const mcpEntry = join(workspace, 'mcp-server.js')
    writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
    writeFileSync(configPath, 'model:\n  provider: openrouter\nmcp_servers:\n  existing:\n    command: existing-server\n', 'utf-8')
    const previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
    process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry

    const provider: ProviderModule = {
      ...baseProvider,
      type: 'hermes-cli',
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'hermes_config_yaml',
          path: configPath,
          serverName: 'adhdev-mesh',
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
      expect(configText).toContain('mcp_servers:')
      expect(configText).toContain('existing:')
      expect(configText).toContain('adhdev-mesh:')
      expect(configText).toContain('ADHDEV_MCP_TRANSPORT: ipc')
      expect(configText).toContain('ADHDEV_INLINE_MESH:')
      expect(configText).toContain('mesh_hermes')
      expect(configText).not.toContain('mcpServers')

      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('launch_cli', expect.objectContaining({
        cliType: 'hermes-cli',
        dir: workspace,
        cliArgs: undefined,
        env: expect.objectContaining({
          HERMES_EPHEMERAL_SYSTEM_PROMPT: expect.stringContaining('Repo Mesh'),
        }),
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
