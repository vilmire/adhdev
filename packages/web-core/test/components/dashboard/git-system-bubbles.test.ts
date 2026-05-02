import { describe, expect, it } from 'vitest'
import type { GitCompactSummary, RecentSessionBucket } from '@adhdev/daemon-core'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import {
  buildGitSystemBubbleMessages,
  getGitSystemBubbleSummaryText,
} from '../../../src/components/dashboard/git-system-bubbles'

function git(overrides: Partial<GitCompactSummary> = {}): GitCompactSummary {
  return {
    isGitRepo: true,
    repoRoot: '/repo',
    branch: 'main',
    dirty: false,
    changedFiles: 0,
    ahead: 0,
    behind: 0,
    hasConflicts: false,
    lastCheckedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function conversation(overrides: Partial<ActiveConversation> & { inboxBucket?: RecentSessionBucket; completionMarker?: string } = {}): ActiveConversation {
  return {
    routeId: 'daemon-1',
    sessionId: 'session-1',
    daemonId: 'daemon-1',
    agentName: 'Hermes',
    agentType: 'hermes-cli',
    status: 'idle',
    title: 'Task',
    messages: [],
    workspaceName: 'repo',
    workspacePath: '/repo',
    git: git(),
    displayPrimary: 'Task',
    displaySecondary: 'Hermes',
    streamSource: 'native',
    tabKey: 'session-1',
    ...overrides,
  } as ActiveConversation
}

describe('git system bubbles', () => {
  it('is enabled by default and emits a work-start system bubble for git workspaces', () => {
    const messages = buildGitSystemBubbleMessages(conversation({ status: 'generating', git: git({ changedFiles: 2, dirty: true, ahead: 1 }) }))

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].kind).toBe('system')
    expect(messages[0].id).toBe('git-system:session-1:working')
    expect(messages[0].content).toContain('Git workspace')
    expect(messages[0].content).toContain('work started')
    expect(messages[0].content).toContain('main')
    expect(messages[0].content).toContain('2 files changed')
    expect(messages[0].content).toContain('ahead 1')
  })

  it('emits a completion system bubble from daemon completion state', () => {
    const messages = buildGitSystemBubbleMessages(conversation({
      status: 'idle',
      inboxBucket: 'task_complete',
      completionMarker: 'done-123',
      git: git({ changedFiles: 3, dirty: true, behind: 2 }),
    }))

    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe('git-system:session-1:complete:done-123')
    expect(messages[0].content).toContain('work completed')
    expect(messages[0].content).toContain('3 files changed')
    expect(messages[0].content).toContain('behind 2')
  })

  it('does not emit for non-git workspaces or when disabled', () => {
    expect(buildGitSystemBubbleMessages(conversation({ git: git({ isGitRepo: false, repoRoot: null }), status: 'generating' }))).toEqual([])
    expect(buildGitSystemBubbleMessages(conversation({ status: 'generating' }), { enabled: false })).toEqual([])
  })

  it('summarizes clean and conflict states without parsing transcript text', () => {
    expect(getGitSystemBubbleSummaryText(git())).toBe('main · clean')
    expect(getGitSystemBubbleSummaryText(git({ hasConflicts: true, changedFiles: 5 }))).toBe('main · 5 files changed · conflicts')
  })
})
