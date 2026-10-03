// R11: concurrent clone_mesh_node calls on one mesh raced on the mesh record and
// the source repo's `git worktree add`. The resolve → create → register section
// is serialized per mesh; remote forwarding runs outside the lock.
import { describe, expect, it, vi } from 'vitest'
import '../../src/commands/router'
import { meshNodeCloneHandlers, withMeshCloneLock } from '../../src/commands/med-family/mesh-node-clone.js'

const tick = () => new Promise(r => setTimeout(r, 5))

describe('withMeshCloneLock', () => {
  it('runs critical sections for one mesh one at a time, in arrival order', async () => {
    const log: string[] = []
    const section = (name: string) => withMeshCloneLock('mesh_1', async () => {
      log.push(`${name}:start`); await tick(); log.push(`${name}:end`); return name
    })
    const results = await Promise.all([section('a'), section('b'), section('c')])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('does not serialize different meshes and survives a failing section', async () => {
    const log: string[] = []
    const failing = withMeshCloneLock('mesh_x', async () => { await tick(); throw new Error('boom') })
    const other = withMeshCloneLock('mesh_y', async () => { log.push('y'); return 'y' })
    const after = withMeshCloneLock('mesh_x', async () => { log.push('x2'); return 'x2' })
    await expect(failing).rejects.toThrow('boom')
    expect(await other).toBe('y')
    expect(await after).toBe('x2')
    expect(log).toEqual(['y', 'x2'])
  })
})

describe('clone_mesh_node forwarding', () => {
  it('forwards to a remote source daemon without holding the mesh lock', async () => {
    const mesh = { id: 'mesh_f', nodes: [{ id: 'node_base', workspace: '/repo', daemonId: 'daemon_other' }] }
    let reentered: unknown
    const ctx: any = {
      getMeshForCommand: async () => ({ mesh, inline: true, source: 'inline_cache' }),
      requireMeshHostMutationOwner: async () => null,
      deps: {
        statusInstanceId: 'daemon_self',
        // A legacy-form id routing back to this daemon re-enters the lock.
        dispatchMeshCommand: vi.fn(async () => {
          reentered = await withMeshCloneLock('mesh_f', async () => 'reentered')
          return { success: true, forwarded: true }
        }),
      },
    }
    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, { meshId: 'mesh_f', sourceNodeId: 'node_base', branch: 'feat/y' })
    expect(reentered).toBe('reentered')
    expect(result.success).not.toBe(false)
  })
})
