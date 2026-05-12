import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-manager'

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
    })

    expect(result.cliArgs).toEqual(['--model', 'test'])
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

  it('starts delegated Claude agents with an isolated empty MCP config instead of repo .mcp coordinator setup', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-mesh-child-claude-'))

    const result = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'claude-cli',
      workspace,
      cliArgs: ['--model', 'test'],
    })

    const mcpConfigIndex = result.cliArgs.indexOf('--mcp-config')
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0)
    const mcpConfigPath = result.cliArgs[mcpConfigIndex + 1]
    expect(mcpConfigPath).toContain('adhdev-delegated-agent-empty-mcp')
    expect(existsSync(mcpConfigPath)).toBe(true)
    expect(JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))).toEqual({ mcpServers: {} })
    expect(result.cliArgs.slice(mcpConfigIndex + 2)).toEqual(['--model', 'test'])
  })
})
