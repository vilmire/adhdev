import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// WORKER-MCP T2 precursor (docs/design/2026-08-28-worker-mcp.md §8 R1 gap).
//
// meshActiveTaskId is a last-write-wins scalar (cli-provider-instance.ts
// attachMeshAssignment): a second task attaching to a session before the
// FIRST task's turn completes overwrites it, so pushEvent's
// completingTurnTaskId() attributes the completion to the WRONG task
// (NOTIF-MISDELIVER / TASK-MSG-MISROUTE) and detachMeshAssignment wipes the
// scalar out from under the still-pending second task entirely.
//
// This does not happen in production today: mesh policy queues busy sessions
// (mesh-delivery-policy.ts BUSY_DELIVERY_STATUSES, allowBusyInjection never
// passed by any caller), auto-pick only selects idle sessions
// (mcp-server mesh-tools-internal.ts isIdleSessionRecord), and the FSM's
// canSendNow() hard-requires 'idle' before writing to the PTY
// (providers/spec/fsm-driver.ts) — none of those three gates are touched by
// this change. These tests cover the PRECONDITION a later T2 change would
// need before any of those three gates could be safely loosened: correct
// attribution across an overlapping attach.
//
// Everything is behind ADHDEV_WORKER_MCP (default off). Flag off: the turn-
// aware history is never populated, so every method here falls through to
// the exact pre-existing scalar-only behavior.
describe('CliProviderInstance — WORKER-MCP T2 precursor: turn-aware task attachment', () => {
  const ORIGINAL_FLAG = process.env.ADHDEV_WORKER_MCP

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ADHDEV_WORKER_MCP
    else process.env.ADHDEV_WORKER_MCP = ORIGINAL_FLAG
  })

  function makeInstance(settings: Record<string, any>) {
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-instance-1'
    instance.type = 'claude-code'
    instance.workingDir = '/work/repo'
    instance.settings = settings
    instance.adapter = { updateRuntimeSettings() {} }
    // Object.create bypasses the constructor, so class-field initializers
    // (meshTaskInjectedAt = 0, meshTaskAttachmentHistory = []) never run —
    // set them explicitly, matching the pattern other tests in this suite use
    // for private instance state.
    instance.meshTaskInjectedAt = 0
    instance.meshTaskAttachmentHistory = []
    return instance
  }

  describe('gate OFF (default) — byte-identical to pre-existing scalar-only behavior', () => {
    beforeEach(() => { delete process.env.ADHDEV_WORKER_MCP })

    it('a second attach before the first detaches still clobbers the scalar (documented pre-existing race)', () => {
      const instance = makeInstance({ launchedByCoordinator: true })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-A', attemptId: 'attempt-A' })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-B', attemptId: 'attempt-B' })
      expect(instance.settings.meshActiveTaskId).toBe('task-B')
      expect(instance.completingTurnTaskId()).toBe('task-B')
      // Detach (as if task-A's turn just completed) wipes the marker outright —
      // task-B's own subsequent completion would carry no taskId at all. This
      // is the exact defect the flag-gated fix below removes.
      instance.detachMeshAssignment()
      expect(instance.settings.meshActiveTaskId).toBeUndefined()
    })

    it('never populates the turn-aware history array', () => {
      const instance = makeInstance({ launchedByCoordinator: true })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-A' })
      expect(instance.meshTaskAttachmentHistory).toEqual([])
    })
  })

  describe('gate ON — single attachment (today\'s only reachable case) is unchanged', () => {
    beforeEach(() => { process.env.ADHDEV_WORKER_MCP = '1' })

    it('attach → completingTurnTaskId → detach matches the scalar exactly', () => {
      const instance = makeInstance({ launchedByCoordinator: true })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-A', attemptId: 'attempt-A', dispatchNonce: 7 })
      expect(instance.settings.meshActiveTaskId).toBe('task-A')
      expect(instance.completingTurnTaskId()).toBe('task-A')
      instance.detachMeshAssignment()
      expect(instance.settings.meshActiveTaskId).toBeUndefined()
      expect(instance.meshTaskAttachmentHistory).toEqual([])
    })
  })

  describe('gate ON — overlapping attach (busy-injection precondition)', () => {
    beforeEach(() => { process.env.ADHDEV_WORKER_MCP = '1' })

    it('resolves the FIRST attached task as completing, not whichever attached last', () => {
      const instance = makeInstance({ launchedByCoordinator: true })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-A', attemptId: 'attempt-A' })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-B', attemptId: 'attempt-B' })
      // Scalar still reflects the most recent attach (back-compat alias, per
      // the design's decision to keep it as a legacy alias) ...
      expect(instance.settings.meshActiveTaskId).toBe('task-B')
      // ... but attribution for the turn that is ACTUALLY completing (task-A's,
      // since it was attached first and only one turn is physically in flight
      // on the PTY) resolves correctly via the turn-aware history.
      expect(instance.completingTurnTaskId()).toBe('task-A')
    })

    it('detaching the completed (first) task restores the still-pending (second) task onto the scalar', () => {
      const instance = makeInstance({ launchedByCoordinator: true })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-A', attemptId: 'attempt-A', dispatchNonce: 1 })
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-B', attemptId: 'attempt-B', dispatchNonce: 2 })

      // task-A's turn completes: pushEvent's real call order is
      // completingTurnTaskId() (resolves task-A) then detachMeshAssignment().
      expect(instance.completingTurnTaskId()).toBe('task-A')
      instance.detachMeshAssignment()

      // task-B is still pending — its identity must be restored onto the
      // scalar and attempt/nonce markers, not left cleared.
      expect(instance.settings.meshActiveTaskId).toBe('task-B')
      expect(instance.settings.meshActiveAttemptId).toBe('attempt-B')
      expect(instance.settings.meshActiveDispatchNonce).toBe(2)
      // Session-level membership survives throughout (unaffected by either detach).
      expect(instance.settings.meshNodeFor).toBe('mesh-1')
      expect(instance.completingTurnTaskId()).toBe('task-B')

      // task-B's turn now completes: second detach clears fully (history empty).
      instance.detachMeshAssignment()
      expect(instance.settings.meshActiveTaskId).toBeUndefined()
      expect(instance.settings.meshActiveAttemptId).toBeUndefined()
      expect(instance.settings.meshActiveDispatchNonce).toBeUndefined()
      expect(instance.settings.meshNodeFor).toBe('mesh-1') // session membership still preserved (launched member)
    })

    it('injectedTaskHasStartedGenerating uses the FIRST attachment\'s inject time, not the bumped scalar', () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000)
        const instance = makeInstance({ launchedByCoordinator: true })
        // task-A attaches at t=1000 and its turn genuinely starts at t=1050.
        instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-A' })
        const taskAInjectedAt = instance.meshTaskAttachmentHistory[0].injectedAt
        expect(taskAInjectedAt).toBe(1_000)
        instance.adapter.currentTurnStartedAt = 1_050 // task-A's turn started

        // Before task-B attaches, the gate correctly sees task-A's turn as started.
        expect(instance.injectedTaskHasStartedGenerating()).toBe(true)

        // task-B attaches at t=2000, while task-A is still generating
        // (busy-injection). The bare scalar meshTaskInjectedAt is bumped
        // forward by this attach — the exact mechanism that would make
        // task-A's real completion (turnStartedAt=1050) look premature
        // (1050 is NOT > 2000) if the gate still read the bare scalar.
        vi.setSystemTime(2_000)
        instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-B' })
        expect(instance.meshTaskInjectedAt).toBe(2_000)

        // The turn-aware history still anchors on task-A's own inject time
        // (1000, its turn hasn't been popped yet), so task-A's already-started
        // turn (1050 > 1000) is NOT reclassified as premature.
        expect(instance.injectedTaskHasStartedGenerating()).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('caps the attachment history so a stuck detach cannot grow it unbounded', () => {
      const instance = makeInstance({ launchedByCoordinator: true })
      for (let i = 0; i < 12; i++) {
        instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: `task-${i}` })
      }
      expect(instance.meshTaskAttachmentHistory.length).toBeLessThanOrEqual(8)
      // Oldest entries are dropped first — the head is always the most recent
      // survivor, never silently reordered.
      expect(instance.meshTaskAttachmentHistory[instance.meshTaskAttachmentHistory.length - 1].taskId).toBe('task-11')
    })
  })

  describe('SEND-OVERLAP non-regression (braided-bubble incident, 2026-08-10)', () => {
    it('this change touches only mesh-attachment bookkeeping — the PTY write gate (fsm-driver.ts canSendNow) is a separate, untouched module', () => {
      // This is a documentation-anchored guard, not a behavioral one: the real
      // canSendNow()/SEND-OVERLAP coverage lives in
      // test/providers/spec/driver-send-overlap-gate.test.ts, which this task
      // does not modify. Turning ADHDEV_WORKER_MCP on does not, by itself,
      // change what gets written to any PTY — attachMeshAssignment only ever
      // mutates in-memory settings/bookkeeping consumed by mesh event
      // attribution, never the send path.
      process.env.ADHDEV_WORKER_MCP = '1'
      const instance = makeInstance({ launchedByCoordinator: true })
      const before = { ...instance.settings }
      instance.attachMeshAssignment({ meshId: 'mesh-1', taskId: 'task-A' })
      // No PTY/adapter send method exists on this stub instance; attach must
      // not attempt to call one (would throw if it tried).
      expect(instance.settings).not.toEqual(before)
      delete process.env.ADHDEV_WORKER_MCP
    })
  })
})
