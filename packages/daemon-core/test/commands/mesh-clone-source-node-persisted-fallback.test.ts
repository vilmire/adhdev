// 2026-10-02: two clones issued together failed the second with "Source node
// '<base>' not found in mesh" while the base node was in meshes.json. The clone
// now consults the persisted mesh before refusing.
import { describe, expect, it, vi } from 'vitest'
import '../../src/commands/router'
import { meshNodeCloneHandlers } from '../../src/commands/med-family/mesh-node-clone.js'

describe('clone_mesh_node source-node lookup', () => {
  it('falls back to the persisted mesh when the inline view lacks the source node', async () => {
    const inline = { id: 'mesh_1', nodes: [] }
    const persisted = { id: 'mesh_1', nodes: [{ id: 'node_base', workspace: '/repo', daemonId: 'daemon_other' }] }
    const getMeshForCommand = vi.fn(async (_id: string, _inline: unknown, opts?: { preferInline?: boolean }) =>
      ({ mesh: opts?.preferInline === false ? persisted : inline, inline: opts?.preferInline !== false, source: 'inline_cache' }))
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, forwarded: true }))
    const ctx: any = {
      getMeshForCommand,
      requireMeshHostMutationOwner: async () => null,
      deps: { statusInstanceId: 'daemon_self', dispatchMeshCommand },
    }
    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, { meshId: 'mesh_1', sourceNodeId: 'node_base', branch: 'feat/x' })
    expect(result.error ?? '').not.toMatch(/not found in mesh/)
    expect(getMeshForCommand).toHaveBeenCalledWith('mesh_1', undefined, { preferInline: false })
  })
})
