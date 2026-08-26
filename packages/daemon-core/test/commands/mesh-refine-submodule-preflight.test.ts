import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'
import {
  runMeshRefineSubmoduleReachabilityPreflight,
} from '../../src/mesh/mesh-refine-submodule-preflight'
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils'

/**
 * 2026-08-25/26 incident (twice): the Refinery dry-run already KNEW a node
 * touched a submodule (`changeAreas[node].touchesSubmodule`) but never asked
 * whether the gitlink commit was reachable from the submodule's origin/main.
 * The dry-run reported all-clear, every execution gate passed, and only then
 * `submodule_reachability_failed` blocked the merge.
 *
 * These tests pin the preflight contract:
 *   - dry-run WARNS up front when a touched gitlink commit is not on the
 *     submodule's origin/<default>, with the same actionable next-step wording
 *     the execution-time failure carries (injection test: revert → red);
 *   - a reachable gitlink stays green and quiet;
 *   - a failed fetch is 'undeterminable', NEVER 'unreachable' (no false
 *     publish prescription from absent evidence);
 *   - non-submodule nodes get no preflight at all (dry-run stays fast/quiet);
 *   - a batch refine:failed event NAMES the per-node failures.
 *
 * Every fixture points `origin` at a LOCAL path; no test reaches a network.
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
  const dir = mkdtempSync(join(tmpdir(), 'refine-submodule-preflight-'))
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
 * A root repo with one submodule ('sub') whose gitlink on HEAD points at a
 * commit that exists only in the local checkout, NOT on the submodule origin.
 * `baseCommit` is the root commit BEFORE the gitlink bump (the diff base).
 */
function buildUnpublishedFixture() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const base = join(tmp, 'base')

  initRepo(submoduleOrigin)
  commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

  initRepo(base)
  const baseCommit = commitFile(base, 'top.txt', 'top\n', 'root init')
  git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  const subRepo = join(base, 'sub')

  writeFileSync(join(subRepo, 'local-only.txt'), 'not published\n', 'utf-8')
  git(subRepo, ['add', 'local-only.txt'])
  git(subRepo, ['commit', '-q', '-m', 'sub local only'])
  const localOnly = git(subRepo, ['rev-parse', 'HEAD'])

  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'gitlink -> local only'])
  const branchRef = git(base, ['rev-parse', 'HEAD'])

  return { tmp, submoduleOrigin, base, subRepo, localOnly, baseCommit, branchRef }
}

describe('runMeshRefineSubmoduleReachabilityPreflight', () => {
  it('★warns on an unpublished gitlink commit, with the publish-approval next step (injection case)', async () => {
    const { base, baseCommit, branchRef, localOnly } = buildUnpublishedFixture()

    const preflight = await runMeshRefineSubmoduleReachabilityPreflight({
      worktreeRoot: base, baseRef: baseCommit, branchRef,
    })

    expect(preflight).toBeDefined()
    expect(preflight!.status).toBe('warning')
    expect(preflight!.checked).toBe(1)
    expect(preflight!.entries[0].verdict).toBe('unreachable')
    expect(preflight!.entries[0].commit).toBe(localOnly)
    // The SAME actionable wording the execution-time failure carries.
    expect(preflight!.nextStep).toContain('Ask the user for explicit approval')
    expect(preflight!.nextStep).toContain(`sub@${localOnly}`)
  })

  it('stays green and quiet when the gitlink commit is published (normal case)', async () => {
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')

    initRepo(submoduleOrigin)
    commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

    initRepo(base)
    const baseCommit = commitFile(base, 'top.txt', 'top\n', 'root init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'gitlink -> published'])
    const branchRef = git(base, ['rev-parse', 'HEAD'])

    const preflight = await runMeshRefineSubmoduleReachabilityPreflight({
      worktreeRoot: base, baseRef: baseCommit, branchRef,
    })

    expect(preflight).toBeDefined()
    expect(preflight!.status).toBe('passed')
    expect(preflight!.nextStep).toBeUndefined()
    expect(preflight!.entries[0].verdict).toBe('reachable')
  })

  it('★a failed fetch is undeterminable, NEVER unreachable (no publish prescription from absent evidence)', async () => {
    const { submoduleOrigin, base, baseCommit, branchRef } = buildUnpublishedFixture()
    renameSync(submoduleOrigin, `${submoduleOrigin}-moved`)
    expect(existsSync(submoduleOrigin)).toBe(false)

    const preflight = await runMeshRefineSubmoduleReachabilityPreflight({
      worktreeRoot: base, baseRef: baseCommit, branchRef,
    })

    expect(preflight).toBeDefined()
    expect(preflight!.status).toBe('warning')
    expect(preflight!.entries[0].verdict).toBe('undeterminable')
    expect(preflight!.nextStep).toContain('could not be determined')
    expect(preflight!.nextStep).not.toContain('Ask the user for explicit approval')
  })

  it('returns undefined when the branch touches no submodule (dry-run stays quiet)', async () => {
    const tmp = makeTmp()
    const base = join(tmp, 'base')
    initRepo(base)
    const baseCommit = commitFile(base, 'top.txt', 'top\n', 'root init')
    const branchRef = commitFile(base, 'docs.md', 'docs\n', 'docs change')

    const preflight = await runMeshRefineSubmoduleReachabilityPreflight({
      worktreeRoot: base, baseRef: baseCommit, branchRef,
    })
    expect(preflight).toBeUndefined()
  })
})

// ── batch dry-run integration: the preflight rides the plan surface ─────────

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: async () => ({ success: false }) } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
      getByCategory: () => [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    packageName: 'adhdev',
    statusVersion: '0.9.76',
  })
}

function refineConfigPolicy() {
  return {
    refineConfig: { version: 1, validation: { required: true, commands: [{ command: 'npm run typecheck', category: 'typecheck' }] } },
  }
}

function meshWith(repo: string, nodes: any[]) {
  return {
    id: `mesh-preflight-${nodes.map(n => n.id).join('_')}`,
    name: 'Preflight Mesh',
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: { ...refineConfigPolicy() },
    coordinator: {},
    nodes: [
      { id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'd', userOverrides: {}, policy: {} },
      ...nodes,
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('batch_refine_mesh_nodes dry-run submodule preflight', () => {
  it('★warns about the unpublished gitlink in the DRY-RUN, before any gate runs', async () => {
    const tmp = makeTmp()
    const prev = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = join(tmp, '.adhdev')
    try {
      const submoduleOrigin = join(tmp, 'sub-origin')
      const repo = join(tmp, 'repo')
      initRepo(submoduleOrigin)
      commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

      initRepo(repo)
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node typecheck.js' } }), 'utf-8')
      writeFileSync(join(repo, 'typecheck.js'), 'process.exit(0)\n', 'utf-8')
      git(repo, ['add', '.'])
      git(repo, ['commit', '-q', '-m', 'init'])
      git(repo, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
      git(repo, ['add', 'sub'])
      git(repo, ['commit', '-q', '-m', 'add sub submodule'])

      // node-sub: a worktree branch that bumps the gitlink to an UNPUBLISHED commit.
      const wtSub = join(tmp, 'wt-sub')
      git(repo, ['worktree', 'add', '-q', '-b', 'feat/sub', wtSub])
      git(wtSub, ['submodule', 'update', '--init', '-q', 'sub'])
      const wtSubRepo = join(wtSub, 'sub')
      writeFileSync(join(wtSubRepo, 'local-only.txt'), 'not published\n', 'utf-8')
      git(wtSubRepo, ['add', 'local-only.txt'])
      git(wtSubRepo, ['commit', '-q', '-m', 'sub local only'])
      const localOnly = git(wtSubRepo, ['rev-parse', 'HEAD'])
      git(wtSub, ['add', 'sub'])
      git(wtSub, ['commit', '-q', '-m', 'bump sub gitlink'])

      // node-plain: a worktree branch that touches no submodule at all.
      const wtPlain = join(tmp, 'wt-plain')
      git(repo, ['worktree', 'add', '-q', '-b', 'feat/plain', wtPlain])
      writeFileSync(join(wtPlain, 'docs.md'), 'docs\n', 'utf-8')
      git(wtPlain, ['add', '.'])
      git(wtPlain, ['commit', '-q', '-m', 'docs'])

      const mesh = meshWith(repo, [
        { id: 'node-sub', workspace: wtSub, repoRoot: wtSub, daemonId: 'd', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: 'feat/sub', clonedFromNodeId: 'node-source' },
        { id: 'node-plain', workspace: wtPlain, repoRoot: wtPlain, daemonId: 'd', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: 'feat/plain', clonedFromNodeId: 'node-source' },
      ])
      const router = createRouter()

      const result: any = await router.execute('batch_refine_mesh_nodes', { meshId: mesh.id, inlineMesh: mesh })

      expect(result).toMatchObject({ success: true, batch: true, dryRun: true, nodeCount: 2 })
      // ★The dry-run now says it up front: node-sub's gitlink is not on sub origin/main.
      const subPreflight = result.changeAreas['node-sub'].submoduleReachabilityPreflight
      expect(subPreflight).toBeDefined()
      expect(subPreflight.status).toBe('warning')
      expect(subPreflight.entries[0].verdict).toBe('unreachable')
      expect(subPreflight.entries[0].commit).toBe(localOnly)
      expect(subPreflight.nextStep).toContain('Ask the user for explicit approval')
      expect(result.submodulePreflightWarnings).toHaveLength(1)
      expect(result.submodulePreflightWarnings[0]).toContain('node-sub')
      // ★The non-submodule node paid nothing and carries no preflight.
      expect(result.changeAreas['node-plain'].submoduleReachabilityPreflight).toBeUndefined()
      // Dry-run merged nothing (node-plain's docs.md must NOT be on main).
      expect(existsSync(join(repo, 'docs.md'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
    }
  })

  // Same shape as buildUnpublishedFixture, but the ROOT repo gets an origin
  // pinned at the pre-bump commit, so the plan's base ref (origin/main)
  // differs from HEAD and the gitlink bump shows in the diff.
  function buildPlanSurfaceFixture(tmp: string) {
    const sub = join(tmp, 'sub-origin')
    const root = join(tmp, 'base')
    initRepo(sub)
    commitFile(sub, 'mod.txt', 'v1\n', 'sub v1')
    initRepo(root)
    commitFile(root, 'top.txt', 'top\n', 'root init')
    const rootOrigin = join(tmp, 'base-origin')
    git(tmp, ['clone', '-q', '--bare', root, rootOrigin])
    git(root, ['remote', 'add', 'origin', rootOrigin])
    git(root, ['fetch', '-q', 'origin'])
    git(root, ['submodule', 'add', '-q', sub, 'sub'])
    const subRepoPath = join(root, 'sub')
    writeFileSync(join(subRepoPath, 'local-only.txt'), 'not published\n', 'utf-8')
    git(subRepoPath, ['add', 'local-only.txt'])
    git(subRepoPath, ['commit', '-q', '-m', 'sub local only'])
    const only = git(subRepoPath, ['rev-parse', 'HEAD'])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'gitlink -> local only'])
    return { base: root, localOnly: only }
  }

  // The single-node plan surfaces: mesh_refine_plan and mesh_refine_node(dry_run).
  for (const command of ['plan_mesh_refine_node', 'refine_mesh_node'] as const) {
    it(`${command} carries the same preflight warning`, async () => {
      const tmp = makeTmp()
      const prev = process.env.ADHDEV_CONFIG_DIR
      process.env.ADHDEV_CONFIG_DIR = join(tmp, '.adhdev')
      try {
        const { base, localOnly } = buildPlanSurfaceFixture(tmp)
        // The "node" is the base repo itself: its branch (main) is ahead of
        // origin/main with the unpublished gitlink bump.
        const mesh = meshWith(base, [])
        const router = createRouter()

        const result: any = await router.execute(command, {
          meshId: mesh.id, nodeId: 'node-source', inlineMesh: mesh,
        })

        expect(result).toMatchObject({ success: true, dryRun: true, nodeId: 'node-source' })
        expect(result.submoduleReachabilityPreflight).toBeDefined()
        expect(result.submoduleReachabilityPreflight.status).toBe('warning')
        expect(result.submoduleReachabilityPreflight.entries[0].commit).toBe(localOnly)
        expect(result.submoduleReachabilityPreflight.nextStep).toContain('Ask the user for explicit approval')
      } finally {
        if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      }
    })
  }
})

// ── batch terminal event: name the per-node failures ────────────────────────

describe('refine:failed batch event rendering', () => {
  it('★names each failed node with its convergence/code/stage', () => {
    const message = buildMeshSystemMessage({
      event: 'refine:failed',
      nodeLabel: 'batch:2 nodes',
      metadataEvent: {
        jobId: 'refine_batch_x',
        result: {
          success: false,
          batch: true,
          convergenceStatus: 'partial',
          nextStep: 'Resolve blocked_review / not_mergeable nodes manually — failed: node-b [submodule_reachability_failed] (see per-node code/stage/error), then re-run mesh_refine_batch for the remaining nodes.',
          results: [
            { nodeId: 'node-a', convergence: 'merged_to_main' },
            { nodeId: 'node-b', convergence: 'blocked_review', code: 'submodule_reachability_failed', stage: 'submodule_reachability', error: 'gitlink not reachable from origin/main' },
          ],
        },
      },
    } as any)

    expect(message).toContain('Per-node failures:')
    expect(message).toContain('node-b')
    expect(message).toContain('code=submodule_reachability_failed')
    expect(message).toContain('stage=submodule_reachability')
    // Converged nodes are not failures — not listed.
    expect(message).not.toContain('- node-a')
  })

  it('leaves a single-node (non-batch) failure message unchanged', () => {
    const message = buildMeshSystemMessage({
      event: 'refine:failed',
      nodeLabel: 'node-solo',
      metadataEvent: {
        jobId: 'refine_y',
        result: { success: false, code: 'validation_failed', error: 'tests failed' },
      },
    } as any)
    expect(message).toContain('node-solo')
    expect(message).not.toContain('Per-node failures:')
  })
})
