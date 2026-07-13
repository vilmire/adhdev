import { describe, expect, it } from 'vitest'
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js'
import { bootstrapQueueTaskCountsAsHandled } from '../../src/mesh/mesh-event-forwarding.js'
import { AUTO_LAUNCH_AWAIT_CLAIM_MS } from '../../src/mesh/mesh-queue-assignment.js'

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

// BOOTSTRAP-MSG-FIX: regression tests for bootstrapQueueTaskCountsAsHandled — the flag
// computation that was incorrectly returning false when autoLaunch.status === 'completed'
// (i.e. enqueue had already fired triggerMeshQueue and the session was spun up before
// bootstrap_complete arrived). Before the fix, a completed autoLaunch on a still-pending
// task caused worktreeHasQueuedTask=false → 'use mesh_launch_session' even though a
// session had already been launched.
describe('bootstrapQueueTaskCountsAsHandled — worktreeHasQueuedTask flag computation', () => {
  const nodeId = 'node_wt_abc'
  const nowMs = Date.now()
  const recentUpdatedAt = new Date(nowMs - 5_000).toISOString()   // 5s ago — well within window
  const staleUpdatedAt  = new Date(nowMs - AUTO_LAUNCH_AWAIT_CLAIM_MS - 10_000).toISOString() // expired

  it('assigned task → true (session claimed it)', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'assigned', targetNodeId: nodeId, autoLaunch: null },
      nodeId, nowMs,
    )).toBe(true)
  })

  it('pending task with no autoLaunch → true (queue will auto-launch)', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'pending', targetNodeId: nodeId, autoLaunch: null },
      nodeId, nowMs,
    )).toBe(true)
  })

  it('pending task with autoLaunch.status=completed, within window → true (session spun up, will claim)', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'pending', targetNodeId: nodeId, autoLaunch: { status: 'completed', updatedAt: recentUpdatedAt } },
      nodeId, nowMs,
    )).toBe(true)
  })

  it('pending task with autoLaunch.status=started, within window → true', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'pending', targetNodeId: nodeId, autoLaunch: { status: 'started', updatedAt: recentUpdatedAt } },
      nodeId, nowMs,
    )).toBe(true)
  })

  it('pending task with autoLaunch.status=completed, OUTSIDE window → false (launch timed out)', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'pending', targetNodeId: nodeId, autoLaunch: { status: 'completed', updatedAt: staleUpdatedAt } },
      nodeId, nowMs,
    )).toBe(false)
  })

  it('pending task with autoLaunch.status=started, OUTSIDE window → false', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'pending', targetNodeId: nodeId, autoLaunch: { status: 'started', updatedAt: staleUpdatedAt } },
      nodeId, nowMs,
    )).toBe(false)
  })

  it('non-matching targetNodeId → false', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'assigned', targetNodeId: 'node_other', autoLaunch: null },
      nodeId, nowMs,
    )).toBe(false)
  })

  it('null targetNodeId → false', () => {
    expect(bootstrapQueueTaskCountsAsHandled(
      { status: 'assigned', targetNodeId: null, autoLaunch: null },
      nodeId, nowMs,
    )).toBe(false)
  })
})
