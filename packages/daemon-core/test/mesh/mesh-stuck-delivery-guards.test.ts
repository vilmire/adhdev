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
// Guard 1 (the delivered-no-turn GENERATING hold bounded by the shared hard
// ceiling) retired 2026-09-23 with mesh-reconcile-stranded-dispatch.ts (wiring-
// unification C4): every open mesh attempt now carries a hard_ceiling turn hold
// from R1, H5 commits it failed, and the scheduler WARNs on an open attempt
// without one — pinned in test/turn-ledger/scheduler.test.ts.
const assignment = readFileSync(join(SRC, 'mesh-queue-assignment.ts'), 'utf-8')
// The auto-launch subsystem (incl. maybeAutoLaunchOneQueueSession and its gates) moved
// out of mesh-queue-assignment.ts into mesh-queue-autolaunch.ts (pure move, no behavior
// change). Only the path follows it — every assertion below is unchanged.
const autolaunch = readFileSync(join(SRC, 'mesh-queue-autolaunch.ts'), 'utf-8')
// The actionable-skip classifier and its guidance text moved out of mesh-queue-assignment.ts
// into mesh-skip-notify.ts (pure move, no behavior change). Only the path follows them —
// every assertion below is unchanged. Without this the two scans would slice an empty
// string and pass against nothing.
const skipNotify = readFileSync(join(SRC, 'mesh-skip-notify.ts'), 'utf-8')

describe('expired target pin reaches the coordinator (defect A — the real one)', () => {
  it('target_session_pin_expired is classified actionable', () => {
    const listStart = skipNotify.indexOf('const ACTIONABLE_SKIP_REASON_PREFIXES = [')
    expect(listStart, 'actionable-skip classifier list not found').toBeGreaterThan(-1)
    const list = skipNotify.slice(listStart, skipNotify.indexOf('];', listStart))
    expect(list).toContain("'target_session_pin_expired'")
  })

  it('carries guidance saying the delta did NOT reach its addressee — when that is what the evidence shows', () => {
    // The actionable part is not "a pin expired" but "assume the worker never got your
    // correction and is still acting on the old premise".
    //
    // DISPATCH-ACK-EVIDENCE (2026-08-11): that guidance is now CONDITIONAL on the delivery
    // records, because asserting it unconditionally was itself a defect — the message was
    // emitted verbatim for tasks the worker had demonstrably received and was already acting
    // on (observed 4x in one session), and acting on it would inject the same instruction
    // twice. The wording below is the no-delivery-record branch: the case this test was
    // written for, and the only one that still licenses a re-send. The behavioural assertions
    // for all three branches live in mesh-pin-expiry-delivery-evidence.test.ts.
    const guidanceStart = skipNotify.indexOf("if (reason === 'target_session_pin_expired')")
    expect(guidanceStart, 'pin-expired guidance branch not found').toBeGreaterThan(-1)
    // Slice to the end of the whole branch (its closing `}` + blank line), not the first
    // `};` — the branch now contains several returns.
    const guidance = skipNotify.slice(guidanceStart, skipNotify.indexOf('\n    }\n', guidanceStart))
    expect(guidance).toMatch(/did not reach it/i)
    expect(guidance).toMatch(/still acting on its previous instructions/i)
    // And the branch must actually discriminate rather than assert one answer for every case.
    expect(guidance).toMatch(/evidence === 'consumed'/)
    expect(guidance).toMatch(/evidence === 'delivered'/)
  })

  it('the park skip is recorded with the reason the classifier matches', () => {
    // The notifier is driven by markAutoLaunch's reason string; a mismatch here makes the
    // classifier entry above dead code.
    //
    // PIN-PARKING: the expiry no longer clears the pin, it PARKS the task, and the skip
    // reason moved with it (target_session_pin_expired → PARKED_SKIP_REASON). Asserted
    // through the shared constant rather than a literal so the two cannot drift apart
    // silently — a rename now breaks the import, not just this string match.
    expect(autolaunch).toContain("markAutoLaunch(meshId, task.id, { status: 'skipped', reason: PARKED_SKIP_REASON })")
    expect(autolaunch).toContain("from './mesh-task-parking.js'")
  })
})

describe('★ write-concurrency invariant is unchanged (regression guard)', () => {
  it('a plain write task is still gated by nodeHasActiveAssignment', () => {
    // A proposed fix would have exempted targeted tasks from this gate. It was NOT made:
    // the gate lives in maybeAutoLaunchOneQueueSession and governs SPAWNING A NEW SESSION,
    // while a targeted task returns earlier at the target_session_constraint branch and is
    // delivered by the claim path instead — so exempting it could not help delivery, and
    // would weaken the one-active-write-per-node invariant (worktree isolation).
    expect(autolaunch).toContain('if (!isTaskReadonly(task) && nodeHasActiveAssignment(meshId, nodeId)) {')
    expect(autolaunch).toContain("markSkip(nodeId, 'node_has_active_assignment')")
  })

  it('the gate is NOT conditioned on targetSessionId', () => {
    // Anchor the bounds explicitly. Without this, altering the gate line makes both
    // indexOf calls return -1, slice() yields an unrelated region, and the negative
    // assertion below passes against exactly the change it exists to forbid — verified:
    // adding the exemption left this test green until the bounds were asserted.
    const start = autolaunch.indexOf('if (!isTaskReadonly(task) && nodeHasActiveAssignment(meshId, nodeId)) {')
    expect(start, 'concurrency gate not found in its expected form').toBeGreaterThan(-1)
    const end = autolaunch.indexOf('const maxConcurrentSessions', start)
    expect(end, 'gate terminator not found').toBeGreaterThan(start)
    expect(autolaunch.slice(start, end)).not.toContain('targetSessionId')
  })

  it('targeted tasks still return before the auto-launch gate', () => {
    // Proves the premise of the decision above: the targeted branch `continue`s, so it
    // never reaches the concurrency gate at all.
    const targeted = autolaunch.slice(
      autolaunch.indexOf('if (task.targetSessionId) {'),
      autolaunch.indexOf('// Per-task await-claim guard', autolaunch.indexOf('if (task.targetSessionId) {')),
    )
    expect(targeted).toContain("markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_constraint' })")
    expect(targeted.indexOf('continue;')).toBeGreaterThan(-1)
    expect(targeted).not.toContain('nodeHasActiveAssignment')
  })
})
