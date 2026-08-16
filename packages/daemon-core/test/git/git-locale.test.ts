import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

import { gitChildEnv } from '../../src/git/git-locale'

const execFileAsync = promisify(execFileCb)

// ─── Unit: the env builder itself ───────────────────────────────────────────

describe('gitChildEnv', () => {
  it('pins every locale variable gettext consults, at C', () => {
    const env = gitChildEnv({ LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8', LANGUAGE: 'ko' })
    expect(env.LC_ALL).toBe('C')
    expect(env.LC_MESSAGES).toBe('C')
    expect(env.LANG).toBe('C')
    // GNU gettext consults LANGUAGE ahead of LC_ALL — an inherited value would
    // still translate, so it must be cleared, not merely overridden.
    expect(env.LANGUAGE).toBe('')
  })

  it('preserves the rest of the environment (PATH, auth, proxy) instead of replacing it', () => {
    const env = gitChildEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/dev',
      GIT_SSH_COMMAND: 'ssh -i /key',
      HTTPS_PROXY: 'http://proxy:3128',
      LANG: 'ko_KR.UTF-8',
    })
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/home/dev')
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /key')
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128')
  })

  it('does not mutate process.env — the daemon keeps its own locale for console output', () => {
    const before = process.env.LC_ALL
    gitChildEnv()
    expect(process.env.LC_ALL).toBe(before)
  })

  // WORKTREE-DELETED-WHILE-RUNNING: GIT_DIR/GIT_WORK_TREE override BOTH -C and
  // cwd, so an inherited value silently redirects git at another repository.
  // Through this env that reaches `git worktree remove --force`.
  it('strips every repo-location variable so -C/cwd decides the target repo', () => {
    const env = gitChildEnv({
      GIT_DIR: '/other/.git',
      GIT_WORK_TREE: '/other',
      GIT_COMMON_DIR: '/other/.git',
      GIT_INDEX_FILE: '/other/.git/index',
      GIT_OBJECT_DIRECTORY: '/other/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/objects',
      GIT_NAMESPACE: 'ns',
      GIT_PREFIX: 'sub/',
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_COMMON_DIR).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined()
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined()
    expect(env.GIT_NAMESPACE).toBeUndefined()
    expect(env.GIT_PREFIX).toBeUndefined()
  })

  it('keeps auth/transport GIT_* vars — stripping those would break fetch/push', () => {
    const env = gitChildEnv({
      GIT_DIR: '/other/.git',
      GIT_SSH_COMMAND: 'ssh -i /key',
      GIT_ASKPASS: '/usr/bin/askpass',
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /key')
    expect(env.GIT_ASKPASS).toBe('/usr/bin/askpass')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})

// ─── Regression: the data-loss shape, against real git ───────────────────────
//
// The defect that destroyed a live worktree, reproduced end to end. With
// GIT_DIR/GIT_WORK_TREE inherited from repo A, a removal explicitly aimed at
// repo B (`git -C B worktree remove --force ...`) acts on A instead — deleting
// A's worktree and de-registering it cleanly, so no stale registration is left
// behind to hint at what happened.
//
// Both halves are asserted: that raw git really does behave this way (the
// hazard is real, not theoretical), and that a spawn using gitChildEnv() is
// immune to it (the fix actually closes it).

describe('inherited GIT_DIR redirects destructive git at the wrong repo (real git)', () => {
  let root = ''
  let available = false

  beforeAll(async () => {
    available = await hasSubmoduleSupport()
    if (available) root = await mkdtemp(join(tmpdir(), 'adhdev-gitdir-'))
  }, 60_000)

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  const initRepo = async (dir: string) => {
    await execFileAsync('git', ['init', '-q', '-b', 'main', dir])
    await writeFile(join(dir, 'f.txt'), 'x\n')
    await execFileAsync('git', ['add', '-A'], { cwd: dir })
    await execFileAsync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: dir })
  }

  it('deletes repo A\'s worktree when the command targeted repo B — and gitChildEnv prevents it', async () => {
    if (!available) return
    const { existsSync } = await import('node:fs')

    const repoA = join(root, 'repoA')
    const repoB = join(root, 'repoB')
    await initRepo(repoA)
    await initRepo(repoB)

    const wtVictim = join(root, 'wt-victim')
    await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'victim', wtVictim], { cwd: repoA })
    expect(existsSync(wtVictim)).toBe(true)

    // The hazard: contaminated env + a command aimed at repoB deletes repoA's worktree.
    await execFileAsync('git', ['-C', repoB, 'worktree', 'remove', '--force', wtVictim], {
      env: { ...process.env, GIT_DIR: join(repoA, '.git'), GIT_WORK_TREE: repoA },
    })
    expect(existsSync(wtVictim)).toBe(false)

    // ...and it leaves NO stale registration — the forensic signature of the
    // incident (directory gone, `worktree list` clean, `prune` a no-op).
    const { stdout: pruneOut } = await execFileAsync('git', ['worktree', 'prune', '--dry-run', '-v'], { cwd: repoA })
    expect(pruneOut.trim()).toBe('')

    // The fix: the same contaminated parent env, sanitized by gitChildEnv, now
    // honors -C — so the removal is scoped to repoB and repoA's worktree lives.
    const wtSurvivor = join(root, 'wt-survivor')
    await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'survivor', wtSurvivor], { cwd: repoA })
    expect(existsSync(wtSurvivor)).toBe(true)

    await execFileAsync('git', ['-C', repoB, 'worktree', 'remove', '--force', wtSurvivor], {
      env: gitChildEnv({ ...process.env, GIT_DIR: join(repoA, '.git'), GIT_WORK_TREE: repoA }),
    }).catch(() => {
      // repoB legitimately does not own this path, so git refuses — which is
      // exactly the point: the command can no longer reach into repoA.
    })
    expect(existsSync(wtSurvivor)).toBe(true)
  }, 120_000)
})

// ─── Wiring: every git spawn in git-worktree carries the pinned env ──────────

type ExecResult = { stdout?: string; stderr?: string; message?: string; error?: boolean }

async function loadWorktreeWithExec(results: ExecResult[]) {
  vi.resetModules()
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
  const run = (args: string[], opts: any) => {
    calls.push({ args, env: opts?.env })
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
      const r = run(args, opts)
      callback(null, r.stdout, r.stderr)
    } catch (e: any) {
      callback(e, e.stdout || '', e.stderr || '')
    }
  })
  execFileMock[promisify.custom] = async (_c: string, args: string[], opts: any) => run(args, opts)

  vi.doMock('node:child_process', () => ({ execFile: execFileMock }))
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, existsSync: () => true }
  })

  const mod = await import('../../src/git/git-worktree')
  return { mod, calls }
}

describe('git-worktree spawns with a pinned locale', () => {
  it('passes LC_ALL=C to every git invocation on the remove path, including the force fallback', async () => {
    const { mod, calls } = await loadWorktreeWithExec([
      { stdout: '' },
      { error: true, stderr: 'fatal: working trees containing submodules cannot be moved or removed\n' },
      { stdout: '' },
    ])

    await mod.removeWorktree('/repo', '/repo/wt/mesh/branch', {
      requireClean: true,
      allowSubmoduleForceFallback: true,
    })

    expect(calls.length).toBe(3)
    for (const call of calls) {
      expect(call.env, `git ${call.args.join(' ')} spawned without a pinned env`).toBeDefined()
      expect(call.env!.LC_ALL).toBe('C')
      expect(call.env!.LANGUAGE).toBe('')
    }
    // PATH must survive — a replaced env would break git resolution entirely.
    expect(calls[0].env!.PATH).toBe(process.env.PATH)
  })
})

// ─── Regression: Korean stderr must never reach the matcher ─────────────────
//
// The defect in one assertion, runnable on every machine (no gettext catalog
// required). If a git spawned by removeWorktree were to answer in Korean, the
// English-only submodule regex would miss and a recoverable cleanup would
// hard-throw. Pinning the child locale is what makes that unreachable — so we
// assert the pin is present on the exact spawn whose stderr is matched.
//
// This complements the real-git test below, which needs a translated git.

describe('the submodule-guard matcher is never handed translated stderr', () => {
  it('would miss the Korean phrasing — which is why the spawn must pin the locale', async () => {
    // Ground truth: git's Korean translation of the submodule-worktree guard.
    const koreanStderr = 'fatal: 하위 모듈이 포함된 작업 폴더는 옮기거나 제거할 수 없습니다\n'
    const englishStderr = 'fatal: working trees containing submodules cannot be moved or removed\n'
    const matcher = /working trees containing submodules cannot be moved or removed/i

    expect(matcher.test(englishStderr)).toBe(true)
    // The precise reason the live Refinery run ended in merged_cleanup_failed.
    expect(matcher.test(koreanStderr)).toBe(false)

    // Therefore the remove spawn — the one whose stderr feeds `matcher` — must
    // carry the C-locale pin, or the Korean branch above becomes reachable.
    const { mod, calls } = await loadWorktreeWithExec([
      { error: true, stderr: englishStderr },
      { stdout: '' },
    ])
    await mod.removeWorktree('/repo', '/repo/wt/mesh/branch', { allowSubmoduleForceFallback: true })
    const removeCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')
    expect(removeCall?.env?.LC_ALL).toBe('C')
  })
})

// ─── Regression: the actual defect, against real git ────────────────────────
//
// This is the guard that matters. `removeWorktree` decides whether to run the
// submodule force-fallback by matching git's stderr against an ENGLISH phrase.
// Under a Korean locale git emits
//   `fatal: 하위 모듈이 포함된 작업 폴더는 옮기거나 제거할 수 없습니다`
// the regex misses, and a recoverable cleanup hard-throws (observed live as
// Refinery `merged_cleanup_failed`).
//
// We drive real git with LANG/LC_ALL/LANGUAGE set to Korean in the PARENT env.
// If removeWorktree did not pin the child locale, the child would inherit
// Korean and the fallback would not fire. Pinning makes the outcome
// locale-independent, which is what we assert.
//
// Skipped when the local git has no Korean catalog (e.g. Apple Git is built
// without gettext, so it always answers in English and the test would pass
// vacuously) — the assertion is still meaningful wherever translations exist.

const hasSubmoduleSupport = async (): Promise<boolean> => {
  try {
    await execFileAsync('git', ['--version'])
    return true
  } catch {
    return false
  }
}

async function gitTranslatesToKorean(): Promise<boolean> {
  try {
    const { stderr } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: tmpdir(),
      env: { ...process.env, LANGUAGE: 'ko', LC_ALL: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8' },
    }).then(
      (r) => r,
      (e: any) => ({ stderr: String(e?.stderr || '') }),
    )
    return /[가-힣]/.test(stderr)
  } catch {
    return false
  }
}

describe('removeWorktree submodule fallback under a non-English locale (real git)', () => {
  let root = ''
  let available = false
  let translates = false

  beforeAll(async () => {
    available = await hasSubmoduleSupport()
    if (!available) return
    translates = await gitTranslatesToKorean()
    root = await mkdtemp(join(tmpdir(), 'adhdev-locale-'))
  }, 60_000)

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('removes a worktree containing a submodule regardless of the ambient locale', async () => {
    if (!available) return
    if (!translates) {
      // git has no Korean catalog here; the scenario cannot be reproduced.
      return
    }

    const g = async (cwd: string, args: string[]) =>
      execFileAsync('git', args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })

    // A submodule origin repo.
    const subOrigin = join(root, 'sub-origin')
    await execFileAsync('git', ['init', '-q', '--bare', subOrigin])
    const subWork = join(root, 'sub-work')
    await execFileAsync('git', ['clone', '-q', subOrigin, subWork])
    await writeFile(join(subWork, 'f.txt'), 'hello\n')
    await g(subWork, ['add', '-A'])
    await g(subWork, ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'])
    await g(subWork, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])

    // The superproject, with that submodule.
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo])
    await writeFile(join(repo, 'readme.md'), 'x\n')
    await g(repo, ['add', '-A'])
    await g(repo, ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'])
    await g(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'sub'])
    await g(repo, ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'add submodule'])

    // A worktree that contains the submodule — the case git refuses to remove.
    const wt = join(root, 'wt')
    await g(repo, ['worktree', 'add', '-q', wt, '-b', 'feature'])
    await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'], {
      cwd: wt,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })

    // Simulate the owner's environment: Korean locale in the PARENT process.
    const savedLang = process.env.LANG
    const savedLcAll = process.env.LC_ALL
    const savedLanguage = process.env.LANGUAGE
    process.env.LANG = 'ko_KR.UTF-8'
    process.env.LC_ALL = 'ko_KR.UTF-8'
    process.env.LANGUAGE = 'ko'

    try {
      vi.resetModules()
      const { removeWorktree } = await import('../../src/git/git-worktree')
      const result = await removeWorktree(repo, wt, { allowSubmoduleForceFallback: true })
      expect(result.success).toBe(true)
      expect(result.removedPath).toBe(wt)
    } finally {
      process.env.LANG = savedLang
      process.env.LC_ALL = savedLcAll
      process.env.LANGUAGE = savedLanguage
    }
  }, 120_000)
})
