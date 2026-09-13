import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-manager'
import { applyPreLaunchTrust } from '../../src/providers/spec/pre-launch-trust'

// Every it() below creates its own mkdtempSync workspace inline (no shared
// beforeEach), so there is no single variable to hook an afterEach onto.
// Track every path created and sweep them all after each test instead —
// see the fix-testtmp-leak-provider-channel-fixtures task for why this file
// leaked ~13 adhdev-mesh-child-*/adhdev-gateoff-*/adhdev-gateon-* dirs per run.
const __tmpDirsToClean: string[] = []
afterEach(() => {
  while (__tmpDirsToClean.length > 0) {
    const dir = __tmpDirsToClean.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

const claudeIsolation = {
  args: [
    { mode: 'empty_mcp_config' as const, flag: '--mcp-config', strictFlag: '--strict-mcp-config' },
  ],
}

const codexIsolation = {
  workerMcpDelivery: {
    mode: 'config_override' as const,
    flag: '-c',
    serverName: 'adhdev-worker',
    commandTemplate: 'mcp_servers.{serverName}.command={command_json}',
    argsTemplate: 'mcp_servers.{serverName}.args={args_json}',
    envVarsTemplate: 'mcp_servers.{serverName}.env_vars={env_vars_json}',
    enabledTemplate: 'mcp_servers.{serverName}.enabled=true',
    shellEnvExcludeTemplate: 'shell_environment_policy.exclude={env_vars_json}',
  },
  args: [
    {
      mode: 'config_override' as const,
      flag: '-c',
      key: 'mcp_servers.adhdev-mesh.enabled',
      value: 'false',
      dedupeKey: 'mcp_servers.adhdev-mesh',
    },
  ],
}

describe('coordinator delegated CLI launch isolation', () => {
  it('clears Repo Mesh coordinator env and prompts inherited by delegated child agents', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-child-env-'))
    __tmpDirsToClean.push(workspace)

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'codex-cli',
      workspace,
      cliArgs: ['--model', 'test'],
      env: {
        ADHDEV_INLINE_MESH: '{"id":"mesh_inherited"}',
        ADHDEV_MCP_TRANSPORT: 'ipc',
        ADHDEV_MESH_ID: 'mesh_inherited',
        HERMES_EPHEMERAL_SYSTEM_PROMPT: 'Repo Mesh coordinator prompt',
        KEEP_ME: 'yes',
      },
      isolation: codexIsolation,
    })

    expect(result.cliArgs).toEqual(['-c', 'mcp_servers.adhdev-mesh.enabled=false', '--model', 'test'])
    expect(result.env).toMatchObject({
      ADHDEV_INLINE_MESH: '',
      ADHDEV_MCP_TRANSPORT: '',
      ADHDEV_MESH_ID: '',
      HERMES_EPHEMERAL_SYSTEM_PROMPT: '',
      KEEP_ME: 'yes',
    })
  })

  it('preserves delegated Hermes args so user default model/provider config is still used', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-child-hermes-'))
    __tmpDirsToClean.push(workspace)

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'hermes-cli',
      workspace,
      cliArgs: ['--model', 'test'],
    })

    expect(result.cliArgs).toEqual(['--model', 'test'])
    expect(result.cliArgs).not.toContain('--ignore-user-config')
    expect(result.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBe('')
  })

  it('does not inject model/provider flags for delegated Hermes launches without explicit overrides', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-child-hermes-default-model-'))
    __tmpDirsToClean.push(workspace)

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'hermes-cli',
      workspace,
    })

    expect(result.cliArgs).toEqual([])
    expect(result.cliArgs).not.toContain('--ignore-user-config')
    expect(result.cliArgs).not.toContain('--model')
    expect(result.cliArgs).not.toContain('--provider')
    expect(Object.keys(result.env).some((key) => /^HERMES_.*MODEL/.test(key))).toBe(false)
  })

  it('starts delegated Claude agents with provider-declared isolated empty MCP config instead of repo .mcp coordinator setup', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-child-claude-'))
    __tmpDirsToClean.push(workspace)

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'claude-cli',
      workspace,
      cliArgs: ['--model', 'test'],
      isolation: claudeIsolation,
    })

    const mcpConfigIndex = result.cliArgs.indexOf('--mcp-config')
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0)
    expect(result.cliArgs).toContain('--strict-mcp-config')
    expect(result.cliArgs.indexOf('--strict-mcp-config')).toBeLessThan(mcpConfigIndex)
    const mcpConfigPath = result.cliArgs[mcpConfigIndex + 1]
    expect(mcpConfigPath).toContain('adhdev-delegated-agent-empty-mcp')
    expect(existsSync(mcpConfigPath)).toBe(true)
    expect(JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))).toEqual({ mcpServers: {} })
    expect(result.cliArgs.slice(mcpConfigIndex + 2)).toEqual(['--model', 'test'])
  })

  it('starts delegated Codex agents with provider-declared mesh MCP disabled so workers cannot act as coordinators', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-child-codex-'))
    __tmpDirsToClean.push(workspace)

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'codex-cli',
      workspace,
      cliArgs: ['--model', 'test'],
      isolation: codexIsolation,
    })

    expect(result.cliArgs).toEqual(['-c', 'mcp_servers.adhdev-mesh.enabled=false', '--model', 'test'])
  })

  it('does not duplicate an explicit Codex adhdev-mesh MCP override for delegated agents', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-child-codex-explicit-'))
    __tmpDirsToClean.push(workspace)

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'codex-cli',
      workspace,
      cliArgs: ['--config', 'mcp_servers.adhdev-mesh.enabled=false', '--model', 'test'],
      isolation: codexIsolation,
    })

    expect(result.cliArgs).toEqual(['--config', 'mcp_servers.adhdev-mesh.enabled=false', '--model', 'test'])
  })
})

/**
 * WORKER-MCP trunk-flag regression.
 *
 * The feature ships behind ADHDEV_WORKER_MCP (default off) and the promise is
 * that a daemon without the flag behaves EXACTLY as it did before. These cases
 * assert that promise at the seam every worker launch goes through, including
 * for the six providers that declare no isolation at all — the ones the feature
 * exists to cover, and therefore the ones most likely to regress.
 */
describe('worker-MCP gate OFF ⇒ delegated launch is unchanged', () => {
  const ALL_PROVIDERS = [
    'claude-cli', 'codex-cli', 'antigravity-cli', 'cursor-cli',
    'grok-cli', 'hermes-cli', 'kimi', 'opencode',
  ]

  const MCP_CONFIGS: Record<string, { mode: string; format?: string; path?: string; serverName: string }> = {
    'claude-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
    'codex-cli': { mode: 'manual', serverName: 'adhdev-mesh' },
    'antigravity-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json', serverName: 'adhdev-mesh' },
    'cursor-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '.cursor/mcp.json', serverName: 'adhdev-mesh' },
    'grok-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
    'hermes-cli': { mode: 'auto_import', format: 'hermes_config_yaml', path: '~/.hermes/config.yaml', serverName: 'adhdev-mesh' },
    kimi: { mode: 'auto_import', format: 'claude_mcp_json', path: '.kimi-code/mcp.json', serverName: 'adhdev-mesh' },
    opencode: { mode: 'auto_import', format: 'opencode_json', path: 'opencode.json', serverName: 'adhdev-mesh' },
  }

  const priorEnv = process.env.ADHDEV_WORKER_MCP

  beforeEach(() => { delete process.env.ADHDEV_WORKER_MCP })
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.ADHDEV_WORKER_MCP
    else process.env.ADHDEV_WORKER_MCP = priorEnv
  })

  it('emits no workerIsolation and writes no config for any of the 8 providers', () => {
    let checked = 0
    for (const cliType of ALL_PROVIDERS) {
      const workspace = mkdtempSync(join(tmpdir(), `adhdev-gateoff-${cliType}-`))
      __tmpDirsToClean.push(workspace)
      const result = buildCoordinatorDelegatedCliLaunchOptions({
        cliType,
        workspace,
        cliArgs: ['--model', 'test'],
        mcpConfig: MCP_CONFIGS[cliType],
        sessionKey: 'task_gateoff',
      })

      expect(result.workerIsolation).toBeUndefined()
      // Nothing may appear in the workspace for a repo-local declared path.
      const declared = MCP_CONFIGS[cliType].path
      if (declared && !declared.startsWith('~')) {
        expect(existsSync(join(workspace, declared))).toBe(false)
      }
      checked += 1
    }
    // Gate-authoring checklist ②: assert the count, not just the loop.
    expect(checked).toBe(8)
  })

  it('produces args/env identical to a call that never mentions worker-MCP at all', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-gateoff-identity-'))
    __tmpDirsToClean.push(workspace)
    const baseArgs = { cliType: 'kimi', workspace, cliArgs: ['--model', 'test'], env: { KEEP: 'yes' } }

    const withoutFeature = buildCoordinatorDelegatedCliLaunchOptions(baseArgs)
    const withFeatureInputs = buildCoordinatorDelegatedCliLaunchOptions({
      ...baseArgs,
      mcpConfig: MCP_CONFIGS.kimi,
      sessionKey: 'task_gateoff',
    })

    expect(withFeatureInputs.cliArgs).toEqual(withoutFeature.cliArgs)
    expect(withFeatureInputs.env).toEqual(withoutFeature.env)
  })

  it('ignores a provider-declared env.set while the gate is off', () => {
    // env.set only carries meaning alongside a worker-private HOME, which does
    // not exist with the gate off. Applying it anyway would export a literal
    // `{{workerHome}}` and send the CLI to a nonexistent directory.
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-gateoff-envset-'))
    __tmpDirsToClean.push(workspace)
    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'antigravity-cli',
      workspace,
      isolation: { env: { set: { HOME: '{{workerHome}}' } } },
    })
    expect(result.env.HOME).toBeUndefined()
  })

  it('does not redirect HOME with the gate off', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-gateoff-home-'))
    __tmpDirsToClean.push(workspace)
    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'antigravity-cli',
      workspace,
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
      sessionKey: 'task_1',
    })
    expect(result.env.HOME).toBeUndefined()
  })
})

describe('worker-MCP gate ON ⇒ provider-specific worker delivery is active', () => {
  const priorEnv = process.env.ADHDEV_WORKER_MCP

  beforeEach(() => { process.env.ADHDEV_WORKER_MCP = '1' })
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.ADHDEV_WORKER_MCP
    else process.env.ADHDEV_WORKER_MCP = priorEnv
  })

  it('★exports HOME so the private directory is actually consulted', () => {
    // Without this export the private HOME exists but nothing reads it — the
    // CLI would still resolve `~` to the real home and inherit the
    // coordinator's mcp_config.json, i.e. the feature would be silently inert.
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-gateon-home-'))
    __tmpDirsToClean.push(workspace)
    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'antigravity-cli',
      workspace,
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
      sessionKey: 'task_home_export',
    })

    // The real machine's ~/.gemini may or may not be present; when the auth
    // import is unavailable the resolver degrades without a private HOME and
    // says so. Assert the pairing: a private HOME implies HOME is exported.
    if (result.workerIsolation?.workerHome) {
      expect(result.env.HOME).toBe(result.workerIsolation.workerHome)
    } else {
      expect(result.env.HOME).toBeUndefined()
      expect(result.workerIsolation!.notes.join(' ')).toMatch(/private HOME unavailable/)
    }
  })

  it('leaves a repo-local provider on the real HOME', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-gateon-kimi-'))
    __tmpDirsToClean.push(workspace)
    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'kimi',
      workspace,
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.kimi-code/mcp.json' },
      sessionKey: 'task_1',
    })

    expect(result.workerIsolation?.workerHome).toBeUndefined()
    expect(result.env.HOME).toBeUndefined()
    // But it DOES get an isolated config — that is the 6-provider win.
    expect(existsSync(join(workspace, '.kimi-code', 'mcp.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(workspace, '.kimi-code', 'mcp.json'), 'utf-8'))).toEqual({ mcpServers: {} })
  })

  it('delivers Codex worker MCP via config overrides while keeping the bind out of argv', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-gateon-codex-'))
    __tmpDirsToClean.push(workspace)
    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'codex-cli',
      workspace,
      isolation: codexIsolation,
      mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh' },
      sessionKey: 'task_codex',
      bindContext: { meshId: 'mesh_codex', sessionId: 'sess_codex', spawnedForTaskId: 'task_codex' },
    })

    const overrides = new Map<string, string>()
    for (let index = 0; index < result.cliArgs.length; index += 1) {
      if (result.cliArgs[index] !== '-c') continue
      const override = result.cliArgs[index + 1]
      const separator = override.indexOf('=')
      overrides.set(override.slice(0, separator), override.slice(separator + 1))
    }

    expect(overrides.get('mcp_servers.adhdev-mesh.enabled')).toBe('false')
    expect(JSON.parse(overrides.get('mcp_servers.adhdev-worker.command')!)).toBeTruthy()
    expect(JSON.parse(overrides.get('mcp_servers.adhdev-worker.args')!)).toContain('--worker')
    expect(JSON.parse(overrides.get('mcp_servers.adhdev-worker.env_vars')!)).toEqual(['ADHDEV_WORKER_SESSION_BIND'])
    expect(overrides.get('mcp_servers.adhdev-worker.enabled')).toBe('true')
    expect(JSON.parse(overrides.get('shell_environment_policy.exclude')!)).toEqual(['ADHDEV_WORKER_SESSION_BIND'])
    expect(result.env.ADHDEV_WORKER_SESSION_BIND).toMatch(/^wsb_/)
    expect(result.cliArgs.join(' ')).not.toContain(result.env.ADHDEV_WORKER_SESSION_BIND)
    expect(result.workerIsolation?.configPath).toBeUndefined()
  })
})

/**
 * ★AGY-WORKER-TRUST-STALL regression (2026-09-13).
 *
 * The defect: a delegated antigravity worker's pre-launch trust plan was built
 * ONLY when `workerIsolation.workerHome` existed — i.e. only behind
 * ADHDEV_WORKER_MCP, which is OFF by default. So on an ordinary daemon the plan
 * was null, fsm-driver fail-closed, and every worker hung forever on
 * "Do you trust the files in this folder?".
 *
 * These cases pin the two halves that together make the fix real:
 *   1. the plan is non-null with the gate OFF, and
 *   2. its store path is worker-scoped — never the daemon's own HOME.
 * Either one alone is insufficient: (1) without (2) is the trust leak the
 * fail-closed branch exists to prevent, and (2) without the HOME export is
 * inert (the CLI would read `~` and prompt anyway).
 */
describe('★delegated worker pre-launch trust is decoupled from the worker-MCP gate', () => {
  const AGY_TRUST = {
    settings_path: '~/.gemini/antigravity-cli/settings.json',
    key: 'trustedWorkspaces',
  } as const

  const priorEnv = process.env.ADHDEV_WORKER_MCP
  beforeEach(() => { delete process.env.ADHDEV_WORKER_MCP })
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.ADHDEV_WORKER_MCP
    else process.env.ADHDEV_WORKER_MCP = priorEnv
  })

  /** A realistic `~` for antigravity, so the private-HOME imports have sources. */
  function fakeRealHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'agy-trust-realhome-'))
    __tmpDirsToClean.push(home)
    const agy = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(join(agy, 'brain'), { recursive: true })
    mkdirSync(join(agy, 'conversations'), { recursive: true })
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(agy, 'antigravity-oauth-token'), '{"token":{}}', { mode: 0o600 })
    writeFileSync(join(agy, 'settings.json'), '{"theme":"owner-sentinel"}\n', { mode: 0o600 })
    writeFileSync(join(agy, 'history.jsonl'), '', { mode: 0o600 })
    return home
  }

  function launchWorker(opts: { realHome: string; workspace: string; ledgerPath: string }) {
    const workerBase = mkdtempSync(join(tmpdir(), 'agy-trust-workerbase-'))
    __tmpDirsToClean.push(workerBase)
    return buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'antigravity-cli',
      workspace: opts.workspace,
      sessionKey: 'sess_worker_trust',
      preLaunchTrust: AGY_TRUST,
      mcpConfig: {
        mode: 'auto_import',
        format: 'claude_mcp_json',
        path: '~/.gemini/config/mcp_config.json',
      },
      realHome: opts.realHome,
      workerHomeBaseDir: workerBase,
      trustLedgerPath: opts.ledgerPath,
      // ★No runtimeEnv override ⇒ ADHDEV_WORKER_MCP is genuinely off (deleted
      // in beforeEach). This is the production default, and the shape the
      // defect lived in.
    })
  }

  it('★builds a NON-NULL trust plan with ADHDEV_WORKER_MCP off (the stall fix)', () => {
    const realHome = fakeRealHome()
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-ws-'))
    __tmpDirsToClean.push(workspace)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'agy-trust-ledger-'))
    __tmpDirsToClean.push(ledgerRoot)

    const result = launchWorker({ realHome, workspace, ledgerPath: join(ledgerRoot, 'grants.json') })

    // The gate really is off — no MCP isolation surface was produced at all.
    expect(result.workerIsolation).toBeUndefined()
    // …and yet the trust plan exists. Before the fix this was null.
    expect(result.resolvedTrustPlan).not.toBeNull()
    expect(result.resolvedTrustPlan).toMatchObject({
      provider: 'antigravity-cli',
      scope: 'worker',
      origin: 'worker_auto',
      sessionKey: 'sess_worker_trust',
    })
    expect(result.resolvedTrustPlan!.workspaceRealpath).toBe(realpathSync(workspace))
  })

  it('★resolves the trust store to a worker-scoped path, never the daemon HOME (leak safety)', () => {
    const realHome = fakeRealHome()
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-leak-ws-'))
    __tmpDirsToClean.push(workspace)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'agy-trust-leak-ledger-'))
    __tmpDirsToClean.push(ledgerRoot)

    const result = launchWorker({ realHome, workspace, ledgerPath: join(ledgerRoot, 'grants.json') })
    const storePath = result.resolvedTrustPlan!.storePath

    expect(storePath).not.toBe(join(realHome, '.gemini', 'antigravity-cli', 'settings.json'))
    // Not merely "a different file" — it must not be anywhere under the real
    // home, which is what a `~`-resolution regression would produce.
    expect(storePath.startsWith(realHome)).toBe(false)
    // And it must not be under the daemon process's own HOME either.
    const daemonHome = process.env.HOME || process.env.USERPROFILE || ''
    if (daemonHome) expect(storePath.startsWith(daemonHome)).toBe(false)

    // HOME is exported to the same worker-scoped root — without this the store
    // exists but the CLI never reads it and still prompts (inert fix).
    expect(result.env.HOME).toBeTruthy()
    expect(storePath.startsWith(result.env.HOME!)).toBe(true)
  })

  it('★materializing the plan leaves the owner\'s real settings.json byte-identical', () => {
    const realHome = fakeRealHome()
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-apply-ws-'))
    __tmpDirsToClean.push(workspace)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'agy-trust-apply-ledger-'))
    __tmpDirsToClean.push(ledgerRoot)
    const ownerSettings = join(realHome, '.gemini', 'antigravity-cli', 'settings.json')
    const ownerBytes = readFileSync(ownerSettings, 'utf8')

    const result = launchWorker({ realHome, workspace, ledgerPath: join(ledgerRoot, 'grants.json') })
    applyPreLaunchTrust(AGY_TRUST, result.resolvedTrustPlan!)

    // The whole point: the worker's automatic grant never lands in the owner's
    // personal trusted-workspace list.
    expect(readFileSync(ownerSettings, 'utf8')).toBe(ownerBytes)
    expect(JSON.parse(ownerBytes).trustedWorkspaces).toBeUndefined()

    // The worker's own copy DOES carry it — inherited settings preserved.
    const projected = JSON.parse(readFileSync(result.resolvedTrustPlan!.storePath, 'utf8'))
    expect(projected.theme).toBe('owner-sentinel')
    expect(projected.trustedWorkspaces).toEqual([realpathSync(workspace)])
  })

  it('records the worker-auto grant in the daemon ledger even with the gate off', () => {
    const realHome = fakeRealHome()
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-ledger-ws-'))
    __tmpDirsToClean.push(workspace)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'agy-trust-ledger-only-'))
    __tmpDirsToClean.push(ledgerRoot)
    const ledgerPath = join(ledgerRoot, 'grants.json')

    const result = launchWorker({ realHome, workspace, ledgerPath })

    expect(result.resolvedTrustPlan).not.toBeNull()
    expect(existsSync(ledgerPath)).toBe(true)
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    expect(ledger.grants).toHaveLength(1)
    expect(ledger.grants[0]).toMatchObject({
      provider: 'antigravity-cli', scope: 'worker', origin: 'worker_auto',
    })
    // Provenance is attributable, not anonymous.
    expect(ledger.grants[0].usages[0].sessionKey).toBe('sess_worker_trust')
  })

  it('emits trust-axis launch notes so a skipped grant is diagnosable from the log', () => {
    const realHome = fakeRealHome()
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-notes-ws-'))
    __tmpDirsToClean.push(workspace)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'agy-trust-notes-ledger-'))
    __tmpDirsToClean.push(ledgerRoot)

    const result = launchWorker({ realHome, workspace, ledgerPath: join(ledgerRoot, 'grants.json') })

    const notes = (result.trustNotes || []).join('; ')
    expect(notes).toMatch(/worker trust HOME/)
    expect(notes).toMatch(/worker-auto trust grant/)
    // The secret-free contract: notes name paths and grant ids, never tokens.
    expect(notes).not.toMatch(/wtk_|wsb_/)
  })

  it('★fails closed (plan stays null) for a provider with no worker-scoped HOME spec', () => {
    // kimi declares pre_launch_trust via a named scheme and has no private-HOME
    // spec. Decoupling must NOT become "resolve `~` against the daemon home for
    // anyone" — a provider we cannot scope still gets a null plan.
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-noscope-ws-'))
    __tmpDirsToClean.push(workspace)
    const workerBase = mkdtempSync(join(tmpdir(), 'agy-trust-noscope-base-'))
    __tmpDirsToClean.push(workerBase)

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'grok-cli',
      workspace,
      sessionKey: 'sess_noscope',
      preLaunchTrust: { settings_path: '~/.grok/settings.json', key: 'trustedFolders' },
      workerHomeBaseDir: workerBase,
    })

    expect(result.resolvedTrustPlan).toBeNull()
    // No HOME redirect either — an unscoped provider keeps its prior behavior
    // exactly, rather than being pointed at a directory with no imports.
    expect(result.env.HOME).toBeUndefined()
    expect((result.trustNotes || []).join('; ')).toMatch(/no worker trust HOME available/)
  })

  it('reuses the MCP-gate private HOME when the gate is ON (one HOME per launch)', () => {
    process.env.ADHDEV_WORKER_MCP = '1'
    const realHome = fakeRealHome()
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-gateon-ws-'))
    __tmpDirsToClean.push(workspace)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'agy-trust-gateon-ledger-'))
    __tmpDirsToClean.push(ledgerRoot)

    const result = launchWorker({ realHome, workspace, ledgerPath: join(ledgerRoot, 'grants.json') })

    expect(result.workerIsolation?.workerHome).toBeTruthy()
    expect(result.resolvedTrustPlan).not.toBeNull()
    // The trust store lives inside the SAME home the MCP config was written to
    // — not a second, parallel private home.
    expect(result.resolvedTrustPlan!.storePath.startsWith(result.workerIsolation!.workerHome!)).toBe(true)
    expect(result.env.HOME).toBe(result.workerIsolation!.workerHome)
    // With the gate on the notes stay in workerIsolation.notes (no double-report).
    expect(result.trustNotes).toBeUndefined()
    expect(result.workerIsolation!.notes.join('; ')).toMatch(/worker-auto trust grant/)
  })

  it('the projected store is the path the CLI will actually read under the exported HOME', () => {
    // Ties the two halves together: HOME redirect + store path must agree, so
    // `~/.gemini/antigravity-cli/settings.json` as the CLI resolves it IS the
    // file the plan wrote. A mismatch here is the silently-inert failure mode.
    const realHome = fakeRealHome()
    const workspace = mkdtempSync(join(tmpdir(), 'agy-trust-agree-ws-'))
    __tmpDirsToClean.push(workspace)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'agy-trust-agree-ledger-'))
    __tmpDirsToClean.push(ledgerRoot)

    const result = launchWorker({ realHome, workspace, ledgerPath: join(ledgerRoot, 'grants.json') })
    applyPreLaunchTrust(AGY_TRUST, result.resolvedTrustPlan!)

    const asCliResolvesIt = join(result.env.HOME!, '.gemini', 'antigravity-cli', 'settings.json')
    expect(asCliResolvesIt).toBe(result.resolvedTrustPlan!.storePath)
    expect(existsSync(dirname(asCliResolvesIt))).toBe(true)
    expect(JSON.parse(readFileSync(asCliResolvesIt, 'utf8')).trustedWorkspaces)
      .toEqual([realpathSync(workspace)])
  })
})
