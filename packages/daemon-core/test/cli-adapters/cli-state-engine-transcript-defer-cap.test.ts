import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { CliStateEngine } from '../../src/cli-adapters/cli-state-engine.js'
import { CliScriptRunner } from '../../src/cli-adapters/cli-script-runner.js'
import type { CliTransportAccess, CliBufferSnapshot, CliStateEngineCallbacks } from '../../src/cli-adapters/cli-state-engine.js'
import type { CliProviderModule } from '../../src/cli-adapters/provider-cli-shared.js'

// FLOOR-CLASS-TRANSCRIPT-DEFER-CAP regression.
//
// Verified live incidents: a codex-cli session showed its final assistant message and
// an idle `›` PTY prompt for 12m53s while read_chat/mesh_status kept reporting
// generating with terminalAt=null for ~70m; a kimi task stayed stale-generating ~48m.
// Root cause: shouldDeferFinishForTranscript (floor class) returns true whenever the
// PTY parse lacks a current-turn final standard assistant — permanently true when the
// final answer scrolled outside the live-frame-tail while the authoritative native
// transcript (JSONL) HAS it — and both call sites re-armed the idle timeout with NO
// bound (rescheduleTranscriptFinishCheck), so the session wedged in `generating`
// forever and every downstream rescue gate (which requires an `idle` read) never fired.
//
// The fix under test: the defer chain is bounded (MAX_TRANSCRIPT_FINISH_DEFERS = 3
// consecutive defers AND TRANSCRIPT_FINISH_DEFER_CAP_MS = 30s elapsed, anchored on
// responseEpoch). At/over the cap the finish is allowed ONLY when (a) the engine is
// still genuinely generating with no actionable approval, (b) screen/interaction
// evidence is quiet, and (c) the native transcript proves a FRESH current-turn final
// assistant via the hasFreshNativeFinalAssistantForCurrentTurn callback. Any guard
// miss fails CLOSED — no finish, no further re-arm.

// ─── Helpers (mirrors cli-state-engine.test.ts) ─────────────────────────────

function makeSnap(overrides: Partial<CliBufferSnapshot> = {}): CliBufferSnapshot {
    const now = Date.now()
    return {
        accumulatedBuffer: '',
        accumulatedRawBuffer: '',
        recentOutputBuffer: '',
        responseBuffer: '',
        screenText: '',
        parseScreenText: '',
        workingDir: '/tmp/test',
        runtimeSettings: {},
        lastOutputAt: now,
        lastNonEmptyOutputAt: now,
        lastScreenChangeAt: now,
        spawnedAt: now - 5000,
        rawBufferVersion: 1,
        isWaitingForResponse: false,
        ...overrides,
    } as CliBufferSnapshot
}

// Floor-class provider minimal shape the profile resolver accepts:
// requiresFinalAssistantBeforeIdle && !holdCompletionForTranscript ⇒ timing 'floor',
// plus a native-source-ish nativeHistory block so the class is 'native-source'.
function makeFloorProvider(): CliProviderModule {
    return {
        type: 'floor-cli',
        name: 'Floor CLI',
        category: 'cli',
        binary: 'floor',
        spawn: { command: 'floor', args: [], shell: false, env: {} },
        requiresFinalAssistantBeforeIdle: true,
        nativeHistory: { mode: 'native-source' },
    } as unknown as CliProviderModule
}

const DEFAULT_TIMEOUTS: Required<NonNullable<CliProviderModule['timeouts']>> = {
    ptyFlush: 100,
    dialogAccept: 500,
    approvalCooldown: 2000,
    // 5s so a full defer cycle (generatingIdle + idleFinishConfirm = 6.2s) keeps the
    // whole 3-defer chain (~18.6s) INSIDE the 30s elapsed cap — the tests then trip
    // the COUNT bound on the 4th evaluation, not the elapsed bound after one defer.
    generatingIdle: 5000,
    idleFinish: 800,
    idleFinishConfirm: 1200,
    statusActivityHold: 2000,
    maxResponse: 300000,
    shutdownGrace: 4000,
    outputSettle: 500,
}

const MAX_DEFERS = 3 // mirrors MAX_TRANSCRIPT_FINISH_DEFERS in the engine

interface Harness {
    engine: CliStateEngine
    callbacks: {
        onStatusChange: ReturnType<typeof vi.fn>
        onApplyParsedSession: ReturnType<typeof vi.fn>
        onTurnCompleted: ReturnType<typeof vi.fn>
    }
    /** Mutable snapshot timestamps — tests flip these mid-flight for the guards. */
    snapState: { lastOutputAt: number; lastNonEmptyOutputAt: number; lastScreenChangeAt: number }
    startedAt: number
}

/**
 * Build an engine already exhibiting the wedge shape: a floor-class provider whose
 * PTY parse shows the user message but NO current-turn final assistant (the final
 * answer is outside the live-frame-tail). All snapshot timestamps are pinned to the
 * harness start so the screen-quiet / recent-activity guards pass until a test
 * explicitly freshens them.
 */
function buildFloorHarness(opts: { nativeProbe?: (() => boolean) | 'absent' } = {}): Harness {
    const startedAt = Date.now()
    const snapState = {
        lastOutputAt: startedAt,
        lastNonEmptyOutputAt: startedAt,
        lastScreenChangeAt: startedAt,
    }

    const transport: CliTransportAccess = {
        getSnapshot: () => makeSnap(snapState),
        writeRaw: () => {},
        getApprovalKeyForIndex: () => undefined,
        flushOutboundQueue: () => {},
        isAlive: () => true,
        // No positive generating cue: shouldDeferIdleTimeoutFinish must not re-route.
        runDetectStatus: () => null,
        // The wedge parse: idle PTY with the user message but no current-turn
        // final standard assistant after it.
        runParseSession: () => ({
            status: 'idle',
            messages: [{ role: 'user', content: 'do it' }],
            activeModal: null,
        }) as any,
    }

    const callbacks: Record<string, unknown> = {
        onStatusChange: vi.fn(),
        onApplyParsedSession: vi.fn(),
        onTurnCompleted: vi.fn(),
    }
    if (opts.nativeProbe !== 'absent') {
        callbacks.hasFreshNativeFinalAssistantForCurrentTurn = () => opts.nativeProbe?.() === true
    }

    const engine = new CliStateEngine(
        makeFloorProvider(),
        new CliScriptRunner(),
        transport,
        callbacks as unknown as CliStateEngineCallbacks,
        DEFAULT_TIMEOUTS,
    )
    return { engine, callbacks: callbacks as unknown as Harness['callbacks'], snapState, startedAt }
}

/** Start a turn and run the first settled evaluation (arms the hold-generating timeout). */
function startWedgedTurn(engine: CliStateEngine): void {
    engine.onTurnStarted({ prompt: 'do it', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 })
    engine.evaluateSettled((engine as any).transport.getSnapshot())
    expect(engine.currentStatus).toBe('generating')
}

/**
 * Drive ONE full defer cycle deterministically:
 *   +generatingIdle(30s) → hold timeout fires → finishResponse → defer decision
 *   +idleFinishConfirm(1.2s) → reschedule fires → evaluateSettled → re-arm hold timeout
 * After the call the engine sits armed for the NEXT hold-timeout fire.
 */
function advanceDeferCycle(): void {
    vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
    vi.advanceTimersByTime(DEFAULT_TIMEOUTS.idleFinishConfirm)
}

function deferredTraces(engine: CliStateEngine) {
    return engine.getTraceEntries().filter(e => e.type === 'transcript_finish_deferred')
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CliStateEngine floor-class transcript finish defer cap', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('defers at most MAX_TRANSCRIPT_FINISH_DEFERS times, then escapes exactly once when the native transcript proves the current-turn final assistant', () => {
        const h = buildFloorHarness({ nativeProbe: () => true })
        startWedgedTurn(h.engine)

        // Three bounded defers — the unbounded loop would continue past this forever.
        for (let i = 1; i <= MAX_DEFERS; i++) {
            advanceDeferCycle()
            expect(deferredTraces(h.engine)).toHaveLength(i)
            expect(h.callbacks.onTurnCompleted).not.toHaveBeenCalled()
            expect(h.engine.currentStatus).toBe('generating')
        }

        // 4th evaluation: cap tripped, all escape guards hold → bounded escape finish.
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        expect(h.callbacks.onTurnCompleted).toHaveBeenCalledTimes(1)
        expect(h.engine.getTraceEntries().some(e => e.type === 'transcript_finish_defer_cap_escape')).toBe(true)

        // The generating → idle commit lands after the 2s idle-confirmation grace — exactly once.
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle) // far past the grace
        expect(h.engine.currentStatus).toBe('idle')
        expect(h.engine.getStatusHistory().filter(s => s.status === 'idle')).toHaveLength(1)

        // No duplicate completion / no further defer activity after far-future advancement.
        vi.advanceTimersByTime(10 * 60_000)
        expect(h.callbacks.onTurnCompleted).toHaveBeenCalledTimes(1)
        expect(h.engine.getStatusHistory().filter(s => s.status === 'idle')).toHaveLength(1)
        expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)
    })

    it('fails closed at the cap while interaction evidence is fresh (output still flowing)', () => {
        const h = buildFloorHarness({ nativeProbe: () => true })
        startWedgedTurn(h.engine)
        for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()
        expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)

        // Screen stays quiet (the hold-timeout's own quiet gate passes) but OUTPUT is
        // fresh AT FIRE TIME — hasRecentInteractiveActivity trips the escape's
        // screen/interaction guard. Freshen only 100ms before the timer fires;
        // freshening a full generatingIdle earlier would let the output age past
        // statusActivityHold and the guard would (correctly) pass.
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle - 100)
        h.snapState.lastNonEmptyOutputAt = Date.now()
        vi.advanceTimersByTime(100)

        expect(h.callbacks.onTurnCompleted).not.toHaveBeenCalled()
        expect(h.engine.currentStatus).toBe('generating')
        const failClosed = h.engine.getTraceEntries().filter(e => e.type === 'transcript_finish_defer_cap_fail_closed')
        expect(failClosed.length).toBeGreaterThanOrEqual(1)
        expect(failClosed.at(-1)?.payload?.guard).toBe('screen_active')

        // Bounded: the defer CHAIN does not re-arm (still exactly MAX_DEFERS).
        // (INFINITE-GENERATING) It used to also assert the turn NEVER completes. That was
        // the wedge, not a contract: the FSM sat dormant with currentTurnScope open forever
        // and the mesh slot stayed occupied. The blocked-finish watchdog now re-evaluates
        // once at the hard cap, so a turn whose screen finally quiesces DOES complete.
        // The fail-closed guarantee that still holds is asserted above (no completion at the
        // moment the guard trips); permanence is not part of it.
        vi.advanceTimersByTime(10 * 60_000)
        expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)
        expect((h.engine as any).currentTurnScope, 'turn scope must not stay open forever').toBeNull()
    })

    it('never force-idles waiting_choice / waiting_approval at the cap', () => {
        for (const blockedStatus of ['waiting_choice', 'waiting_approval'] as const) {
            const h = buildFloorHarness({ nativeProbe: () => true })
            startWedgedTurn(h.engine)
            for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()
            expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)

            // The CLI surfaces a blocking state before the cap evaluation fires.
            h.engine.currentStatus = blockedStatus
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)

            expect(h.callbacks.onTurnCompleted).not.toHaveBeenCalled()
            expect(h.engine.currentStatus).toBe(blockedStatus)
            const failClosed = h.engine.getTraceEntries().filter(e => e.type === 'transcript_finish_defer_cap_fail_closed')
            expect(failClosed.length).toBeGreaterThanOrEqual(1)
            expect(failClosed.at(-1)?.payload?.guard).toBe('status')
        }
    })

    it('resets the defer chain on a newer attempt (epoch-anchored) — no finish attributable to the old chain', () => {
        const h = buildFloorHarness({ nativeProbe: () => true })
        startWedgedTurn(h.engine)
        // Two defers in epoch N, then a NEW turn starts before the cap.
        for (let i = 0; i < 2; i++) advanceDeferCycle()
        expect(deferredTraces(h.engine)).toHaveLength(2)

        const firstEpoch = h.engine.responseEpoch
        startWedgedTurn(h.engine)
        expect(h.engine.responseEpoch).toBe(firstEpoch + 1)

        // The new epoch defers a FULL fresh chain — if the old counters had leaked,
        // the cap would trip after only one more defer and force a finish here.
        for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()
        expect(deferredTraces(h.engine)).toHaveLength(2 + MAX_DEFERS)
        expect(h.callbacks.onTurnCompleted).not.toHaveBeenCalled()
        expect(h.engine.currentStatus).toBe('generating')

        // Only the NEW epoch's own 4th evaluation escapes (native proof holds).
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        expect(h.callbacks.onTurnCompleted).toHaveBeenCalledTimes(1)
        expect(h.engine.currentStatus).toBe('idle')
    })

    it('fails closed at the cap when the native-proof callback is absent — no forced idle, no further re-arm', () => {
        const h = buildFloorHarness({ nativeProbe: 'absent' })
        startWedgedTurn(h.engine)
        for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()
        expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)

        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        expect(h.callbacks.onTurnCompleted).not.toHaveBeenCalled()
        expect(h.engine.currentStatus).toBe('generating')
        const failClosed = h.engine.getTraceEntries().filter(e => e.type === 'transcript_finish_defer_cap_fail_closed')
        expect(failClosed.length).toBeGreaterThanOrEqual(1)
        expect(failClosed.at(-1)?.payload?.guard).toBe('native_proof')

        // Bounded: no additional defers. (INFINITE-GENERATING) The turn no longer stays
        // generating forever — see the note on the screen_active case above; the watchdog
        // releases a turn whose guards can never be satisfied rather than wedging it.
        vi.advanceTimersByTime(10 * 60_000)
        expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)
        expect((h.engine as any).currentTurnScope, 'turn scope must not stay open forever').toBeNull()
    })

    it('fails closed at the cap when the native-proof callback returns false', () => {
        const h = buildFloorHarness({ nativeProbe: () => false })
        startWedgedTurn(h.engine)
        for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()

        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        expect(h.callbacks.onTurnCompleted).not.toHaveBeenCalled()
        expect(h.engine.currentStatus).toBe('generating')
        const failClosed = h.engine.getTraceEntries().filter(e => e.type === 'transcript_finish_defer_cap_fail_closed')
        expect(failClosed.at(-1)?.payload?.guard).toBe('native_proof')

        // (INFINITE-GENERATING) Bounded: no additional defers, and the turn scope is
        // eventually released by the watchdog rather than pinned open forever. The
        // fail-closed guarantee at the moment the guard trips is asserted above.
        vi.advanceTimersByTime(10 * 60_000)
        expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)
        expect((h.engine as any).currentTurnScope, 'turn scope must not stay open forever').toBeNull()
    })

    it('a fresh turn after one bounded finish starts with clean deferral state (epoch-anchored)', () => {
        // Turn 1 escapes at the cap and completes.
        let nativeProven = true
        const h = buildFloorHarness({ nativeProbe: () => nativeProven })
        startWedgedTurn(h.engine)
        for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        expect(h.engine.currentStatus).toBe('idle')
        expect(h.callbacks.onTurnCompleted).toHaveBeenCalledTimes(1)
        expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS)

        // Turn 2 (native proof now FALSE) must defer a full fresh chain before any
        // fail-closed — proving turn 1's tripped cap did not leak across the boundary.
        nativeProven = false
        startWedgedTurn(h.engine)
        for (let i = 0; i < MAX_DEFERS; i++) {
            advanceDeferCycle()
            expect(deferredTraces(h.engine)).toHaveLength(MAX_DEFERS + i + 1)
            expect(h.callbacks.onTurnCompleted).toHaveBeenCalledTimes(1)
        }
        vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
        // Turn 2 fails closed (native proof false), turn 1's completion stays singular.
        expect(h.callbacks.onTurnCompleted).toHaveBeenCalledTimes(1)
        expect(h.engine.currentStatus).toBe('generating')
        expect(h.engine.getStatusHistory().filter(s => s.status === 'idle')).toHaveLength(1)
        vi.advanceTimersByTime(10 * 60_000)
        expect(deferredTraces(h.engine)).toHaveLength(2 * MAX_DEFERS)
    })
})
