/**
 * Live rc.41 run 6 finding (item 2): "the log shows nothing between ROUTING
 * DECISION and pulled task" — i.e. a claim refusal was believed invisible in
 * the owner log. It is not: `recordClaimRefusal` (mesh-queue-observability.ts,
 * landed at oss `0ad1c35a`, A6-SILENT-REFUSAL, predating this run) already
 * logs one INFO line per (mesh, node, session) the FIRST time a reason is
 * seen or when it CHANGES, throttling an unchanged reason on every ~4s drain
 * tick, and clears its memo on a successful claim (`clearClaimRefusalState`,
 * called from `tryAssignQueueTask` right after `claimNextTask` succeeds).
 *
 * This suite is the missing direct coverage of THAT throttle behavior itself
 * (the existing `mesh-claim-refusal-reasons.test.ts` only pins that
 * `claimNextQueueTask` attributes the right `MeshClaimRefusalReason` — it
 * never calls `recordClaimRefusal`/checks the log). Break-once: comment out
 * the fingerprint guard (`if (lastClaimRefusalLog.get(key) === fingerprint)
 * return`) in `recordClaimRefusal` and the "same refusal twice" case goes
 * from 1 call to 2.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOG } from '../../src/logging/logger.js'
import { clearClaimRefusalState, recordClaimRefusal } from '../../src/mesh/mesh-queue-observability.js'

const MESH = 'mesh_dedup_test'
const NODE = 'node_dedup_test'
const SESSION = 'session_dedup_test'

function infoLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .filter((call) => call[0] === 'MeshQueue' && typeof call[1] === 'string' && call[1].startsWith('CLAIM REFUSED'))
    .map((call) => call[1] as string)
}

describe('recordClaimRefusal — one INFO line per changed refusal, never a per-tick repeat', () => {
  afterEach(() => {
    // Leave no fingerprint behind for the next test's fresh (mesh, node, session) triple —
    // each test below uses its own MESH/NODE/SESSION suffix so this is belt-and-suspenders.
    clearClaimRefusalState(MESH, NODE, SESSION)
    vi.restoreAllMocks()
  })

  it('two consecutive drains with the SAME refusal reason+detail log exactly ONE line', () => {
    const spy = vi.spyOn(LOG, 'info')
    const args = { nodeId: NODE, sessionId: SESSION, providerType: 'claude-cli', reason: 'owned_paths_conflict', detail: 'owned_paths overlap with task(s): task_A [src/mesh/**]' }

    recordClaimRefusal(MESH, args)
    recordClaimRefusal(MESH, args) // simulates the next ~4s drain tick, verdict unchanged

    const lines = infoLines(spy)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('owned_paths_conflict')
    expect(lines[0]).toContain('task_A')
  })

  it('a CHANGED reason (or detail) logs a second, distinct line', () => {
    const spy = vi.spyOn(LOG, 'info')
    recordClaimRefusal(MESH, { nodeId: NODE, sessionId: SESSION, reason: 'node_busy_with_active_assignment' })
    recordClaimRefusal(MESH, { nodeId: NODE, sessionId: SESSION, reason: 'node_busy_with_active_assignment' }) // unchanged — throttled
    recordClaimRefusal(MESH, { nodeId: NODE, sessionId: SESSION, reason: 'owned_paths_conflict', detail: 'owned_paths overlap with task(s): task_B [src/x.ts]' }) // changed — logs again

    const lines = infoLines(spy)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('node_busy_with_active_assignment')
    expect(lines[1]).toContain('owned_paths_conflict')
    expect(lines[1]).toContain('task_B')
  })

  it('a successful claim afterwards clears the memo, so a later re-entry into the SAME gate logs again', () => {
    const spy = vi.spyOn(LOG, 'info')
    const args = { nodeId: NODE, sessionId: SESSION, reason: 'required_tags_unsatisfied' }

    recordClaimRefusal(MESH, args)
    recordClaimRefusal(MESH, args) // throttled — still just 1 line so far
    expect(infoLines(spy)).toHaveLength(1)

    // The claim succeeds — tryAssignQueueTask calls this right after claimNextTask returns
    // a task, per mesh-queue-assignment.ts.
    clearClaimRefusalState(MESH, NODE, SESSION)

    recordClaimRefusal(MESH, args) // the SAME reason re-entering after a clear must log again
    expect(infoLines(spy)).toHaveLength(2)
  })

  it('the ordinary idle case (no_pending_candidates) is never reported, even repeatedly', () => {
    const spy = vi.spyOn(LOG, 'info')
    recordClaimRefusal(MESH, { nodeId: NODE, sessionId: SESSION, reason: 'no_pending_candidates' })
    recordClaimRefusal(MESH, { nodeId: NODE, sessionId: SESSION, reason: 'no_pending_candidates' })
    expect(infoLines(spy)).toHaveLength(0)
  })
})
