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
  return { removeWorktree: mod.removeWorktree, calls, execFileMock }
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
