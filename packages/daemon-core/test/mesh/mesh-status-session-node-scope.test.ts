import { describe, expect, it } from 'vitest'

import { collectLiveMeshSessionRecords } from '../../src/commands/router.js'

const meshId = 'mesh_test'

function rec(sessionId: string, workspace: string, meta: Record<string, unknown>) {
  return { sessionId, workspace, meta }
}

// One physical daemon hosting a base node + several worktree nodes must expose, on
// each node, ONLY the sessions whose workspace belongs to that node — never the
// whole daemon session list mirrored under every node.
describe('collectLiveMeshSessionRecords — per-node workspace scoping', () => {
  it('exposes only each node\'s own workspace sessions on a shared daemon', () => {
    const sessions = [
      rec('s-A', 'D:\\gh\\wt\\fix-A', { meshNodeFor: meshId, meshNodeId: 'node_A' }),
      rec('s-B', 'D:\\gh\\wt\\fix-B', { meshNodeFor: meshId, meshNodeId: 'node_B' }),
    ]
    const nodeA = { id: 'node_A', workspace: 'D:\\gh\\wt\\fix-A' }
    const nodeB = { id: 'node_B', workspace: 'D:\\gh\\wt\\fix-B' }

    const matchedA = collectLiveMeshSessionRecords({ meshId, node: nodeA, nodeId: 'node_A', liveSessionRecords: sessions })
    const matchedB = collectLiveMeshSessionRecords({ meshId, node: nodeB, nodeId: 'node_B', liveSessionRecords: sessions })

    expect(matchedA.map(r => r.sessionId)).toEqual(['s-A'])
    expect(matchedB.map(r => r.sessionId)).toEqual(['s-B'])
  })

  it('scopes by workspace even when meshNodeId is absent, tolerating separator/case skew', () => {
    const sessions = [
      rec('s-A', 'D:/gh/wt/fix-A', { meshNodeFor: meshId }),
      rec('s-B', 'D:\\gh\\wt\\fix-B\\', { meshNodeFor: meshId }),
    ]
    const nodeA = { id: 'node_A', workspace: 'D:\\GH\\WT\\FIX-A' }

    const matchedA = collectLiveMeshSessionRecords({ meshId, node: nodeA, nodeId: 'node_A', liveSessionRecords: sessions })

    expect(matchedA.map(r => r.sessionId)).toEqual(['s-A'])
  })

  it('keeps the coordinator self-session on the base node without leaking worktree sessions (no regression)', () => {
    const sessions = [
      rec('coord', 'D:\\gh\\base', { meshCoordinatorFor: meshId }),
      rec('s-A', 'D:\\gh\\wt\\fix-A', { meshNodeFor: meshId, meshNodeId: 'node_A' }),
    ]
    const baseNode = { id: 'node_base', workspace: 'D:\\gh\\base' }

    const matched = collectLiveMeshSessionRecords({
      meshId,
      node: baseNode,
      nodeId: 'node_base',
      liveSessionRecords: sessions,
      allowCoordinatorSession: true,
    })

    expect(matched.map(r => r.sessionId)).toContain('coord')
    expect(matched.map(r => r.sessionId)).not.toContain('s-A')
  })
})
