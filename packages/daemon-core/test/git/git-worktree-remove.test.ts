import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

type ExecResult = {
  stdout?: string
  stderr?: string
  message?: string
  error?: boolean
}

async function loadWithExecResults(results: ExecResult[]) {
  vi.resetModules()
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
  const execFileMock: any = vi.fn((command: string, args: string[], opts: any, callback: Function) => {
    calls.push({ command, args, cwd: opts?.cwd })
    const next = results.shift() || {}
    if (next.error) {
      const error: any = new Error(next.message || next.stderr || 'git failed')
      error.stderr = next.stderr || ''
      error.stdout = next.stdout || ''
      callback(error, next.stdout || '', next.stderr || '')
      return
    }
    callback(null, next.stdout || '', next.stderr || '')
  })
  execFileMock[promisify.custom] = async (command: string, args: string[], opts: any) => {
    calls.push({ command, args, cwd: opts?.cwd })
    const next = results.shift() || {}
    if (next.error) {
      const error: any = new Error(next.message || next.stderr || 'git failed')
      error.stderr = next.stderr || ''
      error.stdout = next.stdout || ''
      throw error
    }
    return { stdout: next.stdout || '', stderr: next.stderr || '' }
  }

  vi.doMock('node:child_process', () => ({ execFile: execFileMock }))
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, existsSync: () => true }
  })

  const mod = await import('../../src/git/git-worktree')
  return { removeWorktree: mod.removeWorktree, deleteBranchRef: mod.deleteBranchRef, calls, execFileMock }
}

describe('removeWorktree submodule fallback', () => {
  it('retries with git worktree remove --force only for the submodule worktree failure when explicitly allowed', async () => {
    const { removeWorktree, calls } = await loadWithExecResults([
      { stdout: '' },
      { error: true, stderr: 'fatal: working trees containing submodules cannot be moved or removed\n' },
      { stdout: '' },
    ])

    const result = await removeWorktree('/repo', '/repo/.adhdev-worktrees/mesh/branch', {
      requireClean: true,
      allowSubmoduleForceFallback: true,
    })

    expect(result).toMatchObject({
      success: true,
      removedPath: '/repo/.adhdev-worktrees/mesh/branch',
      fallback: 'git_worktree_remove_force_submodule',
      forced: true,
      reason: 'working_trees_containing_submodules',
    })
    expect(calls.map(call => call.args)).toEqual([
      ['status', '--porcelain'],
      ['worktree', 'remove', '/repo/.adhdev-worktrees/mesh/branch'],
      ['worktree', 'remove', '--force', '/repo/.adhdev-worktrees/mesh/branch'],
    ])
  })

  it('does not force-remove a dirty worktree even when the submodule fallback is enabled', async () => {
    const { removeWorktree, calls } = await loadWithExecResults([
      { stdout: '?? dirty.txt\n' },
    ])

    await expect(removeWorktree('/repo', '/repo/.adhdev-worktrees/mesh/branch', {
      requireClean: true,
      allowSubmoduleForceFallback: true,
    })).rejects.toThrow('Refusing to remove dirty worktree')

    expect(calls.map(call => call.args)).toEqual([
      ['status', '--porcelain'],
    ])
  })

  it('does not force-remove unrelated git worktree remove failures', async () => {
    const { removeWorktree, calls } = await loadWithExecResults([
      { stdout: '' },
      { error: true, stderr: 'fatal: not a git repository or worktree\n' },
    ])

    await expect(removeWorktree('/repo', '/repo/.adhdev-worktrees/mesh/branch', {
      requireClean: true,
      allowSubmoduleForceFallback: true,
    })).rejects.toThrow('git worktree remove failed: fatal: not a git repository or worktree')

    expect(calls.map(call => call.args)).toEqual([
      ['status', '--porcelain'],
      ['worktree', 'remove', '/repo/.adhdev-worktrees/mesh/branch'],
    ])
  })
})

describe('deleteBranchRef (worktree branch-ref leak fix)', () => {
  it('safe-deletes a merged branch ref via git branch -d', async () => {
    const { deleteBranchRef, calls } = await loadWithExecResults([
      { stdout: 'abc123\n' },     // rev-parse --verify refs/heads/<branch> (ref exists)
      { stdout: "Deleted branch fix/foo (was abc123).\n" }, // branch -d succeeds
    ])

    const res = await deleteBranchRef('/repo', 'fix/foo')

    expect(res).toEqual({ deleted: true, reason: 'safe_deleted_merged_branch' })
    expect(calls.map(c => c.args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/fix/foo'],
      ['branch', '-d', 'fix/foo'],
    ])
  })

  it('preserves an unmerged branch ref (safe -d refuses, no -D when safeDeleteOnly)', async () => {
    const { deleteBranchRef, calls } = await loadWithExecResults([
      { stdout: 'abc123\n' },     // ref exists
      { error: true, stderr: "error: The branch 'fix/bar' is not fully merged.\n" }, // -d refuses
    ])

    const res = await deleteBranchRef('/repo', 'fix/bar', { safeDeleteOnly: true })

    expect(res).toEqual({ deleted: false, reason: 'branch_not_merged_per_git_safe_delete_only' })
    // Crucially: NO `git branch -D` was issued — unmerged work is never dropped.
    expect(calls.map(c => c.args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/fix/bar'],
      ['branch', '-d', 'fix/bar'],
    ])
  })

  it('force-deletes a patch-equivalent branch (-d refuses but containment was proven)', async () => {
    const { deleteBranchRef, calls } = await loadWithExecResults([
      { stdout: 'abc123\n' },     // ref exists
      { error: true, stderr: "error: The branch 'fix/squashed' is not fully merged.\n" }, // -d refuses (squash)
      { stdout: "Deleted branch fix/squashed (was abc123).\n" }, // -D succeeds
    ])

    const res = await deleteBranchRef('/repo', 'fix/squashed', { safeDeleteOnly: false })

    expect(res).toEqual({ deleted: true, reason: 'force_deleted_patch_equivalent_branch', forced: true })
    expect(calls.map(c => c.args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/fix/squashed'],
      ['branch', '-d', 'fix/squashed'],
      ['branch', '-D', 'fix/squashed'],
    ])
  })

  it('is idempotent when the branch ref is already absent', async () => {
    const { deleteBranchRef, calls } = await loadWithExecResults([
      { error: true, stderr: '' }, // rev-parse --verify fails → ref absent
    ])

    const res = await deleteBranchRef('/repo', 'fix/gone')

    expect(res).toEqual({ deleted: true, reason: 'branch_ref_absent' })
    expect(calls.map(c => c.args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/fix/gone'],
    ])
  })
})
