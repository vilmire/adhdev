import { describe, expect, it } from 'vitest'
import { reconcileInlineMeshCache } from '../../src/mesh/mesh-node-identity.js'

/**
 * Regression: NODE-MEMBERSHIP-SHRINK-ON-MERGE.
 *
 * reconcileInlineMeshCache previously derived membership shrinkage from a
 * client-local `updatedAt` timestamp comparison (`preserveCachedMembership`).
 * That timestamp is bumped by ANY MCP client on its own possibly-stale mesh
 * snapshot whenever it makes an unrelated git-status/refine/slots-type call —
 * it carries no information about whether that client has ever learned a
 * given node exists. Whenever an incoming snapshot's `updatedAt` was not
 * older than the cache's, a node that existed ONLY in the cache (e.g. a
 * worktree just registered by clone_mesh_node, not yet echoed back by every
 * other client) was silently dropped from the merged result — no
 * removeNode() call, no ledger entry, no log line.
 *
 * Root-caused via mesh RCA 2026-07-25: 37 node_cloned events over two days,
 * only the 3 permanent base nodes surviving in the durable registry.
 *
 * Fix: membership merge is UNION by default. A cache-only node survives
 * unconditionally unless its id is passed in the new `removedNodeIds`
 * parameter — positive evidence of an intentional removal via the explicit
 * remove_mesh_node tombstone path.
 */
describe('reconcileInlineMeshCache — membership merge is union, not timestamp-gated shrink', () => {
  const baseNode = { id: 'node_base', workspace: '/repo/base', daemonId: 'daemon-1' }
  const clonedNode = { id: 'node_clone', workspace: '/repo/worktree', daemonId: 'daemon-1', isLocalWorktree: true }

  it('preserves a cache-only node when the incoming snapshot has a NEWER updatedAt (the exact bug trigger)', () => {
    const cached = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T17:40:00.000Z',
      nodes: [baseNode, clonedNode],
    }
    // A DIFFERENT MCP client/session sends a snapshot stamped with a later
    // local clock, but it has never learned the clone exists (it only knows
    // about the base node) — this is precisely the live-observed trigger.
    const incoming = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T18:20:00.000Z',
      nodes: [{ ...baseNode, cachedStatus: { health: 'online' } }],
    }

    const merged = reconcileInlineMeshCache(cached, incoming)

    const ids = merged.nodes.map((n: any) => n.id)
    expect(ids).toContain('node_clone')
    expect(ids).toContain('node_base')
  })

  it('preserves a cache-only node when the incoming snapshot has an OLDER updatedAt (previously-covered case, must not regress)', () => {
    const cached = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T18:20:00.000Z',
      nodes: [baseNode, clonedNode],
    }
    const incoming = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T17:40:00.000Z',
      nodes: [{ ...baseNode, cachedStatus: { health: 'online' } }],
    }

    const merged = reconcileInlineMeshCache(cached, incoming)

    expect(merged.nodes.map((n: any) => n.id)).toContain('node_clone')
  })

  it('preserves a cache-only node when the incoming snapshot has NO updatedAt at all', () => {
    const cached = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T17:40:00.000Z',
      nodes: [baseNode, clonedNode],
    }
    const incoming = {
      id: 'mesh_1',
      nodes: [{ ...baseNode }],
    }

    const merged = reconcileInlineMeshCache(cached, incoming)

    expect(merged.nodes.map((n: any) => n.id)).toContain('node_clone')
  })

  it('drops a cache-only node when its id is in removedNodeIds (explicit remove_mesh_node tombstone)', () => {
    const cached = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T17:40:00.000Z',
      nodes: [baseNode, clonedNode],
    }
    const incoming = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T18:20:00.000Z',
      nodes: [{ ...baseNode }],
    }

    const merged = reconcileInlineMeshCache(cached, incoming, new Set(['node_clone']))

    const ids = merged.nodes.map((n: any) => n.id)
    expect(ids).not.toContain('node_clone')
    expect(ids).toContain('node_base')
  })

  it('merges a node that exists only in the incoming snapshot (union in the other direction, must not regress)', () => {
    const cached = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T17:40:00.000Z',
      nodes: [baseNode],
    }
    const newlyDiscoveredNode = { id: 'node_new', workspace: '/repo/other', daemonId: 'daemon-2' }
    const incoming = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T18:20:00.000Z',
      nodes: [{ ...baseNode }, newlyDiscoveredNode],
    }

    const merged = reconcileInlineMeshCache(cached, incoming)

    const ids = merged.nodes.map((n: any) => n.id)
    expect(ids).toContain('node_base')
    expect(ids).toContain('node_new')
  })

  it('a tombstoned id absent from BOTH cached and incoming has no effect (no-op, does not error)', () => {
    const cached = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T17:40:00.000Z',
      nodes: [baseNode, clonedNode],
    }
    const incoming = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T18:20:00.000Z',
      nodes: [{ ...baseNode }],
    }

    const merged = reconcileInlineMeshCache(cached, incoming, new Set(['node_never_existed']))

    expect(merged.nodes.map((n: any) => n.id)).toContain('node_clone')
  })

  it('still lets incoming transient node truth (health/git/cachedStatus) win field-level conflicts for nodes both sides agree exist', () => {
    const cached = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T17:40:00.000Z',
      nodes: [{ ...baseNode, cachedStatus: { health: 'offline' } }, clonedNode],
    }
    const incoming = {
      id: 'mesh_1',
      updatedAt: '2026-07-25T18:20:00.000Z',
      nodes: [{ ...baseNode, cachedStatus: { health: 'online' } }],
    }

    const merged = reconcileInlineMeshCache(cached, incoming)

    const mergedBase = merged.nodes.find((n: any) => n.id === 'node_base')
    expect(mergedBase.cachedStatus.health).toBe('online')
  })
})
