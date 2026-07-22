import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  convergeDivergedSubmoduleGitlinks,
  rootRebaseResolvingGitlinks,
  runMeshRefinePatchEquivalenceGate,
} from '../../src/commands/router'

// --- git helpers --------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim()
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

function commitFile(repo: string, name: string, content: string, message: string): string {
  writeFileSync(join(repo, name), content, 'utf-8')
  git(repo, ['add', name])
  git(repo, ['commit', '-q', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

const cleanups: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refine-diverged-gitlink-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/**
 * Build the RCA scenario: base and branch advance the SAME submodule to DIVERGED
 * sibling commits (neither an ancestor of the other), off a shared submodule
 * merge-base. This is the case the strict-ff gate correctly BLOCKS (there is no
 * fast-forward to exclude) — the auto-converge must rebase the branch-side
 * submodule commit onto the base-side one to make it fast-forwardable.
 *
 *   sub:  subMB ──> subBase   (base side, e.g. edits mod.txt)
 *              └──> subBranch (branch side, e.g. adds other.txt) — non-conflicting
 *   root: rootMB ──> baseHead   (sub->subBase + sibling.txt)
 *              └──> branchHead (sub->subBranch + ours.txt)
 * base's root repo lives at `base/`, the worktree branch at `wt/`, both sharing the
 * same object db as separate git worktrees of the same repo (so baseHead is
 * reachable from the worktree, as in production).
 */
function setupDivergedSubmodule(opts?: { conflicting?: boolean }) {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const base = join(tmp, 'base')

  initRepo(submoduleOrigin)
  const subMB = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  // base-side submodule sibling
  const subBase = commitFile(submoduleOrigin, 'mod.txt', 'v1\nbase-line\n', 'sub base edit')
  // branch-side submodule sibling off subMB — non-conflicting (touches other.txt),
  // or conflicting (edits mod.txt at the same region as subBase) when requested.
  git(submoduleOrigin, ['checkout', '-q', '-b', 'branchsub', subMB])
  const subBranch = opts?.conflicting
    ? commitFile(submoduleOrigin, 'mod.txt', 'v1\nBRANCH-CONFLICT\n', 'sub branch conflicting edit')
    : commitFile(submoduleOrigin, 'other.txt', 'branch-line\n', 'sub branch add')
  git(submoduleOrigin, ['checkout', '-q', 'main'])

  // Root base repo: pin sub at subMB (the common ancestor).
  initRepo(base)
  commitFile(base, 'top.txt', 'top\n', 'root init')
  git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(base, 'sub'), ['fetch', '-q', 'origin'])
  git(join(base, 'sub'), ['checkout', '-q', subMB])
  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'pin sub at merge-base'])
  const rootMB = git(base, ['rev-parse', 'HEAD'])

  // base advances: sub->subBase + a sibling root file (so root diverges too).
  writeFileSync(join(base, 'sibling.txt'), 'sibling\n', 'utf-8')
  git(base, ['add', 'sibling.txt'])
  git(join(base, 'sub'), ['checkout', '-q', subBase])
  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'base: sub->subBase + sibling'])
  const baseHead = git(base, ['rev-parse', 'HEAD'])

  // Worktree branch off rootMB: sub->subBranch + own root file. Diverged at the root.
  const wt = join(tmp, 'wt')
  git(base, ['worktree', 'add', '-q', '--detach', wt, rootMB])
  // Initialize the submodule inside the worktree and make all sub commits available.
  git(wt, ['checkout', '-q', '-b', 'feat'])
  git(wt, ['submodule', 'update', '-q', '--init'])
  git(join(wt, 'sub'), ['fetch', '-q', 'origin'])
  git(join(wt, 'sub'), ['checkout', '-q', subBranch])
  git(wt, ['add', 'sub'])
  writeFileSync(join(wt, 'ours.txt'), 'ours\n', 'utf-8')
  git(wt, ['add', 'ours.txt'])
  git(wt, ['commit', '-q', '-m', 'branch: sub->subBranch + ours'])
  const branchHead = git(wt, ['rev-parse', 'HEAD'])

  return { base, wt, rootMB, baseHead, branchHead, subMB, subBase, subBranch }
}

// -----------------------------------------------------------------------

describe('convergeDivergedSubmoduleGitlinks', () => {
  it('rebases a diverged (non-conflicting) submodule gitlink onto the base-side commit', () => {
    const { base, wt, baseHead, branchHead, subBase, subBranch } = setupDivergedSubmodule()

    // Precondition: subBase and subBranch are genuinely diverged (neither ancestor).
    const subRepo = join(wt, 'sub')
    expect(() => git(subRepo, ['merge-base', '--is-ancestor', subBase, subBranch])).toThrow()
    expect(() => git(subRepo, ['merge-base', '--is-ancestor', subBranch, subBase])).toThrow()

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(result.converged).toBe(true)
    expect(result.resolutions).toHaveLength(1)
    const [res] = result.resolutions
    expect(res.path).toBe('sub')
    expect(res.rebasedCommit).not.toBe(subBranch)
    // After the rebase the base-side commit IS a strict ancestor of the rebased tip.
    expect(git(subRepo, ['merge-base', '--is-ancestor', subBase, res.rebasedCommit])).toBe('')
    // The branch-side change (other.txt) survived the rebase.
    expect(git(subRepo, ['ls-tree', '-r', '--name-only', res.rebasedCommit])).toMatch(/other\.txt/)
  })

  it('aborts and reports rebase_conflict when the submodule content genuinely conflicts', () => {
    const { base, wt, baseHead, branchHead, subBranch } = setupDivergedSubmodule({ conflicting: true })
    const subRepo = join(wt, 'sub')

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(result.converged).toBe(false)
    expect(result.reason).toBe('rebase_conflict')
    expect(result.resolutions).toHaveLength(0)
    // Fail-safe: the submodule checkout is restored to the branch-side commit (no mid-rebase state).
    expect(git(subRepo, ['rev-parse', 'HEAD'])).toBe(subBranch)
    expect(() => git(subRepo, ['rev-parse', '--verify', 'REBASE_HEAD'])).toThrow()
  })

  it('reports not_diverged when the gitlink is a strict fast-forward (nothing to converge)', () => {
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')
    initRepo(submoduleOrigin)
    const s1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'v1')
    const s2 = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'v2')
    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    git(join(base, 'sub'), ['fetch', '-q', 'origin'])
    git(join(base, 'sub'), ['checkout', '-q', s1])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'pin v1'])
    const baseHead = git(base, ['rev-parse', 'HEAD'])
    const wt = join(tmp, 'wt')
    git(base, ['worktree', 'add', '-q', '--detach', wt, baseHead])
    git(wt, ['checkout', '-q', '-b', 'feat'])
    git(wt, ['submodule', 'update', '-q', '--init'])
    git(join(wt, 'sub'), ['fetch', '-q', 'origin'])
    git(join(wt, 'sub'), ['checkout', '-q', s2]) // strict ff v1->v2
    git(wt, ['add', 'sub'])
    git(wt, ['commit', '-q', '-m', 'bump sub v2'])
    const branchHead = git(wt, ['rev-parse', 'HEAD'])

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(result.converged).toBe(false)
    expect(result.reason).toBe('not_diverged')
  })
})

describe('rootRebaseResolvingGitlinks + patch-equivalence (end-to-end auto-converge)', () => {
  it('(a) converges a diverged gitlink so patch-equivalence passes with linear history', async () => {
    const { base, wt, baseHead, branchHead } = setupDivergedSubmodule()

    // STEP 1: converge the submodule.
    const converge = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(converge.converged).toBe(true)

    // STEP 2: gitlink-aware root rebase onto baseHead.
    const rebased = rootRebaseResolvingGitlinks(wt, baseHead, converge.resolutions)
    expect(rebased.ok).toBe(true)
    const newBranchHead = rebased.branchHead!
    expect(newBranchHead).toBeTruthy()

    // Linear history: baseHead is now an ancestor of the rebased branch head.
    expect(git(wt, ['merge-base', '--is-ancestor', baseHead, newBranchHead])).toBe('')
    // Both sides' root changes survived.
    const tree = git(wt, ['ls-tree', '-r', '--name-only', newBranchHead])
    expect(tree).toMatch(/sibling\.txt/) // base side
    expect(tree).toMatch(/ours\.txt/)    // branch side
    // The gitlink is now a strict fast-forward from the base side.
    const subLine = git(wt, ['diff', '--raw', '--no-abbrev', baseHead, newBranchHead])
    const subEntry = subLine.split('\n').find(l => /160000/.test(l) && /\bsub\b/.test(l))
    // The submodule pointer differs, but the base-side commit is now an ancestor of the branch-side one.
    if (subEntry) {
      const shas = subEntry.match(/[0-9a-f]{40}/g) || []
      const baseSub = shas[0]
      const branchSub = shas[1]
      expect(git(join(wt, 'sub'), ['merge-base', '--is-ancestor', baseSub, branchSub])).toBe('')
    }

    // The refine patch-equivalence gate (run from the base repo against the converged
    // branch head) now PASSES — the fast-forwardable gitlink is excluded.
    const pe = await runMeshRefinePatchEquivalenceGate(base, baseHead, newBranchHead)
    expect(pe.status).toBe('passed')
    expect(pe.equivalent).toBe(true)
  })

  it('(b) a genuinely conflicting submodule keeps the block (no converge, no rebase)', () => {
    const { base, wt, baseHead, branchHead } = setupDivergedSubmodule({ conflicting: true })
    const converge = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(converge.converged).toBe(false)
    expect(converge.reason).toBe('rebase_conflict')
    // The branch head is untouched — fail-safe fell back to blocked_review.
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(branchHead)
  })

  it('(c) a non-gitlink root conflict during the gitlink-aware rebase aborts cleanly', () => {
    // Diverge a regular root file on BOTH sides so the root rebase hits a real
    // content conflict (not just the gitlink) — must abort and report it.
    const { base, wt, baseHead, branchHead } = setupDivergedSubmodule()
    // Add a base commit that edits ours.txt' peer file top.txt.
    writeFileSync(join(base, 'top.txt'), 'top-base-edit\n', 'utf-8')
    git(base, ['add', 'top.txt'])
    git(base, ['commit', '-q', '-m', 'base edits top.txt'])
    const baseHead2 = git(base, ['rev-parse', 'HEAD'])
    // Branch edits top.txt differently.
    writeFileSync(join(wt, 'top.txt'), 'top-branch-edit\n', 'utf-8')
    git(wt, ['add', 'top.txt'])
    git(wt, ['commit', '-q', '-m', 'branch edits top.txt'])
    const branchHead2 = git(wt, ['rev-parse', 'HEAD'])

    const converge = convergeDivergedSubmoduleGitlinks(wt, base, baseHead2, branchHead2)
    expect(converge.converged).toBe(true) // the submodule itself is non-conflicting
    const rebased = rootRebaseResolvingGitlinks(wt, baseHead2, converge.resolutions)
    expect(rebased.ok).toBe(false)
    expect(rebased.reason).toBe('non_gitlink_conflict')
    // No mid-rebase state left behind.
    expect(() => git(wt, ['rev-parse', '--verify', 'REBASE_HEAD'])).toThrow()
    void baseHead; void branchHead
  })
})
