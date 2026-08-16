import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// STALE-SCAN-BLOCKER — dispatch_blocked pages fired for work that is already under way.
//
// The auto-launch scan snapshots the pending set ONCE
// (maybeAutoLaunchOneQueueSession: `queue.filter(task => task.status === 'pending')`) and
// then awaits per candidate node. The heavyweight await is `resolveUsableProvider`, which
// awaits `detectCLI` for EVERY slot in the node's provider priority — each a real process
// probe. Across a multi-slot, multi-node scan that is seconds of wall-clock.
//
// Within that window the task can be claimed by an idle session (pending → assigned →
// generating), completed, or cancelled. The loop still holds the PRE-AWAIT snapshot row,
// so it reaches `markAutoLaunch(status:'skipped')` → notifyCoordinatorOfActionableSkip and
// pages the coordinator about a blocker for work that is already running or gone.
//
// Observed 2026-08-16, 4x, every one a false positive:
//   - 3x a late scan of an already-cancelled/completed task (queue pending count was 0)
//   - 1x arrived 122s after its task had already reached `generating` via a successful
//     autoLaunch
// The message asserts an actionable blocker, so each one cost the coordinator a diversion
// into diagnosing a block that did not exist.
//
// The fix re-reads the task's CURRENT status inside notifyCoordinatorOfActionableSkip
// (getQueue reads through to MeshRuntimeStore, not the caller's snapshot) and drops the
// page when the task is no longer pending. It is deliberately FAIL-OPEN: a task that
// cannot be found is still paged, because swallowing a real blocker is the worse failure.

const testTmpDir = path.join(tmpdir(), `adhdev-stale-scan-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'mach_stale_scan_test' } as any),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))

import { notifyCoordinatorOfActionableSkip } from '../../src/mesh/mesh-skip-notify.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  enqueueTask,
  updateTaskStatus,
  cancelTask,
} from '../../src/mesh/mesh-work-queue.js'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'

const NODE_ID = 'node_stale_scan'
const COORDINATOR_DAEMON_ID = 'mach_stale_scan_test'

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

/**
 * Fire the skip notification for `taskId` and return whether the coordinator was paged.
 * Mirrors the production call the scan makes at its skip sites (markAutoLaunch →
 * notifyCoordinatorOfActionableSkip), then drains the coordinator's pending queue.
 */
function pagedFor(meshId: string, taskId: string, reason: string): boolean {
  notifyCoordinatorOfActionableSkip(meshId, taskId, reason, NODE_ID)
  const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
  return (events || []).some(e => (e?.metadataEvent?.taskId ?? e?.taskId) === taskId)
}

describe('STALE-SCAN-BLOCKER: dispatch_blocked is not paged for work already under way', () => {
  let meshId = ''
  afterEach(() => cleanup(meshId))

  // ── The repro ────────────────────────────────────────────────────────────────
  // The exact observed case: the scan computed 'provider_priority_unusable' against a
  // pending snapshot, and by the time the await chain returned the task had been claimed
  // and was generating. 122s elapsed in the live occurrence.
  it('★does NOT page when the task advanced to assigned during the scan await', () => {
    meshId = `stale-scan-${randomUUID().slice(0, 8)}`
    const task = enqueueTask(meshId, 'work that got claimed mid-scan', { difficulty: 'medium' })

    // The scan captured this row while it was pending; during `await detectCLI(...)` an
    // idle session claimed it.
    updateTaskStatus(meshId, task.id, 'assigned')

    expect(pagedFor(meshId, task.id, 'provider_priority_unusable')).toBe(false)
  })

  it('★does NOT page when the task was cancelled during the scan await', () => {
    meshId = `stale-scan-${randomUUID().slice(0, 8)}`
    const task = enqueueTask(meshId, 'work that got cancelled mid-scan', { difficulty: 'medium' })
    cancelTask(meshId, task.id, { reason: 'coordinator cancelled' })

    expect(pagedFor(meshId, task.id, 'provider_priority_unusable')).toBe(false)
  })

  it('★does NOT page when the task already completed during the scan await', () => {
    meshId = `stale-scan-${randomUUID().slice(0, 8)}`
    const task = enqueueTask(meshId, 'work that finished mid-scan', { difficulty: 'medium' })
    updateTaskStatus(meshId, task.id, 'completed')

    expect(pagedFor(meshId, task.id, 'remote_auto_launch_unsupported')).toBe(false)
  })

  // ── The load-bearing inverse: a REAL blocker must still page ─────────────────
  // Without these, "suppress everything" would pass the tests above while hiding genuine
  // blockers — the failure mode this fix must not introduce.
  it('DOES page a genuinely still-pending task (the fix must not swallow real blockers)', () => {
    meshId = `stale-scan-${randomUUID().slice(0, 8)}`
    const task = enqueueTask(meshId, 'genuinely blocked work', { difficulty: 'medium' })

    expect(pagedFor(meshId, task.id, 'provider_priority_unusable')).toBe(true)
  })

  it('DOES page fail-open when the task row cannot be found at all', () => {
    meshId = `stale-scan-${randomUUID().slice(0, 8)}`
    // No enqueue: the row is absent, so status is unknowable. Notifying is the safe
    // direction — an unreadable queue must never silence a blocker.
    expect(pagedFor(meshId, 'task-that-does-not-exist', 'provider_priority_unusable')).toBe(true)
  })

  // ── De-dup re-arm ────────────────────────────────────────────────────────────
  // The suppression path deletes the de-dup marker it just set. Without that, the
  // suppressed reason would stay recorded and a LATER genuine blocker with the same
  // reason would be silently de-duped away — turning a false-positive fix into a
  // false-negative bug.
  it('★re-arms de-dup after suppression, so a later genuine blocker still pages', () => {
    meshId = `stale-scan-${randomUUID().slice(0, 8)}`
    const task = enqueueTask(meshId, 'claimed, then released back to pending', { difficulty: 'medium' })

    // Scan #1: stale — the task advanced mid-await → suppressed.
    updateTaskStatus(meshId, task.id, 'assigned')
    expect(pagedFor(meshId, task.id, 'provider_priority_unusable')).toBe(false)

    // The task returns to pending (requeue / release) and the blocker is now real.
    updateTaskStatus(meshId, task.id, 'pending', { force: true })
    expect(pagedFor(meshId, task.id, 'provider_priority_unusable')).toBe(true)
  })
})

describe('REACHABILITY-RESULT: remote_auto_launch wording matches what the code knows', () => {
  let meshId = ''
  afterEach(() => cleanup(meshId))

  /** The coordinatorMessage surfaced for a still-pending task with `reason`. */
  function messageFor(reason: string): string {
    meshId = `reach-${randomUUID().slice(0, 8)}`
    const task = enqueueTask(meshId, 'pending work', { difficulty: 'medium' })
    notifyCoordinatorOfActionableSkip(meshId, task.id, reason, NODE_ID)
    const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
    const hit = (events || []).find(e => (e?.metadataEvent?.taskId ?? e?.taskId) === task.id)
    return String(hit?.coordinatorMessage ?? '')
  }

  // resolveAutoLaunchTarget emits this when the node has no resolvable daemonId, or when
  // this daemon currently has no dispatchMeshCommand transport — both cleared by a P2P
  // reconnect with NO operator action. The blanket "will NOT clear on its own" clause was
  // therefore false for it, and it is one of the two reasons behind the 4 false pages.
  it('★does not claim a reachability skip will never clear on its own', () => {
    const msg = messageFor('remote_auto_launch_unsupported')
    expect(msg).not.toContain('will NOT clear on its own')
    // Still actionable — a node that stays unreachable does need a human.
    expect(msg).toContain('needs action if it persists')
  })

  // The clause must survive for reasons that genuinely are standing blockers, otherwise
  // the fix has just weakened every warning.
  it('keeps the standing-blocker wording for a genuine configuration blocker', () => {
    expect(messageFor('no_node_satisfies_required_tags')).toContain('will NOT clear on its own')
  })
})
