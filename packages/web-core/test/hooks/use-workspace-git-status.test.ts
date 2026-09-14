import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceGitSubscribeRequest,
  getWorkspaceGitSubscriptionKey,
  readGitDiffFileCommandResponse,
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

  /**
   * D1#4 — the client multiplexes subscriptions by `topic:key` alone, so two
   * daemons watching the same workspace path (ordinary in a mesh, where a repo
   * path repeats across machines) collided on one entry and the later subscriber
   * silently retargeted the earlier one's feed. The daemonId disambiguates.
   */
  it('scopes the subscription key to the daemon so two machines sharing a path do not collide', () => {
    expect(getWorkspaceGitSubscriptionKey('/repo', 'daemon-a')).toBe('git:daemon-a:/repo')
    expect(getWorkspaceGitSubscriptionKey('/repo', 'daemon-a'))
      .not.toBe(getWorkspaceGitSubscriptionKey('/repo', 'daemon-b'))

    expect(buildWorkspaceGitSubscribeRequest({
      workspace: '/repo',
      daemonId: 'daemon-a',
      includeDiffSummary: true,
      intervalMs: 2500,
    })).toEqual({
      type: 'subscribe',
      topic: 'workspace.git',
      key: 'git:daemon-a:/repo',
      params: {
        workspace: '/repo',
        includeDiffSummary: true,
        intervalMs: 2500,
      },
    })

    // The daemon reads the workspace off params, never by parsing the key, so
    // widening the key must not disturb the payload it acts on.
    expect(buildWorkspaceGitSubscribeRequest({ workspace: '/repo', daemonId: 'daemon-a' }).params)
      .toMatchObject({ workspace: '/repo' })
  })

  it('unwraps daemon command responses and surfaces explicit errors', () => {
    const status = { workspace: '/repo', isGitRepo: true, lastCheckedAt: 1 }
    const diffSummary = { workspace: '/repo', isGitRepo: true, files: [], lastCheckedAt: 1 }
    const diffFile = {
      workspace: '/repo',
      isGitRepo: true,
      path: 'src/app.ts',
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+new line',
      binary: false,
      truncated: true,
      lastCheckedAt: 1,
    }

    expect(readGitStatusCommandResponse({ result: { success: true, status } })).toEqual({ status, error: null })
    expect(readGitDiffSummaryCommandResponse({ result: { success: true, diffSummary } })).toEqual({ diffSummary, error: null })
    expect(readGitDiffFileCommandResponse({ result: { success: true, diff: diffFile } })).toEqual({ diff: diffFile, error: null })
    expect(readGitDiffFileCommandResponse({ success: true, diff: diffFile })).toEqual({ diff: diffFile, error: null })
    expect(readGitStatusCommandResponse({ result: { success: false, error: 'not a repo' } })).toEqual({ status: null, error: 'not a repo' })
    expect(readGitDiffSummaryCommandResponse({ result: { success: false, error: 'diff failed' } })).toEqual({ diffSummary: null, error: 'diff failed' })
    expect(readGitDiffFileCommandResponse({ result: { success: false, error: 'file diff failed' } })).toEqual({ diff: null, error: 'file diff failed' })
    expect(readGitDiffFileCommandResponse({ result: { success: true, diff: 'raw patch text' } })).toEqual({
      diff: null,
      error: 'Git file diff response did not include a valid diff object',
    })
    expect(readGitDiffFileCommandResponse({ result: { success: true, diff: { ...diffFile, binary: 'false' } } })).toEqual({
      diff: null,
      error: 'Git file diff response did not include a valid diff object',
    })
  })
})
