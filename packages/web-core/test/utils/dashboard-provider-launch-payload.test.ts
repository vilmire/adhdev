import { describe, expect, it } from 'vitest'
import { buildDashboardProviderLaunchPayload } from '../../src/hooks/useDashboardCommandActions'

describe('dashboard provider launch payload', () => {
  it('passes the selected auto-approve mode through launch_cli settings', () => {
    expect(buildDashboardProviderLaunchPayload('codex-cli', {
      workspaceId: 'workspace-1',
      cliArgs: ['--profile', 'test'],
      settings: { autoApproveMode: 'caution' },
    })).toEqual({
      cliType: 'codex-cli',
      workspaceId: 'workspace-1',
      cliArgs: ['--profile', 'test'],
      settings: { autoApproveMode: 'caution' },
    })
  })

  it('passes the legacy boolean for providers without mode metadata', () => {
    expect(buildDashboardProviderLaunchPayload('legacy-cli', {
      useHome: true,
      settings: { autoApprove: true },
    })).toMatchObject({
      cliType: 'legacy-cli',
      useHome: true,
      settings: { autoApprove: true },
    })
  })
})
