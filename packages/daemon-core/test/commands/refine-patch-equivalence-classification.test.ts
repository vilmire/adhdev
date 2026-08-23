import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { classifyPatchEquivalenceFailure, runMeshRefinePatchEquivalenceGate } from '../../src/commands/router'

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
  const dir = mkdtempSync(join(tmpdir(), 'refine-peclass-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// Root repo with one submodule whose local origin/main we can advance/diverge.
function setupRootWithSubmodule() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const root = join(tmp, 'root')

  initRepo(submoduleOrigin)
  const subC1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subC2 = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2')
  const subC3 = commitFile(submoduleOrigin, 'mod.txt', 'v3\n', 'sub v3')

  initRepo(root)
  commitFile(root, 'top.txt', 'top base\n', 'root init')
  git(root, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(root, 'sub'), ['checkout', '-q', subC1])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'pin submodule at v1'])
  const baseHead = git(root, ['rev-parse', 'HEAD'])
  // Make all sub commits available + origin/main mirror inside the submodule work dir.
  git(join(root, 'sub'), ['fetch', '-q', 'origin'])

  return { tmp, submoduleOrigin, root, subC1, subC2, subC3, baseHead }
}

async function classifyForBranch(root: string, baseHead: string, branchHead: string, autoPublish?: boolean) {
  const summary = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
  const classification = await classifyPatchEquivalenceFailure(root, baseHead, branchHead, summary, {
    targetBaseRef: baseHead,
    autoPublishSubmoduleMainCommits: autoPublish,
  })
  return { summary, classification }
}

describe('classifyPatchEquivalenceFailure', () => {
  it('already_converged — branch identical to base (ahead 0, behind 0, no diff)', async () => {
    const tmp = makeTmp()
    const root = join(tmp, 'root')
    initRepo(root)
    const baseHead = commitFile(root, 'a.txt', 'a\n', 'c1')
    // Branch points at the exact same commit.
    git(root, ['checkout', '-q', '-b', 'feature'])
    const branchHead = git(root, ['rev-parse', 'HEAD'])

    const { classification } = await classifyForBranch(root, baseHead, branchHead)
    expect(classification.detailedReason).toBe('already_converged')
    expect(classification.evidence.ahead).toBe(0)
    expect(classification.evidence.behind).toBe(0)
    expect(classification.recommendedAction).toMatch(/already converged|no merge/i)
  })

  it('base_divergence — HEAD is not a descendant of the target base', async () => {
    const tmp = makeTmp()
    const root = join(tmp, 'root')
    initRepo(root)
    const c1 = commitFile(root, 'shared.txt', 'line1\n', 'c1')
    // base and branch both edit the SAME file to conflicting content so a merge is
    // NOT a clean patch-equivalent apply — the gate genuinely fails while the base
    // is diverged from HEAD (ahead>0 AND behind>0).
    const baseHead = commitFile(root, 'shared.txt', 'line1\nBASE\n', 'base advance')
    git(root, ['checkout', '-q', '-b', 'feature', c1])
    const branchHead = commitFile(root, 'shared.txt', 'line1\nBRANCH\n', 'branch advance')

    const { summary, classification } = await classifyForBranch(root, baseHead, branchHead)
    expect(summary.equivalent).toBe(false)
    expect(classification.evidence.baseDiverged).toBe(true)
    expect(classification.evidence.ahead).toBeGreaterThan(0)
    expect(classification.evidence.behind).toBeGreaterThan(0)
    expect(classification.detailedReason).toBe('base_divergence')
    expect(classification.recommendedAction).toMatch(/rebase/i)
  })

  it('actual_patch_diff — genuine non-equivalent content on a descendant branch', async () => {
    const tmp = makeTmp()
    const root = join(tmp, 'root')
    initRepo(root)
    const baseHead = commitFile(root, 'a.txt', 'a\n', 'c1')
    // Branch descends base (HEAD is a descendant → not base_divergence) but the
    // gate would only fail equivalence on genuinely non-mergeable content. For a
    // plain descendant with clean content the gate PASSES, so we assert the
    // classifier does not spuriously report base_divergence for a descendant.
    git(root, ['checkout', '-q', '-b', 'feature'])
    const branchHead = commitFile(root, 'b.txt', 'b\n', 'add b')

    const summary = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
    const classification = await classifyPatchEquivalenceFailure(root, baseHead, branchHead, summary, { targetBaseRef: baseHead })
    // Descendant branch → base is an ancestor → never base_divergence.
    expect(classification.evidence.baseDiverged).toBe(false)
  })

  it('submodule_unreachable — changed gitlink commit not reachable from submodule origin/main', async () => {
    const { root, submoduleOrigin, baseHead, subC1 } = setupRootWithSubmodule()
    // Create a submodule commit that is NOT on origin/main (a fresh commit only in
    // the local submodule working dir, never pushed to the submodule origin).
    const subLocal = join(root, 'sub')
    git(subLocal, ['checkout', '-q', subC1])
    const unpublished = commitFile(subLocal, 'local-only.txt', 'unpublished\n', 'sub local-only')
    // Branch advances the root gitlink to that unpublished submodule commit.
    git(root, ['checkout', '-q', '-b', 'feature'])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'bump submodule to unpublished commit'])
    const branchHead = git(root, ['rev-parse', 'HEAD'])

    const { classification } = await classifyForBranch(root, baseHead, branchHead, false)
    // The unpublished submodule commit must be flagged unreachable.
    const gl = classification.evidence.submoduleGitlinks || []
    expect(gl.some(g => g.branchCommit === unpublished && g.reachableFromOriginMain === false)).toBe(true)
    expect(classification.detailedReason).toBe('submodule_unreachable')
    expect(classification.recommendedAction).toMatch(/publish/i)
    expect(classification.recommendedAction).toMatch(/allowAutoPublishSubmoduleMainCommits=false/)
  })

  it('trivial_ff_misjudgment — descendant + only a fast-forward gitlink blocks the merge-tree', async () => {
    const { root, baseHead, subC1, subC3 } = setupRootWithSubmodule()
    // Branch fast-forwards the submodule pointer v1 -> v3 (a strict ff on origin/main).
    git(root, ['checkout', '-q', '-b', 'feature'])
    const subLocal = join(root, 'sub')
    git(subLocal, ['checkout', '-q', subC3])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'fast-forward submodule v1 -> v3'])
    const branchHead = git(root, ['rev-parse', 'HEAD'])

    const summary = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
    const classification = await classifyPatchEquivalenceFailure(root, baseHead, branchHead, summary, { targetBaseRef: baseHead })
    // subC3 is reachable from origin/main (published), and the gitlink is a strict ff.
    const gl = classification.evidence.submoduleGitlinks || []
    const subEntry = gl.find(g => g.path === 'sub')
    expect(subEntry?.fastForward).toBe(true)
    expect(subEntry?.reachableFromOriginMain).toBe(true)
    // The gate resolves this trivial ff itself (equivalent === true), so it is NOT
    // a failure at all here — but if the gate had blocked, the classifier must map
    // a descendant + ff-only gitlink to trivial_ff_misjudgment, never actual_patch_diff.
    if (!summary.equivalent) {
      expect(classification.detailedReason).toBe('trivial_ff_misjudgment')
      expect(classification.recommendedAction).toMatch(/fast-forward/i)
    } else {
      expect(classification.evidence.baseDiverged).toBe(false)
    }
  })

  // ── ★worktree-scoped submodule probe (2026-08-22 false-block regression) ──
  //
  // The classifier used to resolve submodule paths against `repoRoot` (the BASE
  // repo). A worktree shares the base's object store for ROOT history, but
  // <base>/sub and <worktree>/sub are separate checkouts with separate object
  // stores and separate remote-tracking refs. The base mirror routinely lacks
  // the branch-side submodule commit and carries a stale origin/main — so the
  // probe reported `reachableFromOriginMain: false` for a commit that WAS on
  // the submodule's main. These tests pin the worktree scoping and, just as
  // importantly, that a genuinely unreachable commit is STILL blocked.

  /**
   * Base repo + a linked worktree, each with its own submodule checkout.
   * The base's submodule checkout is deliberately left STALE (no fetch), which
   * is what the real base mirror looks like.
   */
  function setupBaseAndWorktreeWithSubmodule() {
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const root = join(tmp, 'root')
    const worktree = join(tmp, 'wt')

    initRepo(submoduleOrigin)
    const subC1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

    initRepo(root)
    commitFile(root, 'top.txt', 'top base\n', 'root init')
    git(root, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    git(join(root, 'sub'), ['checkout', '-q', subC1])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'pin submodule at v1'])
    const baseHead = git(root, ['rev-parse', 'HEAD'])

    // A NEW submodule commit published to the submodule origin's main AFTER the
    // base checkout last fetched. The base mirror therefore has neither the
    // object nor an origin/main that contains it — exactly the incident state.
    const subC2 = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2 (published)')

    // The worktree: a real linked worktree on a feature branch, with its own
    // submodule checkout that HAS fetched the submodule origin.
    git(root, ['worktree', 'add', '-q', '-b', 'feature', worktree, baseHead])
    git(worktree, ['submodule', 'update', '--init', '-q'])
    git(join(worktree, 'sub'), ['fetch', '-q', 'origin'])
    git(join(worktree, 'sub'), ['checkout', '-q', subC2])
    git(worktree, ['add', 'sub'])
    git(worktree, ['commit', '-q', '-m', 'bump submodule to published v2'])
    const branchHead = git(worktree, ['rev-parse', 'HEAD'])

    return { tmp, submoduleOrigin, root, worktree, subC1, subC2, baseHead, branchHead }
  }

  it('★worktree-scoped probe: a PUBLISHED submodule commit is not reported unreachable when the base mirror is stale', async () => {
    const { root, worktree, baseHead, branchHead, subC2 } = setupBaseAndWorktreeWithSubmodule()

    // Precondition: the base mirror genuinely cannot answer (stale). If this
    // ever stops holding, the test below would pass vacuously.
    let baseCanAnswer = true
    try {
      git(join(root, 'sub'), ['merge-base', '--is-ancestor', subC2, 'refs/remotes/origin/main'])
    } catch { baseCanAnswer = false }
    expect(baseCanAnswer).toBe(false)

    const summary = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
    const classification = await classifyPatchEquivalenceFailure(root, baseHead, branchHead, summary, {
      targetBaseRef: baseHead,
      worktreeRoot: worktree,
    })

    const sub = (classification.evidence.submoduleGitlinks || []).find(g => g.path === 'sub')
    // The commit IS on the submodule's origin/main → must never be `false`.
    expect(sub?.reachableFromOriginMain).not.toBe(false)
    expect(classification.detailedReason).not.toBe('submodule_unreachable')
    expect(classification.evidence.submoduleReachabilityUndeterminable).toBeFalsy()
    // And the probe must have run in the worktree checkout, not the base mirror.
    expect(sub?.probedRepo).toContain('wt')
  })

  it('★OVER-CORRECTION GUARD: a genuinely UNREACHABLE submodule commit is STILL blocked', async () => {
    const { root, worktree, baseHead, subC1 } = setupBaseAndWorktreeWithSubmodule()

    // Create a submodule commit that exists ONLY in the worktree's submodule
    // checkout and was never pushed to the submodule origin. Even with the
    // worktree scoping + ensureSubmoduleCommitLocal pre-fetch, this must be
    // provably unreachable and must keep blocking.
    const wtSub = join(worktree, 'sub')
    git(wtSub, ['checkout', '-q', subC1])
    const unpublished = commitFile(wtSub, 'never-pushed.txt', 'local only\n', 'sub unpublished')
    git(worktree, ['add', 'sub'])
    git(worktree, ['commit', '-q', '-m', 'bump submodule to UNPUBLISHED commit'])
    const branchHead = git(worktree, ['rev-parse', 'HEAD'])

    const summary = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
    const classification = await classifyPatchEquivalenceFailure(root, baseHead, branchHead, summary, {
      targetBaseRef: baseHead,
      worktreeRoot: worktree,
      autoPublishSubmoduleMainCommits: false,
    })

    const sub = (classification.evidence.submoduleGitlinks || []).find(g => g.path === 'sub')
    expect(sub?.branchCommit).toBe(unpublished)
    // Provably not reachable — a real `false`, not an unanswered probe.
    expect(sub?.reachableFromOriginMain).toBe(false)
    expect(sub?.undeterminable || []).not.toContain('reachableFromOriginMain')
    expect(classification.detailedReason).toBe('submodule_unreachable')
    expect(classification.recommendedAction).toMatch(/publish/i)
  })

  it('★"undeterminable" is a DISTINCT state from "unreachable" — never folded into false', async () => {
    const { root, worktree, baseHead, branchHead } = setupBaseAndWorktreeWithSubmodule()

    // Make the probe genuinely unanswerable: delete the submodule's
    // remote-tracking ref AND its remote, in BOTH checkouts, so neither the
    // worktree nor the base can resolve refs/remotes/origin/main and no fetch
    // strategy can restore it.
    for (const sub of [join(worktree, 'sub'), join(root, 'sub')]) {
      try { git(sub, ['remote', 'remove', 'origin']) } catch { /* may not exist */ }
      try { git(sub, ['update-ref', '-d', 'refs/remotes/origin/main']) } catch { /* ignore */ }
    }

    const summary = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
    const classification = await classifyPatchEquivalenceFailure(root, baseHead, branchHead, summary, {
      targetBaseRef: baseHead,
      worktreeRoot: worktree,
    })

    const sub = (classification.evidence.submoduleGitlinks || []).find(g => g.path === 'sub')
    // ★The whole point: unanswered must NOT become `false`.
    expect(sub?.reachableFromOriginMain).toBeUndefined()
    expect(sub?.undeterminable || []).toContain('reachableFromOriginMain')
    expect(classification.evidence.submoduleReachabilityUndeterminable).toBe(true)
    expect(classification.detailedReason).toBe('submodule_reachability_undeterminable')
    expect(classification.detailedReason).not.toBe('submodule_unreachable')
    // The wording must say "could not determine", not "publish this commit".
    expect(classification.detailedReasonDescription).toMatch(/could not determine/i)
    expect(classification.recommendedAction).toMatch(/do not publish/i)
  })

  it('evidence always carries baseHead/branchHead/ahead/behind + policy value', async () => {
    const tmp = makeTmp()
    const root = join(tmp, 'root')
    initRepo(root)
    const c1 = commitFile(root, 'a.txt', 'a\n', 'c1')
    const baseHead = commitFile(root, 'base.txt', 'base\n', 'base advance')
    git(root, ['checkout', '-q', '-b', 'feature', c1])
    const branchHead = commitFile(root, 'branch.txt', 'branch\n', 'branch advance')

    const summary = await runMeshRefinePatchEquivalenceGate(root, baseHead, branchHead)
    const classification = await classifyPatchEquivalenceFailure(root, baseHead, branchHead, summary, {
      targetBaseRef: baseHead,
      autoPublishSubmoduleMainCommits: true,
    })
    expect(classification.evidence.baseHead).toBe(baseHead)
    expect(classification.evidence.branchHead).toBe(branchHead)
    expect(typeof classification.evidence.ahead).toBe('number')
    expect(typeof classification.evidence.behind).toBe('number')
    expect(classification.evidence.autoPublishSubmoduleMainCommits).toBe(true)
  })
})
