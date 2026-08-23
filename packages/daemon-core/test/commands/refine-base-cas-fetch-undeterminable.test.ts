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
