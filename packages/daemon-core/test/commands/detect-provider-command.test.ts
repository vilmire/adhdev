import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detectCLI: vi.fn(),
}))

vi.mock('../../src/detection/cli-detector.js', () => ({
  detectCLI: mocks.detectCLI,
}))

import { DaemonCommandRouter } from '../../src/commands/router'

function createRouter(providerLoader: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { handleCliCommand: vi.fn(async () => ({ success: false })) } as any,
    cdpManagers: new Map(),
    providerLoader: providerLoader as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    ...overrides,
  })
}

describe('detect_provider command', () => {
  beforeEach(() => {
    mocks.detectCLI.mockReset()
  })

  it('rejects disabled CLI/ACP providers without probing the executable', async () => {
    const setCliDetectionResults = vi.fn()
    const router = createRouter({
      resolveAlias: vi.fn(() => 'codex-cli'),
      getByAlias: vi.fn(() => ({ type: 'codex-cli', category: 'cli' })),
      isMachineProviderEnabled: vi.fn(() => false),
      setCliDetectionResults,
    })

    const result = await router.execute('detect_provider', { providerType: 'codex' }, 'p2p')

    expect(result).toMatchObject({ success: false, error: 'Provider is disabled on this machine: codex' })
    expect(mocks.detectCLI).not.toHaveBeenCalled()
    expect(setCliDetectionResults).not.toHaveBeenCalled()
  })

  it('detects only enabled CLI/ACP providers and persists the machine detection result', async () => {
    const setCliDetectionResults = vi.fn()
    const providerLoader = {
      resolveAlias: vi.fn(() => 'codex-cli'),
      getByAlias: vi.fn(() => ({ type: 'codex-cli', category: 'cli' })),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults,
    }
    mocks.detectCLI.mockResolvedValue({ id: 'codex-cli', installed: true, path: '/opt/bin/codex' })

    const onStatusChange = vi.fn()

    const result = await createRouter(providerLoader, { onStatusChange }).execute('detect_provider', { providerType: 'codex' }, 'p2p')

    expect(mocks.detectCLI).toHaveBeenCalledWith('codex-cli', providerLoader, { includeVersion: false })
    expect(setCliDetectionResults).toHaveBeenCalledWith([
      { id: 'codex-cli', installed: true, path: '/opt/bin/codex' },
    ], false)
    expect(onStatusChange).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, providerType: 'codex-cli', detected: true, path: '/opt/bin/codex' })
  })
})
