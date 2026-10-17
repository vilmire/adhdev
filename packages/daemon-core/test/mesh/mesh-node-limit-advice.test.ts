import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addNode, createMesh, getMesh } from '../../src/config/mesh-config.js'
// The router must load first: it owns the module cycle through the command registry, and a
// handler module imported ahead of it is seen half-initialised ('declared but no med handler').
import '../../src/commands/router.js'
import { meshNodeLifecycleHandlers } from '../../src/commands/med-family/mesh-node-lifecycle.js'
import { getMeshConfigPath } from '../../src/config/mesh-config-store.js'
import { buildMeshNodeLimitDetails, MESH_NODE_LIMIT_CODE } from '../../src/config/mesh-node-limit.js'
import {
  classifyWorktreesForNodeLimit,
  meshNodeLimitFailure,
  nodeLimitFailureFromError,
} from '../../src/mesh/mesh-node-limit-advice.js'
import { DEFAULT_MESH_MAX_NODES, MESH_MAX_NODES_MAX } from '../../src/repo-mesh-types.js'

// The config layer refuses a registration knowing only the node LIST. The command handler
// that surfaces the refusal also holds the inline cache — each node's last-known git — and
// can tell which worktrees are cleanup_candidate. That judgement must reuse the status
// classifier (no second definition of "cleanup candidate"), must not spawn git, and must
// never invent a verdict for a node it has no evidence about.

const SELF = 'mach_00000000000000000000000000000a01'
const OTHER = 'mach_00000000000000000000000000000b02'

/** A held git observation in the shape the mesh probes record on `node.lastGit`. */
function heldGit(overrides: Record<string, unknown> = {}) {
  return { lastGit: { status: { isGitRepo: true, branch: 'feat/x', headCommit: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/feat/x', upstreamStatus: 'fresh', ...overrides } } }
}

function worktreeNode(id: string, extra: Record<string, unknown> = {}) {
  return { id, workspace: `/gone/${id}`, repoRoot: `/gone/${id}`, daemonId: OTHER, isLocalWorktree: true, worktreeBranch: `feat/${id}`, userOverrides: {}, policy: {}, ...extra }
}

function detailsFor(nodes: any[], maxNodes = nodes.length) {
  return buildMeshNodeLimitDetails({ id: 'mesh_advice', name: 'Advice Mesh', nodes, policy: { maxNodes } } as any)
}

describe('classifyWorktreesForNodeLimit — verdicts come from held git evidence only', () => {
  it('a clean worktree on a feature branch is a cleanup_candidate; a dirty one is not mergeable', () => {
    const nodes = [worktreeNode('node_clean'), worktreeNode('node_dirty')]
    const held = [
      { ...nodes[0], ...heldGit() },
      { ...nodes[1], ...heldGit({ modified: 3 }) },
    ]
    const judged = classifyWorktreesForNodeLimit(detailsFor(nodes), { inlineNodes: held })
    expect(judged.worktrees.map(w => [w.nodeId, w.convergence])).toEqual([
      ['node_clean', 'cleanup_candidate'],
      ['node_dirty', 'not_mergeable'],
    ])
  })

  it('judges against the mesh default branch from the persisted mesh', () => {
    const nodes = [worktreeNode('node_on_default')]
    const held = [{ ...nodes[0], ...heldGit({ branch: 'develop', upstream: 'origin/develop' }) }]
    const onMain = classifyWorktreesForNodeLimit(detailsFor(nodes), { inlineNodes: held, configMesh: { defaultBranch: 'main' } })
    const onDevelop = classifyWorktreesForNodeLimit(detailsFor(nodes), { inlineNodes: held, configMesh: { defaultBranch: 'develop' } })
    expect(onMain.worktrees[0].convergence).toBe('cleanup_candidate')
    expect(onDevelop.worktrees[0].convergence).toBe('merged_to_main')
  })

  it('invents no verdict for a worktree it has no evidence about — even one whose path is absent locally', () => {
    // A remote worktree's path exists only on its own machine; "missing here" must not
    // be read as "gone".
    const nodes = [worktreeNode('node_remote', { daemonId: OTHER })]
    const judged = classifyWorktreesForNodeLimit(detailsFor(nodes), {
      configMesh: { nodes },
      inlineNodes: [{ ...nodes[0] }],
      selfDaemonId: SELF,
    })
    expect(judged.worktrees[0].convergence).toBeUndefined()
  })

  it('a worktree whose directory is gone on THIS daemon is a cleanup_candidate without any git', () => {
    const ghost = worktreeNode('node_ghost', { daemonId: SELF })
    const judged = classifyWorktreesForNodeLimit(detailsFor([ghost]), { configMesh: { nodes: [ghost] }, selfDaemonId: SELF })
    expect(judged.worktrees[0].convergence).toBe('cleanup_candidate')
  })

  it('…but not when the directory is still there, or when another daemon owns it', () => {
    const present = mkdtempSync(join(tmpdir(), 'node-limit-advice-present-'))
    try {
      const here = worktreeNode('node_present', { daemonId: SELF, workspace: present, repoRoot: present })
      const elsewhere = worktreeNode('node_elsewhere', { daemonId: OTHER })
      const judged = classifyWorktreesForNodeLimit(detailsFor([here, elsewhere]), {
        configMesh: { nodes: [here, elsewhere] },
        selfDaemonId: SELF,
      })
      expect(judged.worktrees.map(w => w.convergence)).toEqual([undefined, undefined])
    } finally {
      rmSync(present, { recursive: true, force: true })
    }
  })

  it('does not touch the details it was given', () => {
    const nodes = [worktreeNode('node_clean')]
    const details = detailsFor(nodes)
    classifyWorktreesForNodeLimit(details, { inlineNodes: [{ ...nodes[0], ...heldGit() }] })
    expect(details.worktrees[0].convergence).toBeUndefined()
  })
})

describe('meshNodeLimitFailure — the command result', () => {
  const nodes = [
    { id: 'node_base', workspace: '/work/base', userOverrides: {}, policy: {} },
    worktreeNode('node_clean'),
    worktreeNode('node_dirty'),
  ]
  const held = [{ ...nodes[1], ...heldGit() }, { ...nodes[2], ...heldGit({ modified: 1 }) }]

  it('carries the actionable message and the same facts structured', () => {
    const failure: any = meshNodeLimitFailure(detailsFor(nodes), { inlineNodes: held })
    expect(failure).toMatchObject({ success: false, code: MESH_NODE_LIMIT_CODE, meshId: 'mesh_advice' })
    expect(failure.nodeLimit).toMatchObject({
      count: 3,
      limit: 3,
      baseNodes: 1,
      worktreeNodes: 2,
      limitIsOverride: true,
      defaultLimit: DEFAULT_MESH_MAX_NODES,
      maxAllowed: MESH_MAX_NODES_MAX,
      raiseWith: { command: 'update_mesh', args: { meshId: 'mesh_advice', policy: { maxNodes: '<N>' } } },
      // The hand-edit route names the file this instance reads, structured as well as in the text.
      configPath: getMeshConfigPath(),
    })
    expect(failure.error).toContain(getMeshConfigPath())
    expect(failure.cleanupCandidates).toEqual([{ nodeId: 'node_clean', branch: 'feat/node_clean', convergence: 'cleanup_candidate' }])
  })

  it('lists cleanup_candidate worktrees first and flags the others with their verdict', () => {
    const text: string = (meshNodeLimitFailure(detailsFor(nodes), { inlineNodes: held }) as any).error
    expect(text).toContain('cleanup_candidate worktrees (1): node_clean (feat/node_clean)')
    expect(text).toContain('Other worktree nodes (1): node_dirty (feat/node_dirty) [not_mergeable]')
    expect(text.indexOf('node_clean')).toBeLessThan(text.indexOf('node_dirty'))
    // Some worktrees were judged, so the "no git evidence" hint must not appear.
    expect(text).not.toContain('no git evidence was held here')
  })

  it('without any evidence it lists the worktrees and says where to find the verdict', () => {
    const failure: any = meshNodeLimitFailure(detailsFor(nodes), {})
    expect(failure.cleanupCandidates).toEqual([])
    expect(failure.error).toContain('Worktree nodes (2): node_clean (feat/node_clean), node_dirty (feat/node_dirty)')
    expect(failure.error).toContain('no git evidence was held here')
    expect(failure.error).toContain('mesh_status shows it')
  })
})

/** Point ADHDEV_CONFIG_DIR at a fresh temp dir for every test of the enclosing describe. */
function useTempConfigDir() {
  let configDir: string
  let previousConfigDir: string | undefined
  beforeEach(() => {
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    configDir = mkdtempSync(join(tmpdir(), 'node-limit-advice-config-'))
    process.env.ADHDEV_CONFIG_DIR = configDir
  })
  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })
}

describe('nodeLimitFailureFromError — the handler adapter', () => {
  useTempConfigDir()

  function refusalFromFullMesh() {
    const mesh = createMesh({ name: 'Full', repoIdentity: 'github.com/acme/full', defaultBranch: 'main', policy: { maxNodes: 2 } as any })
    addNode(mesh.id, { workspace: '/work/base', repoRoot: '/work/base' })
    // A worktree of THIS daemon whose directory no longer exists: cleanup_candidate with no git at all.
    addNode(mesh.id, { workspace: '/gone/node_ghost', repoRoot: '/gone/node_ghost', daemonId: SELF, isLocalWorktree: true, worktreeBranch: 'feat/ghost' })
    let error: unknown
    try {
      addNode(mesh.id, { workspace: '/work/one-too-many' })
    } catch (caught) {
      error = caught
    }
    return { mesh, error }
  }

  it('turns the thrown limit error into the enriched failure, reading the persisted mesh itself', async () => {
    const { mesh, error } = refusalFromFullMesh()
    const failure: any = await nodeLimitFailureFromError(error, { meshId: mesh.id, selfDaemonId: SELF })
    expect(failure).toMatchObject({ success: false, code: MESH_NODE_LIMIT_CODE, meshId: mesh.id })
    expect(failure.cleanupCandidates).toHaveLength(1)
    expect(failure.cleanupCandidates[0]).toMatchObject({ branch: 'feat/ghost', convergence: 'cleanup_candidate' })
    expect(failure.error).toContain('cleanup_candidate worktrees (1)')
    expect(failure.error).toContain('already holds 2 of its 2 allowed nodes')
  })

  it('still delivers the refusal when the mesh is not in the persisted config', async () => {
    const { error } = refusalFromFullMesh()
    const failure: any = await nodeLimitFailureFromError(error, { meshId: 'mesh_not_in_config', selfDaemonId: SELF })
    expect(failure).toMatchObject({ success: false, code: MESH_NODE_LIMIT_CODE })
    expect(failure.error).toContain('already holds 2 of its 2 allowed nodes')
    expect(failure.cleanupCandidates).toEqual([])
  })

  it('leaves every other error alone', async () => {
    expect(await nodeLimitFailureFromError(new Error('This workspace is already in the mesh'), { meshId: 'm' })).toBeNull()
    expect(await nodeLimitFailureFromError('boom', { meshId: 'm' })).toBeNull()
    expect(await nodeLimitFailureFromError(undefined, { meshId: 'm' })).toBeNull()
    expect(await nodeLimitFailureFromError({ code: MESH_NODE_LIMIT_CODE }, { meshId: 'm' })).toBeNull()
  })
})

describe('add_mesh_node — the refusal reaches the caller; other errors are untouched', () => {
  useTempConfigDir()

  function makeCtx(inlineNodes?: unknown[]) {
    return {
      deps: { statusInstanceId: SELF },
      requireMeshHostMutationOwner: async () => null,
      getCachedInlineMesh: vi.fn(() => (inlineNodes ? { nodes: inlineNodes } : undefined)),
      updateInlineMeshNode: vi.fn(),
      invalidateAggregateMeshStatus: vi.fn(),
    } as any
  }

  it('answers a full mesh with the actionable failure instead of a bare message', async () => {
    const mesh = createMesh({ name: 'Handler', repoIdentity: 'github.com/acme/handler', policy: { maxNodes: 1 } as any })
    addNode(mesh.id, { workspace: '/work/base' })
    const result: any = await meshNodeLifecycleHandlers.add_mesh_node(makeCtx(), { meshId: mesh.id, workspace: '/work/second' })
    expect(result).toMatchObject({ success: false, code: MESH_NODE_LIMIT_CODE, meshId: mesh.id, nodeLimit: { count: 1, limit: 1 } })
    expect(result.error).toContain('already holds 1 of its 1 allowed nodes')
    expect(result.error).toContain('update_mesh')
    expect(getMesh(mesh.id)!.nodes).toHaveLength(1)
  })

  it('marks cleanup_candidate worktrees from the inline cache the handler already holds', async () => {
    const mesh = createMesh({ name: 'Held', repoIdentity: 'github.com/acme/held', defaultBranch: 'main', policy: { maxNodes: 2 } as any })
    addNode(mesh.id, { workspace: '/work/base' })
    const worktree = addNode(mesh.id, { workspace: '/gone/wt-held', isLocalWorktree: true, worktreeBranch: 'feat/held', daemonId: OTHER })!
    const ctx = makeCtx([{ ...worktree, ...heldGit() }])
    const result: any = await meshNodeLifecycleHandlers.add_mesh_node(ctx, { meshId: mesh.id, workspace: '/work/third' })
    expect(ctx.getCachedInlineMesh).toHaveBeenCalledWith(mesh.id)
    expect(result.cleanupCandidates).toEqual([{ nodeId: worktree.id, branch: 'feat/held', convergence: 'cleanup_candidate' }])
    expect(result.error).toContain(`cleanup_candidate worktrees (1): ${worktree.id} (feat/held)`)
  })

  it('keeps the plain error shape for every other failure and never consults the inline cache for it', async () => {
    const mesh = createMesh({ name: 'Plain', repoIdentity: 'github.com/acme/plain' })
    addNode(mesh.id, { workspace: '/work/base' })
    const ctx = makeCtx()
    const result = await meshNodeLifecycleHandlers.add_mesh_node(ctx, { meshId: mesh.id, workspace: '/work/base' })
    expect(result).toEqual({ success: false, error: 'This workspace is already in the mesh' })
    expect(ctx.getCachedInlineMesh).not.toHaveBeenCalled()
  })
})
