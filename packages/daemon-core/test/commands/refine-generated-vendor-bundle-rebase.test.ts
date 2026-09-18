import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// Imported through the router barrel (like the sibling refine tests) so the
// re-export chain the daemon actually uses is covered too.
import {
  isRefineGeneratedVendorBundlePath,
  REFINE_GENERATED_VENDOR_BUNDLE_PATHS,
  rootRebaseResolvingGitlinks,
} from '../../src/commands/router'

/**
 * ★The sibling-branch vendor-bundle false-block (measured twice on 2026-09-18).
 *
 * Two branches both touch daemon-core, which `mcp-server` INLINES, so each
 * commits a re-bundled copy of the vendored output. The first to land advances
 * base's bundle; the second then rebases onto a base whose generated bundle
 * differs from its own and git reports a CONTENT CONFLICT inside the emitted
 * file. sync_base aborts, and because the shared failure path re-probes the
 * patch-equivalence gate for a richer hint, the refine surfaces as
 * `patch_equivalence_failed` / `patch_equivalence_classification` — with the
 * AUTHORED source diff byte-identical.
 *
 * These tests pin both directions:
 *   1. the authored source really is conflict-free (only the bundle conflicts),
 *   2. the driver completes the rebase and reports what it auto-resolved,
 *   3. ★a non-vendor content conflict still aborts (the fix is narrow),
 *   4. ★the resolution takes the BRANCH side, and the resulting bundle is
 *      deliberately STALE — which is what makes `check:vendor` (validation
 *      stage, registered in .adhdev/refine.json) the thing that verifies it.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

function writeFile(repo: string, rel: string, content: string) {
  const abs = join(repo, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

const cleanups: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refine-generated-bundle-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** The vendored mcp-server bundle, as addressed from the cloud monorepo root. */
const BUNDLE_JS = 'packages/daemon-cloud/vendor/mcp-server/index.js'
const BUNDLE_MAP = 'packages/daemon-cloud/vendor/mcp-server/index.js.map'

/**
 * Build the two-sibling scenario and leave `main` advanced to sibling A.
 * Returns the repo plus base/branch heads. Sibling B is on branch `sibB`.
 */
function buildSiblingScenario(opts: { alsoConflictSource?: boolean } = {}) {
  const repo = join(makeTmp(), 'root')
  initRepo(repo)

  // --- base -------------------------------------------------------------
  writeFile(repo, 'src/shared.ts', 'export const shared = 0\n')
  writeFile(repo, BUNDLE_JS, 'bundle v0\n')
  writeFile(repo, BUNDLE_MAP, '{"version":3,"mappings":"AAAA;v0"}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  const baseZero = git(repo, ['rev-parse', 'HEAD'])

  // --- sibling A: lands first, regenerating the bundle -------------------
  git(repo, ['checkout', '-q', '-b', 'sibA'])
  writeFile(repo, 'src/a.ts', 'export const a = 1\n')
  if (opts.alsoConflictSource) {
    // A genuine authored conflict on the SAME source line as sibling B.
    writeFile(repo, 'src/shared.ts', 'export const shared = 111\n')
  }
  writeFile(repo, BUNDLE_JS, 'bundle vA\n')
  writeFile(repo, BUNDLE_MAP, '{"version":3,"mappings":"AAAA;vA-DIFFERENT"}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'sibA'])

  // --- sibling B: branched off the SAME base, also regenerating ----------
  git(repo, ['checkout', '-q', baseZero])
  git(repo, ['checkout', '-q', '-b', 'sibB'])
  writeFile(repo, 'src/b.ts', 'export const b = 2\n')
  if (opts.alsoConflictSource) {
    writeFile(repo, 'src/shared.ts', 'export const shared = 222\n')
  }
  writeFile(repo, BUNDLE_JS, 'bundle vB\n')
  writeFile(repo, BUNDLE_MAP, '{"version":3,"mappings":"AAAA;vB-ALSO-DIFFERENT"}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'sibB'])

  // --- main advances to sibling A (it merged first) -----------------------
  git(repo, ['checkout', '-q', 'main'])
  git(repo, ['merge', '-q', '--ff-only', 'sibA'])
  const baseHead = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-q', 'sibB'])
  return { repo, baseHead }
}

describe('generated vendor bundle path policy', () => {
  it('matches the emitted bundle dirs and NOT the seqscribe submodule', () => {
    expect(isRefineGeneratedVendorBundlePath(BUNDLE_JS)).toBe(true)
    expect(isRefineGeneratedVendorBundlePath(BUNDLE_MAP)).toBe(true)
    expect(isRefineGeneratedVendorBundlePath('oss/packages/daemon-standalone/vendor/mcp-server/index.js')).toBe(true)
    // As addressed from inside the oss submodule checkout (its own root IS oss).
    expect(isRefineGeneratedVendorBundlePath('packages/daemon-standalone/vendor/mcp-server/index.js')).toBe(true)

    // ★`oss/vendor/seqscribe` is a git SUBMODULE, not build output. A blanket
    // `vendor/**` rule would have swallowed it; gitlinks must keep going through
    // the gitlink convergence machinery instead of being resolved to a side.
    expect(isRefineGeneratedVendorBundlePath('oss/vendor/seqscribe')).toBe(false)
    expect(isRefineGeneratedVendorBundlePath('vendor/seqscribe')).toBe(false)
    // Authored source is never a generated bundle.
    expect(isRefineGeneratedVendorBundlePath('oss/packages/daemon-core/src/mesh/mesh-refine-gates.ts')).toBe(false)
  })

  it('normalizes win32 separators (git emits "/" but callers may pass native paths)', () => {
    expect(isRefineGeneratedVendorBundlePath(BUNDLE_JS.replace(/\//g, '\\'))).toBe(true)
  })

  /**
   * ★Counts the scanned set rather than trusting the list looks right. Every
   * entry must be verified by a check-vendor-drift gate — an unverified entry
   * would be auto-resolved and never checked for staleness.
   */
  it('lists exactly the vendor dirs the drift gates verify', () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..', '..')
    const readVendorPaths = (script: string): string[] => {
      const src = readFileSync(join(repoRoot, script), 'utf-8')
      const block = /const VENDOR_PATHS = \[([\s\S]*?)\]/.exec(src)
      expect(block, `VENDOR_PATHS not found in ${script}`).toBeTruthy()
      return [...block![1].matchAll(/'([^']+)'/g)].map(m => m[1])
    }
    const rootVerified = readVendorPaths('scripts/check-vendor-drift.mjs')
    const ossVerified = readVendorPaths('oss/scripts/check-vendor-drift.mjs')

    // 3 root copies + 2 oss copies, each oss one in both spellings = 7 entries.
    expect(rootVerified.length).toBe(3)
    expect(ossVerified.length).toBe(2)
    expect(REFINE_GENERATED_VENDOR_BUNDLE_PATHS.length).toBe(rootVerified.length + ossVerified.length * 2)

    // Every verified path is covered, in the spelling(s) the Refinery can see.
    for (const p of rootVerified) expect(isRefineGeneratedVendorBundlePath(`${p}/index.js`)).toBe(true)
    for (const p of ossVerified) {
      expect(isRefineGeneratedVendorBundlePath(`${p}/index.js`)).toBe(true)
      expect(isRefineGeneratedVendorBundlePath(`oss/${p}/index.js`)).toBe(true)
    }
  })
})

describe('sync_base rebase over a regenerated vendor bundle', () => {
  it('★reproduces the false-block: only the generated bundle conflicts, the source does not', () => {
    const { repo, baseHead } = buildSiblingScenario()

    // Undriven `git rebase` — the pre-fix behaviour.
    let failed = false
    try {
      execFileSync('git', ['rebase', baseHead], { cwd: repo, stdio: 'pipe' })
    } catch {
      failed = true
    }
    expect(failed, 'plain rebase must abort on the bundle conflict (the reported defect)').toBe(true)

    const conflicts = git(repo, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n').map(s => s.trim()).filter(Boolean)
    expect(conflicts).toEqual([BUNDLE_JS, BUNDLE_MAP])

    // ★The authored source applied cleanly — the block is purely generated output.
    const nonVendor = conflicts.filter(p => !isRefineGeneratedVendorBundlePath(p))
    expect(nonVendor).toEqual([])

    try { execFileSync('git', ['rebase', '--abort'], { cwd: repo, stdio: 'ignore' }) } catch { /* ignore */ }
  })

  it('★resolves the bundle conflict, completes the rebase, and reports what it resolved', () => {
    const { repo, baseHead } = buildSiblingScenario()

    // Zero gitlink resolutions — exactly the reported case (no submodule divergence).
    const result = rootRebaseResolvingGitlinks(repo, baseHead, [])

    expect(result.ok, `rebase should complete; reason=${result.reason}`).toBe(true)
    expect(result.resolvedGeneratedBundlePaths).toEqual([BUNDLE_JS, BUNDLE_MAP])

    // No rebase left in progress, nothing unmerged.
    expect(git(repo, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
    expect(git(repo, ['status', '--porcelain'])).toBe('')

    // Base is now a strict ancestor: the branch is linear on top of it.
    expect(git(repo, ['merge-base', baseHead, 'HEAD'])).toBe(baseHead)

    // ★Both siblings' authored source survived the rebase.
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf-8')).toContain('a = 1')
    expect(readFileSync(join(repo, 'src/b.ts'), 'utf-8')).toContain('b = 2')

    // ★No conflict markers were committed into the bundle.
    const bundle = readFileSync(join(repo, BUNDLE_JS), 'utf-8')
    expect(bundle).not.toContain('<<<<<<<')
    expect(bundle).not.toContain('>>>>>>>')
  })

  it('★takes the BRANCH side, leaving a bundle that is stale-by-design for check:vendor to catch', () => {
    const { repo, baseHead } = buildSiblingScenario()
    const result = rootRebaseResolvingGitlinks(repo, baseHead, [])
    expect(result.ok).toBe(true)

    // The branch's own bundle won — NOT base's, and not a hand-merge of the two.
    expect(readFileSync(join(repo, BUNDLE_JS), 'utf-8')).toBe('bundle vB\n')

    // ★This is deliberately STALE: the tree now holds BOTH siblings' source, so a
    // bundle rebuilt from it would be neither 'vA' nor 'vB'. That staleness is real
    // and is exactly what `check:vendor` rebuilds-and-diffs to catch in the
    // validation stage, which runs after sync_base and before patch_equivalence.
    // The safety claim is NOT "the bundle is right"; it is "a wrong bundle cannot
    // reach main, because a separate registered gate rebuilds it".
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf-8')).toContain('a = 1')
    expect(readFileSync(join(repo, 'src/b.ts'), 'utf-8')).toContain('b = 2')
  })

  it('★still aborts on a genuine authored conflict (the fix is narrow, not a blanket -X theirs)', () => {
    const { repo, baseHead } = buildSiblingScenario({ alsoConflictSource: true })

    const result = rootRebaseResolvingGitlinks(repo, baseHead, [])

    expect(result.ok, 'a real source conflict must NOT be auto-resolved').toBe(false)
    expect(result.reason).toBe('non_gitlink_conflict')
    expect(result.conflictPaths).toContain('src/shared.ts')

    // Fail-safe: the rebase was aborted, leaving the worktree clean for review.
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'sibB']))
  })
})
