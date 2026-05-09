import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
}

const DEFAULT_SERVER_NAME = 'adhdev-mesh'
const DEFAULT_ADHDEV_MCP_COMMAND = 'adhdev-mcp'
const HERMES_CLI_TYPE = 'hermes-cli'
const HERMES_MCP_CONFIG_PATH = '~/.hermes/config.yaml'

function isHermesProvider(provider: ProviderModule | null | undefined, cliType?: string): boolean {
  const type = cliType?.trim() || provider?.type?.trim() || ''
  return type === HERMES_CLI_TYPE
}

function resolveHermesMeshCoordinatorSetup(options: ResolveMeshCoordinatorSetupOptions): MeshCoordinatorSetup {
  const mcpServer = resolveAdhdevMcpServerLaunch({
    meshId: options.meshId,
    nodeExecutable: options.nodeExecutable,
    adhdevMcpEntryPath: options.adhdevMcpEntryPath,
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
      'mcp_servers:\n  {{serverName}}:\n    command: {{adhdevMcpCommand}}\n    args:\n      - --repo-mesh\n      - {{meshId}}\n    enabled: true\n',
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
      nodeExecutable: options.nodeExecutable,
      adhdevMcpEntryPath: options.adhdevMcpEntryPath,
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
  nodeExecutable?: string
  adhdevMcpEntryPath?: string
}): MeshCoordinatorMcpServerLaunch | null {
  const entryPath = resolveAdhdevMcpEntryPath(options.adhdevMcpEntryPath)
  if (!entryPath) return null
  const nodeExecutable = resolveMcpNodeExecutable(options.nodeExecutable)
  if (!nodeExecutable) return null
  return {
    command: nodeExecutable,
    args: [entryPath, '--mode', 'ipc', '--repo-mesh', options.meshId],
  }
}

function resolveMcpNodeExecutable(explicitExecutable?: string): string | null {
  const explicit = explicitExecutable?.trim()
  if (explicit) return explicit

  const candidates: string[] = []
  const addCandidate = (candidate?: string | null) => {
    const trimmed = candidate?.trim()
    if (!trimmed) return
    const normalized = normalizeExistingPath(trimmed) || trimmed
    if (!candidates.includes(normalized)) candidates.push(normalized)
  }

  addCandidate(process.env.ADHDEV_MCP_NODE_EXECUTABLE)
  addCandidate(process.env.ADHDEV_NODE_EXECUTABLE)
  addCandidate(process.env.npm_node_execpath)
  addNodeCandidatesFromPath(process.env.PATH, addCandidate)
  addNodeCandidatesFromNvm(os.homedir(), addCandidate)
  addCandidate('/opt/homebrew/bin/node')
  addCandidate('/usr/local/bin/node')
  addCandidate('/usr/bin/node')
  addCandidate(process.execPath)

  for (const candidate of candidates) {
    if (nodeRuntimeSupportsWebSocket(candidate)) return candidate
  }
  return null
}

function addNodeCandidatesFromPath(pathValue: string | undefined, addCandidate: (candidate?: string | null) => void) {
  for (const entry of (pathValue || '').split(':')) {
    const dir = entry.trim()
    if (!dir) continue
    addCandidate(join(dir, 'node'))
  }
}

function addNodeCandidatesFromNvm(homeDir: string, addCandidate: (candidate?: string | null) => void) {
  const versionsDir = join(homeDir, '.nvm', 'versions', 'node')
  try {
    const versionDirs = readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareNodeVersionNamesDescending)
    for (const versionDir of versionDirs) {
      addCandidate(join(versionsDir, versionDir, 'bin', 'node'))
    }
  } catch {
    // nvm is optional; PATH and process.execPath candidates still cover normal installs.
  }
}

function compareNodeVersionNamesDescending(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] || 0) - (left[i] || 0)
    if (diff !== 0) return diff
  }
  return b.localeCompare(a)
}

function nodeRuntimeSupportsWebSocket(nodeExecutable: string): boolean {
  try {
    execFileSync(nodeExecutable, ['-e', "process.exit(typeof WebSocket === 'function' ? 0 : 42)"], {
      stdio: 'ignore',
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}

function resolveAdhdevMcpEntryPath(explicitPath?: string): string | null {
  const explicit = explicitPath?.trim()
  if (explicit) return normalizeExistingPath(explicit) || explicit

  const envPath = process.env.ADHDEV_MCP_SERVER_PATH?.trim()
  if (envPath) return normalizeExistingPath(envPath) || envPath

  const candidates: string[] = []
  const addCandidate = (candidate: string) => {
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  const addPackagedCandidates = (baseFile?: string) => {
    if (!baseFile) return
    const realBase = normalizeExistingPath(baseFile) || baseFile
    const dir = dirname(realBase)
    addCandidate(resolve(dir, '../vendor/mcp-server/index.js'))
    addCandidate(resolve(dir, '../../vendor/mcp-server/index.js'))
    addCandidate(resolve(dir, '../../../vendor/mcp-server/index.js'))
    // Source checkout/dev mode does not vendor the MCP server into daemon-standalone.
    // Resolve the sibling workspace build directly so Repo Mesh auto-import still
    // writes an absolute Node entrypoint instead of falling back to a PATH bin shim.
    addCandidate(resolve(dir, '../../mcp-server/dist/index.js'))
    addCandidate(resolve(dir, '../../../mcp-server/dist/index.js'))
  }

  addPackagedCandidates(process.argv[1])

  for (const candidate of candidates) {
    const normalized = normalizeExistingPath(candidate)
    if (normalized) return normalized
  }

  try {
    const requireBase = process.argv[1] ? (normalizeExistingPath(process.argv[1]) || process.argv[1]) : join(process.cwd(), 'adhdev-daemon.js')
    const req = createRequire(requireBase)
    const resolvedModule = req.resolve('@adhdev/mcp-server')
    return normalizeExistingPath(resolvedModule) || resolvedModule
  } catch {
    return null
  }
}

function normalizeExistingPath(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null
    return realpathSync.native(filePath)
  } catch {
    return null
  }
}
