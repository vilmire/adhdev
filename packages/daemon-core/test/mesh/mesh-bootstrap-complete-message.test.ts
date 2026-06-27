import { describe, expect, it } from 'vitest'
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js'

// BOOTSTRAP-MSG: when a worktree bootstrap completes, a task already enqueued against
// that node is auto-claimed by the post-bootstrap queue re-fire. The completion [System]
// message must reflect that auto-claim instead of advising mesh_launch_session — following
// the old advice would spawn a DUPLICATE session alongside the auto-claimed one. The builder
// branches on the `worktreeHasQueuedTask` flag (computed by the caller from the work queue).
describe('buildMeshSystemMessage — worktree_bootstrap_complete auto-claim branching', () => {
  it('advises the auto-claim (no manual launch) when a queued task targets the node', () => {
    const msg = buildMeshSystemMessage({
      event: 'worktree_bootstrap_complete',
      nodeLabel: "Node 'node_wt_1'",
      metadataEvent: { worktreePath: '/work/wt-1', durationMs: 4200 },
      worktreeHasQueuedTask: true,
    })
    expect(msg).toContain('worktree bootstrap completed')
    expect(msg).toContain('at /work/wt-1')
    expect(msg).toContain('in 4s')
    // Auto-claim phrasing — and crucially NOT the misleading manual-launch advice.
    expect(msg).toContain('auto-claim')
    expect(msg).toContain('no manual')
    expect(msg).not.toContain('use `mesh_launch_session` to start an agent')
  })

  it('keeps the manual mesh_launch_session advice when no queued task targets the node', () => {
    const msg = buildMeshSystemMessage({
      event: 'worktree_bootstrap_complete',
      nodeLabel: "Node 'node_wt_2'",
      metadataEvent: { worktreePath: '/work/wt-2' },
      worktreeHasQueuedTask: false,
    })
    expect(msg).toContain('worktree bootstrap completed')
    expect(msg).toContain('use `mesh_launch_session` to start an agent')
    expect(msg).not.toContain('auto-claim')
  })

  it('defaults to the manual-launch advice when the flag is omitted (backward compatible)', () => {
    const msg = buildMeshSystemMessage({
      event: 'worktree_bootstrap_complete',
      nodeLabel: "Node 'node_wt_3'",
      metadataEvent: {},
    })
    expect(msg).toContain('use `mesh_launch_session` to start an agent')
    expect(msg).not.toContain('auto-claim')
  })
})
