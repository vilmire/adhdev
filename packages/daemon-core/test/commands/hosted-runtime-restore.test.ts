import { describe, expect, it } from 'vitest'
import { shouldRestoreHostedRuntime } from '../../src/commands/hosted-runtime-restore'

describe('hosted runtime restore guard', () => {
  it('restores runtimes when no manager tag is configured', () => {
    expect(shouldRestoreHostedRuntime({}, undefined)).toBe(true)
    expect(shouldRestoreHostedRuntime({ managedBy: 'adhdev-standalone' }, undefined)).toBe(true)
  })

  it('skips runtimes managed by a different daemon family', () => {
    expect(shouldRestoreHostedRuntime({ managedBy: 'adhdev-standalone' }, 'adhdev-cloud')).toBe(false)
    expect(shouldRestoreHostedRuntime({ managedBy: 'adhdev-cloud' }, 'adhdev-standalone')).toBe(false)
  })

  it('allows matching manager tags and legacy untagged runtimes', () => {
    expect(shouldRestoreHostedRuntime({ managedBy: 'adhdev-standalone' }, 'adhdev-standalone')).toBe(true)
    expect(shouldRestoreHostedRuntime({ managedBy: '' }, 'adhdev-standalone')).toBe(true)
    expect(shouldRestoreHostedRuntime({}, 'adhdev-cloud')).toBe(true)
  })
})
