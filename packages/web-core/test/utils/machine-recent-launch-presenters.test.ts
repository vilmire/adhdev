import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildMachineRecentLaunchCardView,
  getMachineRecentLaunchKindLabel,
  getMachineRecentLaunchMetaText,
  getMachineRecentLaunchUpdatedLabel,
} from '../../src/utils/machine-recent-launch-presenters'

describe('machine recent launch presenters', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('formats kind labels', () => {
    expect(getMachineRecentLaunchKindLabel('ide')).toBe('IDE')
    expect(getMachineRecentLaunchKindLabel('cli')).toBe('CLI')
    expect(getMachineRecentLaunchKindLabel('acp')).toBe('ACP')
  })

  it('adds a saved-history hint when the launch can resume provider history', () => {
    expect(getMachineRecentLaunchMetaText({
      kind: 'cli',
      subtitle: '/repo',
      providerSessionId: 'session-123',
    })).toBe('CLI · /repo · Saved history')
  })

  it('omits the saved-history hint for ordinary launches', () => {
    expect(getMachineRecentLaunchMetaText({
      kind: 'ide',
      subtitle: '/repo',
    })).toBe('IDE · /repo')
  })

  it('formats a recent launch updated label from the last launch timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-14T15:00:00Z').getTime())

    expect(getMachineRecentLaunchUpdatedLabel({
      lastLaunchedAt: new Date('2026-04-14T14:55:00Z').getTime(),
    })).toBe('5m')
  })

  it('omits the updated label when the launch timestamp is missing', () => {
    expect(getMachineRecentLaunchUpdatedLabel({})).toBe('')
  })

  it('builds a shared card view with meta text and updated label', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-14T15:00:00Z').getTime())

    expect(buildMachineRecentLaunchCardView({
      kind: 'cli',
      subtitle: '/repo',
      providerSessionId: 'session-123',
      lastLaunchedAt: new Date('2026-04-14T14:55:00Z').getTime(),
    } as any)).toEqual({
      metaText: 'CLI · /repo · Saved history',
      updatedLabel: '5m',
    })
  })
})
