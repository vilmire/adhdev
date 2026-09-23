import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// CLOCK-LOWER-BOUND (2026-09-21) — regression for the stall watchdog's causal
// freshness exemption having NO lower bound on the age it computes.
//
// THE DEFECT (mesh-stall-watchdog.ts Stage 6):
//     now - causalEvidenceMs < threshold   → re-arm the anchor, suppress the stall
// `causalEvidenceMs` is `Date.parse(turn_attempts.updated_at)` — a FOREIGN
// timestamp, written by whichever process/machine owned the turn. Nothing forces
// it to precede our `now`: node clock skew, an NTP step, or a replicated row can
// all put it in the future. When it does, the left side goes NEGATIVE, the `<`
// comparison is unconditionally true, and the branch re-arms the anchor on EVERY
// tick — so a genuinely wedged worker is suppressed forever and never reported.
//
// ★WHY THE FIX IS A REJECTION AND NOT A CLAMP: `Math.max(0, age)` maps a future
// stamp onto age 0 — "created this very instant", the freshest value the
// exemption can be handed — which passes the gate even harder than the negative
// value did. A negative age is not fresh evidence; it is an untrustworthy clock.
// The tests below therefore assert the stall FIRES on a future stamp. A clamped
// implementation fails them exactly as the unfixed one does.
//
// THE SECOND SITE (mesh-turn-presentation.ts): the same class, and the watchdog
// explicitly depends on it — its comment argues a stranded row "is demoted out of
// turn_reducer authority before we get here". That demotion is
// isStaleTurnAttemptAuthority(), which computed age through a Math.max(0, …)
// helper. A future-dated in-flight row thus scored 0 forever, could never exceed
// the 30-minute bound, and so kept authority permanently — the same inversion,
// one layer up.
//
// NOTE ON SEEDING (C-W8): rows are seeded on the turn ledger's `turn_attempts`
// through `seedMeshAttempt`, whose `nowMs` stamps `updated_at`. Seeding at real
// wall-clock instead manufactures an accidental negative age — i.e. it would
// silently fake this very defect. Every seed below passes `nowMs` explicitly,
// and the first test ASSERTS the stamp it produced rather than trusting it.

const testTmpDir = join(tmpdir(), `adhdev-stall-clock-bound-test-${randomUUID().slice(0, 8)}`)
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
    resolveTurnAttemptRow,
    isStaleTurnAttemptAuthority,
    STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS,
} from '../../src/mesh/mesh-turn-presentation.js'

const IDLE_STALL_MS = 180_000

// Wall-clock scale on purpose: a synthetic epoch-1970 base reads as ~56 years old
// and is demoted by the staleness gate before the watchdog ever sees a stage,
// which would make every assertion here pass for the wrong reason.
const CLOCK_BASE = Date.parse('2026-09-21T09:00:00.000Z')

// How far ahead of `now` the row is stamped. Comfortably past any skew tolerance
// a correct implementation may allow, so the test pins the defect and not a
// boundary value.
const FUTURE_SKEW_MS = 3_600_000

afterAll(() => {
    try { rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('stall watchdog — causal freshness needs a lower bound on age', () => {
    let seq = 0
    let meshId: string
    let taskId: string
    let sessionId: string

    beforeEach(() => {
        seq += 1
        meshId = `mesh-clock-bound-${seq}`
        taskId = `task-clock-bound-${seq}`
        sessionId = `sess-clock-bound-${seq}`
    })

    /**
     * Drive a real attempt row to `stage` with `updated_at` stamped at `stampAt`.
     * `stampAt` is deliberately decoupled from the watchdog's clock so a caller can
     * place the row in the FUTURE relative to the ticks it then runs.
     */
    function seedAttempt(stage: 'generating' | 'consumed', stampAt: number): void {
        // C-W8: seeded on the turn ledger (`turn_attempts`), the table Stage 6 reads.
        seedMeshAttempt({ meshId, taskId, sessionId, providerType: 'codex-cli', stage, nowMs: stampAt })
    }

    function makeInstance(opts: { lastOutputAt: number; turnActive: boolean; startedAt: number }) {
        const emitted: any[] = []
        const instance = Object.create(CliProviderInstance.prototype) as any
        instance.instanceId = sessionId
        instance.type = 'codex-cli'
        instance.workingDir = '/work/repo'
        instance.providerSessionId = 'provider-sess-codex'
        instance.settings = { meshNodeFor: meshId, meshNodeId: 'node-1', meshActiveTaskId: taskId }
        instance.events = []
        instance.startedAt = opts.startedAt
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

    it('proves the setup: the seeded row really is stamped in the future, so age is NEGATIVE', () => {
        const observeAt = CLOCK_BASE
        const stampAt = observeAt + FUTURE_SKEW_MS
        seedAttempt('generating', stampAt)

        // Read the RAW row, upstream of the staleness gate. Asserting through
        // resolveSessionTurnPresentation() cannot work here: with site 2 fixed the
        // future-stamped row is correctly demoted to provider_fsm_fallback, whose
        // updatedAt is null — so the premise has to be pinned one layer down.
        const raw = resolveTurnAttemptRow({
            sessionId,
            legacyStatus: 'generating',
            providerType: 'codex-cli',
            surface: 'stall_watchdog',
            nowMs: observeAt,
        })
        // Guard against the seeding-clock trap (see the header note): assert the
        // stamp we actually produced rather than assuming the writer honoured it.
        expect(raw).not.toBeNull()
        expect(raw!.stage).toBe('generating')
        expect(Date.parse(raw!.updatedAt!)).toBe(stampAt)
        // This is the quantity the watchdog compares against its threshold.
        expect(observeAt - Date.parse(raw!.updatedAt!)).toBeLessThan(0)

        // And the fix's consequence, stated directly: such a row does not hold
        // reducer authority, so the Stage 6 clock branch is not even reachable.
        const presentation = resolveSessionTurnPresentation({
            sessionId,
            legacyStatus: 'generating',
            providerType: 'codex-cli',
            surface: 'stall_watchdog',
            nowMs: observeAt,
        })
        expect(presentation.authority).toBe('provider_fsm_fallback')
    })

    // ── THE DEFECT ITSELF ────────────────────────────────────────────────────
    // A wedged worker (adapter turn CLOSED, so the rc.23 generating&&turnActive
    // veto does not apply) whose attempt row carries a future `updated_at`.
    // Unfixed: `now - causalEvidenceMs` is negative → `< threshold` always true →
    // the anchor is re-armed on every tick and monitor:no_progress NEVER fires.
    it('FIRES for a wedged worker whose attempt row is stamped in the future (generating)', () => {
        const startedAt = CLOCK_BASE + 3_600_000
        seedAttempt('generating', startedAt + FUTURE_SKEW_MS)
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: false, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        expect(emitted).toHaveLength(0)
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS - 1)
        expect(emitted).toHaveLength(0)
        // The stall bound elapses. A future stamp must NOT buy the session an
        // exemption — the clock signal is untrustworthy, not fresh.
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS)
        expect(emitted).toHaveLength(1)
        expect(emitted[0].event).toBe('monitor:no_progress')
        expect(emitted[0].meshWorkerStall).toBe(true)
    })

    // The `consumed` stage takes the same branch and has no turnActive veto at all,
    // so it is the purest expression of the defect.
    it('FIRES for a wedged worker whose attempt row is stamped in the future (consumed)', () => {
        const startedAt = CLOCK_BASE + 7_200_000
        seedAttempt('consumed', startedAt + FUTURE_SKEW_MS)
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: false, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS)
        expect(emitted).toHaveLength(1)
        expect(emitted[0].event).toBe('monitor:no_progress')
    })

    // Suppression is not merely LATE under the defect — it is unbounded. Ticking far
    // past every threshold in the module pins that a clamp-style "treat it as age 0"
    // fix (which would also never fire) cannot pass.
    it('does not suppress a future-stamped row indefinitely across many ticks', () => {
        const startedAt = CLOCK_BASE + 10_800_000
        seedAttempt('generating', startedAt + FUTURE_SKEW_MS)
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: false, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        for (let i = 1; i <= 12; i += 1) {
            instance.checkMeshWorkerStall(startedAt + i * IDLE_STALL_MS)
        }
        expect(emitted.length).toBeGreaterThanOrEqual(1)
        expect(emitted[0].event).toBe('monitor:no_progress')
    })

    // ── CONTROL GROUP: the exemption must still work for SANE clocks ─────────
    // If this went red the fix would have broken Stage 6 rather than bounded it.
    it('CONTROL — a past-stamped, genuinely fresh row still earns the exemption', () => {
        const startedAt = CLOCK_BASE + 14_400_000
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: false, startedAt })

        // Row stamped 10s before the tick that crosses the stall bound: a real,
        // non-negative, well-under-threshold age.
        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        seedAttempt('generating', startedAt + IDLE_STALL_MS - 10_000)
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS)
        expect(emitted).toHaveLength(0)
    })

    // The other side of the same control: a past-stamped row that is genuinely OLD
    // gets no exemption and fires. Pins that the exemption is bounded above too.
    it('CONTROL — a past-stamped, stale row is not exempt and still fires', () => {
        const startedAt = CLOCK_BASE + 18_000_000
        seedAttempt('generating', startedAt - IDLE_STALL_MS)
        const { instance, emitted } = makeInstance({ lastOutputAt: startedAt, turnActive: false, startedAt })

        instance.checkMeshWorkerStall(startedAt + 1_000) // arm
        instance.checkMeshWorkerStall(startedAt + IDLE_STALL_MS)
        expect(emitted).toHaveLength(1)
        expect(emitted[0].event).toBe('monitor:no_progress')
    })
})

// ── SITE 2: the upstream staleness gate the watchdog leans on ───────────────
describe('stale-attempt-authority gate — a future updated_at is untrustworthy, not fresh', () => {
    function row(stage: string, updatedAt: string) {
        return {
            meshId: 'mesh-gate',
            taskId: 'task-gate',
            attemptId: 'attempt-gate',
            sessionId: 'sess-gate',
            providerType: 'codex-cli',
            stage,
            updatedAt,
            terminalOutcome: null,
            terminalReason: null,
        } as any
    }

    it('demotes an in-flight row stamped in the future', () => {
        const now = CLOCK_BASE
        // Unfixed (Math.max(0, …)): age reads 0 — maximally fresh — so the row could
        // NEVER exceed the 30-minute bound and held authority permanently.
        expect(isStaleTurnAttemptAuthority(row('generating', new Date(now + FUTURE_SKEW_MS).toISOString()), now)).toBe(true)
        expect(isStaleTurnAttemptAuthority(row('consumed', new Date(now + FUTURE_SKEW_MS).toISOString()), now)).toBe(true)
    })

    it('CONTROL — tolerates sub-second write/read jitter without demoting', () => {
        const now = CLOCK_BASE
        expect(isStaleTurnAttemptAuthority(row('generating', new Date(now + 250).toISOString()), now)).toBe(false)
    })

    it('CONTROL — a recent past-stamped row keeps authority; an old one loses it', () => {
        const now = CLOCK_BASE
        expect(isStaleTurnAttemptAuthority(row('generating', new Date(now - 60_000).toISOString()), now)).toBe(false)
        expect(isStaleTurnAttemptAuthority(
            row('generating', new Date(now - STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS - 1_000).toISOString()), now,
        )).toBe(true)
    })

    it('CONTROL — long-lived stages are exempt from the gate regardless of stamp', () => {
        const now = CLOCK_BASE
        for (const stage of ['waiting_approval', 'waiting_choice', 'finalizing']) {
            expect(isStaleTurnAttemptAuthority(row(stage, new Date(now + FUTURE_SKEW_MS).toISOString()), now)).toBe(false)
        }
    })
})
