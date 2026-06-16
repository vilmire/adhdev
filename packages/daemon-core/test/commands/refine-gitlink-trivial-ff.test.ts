import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectFastForwardGitlinkPaths, evaluateGitlinkTrivialFastForward, runMeshRefinePatchEquivalenceGate } from '../../src/commands/router'

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
  const dir = mkdtempSync(join(tmpdir(), 'refine-gitlink-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// Build a root repo with one submodule. Returns root + submodule helpers so a
// test can advance the submodule pointer on base and branch independently.
function setupRootWithSubmodule() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const root = join(tmp, 'root')

  // Submodule origin with a small history we can fast-forward through.
  initRepo(submoduleOrigin)
  const subC1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subC2 = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2')
  const subC3 = commitFile(submoduleOrigin, 'mod.txt', 'v3\n', 'sub v3')
  // A diverged branch off v1 (NOT an ancestor of v3).
  git(submoduleOrigin, ['checkout', '-q', '-b', 'fork', subC1])
  const subForked = commitFile(submoduleOrigin, 'other.txt', 'forked\n', 'sub forked')
  git(submoduleOrigin, ['checkout', '-q', 'main'])

  // Root repo with the submodule pinned at subC1.
  initRepo(root)
  commitFile(root, 'top.txt', 'top base\n', 'root init')
  git(root, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(root, 'sub'), ['checkout', '-q', subC1])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'pin submodule at v1'])
  const baseHead = git(root, ['rev-parse', 'HEAD'])

  // Make all sub commits available inside the submodule working dir for ancestry checks.
  git(join(root, 'sub'), ['fetch', '-q', 'origin'])

  const pinRootSubmodule = (commit: string, message: string): string => {
    git(join(root, 'sub'), ['checkout', '-q', commit])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', message])
    return git(root, ['rev-parse', 'HEAD'])
  }

  return { root, baseHead, subC1, subC2, subC3, subForked, pinRootSubmodule }
}

// Build a "diverged but both descend from base" scenario:
//   mergeBaseRoot  — common ancestor, submodule pinned at `subBase`
//   advancedMain   — a sibling was merged into main: edits sibling.txt AND
//                    bumps the submodule to `subAdvanced` (a descendant of base)
//   ourBump        — our feature branch off mergeBaseRoot: edits ours.txt AND
//                    bumps the submodule to `subOurs` (a descendant of advanced)
// advancedMain and ourBump are diverged at the ROOT (neither is an ancestor of
// the other) yet both descend from mergeBaseRoot, and the submodule pointer is a
// strict fast-forward advanced→ours. This is the case that wrongly failed
// patch-equivalence before the fix.
function setupDivergedBothDescend() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const root = join(tmp, 'root')

  initRepo(submoduleOrigin)
  const subBase = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subAdvanced = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2')
  const subOurs = commitFile(submoduleOrigin, 'mod.txt', 'v3\n', 'sub v3')
  // A submodule commit that is NOT a descendant of subAdvanced (forked off base).
  git(submoduleOrigin, ['checkout', '-q', '-b', 'fork', subBase])
  const subForked = commitFile(submoduleOrigin, 'other.txt', 'forked\n', 'sub forked')
  git(submoduleOrigin, ['checkout', '-q', 'main'])

  initRepo(root)
  commitFile(root, 'top.txt', 'top base\n', 'root init')
  git(root, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(root, 'sub'), ['checkout', '-q', subBase])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'pin submodule at v1'])
  const mergeBaseRoot = git(root, ['rev-parse', 'HEAD'])
  git(join(root, 'sub'), ['fetch', '-q', 'origin'])

  // advancedMain: sibling merged → sibling.txt + submodule bump to v2.
  writeFileSync(join(root, 'sibling.txt'), 'sibling\n', 'utf-8')
  git(root, ['add', 'sibling.txt'])
  git(join(root, 'sub'), ['checkout', '-q', subAdvanced])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'advanced-main: sibling merge + sub v2'])
  const advancedMain = git(root, ['rev-parse', 'HEAD'])

  // ourBump: branch off the common base, edit ours.txt + submodule bump to v3.
  // Deliberately NOT rebased onto advancedMain — the root commits diverge.
  git(root, ['checkout', '-q', '-b', 'ourfeat', mergeBaseRoot])
  git(join(root, 'sub'), ['checkout', '-q', subOurs])
  git(root, ['add', 'sub'])
  writeFileSync(join(root, 'ours.txt'), 'ours\n', 'utf-8')
  git(root, ['add', 'ours.txt'])
  git(root, ['commit', '-q', '-m', 'our-bump: ours.txt + sub v3'])
  const ourBump = git(root, ['rev-parse', 'HEAD'])

  return { root, mergeBaseRoot, advancedMain, ourBump, subBase, subAdvanced, subOurs, subForked }
}

// -----------------------------------------------------------------------

describe('evaluateGitlinkTrivialFastForward', () => {
  it('passes when the only conflict is a fast-forward gitlink bump', () => {
    const { root, baseHead, subC3, pinRootSubmodule } = setupRootWithSubmodule()
    // Branch: advance the submodule pointer to a descendant (v1 -> v3 is ff).
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = pinRootSubmodule(subC3, 'bump submodule to v3')

    const result = evaluateGitlinkTrivialFastForward(root, baseHead, branchHead)
    expect(result.trivial).toBe(true)
    expect(result.gitlinks).toHaveLength(1)
    expect(result.gitlinks[0]).toMatchObject({ path: 'sub', fastForward: true })
  })

  it('blocks when the gitlink diverged (not a fast-forward)', () => {
    const { root, baseHead, subForked, pinRootSubmodule } = setupRootWithSubmodule()
    // First move base forward to v2 so the branch fork is NOT an ancestor.
    const newBase = pinRootSubmodule(git(join(root, 'sub'), ['rev-parse', 'origin/main^']), 'base to v2')
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = pinRootSubmodule(subForked, 'point submodule at forked commit')

    const result = evaluateGitlinkTrivialFastForward(root, newBase, branchHead)
    expect(result.trivial).toBe(false)
    expect(result.reason).toMatch(/diverged_gitlinks/)
  })

  it('blocks when a regular file also conflicts alongside a ff gitlink', () => {
    const { root, baseHead, subC2, subC3, pinRootSubmodule } = setupRootWithSubmodule()
    // Diverge a regular file on BOTH sides relative to merge-base so a 3-way
    // content conflict exists in addition to the ff gitlink bump.
    // Base side: change top.txt + advance submodule to v2.
    writeFileSync(join(root, 'top.txt'), 'top BASE EDIT\n', 'utf-8')
    git(root, ['add', 'top.txt'])
    git(join(root, 'sub'), ['checkout', '-q', subC2])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'base edits top + sub v2'])
    const newBase = git(root, ['rev-parse', 'HEAD'])

    // Branch off the ORIGINAL base, edit top.txt differently + advance sub to v3.
    git(root, ['checkout', '-q', '-b', 'feat', baseHead])
    writeFileSync(join(root, 'top.txt'), 'top BRANCH EDIT\n', 'utf-8')
    git(root, ['add', 'top.txt'])
    git(join(root, 'sub'), ['checkout', '-q', subC3])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'branch edits top + sub v3'])
    const branchHead = git(root, ['rev-parse', 'HEAD'])

    const result = evaluateGitlinkTrivialFastForward(root, newBase, branchHead)
    expect(result.trivial).toBe(false)
    expect(result.reason).toMatch(/non_gitlink_overlap/)
  })

  it('blocks when there is no changed gitlink at all', () => {
    const { root, baseHead } = setupRootWithSubmodule()
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = commitFile(root, 'top.txt', 'top base\nfeature line\n', 'feature edit only')

    const result = evaluateGitlinkTrivialFastForward(root, baseHead, branchHead)
    expect(result.trivial).toBe(false)
    expect(result.reason).toBe('no_changed_gitlinks')
  })

  // Regression: advanced-main and our-bump diverged at the root (neither is an
  // ancestor of the other) but both descend from the common base, and the
  // submodule pointer advanced→ours is a strict fast-forward. The evaluator
  // must still treat the gitlink as a trivial ff (our-side commit descends from
  // the main-side commit), not as a diverged conflict.
  it('passes when root commits diverged but the gitlink still fast-forwards', () => {
    const { root, advancedMain, ourBump } = setupDivergedBothDescend()
    const result = evaluateGitlinkTrivialFastForward(root, advancedMain, ourBump)
    expect(result.trivial).toBe(true)
    expect(result.gitlinks).toHaveLength(1)
    expect(result.gitlinks[0]).toMatchObject({ path: 'sub', fastForward: true })
  })

  // Guard against false-pass: when the submodule pointers genuinely diverge
  // (our-side is NOT a descendant of the main-side), the conflict must stay
  // blocked even if both root commits descend from a common base.
  it('blocks when root diverged AND the gitlink is a real (non-ff) divergence', () => {
    const { root, advancedMain, ourBump, mergeBaseRoot, subForked } = setupDivergedBothDescend()
    // Re-point our-bump's submodule at a forked commit that does NOT descend
    // from advanced-main's pointer (a genuine submodule divergence).
    git(root, ['checkout', '-q', '-B', 'ourfeat-diverged', mergeBaseRoot])
    git(join(root, 'sub'), ['checkout', '-q', subForked])
    git(root, ['add', 'sub'])
    writeFileSync(join(root, 'ours.txt'), 'ours\n', 'utf-8')
    git(root, ['add', 'ours.txt'])
    git(root, ['commit', '-q', '-m', 'our-bump: ours.txt + forked sub'])
    const ourDiverged = git(root, ['rev-parse', 'HEAD'])
    expect(ourBump).not.toBe(ourDiverged)

    const result = evaluateGitlinkTrivialFastForward(root, advancedMain, ourDiverged)
    expect(result.trivial).toBe(false)
    expect(result.reason).toMatch(/diverged_gitlinks/)
  })
})

describe('runMeshRefinePatchEquivalenceGate', () => {
  // The end-to-end bug: even with evaluateGitlinkTrivialFastForward returning
  // trivial=true, the gate previously failed because (a) the synthesized merge
  // tree dropped our branch's non-gitlink changes and (b) the gitlink hunk's
  // old-value differs between the expected and actual patch-ids. The fix runs a
  // real 3-way merge and excludes the ff'd gitlink path from the patch-id
  // comparison. This is the exact 3-way pointer state from the reproductions.
  it('passes a diverged-but-both-descend gitlink fast-forward', async () => {
    const { root, advancedMain, ourBump } = setupDivergedBothDescend()
    const result = await runMeshRefinePatchEquivalenceGate(root, advancedMain, ourBump)
    expect(result.equivalent).toBe(true)
    expect(result.status).toBe('passed')
    // The synthesized merge tree must contain BOTH sides' non-gitlink changes
    // and the fast-forwarded submodule pointer.
    expect(result.mergedTree).toBeTruthy()
    const merged = git(root, ['ls-tree', '-r', result.mergedTree!])
    expect(merged).toMatch(/\bsibling\.txt\b/)   // from advanced-main side
    expect(merged).toMatch(/\bours\.txt\b/)       // from our-bump side
    const subLine = git(root, ['ls-tree', result.mergedTree!, '--', 'sub'])
    expect(subLine).toContain(git(join(root, 'sub'), ['rev-parse', 'origin/main'])) // sub v3
  })

  // Backward compatibility: the simple non-diverged case (base IS the merge-base,
  // only a gitlink bump) must still pass.
  it('passes the simple non-diverged gitlink bump', async () => {
    const { root, baseHead, subC3, pinRootSubmodule } = setupRootWithSubmodule()
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = pinRootSubmodule(subC3, 'bump submodule to v3')

    const result = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
    expect(result.equivalent).toBe(true)
    expect(result.status).toBe('passed')
  })

  // False-pass guard: the patch-equivalence exclusion must ONLY apply to gitlinks
  // that are a *proven* fast-forward. A genuinely diverged (non-ff) submodule
  // must NOT be excluded — its differing hunk has to stay in the patch-id
  // comparison so the gate cannot be tricked into passing a real divergence.
  it('does not exclude a genuinely diverged (non-ff) gitlink from the comparison', () => {
    const { root, baseHead, subForked, pinRootSubmodule } = setupRootWithSubmodule()
    // Base advances to v2; branch points at a forked commit that does NOT descend
    // from v2 — a genuine divergence, not a fast-forward.
    const newBase = pinRootSubmodule(git(join(root, 'sub'), ['rev-parse', 'origin/main^']), 'base to v2')
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = pinRootSubmodule(subForked, 'point submodule at forked commit')

    const excluded = collectFastForwardGitlinkPaths(root, newBase, branchHead)
    expect(excluded).not.toContain('sub')
    // And the evaluator still classifies the merge-tree submodule conflict as
    // non-trivial, so the bail path keeps the block too.
    const evaluation = evaluateGitlinkTrivialFastForward(root, newBase, branchHead)
    expect(evaluation.trivial).toBe(false)
    expect(evaluation.reason).toMatch(/diverged_gitlinks/)
  })

  // The diverged-but-both-descend gitlink IS excluded (it is a proven ff), which
  // is exactly what lets the gate pass that case.
  it('excludes only the proven fast-forward gitlink in the diverged-but-both-descend case', () => {
    const { root, advancedMain, ourBump } = setupDivergedBothDescend()
    const excluded = collectFastForwardGitlinkPaths(root, advancedMain, ourBump)
    expect(excluded).toEqual(['sub'])
  })
})
