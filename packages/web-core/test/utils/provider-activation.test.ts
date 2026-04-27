import { describe, expect, it } from 'vitest'
import { isLaunchableMachineProvider } from '../../src/utils/provider-activation'

describe('provider activation launchability', () => {
  it('keeps CLI/ACP catalog entries hidden until explicitly enabled, then allows launch attempts', () => {
    expect(isLaunchableMachineProvider({ category: 'cli' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: false, machineStatus: 'detected' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: true, machineStatus: 'enabled_unchecked' }, 'cli')).toBe(true)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: true, machineStatus: 'not_detected' }, 'cli')).toBe(true)
    expect(isLaunchableMachineProvider({ category: 'cli', enabled: true, machineStatus: 'detected' }, 'cli')).toBe(true)
  })

  it('requires the requested category and preserves IDE launch behavior', () => {
    expect(isLaunchableMachineProvider({ category: 'acp', enabled: true, machineStatus: 'detected' }, 'cli')).toBe(false)
    expect(isLaunchableMachineProvider({ category: 'ide', installed: false }, 'ide')).toBe(true)
  })

  it('does not hide enabled CLI/ACP providers just because detection/install state is stale or negative', () => {
    expect(isLaunchableMachineProvider({ category: 'acp', enabled: true, machineStatus: 'enabled_unchecked', installed: false }, 'acp')).toBe(true)
    expect(isLaunchableMachineProvider({ category: 'acp', enabled: true, machineStatus: 'not_detected', installed: false }, 'acp')).toBe(true)
  })
})
