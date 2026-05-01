import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceGitSubscribeRequest,
  getWorkspaceGitSubscriptionKey,
  readGitDiffSummaryCommandResponse,
  readGitStatusCommandResponse,
} from '../../src/hooks/useWorkspaceGitStatus'

describe('useWorkspaceGitStatus helpers', () => {
  it('builds workspace.git subscribe requests using the daemon-owned topic contract', () => {
    expect(getWorkspaceGitSubscriptionKey('/repo')).toBe('git:/repo')
    expect(buildWorkspaceGitSubscribeRequest({
      workspace: '/repo',
      includeDiffSummary: true,
      intervalMs: 2500,
    })).toEqual({
      type: 'subscribe',
      topic: 'workspace.git',
      key: 'git:/repo',
      params: {
        workspace: '/repo',
        includeDiffSummary: true,
        intervalMs: 2500,
      },
    })
  })

  it('unwraps daemon command responses and surfaces explicit errors', () => {
    const status = { workspace: '/repo', isGitRepo: true, lastCheckedAt: 1 }
    const diffSummary = { workspace: '/repo', isGitRepo: true, files: [], lastCheckedAt: 1 }

    expect(readGitStatusCommandResponse({ result: { success: true, status } })).toEqual({ status, error: null })
    expect(readGitDiffSummaryCommandResponse({ result: { success: true, diffSummary } })).toEqual({ diffSummary, error: null })
    expect(readGitStatusCommandResponse({ result: { success: false, error: 'not a repo' } })).toEqual({ status: null, error: 'not a repo' })
    expect(readGitDiffSummaryCommandResponse({ result: { success: false, error: 'diff failed' } })).toEqual({ diffSummary: null, error: 'diff failed' })
  })
})
