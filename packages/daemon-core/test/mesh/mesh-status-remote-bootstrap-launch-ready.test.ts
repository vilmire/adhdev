import { describe, expect, it } from 'vitest'
import { finalizeMeshNodeStatus } from '../../src/mesh/mesh-node-identity.js'
import { WORKTREE_BOOTSTRAP_STALE_RUNNING_MS } from '../../src/mesh/worktree-bootstrap-config.js'

// M-MESH-INFRA-0829 defect 5-b [A]: finalizeMeshNodeStatus's worktreeBootstrap 'running'
// early-return had NO staleness backstop at all (unlike the auto-launch gate's
// shouldDeferDispatchForBootstrap, which already recovered a STALE local-workspace node via
// isWorktreeBootstrapStaleRunning). A REMOTE worktree node whose terminal bootstrap stamp never
// reached this coordinator's mesh view was therefore permanently reported launchReady:false in
// mesh_status even once mirrored recovery landed in the queue's own gate — this test pins that
// finalizeMeshNodeStatus now mirrors the SAME remote-capable backstop
// (isRemoteWorktreeBootstrapStaleRunning), closing the launchReady/queue-gate split.
describe('M-MESH-INFRA-0829 [A] — finalizeMeshNodeStatus remote-bootstrap-stale-running backstop', () => {
  const STARTED = '2026-01-01T00:00:00.000Z'
  const startedMs = Date.parse(STARTED)
  const staleCheckedAt = startedMs + 5 * 60_000 // after start, well within the stale window boundary once elapsed
  const REMOTE_WORKSPACE = '/nonexistent/remote/machine/path/worktree'

  const cleanGitStatus = {
    isGitRepo: true,
    branch: 'main',
    headCommit: 'abc123',
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
  }

  function baseNode(overrides: Record<string, unknown> = {}) {
    return {
      id: 'node_remote_1',
      isLocalWorktree: true, // remote-cloned worktree nodes are still stamped isLocalWorktree:true
      workspace: REMOTE_WORKSPACE,
      worktreeBootstrap: { status: 'running', startedAt: STARTED, required: true },
      ...overrides,
    }
  }

  function baseStatus() {
    // machineStatus:'online' isolates the test to the bootstrap gate — without a stale-running
    // backstop this alone is not enough to make launchReady true (the early return fires first).
    return { machineStatus: 'online', connection: { state: 'connected' } } as Record<string, unknown>
  }

  it('stays launchReady:false while genuinely within the stale window (no premature recovery)', () => {
    const node = baseNode({ lastGit: { checkedAt: startedMs + 60_000, status: cleanGitStatus } })
    const status = baseStatus()
    // "now" is only 5 minutes past start — below WORKTREE_BOOTSTRAP_STALE_RUNNING_MS (10m).
    const now = startedMs + 5 * 60_000
    const realNow = Date.now
    Date.now = () => now
    try {
      finalizeMeshNodeStatus({ status, node, daemonId: 'daemon_remote_x', isSelfNode: false })
    } finally {
      Date.now = realNow
    }
    expect(status.launchReady).toBe(false)
    expect(status.launchBlockedReason).toBe('worktree_bootstrap_running')
  })

  it('stays launchReady:false past the stale window with NO remote git evidence (fail-closed preserved)', () => {
    const node = baseNode()
    const status = baseStatus()
    const now = startedMs + WORKTREE_BOOTSTRAP_STALE_RUNNING_MS + 60_000
    const realNow = Date.now
    Date.now = () => now
    try {
      finalizeMeshNodeStatus({ status, node, daemonId: 'daemon_remote_x', isSelfNode: false })
    } finally {
      Date.now = realNow
    }
    expect(status.launchReady).toBe(false)
    expect(status.launchBlockedReason).toBe('worktree_bootstrap_running')
  })

  it('recovers to launchReady:true once stale + a clean post-start remote git snapshot exists', () => {
    const node = baseNode({ lastGit: { checkedAt: staleCheckedAt, status: cleanGitStatus } })
    const status = baseStatus()
    const now = startedMs + WORKTREE_BOOTSTRAP_STALE_RUNNING_MS + 60_000
    const realNow = Date.now
    Date.now = () => now
    try {
      finalizeMeshNodeStatus({ status, node, daemonId: 'daemon_remote_x', isSelfNode: false })
    } finally {
      Date.now = realNow
    }
    expect(status.launchReady).toBe(true)
    expect(status.launchBlockedReason).toBeUndefined()
  })

  it('stays launchReady:false when the recovered-clean snapshot is DIRTY (must keep deferring)', () => {
    const node = baseNode({ lastGit: { checkedAt: staleCheckedAt, status: { ...cleanGitStatus, untracked: 1 } } })
    const status = baseStatus()
    const now = startedMs + WORKTREE_BOOTSTRAP_STALE_RUNNING_MS + 60_000
    const realNow = Date.now
    Date.now = () => now
    try {
      finalizeMeshNodeStatus({ status, node, daemonId: 'daemon_remote_x', isSelfNode: false })
    } finally {
      Date.now = realNow
    }
    expect(status.launchReady).toBe(false)
    expect(status.launchBlockedReason).toBe('worktree_bootstrap_running')
  })

  it("terminal 'complete' bootstrap status is unaffected (formula runs normally)", () => {
    const node = baseNode({ worktreeBootstrap: { status: 'complete', startedAt: STARTED, required: true } })
    const status = baseStatus()
    finalizeMeshNodeStatus({ status, node, daemonId: 'daemon_remote_x', isSelfNode: false })
    expect(status.launchReady).toBe(true)
  })
})
