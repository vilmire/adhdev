import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { LOG } from '../logging/logger.js'
import type {
  MeshCoordinatorMcpConfigFormat,
  MeshCoordinatorSystemPromptInjection,
  ProviderModule,
} from '../providers/contracts.js'

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

/**
 * Apply a provider's declared system-prompt injection rule, mutating `cliArgs`
 * and `launchEnv` in place and writing any required workspace context file.
 *
 * Replaces the previous hard-coded `if (cliType === 'claude-cli') ... else if
 * (cliType === 'hermes-cli') ...` branches in router.ts. Adding a new CLI is
 * now provider.v1.json data, not a router edit.
 *
 * Failures are non-fatal: log and continue with whatever was applied so the
 * coordinator session still launches, just without the prompt for that
 * provider. A missing/unknown rule means "skip injection" — safe by default
 * (the previous fallback unconditionally pushed --append-system-prompt onto
 * every non-Claude CLI, which crashed agy on launch).
 */
export function applyMeshCoordinatorSystemPromptInjection(
  systemPrompt: string,
  injection: MeshCoordinatorSystemPromptInjection | undefined,
  ctx: { cliArgs: string[]; launchEnv: Record<string, string>; workspace: string; cliType: string },
): void {
  if (!systemPrompt || !injection) return
  applyInjectionRule(systemPrompt, injection, ctx)
}

function applyInjectionRule(
  systemPrompt: string,
  injection: MeshCoordinatorSystemPromptInjection,
  ctx: { cliArgs: string[]; launchEnv: Record<string, string>; workspace: string; cliType: string },
): void {
  switch (injection.mode) {
    case 'cli_arg': {
      if (!injection.flag) return
      ctx.cliArgs.push(injection.flag, systemPrompt)
      return
    }
    case 'config_override': {
      if (!injection.flag || !injection.template) return
      const rendered = injection.template
        .replace(/\{prompt_json\}/g, JSON.stringify(systemPrompt))
        .replace(/\{prompt\}/g, systemPrompt)
      ctx.cliArgs.push(injection.flag, rendered)
      return
    }
    case 'env_var': {
      if (!injection.name) return
      ctx.launchEnv[injection.name] = systemPrompt
      return
    }
    case 'context_file': {
      if (!injection.path) return
      const target = isAbsolute(injection.path)
        ? injection.path
        : join(ctx.workspace, injection.path)
      const wrapper = injection.wrapper && injection.wrapper.includes('{prompt}')
        ? injection.wrapper
        : '{prompt}'
      // Prepend a short managed-by hint inside the wrapper block so a user
      // opening AGENTS.md / GEMINI.md immediately understands the block is
      // auto-regenerated by the daemon on every coordinator launch. The hint
      // sits between the opening sentinel and the prompt body, so the stable
      // sentinels declared in provider.v1.json are untouched and the
      // idempotent replace regex above still matches on relaunches.
      const managedNote =
        '> _Managed by adhdev mesh coordinator — do not hand-edit this block. ' +
        'Changes inside the sentinels are overwritten on next coordinator launch._'
      const promptWithNote = `${managedNote}\n\n${systemPrompt}`
      const rendered = wrapper.replace(/\{prompt\}/g, promptWithNote)
      // If the wrapper has a stable opening sentinel, treat everything up to
      // the matching closing sentinel as our previously-written block and
      // replace it. Otherwise just append. The marker is the first non-
      // placeholder line of the wrapper; this keeps relaunches idempotent
      // without forcing spec authors to declare an explicit marker.
      const sentinel = wrapper.split('{prompt}')[0].trim()
      try {
        if (existsSync(target)) {
          const existing = readFileSync(target, 'utf-8')
          if (sentinel && existing.includes(sentinel)) {
            const closing = wrapper.split('{prompt}')[1]?.trim()
            const safeOpen = sentinel.replace(/[.+^${}()|[\]\\]/g, '\\$&')
            const safeClose = closing
              ? closing.replace(/[.+^${}()|[\]\\]/g, '\\$&')
              : ''
            const re = closing
              ? new RegExp(`${safeOpen}[\\s\\S]*?${safeClose}`, 'g')
              : new RegExp(`${safeOpen}[\\s\\S]*$`, 'g')
            writeFileSync(target, existing.replace(re, rendered), 'utf-8')
          } else {
            writeFileSync(target, `${existing}\n\n${rendered}`, 'utf-8')
          }
        } else {
          writeFileSync(target, rendered, 'utf-8')
        }
        LOG.info('MeshCoordinator', `Wrote coordinator prompt to ${target} (${ctx.cliType})`)
      } catch (error: any) {
        LOG.warn('MeshCoordinator', `Could not write ${target}: ${error?.message || error}`)
      }
      return
    }
    default:
      // Unknown future mode — skip silently. Adding the new mode is a spec-
      // language extension, not a runtime crash.
      return
  }
}

export interface PtyExecResult {
  exitCode: number | null
  signal: number | null
  output: string
  timedOut: boolean
}

/**
 * Run a one-shot CLI command under a real PTY and collect its output.
 *
 * Some provider mcp-registration commands (`agy mcp add`, future bubbletea
 * TUIs) refuse to run without `/dev/tty`. Daemon-side `execFileSync` runs
 * pipe-only, so those commands fail with errors like
 *   `bubbletea: error opening TTY: open /dev/tty: device not configured`
 * and silently skip the registration, leaving the launched session
 * without the adhdev-mesh MCP tools — which is exactly what we saw with
 * agy coordinators.
 *
 * Wrapping the registration through node-pty gives the child a real PTY,
 * so the bubbletea check passes. We close stdin immediately and just
 * collect stdout until the process exits or the timeout fires.
 */
export async function execUnderPty(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<PtyExecResult> {
  let ptyLib: any
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyLib = require('node-pty')
  } catch (error: any) {
    throw new Error(`node-pty is not available: ${error?.message || error}`)
  }
  const env = { ...(options.env ?? (process.env as Record<string, string>)), TERM: 'xterm-256color' }
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 20_000
  return new Promise<PtyExecResult>((resolveResult) => {
    let child: any
    try {
      child = ptyLib.spawn(command, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: options.cwd ?? process.cwd(),
        env,
      })
    } catch (error: any) {
      resolveResult({ exitCode: null, signal: null, output: String(error?.message || error), timedOut: false })
      return
    }
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolveResult({ exitCode: null, signal: null, output: buffer, timedOut: true })
    }, timeoutMs)
    child.onData((chunk: string) => {
      buffer += chunk
      if (buffer.length > 256 * 1024) {
        buffer = buffer.slice(-128 * 1024)
      }
    })
    child.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({ exitCode, signal: signal ?? null, output: buffer, timedOut: false })
    })
  })
}
