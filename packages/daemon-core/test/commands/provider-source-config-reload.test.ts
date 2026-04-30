import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleSetProviderSourceConfig } from '../../src/commands/stream-commands.js'

let previousHome = process.env.HOME
let tempHome: string | null = null

function useTempHome() {
  tempHome = mkdtempSync(join(tmpdir(), 'adhdev-provider-source-config-'))
  process.env.HOME = tempHome
}

afterEach(() => {
  process.env.HOME = previousHome
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  tempHome = null
})

describe('set_provider_source_config reload behavior', () => {
  it('refreshes already-running provider instances after reloading the provider source config', async () => {
    useTempHome()
    const refreshedProviders: any[] = []
    const sourceConfig = {
      sourceMode: 'normal',
      disableUpstream: false,
      explicitProviderDir: '/tmp/adhdev-providers-test',
      userDir: '/tmp/adhdev-providers-test',
      userDirSource: 'explicit',
      upstreamDir: '/tmp/adhdev-providers-test/.upstream',
      providerRoots: ['/tmp/adhdev-providers-test'],
    }
    const providerLoader = {
      getSourceConfig: vi.fn(() => ({ explicitProviderDir: null })),
      applySourceConfig: vi.fn(() => sourceConfig),
      reload: vi.fn(),
      registerToDetector: vi.fn(),
      resolve: vi.fn((providerType: string) => ({ type: providerType, name: 'Reloaded Hermes', category: 'cli' })),
    }
    const instanceManager = {
      refreshProviderDefinitions: vi.fn((resolveProvider: (providerType: string) => unknown) => {
        refreshedProviders.push(resolveProvider('hermes-cli'))
        return 1
      }),
    }
    const onProviderSourceConfigChanged = vi.fn()

    const result = await handleSetProviderSourceConfig({
      ctx: { providerLoader, instanceManager, onProviderSourceConfigChanged },
    } as any, {
      providerSourceMode: 'normal',
      providerDir: '/tmp/adhdev-providers-test',
    })

    expect(result).toMatchObject({ success: true, reloaded: true, refreshedInstances: 1 })
    expect(providerLoader.reload).toHaveBeenCalledOnce()
    expect(providerLoader.registerToDetector).toHaveBeenCalledOnce()
    expect(instanceManager.refreshProviderDefinitions).toHaveBeenCalledOnce()
    expect(refreshedProviders).toEqual([{ type: 'hermes-cli', name: 'Reloaded Hermes', category: 'cli' }])
    expect(onProviderSourceConfigChanged).toHaveBeenCalledOnce()
  })
})
