import { describe, expect, it } from 'vitest'
import {
  getGitStatusPillLabel,
  getGitStatusPillTone,
} from '../../../src/components/git/GitStatusPill'
import type { GitCompactSummary } from '@adhdev/daemon-core'

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
    lastCheckedAt: 1,
    ...overrides,
  }
}

describe('GitStatusPill helpers', () => {
  it('stays quiet for missing or non-repository git summaries', () => {
    expect(getGitStatusPillLabel(null)).toBeNull()
    expect(getGitStatusPillTone(null)).toBeNull()
    expect(getGitStatusPillLabel(git({ isGitRepo: false, reason: 'not_git_repo' }))).toBeNull()
    expect(getGitStatusPillTone(git({ isGitRepo: false, reason: 'not_git_repo' }))).toBeNull()
  })

  it('prioritizes conflict state over dirty and ahead/behind state', () => {
    const conflicted = git({ hasConflicts: true, dirty: true, changedFiles: 4, ahead: 2, behind: 1 })

    expect(getGitStatusPillTone(conflicted)).toBe('conflict')
    expect(getGitStatusPillLabel(conflicted)).toBe('main · conflicts 4')
  })

  it('summarizes dirty, ahead, and behind counts without fetching diff bodies', () => {
    expect(getGitStatusPillTone(git({ dirty: true, changedFiles: 3, ahead: 1, behind: 2 }))).toBe('dirty')
    expect(getGitStatusPillLabel(git({ dirty: true, changedFiles: 3, ahead: 1, behind: 2 }))).toBe('main ±3 ↑1 ↓2')
    expect(getGitStatusPillTone(git())).toBe('quiet')
    expect(getGitStatusPillLabel(git())).toBe('main')
  })
})
