import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  collectTrivialFastForwardGitlinkResolutions,
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
  const dir = mkdtempSync(join(tmpdir(), 'refine-trivial-ff-rebase-'))
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
 * The batch/sequential-convergence RCA scenario (autorebase_skips_submodule_gitlink):
 * sibling A has already merged, advancing base's oss submodule pointer AND adding a
 * root file the branch does not have (so the branch is behind>0 and a rebase is
 * required). Sibling B (this worktree branch) bumps the SAME submodule to a commit
 * that is in a strict fast-forward relationship with base's — i.e. a trivial-ff
 * gitlink. `evaluateGitlinkTrivialFastForward` returns trivial=true, so the
 * pre-rebase gate reports NO submodule_conflict → the old sync_base path took a
 * plain `git rebase baseHead`, which still aborts on the gitlink.
 *
 *   sub:  subBase ──> subA (base/sibling-A side, e.g. v2)
 *              └────> subB (branch side, e.g. v3 — a descendant of subA: strict ff)
 *   root: rootMB ──> baseHead   (sub->subA + sibling.txt)     [A merged first]
 *              └──> branchHead (sub->subB + ours.txt)          [B, behind baseHead]
 *
 * `direction` flips which side is the descendant so we cover both ff directions:
 *   'branch-ahead' → subB descends from subA (resolve to branch-side)
 *   'base-ahead'   → subA descends from subB (resolve to base-side)
 */
function setupTrivialFfSubmodule(direction: 'branch-ahead' | 'base-ahead' = 'branch-ahead') {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const base = join(tmp, 'base')

  // Linear submodule history subBase ──> subMid ──> subTip.
  initRepo(submoduleOrigin)
  const subBase = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subMid = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2')
  const subTip = commitFile(submoduleOrigin, 'mod.txt', 'v3\n', 'sub v3')

  // branch-ahead: base=subMid, branch=subTip (branch descends). base-ahead: swap.
  const subA = direction === 'branch-ahead' ? subMid : subTip
  const subB = direction === 'branch-ahead' ? subTip : subMid

  // Root base repo: pin sub at subBase (the shared ancestor pointer).
  initRepo(base)
  commitFile(base, 'top.txt', 'top\n', 'root init')
  git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(base, 'sub'), ['fetch', '-q', 'origin'])
  git(join(base, 'sub'), ['checkout', '-q', subBase])
  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'pin sub at base'])
  const rootMB = git(base, ['rev-parse', 'HEAD'])

  // Sibling A merged: sub->subA + a root file (sibling.txt) the branch lacks → behind>0.
  writeFileSync(join(base, 'sibling.txt'), 'sibling\n', 'utf-8')
  git(base, ['add', 'sibling.txt'])
  git(join(base, 'sub'), ['checkout', '-q', subA])
  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'sibling-A merged: sub->subA + sibling.txt'])
  const baseHead = git(base, ['rev-parse', 'HEAD'])

  // Worktree branch off rootMB (behind baseHead): sub->subB + own root file.
  const wt = join(tmp, 'wt')
  git(base, ['worktree', 'add', '-q', '--detach', wt, rootMB])
  git(wt, ['checkout', '-q', '-b', 'feat'])
  git(wt, ['submodule', 'update', '-q', '--init'])
  git(join(wt, 'sub'), ['fetch', '-q', 'origin'])
  git(join(wt, 'sub'), ['checkout', '-q', subB])
  git(wt, ['add', 'sub'])
  writeFileSync(join(wt, 'ours.txt'), 'ours\n', 'utf-8')
  git(wt, ['add', 'ours.txt'])
  git(wt, ['commit', '-q', '-m', 'sibling-B: sub->subB + ours.txt'])
  const branchHead = git(wt, ['rev-parse', 'HEAD'])

  return { base, wt, rootMB, baseHead, branchHead, subBase, subA, subB }
}

// -----------------------------------------------------------------------

describe('collectTrivialFastForwardGitlinkResolutions', () => {
  it('resolves to the branch-side commit when branch descends from base (branch-ahead ff)', () => {
    const { base, wt, baseHead, branchHead, subB } = setupTrivialFfSubmodule('branch-ahead')
    const resolutions = collectTrivialFastForwardGitlinkResolutions(wt, base, baseHead, branchHead)
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0].path).toBe('sub')
    expect(resolutions[0].rebasedCommit).toBe(subB) // branch side = descendant
  })

  it('resolves to the base-side commit when base descends from branch (base-ahead ff)', () => {
    const { base, wt, baseHead, branchHead, subA } = setupTrivialFfSubmodule('base-ahead')
    const resolutions = collectTrivialFastForwardGitlinkResolutions(wt, base, baseHead, branchHead)
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0].path).toBe('sub')
    expect(resolutions[0].rebasedCommit).toBe(subA) // base side = descendant (more advanced)
  })

  it('returns nothing when the pointers are diverged (not a fast-forward)', () => {
    // Fork the submodule so branch-side is NOT an ancestor/descendant of base-side.
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')
    initRepo(submoduleOrigin)
    const subBase = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
    const subA = commitFile(submoduleOrigin, 'mod.txt', 'v1\nbase\n', 'sub base edit')
    git(submoduleOrigin, ['checkout', '-q', '-b', 'fork', subBase])
    const subB = commitFile(submoduleOrigin, 'other.txt', 'branch\n', 'sub branch add')
    git(submoduleOrigin, ['checkout', '-q', 'main'])

    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    git(join(base, 'sub'), ['fetch', '-q', 'origin'])
    git(join(base, 'sub'), ['checkout', '-q', subBase])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'pin base'])
    const rootMB = git(base, ['rev-parse', 'HEAD'])
    git(join(base, 'sub'), ['checkout', '-q', subA])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'base: sub->subA'])
    const baseHead = git(base, ['rev-parse', 'HEAD'])

    const wt = join(tmp, 'wt')
    git(base, ['worktree', 'add', '-q', '--detach', wt, rootMB])
    git(wt, ['checkout', '-q', '-b', 'feat'])
    git(wt, ['submodule', 'update', '-q', '--init'])
    git(join(wt, 'sub'), ['fetch', '-q', 'origin'])
    git(join(wt, 'sub'), ['checkout', '-q', subB])
    git(wt, ['add', 'sub'])
    git(wt, ['commit', '-q', '-m', 'branch: sub->subB'])
    const branchHead = git(wt, ['rev-parse', 'HEAD'])

    const resolutions = collectTrivialFastForwardGitlinkResolutions(wt, base, baseHead, branchHead)
    expect(resolutions).toHaveLength(0)
  })
})

describe('trivial-ff gitlink sync_base rebase (autorebase_skips_submodule_gitlink regression)', () => {
  // Precondition sanity: the branch really is behind baseHead (a rebase IS needed),
  // and the changed path is a gitlink — otherwise the fix's branch would not engage.
  //
  // NOTE on the plain-rebase abort: whether a bare `git rebase baseHead` actually
  // aborts on a trivial-ff gitlink is git-strategy/version/platform dependent — the
  // ORT strategy on recent git auto-fast-forwards the submodule, whereas the older
  // recursive strategy (and some platforms/configs — notably the win32 mesh nodes)
  // bail with "Recursive merging with submodules currently only supports trivial
  // cases" and abort → blocked_review. Rather than assert that non-portable abort,
  // we assert the fix's positive, strategy-independent contract below: the changed
  // gitlink is always routed through the gitlink-aware rebase, which converges
  // deterministically regardless of the ambient merge strategy.
  it('precondition: the branch is behind base and the change is a gitlink', () => {
    const { wt, baseHead, branchHead } = setupTrivialFfSubmodule('branch-ahead')
    // behind>0: base has commits the branch lacks.
    const behind = Number(git(wt, ['rev-list', '--count', `${branchHead}..${baseHead}`]))
    expect(behind).toBeGreaterThan(0)
    // The submodule pointer changed base↔branch (a gitlink diff, mode 160000).
    const raw = git(wt, ['diff', '--raw', '--no-abbrev', baseHead, branchHead])
    expect(raw).toMatch(/160000/)
    expect(raw).toMatch(/\bsub\b/)
  })

  it('the gitlink-aware rebase converges the trivial-ff gitlink and yields linear history', async () => {
    const { base, wt, baseHead, branchHead, subB } = setupTrivialFfSubmodule('branch-ahead')

    // This is what refineSyncBaseStage now does: collect the trivial-ff resolutions
    // and drive the gitlink-aware root rebase instead of a plain `git rebase`.
    const resolutions = collectTrivialFastForwardGitlinkResolutions(wt, base, baseHead, branchHead)
    expect(resolutions).toHaveLength(1)

    const rebased = rootRebaseResolvingGitlinks(wt, baseHead, resolutions)
    expect(rebased.ok).toBe(true)
    const newBranchHead = rebased.branchHead!
    expect(newBranchHead).toBeTruthy()

    // Linear history: baseHead is now an ancestor of the rebased branch head.
    expect(git(wt, ['merge-base', '--is-ancestor', baseHead, newBranchHead])).toBe('')
    // Both sides' root changes survived.
    const tree = git(wt, ['ls-tree', '-r', '--name-only', newBranchHead])
    expect(tree).toMatch(/sibling\.txt/) // base / sibling-A side
    expect(tree).toMatch(/ours\.txt/)    // branch / sibling-B side
    // The submodule pointer is the branch-side (descendant) commit.
    const subLine = git(wt, ['ls-tree', newBranchHead, '--', 'sub'])
    expect(subLine).toContain(subB)

    // And the downstream patch-equivalence gate passes on the converged head.
    const pe = await runMeshRefinePatchEquivalenceGate(base, baseHead, newBranchHead)
    expect(pe.status).toBe('passed')
    expect(pe.equivalent).toBe(true)
  })
})
