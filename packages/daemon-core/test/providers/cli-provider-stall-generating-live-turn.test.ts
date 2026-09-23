import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// GENERATING-LIVE-TURN (2026-09-20) — regression for the false stall that sealed a
// WORKING worker as terminal `failed`.
//
// The live incident (coordinator session 555467f4 / task ae0c8135):
//   14:13:39  FsmDriver   starting → idle (startup-grace)
//   14:14:23  FsmDriver   idle → busy
//   14:14:59  FsmDriver   busy → idle
//   14:15:13  FsmDriver   idle → busy          ← the real work turn starts
//             (PTY and transcript both silent — codex reasoning between tool calls)
//   14:21:20  EvtTrace    [stage:fired] monitor:no_progress — mesh_worker_stall
//   14:21:28  TurnLedger  Committed terminal failed (source=stall_reconcile,
//                         stage was generating)
//   14:22:42  FsmDriver   busy → idle          ← the worker finished 74s LATER
// Result: totalMessages=1 (the dispatch only), assistant output 0 — the work was
// discarded because the reconcile treats the `task_stalled` ledger entry as
// terminal evidence and never re-reads the transcript.
//
// WHY THE PRE-EXISTING GUARD COULD NOT CATCH IT: the Stage 6 branch re-armed on
// `now - attempt.updatedAt < threshold`, but `turn_attempts.updated_at` (formerly `mesh_turn_attempts`) is a
// STAGE-TRANSITION stamp. `generating` is written once (edge-triggered from
// agent:generating_started) and nothing refreshes it while the agent works, so that
// comparison is just "is the turn younger than the threshold" — true only in the
// window where the stall cannot fire anyway. The fix keys the veto to the ADAPTER's
// open turn instead of to a frozen clock.
//
// This suite pins BOTH directions:
//   (1) a `generating` attempt with an OPEN adapter turn is never sealed, however
//       long the PTY stays quiet (the incident), and
//   (2) a genuinely wedged worker — `generating` row but the adapter turn has
//       CLOSED — still fires, so stall detection is not weakened.

const testTmpDir = join(tmpdir(), `adhdev-stall-live-turn-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true })
        return testConfigDir
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}))

import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js'
import {
    resolveSessionTurnPresentation,
    STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS,
} from '../../src/mesh/mesh-turn-presentation.js'

const IDLE_STALL_MS = 180_000
const TURN_STALL_MS = 360_000

// The incident's own geometry, in ms offsets from the turn start.
const QUIET_AT_FIRE = 367_000   // 14:15:13 → 14:21:20, the moment it actually fired
const QUIET_AT_FINISH = 449_000 // 14:15:13 → 14:22:42, when the worker really finished

// STALE-ATTEMPT-AUTHORITY GATE (mesh-turn-presentation.ts) — an in-flight row
// older than 30 min loses `turn_reducer` authority, and with it BOTH the Stage 6
// branches these tests exercise. The bases below must therefore be wall-clock
// scale, not synthetic epoch-1970 offsets: a row stamped at t=1_000_000 reads as
// ~56 years old and is demoted before the watchdog ever sees a stage, which would
// make every assertion here pass or fail for the wrong reason.
const CLOCK_BASE = Date.parse('2026-09-20T14:15:13.000Z')
// Imported, not copied: if the gate is ever retuned, the bound asserted below
// moves with it instead of silently testing a stale number.
const STALE_AUTHORITY_MAX_AGE_MS = STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS

afterAll(() => {
    try { rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('stall watchdog — a generating attempt with an open adapter turn', () => {
    let seq = 0
    let meshId: string
    let taskId: string
    let sessionId: string

    beforeEach(() => {
        seq += 1
        meshId = `mesh-live-turn-${seq}`
        taskId = `task-live-turn-${seq}`
        sessionId = `sess-live-turn-${seq}`
    })

    /**
     * Drive a real attempt row to `generating` at `startedAt`, exactly as the live
     * dispatch does. Nothing writes the row again afterwards — which is the whole
     * point: updated_at stays frozen at the turn start.
     *
     * Every writer takes `nowMs` — that is the knob that stamps `updated_at`.
     * (C-W8: `turn_attempts.updated_at`, stamped by `TurnStore.upsertAttempt(nowMs)`.)
     * Seeding at real wall-clock instead would leave the row stamped at
     * real wall-clock while the watchdog is driven on the synthetic clock, and the
     * resulting NEGATIVE `now - updatedAt` would satisfy the pre-existing Stage 6
     * clock branch by accident — masking exactly what these tests must observe.
     */
    function seedGeneratingAttempt(startedAt: number): void {
        // C-W8: seeded on the turn ledger (`turn_attempts`), the table Stage 6 reads.
        seedMeshAttempt({ meshId, taskId, sessionId, providerType: 'codex-cli', stage: 'generating', nowMs: startedAt })
    }

    function makeInstance(opts: { lastOutputAt: number; turnActive: boolean; startedAt?: number }) {
        const emitted: any[] = []
        const instance = Object.create(CliProviderInstance.prototype) as any
        instance.instanceId = sessionId
        instance.type = 'codex-cli'
        instance.workingDir = '/work/repo'
        instance.providerSessionId = 'provider-sess-codex'
        instance.settings = { meshNodeFor: meshId, meshNodeId: 'node-1', meshActiveTaskId: taskId }
        instance.events = []
        instance.startedAt = opts.startedAt ?? 1_000
        instance.meshStallAnchorAt = -1
        instance.meshStallEmittedForAnchor = false
        instance.meshStallTurnActiveLast = undefined
        instance.meshStallLastFiredAt = -1
        instance.meshStallTranscriptSignalSampled = false
        const adapter = {
            currentTurnTaskId: taskId as string | undefined,
            _lastOutputAt: opts.lastOutputAt,
            _status: 'generating',
            _alive: true,
            currentTurnScope: opts.turnActive ? { id: 'turn-1' } : undefined,
            isAlive() { return this._alive },
            getStatus() { return { lastOutputAt: this._lastOutputAt, status: this._status } },
        }
        instance.adapter = adapter
        instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
        return { instance, emitted, adapter }
    }

    it('proves the premise: updated_at freezes at turn start, so it cannot witness liveness', () => {
        const startedAt = CLOCK_BASE
        seedGeneratingAttempt(startedAt)
        // Sampled >6 minutes later — the row has NOT been written again.
        const presentation = resolveSessionTurnPresentation({
            sessionId,
            legacyStatus: 'generating',
            providerType: 'codex-cli',
            surface: 'stall_watchdog',
            nowMs: startedAt + QUIET_AT_FIRE,
        })
        expect(presentation.authority).toBe('turn_reducer')
        expect(presentation.stage).toBe('generating')
        // The stamp is the TURN START, not a heartbeat — this is the defect's root.
        expect(Date.parse(presentation.updatedAt!)).toBe(startedAt)
        // ...so the old `now - updatedAt < threshold` test is FALSE exactly when the
        // watchdog acts. Pinning this keeps the premise honest if the guard is retuned.
        expect(startedAt + QUIET_AT_FIRE - Date.parse(presentation.updatedAt!))
            .toBeGreaterThan(TURN_STALL_MS)
    })

    it('does NOT seal a worker that is quiet for 6+ minutes while its adapter turn is open', () => {
        const startedAt = CLOCK_BASE + 3_600_000
        seedGeneratingAttempt(startedAt)
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: true, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        expect(emitted).toHaveLength(0)
        // Past the idle bound — the raised turn bound applies, still quiet.
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS + 5_000)
        expect(emitted).toHaveLength(0)
        // THE INCIDENT MOMENT: 367s of total silence, past the 360s turn bound.
        // Before the fix this emitted monitor:no_progress and the reconcile sealed
        // the task terminal `failed` while the worker was still working.
        instance.checkMeshWorkerStall(startedAt + QUIET_AT_FIRE)
        expect(emitted).toHaveLength(0)
        // ...and it keeps not firing right through to when the worker really finished.
        instance.checkMeshWorkerStall(startedAt + QUIET_AT_FINISH)
        expect(emitted).toHaveLength(0)
        // Well beyond the incident too: the veto is evidence-based, so it does not
        // expire on a clock the way a raised timeout would. Sampled just under the
        // STALE-ATTEMPT-AUTHORITY gate, which is the OUTER bound on this protection —
        // past 30 min the row loses `turn_reducer` authority entirely and the veto
        // becomes unreachable by construction (asserted in the next test).
        instance.checkMeshWorkerStall(startedAt + STALE_AUTHORITY_MAX_AGE_MS - 1_000)
        expect(emitted).toHaveLength(0)
    })

    // The veto is NOT unbounded, and that bound is deliberate: a `generating` row
    // whose adapter still claims an open turn after 30 minutes of total PTY silence
    // is indistinguishable from a wedged adapter that never cleared its turn scope.
    // The upstream staleness gate demotes such a row out of `turn_reducer` authority,
    // so the veto branch is skipped and the ordinary stall path fires. Pinning this
    // keeps the fix from being read as "generating sessions can never stall".
    it('does not protect a live turn forever — the 30min authority gate still ends it', () => {
        const startedAt = CLOCK_BASE + 7_200_000
        seedGeneratingAttempt(startedAt)
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: true, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        const lastProtectedTick = startedAt + STALE_AUTHORITY_MAX_AGE_MS - 1_000
        instance.checkMeshWorkerStall(lastProtectedTick)
        expect(emitted).toHaveLength(0) // still inside the gate — protected

        // Past the gate the row is demoted, so the `generating && turnActive` veto
        // never runs even though the adapter still reports an open turn. The veto
        // re-armed the anchor on its last protected tick, so the stall clock restarts
        // from there and the (still raised, turnActive) turn bound must elapse again —
        // this is the ordinary path, no longer vetoed.
        instance.checkMeshWorkerStall(lastProtectedTick + TURN_STALL_MS - 1)
        expect(emitted).toHaveLength(0)
        instance.checkMeshWorkerStall(lastProtectedTick + TURN_STALL_MS)
        expect(emitted).toHaveLength(1)
        expect(emitted[0].event).toBe('monitor:no_progress')
        expect(emitted[0].meshWorkerStall).toBe(true)
    })

    it('STILL fires for a genuinely wedged worker whose adapter turn has closed', () => {
        const startedAt = CLOCK_BASE + 10_800_000
        seedGeneratingAttempt(startedAt)
        // Same frozen `generating` row, but the adapter reports NO open turn — the
        // session is wedged rather than thinking. This must remain detectable.
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: false, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        expect(emitted).toHaveLength(0)
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS - 1)
        expect(emitted).toHaveLength(0)
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS)
        expect(emitted).toHaveLength(1)
        expect(emitted[0].event).toBe('monitor:no_progress')
        expect(emitted[0].meshWorkerStall).toBe(true)
    })

    it('resumes normal stall detection once the live turn actually ends', () => {
        const startedAt = CLOCK_BASE + 14_400_000
        seedGeneratingAttempt(startedAt)
        const { instance, emitted, adapter } = makeInstance({ lastOutputAt: startedAt, turnActive: true, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000)
        instance.checkMeshWorkerStall(startedAt + QUIET_AT_FIRE)
        expect(emitted).toHaveLength(0) // protected while live

        // The turn ends and the session wedges WITHOUT producing output. The veto is
        // gone with the open turn, so the worker is caught by the ordinary idle path.
        adapter.currentTurnScope = undefined
        const endedAt = startedAt + QUIET_AT_FINISH
        instance.checkMeshWorkerStall(endedAt)   // turn-end edge re-arms the anchor
        expect(emitted).toHaveLength(0)
        instance.checkMeshWorkerStall(endedAt + IDLE_STALL_MS - 1)
        expect(emitted).toHaveLength(0)
        instance.checkMeshWorkerStall(endedAt + IDLE_STALL_MS)
        expect(emitted).toHaveLength(1)
        expect(emitted[0].event).toBe('monitor:no_progress')
    })
})
