import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MESH_MAX_NODES,
  DEFAULT_MESH_POLICY,
  MESH_MAX_NODES_MAX,
  MESH_MAX_NODES_MIN,
  MESH_MAX_PARALLEL_TASKS_MAX,
  mergePolicyOverrides,
  migratePolicyToSparseOverrides,
  normalizePolicyOverrides,
  resolveMaxNodes,
  resolveMeshPolicy,
} from '../../src/repo-mesh-types.js'
import { MEMBER_WORKTREE_REPORT_MAX_NODES } from '../../src/mesh/mesh-remote-worktree-membership.js'

// policy.maxNodes replaced the literal `mesh.nodes.length >= 10` that addNode and the host
// join path each carried. It rides the existing sparse policy surface (POLICY_KEY_SPECS /
// update_mesh), so these tests pin the three things that surface promises for any key:
// the default + clamp on READ, sparse canonical form on STORE, and rejection of a nonsense
// WRITE instead of a silent re-interpretation.

describe('policy.maxNodes — default and bounds', () => {
  it('defaults well above the old literal 10 and inside its own bounds', () => {
    // 32 is the evidence-based default (see DEFAULT_MESH_MAX_NODES): the old literal 10
    // refused eight parallel-task worktree clones in under four days. It must not come back.
    expect(DEFAULT_MESH_MAX_NODES).toBeGreaterThanOrEqual(32)
    expect(DEFAULT_MESH_MAX_NODES).toBeGreaterThan(10)
    expect(DEFAULT_MESH_MAX_NODES).toBeGreaterThanOrEqual(MESH_MAX_NODES_MIN)
    expect(DEFAULT_MESH_MAX_NODES).toBeLessThanOrEqual(MESH_MAX_NODES_MAX)
    expect(DEFAULT_MESH_POLICY.maxNodes).toBe(DEFAULT_MESH_MAX_NODES)
  })

  it('the ceiling is the same bound the scheduler uses for parallel write tasks', () => {
    expect(MESH_MAX_NODES_MAX).toBe(MESH_MAX_PARALLEL_TASKS_MAX)
  })

  it('a member reports worktree nodes up to the largest limit any mesh can be given, not the old 10', () => {
    expect(MEMBER_WORKTREE_REPORT_MAX_NODES).toBe(MESH_MAX_NODES_MAX)
  })
})

describe('resolveMaxNodes — reads never throw and always land in range', () => {
  it('unset, null and non-numeric values resolve to the default', () => {
    for (const unset of [undefined, null, Number.NaN, 'junk', {}, Infinity]) {
      expect(resolveMaxNodes(unset)).toBe(DEFAULT_MESH_MAX_NODES)
    }
  })

  it('values that coerce to 0 through Number() are "unset", not a limit of 1', () => {
    // Number(null), Number(''), Number(false) and Number([]) are all 0; the clamp would
    // raise that to the floor and turn a malformed value into "refuse every new node".
    for (const zeroish of [null, '', '   ', false, []]) {
      expect(Number(zeroish)).toBe(0)
      expect(resolveMaxNodes(zeroish)).toBe(DEFAULT_MESH_MAX_NODES)
    }
    expect(resolveMaxNodes(true)).toBe(DEFAULT_MESH_MAX_NODES)
  })

  it('clamps a hand-edited value into [MIN, MAX] and floors fractions', () => {
    expect(resolveMaxNodes(0)).toBe(MESH_MAX_NODES_MIN)
    expect(resolveMaxNodes(-5)).toBe(MESH_MAX_NODES_MIN)
    expect(resolveMaxNodes(9999)).toBe(MESH_MAX_NODES_MAX)
    expect(resolveMaxNodes(12.9)).toBe(12)
    expect(resolveMaxNodes(48)).toBe(48)
    expect(resolveMaxNodes('48')).toBe(48)
  })

  it('resolveMeshPolicy surfaces the effective value for every stored shape', () => {
    expect(resolveMeshPolicy({}).maxNodes).toBe(DEFAULT_MESH_MAX_NODES)
    expect(resolveMeshPolicy({ maxNodes: 48 }).maxNodes).toBe(48)
    expect(resolveMeshPolicy({ maxNodes: 9999 }).maxNodes).toBe(MESH_MAX_NODES_MAX)
    expect(resolveMeshPolicy({ maxNodes: null }).maxNodes).toBe(DEFAULT_MESH_MAX_NODES)
  })
})

describe('policy.maxNodes — sparse storage and the update_mesh patch', () => {
  it('stores an override and drops a value equal to the default', () => {
    expect(normalizePolicyOverrides({ maxNodes: 48 })).toEqual({ maxNodes: 48 })
    expect(normalizePolicyOverrides({ maxNodes: DEFAULT_MESH_MAX_NODES })).toEqual({})
  })

  it('is resolve-neutral: normalising never changes what the mesh resolves to', () => {
    for (const maxNodes of [1, 2, 10, DEFAULT_MESH_MAX_NODES, 48, MESH_MAX_NODES_MAX]) {
      const stored = normalizePolicyOverrides({ maxNodes })
      expect(resolveMeshPolicy(stored).maxNodes).toBe(resolveMeshPolicy({ maxNodes }).maxNodes)
      expect(normalizePolicyOverrides(stored)).toEqual(stored)
    }
  })

  it('a numeric string from a JSON patch is stored as the number', () => {
    expect(normalizePolicyOverrides({ maxNodes: '48' })).toEqual({ maxNodes: 48 })
  })

  it('a patch sets it, `null` resets it to the default, an absent key leaves it alone', () => {
    const raised = mergePolicyOverrides({ maxParallelTasks: 4 }, { maxNodes: 48 })
    expect(raised).toEqual({ maxParallelTasks: 4, maxNodes: 48 })
    expect(mergePolicyOverrides(raised, { maxParallelTasks: 3 })).toEqual({ maxParallelTasks: 3, maxNodes: 48 })
    const reset = mergePolicyOverrides(raised, { maxNodes: null } as any)
    expect(reset).toEqual({ maxParallelTasks: 4 })
    expect(resolveMeshPolicy(reset).maxNodes).toBe(DEFAULT_MESH_MAX_NODES)
  })
})

describe('policy.maxNodes — a nonsense write is rejected with the range, never clamped', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['above the ceiling', MESH_MAX_NODES_MAX + 1],
    ['a fraction', 1.5],
    ['text', 'many'],
    ['a boolean', true],
    ['an object', {}],
    ['an empty string', ''],
  ])('%s', (_label, value) => {
    expect(() => normalizePolicyOverrides({ maxNodes: value })).toThrow(/invalid_max_nodes/)
    expect(() => mergePolicyOverrides({}, { maxNodes: value })).toThrow(/invalid_max_nodes/)
  })

  it('the error names the accepted range, the offending value and how to reset', () => {
    let message = ''
    try { normalizePolicyOverrides({ maxNodes: 500 }) } catch (e: any) { message = e.message }
    expect(message).toContain(`from ${MESH_MAX_NODES_MIN} to ${MESH_MAX_NODES_MAX}`)
    expect(message).toContain('500')
    expect(message).toContain('null')
    expect(message).toContain(String(DEFAULT_MESH_MAX_NODES))
  })

  it('a stored value that a write would reject survives the load-time migration verbatim', () => {
    // Owner data is never dropped on load; resolve clamps it instead.
    const migrated = migratePolicyToSparseOverrides({ maxNodes: 9999, maxParallelTasks: 4 })
    expect(migrated).toEqual({ maxNodes: 9999, maxParallelTasks: 4 })
    expect(resolveMeshPolicy(migrated).maxNodes).toBe(MESH_MAX_NODES_MAX)
  })
})
