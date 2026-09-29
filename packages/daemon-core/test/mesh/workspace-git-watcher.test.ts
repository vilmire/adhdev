/**
 * The git-dir change detector against a REAL repository (git tier —
 * vitest.git-suites.mts): a commit / branch checkout / `git add` made from a
 * terminal fires one debounced callback; a linked worktree's `.git` file is
 * followed to its git dir; nothing fires while the checkout is idle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isGitStateTrigger, resolveWorkspaceGitDirs, watchWorkspaceGit } from '../../src/mesh/workspace-git-watcher'
import { cleanupTempDir } from '../helpers/temp-cleanup.js'

const execFileAsync = promisify(execFile)
const git = (cwd: string, ...args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true })

const dirs: string[] = []
const handles: Array<{ stop(): void }> = []
afterEach(async () => {
  for (const handle of handles.splice(0)) handle.stop()
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir)
})

async function repo(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'git-watch-')))
  dirs.push(dir)
  const root = join(dir, 'repo')
  await execFileAsync('git', ['init', '-b', 'main', root], { windowsHide: true })
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test User')
  await writeFile(join(root, 'README.md'), '# test\n')
  await git(root, 'add', 'README.md')
  await git(root, 'commit', '-m', 'init')
  return root
}

describe('workspace git watcher', () => {
  it('fires once (debounced) for a terminal commit, a branch checkout and a `git add`; stays silent while idle', async () => {
    const root = await repo()
    const onChange = vi.fn()
    const handle = watchWorkspaceGit(root, onChange, { debounceMs: 150 })
    expect(handle).not.toBeNull()
    handles.push(handle!)

    // macOS FSEvents may still deliver the fixture's own (pre-watch) writes once.
    await new Promise((resolve) => setTimeout(resolve, 400))
    onChange.mockClear()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(onChange).not.toHaveBeenCalled()

    await writeFile(join(root, 'a.txt'), 'a\n')
    await git(root, 'add', 'a.txt')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    await git(root, 'commit', '-m', 'from a terminal')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2), { timeout: 5_000 })

    await git(root, 'checkout', '-b', 'feature/x')
    await vi.waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 5_000 })

    // Editing a tracked file touches only the working tree — not the git dir.
    const before = onChange.mock.calls.length
    await writeFile(join(root, 'README.md'), '# edited\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(onChange.mock.calls.length).toBe(before)
  })

  it('follows a linked worktree to its own git dir and the shared refs', async () => {
    const root = await repo()
    const wt = join(root, '..', 'wt')
    await git(root, 'worktree', 'add', '-b', 'wt-branch', wt)
    const resolved = resolveWorkspaceGitDirs(wt)!
    expect(resolved.gitDir).toContain(join('.git', 'worktrees'))
    expect(realpathSync(resolved.commonDir)).toBe(realpathSync(join(root, '.git')))

    const onChange = vi.fn()
    const handle = watchWorkspaceGit(wt, onChange, { debounceMs: 150 })
    handles.push(handle!)
    await writeFile(join(wt, 'b.txt'), 'b\n')
    await git(wt, 'add', 'b.txt')
    await git(wt, 'commit', '-m', 'in the worktree')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000 })
  })

  it('returns null (caller keeps its periodic check) for a path that is not a checkout', () => {
    expect(watchWorkspaceGit('/definitely/not/a/checkout', () => {})).toBeNull()
    expect(resolveWorkspaceGitDirs('')).toBeNull()
  })

  it('filters lock files, reflogs and FETCH_HEAD', () => {
    expect(isGitStateTrigger('gitDir', 'HEAD')).toBe(true)
    expect(isGitStateTrigger('gitDir', 'index')).toBe(true)
    expect(isGitStateTrigger('gitDir', 'index.lock')).toBe(false)
    expect(isGitStateTrigger('gitDir', 'FETCH_HEAD')).toBe(false)
    expect(isGitStateTrigger('gitDir', 'logs/HEAD')).toBe(false)
    expect(isGitStateTrigger('refs', 'heads/main')).toBe(true)
    expect(isGitStateTrigger('refs', 'heads/main.lock')).toBe(false)
    expect(isGitStateTrigger('gitDir', null)).toBe(true)
  })
})
