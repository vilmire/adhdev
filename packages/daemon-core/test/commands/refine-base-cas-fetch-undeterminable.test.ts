import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runRefineMergeAndFinalizeLocked } from '../../src/commands/router-refine'

/**
 * ★The DS2 base-movement CAS is the ONLY time-of-check guard in front of the
 * Refinery's `git merge` + `git push origin <base>`. It used to run
 *
 *     git fetch origin <base>
 *     git rev-parse origin/<base>
 *
 * under ONE shared `catch` that left `baseMoved = false` — the exact value that
 * also means "the remote confirmed the base has not moved". A failure to CONSULT
 * the remote was therefore indistinguishable from a successful consultation, the
 * stage was recorded as `base_cas: passed`, and control fell through to the merge
 * and (when `requireApprovalForPush` is false) a real push to origin.
 *
 * The precondition is ordinary: on 2026-08-23 a dead macOS DNS resolver broke
 * `git fetch` in every worktree on this machine and left ZERO lines in 17MB of
 * daemon log — the shared catch swallowed it whole.
 *
 * These tests pin the corrected contract:
 *   fetch fails            → base_cas_undeterminable → NO merge, NO push (fail-closed)
 *   rev-parse fails/empty  → base_cas_undeterminable → NO merge, NO push (fail-closed)
 *   fetch ok + base moved  → base_moved              → NO merge, NO push (UNCHANGED —
 *                                                      the over-correction guard)
 *   fetch ok + base same   → proceeds past the CAS   → merge runs (UNCHANGED)
 *
 * ★NOTE ON SAFETY: every fixture's `origin` is a LOCAL filesystem path created by
 * the test. No case in this file can reach a network, and the only case that
 * reaches `git push` pushes into a local bare repo the test itself made and then
 * deletes. That matters here specifically: the defect under test is "a push that
 * should not have happened", so the test must not be capable of one.
 */

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
  const dir = mkdtempSync(join(tmpdir(), 'refine-base-cas-'))
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
 * A base repo cloned from a local bare origin, plus a feature branch worktree
 * with one extra commit — the shape `runRefineMergeAndFinalizeLocked` expects
 * when every earlier gate has passed and only the merge/push remains.
 */
function buildFixture() {
  const root = makeTmp()
  const originPath = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const repoRoot = join(root, 'base')
  const workspace = join(root, 'wt')

  // Bare local origin, seeded with one commit on main.
  initRepo(seed)
  commitFile(seed, 'README.md', 'seed\n', 'seed')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originPath], { encoding: 'utf-8' })
  git(seed, ['remote', 'add', 'origin', originPath])
  git(seed, ['push', '-q', 'origin', 'main'])

  // Base checkout.
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', originPath, repoRoot], { encoding: 'utf-8' })
  git(repoRoot, ['config', 'user.email', 'test@example.com'])
  git(repoRoot, ['config', 'user.name', 'Test User'])
  const baseHead = git(repoRoot, ['rev-parse', 'origin/main'])

  // Feature branch in a worktree, one commit ahead.
  git(repoRoot, ['worktree', 'add', '-q', '-b', 'feature/x', workspace, 'main'])
  git(workspace, ['config', 'user.email', 'test@example.com'])
  git(workspace, ['config', 'user.name', 'Test User'])
  const branchHead = commitFile(workspace, 'feature.txt', 'work\n', 'feat: work')

  return { root, originPath, repoRoot, workspace, baseHead, branchHead }
}

type Recorded = { file: string; args: string[]; cwd: string }

/**
 * Drives the real stage with a real `git`, recording every invocation so the
 * assertions can prove a merge/push did or did not happen — rather than
 * inferring it from the result shape alone.
 *
 * `failFetch` simulates the 2026-08-23 outage precisely where it happened: the
 * `git fetch origin <base>` call, and nowhere else. Everything else runs for
 * real, so a fix that merely reorders the code cannot pass.
 */
async function runStage(fx: ReturnType<typeof buildFixture>, opts: {
  failFetch?: boolean
  failRevParse?: boolean
  emptyRevParse?: boolean
  requireApprovalForPush?: boolean
  baseHeadOverride?: string
} = {}) {
  const calls: Recorded[] = []
  const execFileAsync = async (file: string, args: string[], options: any) => {
    calls.push({ file, args, cwd: options.cwd })
    if (opts.failFetch && args[0] === 'fetch') {
      throw new Error("fatal: unable to access 'origin': Could not resolve host: github.com")
    }
    if (args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) {
      if (opts.failRevParse) throw new Error('fatal: ambiguous argument')
      if (opts.emptyRevParse) return { stdout: '\n', stderr: '' }
    }
    const stdout = execFileSync(file, ['-c', 'protocol.file.allow=always', ...args], {
      cwd: options.cwd,
      encoding: 'utf-8',
    })
    return { stdout, stderr: '' }
  }

  const ctx: any = {
    meshId: 'mesh_test',
    nodeId: 'node_test',
    args: {},
    refineStages: [],
    execFileAsync,
    mesh: { policy: { requireApprovalForPush: opts.requireApprovalForPush ?? false } },
    node: { id: 'node_test', workspace: fx.workspace },
    sourceNode: undefined,
    repoRoot: fx.repoRoot,
    branch: 'feature/x',
    baseBranch: 'main',
    baseHead: opts.baseHeadOverride ?? fx.baseHead,
    branchHead: fx.branchHead,
    validationSummary: { passed: true },
    patchEquivalence: { equivalent: true },
    submoduleReachability: { ok: true },
  }

  // Only the post-push worktree cleanup reaches into `self` (session sweep +
  // remove_mesh_node), which is out of scope here — stub it so the stage runs to
  // completion. The CAS / merge / push path under test never touches `self`.
  const self: any = { deps: {}, execute: async () => ({ success: true }) }
  const outcome = await runRefineMergeAndFinalizeLocked(self, ctx)
  const ran = (verb: string) => calls.some(c => c.args[0] === verb)
  return {
    outcome,
    calls,
    stages: ctx.refineStages as Array<Record<string, any>>,
    mergeRan: ran('merge'),
    pushRan: calls.some(c => c.args[0] === 'push'),
  }
}

describe('base_cas: an unobtained verdict must not authorize a merge or a push', () => {
  it('★fetch failure does NOT read as "base unmoved" — it blocks before merge and push', async () => {
    const fx = buildFixture()
    const { outcome, stages, mergeRan, pushRan } = await runStage(fx, { failFetch: true })

    // ★THE REGRESSION: pre-fix this returned kind:'continue'-equivalent success
    // with base_cas recorded as `passed`, then merged and pushed.
    expect(outcome.kind).toBe('terminal')
    const result = (outcome as any).result
    expect(result.success).toBe(false)
    expect(result.code).toBe('base_cas_undeterminable')
    expect(result.convergenceStatus).toBe('blocked_review')
    expect(result.retryable).toBe(true)

    // The push gate was WIDE OPEN (requireApprovalForPush: false) and still no push.
    expect(pushRan).toBe(false)
    expect(mergeRan).toBe(false)

    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.status).toBe('failed')
    expect(cas?.undeterminable).toBe(true)
    // The swallowed cause is now on the record instead of being discarded.
    expect(String(cas?.fetchError)).toMatch(/Could not resolve host/)

    // The prescription must not read as "the base moved" — it did not; we could not look.
    expect(String(result.error)).toMatch(/Could not verify/)
    expect(String(result.error)).not.toMatch(/advanced from/)
  })

  it('★a failing rev-parse is undeterminable too — the two steps no longer share a catch', async () => {
    const fx = buildFixture()
    const { outcome, mergeRan, pushRan } = await runStage(fx, { failRevParse: true })
    const result = (outcome as any).result
    expect(result.code).toBe('base_cas_undeterminable')
    expect(mergeRan).toBe(false)
    expect(pushRan).toBe(false)
  })

  it('★a fetch that succeeds but resolves no SHA is not "unmoved" either', async () => {
    const fx = buildFixture()
    const { outcome, mergeRan, pushRan } = await runStage(fx, { emptyRevParse: true })
    const result = (outcome as any).result
    expect(result.code).toBe('base_cas_undeterminable')
    expect(mergeRan).toBe(false)
    expect(pushRan).toBe(false)
  })
})

describe('base_cas: over-correction guards — the real verdicts still behave exactly as before', () => {
  it('★a base that genuinely MOVED is still blocked, and still as base_moved (not undeterminable)', async () => {
    const fx = buildFixture()
    // Advance origin/main behind this node's back, exactly like a racing peer.
    const peer = join(fx.root, 'peer')
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', fx.originPath, peer], { encoding: 'utf-8' })
    git(peer, ['config', 'user.email', 'test@example.com'])
    git(peer, ['config', 'user.name', 'Test User'])
    commitFile(peer, 'peer.txt', 'peer\n', 'peer: advance base')
    git(peer, ['push', '-q', 'origin', 'main'])

    const { outcome, stages, mergeRan, pushRan } = await runStage(fx)
    const result = (outcome as any).result
    expect(result.success).toBe(false)
    // ★The fix must NOT swallow real movement into the new code.
    expect(result.code).toBe('base_moved')
    expect(result.retryable).toBe(true)
    expect(result.liveBaseHead).toBeTruthy()
    expect(result.liveBaseHead).not.toBe(fx.baseHead)
    expect(mergeRan).toBe(false)
    expect(pushRan).toBe(false)

    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.status).toBe('failed')
    expect(cas?.undeterminable).toBeUndefined()
  })

  it('★an unmoved base still PASSES the CAS and proceeds to the merge (no over-blocking)', async () => {
    const fx = buildFixture()
    const { stages, mergeRan } = await runStage(fx, { requireApprovalForPush: true })

    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.status).toBe('passed')
    expect(cas?.undeterminable).toBeUndefined()
    // ★The whole point of a fail-closed gate is that it still lets the good case
    // through. requireApprovalForPush is ON here so the merge lands locally and
    // no push is attempted at all.
    expect(mergeRan).toBe(true)
    const merged = git(fx.repoRoot, ['log', '--oneline', '-1'])
    expect(merged).toMatch(/Auto-merge branch 'feature\/x'/)
  })

  it('★a repo with NO origin at all is not "undeterminable" — a local-only mesh still converges', async () => {
    const fx = buildFixture()
    // Drop the remote entirely. This is the case that separates "we failed to
    // obtain evidence" (fail-closed) from "there is no remote base that could
    // have moved, and nothing will be published" (nothing to guard).
    git(fx.repoRoot, ['remote', 'remove', 'origin'])

    const { outcome, stages, mergeRan, pushRan } = await runStage(fx, { requireApprovalForPush: true })
    const result = (outcome as any).result
    expect(result.code).not.toBe('base_cas_undeterminable')
    expect(mergeRan).toBe(true)
    expect(pushRan).toBe(false)

    const cas = stages.filter(s => s.stage === 'base_cas')
    // Exactly one record for the stage — skipped, with the reason named.
    expect(cas).toHaveLength(1)
    expect(cas[0].status).toBe('skipped')
    expect(cas[0].reason).toBe('no_origin_remote')
  })

  it('★the good case still pushes when approval is not required — the gate is not a blanket block', async () => {
    const fx = buildFixture()
    const { pushRan, mergeRan } = await runStage(fx, { requireApprovalForPush: false })
    expect(mergeRan).toBe(true)
    // Pushes into the test's own local bare origin — never a real remote.
    expect(pushRan).toBe(true)
    const originHead = git(fx.originPath, ['rev-parse', 'main'])
    expect(originHead).toBe(git(fx.repoRoot, ['rev-parse', 'HEAD']))
  })
})

/**
 * ★R3: the pin is REMOTE, the merge is LOCAL, and until this check nothing
 * compared the two.
 *
 *   resolve_refs pins baseHead to origin/<base>        (router-refine.ts)
 *   the merge runs `git merge <branch>` in repoRoot    → against LOCAL HEAD
 *
 * The Refinery merges locally and pushes later — and under
 * `requireApprovalForPush` never pushes at all — so a local base ahead of the pin
 * is the NORMAL steady state. The two stages that could have caught the gap both
 * looked at the wrong SHA: sync_base measures divergence against the PIN, so a
 * branch behind the local base still reported `behind === 0` /
 * `branch_up_to_date_with_base` and skipped its rebase; then base_cas compared
 * pin↔origin, found them equal because BOTH were stale, and returned 'unmoved'.
 * The merge then ran against a base the branch had never absorbed.
 *
 * Observed: pin 74820488 vs local 7df78f1a (9 commits ahead) → rebase skipped →
 * merge_failed, conflicts in `oss`.
 */
describe('base_cas: a LOCAL base ahead of the pin is movement too', () => {
  /**
   * Advances repoRoot's local base past the pin WITHOUT touching origin — the
   * unpushed-local-merge shape. `conflicting` decides whether those local commits
   * touch the same file the branch does; the branch is never rebased onto them
   * either way, which is the actual defect.
   */
  function advanceLocalBaseOnly(fx: ReturnType<typeof buildFixture>, opts: { conflicting?: boolean } = {}) {
    const before = git(fx.repoRoot, ['rev-parse', 'HEAD'])
    commitFile(
      fx.repoRoot,
      opts.conflicting ? 'feature.txt' : 'local.txt',
      opts.conflicting ? 'base-side edit\n' : 'local\n',
      'local: unpushed base commit',
    )
    const after = git(fx.repoRoot, ['rev-parse', 'HEAD'])
    // The premise of the whole scenario: origin did NOT move, only local did.
    expect(after).not.toBe(before)
    expect(git(fx.repoRoot, ['rev-parse', 'origin/main'])).toBe(fx.baseHead)
    return after
  }

  it('★THE FIX: pin stale + local HEAD ahead → moved, and NO merge (pre-fix: unmoved → merge)', async () => {
    const fx = buildFixture()
    const localHead = advanceLocalBaseOnly(fx)

    const { outcome, stages, mergeRan, pushRan } = await runStage(fx)
    const result = (outcome as any).result

    // ★THE REGRESSION: pre-fix origin === pin → 'unmoved' → base_cas passed → merge ran.
    expect(outcome.kind).toBe('terminal')
    expect(result.success).toBe(false)
    expect(result.code).toBe('base_moved')
    expect(result.retryable).toBe(true)
    expect(result.convergenceStatus).toBe('blocked_review')
    expect(mergeRan).toBe(false)
    expect(pushRan).toBe(false)

    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.status).toBe('failed')
    expect(cas?.undeterminable).toBeUndefined()
    // The record must name WHICH base moved — origin never did.
    expect(cas?.localBaseHead).toBe(localHead)
    expect(cas?.movedAxis).toBe('local')
    expect(cas?.liveBaseHead).toBe(fx.baseHead)
  })

  it('★names the local axis — it must not claim origin "advanced" when origin never moved', async () => {
    const fx = buildFixture()
    const localHead = advanceLocalBaseOnly(fx)
    const { outcome } = await runStage(fx)
    const result = (outcome as any).result

    expect(result.localBaseHead).toBe(localHead)
    expect(String(result.error)).toMatch(/Local base main .* is ahead of the pinned/)
    expect(String(result.error)).toMatch(/still matches the pin/)
    // Reporting a peer push that never happened sends a coordinator hunting a ghost.
    expect(String(result.error)).not.toMatch(/advanced from/)
  })

  it('★this is the merge_failed that R3 actually hit — blocked BEFORE the conflict, not after', async () => {
    const fx = buildFixture()
    advanceLocalBaseOnly(fx, { conflicting: true })

    const { outcome, stages, mergeRan } = await runStage(fx)
    const result = (outcome as any).result

    // Pre-fix the CAS passed and `git merge` then failed on the unabsorbed local
    // commits. The gate now catches it one stage earlier, with a retryable
    // prescription instead of not_mergeable.
    expect(result.code).toBe('base_moved')
    expect(result.code).not.toBe('merge_failed')
    expect(result.convergenceStatus).not.toBe('not_mergeable')
    expect(mergeRan).toBe(false)
    expect(stages.find(s => s.stage === 'merge')).toBeUndefined()
  })
})

describe('base_cas: over-correction guards for the local-ahead check', () => {
  it('★the fully-aligned case (pin === local === origin) is byte-for-byte unchanged', async () => {
    const fx = buildFixture()
    // The steady state of every healthy refine. If the new check fires here, EVERY
    // refine blocks — so this is the guard that matters most.
    expect(git(fx.repoRoot, ['rev-parse', 'HEAD'])).toBe(fx.baseHead)
    expect(git(fx.repoRoot, ['rev-parse', 'origin/main'])).toBe(fx.baseHead)

    const { stages, mergeRan } = await runStage(fx, { requireApprovalForPush: true })
    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.status).toBe('passed')
    // No local-ahead metadata may appear on a passing record.
    expect(cas?.localBaseHead).toBeUndefined()
    expect(cas?.movedAxis).toBeUndefined()
    expect(cas?.liveBaseHead).toBe(fx.baseHead)
    expect(mergeRan).toBe(true)
  })

  it('★a local base BEHIND the pin still passes — merging into an older base loses nothing', async () => {
    const fx = buildFixture()
    // A peer pushed and this checkout has not fast-forwarded: pin/origin are the
    // NEW commit, local HEAD is the old one. Inequality alone would wrongly block
    // here, which is why the check is ancestry-gated in the local→pin direction.
    const peer = join(fx.root, 'peer')
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', fx.originPath, peer], { encoding: 'utf-8' })
    git(peer, ['config', 'user.email', 'test@example.com'])
    git(peer, ['config', 'user.name', 'Test User'])
    const advanced = commitFile(peer, 'peer.txt', 'peer\n', 'peer: advance base')
    git(peer, ['push', '-q', 'origin', 'main'])
    git(fx.repoRoot, ['fetch', '-q', 'origin', 'main'])

    // Pin at the NEW origin SHA; local HEAD deliberately left behind it.
    expect(git(fx.repoRoot, ['rev-parse', 'HEAD'])).toBe(fx.baseHead)
    const { stages, mergeRan } = await runStage(fx, {
      baseHeadOverride: advanced,
      requireApprovalForPush: true,
    })

    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.status).toBe('passed')
    expect(cas?.localBaseHead).toBeUndefined()
    expect(mergeRan).toBe(true)
  })

  it('★an unrelated local base (no shared history with the pin) does not read as ahead', async () => {
    const fx = buildFixture()
    // Ancestry, not mere inequality: an orphan local HEAD is not a descendant of
    // the pin, so the local-ahead branch must not claim it advanced past it.
    git(fx.repoRoot, ['checkout', '-q', '--orphan', 'main-orphan'])
    commitFile(fx.repoRoot, 'orphan.txt', 'orphan\n', 'orphan: unrelated root')
    const orphanHead = git(fx.repoRoot, ['rev-parse', 'HEAD'])

    const { stages } = await runStage(fx, { requireApprovalForPush: true })
    const cas = stages.find(s => s.stage === 'base_cas')
    // origin === pin and the orphan is not a descendant → the pre-existing
    // 'unmoved' verdict stands untouched.
    expect(cas?.status).toBe('passed')
    expect(cas?.localBaseHead).toBeUndefined()
    expect(orphanHead).not.toBe(fx.baseHead)

    // ★Scope note: the merge that follows then fails on "unrelated histories".
    // That is the PRE-EXISTING behaviour for an orphan base and is deliberately
    // left alone — this test asserts only that the CAS verdict is unchanged, not
    // that the merge succeeds. Pinning it here keeps a later reader from
    // mistaking the failure for fallout of this fix.
    const merge = stages.find(s => s.stage === 'merge')
    expect(merge?.status).toBe('failed')
  })

  it('★local ahead of the pin but ALREADY IN the branch still passes — the ordinary worktree shape', async () => {
    // A worktree cut from the local base inherits its commits, so "local ahead of
    // the pin" is the NORMAL state, not a fault. Order matters: commit on the base
    // FIRST, then branch, so the branch contains it — buildFixture() branches before
    // any local commit, so this case needs its own fixture.
    const root2 = makeTmp()
    const originPath = join(root2, 'origin.git')
    const seed = join(root2, 'seed')
    const repoRoot = join(root2, 'base')
    const workspace = join(root2, 'wt')

    initRepo(seed)
    commitFile(seed, 'README.md', 'seed\n', 'seed')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originPath], { encoding: 'utf-8' })
    git(seed, ['remote', 'add', 'origin', originPath])
    git(seed, ['push', '-q', 'origin', 'main'])
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', originPath, repoRoot], { encoding: 'utf-8' })
    git(repoRoot, ['config', 'user.email', 'test@example.com'])
    git(repoRoot, ['config', 'user.name', 'Test User'])
    const pin = git(repoRoot, ['rev-parse', 'origin/main'])
    // Unpushed local base commit, THEN the branch off it.
    const localHead = commitFile(repoRoot, 'local.txt', 'local\n', 'local: unpushed')
    git(repoRoot, ['worktree', 'add', '-q', '-b', 'feature/x', workspace, 'main'])
    git(workspace, ['config', 'user.email', 'test@example.com'])
    git(workspace, ['config', 'user.name', 'Test User'])
    const branchHead = commitFile(workspace, 'feature.txt', 'work\n', 'feat: work')
    expect(localHead).not.toBe(pin)

    const { stages, mergeRan } = await runStage(
      { root: root2, originPath, repoRoot, workspace, baseHead: pin, branchHead },
      { requireApprovalForPush: true },
    )
    const cas = stages.find(s => s.stage === 'base_cas')
    // The branch already contains the local base → nothing to conflict over.
    expect(cas?.status).toBe('passed')
    expect(cas?.localBaseHead).toBeUndefined()
    expect(mergeRan).toBe(true)
  })

  it('★an ALREADY-MERGED branch still passes — a push-failure retry must stay push_failed', async () => {
    const fx = buildFixture()
    // The auto-retry shape: attempt 1 merged locally and only the PUSH failed, so
    // attempt 2 finds the local base ahead of the pin — with the branch already
    // absorbed into it. Blocking here would mask a real push_failed as base_moved,
    // swapping a true blocker for a misleading one.
    git(fx.repoRoot, ['merge', '--no-ff', '-q', 'feature/x', '-m', 'Auto-merge branch feature/x via Refinery'])
    const localHead = git(fx.repoRoot, ['rev-parse', 'HEAD'])
    expect(localHead).not.toBe(fx.baseHead)
    // Branch ⊆ local base — the containment that makes a re-merge a no-op.
    expect(() => git(fx.repoRoot, ['merge-base', '--is-ancestor', fx.branchHead, localHead])).not.toThrow()

    const { stages } = await runStage(fx, { requireApprovalForPush: true })
    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.status).toBe('passed')
    expect(cas?.localBaseHead).toBeUndefined()
  })

  it('★a REMOTE advance is still reported as a remote advance, not relabelled local', async () => {
    const fx = buildFixture()
    const peer = join(fx.root, 'peer')
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', fx.originPath, peer], { encoding: 'utf-8' })
    git(peer, ['config', 'user.email', 'test@example.com'])
    git(peer, ['config', 'user.name', 'Test User'])
    commitFile(peer, 'peer.txt', 'peer\n', 'peer: advance base')
    git(peer, ['push', '-q', 'origin', 'main'])

    const { outcome, stages } = await runStage(fx)
    const result = (outcome as any).result
    expect(result.code).toBe('base_moved')
    // The remote branch returns BEFORE the local probe, so no local metadata.
    expect(result.localBaseHead).toBeUndefined()
    expect(String(result.error)).toMatch(/advanced from/)
    const cas = stages.find(s => s.stage === 'base_cas')
    expect(cas?.movedAxis).toBeUndefined()
  })
})
