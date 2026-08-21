import { promisify } from 'node:util'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveWorktreePath,
  resolveWorktreeBaseDir,
  getDefaultWorktreeBaseDir,
} from '../../src/git/git-worktree'
import { resolveConfigDir } from '../../src/config/config-dir'

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
  it('defaults the base to <configDir>/worktrees, namespaced by mesh + branch', () => {
    // Derived from resolveConfigDir, not a literal '.adhdev': asserting the
    // literal here is what let the track bug (below) sit unnoticed.
    expect(getDefaultWorktreeBaseDir()).toBe(path.join(resolveConfigDir(), 'worktrees'))
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

describe('worktree base directory follows the build track', () => {
  // The base joined '.adhdev' literally, so a PREVIEW daemon put its worktrees
  // in the STABLE config dir. Nothing errored (the dir exists on both tracks),
  // so both tracks' worktrees silently pooled in one tree — observed live on a
  // preview daemon (19223) whose worktrees all sat under ~/.adhdev/worktrees.
  //
  // getDefaultWorktreeBaseDir() reads process.env per call, so the track is
  // selected by env here — no production code is bent for the test.
  const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      return fn()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  // ADHDEV_CONFIG_DIR outranks the track in resolveConfigDir, so it must be
  // cleared for these to measure the track rather than an ambient override.
  //
  // Clearing it is exactly what the un-pinned-config-dir gate in resolveConfigDir()
  // fires on, so VITEST/NODE_ENV are stood down for the duration of the call. That is
  // safe here and ONLY here because these cases compute a path string and assert on
  // it -- getDefaultWorktreeBaseDir() does no mkdir/read/write, so no live
  // ~/.adhdev(-preview) state is touched. Do not copy this stand-down into a test
  // that actually touches the resolved dir; pin ADHDEV_CONFIG_DIR to a tmp dir there.
  const onTrack = (track: string) =>
    withEnv(
      { ADHDEV_BUILD_CHANNEL: track, ADHDEV_CONFIG_DIR: undefined, VITEST: undefined, NODE_ENV: undefined },
      () => getDefaultWorktreeBaseDir(),
    )

  it('uses the preview config dir on the preview track (the regression: it used the stable dir)', () => {
    expect(onTrack('preview')).toBe(path.join(os.homedir(), '.adhdev-preview', 'worktrees'))
  })

  it('uses the stable config dir on the stable track', () => {
    expect(onTrack('stable')).toBe(path.join(os.homedir(), '.adhdev', 'worktrees'))
  })

  it('keeps the two tracks in separate trees', () => {
    // The actual isolation property, independent of the literal dir names.
    expect(onTrack('preview')).not.toBe(onTrack('stable'))
  })

  it('agrees with resolveConfigDir on each track rather than restating dir names', () => {
    for (const track of ['preview', 'stable']) {
      // Same stand-down rationale as onTrack() above: resolveConfigDir() is called
      // for its return value only, so nothing under the resolved dir is touched.
      const expected = withEnv(
        { ADHDEV_BUILD_CHANNEL: track, ADHDEV_CONFIG_DIR: undefined, VITEST: undefined, NODE_ENV: undefined },
        () => path.join(resolveConfigDir(), 'worktrees'),
      )
      expect(onTrack(track)).toBe(expected)
    }
  })

  it('honors ADHDEV_CONFIG_DIR so worktrees stay with the rest of the daemon state', () => {
    const custom = path.join(os.tmpdir(), 'adhdev-cfg-probe')
    expect(withEnv({ ADHDEV_CONFIG_DIR: custom, ADHDEV_BUILD_CHANNEL: 'preview' }, getDefaultWorktreeBaseDir))
      .toBe(path.join(custom, 'worktrees'))
  })
})
