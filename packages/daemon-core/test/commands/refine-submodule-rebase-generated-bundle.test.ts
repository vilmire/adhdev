import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// Imported through the router barrel (like the sibling refine tests) so the
// re-export chain the daemon actually uses is covered too.
import {
  convergeDivergedSubmoduleGitlinks,
  driveSubmoduleRebaseResolvingGeneratedBundles,
  isRefineGeneratedVendorBundlePath,
  isRegularFileConflictIn,
  rootRebaseResolvingGitlinks,
} from '../../src/commands/router'

/**
 * ★Gap A — the SUBMODULE-INTERNAL twin of the vendor-bundle false-block that
 * `refine-generated-vendor-bundle-rebase.test.ts` pins at the ROOT level.
 *
 * The oss submodule emits its own vendored bundles
 * (`packages/daemon-standalone/vendor/mcp-server`), and anything touching
 * `daemon-core` — which `mcp-server` INLINES — regenerates them. So two sibling
 * branches conflict INSIDE the submodule too, one level below where STEP 2
 * resolves it. Before this fix STEP 1's undriven `git rebase` aborted there;
 * because a STEP 1 failure makes `router-refine.ts` sync_base return BEFORE
 * STEP 2 runs, the already-working root-side gitlink remapping never got a
 * chance and the branch had to be landed by hand (measured twice 2026-09-18).
 *
 * ## What these tests assert, and why that choice matters
 *
 * They assert the OUTCOME — `converged: true` and the final gitlink SHA the root
 * commit actually records — not that a helper was called. This repo has a
 * repeated history of green suites over broken builds because a proxy signal was
 * asserted instead of the effect, so the end-to-end assertions here deliberately
 * re-read the resulting tree with plain `git`.
 *
 * Coverage:
 *   1. two-level injection: disabled (plain rebase) fails, driven succeeds;
 *   2. ★the safety guarantee — a real authored conflict inside the submodule
 *      still aborts, so this is not a blanket `-X theirs`;
 *   3. ★a nested GITLINK conflict is never resolved by taking a side;
 *   4. end-to-end STEP 1 + STEP 2: the root gitlink lands on the rebased
 *      submodule commit.
 */

/**
 * ★Committer identity must be supplied explicitly, and in BOTH of the two ways
 * below, because the fixture commits from three different kinds of process.
 *
 * On a developer Mac `git` silently invents an identity from the OS user record
 * (gecos full name + hostname), so a repo with no `user.name`/`user.email` still
 * commits fine. A CI runner's account has an empty gecos field, so the very same
 * commit dies with `fatal: empty ident name`. That asymmetry is exactly why this
 * file passed locally and failed on every oss CI run (measured 2026-09-18).
 *
 *   1. `GIT_{AUTHOR,COMMITTER}_*` in the helper env — covers repos this fixture
 *      never ran `initRepo` on: the `git clone`d worktree and the checkouts that
 *      `git submodule add`/`submodule update` materialize. Setting only repo-local
 *      config would miss all of those.
 *   2. repo-local `git config` in `initRepo`/`configureIdentity` — covers the git
 *      processes the PRODUCTION code spawns (the rebase under test commits inside
 *      `work` and `work/oss`). Those inherit `process.env`, not this helper's env,
 *      so the env vars above never reach them.
 *
 * `--global` is deliberately untouched: other suites and other workers share this
 * machine.
 */
const IDENT_NAME = 'Test User'
const IDENT_EMAIL = 'test@example.com'

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_EDITOR: 'true',
  GIT_AUTHOR_NAME: IDENT_NAME,
  GIT_AUTHOR_EMAIL: IDENT_EMAIL,
  GIT_COMMITTER_NAME: IDENT_NAME,
  GIT_COMMITTER_EMAIL: IDENT_EMAIL,
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV },
  }).trim()
}

/** Pin identity into a repo that already exists (a clone, or a submodule checkout). */
function configureIdentity(repo: string) {
  git(repo, ['config', 'user.email', IDENT_EMAIL])
  git(repo, ['config', 'user.name', IDENT_NAME])
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  configureIdentity(repo)
}

function writeFile(repo: string, rel: string, content: string) {
  const abs = join(repo, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

const cleanups: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refine-sub-bundle-'))
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
 * The vendored bundle as addressed from INSIDE the oss submodule checkout (its own
 * root IS oss, so the `oss/` prefix never appears in its conflict paths).
 */
const SUB_BUNDLE_JS = 'packages/daemon-standalone/vendor/mcp-server/index.js'
const SUB_BUNDLE_MAP = 'packages/daemon-standalone/vendor/mcp-server/index.js.map'

/**
 * Build a standalone submodule-shaped repo with two sibling commits off a shared
 * base, each regenerating the vendored bundle. Returns the base-side commit
 * (already on `main`) and the branch-side commit, with HEAD detached at branch.
 */
function buildSubmoduleSiblingScenario(opts: {
  alsoConflictSource?: boolean
  nestedGitlinkConflict?: boolean
} = {}) {
  const root = makeTmp()
  const repo = join(root, 'sub')
  initRepo(repo)

  // A nested submodule (the `oss/vendor/seqscribe` shape) that both siblings move.
  let nestedA = ''
  let nestedB = ''
  if (opts.nestedGitlinkConflict) {
    const nested = join(root, 'nested')
    initRepo(nested)
    writeFile(nested, 'n.txt', 'n0\n')
    git(nested, ['add', '-A'])
    git(nested, ['commit', '-q', '-m', 'n0'])
    const nestedZero = git(nested, ['rev-parse', 'HEAD'])
    // ★The two nested commits must DIVERGE (siblings off n0), not stack. Measured
    // while writing this test: when nestedB descends from nestedA, git resolves the
    // gitlink as a trivial fast-forward and never conflicts at all — so a stacked
    // fixture asserts nothing about how a gitlink conflict is handled.
    writeFile(nested, 'n.txt', 'nA\n')
    git(nested, ['add', '-A'])
    git(nested, ['commit', '-q', '-m', 'nA'])
    nestedA = git(nested, ['rev-parse', 'HEAD'])
    git(nested, ['checkout', '-q', '--detach', nestedZero])
    writeFile(nested, 'n.txt', 'nB\n')
    git(nested, ['add', '-A'])
    git(nested, ['commit', '-q', '-m', 'nB'])
    nestedB = git(nested, ['rev-parse', 'HEAD'])
    git(nested, ['checkout', '-q', '--detach', nestedA])
  }

  // --- shared base -------------------------------------------------------
  writeFile(repo, 'src/shared.ts', 'export const shared = 0\n')
  writeFile(repo, SUB_BUNDLE_JS, 'sub bundle v0\n')
  writeFile(repo, SUB_BUNDLE_MAP, '{"version":3,"mappings":"AAAA;v0"}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  if (opts.nestedGitlinkConflict) {
    git(repo, ['submodule', 'add', '-q', join(root, 'nested'), 'vendor/seqscribe'])
    configureIdentity(join(repo, 'vendor/seqscribe'))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'add nested'])
  }
  const baseZero = git(repo, ['rev-parse', 'HEAD'])

  // --- sibling A (lands first → becomes the base side) -------------------
  writeFile(repo, 'src/a.ts', 'export const a = 1\n')
  if (opts.alsoConflictSource) writeFile(repo, 'src/shared.ts', 'export const shared = 111\n')
  writeFile(repo, SUB_BUNDLE_JS, 'sub bundle vA\n')
  writeFile(repo, SUB_BUNDLE_MAP, '{"version":3,"mappings":"AAAA;vA-DIFFERENT"}\n')
  if (opts.nestedGitlinkConflict) {
    git(join(repo, 'vendor/seqscribe'), ['checkout', '-q', '--detach', nestedA])
    git(repo, ['add', 'vendor/seqscribe'])
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'sibA'])
  const baseCommit = git(repo, ['rev-parse', 'HEAD'])

  // --- sibling B (off the SAME base, also regenerating) ------------------
  git(repo, ['checkout', '-q', '--detach', baseZero])
  writeFile(repo, 'src/b.ts', 'export const b = 2\n')
  if (opts.alsoConflictSource) writeFile(repo, 'src/shared.ts', 'export const shared = 222\n')
  writeFile(repo, SUB_BUNDLE_JS, 'sub bundle vB\n')
  writeFile(repo, SUB_BUNDLE_MAP, '{"version":3,"mappings":"AAAA;vB-ALSO-DIFFERENT"}\n')
  if (opts.nestedGitlinkConflict) {
    git(join(repo, 'vendor/seqscribe'), ['checkout', '-q', '--detach', nestedB])
    git(repo, ['add', 'vendor/seqscribe'])
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'sibB'])
  const branchCommit = git(repo, ['rev-parse', 'HEAD'])

  return { repo, baseCommit, branchCommit }
}

describe('Gap A — submodule-internal rebase over a regenerated vendor bundle', () => {
  it('★injection (disabled): an UNDRIVEN rebase aborts on the bundle alone — the reported block', () => {
    const { repo, baseCommit } = buildSubmoduleSiblingScenario()

    // This is literally the pre-fix line: a single blind `git rebase baseCommit`.
    let failed = false
    try {
      execFileSync('git', ['rebase', baseCommit], { cwd: repo, stdio: 'pipe' })
    } catch {
      failed = true
    }
    expect(failed, 'undriven submodule rebase must abort (the gap being fixed)').toBe(true)

    const conflicts = git(repo, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n').map(s => s.trim()).filter(Boolean)
    expect(conflicts).toEqual([SUB_BUNDLE_JS, SUB_BUNDLE_MAP])

    try { execFileSync('git', ['rebase', '--abort'], { cwd: repo, stdio: 'ignore' }) } catch { /* ignore */ }
  })

  it('★injection (enabled): the driven rebase completes and reports what it resolved', () => {
    const { repo, baseCommit, branchCommit } = buildSubmoduleSiblingScenario()

    const driven = driveSubmoduleRebaseResolvingGeneratedBundles(repo, baseCommit)

    expect(driven.ok, `driven rebase should complete; reason=${driven.reason}`).toBe(true)
    expect(driven.resolvedGeneratedBundlePaths).toEqual([SUB_BUNDLE_JS, SUB_BUNDLE_MAP])

    // ★Outcome, not call-site: base is now a strict ancestor and the branch work survived.
    const head = git(repo, ['rev-parse', 'HEAD'])
    expect(head).not.toBe(branchCommit)
    expect(git(repo, ['merge-base', baseCommit, head])).toBe(baseCommit)
    expect(git(repo, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
    expect(git(repo, ['status', '--porcelain'])).toBe('')

    // Both siblings' authored source is present, and no markers were committed.
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf-8')).toContain('a = 1')
    expect(readFileSync(join(repo, 'src/b.ts'), 'utf-8')).toContain('b = 2')
    const bundle = readFileSync(join(repo, SUB_BUNDLE_JS), 'utf-8')
    expect(bundle).not.toContain('<<<<<<<')
    // ★Branch side won (stale by design → `check:vendor` is what proves it current).
    expect(bundle).toBe('sub bundle vB\n')
  })

  it('★SAFETY: a genuine authored conflict inside the submodule still fails (not a blanket -X theirs)', () => {
    const { repo, baseCommit } = buildSubmoduleSiblingScenario({ alsoConflictSource: true })

    const driven = driveSubmoduleRebaseResolvingGeneratedBundles(repo, baseCommit)

    expect(driven.ok, 'a real source conflict must NOT be auto-resolved').toBe(false)
    expect(driven.reason).toBe('non_generated_bundle_conflict')
    // The authored file was NOT resolved to a side.
    expect(driven.resolvedGeneratedBundlePaths).not.toContain('src/shared.ts')
  })

  /**
   * ★The gitlink guard, tested where it is actually decidable.
   *
   * Measured while writing this test: a nested-submodule gitlink does NOT produce an
   * unmerged entry in this scenario at all — git resolves it silently (taking the
   * branch side) whether the two nested commits fast-forward OR diverge. So a
   * "nested gitlink conflict" cannot be staged here to prove the guard, and asserting
   * `ok === false` was asserting the fixture, not the code.
   *
   * What IS load-bearing and IS decidable: a gitlink must never satisfy the
   * generated-bundle predicate in the first place. Both guards are checked:
   *   (1) the explicit path list excludes `vendor/seqscribe`, and
   *   (2) the resolver additionally requires a REGULAR FILE (mode != 160000), so even
   *       a future vendor path that overlapped a submodule could not be taken-a-side.
   * (2) is verified against a real mode-160000 index entry below.
   */
  it('★SAFETY: a gitlink can never satisfy the generated-bundle resolution predicate', () => {
    const { repo } = buildSubmoduleSiblingScenario({ nestedGitlinkConflict: true })

    // (1) path-list guard — the nested submodule is not a generated bundle.
    expect(isRefineGeneratedVendorBundlePath('vendor/seqscribe')).toBe(false)

    // (2) mode guard — `vendor/seqscribe` really is mode 160000 in the index, and the
    // regular-file probe the resolver gates on therefore rejects it, while the real
    // generated bundle (a regular file) passes.
    const staged = git(repo, ['ls-files', '--stage', '--', 'vendor/seqscribe'])
    expect(staged).toMatch(/^160000\s/)
    expect(isRegularFileConflictIn(repo, 'vendor/seqscribe')).toBe(false)
    expect(isRegularFileConflictIn(repo, SUB_BUNDLE_JS)).toBe(true)
  })
})

/**
 * ★End-to-end: STEP 1 (submodule rebase, Gap A) + STEP 2 (root gitlink remap).
 *
 * This is the shape the coordinator hit: the submodule conflicts on its vendored
 * bundle, and the root then needs its gitlink pointed at the REBASED submodule
 * commit ("Failed to merge submodule oss / commits don't follow merge-base").
 * Asserting the final gitlink SHA is the point — a green STEP 1 with a root that
 * still records the old pointer would be exactly the proxy-signal failure this
 * repo keeps hitting.
 */
describe('Gap A + Gap B end-to-end — submodule rebase then root gitlink remap', () => {
  function buildRootWithSubmodule() {
    const root = makeTmp()

    // --- the submodule's own origin ---------------------------------------
    const subOrigin = join(root, 'sub-origin')
    initRepo(subOrigin)
    writeFile(subOrigin, 'src/shared.ts', 'export const shared = 0\n')
    writeFile(subOrigin, SUB_BUNDLE_JS, 'sub bundle v0\n')
    git(subOrigin, ['add', '-A'])
    git(subOrigin, ['commit', '-q', '-m', 's0'])

    // --- base repo ---------------------------------------------------------
    const baseRepo = join(root, 'base')
    initRepo(baseRepo)
    writeFile(baseRepo, 'r.txt', 'r0\n')
    git(baseRepo, ['add', '-A'])
    git(baseRepo, ['commit', '-q', '-m', 'r0'])
    git(baseRepo, ['submodule', 'add', '-q', subOrigin, 'oss'])
    configureIdentity(join(baseRepo, 'oss'))
    git(baseRepo, ['add', '-A'])
    git(baseRepo, ['commit', '-q', '-m', 'add oss'])
    const rootBaseZero = git(baseRepo, ['rev-parse', 'HEAD'])
    const subZero = git(join(baseRepo, 'oss'), ['rev-parse', 'HEAD'])

    // --- the worktree (branch side), cloned from base ----------------------
    const work = join(root, 'work')
    git(root, ['clone', '-q', baseRepo, work])
    configureIdentity(work)
    git(work, ['submodule', 'update', '-q', '--init'])
    // ★`work/oss` is where the production rebase under test mints its commits, and
    // that git runs in a child process inheriting `process.env` — not GIT_ENV.
    configureIdentity(join(work, 'oss'))

    // sibling A lands in BASE: advances oss (regenerating the bundle) + root gitlink.
    const baseSub = join(baseRepo, 'oss')
    git(baseSub, ['checkout', '-q', '--detach', subZero])
    writeFile(baseSub, 'src/a.ts', 'export const a = 1\n')
    writeFile(baseSub, SUB_BUNDLE_JS, 'sub bundle vA\n')
    git(baseSub, ['add', '-A'])
    git(baseSub, ['commit', '-q', '-m', 'sub sibA'])
    const subBase = git(baseSub, ['rev-parse', 'HEAD'])
    git(baseRepo, ['add', 'oss'])
    writeFile(baseRepo, 'a.txt', 'a\n')
    git(baseRepo, ['add', '-A'])
    git(baseRepo, ['commit', '-q', '-m', 'root sibA'])
    const baseHead = git(baseRepo, ['rev-parse', 'HEAD'])

    // sibling B in the WORKTREE, off the same rootBaseZero/subZero.
    git(work, ['checkout', '-q', '-b', 'sibB', rootBaseZero])
    git(work, ['submodule', 'update', '-q', '--init', '--force'])
    const workSub = join(work, 'oss')
    git(workSub, ['checkout', '-q', '--detach', subZero])
    writeFile(workSub, 'src/b.ts', 'export const b = 2\n')
    writeFile(workSub, SUB_BUNDLE_JS, 'sub bundle vB\n')
    git(workSub, ['add', '-A'])
    git(workSub, ['commit', '-q', '-m', 'sub sibB'])
    const subBranch = git(workSub, ['rev-parse', 'HEAD'])
    git(work, ['add', 'oss'])
    writeFile(work, 'b.txt', 'b\n')
    git(work, ['add', '-A'])
    git(work, ['commit', '-q', '-m', 'root sibB'])
    const branchHead = git(work, ['rev-parse', 'HEAD'])

    // The Refinery fetches the base head into the worktree before sync_base; without
    // it `git diff baseHead branchHead` (run IN the worktree) cannot see baseHead at
    // all and the gitlink scan reports `no_changed_gitlinks`.
    // `--no-recurse-submodules`: only the ROOT ref is needed here, and recursing
    // would chase submodule commits that live in the base checkout, not its origin.
    git(work, ['fetch', '-q', '--no-recurse-submodules', 'origin'])

    return { work, baseRepo, baseHead, branchHead, subBase, subBranch }
  }

  it('★converges the gitlink and the ROOT COMMIT records the rebased submodule SHA', () => {
    const { work, baseRepo, baseHead, branchHead, subBase, subBranch } = buildRootWithSubmodule()

    // Sanity: the gitlink really is a sibling divergence (neither an ancestor).
    expect(subBase).not.toBe(subBranch)

    // STEP 1 — auto-publish ON, because the rebase legitimately mints a submodule
    // commit here (the pre-mint gate is not what this test is about).
    const converge = convergeDivergedSubmoduleGitlinks(work, baseRepo, baseHead, branchHead, {
      allowAutoPublishSubmoduleMainCommits: true,
    })

    // ★Gap A: WITHOUT the driven submodule rebase this is `rebase_conflict` and
    // STEP 2 never runs, because sync_base returns early on a STEP 1 failure.
    expect(converge.converged, `STEP 1 should converge; reason=${converge.reason}`).toBe(true)
    const resolution = converge.resolutions.find(r => r.path === 'oss')
    expect(resolution, 'the oss gitlink must have a resolution').toBeTruthy()
    const rebasedSub = resolution!.rebasedCommit

    // The rebased submodule tip descends from the base side and kept branch work.
    const workSub = join(work, 'oss')
    expect(git(workSub, ['merge-base', subBase, rebasedSub])).toBe(subBase)
    expect(rebasedSub).not.toBe(subBranch)
    // Observability: the submodule-internal bundle resolution is named, not silent.
    const rec = converge.gitlinks.find(g => g.path === 'oss')
    expect(rec?.action).toBe('rebased')
    expect(rec?.resolvedGeneratedBundlePaths).toContain(SUB_BUNDLE_JS)

    // STEP 2 — the root rebase, which must remap the gitlink to the REBASED SHA.
    const driven = rootRebaseResolvingGitlinks(work, baseHead, converge.resolutions)
    expect(driven.ok, `root rebase should complete; reason=${driven.reason}`).toBe(true)

    // ★THE assertion: the landed root commit records the rebased submodule commit.
    const landedGitlink = git(work, ['rev-parse', 'HEAD:oss'])
    expect(landedGitlink).toBe(rebasedSub)

    // And the root history is linear on top of base.
    expect(git(work, ['merge-base', baseHead, 'HEAD'])).toBe(baseHead)
    expect(git(work, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
    // Both roots' authored files survived.
    expect(readFileSync(join(work, 'a.txt'), 'utf-8')).toBe('a\n')
    expect(readFileSync(join(work, 'b.txt'), 'utf-8')).toBe('b\n')
  })
})
