import { join } from 'path'
import type { ProviderModule, MeshCoordinatorMcpConfigFormat } from '../providers/contracts.js'

export type MeshCoordinatorSetup =
  | {
      kind: 'auto_import'
      serverName: string
      configPath: string
      configFormat?: MeshCoordinatorMcpConfigFormat
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
      kind: 'unsupported'
      reason: string
    }

export interface ResolveMeshCoordinatorSetupOptions {
  provider?: ProviderModule | null
  meshId: string
  workspace: string
  adhdevMcpCommand?: string
}

const DEFAULT_SERVER_NAME = 'adhdev-mesh'
const DEFAULT_ADHDEV_MCP_COMMAND = 'adhdev-mcp'

export function resolveMeshCoordinatorSetup(options: ResolveMeshCoordinatorSetupOptions): MeshCoordinatorSetup {
  const { provider, meshId, workspace } = options
  const config = provider?.meshCoordinator
  if (!config?.supported) {
    return {
      kind: 'unsupported',
      reason: config?.reason || 'Provider does not declare Repo Mesh coordinator support',
    }
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
    return {
      kind: 'auto_import',
      serverName,
      configPath: join(workspace, path),
      configFormat: mcpConfig.format,
    }
  }

  if (mcpConfig.mode === 'manual') {
    const instructions = mcpConfig.instructions?.trim()
    const template = mcpConfig.template
    if (!instructions || !template?.trim()) {
      return { kind: 'unsupported', reason: 'Provider manual MCP setup is missing instructions or template' }
    }
    return {
      kind: 'manual',
      serverName,
      configFormat: mcpConfig.format,
      configPathCommand: mcpConfig.configPathCommand,
      requiresRestart: mcpConfig.requiresRestart === true,
      instructions,
      template: renderMeshCoordinatorTemplate(template, {
        meshId,
        workspace,
        serverName,
        adhdevMcpCommand: options.adhdevMcpCommand || DEFAULT_ADHDEV_MCP_COMMAND,
      }),
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
