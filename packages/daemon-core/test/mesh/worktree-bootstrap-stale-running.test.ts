import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWin32Executable } from '../../src/cli-adapters/resolve-executable.js'
import {
  isWorktreeBootstrapStaleRunning,
  WORKTREE_BOOTSTRAP_STALE_RUNNING_MS,
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
