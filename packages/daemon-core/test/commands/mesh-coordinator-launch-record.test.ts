import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DaemonCommandRouter } from '../../src/commands/router.js'
import type { ProviderModule } from '../../src/providers/contracts.js'

// Phase E: a coordinator launch's model / thinking level is an explicit
// per-launch pick — the launch_cli it issues must say so (`modelSource: 'user'`,
// `launchedBy: 'mesh'`), unless the dialog declares the value was restored from
// the last launch. cli-manager turns these args into the session's launch record
// (covered by cli-manager-launch-record.test.ts).

let configDir = ''
let previousConfigDir: string | undefined
let workspace = ''
let previousMcpEntry: string | undefined

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'adhdev-coord-launch-record-config-'))
  previousConfigDir = process.env.ADHDEV_CONFIG_DIR
  process.env.ADHDEV_CONFIG_DIR = configDir
  workspace = mkdtempSync(join(tmpdir(), 'adhdev-coord-launch-record-ws-'))
  const mcpEntry = join(workspace, 'mcp-server.js')
  writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
  previousMcpEntry = process.env.ADHDEV_MCP_SERVER_PATH
  process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
  if (previousMcpEntry === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
  else process.env.ADHDEV_MCP_SERVER_PATH = previousMcpEntry
  rmSync(configDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

afterEach(() => { vi.restoreAllMocks() })

const provider: ProviderModule = {
  type: 'claude-cli',
  name: 'Claude Code',
  category: 'cli',
  spawn: { command: 'claude' },
  meshCoordinator: {
    supported: true,
    mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
    systemPromptInjection: { mode: 'cli_arg', flag: '--append-system-prompt' },
  },
}

async function launchCoordinator(extra: Record<string, unknown>) {
  const launchCli = vi.fn(async () => ({ success: true, sessionId: 'coord-session' }))
  const router = new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { launchCli } as any,
    cdpManagers: new Map(),
    providerLoader: { resolve: vi.fn(() => provider), getMeta: vi.fn(() => provider) } as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    packageName: 'adhdev',
    statusVersion: '0.9.71',
  })
  const meshId = `mesh_launch_record_${Math.random().toString(36).slice(2, 8)}`
  const result = await router.execute('launch_mesh_coordinator', {
    meshId,
    cliType: 'claude-cli',
    inlineMesh: { id: meshId, name: 'M', repoIdentity: 'example/repo', nodes: [{ id: 'node-1', workspace, policy: {} }], policy: {}, coordinator: {} },
    ...extra,
  })
  expect(result).toMatchObject({ success: true })
  return (launchCli.mock.calls[0] as any)?.[0] as Record<string, unknown>
}

describe('launch_mesh_coordinator — launch provenance forwarded to launch_cli', () => {
  it('a dialog model / thinking level is a user pick, launched by mesh', async () => {
    const call = await launchCoordinator({ initialModel: 'opus', initialThinkingLevel: 'high' })
    expect(call).toMatchObject({
      initialModel: 'opus',
      initialThinkingLevel: 'high',
      launchedBy: 'mesh',
      modelSource: 'user',
      thinkingLevelSource: 'user',
    })
  })

  it('a dialog-declared remembered value stays remembered', async () => {
    const call = await launchCoordinator({ initialModel: 'opus', modelSource: 'remembered', thinkingLevelSource: 'bogus', initialThinkingLevel: 'low' })
    expect(call).toMatchObject({ modelSource: 'remembered', thinkingLevelSource: 'user' })
  })

  it('no model requested → no model source claimed (the daemon resolves the default)', async () => {
    const call = await launchCoordinator({})
    expect(call.launchedBy).toBe('mesh')
    expect(call).not.toHaveProperty('modelSource')
    expect(call).not.toHaveProperty('thinkingLevelSource')
  })
})
