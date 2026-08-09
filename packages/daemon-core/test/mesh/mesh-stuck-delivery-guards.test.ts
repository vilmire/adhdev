import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// STUCK-DELIVERY GUARDS (observed live 2026-08-09): a coordinator waited 74min for a
// delta that could never arrive, while a task that had already posted its final report
// sat 'generating' for 86min. Two independent holds, one shared consequence — the row
// stays 'assigned', the node keeps reading busy, and `node_has_active_assignment` skips
// every later auto-launch on it: a dead task blocking live ones.
//
// Guarded here:
//   1. GENERATING is bounded by the same hard ceiling as the other holds (it was the one
//      branch in the phase that reset its grace every tick and could hold forever).
//   2. An expired target pin is reported to the coordinator instead of being dropped into
//      a metrics counter — the delta lost its address and will NOT reach the session it
//      was written for, which no amount of waiting fixes.
//   3. ★ The write-concurrency invariant is UNCHANGED: a plain write task with no
//      targetSessionId is still gated by nodeHasActiveAssignment. This is the regression
//      guard for the fix that was considered and deliberately NOT made — see below.

const SRC = join(import.meta.dirname, '../../src/mesh')
const reconcile = readFileSync(join(SRC, 'mesh-reconcile-loop.ts'), 'utf-8')
const assignment = readFileSync(join(SRC, 'mesh-queue-assignment.ts'), 'utf-8')

/** Body of the delivered-no-turn GENERATING branch. */
function generatingBranch(): string {
  const start = reconcile.indexOf("if (verdict === 'GENERATING'")
  expect(start, "delivered-no-turn GENERATING branch not found").toBeGreaterThan(-1)
  const end = reconcile.indexOf('continue;  // worker still working', start)
  expect(end, 'GENERATING branch terminator not found').toBeGreaterThan(start)
  return reconcile.slice(start, end)
}

describe('generating hold is bounded (defect B)', () => {
  it('the GENERATING branch is gated by the shared hard deadline', () => {
    const branch = generatingBranch()
    // Without this the branch resets the grace and `continue`s unconditionally, so a
    // stuck liveness signal holds the row 'assigned' forever.
    expect(branch).toContain('queueHoldHardDeadlineExceeded(')
    expect(branch).toContain("'live_generating'")
    // Negated: the branch is taken only while the ceiling has NOT been exceeded.
    expect(branch).toMatch(/&&\s*!queueHoldHardDeadlineExceeded\(/)
  })

  it('reuses the existing ceiling rather than introducing a second number', () => {
    // One place decides "how long is too long to hold a row assigned". A separate
    // constant here would drift from the approval/suspension holds it must agree with.
    expect(reconcile).toContain('const QUEUE_HOLD_HARD_DEADLINE_MS = 90 * 60_000')
    expect(generatingBranch()).not.toMatch(/\d+\s*\*\s*60_000/)
  })

  it('keeps the reset-grace behavior for workers inside the ceiling', () => {
    // Below the ceiling a demonstrably-alive worker must still be protected — the fix
    // bounds the hold, it does not weaken liveness respect.
    expect(generatingBranch()).toContain('deliveredNoTurnUnknownStreak.delete(streakKey)')
  })

  it('live_generating is an accepted gate label on the shared helper', () => {
    const sig = reconcile.slice(
      reconcile.indexOf('function queueHoldHardDeadlineExceeded('),
      reconcile.indexOf('): boolean {', reconcile.indexOf('function queueHoldHardDeadlineExceeded(')),
    )
    expect(sig).toContain("'live_generating'")
  })
})

describe('expired target pin reaches the coordinator (defect A — the real one)', () => {
  it('target_session_pin_expired is classified actionable', () => {
    const list = assignment.slice(
      assignment.indexOf('const ACTIONABLE_SKIP_REASON_PREFIXES = ['),
      assignment.indexOf('];', assignment.indexOf('const ACTIONABLE_SKIP_REASON_PREFIXES = [')),
    )
    expect(list).toContain("'target_session_pin_expired'")
  })

  it('carries guidance saying the delta did NOT reach its addressee', () => {
    // The actionable part is not "a pin expired" but "assume the worker never got your
    // correction and is still acting on the old premise".
    const guidance = assignment.slice(
      assignment.indexOf("if (reason === 'target_session_pin_expired')"),
      assignment.indexOf('};', assignment.indexOf("if (reason === 'target_session_pin_expired')")),
    )
    expect(guidance).toMatch(/NOT reach the session/i)
    expect(guidance).toMatch(/still acting on its previous instructions/i)
  })

  it('the expiry skip is recorded with the reason the classifier matches', () => {
    // The notifier is driven by markAutoLaunch's reason string; a mismatch here makes the
    // classifier entry above dead code.
    expect(assignment).toContain("markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_pin_expired' })")
  })
})

describe('★ write-concurrency invariant is unchanged (regression guard)', () => {
  it('a plain write task is still gated by nodeHasActiveAssignment', () => {
    // A proposed fix would have exempted targeted tasks from this gate. It was NOT made:
    // the gate lives in maybeAutoLaunchOneQueueSession and governs SPAWNING A NEW SESSION,
    // while a targeted task returns earlier at the target_session_constraint branch and is
    // delivered by the claim path instead — so exempting it could not help delivery, and
    // would weaken the one-active-write-per-node invariant (worktree isolation).
    expect(assignment).toContain('if (!isTaskReadonly(task) && nodeHasActiveAssignment(meshId, nodeId)) {')
    expect(assignment).toContain("markSkip(nodeId, 'node_has_active_assignment')")
  })

  it('the gate is NOT conditioned on targetSessionId', () => {
    // Anchor the bounds explicitly. Without this, altering the gate line makes both
    // indexOf calls return -1, slice() yields an unrelated region, and the negative
    // assertion below passes against exactly the change it exists to forbid — verified:
    // adding the exemption left this test green until the bounds were asserted.
    const start = assignment.indexOf('if (!isTaskReadonly(task) && nodeHasActiveAssignment(meshId, nodeId)) {')
    expect(start, 'concurrency gate not found in its expected form').toBeGreaterThan(-1)
    const end = assignment.indexOf('const maxConcurrentSessions', start)
    expect(end, 'gate terminator not found').toBeGreaterThan(start)
    expect(assignment.slice(start, end)).not.toContain('targetSessionId')
  })

  it('targeted tasks still return before the auto-launch gate', () => {
    // Proves the premise of the decision above: the targeted branch `continue`s, so it
    // never reaches the concurrency gate at all.
    const targeted = assignment.slice(
      assignment.indexOf('if (task.targetSessionId) {'),
      assignment.indexOf('// Per-task await-claim guard', assignment.indexOf('if (task.targetSessionId) {')),
    )
    expect(targeted).toContain("markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_constraint' })")
    expect(targeted.indexOf('continue;')).toBeGreaterThan(-1)
    expect(targeted).not.toContain('nodeHasActiveAssignment')
  })
})
