import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildSubmodulePublishRequiredNextStep,
  collectTrivialFastForwardGitlinkResolutions,
  convergeDivergedSubmoduleGitlinks,
  describeSubmoduleConvergeDecline,
  rootRebaseResolvingGitlinks,
  runMeshRefinePatchEquivalenceGate,
  runMeshRefineSubmoduleReachabilityGate,
} from '../../src/commands/router'
// Imported from the source module rather than the router barrel: these two are
// not re-exported there, and the decline-details contract does not need a wider
// public surface just to be tested.
import {
  SUBMODULE_PUBLISH_REQUIRED_RECOMMENDED_ACTION,
  buildSubmoduleConvergeDeclineDetails,
} from '../../src/mesh/mesh-refine-submodule-converge'

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

/**
 * The rewrite (mint-a-new-submodule-commit) path is only reachable when the
 * Refinery is allowed to publish submodule commits to submodule origin main —
 * otherwise the pre-mint publish gate defers instead, because a minted commit
 * could never satisfy the downstream reachability gate. Tests whose SUBJECT is
 * the rebase/rewrite behaviour therefore opt into that policy explicitly; the
 * gate's own behaviour is covered by the pre-mint publish gate describe-block.
 */
const AUTO_PUBLISH_ON = { allowAutoPublishSubmoduleMainCommits: true } as const

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

  return { base, wt, rootMB, baseHead, branchHead, subMB, subBase, subBranch, submoduleOrigin }
}

// -----------------------------------------------------------------------

describe('convergeDivergedSubmoduleGitlinks', () => {
  it('rebases a diverged (non-conflicting) submodule gitlink onto the base-side commit', () => {
    const { base, wt, baseHead, branchHead, subBase, subBranch } = setupDivergedSubmodule()

    // Precondition: subBase and subBranch are genuinely diverged (neither ancestor).
    const subRepo = join(wt, 'sub')
    expect(() => git(subRepo, ['merge-base', '--is-ancestor', subBase, subBranch])).toThrow()
    expect(() => git(subRepo, ['merge-base', '--is-ancestor', subBranch, subBase])).toThrow()

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)
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
    const converge = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)
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
    const converge = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)
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

    const converge = convergeDivergedSubmoduleGitlinks(wt, base, baseHead2, branchHead2, AUTO_PUBLISH_ON)
    expect(converge.converged).toBe(true) // the submodule itself is non-conflicting
    const rebased = rootRebaseResolvingGitlinks(wt, baseHead2, converge.resolutions)
    expect(rebased.ok).toBe(false)
    expect(rebased.reason).toBe('non_gitlink_conflict')
    // No mid-rebase state left behind.
    expect(() => git(wt, ['rev-parse', '--verify', 'REBASE_HEAD'])).toThrow()
    void baseHead; void branchHead
  })
})

/**
 * The REAL incident this regression suite pins down (parallel-refine twin):
 *
 *   oss origin/main = 83ea6c68
 *   A worker merged the branch → 67dab44d, ff-pushed to origin/main (published)
 *   The Refinery rewrote the branch commit 9586a8d8 onto 83ea6c68 → d8e3acb7
 *     · patch-id(d8e3acb7) == patch-id(9586a8d8)   (byte-identical diff)
 *     · tree(d8e3acb7)     == tree(67dab44d)       (byte-identical content)
 *     · d8e3acb7 is NOT an ancestor of 67dab44d
 *   → old behavior: submodule_publish_required (WRONG — publishing the twin
 *     mints duplicate history)
 *   → fixed behavior: converge the gitlink to the already-published 67dab44d.
 *
 * Submodule graph built here (analog SHAs):
 *
 *   subMB ──> subBase ──(merge branchsub)──> subPublished   (origin/main)
 *     └──> subBranch
 *
 * where tree(merge-tree(subBase, subBranch)) == tree(subPublished).
 */
function setupPublishedTwinSubmodule() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const base = join(tmp, 'base')

  initRepo(submoduleOrigin)
  const subMB = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subBase = commitFile(submoduleOrigin, 'mod.txt', 'v1\nbase-line\n', 'sub base edit')
  git(submoduleOrigin, ['checkout', '-q', '-b', 'branchsub', subMB])
  const subBranch = commitFile(submoduleOrigin, 'other.txt', 'branch-line\n', 'sub branch add')
  // The sibling worker merges the branch onto main and pushes → the published twin.
  git(submoduleOrigin, ['checkout', '-q', 'main'])
  git(submoduleOrigin, ['merge', '-q', '--no-ff', 'branchsub', '-m', 'merge branchsub'])
  const subPublished = git(submoduleOrigin, ['rev-parse', 'HEAD'])

  // Root base repo: pin sub at subMB (the common ancestor), then advance to subBase.
  initRepo(base)
  commitFile(base, 'top.txt', 'top\n', 'root init')
  git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(base, 'sub'), ['fetch', '-q', 'origin'])
  git(join(base, 'sub'), ['checkout', '-q', subMB])
  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'pin sub at merge-base'])
  const rootMB = git(base, ['rev-parse', 'HEAD'])

  writeFileSync(join(base, 'sibling.txt'), 'sibling\n', 'utf-8')
  git(base, ['add', 'sibling.txt'])
  git(join(base, 'sub'), ['checkout', '-q', subBase])
  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'base: sub->subBase + sibling'])
  const baseHead = git(base, ['rev-parse', 'HEAD'])

  // Worktree branch off rootMB: sub->subBranch + own root file.
  const wt = join(tmp, 'wt')
  git(base, ['worktree', 'add', '-q', '--detach', wt, rootMB])
  git(wt, ['checkout', '-q', '-b', 'feat'])
  git(wt, ['submodule', 'update', '-q', '--init'])
  git(join(wt, 'sub'), ['fetch', '-q', 'origin'])
  git(join(wt, 'sub'), ['checkout', '-q', subBranch])
  git(wt, ['add', 'sub'])
  writeFileSync(join(wt, 'ours.txt'), 'ours\n', 'utf-8')
  git(wt, ['add', 'ours.txt'])
  git(wt, ['commit', '-q', '-m', 'branch: sub->subBranch + ours'])
  const branchHead = git(wt, ['rev-parse', 'HEAD'])

  return { base, wt, baseHead, branchHead, subMB, subBase, subBranch, subPublished }
}

describe('parallel-refine published-twin (Gap #1/Gap #2 regression)', () => {
  it('converges to the already-published equivalent commit instead of rewriting a same-content twin', async () => {
    const { base, wt, baseHead, branchHead, subBase, subBranch, subPublished } = setupPublishedTwinSubmodule()
    const subRepo = join(wt, 'sub')

    // Precondition: base and branch advanced the SAME submodule to genuinely
    // diverged sibling commits (neither an ancestor of the other) — the exact
    // input the stale cache misjudged.
    expect(() => git(subRepo, ['merge-base', '--is-ancestor', subBase, subBranch])).toThrow()
    expect(() => git(subRepo, ['merge-base', '--is-ancestor', subBranch, subBase])).toThrow()

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(result.converged).toBe(true)
    expect(result.resolutions).toHaveLength(1)
    const [res] = result.resolutions
    expect(res.path).toBe('sub')
    // ★ NO rewrite: the resolution IS the already-published commit (67dab44d
    // analog). Under the old behavior this was a freshly-minted local twin.
    expect(res.rebasedCommit).toBe(subPublished)
    expect(result.gitlinks[0].action).toBe('converged_to_published')
    // The published commit descends from the base side (linear history preserved).
    expect(git(subRepo, ['merge-base', '--is-ancestor', subBase, res.rebasedCommit])).toBe('')

    // End-to-end: the gitlink-aware root rebase resolves to the published commit
    // and the patch-equivalence gate passes on the converged branch.
    const rebased = rootRebaseResolvingGitlinks(wt, baseHead, result.resolutions)
    expect(rebased.ok).toBe(true)
    const pe = await runMeshRefinePatchEquivalenceGate(base, baseHead, rebased.branchHead!)
    expect(pe.status).toBe('passed')
    expect(pe.equivalent).toBe(true)
  })

  it('still rewrites a genuinely diverged submodule when origin/main advanced with UNRELATED content', () => {
    // The maximum-risk guard: the published-equivalence check must NOT be so
    // broad that it blocks a legitimate rewrite. Here origin/main HAS moved past
    // the base side, but with content unrelated to the branch — there is no
    // equivalent twin, so the historical rebase path must run unchanged.
    const { base, wt, baseHead, branchHead, subBase, subBranch } = setupDivergedSubmodule()
    const subRepo = join(wt, 'sub')
    const submoduleOrigin = git(subRepo, ['remote', 'get-url', 'origin'])
    commitFile(submoduleOrigin, 'unrelated.txt', 'unrelated\n', 'unrelated published commit')

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)
    expect(result.converged).toBe(true)
    expect(result.resolutions).toHaveLength(1)
    const [res] = result.resolutions
    expect(result.gitlinks[0].action).toBe('rebased')
    expect(res.rebasedCommit).not.toBe(subBranch)
    // A REAL rewrite happened: a brand-new tip that descends from the base side
    // and still carries the branch's work.
    expect(git(subRepo, ['merge-base', '--is-ancestor', subBase, res.rebasedCommit])).toBe('')
    expect(git(subRepo, ['ls-tree', '-r', '--name-only', res.rebasedCommit])).toMatch(/other\.txt/)
    expect(git(subRepo, ['ls-tree', '-r', '--name-only', res.rebasedCommit])).not.toMatch(/unrelated\.txt/)
  })

  it('reachability gate points an unreachable twin at the published equivalent instead of demanding a publish', async () => {
    // Reproduce the incident's exact end state: the Refinery already rewrote the
    // branch commit into a LOCAL twin (d8e3acb7 analog) whose tree is
    // byte-identical to the published origin/main commit (67dab44d analog) but
    // which is NOT reachable from origin/main.
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')

    initRepo(submoduleOrigin)
    const subMB = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
    const subPublished = commitFile(submoduleOrigin, 'other.txt', 'branch-line\n', 'published merge result')

    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'root init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    // Mint the local twin: same content as subPublished, different SHA, not pushed.
    const subRepo = join(base, 'sub')
    git(subRepo, ['checkout', '-q', '--detach', subMB])
    writeFileSync(join(subRepo, 'other.txt'), 'branch-line\n', 'utf-8')
    git(subRepo, ['add', 'other.txt'])
    git(subRepo, ['commit', '-q', '-m', 'rewritten twin'])
    const subTwin = git(subRepo, ['rev-parse', 'HEAD'])

    // The incident's three invariants, asserted on the fixture itself:
    const patchIdOf = (from: string, to: string) =>
      execFileSync('git', ['patch-id', '--stable'], {
        cwd: subRepo,
        input: git(subRepo, ['diff', '--patch', '--full-index', from, to]),
        encoding: 'utf-8',
      }).trim().split(/\s+/)[0]
    expect(patchIdOf(subMB, subTwin)).toBe(patchIdOf(subMB, subPublished))          // patch-id equal
    expect(git(subRepo, ['rev-parse', `${subTwin}^{tree}`]))
      .toBe(git(subRepo, ['rev-parse', `${subPublished}^{tree}`]))                  // tree equal
    expect(() => git(subRepo, ['merge-base', '--is-ancestor', subTwin, subPublished])).toThrow() // not an ancestor

    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'gitlink -> twin'])
    const mergedTree = git(base, ['rev-parse', 'HEAD^{tree}'])

    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree)
    expect(gate.status).toBe('failed')
    expect(gate.unreachable).toHaveLength(1)
    const [entry] = gate.unreachable
    // ★ Old behavior: publishRequired:true + "push the commit". Fixed behavior:
    // converge the gitlink to the already-published equivalent.
    expect(entry.equivalentPublishedCommit).toBe(subPublished)
    expect(entry.publishRequired).toBe(false)
    expect(entry.error).toContain('converge the gitlink to the published commit')
    const nextStep = buildSubmodulePublishRequiredNextStep(gate.unreachable)
    expect(nextStep).toContain('already-published equivalent commit')
    expect(nextStep).toContain(subPublished)
    expect(nextStep).not.toContain('Ask the user for explicit approval')
  })

  it('reachability gate still demands a publish for a genuinely unpublished commit (no equivalent on origin)', async () => {
    // Guard against the equivalence check passing spuriously: a commit whose
    // content exists nowhere on origin/main keeps the historical
    // publish-required prescription, byte-for-byte.
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')

    initRepo(submoduleOrigin)
    commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'root init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    const subRepo = join(base, 'sub')
    writeFileSync(join(subRepo, 'local-only.txt'), 'not published\n', 'utf-8')
    git(subRepo, ['add', 'local-only.txt'])
    git(subRepo, ['commit', '-q', '-m', 'genuinely new work'])
    const localOnly = git(subRepo, ['rev-parse', 'HEAD'])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'gitlink -> local only'])
    const mergedTree = git(base, ['rev-parse', 'HEAD^{tree}'])

    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree)
    expect(gate.status).toBe('failed')
    expect(gate.unreachable).toHaveLength(1)
    const [entry] = gate.unreachable
    expect(entry.equivalentPublishedCommit).toBeUndefined()
    expect(entry.publishRequired).toBe(true)
    expect(entry.error).toContain('Submodule remote main reachability check failed for origin/main')
    const nextStep = buildSubmodulePublishRequiredNextStep(gate.unreachable)
    expect(nextStep).toContain('Ask the user for explicit approval')
    expect(nextStep).toContain(`sub@${localOnly}`)
  })
})

/**
 * Build the DETACHED-HEAD OBJECT-FETCH scenario — the exact production shape that
 * false-blocked a sibling batch at `patch_equivalence_classification` while all 19
 * validation gates passed and the content merged cleanly.
 *
 * Two properties matter, and both are the normal state of a real submodule:
 *
 *   (a) the worktree's submodule and the base workspace's submodule are SEPARATE
 *       clones — they do not share an object store, so the base-side commit is
 *       genuinely absent from the worktree until it is fetched;
 *   (b) the base workspace's submodule is on a **detached HEAD** and **no local
 *       branch points at the base-side commit**, and that commit was never pushed
 *       to origin.
 *
 * Under (b) the historical `+refs/heads/*:refs/adhdev-refine-base/*` refspec could
 * not name the object at all, so the fetch brought back nothing, the ancestry
 * check saw a missing commit, and the run reported `not_diverged` → defer →
 * blocked_review. Auto-converge never got its chance even though a rebase would
 * have succeeded with zero conflicts.
 *
 *   sub:  subMB ──> subBase   (base side — detached, NO branch, NOT on origin)
 *              └──> subBranch (branch side, non-conflicting)
 */
function setupDetachedBaseSubmodule() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const base = join(tmp, 'base')

  initRepo(submoduleOrigin)
  const subMB = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

  // Root base repo pinned at the submodule merge-base.
  initRepo(base)
  commitFile(base, 'top.txt', 'top\n', 'root init')
  git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'pin sub at merge-base'])
  const rootMB = git(base, ['rev-parse', 'HEAD'])

  // The worktree is created BEFORE the base-side submodule commit exists and gets
  // its own independent clone of the submodule, so (a) holds.
  const wt = join(tmp, 'wt')
  git(base, ['worktree', 'add', '-q', '--detach', wt, rootMB])
  git(wt, ['checkout', '-q', '-b', 'feat'])
  git(wt, ['submodule', 'update', '-q', '--init'])

  // base side: commit INSIDE the base workspace's submodule on a detached HEAD.
  const baseSubRepo = join(base, 'sub')
  git(baseSubRepo, ['checkout', '-q', '--detach', subMB])
  writeFileSync(join(baseSubRepo, 'mod.txt'), 'v1\nbase-line\n', 'utf-8')
  git(baseSubRepo, ['add', 'mod.txt'])
  git(baseSubRepo, ['commit', '-q', '-m', 'sub base edit (detached, unpublished)'])
  const subBase = git(baseSubRepo, ['rev-parse', 'HEAD'])
  git(base, ['add', 'sub'])
  writeFileSync(join(base, 'sibling.txt'), 'sibling\n', 'utf-8')
  git(base, ['add', 'sibling.txt'])
  git(base, ['commit', '-q', '-m', 'base: sub->subBase + sibling'])
  const baseHead = git(base, ['rev-parse', 'HEAD'])

  // branch side: an independent, non-conflicting submodule commit off subMB.
  const wtSubRepo = join(wt, 'sub')
  git(wtSubRepo, ['checkout', '-q', '--detach', subMB])
  writeFileSync(join(wtSubRepo, 'other.txt'), 'branch-line\n', 'utf-8')
  git(wtSubRepo, ['add', 'other.txt'])
  git(wtSubRepo, ['commit', '-q', '-m', 'sub branch add'])
  const subBranch = git(wtSubRepo, ['rev-parse', 'HEAD'])
  git(wt, ['add', 'sub'])
  writeFileSync(join(wt, 'ours.txt'), 'ours\n', 'utf-8')
  git(wt, ['add', 'ours.txt'])
  git(wt, ['commit', '-q', '-m', 'branch: sub->subBranch + ours'])
  const branchHead = git(wt, ['rev-parse', 'HEAD'])

  return { base, wt, baseHead, branchHead, subMB, subBase, subBranch, baseSubRepo, wtSubRepo }
}

describe('detached-HEAD base submodule object fetch (M-REFINE-SUBMODULE-OBJECT-FETCH-GAP)', () => {
  it('auto-converges when the base-side commit is reachable from NO local branch (detached HEAD, unpublished)', () => {
    const { base, wt, baseHead, branchHead, subBase, subBranch, baseSubRepo, wtSubRepo } = setupDetachedBaseSubmodule()

    // ★ Fixture invariants — these ARE the failure condition. If any of them stops
    // holding, this test silently stops covering the regression.
    // 1. The base workspace's submodule is on a detached HEAD...
    expect(() => git(baseSubRepo, ['symbolic-ref', '-q', 'HEAD'])).toThrow()
    // 2. ...and NO local branch there points at the base-side commit, so the old
    //    `+refs/heads/*` refspec is structurally unable to fetch it.
    const baseBranchTips = git(baseSubRepo, ['for-each-ref', '--format=%(objectname)', 'refs/heads/'])
      .split('\n').map(s => s.trim()).filter(Boolean)
    expect(baseBranchTips).not.toContain(subBase)
    // 3. It is not on the submodule's origin either (no remote fallback).
    expect(() => git(baseSubRepo, ['merge-base', '--is-ancestor', subBase, 'refs/remotes/origin/main'])).toThrow()
    // 4. And it is genuinely absent from the worktree's submodule object store.
    expect(() => git(wtSubRepo, ['cat-file', '-e', `${subBase}^{commit}`])).toThrow()

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)

    // The fetch now reaches the detached commit → divergence is judged → converge runs.
    expect(result.converged).toBe(true)
    expect(result.resolutions).toHaveLength(1)
    const [res] = result.resolutions
    expect(res.path).toBe('sub')
    expect(result.gitlinks[0].action).toBe('rebased')
    // Base side is a strict ancestor of the rebased tip (linear history)...
    expect(git(wtSubRepo, ['merge-base', '--is-ancestor', subBase, res.rebasedCommit])).toBe('')
    // ...and the branch-side work survived the replay (nothing silently lost).
    expect(res.rebasedCommit).not.toBe(subBranch)
    expect(git(wtSubRepo, ['ls-tree', '-r', '--name-only', res.rebasedCommit])).toMatch(/other\.txt/)
    expect(git(wtSubRepo, ['ls-tree', '-r', '--name-only', res.rebasedCommit])).toMatch(/mod\.txt/)
  })

  it('end-to-end: the converged branch passes the patch-equivalence gate', async () => {
    const { base, wt, baseHead, branchHead } = setupDetachedBaseSubmodule()

    const converge = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)
    expect(converge.converged).toBe(true)
    const rebased = rootRebaseResolvingGitlinks(wt, baseHead, converge.resolutions)
    expect(rebased.ok).toBe(true)
    const pe = await runMeshRefinePatchEquivalenceGate(base, baseHead, rebased.branchHead!)
    expect(pe.status).toBe('passed')
    expect(pe.equivalent).toBe(true)
  })

  it('the trivial-ff collector also sees a detached, branchless base-side commit', () => {
    // Same object-availability path, other consumer. The BASE side holds the
    // commit that is unreachable from any local branch, so the collector cannot
    // answer the ancestry question without the fetch: base advanced the submodule
    // to a descendant (branch is strictly behind) → the correct resolution is the
    // BASE-side commit. Without the fetch fix the collector cannot see it and
    // returns [], and the plain root rebase then aborts on the gitlink.
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')
    initRepo(submoduleOrigin)
    const s1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'v1')
    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'pin v1'])
    const rootMB = git(base, ['rev-parse', 'HEAD'])

    // Worktree gets its own submodule clone, pinned at s1, and advances only the root.
    const wt = join(tmp, 'wt')
    git(base, ['worktree', 'add', '-q', '--detach', wt, rootMB])
    git(wt, ['checkout', '-q', '-b', 'feat'])
    git(wt, ['submodule', 'update', '-q', '--init'])
    writeFileSync(join(wt, 'ours.txt'), 'ours\n', 'utf-8')
    git(wt, ['add', 'ours.txt'])
    git(wt, ['commit', '-q', '-m', 'branch: ours'])
    const branchHead = git(wt, ['rev-parse', 'HEAD'])

    // Base advances the submodule on a DETACHED HEAD, unpublished → s2 exists
    // only in the base workspace's submodule, reachable from no branch there.
    const baseSubRepo = join(base, 'sub')
    git(baseSubRepo, ['checkout', '-q', '--detach', s1])
    writeFileSync(join(baseSubRepo, 'mod.txt'), 'v2\n', 'utf-8')
    git(baseSubRepo, ['add', 'mod.txt'])
    git(baseSubRepo, ['commit', '-q', '-m', 'v2'])
    const s2 = git(baseSubRepo, ['rev-parse', 'HEAD'])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'base: bump sub v2'])
    const baseHead = git(base, ['rev-parse', 'HEAD'])

    // Fixture invariants: s2 is on no local branch of the base submodule, and is
    // absent from the worktree's submodule object store.
    const baseBranchTips = git(baseSubRepo, ['for-each-ref', '--format=%(objectname)', 'refs/heads/'])
      .split('\n').map(s => s.trim()).filter(Boolean)
    expect(baseBranchTips).not.toContain(s2)
    expect(() => git(join(wt, 'sub'), ['cat-file', '-e', `${s2}^{commit}`])).toThrow()

    const resolutions = collectTrivialFastForwardGitlinkResolutions(wt, base, baseHead, branchHead)
    // branch (s1) is an ancestor of base (s2) → resolve to the more-advanced base side.
    expect(resolutions).toEqual([{ path: 'sub', rebasedCommit: s2 }])
  })

  it('reports submodule_commit_unavailable — NOT not_diverged — when the object cannot be obtained', () => {
    // ★ The observability half of the fix. When the base-side commit is truly
    // unobtainable (the base workspace's submodule checkout is gone), the run must
    // say "could not determine", not make the positive claim "not divergent".
    // Conflating the two is what sent the coordinator chasing a stale-daemon theory.
    const { base, wt, baseHead, branchHead, subBase, baseSubRepo } = setupDetachedBaseSubmodule()

    // Remove the only source of the base-side object.
    rmSync(baseSubRepo, { recursive: true, force: true })
    expect(() => git(join(wt, 'sub'), ['cat-file', '-e', `${subBase}^{commit}`])).toThrow()

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(result.converged).toBe(false)
    expect(result.reason).toBe('submodule_commit_unavailable')
    expect(result.reason).not.toBe('not_diverged')
    expect(result.resolutions).toHaveLength(0)
    const [entry] = result.gitlinks
    expect(entry.action).toBe('skipped_commit_unavailable')
    expect(entry.unavailable).toContain('base')
    expect(entry.path).toBe('sub')
  })

  it('still reports not_diverged for a real strict fast-forward (no false undeterminable)', () => {
    // Guard the other direction: the new reason must not swallow the genuine
    // not_diverged case. Both commits present, strict ff → unchanged wording.
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
    git(join(wt, 'sub'), ['checkout', '-q', s2])
    git(wt, ['add', 'sub'])
    git(wt, ['commit', '-q', '-m', 'bump sub v2'])
    const branchHead = git(wt, ['rev-parse', 'HEAD'])

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(result.converged).toBe(false)
    expect(result.reason).toBe('not_diverged')
    expect(result.gitlinks[0].action).toBe('skipped_not_diverged')
  })
})

/**
 * ★PRE-MINT PUBLISH GATE (auto-rebase orphan gitlink incident).
 *
 * The incident: the Refinery hit a diverged gitlink whose branch-side submodule
 * commit was never pushed, rebased it anyway, and MINTED a brand-new submodule
 * commit (1bd259f0 analog) that existed on exactly one machine. The downstream
 * reachability gate then blocked the merge — as it must — but by that point the
 * branch had already been rewritten to point at an orphan, and the reported next
 * step ("rebase") re-minted a fresh orphan on every retry.
 *
 * The fix stops BEFORE the rewrite whenever minting is provably futile: the new
 * commit could never be reachable because nobody is allowed to publish it. When
 * publishing IS allowed, minting is legitimate and must still happen — that
 * distinction is what these tests pin down, alongside the untouched paths.
 */
describe('pre-mint publish gate (auto-rebase orphan gitlink)', () => {
  it('defers instead of minting when the branch-side commit is unpublished and auto-publish is OFF', () => {
    const { base, wt, baseHead, branchHead, subBranch } = setupDivergedSubmodule()
    const subRepo = join(wt, 'sub')
    const subHeadBefore = git(subRepo, ['rev-parse', 'HEAD'])
    const rootHeadBefore = git(wt, ['rev-parse', 'HEAD'])

    // Default policy = auto-publish disabled.
    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)

    expect(result.converged).toBe(false)
    expect(result.reason).toBe('submodule_publish_required')
    expect(result.resolutions).toEqual([])
    expect(result.gitlinks).toHaveLength(1)
    expect(result.gitlinks[0].action).toBe('publish_required_before_rebase')
    expect(result.gitlinks[0].path).toBe('sub')
    // The evidence a coordinator needs to act: which commit must be published.
    expect(result.gitlinks[0].branchCommit).toBe(subBranch)
    expect(result.gitlinks[0].remoteMainRef).toBeTruthy()

    // ★No rewrite happened — nothing was minted and neither HEAD moved. This is the
    // property the incident violated: the branch must be left exactly as the worker
    // left it, so the only remaining action is to publish.
    expect(git(subRepo, ['rev-parse', 'HEAD'])).toBe(subHeadBefore)
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(rootHeadBefore)
    expect(() => git(subRepo, ['rev-parse', '--verify', 'REBASE_HEAD'])).toThrow()
  })

  it('★over-correction guard: still mints when auto-publish is ON (reachability is obtainable)', () => {
    // The mesh in production runs with allowAutoPublishSubmoduleMainCommits=true.
    // Gating that case would break normal sibling convergence — the gate must be
    // scoped to "nobody will publish this", not "this is unpublished".
    const { base, wt, baseHead, branchHead, subBase, subBranch } = setupDivergedSubmodule()
    const subRepo = join(wt, 'sub')

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)

    expect(result.converged).toBe(true)
    expect(result.resolutions).toHaveLength(1)
    expect(result.gitlinks[0].action).toBe('rebased')
    // A genuinely new commit was minted, and the branch work survived it.
    expect(result.resolutions[0].rebasedCommit).not.toBe(subBranch)
    expect(git(subRepo, ['merge-base', '--is-ancestor', subBase, result.resolutions[0].rebasedCommit])).toBe('')
    expect(git(subRepo, ['ls-tree', '-r', '--name-only', result.resolutions[0].rebasedCommit])).toMatch(/other\.txt/)
    // ★Observability: the record says plainly that a commit was SYNTHESIZED and is
    // not yet on any remote — the fact the coordinator missed during the incident.
    expect(result.gitlinks[0].mintedUnpublishedCommit).toBe(true)
    expect(result.gitlinks[0].remoteMainRef).toBeTruthy()
  })

  it('★over-correction guard: never fires when a published equivalent exists (normal path, auto-publish OFF)', async () => {
    // The published-twin path resolves to an ALREADY-PUBLISHED commit, so nothing is
    // minted and no publish is owed. The gate must stay out of its way even with
    // auto-publish disabled — this is the common sibling-convergence case.
    const { base, wt, baseHead, branchHead, subPublished } = setupPublishedTwinSubmodule()

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)

    expect(result.converged).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(result.gitlinks[0].action).toBe('converged_to_published')
    expect(result.resolutions[0].rebasedCommit).toBe(subPublished)
    // Nothing was synthesized, so nothing is owed a publish.
    expect(result.gitlinks[0].mintedUnpublishedCommit).toBeUndefined()

    // End-to-end: still merges cleanly.
    const rebased = rootRebaseResolvingGitlinks(wt, baseHead, result.resolutions)
    expect(rebased.ok).toBe(true)
    const pe = await runMeshRefinePatchEquivalenceGate(base, baseHead, rebased.branchHead!)
    expect(pe.status).toBe('passed')
  })

  it('★over-correction guard: never fires on a trivial fast-forward gitlink (not diverged)', () => {
    // A strict-ff gitlink never reaches the rewrite path at all, so the gate must
    // report not_diverged exactly as before — no publish demand for a pointer that
    // only moved forward.
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
    git(join(wt, 'sub'), ['checkout', '-q', s2])
    git(wt, ['add', 'sub'])
    git(wt, ['commit', '-q', '-m', 'bump sub v2'])
    const branchHead = git(wt, ['rev-parse', 'HEAD'])

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)
    expect(result.reason).toBe('not_diverged')
    expect(result.gitlinks[0].action).toBe('skipped_not_diverged')
    expect(result.gitlinks.some(g => g.action === 'publish_required_before_rebase')).toBe(false)
  })

  it('★over-correction guard: a real content conflict still reports rebase_conflict, not publish_required', () => {
    // A conflicting submodule is unpublished too, so a gate placed carelessly would
    // shadow the more specific diagnosis. `rebase_conflict` is differently
    // actionable (resolve the conflict) and must win.
    const { base, wt, baseHead, branchHead, subBranch } = setupDivergedSubmodule({ conflicting: true })
    const subRepo = join(wt, 'sub')

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)

    expect(result.converged).toBe(false)
    expect(result.reason).toBe('rebase_conflict')
    expect(git(subRepo, ['rev-parse', 'HEAD'])).toBe(subBranch)
  })

  it('does not fire when the branch-side commit is already published on the submodule remote main', () => {
    // Unpublished-ness is the trigger, not divergence: when the branch-side commit
    // is already reachable from origin/main, a rebase of it produces a tip whose
    // history is publishable, so the gate must stay silent even with auto-publish
    // off. Built by publishing the branch-side sibling to origin/main directly.
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')

    initRepo(submoduleOrigin)
    const subMB = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
    // The branch-side commit is published on origin/main...
    const subBranch = commitFile(submoduleOrigin, 'other.txt', 'branch-line\n', 'sub branch add (published)')
    // ...while the base side is a sibling off the merge base, unpublished on main.
    git(submoduleOrigin, ['checkout', '-q', '-b', 'basesub', subMB])
    const subBase = commitFile(submoduleOrigin, 'mod.txt', 'v1\nbase-line\n', 'sub base edit')
    git(submoduleOrigin, ['checkout', '-q', 'main'])

    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'root init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    git(join(base, 'sub'), ['fetch', '-q', 'origin'])
    git(join(base, 'sub'), ['checkout', '-q', subMB])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'pin sub at merge-base'])
    const rootMB = git(base, ['rev-parse', 'HEAD'])
    writeFileSync(join(base, 'sibling.txt'), 'sibling\n', 'utf-8')
    git(base, ['add', 'sibling.txt'])
    git(join(base, 'sub'), ['checkout', '-q', subBase])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'base: sub->subBase + sibling'])
    const baseHead = git(base, ['rev-parse', 'HEAD'])

    const wt = join(tmp, 'wt')
    git(base, ['worktree', 'add', '-q', '--detach', wt, rootMB])
    git(wt, ['checkout', '-q', '-b', 'feat'])
    git(wt, ['submodule', 'update', '-q', '--init'])
    git(join(wt, 'sub'), ['fetch', '-q', 'origin'])
    git(join(wt, 'sub'), ['checkout', '-q', subBranch])
    git(wt, ['add', 'sub'])
    writeFileSync(join(wt, 'ours.txt'), 'ours\n', 'utf-8')
    git(wt, ['add', 'ours.txt'])
    git(wt, ['commit', '-q', '-m', 'branch: sub->subBranch + ours'])
    const branchHead = git(wt, ['rev-parse', 'HEAD'])

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)

    expect(result.reason).not.toBe('submodule_publish_required')
    expect(result.converged).toBe(true)
    // The rewrite ran and is NOT flagged as owing a publish.
    expect(result.gitlinks[0].mintedUnpublishedCommit).toBeUndefined()
  })
})

/**
 * ★UNDETERMINED-PUBLICATION GATE (shared-catch class, finding #2).
 *
 * The pre-mint publish gate asks "is the branch-side commit already published?"
 * That question used to be answered two-state: `isCommitReachableFromRemoteMain`
 * returned a bare `false` for "git said no", for "no origin main ref resolves",
 * AND for "the probe failed". Upstream of it, the submodule `git fetch origin`
 * error was swallowed entirely, so a failed fetch left `refs/remotes/origin/*`
 * stale or absent and every derived answer was read off state the remote never
 * confirmed.
 *
 * A `false` means `willMintUnpublishedCommit`, and with auto-publish enabled
 * that runs `checkout --detach` + `rebase` — MINTING a submodule commit. So a
 * transient network failure could synthesize a commit on the claim that the
 * content was unpublished, when it may already be on origin. That minted commit
 * is then what the reachability gate sees and can be pushed.
 *
 * Contract pinned here: when we could not consult the remote we do NOT mint —
 * regardless of the auto-publish policy — and we say we could not tell rather
 * than claiming a publish is required.
 *
 * ★Every fixture's `origin` is a LOCAL path that is renamed away. No test here
 * reaches a network, and none can push.
 */
describe('undetermined-publication gate (fetch failure must not mint a commit)', () => {
  it('★does NOT mint when the submodule fetch fails, even with auto-publish ON', () => {
    // The core regression. Auto-publish ON is the production configuration and
    // the one where the old code would have rebased.
    const { base, wt, baseHead, branchHead, subBranch, submoduleOrigin } = setupDivergedSubmodule()
    const subRepo = join(wt, 'sub')
    const subHeadBefore = git(subRepo, ['rev-parse', 'HEAD'])
    const rootHeadBefore = git(wt, ['rev-parse', 'HEAD'])
    const subObjectsBefore = git(subRepo, ['rev-list', '--all']).split('\n').length

    // Break the remote: origin now points at a path that does not exist, so
    // `git fetch origin` fails and no remote-tracking ref can be refreshed.
    // Also drop the stale remote-tracking refs so nothing can be read off them.
    renameSync(submoduleOrigin, `${submoduleOrigin}-moved`)
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/branchsub']) {
      try { git(subRepo, ['update-ref', '-d', ref]) } catch { /* may not exist */ }
    }

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)

    expect(result.converged).toBe(false)
    expect(result.reason).toBe('submodule_publication_undeterminable')
    expect(result.resolutions).toEqual([])
    expect(result.gitlinks).toHaveLength(1)
    expect(result.gitlinks[0].action).toBe('publication_undeterminable')
    // The evidence: the remote was never successfully consulted.
    expect(result.gitlinks[0].remoteFetched).toBe(false)

    // ★Nothing was minted and neither HEAD moved.
    expect(git(subRepo, ['rev-parse', 'HEAD'])).toBe(subHeadBefore)
    expect(git(subRepo, ['rev-parse', 'HEAD'])).toBe(subBranch)
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(rootHeadBefore)
    expect(git(subRepo, ['rev-list', '--all']).split('\n').length).toBe(subObjectsBefore)
    expect(() => git(subRepo, ['rev-parse', '--verify', 'REBASE_HEAD'])).toThrow()
  })

  it('★does NOT mint when the fetch fails and auto-publish is OFF either', () => {
    const { base, wt, baseHead, branchHead, submoduleOrigin } = setupDivergedSubmodule()
    const subRepo = join(wt, 'sub')
    const subHeadBefore = git(subRepo, ['rev-parse', 'HEAD'])
    renameSync(submoduleOrigin, `${submoduleOrigin}-moved`)
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/branchsub']) {
      try { git(subRepo, ['update-ref', '-d', ref]) } catch { /* may not exist */ }
    }

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead)

    expect(result.converged).toBe(false)
    // ★Reported as "could not tell", NOT as the positive "publish is required"
    // claim — we have no evidence the commit is unpublished.
    expect(result.reason).toBe('submodule_publication_undeterminable')
    expect(git(subRepo, ['rev-parse', 'HEAD'])).toBe(subHeadBefore)
  })

  it('★tells the operator to restore remote access, not to publish', () => {
    const { base, wt, baseHead, branchHead, submoduleOrigin } = setupDivergedSubmodule()
    renameSync(submoduleOrigin, `${submoduleOrigin}-moved`)
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/branchsub']) {
      try { git(join(wt, 'sub'), ['update-ref', '-d', ref]) } catch { /* may not exist */ }
    }

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)
    const message = describeSubmoduleConvergeDecline('node-x', result.reason, result.gitlinks)

    expect(message).toBeTruthy()
    expect(message).toContain('Could NOT determine')
    expect(message).toContain('restore access to the submodule remote')
    // ★Must not read as the publish prescription — that is the wrong remedy here.
    expect(message).not.toContain('NEXT STEP: publish')
  })

  it('★over-correction guard: a REACHABLE remote with a genuinely unpublished commit still behaves exactly as before', () => {
    // The remote is intact and the probe answers "no" for real, so the historical
    // verdict must survive untouched: publish-required with auto-publish OFF...
    const off = setupDivergedSubmodule()
    const resultOff = convergeDivergedSubmoduleGitlinks(off.wt, off.base, off.baseHead, off.branchHead)
    expect(resultOff.converged).toBe(false)
    expect(resultOff.reason).toBe('submodule_publish_required')
    expect(resultOff.gitlinks[0].action).toBe('publish_required_before_rebase')

    // ...and a real mint with auto-publish ON.
    const on = setupDivergedSubmodule()
    const resultOn = convergeDivergedSubmoduleGitlinks(on.wt, on.base, on.baseHead, on.branchHead, AUTO_PUBLISH_ON)
    expect(resultOn.converged).toBe(true)
    expect(resultOn.gitlinks[0].action).toBe('rebased')
    expect(resultOn.gitlinks[0].mintedUnpublishedCommit).toBe(true)
    expect(resultOn.resolutions).toHaveLength(1)
  })

  it('★over-correction guard: a real content conflict still reports rebase_conflict, not undeterminable', () => {
    // The conflict path is more specific and differently actionable; the new gate
    // defers to it exactly as the publish gate does.
    const { base, wt, baseHead, branchHead, submoduleOrigin } = setupDivergedSubmodule({ conflicting: true })
    renameSync(submoduleOrigin, `${submoduleOrigin}-moved`)

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)

    expect(result.converged).toBe(false)
    expect(result.reason).toBe('rebase_conflict')
  })

  it('★over-correction guard: a submodule with NO origin at all is not "undeterminable"', () => {
    // ★The regression this pins: an unreachable remote and a MISSING one produce
    // byte-identical `git fetch` output, so gating purely on "the fetch failed"
    // swept up every local-only submodule topology — a repo that never had an
    // origin was told its publication verdict could not be obtained, when in fact
    // there is no published history to be unpublished against and nothing will
    // ever be pushed. That is a determinate answer, not a missing one.
    //
    // It is not hypothetical: it broke two passing tests in
    // refine-single-node-auto-retry.test.ts, whose fixture builds exactly this
    // shape (`git init` with no remote).
    const { base, wt, baseHead, branchHead } = setupDivergedSubmodule()
    const subRepo = join(wt, 'sub')
    // Remove the remote outright, and any refs it left behind, so the only thing
    // distinguishing this from an outage is the absence of the remote itself.
    git(subRepo, ['remote', 'remove', 'origin'])
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/branchsub']) {
      try { git(subRepo, ['update-ref', '-d', ref]) } catch { /* may not exist */ }
    }

    const result = convergeDivergedSubmoduleGitlinks(wt, base, baseHead, branchHead, AUTO_PUBLISH_ON)

    expect(result.reason).not.toBe('submodule_publication_undeterminable')
    // With auto-publish ON and no remote to contradict it, the historical
    // behaviour is a normal converge.
    expect(result.converged).toBe(true)
    expect(result.gitlinks[0].action).toBe('rebased')
  })

  it('★the undetermined decline carries its own next step — not the publish prescription', () => {
    // The stage record is what the coordinator reads. Before this, the new reason
    // fell through `buildSubmoduleConvergeDeclineDetails` to `{}`, so an
    // undetermined decline arrived with NO recommendedAction at all — leaving the
    // "just retry the rebase" instinct that the publish gate exists to prevent.
    const undetermined = buildSubmoduleConvergeDeclineDetails('submodule_publication_undeterminable', true)
    expect(undetermined.recommendedAction).toBeTruthy()
    expect(undetermined.recommendedAction).toContain('Restore access to the submodule remote')
    expect(undetermined.recommendedAction).toContain('Do NOT publish')
    // ★It must NOT be the publish action: that asserts a finding nobody obtained.
    expect(undetermined.recommendedAction).not.toBe(SUBMODULE_PUBLISH_REQUIRED_RECOMMENDED_ACTION)
    // ★And it must not claim an auto-publish verdict either — the axis is irrelevant
    // when the question was never answered.
    expect(undetermined.autoPublishAllowed).toBeUndefined()

    // The positive finding keeps its own, unchanged prescription.
    const publishRequired = buildSubmoduleConvergeDeclineDetails('submodule_publish_required', true)
    expect(publishRequired.recommendedAction).toBe(SUBMODULE_PUBLISH_REQUIRED_RECOMMENDED_ACTION)
    expect(publishRequired.autoPublishAllowed).toBe(true)
  })
})
