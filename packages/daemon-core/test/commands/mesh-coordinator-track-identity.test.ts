/**
 * Regression: the coordinator MCP launch must follow the BUILD TRACK.
 *
 * A preview install used to generate a coordinator config that launched the
 * stable `adhdev` binary with no `--port`, so the mcp-server fell back to the
 * stable IPC port (19222). The result was a preview coordinator that either
 * failed to start or silently drove the *stable* daemon.
 *
 * `IDENTITY` is snapshotted at module load, so each track is exercised in an
 * isolated module registry with the build-channel env var set beforehand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderModule } from '../../src/providers/contracts.js'

const provider: ProviderModule = {
  type: 'test-cli',
  name: 'Test CLI',
  category: 'cli',
  spawn: { command: 'test' },
  meshCoordinator: {
    supported: true,
    mcpConfig: {
      mode: 'auto_import',
      format: 'claude_mcp_json',
      path: '.mcp.json',
      serverName: 'adhdev-mesh',
    },
  },
} as ProviderModule

const ORIGINAL_CHANNEL = process.env.ADHDEV_BUILD_CHANNEL

async function resolveSetupForTrack(channel: 'stable' | 'preview') {
  if (channel === 'preview') process.env.ADHDEV_BUILD_CHANNEL = 'preview'
  else delete process.env.ADHDEV_BUILD_CHANNEL

  vi.resetModules()
  const { resolveMeshCoordinatorSetup } = await import('../../src/commands/mesh-coordinator.js')
  return resolveMeshCoordinatorSetup({ provider, meshId: 'mesh_track', workspace: '/repo' })
}

describe('mesh coordinator MCP launch is track-scoped', () => {
  beforeEach(() => {
    delete process.env.ADHDEV_COORDINATOR_MCP_COMMAND
    delete process.env.ADHDEV_COORDINATOR_MCP_PORT
  })

  afterEach(() => {
    if (ORIGINAL_CHANNEL === undefined) delete process.env.ADHDEV_BUILD_CHANNEL
    else process.env.ADHDEV_BUILD_CHANNEL = ORIGINAL_CHANNEL
    vi.resetModules()
  })

  it('uses the stable binary and stable IPC port on the stable track', async () => {
    const setup = await resolveSetupForTrack('stable')
    if (setup.kind !== 'auto_import') throw new Error(`expected auto_import, got ${setup.kind}`)

    expect(setup.mcpServer.command).toBe('adhdev')
    expect(setup.mcpServer.args).toEqual(
      ['mcp', '--mode', 'ipc', '--repo-mesh', 'mesh_track', '--port', '19222'],
    )
  })

  it('uses the preview binary and preview IPC port on the preview track', async () => {
    const setup = await resolveSetupForTrack('preview')
    if (setup.kind !== 'auto_import') throw new Error(`expected auto_import, got ${setup.kind}`)

    // The whole point of the fix: neither of these may be the stable value.
    expect(setup.mcpServer.command).toBe('adhdev-preview')
    expect(setup.mcpServer.args).toEqual(
      ['mcp', '--mode', 'ipc', '--repo-mesh', 'mesh_track', '--port', '19223'],
    )
  })

  it('always stamps an explicit --port so the config is never track-ambiguous', async () => {
    for (const channel of ['stable', 'preview'] as const) {
      const setup = await resolveSetupForTrack(channel)
      if (setup.kind !== 'auto_import') throw new Error(`expected auto_import, got ${setup.kind}`)
      expect(setup.mcpServer.args).toContain('--port')
    }
  })

  it('still honors explicit command/port overrides on the preview track', async () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview'
    process.env.ADHDEV_COORDINATOR_MCP_COMMAND = '/custom/bin/adhdev'
    process.env.ADHDEV_COORDINATOR_MCP_PORT = '3957'

    vi.resetModules()
    const { resolveMeshCoordinatorSetup } = await import('../../src/commands/mesh-coordinator.js')
    const setup = resolveMeshCoordinatorSetup({ provider, meshId: 'mesh_track', workspace: '/repo' })
    if (setup.kind !== 'auto_import') throw new Error(`expected auto_import, got ${setup.kind}`)

    expect(setup.mcpServer.command).toBe('/custom/bin/adhdev')
    expect(setup.mcpServer.args).toContain('3957')
  })
})
