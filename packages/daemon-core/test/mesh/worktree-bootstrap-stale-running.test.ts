import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWin32Executable } from '../../src/cli-adapters/resolve-executable.js'
import {
  isWorktreeBootstrapStaleRunning,
  evaluateWorktreeBootstrapState,
  WORKTREE_BOOTSTRAP_STALE_RUNNING_MS,
  type WorktreeBootstrapState,
} from '../../src/mesh/worktree-bootstrap-config.js'

const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git'

// Fix (3) safety net: a worktree node stuck 'running' far past any real bootstrap whose
// working tree is git-clean is downgraded so a dispatch is allowed (its terminal-state stamp
// likely never reached this daemon). The git-clean co-requirement keeps a genuinely
// in-progress bootstrap (which must keep deferring) gated.
describe('Fix (3) — isWorktreeBootstrapStaleRunning backstop', () => {
  let cleanRepo: string
  let dirtyRepo: string
  const STARTED = '2026-01-01T00:00:00.000Z'
  const startedMs = Date.parse(STARTED)
  const stale = startedMs + WORKTREE_BOOTSTRAP_STALE_RUNNING_MS + 60_000
  const fresh = startedMs + 60_000

  const git = (cwd: string, args: string[]) =>
    execFileSync(GIT, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' })

  beforeAll(() => {
    cleanRepo = mkdtempSync(join(tmpdir(), 'adhdev-wt-clean-'))
    git(cleanRepo, ['init', '-q'])
    git(cleanRepo, ['config', 'user.email', 'test@example.com'])
    git(cleanRepo, ['config', 'user.name', 'Test'])
    writeFileSync(join(cleanRepo, 'a.txt'), 'hello\n')
    git(cleanRepo, ['add', '-A'])
    git(cleanRepo, ['commit', '-q', '-m', 'init'])

    dirtyRepo = mkdtempSync(join(tmpdir(), 'adhdev-wt-dirty-'))
    git(dirtyRepo, ['init', '-q'])
    git(dirtyRepo, ['config', 'user.email', 'test@example.com'])
    git(dirtyRepo, ['config', 'user.name', 'Test'])
    writeFileSync(join(dirtyRepo, 'a.txt'), 'hello\n')
    git(dirtyRepo, ['add', '-A'])
    git(dirtyRepo, ['commit', '-q', '-m', 'init'])
    // Leave an untracked file so `git status --porcelain` is non-empty (dirty).
    writeFileSync(join(dirtyRepo, 'untracked.txt'), 'wip\n')
  })

  afterAll(() => {
    for (const dir of [cleanRepo, dirtyRepo]) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('returns false when bootstrap is not running', () => {
    const node = { worktreeBootstrap: { status: 'complete', startedAt: STARTED }, workspace: cleanRepo }
    expect(isWorktreeBootstrapStaleRunning(node, stale)).toBe(false)
  })

  it('returns false for a running bootstrap that is still within the stale window (genuinely in progress)', () => {
    const node = { worktreeBootstrap: { status: 'running', startedAt: STARTED }, workspace: cleanRepo }
    expect(isWorktreeBootstrapStaleRunning(node, fresh)).toBe(false)
  })

  it('returns true for a stale running bootstrap whose worktree is git-clean', () => {
    const node = { worktreeBootstrap: { status: 'running', startedAt: STARTED }, workspace: cleanRepo }
    expect(isWorktreeBootstrapStaleRunning(node, stale)).toBe(true)
  })

  it('returns false for a stale running bootstrap whose worktree is DIRTY (must keep deferring)', () => {
    const node = { worktreeBootstrap: { status: 'running', startedAt: STARTED }, workspace: dirtyRepo }
    expect(isWorktreeBootstrapStaleRunning(node, stale)).toBe(false)
  })

  it('returns false when the workspace does not exist on disk (cannot verify clean-ness)', () => {
    const node = { worktreeBootstrap: { status: 'running', startedAt: STARTED }, workspace: join(tmpdir(), 'adhdev-nonexistent-xyz') }
    expect(isWorktreeBootstrapStaleRunning(node, stale)).toBe(false)
  })

  it('prefers updatedAt over startedAt when present', () => {
    // updatedAt is recent even though startedAt is ancient → not stale.
    const node = { worktreeBootstrap: { status: 'running', startedAt: STARTED, updatedAt: new Date(fresh).toISOString() }, workspace: cleanRepo }
    expect(isWorktreeBootstrapStaleRunning(node, stale)).toBe(false)
  })
})

// FIX (b): the git-clean predicate in the stale backstop must treat a superproject whose ONLY
// uncommitted change is a submodule-gitlink pointer move (" M oss") as CLEAN — that outOfSync is
// the normal product of a worktree task committing inside a submodule, and disqualifying the
// backstop on it leaves the dispatch gate permanently closed once the worker commits inside oss/.
// Real file edits and untracked files must still count as DIRTY.
describe('FIX (b) — git-clean predicate exempts submodule-gitlink-only outOfSync', () => {
  let superRepo: string
  let subOriginOss: string
  let subOriginProv: string
  const STARTED = '2026-01-01T00:00:00.000Z'
  const startedMs = Date.parse(STARTED)
  const stale = startedMs + WORKTREE_BOOTSTRAP_STALE_RUNNING_MS + 60_000

  const git = (cwd: string, args: string[]) =>
    execFileSync(GIT, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' })

  const initRepo = (dir: string) => {
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    git(dir, ['config', 'commit.gpgsign', 'false'])
  }

  // Make a standalone origin repo with two commits so a submodule pointer can be moved.
  const makeSubmoduleOrigin = (label: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-wt-suborigin-${label}-`))
    initRepo(dir)
    writeFileSync(join(dir, 'README.md'), 'v1\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'v1'])
    writeFileSync(join(dir, 'README.md'), 'v2\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'v2'])
    return dir
  }

  // Move a submodule's checked-out HEAD back one commit so the superproject sees a gitlink
  // pointer move (" M <path>") — without touching any file in the superproject worktree.
  const movePointerBack = (submodulePath: string) => {
    git(join(superRepo, submodulePath), ['checkout', '-q', 'HEAD~1'])
  }

  beforeAll(() => {
    subOriginOss = makeSubmoduleOrigin('oss')
    subOriginProv = makeSubmoduleOrigin('prov')
    superRepo = mkdtempSync(join(tmpdir(), 'adhdev-wt-super-'))
    initRepo(superRepo)
    writeFileSync(join(superRepo, 'root.txt'), 'root\n')
    git(superRepo, ['add', '-A'])
    git(superRepo, ['commit', '-q', '-m', 'init'])
    // Register two submodules at distinct paths ('oss', 'adhdev-providers') so the
    // enumeration-from-.gitmodules path is exercised generically.
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOriginOss, 'oss'])
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOriginProv, 'adhdev-providers'])
    git(superRepo, ['commit', '-q', '-m', 'add submodules'])
  })

  afterAll(() => {
    for (const dir of [superRepo, subOriginOss, subOriginProv]) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  const node = () => ({ worktreeBootstrap: { status: 'running', startedAt: STARTED }, workspace: superRepo })

  it('" M oss" gitlink-only outOfSync → CLEAN (backstop releases)', () => {
    // Start from a clean superproject (sanity), then move only the oss pointer.
    expect(git(superRepo, ['status', '--porcelain']).trim()).toBe('')
    movePointerBack('oss')
    const porcelain = git(superRepo, ['status', '--porcelain'])
    expect(porcelain).toMatch(/^ M oss$/m)
    expect(isWorktreeBootstrapStaleRunning(node(), stale)).toBe(true)
  })

  it('multiple submodules all gitlink-only → CLEAN', () => {
    movePointerBack('adhdev-providers')
    const porcelain = git(superRepo, ['status', '--porcelain'])
    expect(porcelain).toMatch(/^ M oss$/m)
    expect(porcelain).toMatch(/^ M adhdev-providers$/m)
    expect(isWorktreeBootstrapStaleRunning(node(), stale)).toBe(true)
  })

  it('" M oss" + a real tracked-file edit → DIRTY (must keep deferring)', () => {
    writeFileSync(join(superRepo, 'root.txt'), 'edited\n')
    const porcelain = git(superRepo, ['status', '--porcelain'])
    expect(porcelain).toMatch(/^ M oss$/m)
    expect(porcelain).toMatch(/root\.txt/m)
    expect(isWorktreeBootstrapStaleRunning(node(), stale)).toBe(false)
    // restore the file so later assertions in this block start from gitlink-only.
    git(superRepo, ['checkout', '--', 'root.txt'])
  })

  it('" M oss" + an untracked file → DIRTY (must keep deferring)', () => {
    const untracked = join(superRepo, 'wip-untracked.txt')
    writeFileSync(untracked, 'wip\n')
    const porcelain = git(superRepo, ['status', '--porcelain'])
    expect(porcelain).toMatch(/^ M oss$/m)
    expect(porcelain).toMatch(/\?\? wip-untracked\.txt/m)
    expect(isWorktreeBootstrapStaleRunning(node(), stale)).toBe(false)
    rmSync(untracked, { force: true })
  })

  it('a non-submodule new directory (not registered in .gitmodules) → DIRTY', () => {
    // A path that LOOKS like a nested checkout but is NOT a registered submodule must not
    // be exempted — the enumeration is sourced strictly from .gitmodules.
    mkdirSync(join(superRepo, 'not-a-submodule'), { recursive: true })
    writeFileSync(join(superRepo, 'not-a-submodule', 'f.txt'), 'x\n')
    const porcelain = git(superRepo, ['status', '--porcelain'])
    expect(porcelain).toMatch(/not-a-submodule/m)
    expect(isWorktreeBootstrapStaleRunning(node(), stale)).toBe(false)
    rmSync(join(superRepo, 'not-a-submodule'), { recursive: true, force: true })
  })
})

// FIX (a-residual): the terminal 'complete' stamp (markWorktreeBootstrapTerminalState) must be
// recognized as terminal by evaluateWorktreeBootstrapState and never round-tripped back to a
// non-terminal state ('stale'/'never_ran') on a later re-hydration — doing so would reopen the
// dispatch/claim gate against a node whose bootstrap is already done.
describe("FIX (a-residual) — evaluateWorktreeBootstrapState keeps persisted 'complete' terminal", () => {
  // Inline mesh config carrying a usable worktree_bootstrap policy so loadMeshWorktreeBootstrapConfig
  // resolves a config (otherwise we'd short-circuit to 'not_configured' before reading persisted).
  const mesh = {
    policy: {
      worktreeBootstrap: {
        version: 1,
        commands: [{ command: 'echo', args: ['ok'] }],
      },
    },
  }
  const workspace = tmpdir() // no staleInputs configured → no fs reads needed

  it("passes a persisted 'complete' through unchanged (not re-derived to stale/never_ran)", () => {
    const persisted: WorktreeBootstrapState = {
      status: 'complete',
      required: true,
      completedAt: '2026-01-01T00:00:00.000Z',
    }
    const evaluated = evaluateWorktreeBootstrapState(mesh, workspace, persisted)
    expect(evaluated.status).toBe('complete')
    expect(evaluated.staleReason).toBeUndefined()
  })

  it("with NO persisted state, still resolves to 'stale'/never_ran (unchanged baseline behavior)", () => {
    const evaluated = evaluateWorktreeBootstrapState(mesh, workspace, null)
    expect(evaluated.status).toBe('stale')
    expect(evaluated.staleReason).toBe('never_ran')
  })
})
