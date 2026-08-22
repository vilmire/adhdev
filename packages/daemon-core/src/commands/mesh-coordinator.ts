import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { LOG } from '../logging/logger.js'
import { shortHash } from '../system/hash.js'
import { IDENTITY } from '../track-identity.js'
import { inspectEmbeddedPath, type EmbeddedPathHealth, type EmbeddedPathState } from '../config/embedded-path-health.js'
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
      mcpServer: MeshCoordinatorMcpServerLaunch
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
// Track-scoped binary ('adhdev' stable / 'adhdev-preview' preview). Hardcoding
// 'adhdev' made every PREVIEW install generate a coordinator MCP config that
// launches the STABLE binary, which then connects to the stable daemon's IPC —
// so preview coordinators either failed to start or drove the wrong daemon.
const DEFAULT_ADHDEV_MCP_COMMAND = IDENTITY.binaryName
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
    adhdevMcpEntryPath: options.adhdevMcpEntryPath,
    nodeExecutable: options.nodeExecutable,
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
      adhdevMcpEntryPath: options.adhdevMcpEntryPath,
      nodeExecutable: options.nodeExecutable,
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
    const mcpServer = resolveAdhdevMcpServerLaunch({
      meshId,
      adhdevMcpCommand: options.adhdevMcpCommand,
      adhdevMcpEntryPath: options.adhdevMcpEntryPath,
      nodeExecutable: options.nodeExecutable,
      adhdevMcpTransport: options.adhdevMcpTransport,
      adhdevMcpPort: options.adhdevMcpPort,
    })
    if (!mcpServer) {
      return {
        kind: 'unsupported',
        reason: 'Could not resolve the ADHDev MCP server entrypoint and transport arguments',
      }
    }
    let renderedTemplate = renderMeshCoordinatorTemplate(template, {
      meshId,
      workspace,
      serverName,
      adhdevMcpCommand: mcpServer.command,
      adhdevMcpArgs: mcpServer.args.join(' '),
    })
    // Detect if the template is a runnable CLI command (single line, no YAML/JSON structure).
    // If so, use cli_command kind so the daemon can execute it automatically.
    const isCliCommand = !renderedTemplate.trim().includes('\n') && !renderedTemplate.trim().startsWith('{')
    if (isCliCommand) {
      if (!/\{\{\s*adhdevMcpArgs\s*\}\}/.test(template)) {
        renderedTemplate = replaceLegacyCliCommandMcpArgs(renderedTemplate, mcpServer.args)
      }
      return {
        kind: 'cli_command',
        serverName,
        command: renderedTemplate.trim(),
        requiresRestart: mcpConfig.requiresRestart === true,
        instructions: instructions,
        mcpServer,
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
  return template.replace(/\{\{\s*(meshId|workspace|serverName|adhdevMcpCommand|adhdevMcpArgs)\s*\}\}/g, (_, key: string) => values[key] || '')
}

function replaceLegacyCliCommandMcpArgs(command: string, args: string[]): string {
  return command.replace(
    /\bmcp\s+--mode\s+(?:ipc|local)\s+--repo-mesh\s+\S+(?:\s+--port\s+\d+)?\s*$/,
    args.join(' '),
  )
}

function resolveHermesCoordinatorHome(meshId: string, workspace: string): string {
  const key = `${meshId || 'mesh'}\n${resolve(workspace || os.tmpdir())}`
  const hash = shortHash(key)
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
  adhdevMcpEntryPath?: string
  nodeExecutable?: string
  adhdevMcpTransport?: 'local' | 'ipc'
  adhdevMcpPort?: number
}): MeshCoordinatorMcpServerLaunch | null {
  const directEntryPath = resolveAdhdevMcpEntryPath(options.adhdevMcpEntryPath)
  if (directEntryPath) {
    const transport = resolveMcpTransport(options.adhdevMcpTransport)
    const args = [directEntryPath, '--mode', transport, '--repo-mesh', options.meshId]
    const port = resolveMcpPort(options.adhdevMcpPort)
    if (port !== undefined) args.push('--port', String(port))
    return {
      command: resolveNodeExecutable(options.nodeExecutable),
      args,
    }
  }

  const command = resolveAdhdevCommand(options.adhdevMcpCommand)
  const transport = resolveMcpTransport(options.adhdevMcpTransport)
  const directMcpEntrypoint = basename(command).startsWith('adhdev-mcp')
    || command.includes('/vendor/mcp-server/')
    || command.includes('\\vendor\\mcp-server\\')
  const args = [...(directMcpEntrypoint ? [] : ['mcp']), '--mode', transport, '--repo-mesh', options.meshId]
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

export interface MeshCoordinatorMcpServerPathHealth {
  /** Same three-state vocabulary as config/embedded-path-health. */
  state: EmbeddedPathState
  /** The embedded absolute path that drove `state`, else null. */
  referencedPath: string | null
  volatile: boolean
  volatileReason: string | null
  /** Actionable one-liner for logs and launch results; null when healthy. */
  warning: string | null
}

/**
 * Health of the absolute paths a coordinator MCP setup embeds into a config
 * file the provider CLI owns (`.mcp.json` / `.cursor/mcp.json` /
 * `opencode.json` / hermes `config.yaml` / — via `codex mcp add` —
 * `~/.codex/config.toml`).
 *
 * Detection-only counterpart of the statusline fix
 * (`config/embedded-path-health.ts`): the written config must OUTLIVE the
 * launch — a coordinator restarted after a reboot still needs the entry — so
 * teardown is intentionally absent and the failure class to catch is a
 * reference that is ALREADY dangling (`missing`) or that lives somewhere the
 * OS or worktree cleanup will reap (`volatile`): works today, dangles later,
 * exactly the 2026-08-20 statusline accident. A bare PATH command
 * (`adhdev mcp …`) embeds no absolute path and reports `absent`.
 */
export function inspectMeshCoordinatorMcpServerPaths(
  mcpServer: MeshCoordinatorMcpServerLaunch,
  options: {
    env?: NodeJS.ProcessEnv
    serverName?: string
    /** What is being written, e.g. "MCP config /repo/.mcp.json". */
    target?: string
    /** True when the target file lives inside the repo and may be committed. */
    repoLocal?: boolean
  } = {},
): MeshCoordinatorMcpServerPathHealth {
  const embeddedPaths = [mcpServer.command, ...mcpServer.args].filter((value) => isAbsolute(value))
  if (embeddedPaths.length === 0) {
    return { state: 'absent', referencedPath: null, volatile: false, volatileReason: null, warning: null }
  }
  let firstMissing: EmbeddedPathHealth | null = null
  let firstVolatile: EmbeddedPathHealth | null = null
  for (const embeddedPath of embeddedPaths) {
    const health = inspectEmbeddedPath(embeddedPath, options.env ?? process.env)
    if (health.state === 'missing' && !firstMissing) firstMissing = health
    if (health.volatile && !firstVolatile) firstVolatile = health
  }
  const serverName = options.serverName?.trim() || 'adhdev-mesh'
  const target = options.target?.trim() || `MCP setup for ${serverName}`
  const propagationNote = options.repoLocal
    ? ' The config file lives inside the workspace and may be committed — this machine-specific absolute path would propagate to teammates\' machines, where it matches nothing.'
    : ''
  if (firstMissing) {
    return {
      state: 'missing',
      referencedPath: firstMissing.referencedPath,
      volatile: firstMissing.volatile || Boolean(firstVolatile),
      volatileReason: firstMissing.volatileReason || firstVolatile?.volatileReason || null,
      warning: `${target} embeds ${firstMissing.referencedPath}, which does not exist on this machine — the ${serverName} MCP server will fail to start (dangling reference, the statusline failure class).${propagationNote}`,
    }
  }
  if (firstVolatile) {
    return {
      state: 'ok',
      referencedPath: firstVolatile.referencedPath,
      volatile: true,
      volatileReason: firstVolatile.volatileReason,
      warning: `${target} embeds ${firstVolatile.referencedPath}, which is ${firstVolatile.volatileReason}. It works today, but the ${serverName} entry will dangle once that location is cleaned up — the same failure class as the 2026-08-20 statusline incident.${propagationNote}`,
    }
  }
  return { state: 'ok', referencedPath: embeddedPaths[0], volatile: false, volatileReason: null, warning: null }
}

function resolveAdhdevMcpEntryPath(explicitEntryPath?: string): string | null {
  const entryPath = explicitEntryPath?.trim() || process.env.ADHDEV_COORDINATOR_MCP_ENTRY_PATH?.trim()
  return entryPath || null
}

function resolveNodeExecutable(explicitNodeExecutable?: string): string {
  return explicitNodeExecutable?.trim()
    || process.env.ADHDEV_COORDINATOR_NODE_EXECUTABLE?.trim()
    || process.execPath
}

function resolveMcpTransport(explicitTransport?: 'local' | 'ipc'): 'local' | 'ipc' {
  if (explicitTransport === 'local' || explicitTransport === 'ipc') return explicitTransport
  const envTransport = process.env.ADHDEV_COORDINATOR_MCP_TRANSPORT?.trim()
  return envTransport === 'local' ? 'local' : 'ipc'
}

/**
 * Resolve the IPC port to stamp into the generated MCP args.
 *
 * Falls back to the track default (19222 stable / 19223 preview) rather than
 * `undefined`. Returning undefined omitted `--port` entirely, leaving the
 * mcp-server to apply its own default — which is how a preview coordinator
 * ended up driving the stable daemon. Stamping the port explicitly makes the
 * generated config self-describing instead of track-ambiguous.
 */
function resolveMcpPort(explicitPort?: number): number | undefined {
  if (typeof explicitPort === 'number' && Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort
  const raw = process.env.ADHDEV_COORDINATOR_MCP_PORT?.trim()
  if (raw) {
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return IDENTITY.defaultPort
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
export interface CoordinatorInjectionEffect {
  /** Absolute path the daemon wrote a wrapper-blocked file to. Only set for
   *  context_file injection. R48 schedules a strip after launch so workers
   *  don't see the wrapper on disk; R47's unregister cleanup uses it as a
   *  fallback if the timer never fires (process crash, etc). */
  contextFilePath?: string
  /** context_file with owned:true — cleanup deletes the whole file rather
   *  than stripping the wrapper block (daemon-named file, no user content). */
  contextFileOwned?: boolean
  /** Absolute path of the daemon-owned temp agent file. Only set for
   *  agent_file injection. The CLI reads it once at startup, so the launch
   *  path schedules a delete after the spawn settles; leftovers in the temp
   *  dir are harmless (OS-reaped) but we still best-effort clean up. */
  agentFilePath?: string
}

export function applyMeshCoordinatorSystemPromptInjection(
  systemPrompt: string,
  injection: MeshCoordinatorSystemPromptInjection | undefined,
  ctx: { cliArgs: string[]; launchEnv: Record<string, string>; workspace: string; cliType: string },
): CoordinatorInjectionEffect {
  if (!systemPrompt || !injection) return {}
  return applyInjectionRule(systemPrompt, injection, ctx)
}

function applyInjectionRule(
  systemPrompt: string,
  injection: MeshCoordinatorSystemPromptInjection,
  ctx: { cliArgs: string[]; launchEnv: Record<string, string>; workspace: string; cliType: string },
): CoordinatorInjectionEffect {
  switch (injection.mode) {
    case 'cli_arg': {
      if (!injection.flag) return {}
      ctx.cliArgs.push(injection.flag, systemPrompt)
      return {}
    }
    case 'config_override': {
      if (!injection.flag || !injection.template) return {}
      const rendered = injection.template
        .replace(/\{prompt_json\}/g, JSON.stringify(systemPrompt))
        .replace(/\{prompt\}/g, systemPrompt)
      ctx.cliArgs.push(injection.flag, rendered)
      return {}
    }
    case 'env_var': {
      if (!injection.name) return {}
      ctx.launchEnv[injection.name] = systemPrompt
      return {}
    }
    case 'agent_file': {
      if (!injection.flag) return {}
      const template = injection.template && injection.template.includes('{prompt}')
        ? injection.template
        : '{prompt}'
      const body = template.replace(/\{prompt\}/g, systemPrompt)
      try {
        const dir = mkdtempSync(join(os.tmpdir(), `adhdev-coord-${ctx.cliType}-`))
        const filePath = join(dir, 'coordinator-agent.md')
        writeFileSync(filePath, body, 'utf-8')
        ctx.cliArgs.push(injection.flag, filePath)
        LOG.info('MeshCoordinator', `Wrote coordinator agent file to ${filePath} (${ctx.cliType})`)
        return { agentFilePath: filePath }
      } catch (error: any) {
        LOG.warn('MeshCoordinator', `Could not write coordinator agent file: ${error?.message || error}`)
        return {}
      }
    }
    case 'context_file': {
      if (!injection.path) return {}
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
        // The declared path may live in a subdirectory the workspace doesn't
        // have yet (e.g. cursor's `.cursor/rules/*.mdc`) — create parents.
        mkdirSync(dirname(target), { recursive: true })
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
        return { contextFilePath: target, contextFileOwned: injection.owned === true }
      } catch (error: any) {
        LOG.warn('MeshCoordinator', `Could not write ${target}: ${error?.message || error}`)
        return {}
      }
    }
    default:
      // Unknown future mode — skip silently. Adding the new mode is a spec-
      // language extension, not a runtime crash.
      return {}
  }
}

/**
 * Strip the daemon's wrapper block from a context_file we previously wrote.
 *
 * Used in two places:
 *   1. R48 inject-then-remove: ~5s after spawn, after agy/gemini have read
 *      the file into their in-memory system-prompt cache. Removing it from
 *      disk at that point doesn't affect the running coordinator but keeps
 *      worker sessions (or fresh non-coordinator launches) in the same
 *      workspace from picking up our wrapper.
 *   2. R47 unregister fallback: if the timer never fires (process crash,
 *      kill -9), coordinator-registry.unregisterMeshCoordinator runs the
 *      same logic when its entry is dropped.
 *
 * Idempotent: missing file is fine, missing sentinels are fine, returns
 * silently. Leaves user-authored content outside the sentinels intact.
 * Deletes the file outright if our wrapper was the only content.
 */
export function stripCoordinatorWrapperFile(filePath: string, owned = false): void {
  const OPEN = '<!-- adhdev-mesh-coordinator-prompt -->'
  const CLOSE = '<!-- /adhdev-mesh-coordinator-prompt -->'
  try {
    if (!existsSync(filePath)) return
    // Daemon-owned whole file (dedicated name, e.g. cursor's rules .mdc) —
    // delete outright instead of stripping sentinels out of user content.
    if (owned) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs')
        fs.unlinkSync(filePath)
      } catch { /* best-effort */ }
      return
    }
    const existing = readFileSync(filePath, 'utf-8')
    const openIdx = existing.indexOf(OPEN)
    if (openIdx < 0) return
    const closeIdx = existing.indexOf(CLOSE, openIdx)
    if (closeIdx < 0) return
    const remaining = (existing.slice(0, openIdx) + existing.slice(closeIdx + CLOSE.length))
      .replace(/^\s*\n+/, '')
      .replace(/\n+\s*$/, '')
    if (!remaining.trim()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs')
        fs.unlinkSync(filePath)
      } catch { /* best-effort */ }
    } else {
      writeFileSync(filePath, remaining + '\n', 'utf-8')
    }
  } catch { /* best-effort */ }
}

/**
 * Delete a daemon-owned temp agent file written by agent_file injection,
 * together with the mkdtemp directory that holds it. The CLI (kimi
 * --agent-file) reads the file exactly once at startup and binds the agent
 * to the session, so after the spawn settles the file is dead weight.
 * Idempotent and best-effort: leftovers in os.tmpdir() are harmless.
 */
export function cleanupCoordinatorAgentFile(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    rmSync(dirname(filePath), { recursive: true, force: true })
  } catch { /* best-effort */ }
}

export interface PtyExecResult {
  exitCode: number | null
  signal: number | null
  output: string
  timedOut: boolean
}

export interface MeshCoordinatorRegistrationStep {
  command: string
  args: string[]
  required: boolean
  label: 'remove_existing' | 'register'
}

/**
 * Codex rejects `mcp add` when a server with the same name already exists.
 * Replace that entry before registering so transport/mesh changes do not leave
 * a fresh coordinator attached to stale MCP launch arguments.
 */
export function buildMeshCoordinatorRegistrationPlan(
  cliType: string,
  serverName: string,
  registrationCommand: string,
): MeshCoordinatorRegistrationStep[] {
  const commandParts = registrationCommand.trim().split(/\s+/).filter(Boolean)
  const [command, ...args] = commandParts
  if (!command) return []

  const register: MeshCoordinatorRegistrationStep = {
    command,
    args,
    required: true,
    label: 'register',
  }
  if (
    cliType === 'codex-cli'
    && basename(command) === 'codex'
    && args[0] === 'mcp'
    && args[1] === 'add'
  ) {
    return [
      {
        command,
        args: ['mcp', 'remove', serverName],
        required: false,
        label: 'remove_existing',
      },
      register,
    ]
  }
  return [register]
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
        cols: DEFAULT_SESSION_HOST_COLS,
        rows: DEFAULT_SESSION_HOST_ROWS,
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
