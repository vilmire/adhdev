import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { CliStateEngine } from '../../src/cli-adapters/cli-state-engine.js'
import { CliScriptRunner } from '../../src/cli-adapters/cli-script-runner.js'
import type { CliTransportAccess, CliBufferSnapshot, CliStateEngineCallbacks } from '../../src/cli-adapters/cli-state-engine.js'
import type { CliProviderModule } from '../../src/cli-adapters/provider-cli-shared.js'

// INFINITE-GENERATING (adapter side).
//
// deferOrEscalateTranscriptFinish's fail-closed 'blocked' verdict makes finishResponse
// early-return WITHOUT resetActiveTurnState(), so currentTurnScope stays set and
// isWaitingForResponse stays true forever. The completion engine's terminal-block hard
// cap cannot rescue this: that cap makes the ENGINE emit a completion, but it cannot
// reach into this adapter FSM, so the session stays generating and the next turn starts
// holding a stale open scope.
//
// The live killer is escape guard (b): a provider painting COSMETIC PTY output (spinner
// frames, token counters, status bars) never satisfies hasScreenBeenQuietForIdle, so the
// guard stays false and the tripped cap re-blocks on every single evaluation, forever.
//
// Fix under test: TRANSCRIPT_FINISH_BLOCKED_HARD_CAP_MS (5min) — past that bound guards
// (b)/(c) escape to 'proceed' so the turn closes and the adapter FSM is restored. Guard
// (a) is deliberately excluded: force-idling an approval state would discard a real
// pending user decision.

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

/** codex-cli shape: requiresFinalAssistantBeforeIdle ⇒ timing 'floor', native-source class. */
function makeFloorProvider(): CliProviderModule {
    return {
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        binary: 'codex',
        spawn: { command: 'codex', args: [], shell: false, env: {} },
        requiresFinalAssistantBeforeIdle: true,
        nativeHistory: { mode: 'native-source' },
    } as unknown as CliProviderModule
}

/** antigravity-cli shape: holdCompletionForTranscript ⇒ timing 'hold'. */
function makeHoldProvider(): CliProviderModule {
    return {
        type: 'antigravity-cli',
        name: 'Antigravity CLI',
        category: 'cli',
        binary: 'antigravity',
        spawn: { command: 'antigravity', args: [], shell: false, env: {} },
        holdCompletionForTranscript: true,
        nativeHistory: { mode: 'native-source' },
    } as unknown as CliProviderModule
}

/** claude-cli shape: requiresFinalAssistantBeforeIdle false ⇒ timing 'immediate'. */
function makeImmediateProvider(): CliProviderModule {
    return {
        type: 'claude-cli',
        name: 'Claude CLI',
        category: 'cli',
        binary: 'claude',
        spawn: { command: 'claude', args: [], shell: false, env: {} },
        requiresFinalAssistantBeforeIdle: false,
        nativeHistory: { mode: 'native-source' },
    } as unknown as CliProviderModule
}

const DEFAULT_TIMEOUTS: Required<NonNullable<CliProviderModule['timeouts']>> = {
    ptyFlush: 100,
    dialogAccept: 500,
    approvalCooldown: 2000,
    generatingIdle: 5000,
    idleFinish: 800,
    idleFinishConfirm: 1200,
    statusActivityHold: 2000,
    maxResponse: 300000,
    shutdownGrace: 4000,
    outputSettle: 500,
}

const MAX_DEFERS = 3
const BLOCKED_HARD_CAP_MS = 5 * 60_000 // mirrors TRANSCRIPT_FINISH_BLOCKED_HARD_CAP_MS

interface Harness {
    engine: CliStateEngine
    callbacks: {
        onStatusChange: ReturnType<typeof vi.fn>
        onApplyParsedSession: ReturnType<typeof vi.fn>
        onTurnCompleted: ReturnType<typeof vi.fn>
    }
    snapState: { lastOutputAt: number; lastNonEmptyOutputAt: number; lastScreenChangeAt: number }
}

function buildHarness(provider: CliProviderModule, opts: { nativeProbe?: (() => boolean) | 'absent' } = {}): Harness {
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
        runDetectStatus: () => null,
        // The wedge parse: idle PTY, user message present, no current-turn final assistant.
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
        provider,
        new CliScriptRunner(),
        transport,
        callbacks as unknown as CliStateEngineCallbacks,
        DEFAULT_TIMEOUTS,
    )
    return { engine, callbacks: callbacks as unknown as Harness['callbacks'], snapState }
}

function startWedgedTurn(engine: CliStateEngine): void {
    engine.onTurnStarted({ prompt: 'do it', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 })
    engine.evaluateSettled((engine as any).transport.getSnapshot())
    expect(engine.currentStatus).toBe('generating')
}

function advanceDeferCycle(): void {
    vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle)
    vi.advanceTimersByTime(DEFAULT_TIMEOUTS.idleFinishConfirm)
}

/**
 * Advance `totalMs` while a cosmetic repainter keeps lastNonEmptyOutputAt fresh —
 * the live killer. Steps small enough that output never ages past statusActivityHold,
 * so hasRecentInteractiveActivity is true at EVERY timer fire.
 */
function advanceWithCosmeticRepaint(h: Harness, totalMs: number): void {
    const step = 500
    for (let elapsed = 0; elapsed < totalMs; elapsed += step) {
        vi.advanceTimersByTime(step)
        h.snapState.lastNonEmptyOutputAt = Date.now()
        h.snapState.lastScreenChangeAt = Date.now()
    }
}

const PROVIDERS: Array<{ name: string; make: () => CliProviderModule; timing: 'floor' | 'hold' | 'immediate' }> = [
    { name: 'codex-cli (floor)', make: makeFloorProvider, timing: 'floor' },
    { name: 'antigravity-cli (hold)', make: makeHoldProvider, timing: 'hold' },
    { name: 'claude-cli (immediate)', make: makeImmediateProvider, timing: 'immediate' },
]

describe('INFINITE-GENERATING: a permanently-blocked transcript finish releases at the hard cap', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    // ALL THREE providers must end with a closed turn scope under a permanent cosmetic
    // repainter. Only the FLOOR class routes through the transcript-defer chain at all
    // (shouldDeferFinishForTranscript returns false for hold/immediate by design,
    // cli-state-engine.ts:1863) — so hold/immediate are the CONTROL group here: they must
    // finish via the ordinary path and must never enter the blocked-wedge state. Asserting
    // the same escape trace for them would be asserting a path they cannot reach.
    for (const { name, make, timing } of PROVIDERS) {
        it(`${name}: cosmetic PTY repaints must not leave a stale open turn scope`, () => {
            const h = buildHarness(make(), { nativeProbe: () => true })
            startWedgedTurn(h.engine)
            for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()

            // Cosmetic repainter runs for well past the hard cap: while it runs,
            // hasRecentInteractiveActivity is legitimately true, so NOT escaping during
            // it is correct — the contract is that the wedge resolves once the noise stops.
            advanceWithCosmeticRepaint(h, BLOCKED_HARD_CAP_MS + 30_000)
            // Repainter stops (the process finally quiesces). Pre-fix this changed NOTHING:
            // the defer chain was exhausted and nothing was scheduled, so the FSM sat dormant
            // with currentTurnScope open forever. The watchdog is what makes this resolvable.
            vi.advanceTimersByTime(60_000)

            expect(h.callbacks.onTurnCompleted, `${name} never completed its turn`).toHaveBeenCalled()
            // The adapter FSM must be RESTORED — not merely a completion event emitted.
            expect((h.engine as any).currentTurnScope, `${name} left a stale open turn scope`).toBeNull()
            expect(h.engine.isWaitingForResponse, `${name} still waiting for response`).toBe(false)

            if (timing === 'floor') {
                // The wedge class: the rescue tick must have re-armed the exhausted chain.
                expect(
                    h.engine.getTraceEntries().some(e => e.type === 'transcript_finish_blocked_watchdog_armed'),
                    `${name} never armed the blocked-finish watchdog`,
                ).toBe(true);
            } else {
                expect(
                    h.engine.getTraceEntries().some(e => e.type === 'transcript_finish_blocked_watchdog_armed'),
                    `${name} unexpectedly needed the wedge rescue`,
                ).toBe(false);
                // Control: never enters the defer chain, so it must finish WITHOUT the rescue.
                expect(
                    h.engine.getTraceEntries().some(e => e.type === 'transcript_finish_deferred'),
                    `${name} unexpectedly entered the floor-class defer chain`,
                ).toBe(false);
            }
        })
    }

    it('releases even when the native-proof callback is absent entirely (guard (c) unsatisfiable)', () => {
        const h = buildHarness(makeFloorProvider(), { nativeProbe: 'absent' })
        startWedgedTurn(h.engine)
        for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()

        // Screen goes quiet, so guard (b) passes, but (c) can never be proven.
        vi.advanceTimersByTime(BLOCKED_HARD_CAP_MS + 30_000)

        expect(h.callbacks.onTurnCompleted).toHaveBeenCalled()
        expect((h.engine as any).currentTurnScope).toBeNull()
        const escapes = h.engine.getTraceEntries().filter(e => e.type === 'transcript_finish_blocked_hard_cap_escape')
        expect(escapes.length).toBeGreaterThanOrEqual(1)
        expect(escapes.at(-1)?.payload?.guard).toBe('native_proof')
    })

    it('still fails closed BEFORE the hard cap (the bounded-escape contract is preserved)', () => {
        const h = buildHarness(makeFloorProvider(), { nativeProbe: () => true })
        startWedgedTurn(h.engine)
        for (let i = 0; i < MAX_DEFERS; i++) advanceDeferCycle()

        // Well inside the hard cap with a live repainter: must NOT force-close yet.
        advanceWithCosmeticRepaint(h, 60_000)

        expect(h.callbacks.onTurnCompleted).not.toHaveBeenCalled()
        expect(h.engine.currentStatus).toBe('generating')
        expect(
            h.engine.getTraceEntries().some(e => e.type === 'transcript_finish_blocked_hard_cap_escape'),
        ).toBe(false)
    })
})
