import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-manager'

const claudeIsolation = {
  args: [
    { mode: 'empty_mcp_config' as const, flag: '--mcp-config', strictFlag: '--strict-mcp-config' },
  ],
}

const codexIsolation = {
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
    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'antigravity-cli',
      workspace,
      isolation: { env: { set: { HOME: '{{workerHome}}' } } },
    })
    expect(result.env.HOME).toBeUndefined()
  })

  it('does not redirect HOME with the gate off', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-gateoff-home-'))
    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'antigravity-cli',
      workspace,
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
      sessionKey: 'task_1',
    })
    expect(result.env.HOME).toBeUndefined()
  })
})

describe('worker-MCP gate ON ⇒ antigravity worker gets a private HOME', () => {
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
})
