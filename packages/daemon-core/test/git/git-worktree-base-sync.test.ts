import { promisify } from 'node:util'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveWorktreePath,
  resolveWorktreeBaseDir,
  getDefaultWorktreeBaseDir,
} from '../../src/git/git-worktree'

type ExecResult = {
  stdout?: string
  stderr?: string
  message?: string
  error?: boolean
}

/**
 * Load createWorktree with a queue of canned git results and a stubbed fs so the
 * stale-base resolution (fetch + behind/ahead/diverge compare) can be exercised
 * without a real repo. `targetDir` is reported as non-existent so create proceeds.
 */
async function loadCreateWorktree(results: ExecResult[]) {
  vi.resetModules()
  const calls: Array<{ args: string[]; cwd?: string }> = []
  const handle = (args: string[], opts: any) => {
    calls.push({ args, cwd: opts?.cwd })
    const next = results.shift() || {}
    if (next.error) {
      const error: any = new Error(next.message || next.stderr || 'git failed')
      error.stderr = next.stderr || ''
      error.stdout = next.stdout || ''
      throw error
    }
    return { stdout: next.stdout || '', stderr: next.stderr || '' }
  }
  const execFileMock: any = vi.fn((command: string, args: string[], opts: any, callback: Function) => {
    try {
      const r = handle(args, opts)
      callback(null, r.stdout, r.stderr)
    } catch (e: any) {
      callback(e, e.stdout || '', e.stderr || '')
    }
  })
  execFileMock[promisify.custom] = async (_command: string, args: string[], opts: any) => handle(args, opts)

  vi.doMock('node:child_process', () => ({ execFile: execFileMock }))
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, existsSync: () => false }
  })
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, mkdir: async () => undefined }
  })

  const mod = await import('../../src/git/git-worktree')
  return { createWorktree: mod.createWorktree, calls }
}

const lastAdd = (calls: Array<{ args: string[] }>) =>
  calls.map(c => c.args).find(a => a[0] === 'worktree' && a[1] === 'add')

describe('createWorktree stale-base resolution', () => {
  it('branches from origin/<branch> when local base is strictly behind remote', async () => {
    // fetch ok; local=AAA, remote=BBB; local IS ancestor of remote (behind), remote NOT ancestor of local.
    const { createWorktree, calls } = await loadCreateWorktree([
      { stdout: '' },                              // fetch origin main
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' }, // rev-parse local
      { stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' }, // rev-parse remote
      { stdout: '' },                              // merge-base --is-ancestor local remote (ok → behind)
      { error: true, stderr: '' },                 // merge-base --is-ancestor remote local (fail)
      { stdout: '1\n' },                           // rev-list --count local..remote (behindBy)
      { stdout: '0\n' },                           // rev-list --count remote..local (aheadBy)
      { stdout: '' },                              // worktree add
    ])

    const result = await createWorktree({ repoRoot: '/repo', branch: 'task/x', baseBranch: 'main', meshName: 'm' })

    expect(result.baseSync).toMatchObject({
      action: 'local_behind_used_remote',
      startRef: 'origin/main',
      behindBy: 1,
      aheadBy: 0,
      fetched: true,
    })
    expect(result.baseSync?.warning).toMatch(/behind origin\/main by 1/)
    // The worktree was branched from the remote tip, NOT the stale local main.
    expect(lastAdd(calls)).toEqual(['worktree', 'add', expect.any(String), '-b', 'task/x', 'origin/main'])
  })

  it('branches from local base when up-to-date with remote', async () => {
    const sha = 'cccccccccccccccccccccccccccccccccccccccc'
    const { createWorktree, calls } = await loadCreateWorktree([
      { stdout: '' },              // fetch
      { stdout: `${sha}\n` },      // local
      { stdout: `${sha}\n` },      // remote (equal)
      { stdout: '' },              // worktree add
    ])

    const result = await createWorktree({ repoRoot: '/repo', branch: 'task/y', baseBranch: 'main', meshName: 'm' })

    expect(result.baseSync).toMatchObject({ action: 'up_to_date', startRef: 'main' })
    expect(result.baseSync?.warning).toBeUndefined()
    expect(lastAdd(calls)).toEqual(['worktree', 'add', expect.any(String), '-b', 'task/y', 'main'])
  })

  it('keeps local + warns when base has diverged from remote', async () => {
    const { createWorktree, calls } = await loadCreateWorktree([
      { stdout: '' },                              // fetch
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' }, // local
      { stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' }, // remote
      { error: true, stderr: '' },                 // is-ancestor local remote (fail)
      { error: true, stderr: '' },                 // is-ancestor remote local (fail) → diverged
      { stdout: '2\n' },                           // behindBy
      { stdout: '3\n' },                           // aheadBy
      { stdout: '' },                              // worktree add
    ])

    const result = await createWorktree({ repoRoot: '/repo', branch: 'task/z', baseBranch: 'main', meshName: 'm' })

    expect(result.baseSync).toMatchObject({ action: 'diverged_used_local', startRef: 'main', behindBy: 2, aheadBy: 3 })
    expect(result.baseSync?.warning).toMatch(/DIVERGED/)
    expect(lastAdd(calls)).toEqual(['worktree', 'add', expect.any(String), '-b', 'task/z', 'main'])
  })

  it('surfaces a warning and uses local when fetch fails and no remote ref exists', async () => {
    const { createWorktree, calls } = await loadCreateWorktree([
      { error: true, stderr: 'fatal: unable to access remote' }, // fetch fails
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' },  // local
      { error: true, stderr: '' },                                // remote rev-parse fails (no tracking ref)
      { stdout: '' },                                             // worktree add
    ])

    const result = await createWorktree({ repoRoot: '/repo', branch: 'task/w', baseBranch: 'main', meshName: 'm' })

    expect(result.baseSync).toMatchObject({ action: 'no_remote_ref_used_local', startRef: 'main', fetched: false })
    expect(result.baseSync?.warning).toMatch(/git fetch origin main failed/)
    expect(lastAdd(calls)).toEqual(['worktree', 'add', expect.any(String), '-b', 'task/w', 'main'])
  })

  it('does not fetch or resolve when syncBaseFromRemote is disabled', async () => {
    const { createWorktree, calls } = await loadCreateWorktree([
      { stdout: '' }, // worktree add only
    ])

    const result = await createWorktree({ repoRoot: '/repo', branch: 'task/legacy', baseBranch: 'main', meshName: 'm', syncBaseFromRemote: false })

    expect(result.baseSync).toBeUndefined()
    expect(calls.map(c => c.args[0])).toEqual(['worktree'])
    expect(lastAdd(calls)).toEqual(['worktree', 'add', expect.any(String), '-b', 'task/legacy', 'main'])
  })
})

describe('resolveWorktreePath base directory', () => {
  it('defaults the base to <home>/.adhdev/worktrees, namespaced by mesh + branch', () => {
    expect(getDefaultWorktreeBaseDir()).toBe(path.join(os.homedir(), '.adhdev', 'worktrees'))
    // The base is home-derived, NOT dirname(repoRoot) as in the legacy layout.
    const resolved = resolveWorktreePath('/some/deep/repo', 'my mesh', 'feat/auth')
    expect(resolved).toBe(path.join(getDefaultWorktreeBaseDir(), 'my mesh', 'feat-auth'))
    expect(resolved.startsWith(getDefaultWorktreeBaseDir())).toBe(true)
    // repoRoot no longer contributes to the base path.
    expect(resolved).not.toContain('/some/deep')
  })

  it('sanitizes mesh + branch segments for the filesystem', () => {
    const resolved = resolveWorktreePath('/repo', 'Team/Mesh', 'feat/auth:v2')
    expect(resolved).toBe(path.join(getDefaultWorktreeBaseDir(), 'Team-Mesh', 'feat-auth-v2'))
  })

  it('honors a worktreeBaseDir override for the base', () => {
    const override = path.join('/custom', 'wt-base')
    const resolved = resolveWorktreePath('/repo', 'm', 'feat/x', override)
    expect(resolved).toBe(path.join(override, 'm', 'feat-x'))
    expect(resolved.startsWith(override)).toBe(true)
    expect(resolved.startsWith(getDefaultWorktreeBaseDir())).toBe(false)
  })

  it('resolveWorktreeBaseDir falls back to the home default for missing/blank overrides', () => {
    expect(resolveWorktreeBaseDir(undefined)).toBe(getDefaultWorktreeBaseDir())
    expect(resolveWorktreeBaseDir('')).toBe(getDefaultWorktreeBaseDir())
    expect(resolveWorktreeBaseDir('   ')).toBe(getDefaultWorktreeBaseDir())
    expect(resolveWorktreeBaseDir('/x/y')).toBe('/x/y')
  })
})
