import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { decideOssCloneSync } from '../../src/commands/med-family/mesh-crud.js'
import { runGit } from '../../src/git/git-executor.js'
import type { GitRepoIdentity } from '../../src/git/git-types.js'

const execFileAsync = promisify(execFile)

/**
 * Rewind guard for clone_mesh_node's `oss` submodule sync (mesh-crud.ts).
 *
 * The worktree's `oss` HEAD is checked out from the FRESH (origin/main-derived)
 * root base. The clone source node's working `oss` SHA can lag that tip. The old
 * sync force-checked-out the source SHA whenever it merely differed, rewinding
 * the submodule back onto the stale source. decideOssCloneSync applies the
 * origin-tip-priority policy: only advance to a strictly-newer source, never
 * rewind to a behind/diverged source.
 */
describe('decideOssCloneSync — oss submodule clone rewind guard', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    while (cleanups.length) {
      const dir = cleanups.pop()!
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // Build a single oss-like repo with a linear history c1 -> c2 -> c3 plus a
  // sibling commit forked off c1 (diverged from c2/c3). Returns the SHAs.
  async function buildOssRepo() {
    const dir = await mkdtemp(join(tmpdir(), 'oss-clone-sync-guard-'))
    cleanups.push(dir)
    const repoRoot = join(dir, 'oss')
    await execFileAsync('git', ['init', repoRoot])
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })

    const commit = async (file: string, msg: string): Promise<string> => {
      await writeFile(join(repoRoot, file), `${msg}\n`)
      await execFileAsync('git', ['add', file], { cwd: repoRoot })
      await execFileAsync('git', ['commit', '-m', msg], { cwd: repoRoot })
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
      return stdout.trim()
    }

    const c1 = await commit('a', 'c1')
    const c2 = await commit('b', 'c2')
    const c3 = await commit('c', 'c3')

    // Fork a sibling commit off c1 → diverged from c2/c3.
    await execFileAsync('git', ['checkout', '-b', 'side', c1], { cwd: repoRoot })
    const side = await commit('s', 'side')
    await execFileAsync('git', ['checkout', '-'], { cwd: repoRoot }).catch(() => {})

    const ctx: GitRepoIdentity = { workspace: repoRoot, repoRoot, isGitRepo: true }
    return { ctx, c1, c2, c3, side }
  }

  it('skips a rewind when the source oss SHA is an ancestor of the fresh worktree oss (the core bug)', async () => {
    const { ctx, c1, c3 } = await buildOssRepo()
    // worktree = fresh tip c3, source = stale ancestor c1 → must NOT rewind.
    const action = await decideOssCloneSync(ctx, c3, c1, runGit)
    expect(action).toBe('skip_rewind')
  })

  it('advances when the source oss SHA is strictly newer than the worktree oss', async () => {
    const { ctx, c1, c3 } = await buildOssRepo()
    // worktree = c1, source = newer c3 → safe fast-forward.
    const action = await decideOssCloneSync(ctx, c1, c3, runGit)
    expect(action).toBe('advance')
  })

  it('is a noop when source and worktree oss SHAs already match', async () => {
    const { ctx, c2 } = await buildOssRepo()
    const action = await decideOssCloneSync(ctx, c2, c2, runGit)
    expect(action).toBe('noop')
  })

  it('skips (no rewind) when source and worktree oss have diverged', async () => {
    const { ctx, c3, side } = await buildOssRepo()
    // c3 and side share base c1 but neither is an ancestor of the other.
    const action = await decideOssCloneSync(ctx, c3, side, runGit)
    expect(action).toBe('skip_diverged')
  })

  it('rethrows a real git failure (unresolvable SHA) so the caller keeps the fresh HEAD', async () => {
    const { ctx, c3 } = await buildOssRepo()
    const bogus = '0'.repeat(40)
    // Differs from c3 and is unresolvable → merge-base exits 128, not 1.
    await expect(decideOssCloneSync(ctx, c3, bogus, runGit)).rejects.toBeTruthy()
  })
})
