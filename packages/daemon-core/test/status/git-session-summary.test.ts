import { describe, expect, it, vi } from 'vitest'
import { buildSessionEntries } from '../../src/status/builders.js'
import { buildStatusSnapshot } from '../../src/status/snapshot.js'
import type { GitCompactSummary } from '../../src/git/git-types.js'

const gitSummary: GitCompactSummary = {
  isGitRepo: true,
  repoRoot: '/repo',
  branch: 'main',
  dirty: true,
  changedFiles: 3,
  ahead: 1,
  behind: 0,
  hasConflicts: false,
  lastCheckedAt: 123,
}

function cliState(workspace = '/repo') {
  return {
    category: 'cli',
    type: 'codex',
    name: 'Codex',
    instanceId: 'cli-1',
    status: 'idle',
    workspace,
    mode: 'chat',
    activeChat: null,
    controlValues: {},
    providerControls: undefined,
  } as any
}

describe('Git compact summaries in status sessions', () => {
  it('attaches cached compact Git summaries to sessions with workspaces without running Git in the builder', () => {
    const getGitSummaryForWorkspace = vi.fn((workspace: string) => workspace === '/repo' ? gitSummary : null)

    const sessions = buildSessionEntries([
      cliState('/repo'),
      cliState('/not-a-repo'),
    ], new Map(), { profile: 'live', getGitSummaryForWorkspace })

    expect(getGitSummaryForWorkspace).toHaveBeenCalledWith('/repo')
    expect(getGitSummaryForWorkspace).toHaveBeenCalledWith('/not-a-repo')
    expect(sessions.find((session) => session.id === 'cli-1')?.git).toEqual(gitSummary)
    expect(sessions.find((session) => session.workspace === '/not-a-repo')).not.toHaveProperty('git')
  })

  it('passes the Git summary resolver through buildStatusSnapshot', () => {
    const getGitSummaryForWorkspace = vi.fn(() => gitSummary)

    const snapshot = buildStatusSnapshot({
      allStates: [cliState('/repo')],
      cdpManagers: new Map(),
      providerLoader: { getAll: () => [] },
      detectedIdes: [],
      instanceId: 'machine-1',
      version: '0.0.0',
      profile: 'live',
      getGitSummaryForWorkspace,
    })

    expect(snapshot.sessions[0]?.git).toEqual(gitSummary)
    expect(getGitSummaryForWorkspace).toHaveBeenCalledWith('/repo')
  })
})
