import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadMeshRefineConfig, resolveMeshRefineConfigBaseRefs } from '../../src/mesh/refine-config'
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates'
import { fastForwardHandlers } from '../../src/commands/med-family/fast-forward'

/**
 * BASE-REF-CONFIG-FALLBACK (live 2026-10-01).
 *
 * A coordinator committed `.adhdev/refine.json` to main AFTER its worktree nodes
 * were cut. The Refinery read the config only from the worktree, so every node
 * reported validation_unavailable and finished work could not land without a
 * manual rebase per node. The base branch's (already-landed) config must be
 * honored when the worktree has none; the worktree's own config still wins.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })

const BASE_CONFIG = {
  version: 1,
  validation: { required: true, commands: [{ command: 'git --version', category: 'custom' }] },
}

describe('refine config falls back to the base branch when the worktree predates it', () => {
  let root: string
  let repo: string
  let wt: string
  let mesh: any
  let node: any

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'refine-base-ref-')))
    repo = join(root, 'repo')
    wt = join(root, 'wt')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'hi\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    // Worktree node cut from main BEFORE the config exists.
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
    writeFileSync(join(wt, 'feature.txt'), 'work\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-q', '-m', 'feature work')
    // Coordinator lands the refine config on main afterwards.
    mkdirSync(join(repo, '.adhdev'))
    writeFileSync(join(repo, '.adhdev', 'refine.json'), JSON.stringify(BASE_CONFIG))
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'add refine config')

    node = { id: 'node_wt', workspace: wt, isLocalWorktree: true, clonedFromNodeId: 'node_src', worktreeBranch: 'feature' }
    mesh = { id: 'mesh_1', nodes: [{ id: 'node_src', workspace: repo, repoRoot: repo }, node] }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('without base refs the worktree alone has no config (the pre-fix behavior)', () => {
    expect(loadMeshRefineConfig(mesh, wt).sourceType).toBe('unavailable')
  })

  it('resolves the node base refs and reads the config from main', () => {
    const baseRefs = resolveMeshRefineConfigBaseRefs(mesh, node)
    expect(baseRefs).toEqual(['origin/main', 'main'])
    const loaded = loadMeshRefineConfig(mesh, wt, { baseRefs })
    expect(loaded.sourceType).toBe('repo_file')
    expect(loaded.baseRef).toBe('main')
    expect(loaded.source).toBe('main:.adhdev/refine.json')
    expect(loaded.config?.validation?.commands?.[0]?.command).toBe('git --version')
  })

  it('the worktree own config still wins when present', () => {
    mkdirSync(join(wt, '.adhdev'))
    writeFileSync(join(wt, '.adhdev', 'refine.json'), JSON.stringify({
      version: 1,
      validation: { commands: [{ command: 'git status', category: 'custom' }] },
    }))
    const loaded = loadMeshRefineConfig(mesh, wt, { baseRefs: resolveMeshRefineConfigBaseRefs(mesh, node) })
    expect(loaded.baseRef).toBeUndefined()
    expect(loaded.source).toBe('.adhdev/refine.json')
    expect(loaded.config?.validation?.commands?.[0]?.command).toBe('git status')
  })

  it('refine plan (dry-run) for the stale worktree shows the base config, not validation_unavailable', async () => {
    const ctx: any = { getMeshForCommand: async () => ({ mesh }) }
    const result: any = await fastForwardHandlers.plan_mesh_refine_node(ctx, { meshId: 'mesh_1', nodeId: 'node_wt' })
    expect(result.success).toBe(true)
    expect(result.validationPlan.sourceType).toBe('repo_file')
    expect(result.validationPlan.unavailableReason).toBeUndefined()
    expect(result.validationPlan.commands.map((c: any) => c.displayCommand)).toEqual(['git --version'])
  })

  it('validation gate runs the base config commands when given base refs', async () => {
    const summary: any = await runMeshRefineValidationGate(mesh, wt, { configBaseRefs: ['main'] })
    expect(summary.configSource).toBe('main:.adhdev/refine.json')
    expect(summary.status).toBe('passed')
    expect(summary.commandsRun).toHaveLength(1)
  })
})
