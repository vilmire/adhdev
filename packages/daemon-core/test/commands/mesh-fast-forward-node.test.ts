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
})
