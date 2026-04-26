import { describe, expect, it } from 'vitest'
import { isLaunchableMachineProvider } from '../../src/utils/provider-activation'

describe('provider activation launchability', () => {
  it('keeps CLI/ACP catalog entries hidden until explicitly enabled and detected', () => {
    expect(isLaunchableMachineProvider({ category: 'cli' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: false, machineStatus: 'detected' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: true, machineStatus: 'enabled_unchecked' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: true, machineStatus: 'not_detected' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: true, machineStatus: 'detected' }, 'cli')).toBe(true)
  })

  it('requires the requested category and preserves IDE launch behavior', () => {
    expect(isLaunchableMachineProvider({ category: 'acp', enabled: true, machineStatus: 'detected' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'ide', installed: false }, 'ide')).toBe(true)
  })

  it('does not launch detected providers that daemon marked explicitly unavailable', () => {
    expect(isLaunchableMachineProvider({ category: 'acp', enabled: true, machineStatus: 'detected', installed: false }, 'acp')).toBe(false)
  })
})
