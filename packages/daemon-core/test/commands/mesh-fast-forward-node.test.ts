import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { fastForwardMeshNode } from '../../src/mesh/mesh-fast-forward'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function configureUser(repo: string) {
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

function commitFile(repo: string, path: string, content: string, message: string) {
  writeFileSync(join(repo, path), content, 'utf-8')
  git(repo, ['add', path])
  git(repo, ['commit', '-q', '-m', message])
}

function createRemoteBackedRepo(root: string) {
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')
  mkdirSync(seed, { recursive: true })
  git(root, ['init', '--bare', '-q', origin])
  git(seed, ['init', '-q', '-b', 'main'])
  configureUser(seed)
  commitFile(seed, 'README.md', 'base\n', 'init')
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '-q', '-u', 'origin', 'main'])
  git(root, ['clone', '-q', origin, work])
  configureUser(work)
  return { origin, seed, work }
}

function pushRemoteCommit(seed: string, content = 'base\nremote\n') {
  commitFile(seed, 'README.md', content, 'remote update')
  git(seed, ['push', '-q', 'origin', 'main'])
}

describe('fast_forward_mesh_node', () => {
  it('dry-runs an obvious behind-only fast-forward without executing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-dry-run-'))
    try {
      const { seed, work } = createRemoteBackedRepo(root)
      pushRemoteCommit(seed)
      const before = git(work, ['rev-parse', 'HEAD'])

      const result: any = await fastForwardMeshNode({
        workspace: work,
        nodeId: 'node-ff',
      })

      expect(result).toMatchObject({ success: true, allowed: true, willRun: false, executed: false, dryRun: true })
      expect(result.current).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 1 })
      expect(result.plannedSteps.map((step: any) => step.operation)).toEqual(expect.arrayContaining(['refresh_upstream', 'merge_ff_only']))
      expect(git(work, ['rev-parse', 'HEAD'])).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('returns a no-op success when the branch is already even with upstream', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-noop-'))
    try {
      const { work } = createRemoteBackedRepo(root)

      const result: any = await fastForwardMeshNode({
        workspace: work,
        execute: true,
        nodeId: 'node-even',
      })

      expect(result).toMatchObject({ success: true, allowed: true, willRun: false, executed: false, code: 'already_up_to_date' })
      expect(result.finalBranchConvergenceState).toMatchObject({ status: 'up_to_date', branch: 'main', ahead: 0, behind: 0 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('blocks dirty worktrees without fetching or merging', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-dirty-'))
    try {
      const { seed, work } = createRemoteBackedRepo(root)
      pushRemoteCommit(seed)
      writeFileSync(join(work, 'LOCAL.txt'), 'local\n', 'utf-8')

      const result: any = await fastForwardMeshNode({
        workspace: work,
        execute: true,
        nodeId: 'node-dirty',
      })

      expect(result).toMatchObject({ success: false, allowed: false, willRun: false, executed: false, code: 'dirty_worktree' })
      expect(result.blockingReasons).toContain('working_tree_not_clean')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('reclassifies pure-ahead merge as ahead_needs_push (push mode hint)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-ahead-'))
    try {
      const { work } = createRemoteBackedRepo(root)
      commitFile(work, 'LOCAL.md', 'local\n', 'local commit')

      const result: any = await fastForwardMeshNode({
        workspace: work,
        execute: true,
        nodeId: 'node-ahead',
      })

      // ahead>0, behind=0 in merge mode is a push-needed case, not a hard block.
      expect(result).toMatchObject({ success: false, allowed: false, willRun: false, executed: false, code: 'ahead_needs_push' })
      expect(result.nextStep).toMatch(/mode="push"/)
      expect(result.current).toMatchObject({ ahead: 1, behind: 0 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('push mode dry-runs an ff-only push of pure-ahead commits without pushing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-push-dry-'))
    try {
      const { origin, work } = createRemoteBackedRepo(root)
      commitFile(work, 'LOCAL.md', 'local\n', 'local commit')
      const localHead = git(work, ['rev-parse', 'HEAD'])
      const remoteHeadBefore = git(origin, ['rev-parse', 'main'])

      const result: any = await fastForwardMeshNode({
        workspace: work,
        mode: 'push',
        nodeId: 'node-push',
      })

      expect(result).toMatchObject({ success: true, allowed: true, willRun: false, executed: false, dryRun: true, code: 'push_available', mode: 'push' })
      expect(result.pushTarget).toMatchObject({ remote: 'origin', remoteBranch: 'main', refspec: 'HEAD:refs/heads/main' })
      expect(result.plannedSteps.map((step: any) => step.operation)).toEqual(expect.arrayContaining(['verify_push_descendant', 'push_ff_only']))
      // Nothing was pushed.
      expect(git(origin, ['rev-parse', 'main'])).toBe(remoteHeadBefore)
      expect(git(work, ['rev-parse', 'HEAD'])).toBe(localHead)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('push mode executes a strict ff-only push to origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-push-exec-'))
    try {
      const { origin, work } = createRemoteBackedRepo(root)
      commitFile(work, 'LOCAL.md', 'local\n', 'local commit')
      const localHead = git(work, ['rev-parse', 'HEAD'])

      const result: any = await fastForwardMeshNode({
        workspace: work,
        mode: 'push',
        execute: true,
        nodeId: 'node-push',
      })

      expect(result).toMatchObject({ success: true, allowed: true, willRun: true, executed: true, code: 'push_applied', mode: 'push' })
      expect(git(origin, ['rev-parse', 'main'])).toBe(localHead)
      expect(result.postStatus).toMatchObject({ ahead: 0, behind: 0 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('push mode refuses a non-fast-forward push when origin has diverged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-push-nonff-'))
    try {
      const { seed, origin, work } = createRemoteBackedRepo(root)
      // origin advances with a commit the local work does not have.
      pushRemoteCommit(seed)
      const remoteHeadBefore = git(origin, ['rev-parse', 'main'])
      // local also commits, so it is both ahead and behind (diverged).
      commitFile(work, 'LOCAL.md', 'local\n', 'local commit')

      const result: any = await fastForwardMeshNode({
        workspace: work,
        mode: 'push',
        execute: true,
        nodeId: 'node-push',
      })

      expect(result).toMatchObject({ success: false, allowed: false, executed: false, mode: 'push' })
      expect(['branch_diverged', 'non_fast_forward_push']).toContain(result.code)
      // Origin untouched — no force push.
      expect(git(origin, ['rev-parse', 'main'])).toBe(remoteHeadBefore)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('push mode reports nothing_to_push when fully in sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-push-noop-'))
    try {
      const { work } = createRemoteBackedRepo(root)

      const result: any = await fastForwardMeshNode({
        workspace: work,
        mode: 'push',
        execute: true,
        nodeId: 'node-push',
      })

      expect(result).toMatchObject({ success: true, executed: false, code: 'nothing_to_push', mode: 'push' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('blocks diverged/non-fast-forward branches after refreshed upstream truth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-diverged-'))
    try {
      const { seed, work } = createRemoteBackedRepo(root)
      pushRemoteCommit(seed)
      commitFile(work, 'LOCAL.md', 'local\n', 'local commit')

      const result: any = await fastForwardMeshNode({
        workspace: work,
        execute: true,
        nodeId: 'node-diverged',
      })

      expect(result).toMatchObject({ success: false, allowed: false, willRun: false, executed: false, code: 'branch_diverged' })
      expect(result.current).toMatchObject({ ahead: 1, behind: 1 })
      expect(result.blockingReasons).toContain('branch_has_local_commits')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('executes a safe fast-forward and verifies final convergence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-execute-'))
    try {
      const { seed, work } = createRemoteBackedRepo(root)
      pushRemoteCommit(seed, 'base\nremote\nexecute\n')
      const remoteHead = git(seed, ['rev-parse', 'HEAD'])

      const result: any = await fastForwardMeshNode({
        workspace: work,
        execute: true,
        updateSubmodules: false,
        nodeId: 'node-execute',
        meshId: 'mesh-test',
      })

      expect(result).toMatchObject({ success: true, allowed: true, willRun: true, executed: true, code: 'fast_forward_applied' })
      expect(result.preStatus).toMatchObject({ ahead: 0, behind: 1 })
      expect(result.postStatus).toMatchObject({ ahead: 0, behind: 0, branch: 'main' })
      expect(result.finalBranchConvergenceState).toMatchObject({ status: 'fast_forwarded', branch: 'main', ahead: 0, behind: 0 })
      expect(git(work, ['rev-parse', 'HEAD'])).toBe(remoteHead)
      expect(readFileSync(join(work, 'README.md'), 'utf-8')).toBe('base\nremote\nexecute\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  // Regression for mission b6556fc4 (auto-ff submodule gitlink drift self-block): a
  // ff-only merge that lands a commit which bumps a submodule's gitlink must leave the
  // submodule checkout IN SYNC with the new gitlink when updateSubmodules:true is passed
  // (mirrors the manual mesh_fast_forward_node update_submodules:true behavior) — this is
  // the auto-ff caller's new default (see mesh-auto-fast-forward.ts). Before that caller
  // fix, auto-ff always passed updateSubmodules:false, so this second commit was
  // fetched/merged into the root but the submodule was left checked out at the OLD sha —
  // gitlink drift that self-blocks the next auto-ff attempt via collectPreflightBlockers.
  describe('submodule gitlink drift (mission b6556fc4)', () => {
    function initSubmoduleChild(root: string, name: string): string {
      const child = join(root, name)
      mkdirSync(child, { recursive: true })
      git(child, ['init', '-q', '-b', 'main'])
      configureUser(child)
      commitFile(child, 'child.txt', 'child v1\n', 'child init')
      return child
    }

    function addSubmoduleAndCommit(work: string, childRepo: string, path: string) {
      git(work, ['-c', 'protocol.file.allow=always', 'submodule', 'add', childRepo, path])
      git(work, ['commit', '-q', '-m', 'add submodule'])
    }

    it('auto-ff-style updateSubmodules:true keeps the submodule in sync after a gitlink-moving ff', async () => {
      const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-gitlink-sync-'))
      try {
        const { seed, work } = createRemoteBackedRepo(root)
        const childRepo = initSubmoduleChild(root, 'child-origin')

        // seed adds the submodule and pushes — work must pick this up too (fetch +
        // ff-merge the "add submodule" commit), simulating: submodule already present
        // before the drift-inducing commit, same as a real oss/ or adhdev-providers/
        // checkout that was cloned before the pointer-bump commit landed.
        addSubmoduleAndCommit(seed, childRepo, 'oss')
        git(seed, ['push', '-q', 'origin', 'main'])
        git(work, ['fetch', '-q', 'origin'])
        git(work, ['merge', '-q', '--ff-only', 'origin/main'])
        git(work, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

        // Bump the child repo's own history, then bump the gitlink in `seed` to point at
        // the new child commit, and push — this is the "submodule pointer bump" commit
        // pattern used by the real oss-pointer-bump workflow.
        commitFile(childRepo, 'child.txt', 'child v2\n', 'child v2')
        const childV2 = git(childRepo, ['rev-parse', 'HEAD'])
        git(join(seed, 'oss'), ['fetch', '-q', 'origin'])
        git(join(seed, 'oss'), ['checkout', '-q', childV2])
        git(seed, ['add', 'oss'])
        git(seed, ['commit', '-q', '-m', 'chore(oss): bump submodule pointer'])
        git(seed, ['push', '-q', 'origin', 'main'])

        // Sanity: before the ff, work's submodule checkout is still at v1 (old gitlink).
        expect(git(join(work, 'oss'), ['rev-parse', 'HEAD'])).not.toBe(childV2)

        const result: any = await fastForwardMeshNode({
          workspace: work,
          execute: true,
          updateSubmodules: true,
          nodeId: 'node-gitlink-sync',
          meshId: 'mesh-test',
        })

        expect(result).toMatchObject({ success: true, allowed: true, executed: true, code: 'fast_forward_applied' })
        // The submodule checkout must now match the new gitlink — no drift left behind.
        expect(git(join(work, 'oss'), ['rev-parse', 'HEAD'])).toBe(childV2)
        expect(result.postStatus?.submodules).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: 'oss', dirty: false, outOfSync: false })]),
        )

        // The self-blocking regression: a SECOND auto-ff-style dry-run immediately after
        // must see the submodule as clean/in-sync and remain eligible (not blocked as
        // submodule_not_clean) — this is the "behind 37 accumulation" failure mode.
        const followUpDryRun: any = await fastForwardMeshNode({
          workspace: work,
          execute: false,
          dryRun: true,
          updateSubmodules: true,
          nodeId: 'node-gitlink-sync',
          meshId: 'mesh-test',
        })
        expect(followUpDryRun.code).toBe('already_up_to_date')
        expect(followUpDryRun.allowed).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 60000)

    it('regression guard: a genuinely dirty submodule is still rejected even with updateSubmodules:true', async () => {
      const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-gitlink-dirty-'))
      try {
        const { seed, work } = createRemoteBackedRepo(root)
        const childRepo = initSubmoduleChild(root, 'child-origin-dirty')

        addSubmoduleAndCommit(seed, childRepo, 'oss')
        git(seed, ['push', '-q', 'origin', 'main'])
        git(work, ['fetch', '-q', 'origin'])
        git(work, ['merge', '-q', '--ff-only', 'origin/main'])
        git(work, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

        // Remote advances the ROOT (not the submodule) so there's something to ff.
        pushRemoteCommit(seed, 'base\nremote\n')

        // Local submodule has uncommitted edits — a real dirty submodule, not drift.
        writeFileSync(join(work, 'oss', 'child.txt'), 'child v1\nlocal edit\n', 'utf-8')

        const result: any = await fastForwardMeshNode({
          workspace: work,
          execute: true,
          updateSubmodules: true,
          nodeId: 'node-gitlink-dirty',
          meshId: 'mesh-test',
        })

        expect(result).toMatchObject({ success: false, allowed: false, executed: false, code: 'submodule_not_clean' })
        expect(result.blockingReasons.some((r: string) => r.startsWith('pre_submodule_dirty:'))).toBe(true)
        // Nothing was merged — root HEAD untouched.
        expect(git(work, ['rev-parse', 'HEAD'])).not.toBe(git(seed, ['rev-parse', 'HEAD']))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 60000)

    // This is the exact "behind 37 accumulation" mechanism: a PRIOR auto-ff (before this
    // fix) landed a gitlink-moving commit with updateSubmodules:false, leaving the
    // submodule checked out at the old commit — pure drift, clean working tree. The very
    // NEXT auto-ff attempt must not hard-block on that pre-existing drift at the preflight
    // stage; it should proceed and let updateSubmodules:true resolve it in this cycle.
    // Before the collectPreflightBlockers fix, this test is red: 'pre_submodule_out_of_sync'
    // alone forced code:'submodule_not_clean', allowed:false, even with updateSubmodules:true.
    it('pre-existing gitlink drift (left by a prior ff) does not block a later ff with updateSubmodules:true', async () => {
      const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-ff-gitlink-preexisting-drift-'))
      try {
        const { seed, work } = createRemoteBackedRepo(root)
        const childRepo = initSubmoduleChild(root, 'child-origin-preexisting')

        addSubmoduleAndCommit(seed, childRepo, 'oss')
        git(seed, ['push', '-q', 'origin', 'main'])
        git(work, ['fetch', '-q', 'origin'])
        git(work, ['merge', '-q', '--ff-only', 'origin/main'])
        git(work, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

        // Bump the child repo and the gitlink, and push — same pointer-bump pattern.
        commitFile(childRepo, 'child.txt', 'child v2\n', 'child v2')
        const childV2 = git(childRepo, ['rev-parse', 'HEAD'])
        git(join(seed, 'oss'), ['fetch', '-q', 'origin'])
        git(join(seed, 'oss'), ['checkout', '-q', childV2])
        git(seed, ['add', 'oss'])
        git(seed, ['commit', '-q', '-m', 'chore(oss): bump submodule pointer'])
        git(seed, ['push', '-q', 'origin', 'main'])

        // Simulate a PRIOR ff that used updateSubmodules:false (the pre-fix auto-ff
        // behavior): fetch + root ff-only merge happen directly here (bypassing
        // fastForwardMeshNode) so the submodule is left un-updated — pure drift.
        git(work, ['fetch', '-q', 'origin'])
        git(work, ['merge', '-q', '--ff-only', 'origin/main'])
        expect(git(work, ['rev-parse', 'HEAD:oss'])).toBe(childV2) // gitlink now points at v2
        expect(git(join(work, 'oss'), ['rev-parse', 'HEAD'])).not.toBe(childV2) // but checkout wasn't updated — drift confirmed

        // Root is now fully caught up (ahead=0, behind=0) — nothing left to merge — so
        // this call exercises the preflight path directly, not the post-merge path.
        const result: any = await fastForwardMeshNode({
          workspace: work,
          execute: true,
          updateSubmodules: true,
          nodeId: 'node-preexisting-drift',
          meshId: 'mesh-test',
        })

        // Before the fix: code 'submodule_not_clean' (or 'dirty_worktree' via the root-level
        // 'modified' porcelain entry a gitlink mismatch also produces), allowed:false —
        // self-blocked forever. After the fix: neither preflight signal fires on pure drift.
        expect(result.allowed).toBe(true)
        expect(result.blockingReasons ?? []).not.toContain('modified_changes_present')
        expect((result.blockingReasons ?? []).some((r: string) => r.startsWith('pre_submodule_out_of_sync:'))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 60000)
  })
})
