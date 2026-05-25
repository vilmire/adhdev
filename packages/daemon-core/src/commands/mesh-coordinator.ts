import { createHash } from 'node:crypto'
import * as os from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { ProviderModule, MeshCoordinatorMcpConfigFormat } from '../providers/contracts.js'

export interface MeshCoordinatorMcpServerLaunch {
  command: string
  args: string[]
}

export type MeshCoordinatorSetup =
  | {
      kind: 'auto_import'
      serverName: string
      configPath: string
      configFormat?: MeshCoordinatorMcpConfigFormat
      mcpServer: MeshCoordinatorMcpServerLaunch
    }
  | {
      kind: 'manual'
      serverName: string
      configFormat?: MeshCoordinatorMcpConfigFormat
      configPathCommand?: string
      requiresRestart: boolean
      instructions: string
      template: string
    }
  | {
      /** Provider registers MCP via its own CLI command (e.g. `codex mcp add` / `gemini mcp add`). */
      kind: 'cli_command'
      serverName: string
      /** The rendered shell command to execute before launching the coordinator session. */
      command: string
      requiresRestart: boolean
      instructions: string
    }
  | {
      kind: 'unsupported'
      reason: string
    }

export interface ResolveMeshCoordinatorSetupOptions {
  provider?: ProviderModule | null
  cliType?: string
  meshId: string
  workspace: string
  adhdevMcpCommand?: string
  adhdevMcpEntryPath?: string
  nodeExecutable?: string
  adhdevMcpTransport?: 'local' | 'ipc'
  adhdevMcpPort?: number
}

const DEFAULT_SERVER_NAME = 'adhdev-mesh'
const DEFAULT_ADHDEV_MCP_COMMAND = 'adhdev'
const HERMES_CLI_TYPE = 'hermes-cli'
const HERMES_MCP_CONFIG_PATH = '~/.hermes/config.yaml'

function isHermesProvider(provider: ProviderModule | null | undefined, cliType?: string): boolean {
  const type = cliType?.trim() || provider?.type?.trim() || ''
  return type === HERMES_CLI_TYPE
}

function resolveHermesMeshCoordinatorSetup(options: ResolveMeshCoordinatorSetupOptions): MeshCoordinatorSetup {
  const mcpServer = resolveAdhdevMcpServerLaunch({
    meshId: options.meshId,
    adhdevMcpCommand: options.adhdevMcpCommand,
    adhdevMcpTransport: options.adhdevMcpTransport,
    adhdevMcpPort: options.adhdevMcpPort,
  })
  if (!mcpServer) {
    return {
      kind: 'unsupported',
      reason: 'Could not resolve the ADHDev MCP server entrypoint and a Node runtime with WebSocket support for daemon IPC mode',
    }
  }
  const configPath = join(resolveHermesCoordinatorHome(options.meshId, options.workspace), 'config.yaml')
  if (!configPath.trim()) {
    return createHermesManualMeshCoordinatorSetup(options.meshId, options.workspace)
  }
  return {
    kind: 'auto_import',
    serverName: DEFAULT_SERVER_NAME,
    configPath,
    configFormat: 'hermes_config_yaml',
    mcpServer,
  }
}

export function createHermesManualMeshCoordinatorSetup(meshId: string, workspace: string): MeshCoordinatorSetup {
  return {
    kind: 'manual',
    serverName: DEFAULT_SERVER_NAME,
    configFormat: 'hermes_config_yaml',
    configPathCommand: HERMES_MCP_CONFIG_PATH,
    requiresRestart: true,
    instructions: 'Hermes CLI does not auto-import repo-local .mcp.json. Add this MCP server to Hermes config under mcp_servers, then start a fresh Hermes session.',
    template: renderMeshCoordinatorTemplate(
      'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - mcp\n      - --mode\n      - ipc\n      - --repo-mesh\n      - {{meshId}}\n    enabled: true\n',
      {
        meshId,
        workspace,
        serverName: DEFAULT_SERVER_NAME,
        adhdevMcpCommand: DEFAULT_ADHDEV_MCP_COMMAND,
      },
    ),
  }
}

export function resolveMeshCoordinatorSetup(options: ResolveMeshCoordinatorSetupOptions): MeshCoordinatorSetup {
  const { provider, meshId, workspace } = options
  const config = provider?.meshCoordinator
  if (!config?.supported) {
    return {
      kind: 'unsupported',
      reason: config?.reason || 'Provider does not declare Repo Mesh coordinator support',
    }
  }

  if (isHermesProvider(provider, options.cliType)) {
    return resolveHermesMeshCoordinatorSetup(options)
  }

  const mcpConfig = config.mcpConfig
  if (!mcpConfig || mcpConfig.mode === 'none') {
    return {
      kind: 'unsupported',
      reason: config.reason || 'Provider does not declare a usable Repo Mesh MCP configuration mode',
    }
  }

  const serverName = mcpConfig.serverName?.trim() || DEFAULT_SERVER_NAME
  if (mcpConfig.mode === 'auto_import') {
    const path = mcpConfig.path?.trim()
    if (!path) {
      return { kind: 'unsupported', reason: 'Provider auto-import MCP config is missing a config path' }
    }
    const mcpServer = resolveAdhdevMcpServerLaunch({
      meshId,
      adhdevMcpCommand: options.adhdevMcpCommand,
      adhdevMcpTransport: options.adhdevMcpTransport,
      adhdevMcpPort: options.adhdevMcpPort,
    })
    if (!mcpServer) {
      return {
        kind: 'unsupported',
        reason: 'Could not resolve the ADHDev MCP server entrypoint and a Node runtime with WebSocket support for daemon IPC mode',
      }
    }
    return {
      kind: 'auto_import',
      serverName,
      configPath: resolveMcpConfigPath(path, workspace),
      configFormat: mcpConfig.format,
      mcpServer,
    }
  }

  if (mcpConfig.mode === 'manual') {
    const instructions = mcpConfig.instructions?.trim()
    const template = mcpConfig.template
    if (!instructions || !template?.trim()) {
      return { kind: 'unsupported', reason: 'Provider manual MCP setup is missing instructions or template' }
    }
    const renderedTemplate = renderMeshCoordinatorTemplate(template, {
      meshId,
      workspace,
      serverName,
      adhdevMcpCommand: options.adhdevMcpCommand || DEFAULT_ADHDEV_MCP_COMMAND,
    })
    // Detect if the template is a runnable CLI command (single line, no YAML/JSON structure).
    // If so, use cli_command kind so the daemon can execute it automatically.
    const isCliCommand = !renderedTemplate.trim().includes('\n') && !renderedTemplate.trim().startsWith('{')
    if (isCliCommand) {
      return {
        kind: 'cli_command',
        serverName,
        command: renderedTemplate.trim(),
        requiresRestart: mcpConfig.requiresRestart === true,
        instructions: instructions,
      }
    }
    return {
      kind: 'manual',
      serverName,
      configFormat: mcpConfig.format,
      configPathCommand: mcpConfig.configPathCommand,
      requiresRestart: mcpConfig.requiresRestart === true,
      instructions,
      template: renderedTemplate,
    }
  }

  return {
    kind: 'unsupported',
    reason: `Unsupported Repo Mesh MCP configuration mode: ${String(mcpConfig.mode)}`,
  }
}

function renderMeshCoordinatorTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(meshId|workspace|serverName|adhdevMcpCommand)\s*\}\}/g, (_, key: string) => values[key] || '')
}

function resolveHermesCoordinatorHome(meshId: string, workspace: string): string {
  const key = `${meshId || 'mesh'}\n${resolve(workspace || os.tmpdir())}`
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(os.tmpdir(), `adhdev-hermes-mesh-coordinator-${hash}`)
}

function resolveMcpConfigPath(configPath: string, workspace: string): string {
  const trimmed = configPath.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return join(os.homedir(), trimmed.slice(2))
  if (isAbsolute(trimmed)) return trimmed
  return join(workspace, trimmed)
}

function resolveAdhdevMcpServerLaunch(options: {
  meshId: string
  adhdevMcpCommand?: string
  adhdevMcpTransport?: 'local' | 'ipc'
  adhdevMcpPort?: number
}): MeshCoordinatorMcpServerLaunch | null {
  const command = resolveAdhdevCommand(options.adhdevMcpCommand)
  const transport = resolveMcpTransport(options.adhdevMcpTransport)
  const args = ['mcp', '--mode', transport, '--repo-mesh', options.meshId]
  const port = resolveMcpPort(options.adhdevMcpPort)
  if (port !== undefined) args.push('--port', String(port))
  return {
    command,
    args,
  }
}

function resolveAdhdevCommand(explicitCommand?: string): string {
  return explicitCommand?.trim() || process.env.ADHDEV_COORDINATOR_MCP_COMMAND?.trim() || DEFAULT_ADHDEV_MCP_COMMAND
}

function resolveMcpTransport(explicitTransport?: 'local' | 'ipc'): 'local' | 'ipc' {
  if (explicitTransport === 'local' || explicitTransport === 'ipc') return explicitTransport
  const envTransport = process.env.ADHDEV_COORDINATOR_MCP_TRANSPORT?.trim()
  return envTransport === 'local' ? 'local' : 'ipc'
}

function resolveMcpPort(explicitPort?: number): number | undefined {
  if (typeof explicitPort === 'number' && Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort
  const raw = process.env.ADHDEV_COORDINATOR_MCP_PORT?.trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
