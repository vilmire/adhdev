import { describe, expect, it } from 'vitest'
import { buildMeshCoordinatorLaunchPayload } from '../../src/hooks/useDashboardCommandActions'

describe('mesh coordinator launch payload', () => {
  it('passes the selected auto-approve mode through to launch_mesh_coordinator', () => {
    expect(buildMeshCoordinatorLaunchPayload('mesh-1', 'claude-cli', {
      settings: { autoApproveMode: 'accept-edits' },
    })).toEqual({
      meshId: 'mesh-1',
      cliType: 'claude-cli',
      autoApproveMode: 'accept-edits',
    })
  })

  it('passes the legacy boolean for providers without mode metadata', () => {
    expect(buildMeshCoordinatorLaunchPayload('mesh-1', 'legacy-cli', {
      settings: { autoApprove: false },
    })).toEqual({
      meshId: 'mesh-1',
      cliType: 'legacy-cli',
      autoApprove: false,
    })
  })

  it('prefers autoApproveMode over the legacy boolean when both are present', () => {
    expect(buildMeshCoordinatorLaunchPayload('mesh-1', 'claude-cli', {
      settings: { autoApprove: true, autoApproveMode: 'yolo' },
    })).toEqual({
      meshId: 'mesh-1',
      cliType: 'claude-cli',
      autoApproveMode: 'yolo',
    })
  })

  it('omits settings entirely when none were selected', () => {
    expect(buildMeshCoordinatorLaunchPayload('mesh-1', 'claude-cli')).toEqual({
      meshId: 'mesh-1',
      cliType: 'claude-cli',
    })
  })

  it('carries initialModel/initialThinkingLevel alongside the approval settings', () => {
    expect(buildMeshCoordinatorLaunchPayload('mesh-1', 'claude-cli', {
      initialModel: 'opus',
      initialThinkingLevel: 'high',
      settings: { autoApproveMode: 'accept-edits' },
    })).toEqual({
      meshId: 'mesh-1',
      cliType: 'claude-cli',
      initialModel: 'opus',
      initialThinkingLevel: 'high',
      autoApproveMode: 'accept-edits',
    })
  })
})
