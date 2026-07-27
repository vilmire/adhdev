import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { CliStateEngine } from '../../src/cli-adapters/cli-state-engine.js'
import { CliScriptRunner } from '../../src/cli-adapters/cli-script-runner.js'
import type { CliTransportAccess, CliBufferSnapshot, CliStateEngineCallbacks } from '../../src/cli-adapters/cli-state-engine.js'
import type { CliProviderModule } from '../../src/cli-adapters/provider-cli-shared.js'

// RC17-APPROVAL-NO-MODAL regression.
//
// Live evidence (debug bundle chat-debug-20260727T023205803Z-8c5b3b1a-...-949e1ad0.json,
// Claude session 8c5b3b1a-6cdc-4688-90ad-ab44c1babfe5): the raw PTY never showed an
// actionable approval modal — command/spinner output only — yet the session fired
// agent:waiting_approval 5+ times.
//
// Root cause: cli-state-engine.ts's evaluateSettled() took `(session as any).activeModal
// ?? session.modal ?? null` from the provider's own parseSession/detectStatus output and
// handed it straight to applyWaitingApproval() as `ctx.modal`, with no check that
// modal.buttons was non-empty. applyWaitingApproval's ONLY button-validity guard lives in
// its `!modal` branch (warn + cooldown-gated recovery) — a modal object that is merely
// non-null but carries an empty/blank buttons array skipped that branch entirely, got
// latched into `this.activeModal`, flipped `this.currentStatus` to 'waiting_approval', and
// fired onStatusChange — from which cli-provider-instance.ts's detectStatusTransition
// unconditionally pushes agent:waiting_approval (cli-provider-instance.ts ~4465-4517) with
// no actionable-modal check of its own either.
//
// The fix normalizes `modal` at the point it enters the FSM: a buttons-empty modal is
// treated identically to no modal, reusing the same hasNonEmptyCliModalButtons predicate
// already applied elsewhere (resolveModal, stabilizeFlappingApprovalStatus).

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
    }
}

function makeProvider(overrides: Partial<CliProviderModule> = {}): CliProviderModule {
    return {
        type: 'test-cli',
        name: 'Test CLI',
        category: 'cli',
        binary: 'test',
        spawn: { command: 'test', args: [], shell: false, env: {} },
        ...overrides,
    } as CliProviderModule
}

const DEFAULT_TIMEOUTS: Required<NonNullable<CliProviderModule['timeouts']>> = {
    ptyFlush: 100,
    dialogAccept: 500,
    approvalCooldown: 2000,
    generatingIdle: 30000,
    idleFinish: 800,
    idleFinishConfirm: 1200,
    statusActivityHold: 2000,
    maxResponse: 300000,
    shutdownGrace: 4000,
    outputSettle: 500,
}

function buildEngine(
    providerOverrides: Partial<CliProviderModule> = {},
    transportOverrides: Partial<CliTransportAccess> = {},
) {
    const transport: CliTransportAccess & { written: string[]; flushed: number } = {
        written: [],
        flushed: 0,
        getSnapshot: () => makeSnap(),
        writeRaw: (data) => { transport.written.push(String(data)) },
        getApprovalKeyForIndex: () => undefined,
        flushOutboundQueue: () => { transport.flushed++ },
        isAlive: () => true,
        ...transportOverrides,
    }

    const callbacks = {
        onStatusChange: vi.fn(),
        onApplyParsedSession: vi.fn(),
        onTurnCompleted: vi.fn(),
    }

    const runner = new CliScriptRunner()

    const engine = new CliStateEngine(
        makeProvider(providerOverrides),
        runner,
        transport,
        callbacks as CliStateEngineCallbacks,
        DEFAULT_TIMEOUTS,
    )

    return { engine, transport, callbacks, runner }
}

describe('CliStateEngine — RC17 approval requires an actionable (non-empty-buttons) modal', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('does not enter waiting_approval when parseSession reports an empty-buttons modal (half-rendered frame)', () => {
        const { engine, transport, callbacks } = buildEngine()
        transport.getSnapshot = () => makeSnap({ screenText: 'Running Bash command...' })
        transport.runParseSession = () => ({
            status: 'waiting_approval',
            messages: [],
            // Half-rendered approval frame: message present, buttons not yet painted.
            activeModal: { message: 'Allow Bash command?', buttons: [] },
        })
        engine.isWaitingForResponse = true
        engine.currentTurnScope = { prompt: 'do the thing' } as any

        engine.evaluateSettled(transport.getSnapshot())

        expect(engine.currentStatus).not.toBe('waiting_approval')
        expect(engine.activeModal).toBe(null)
        expect(callbacks.onStatusChange).not.toHaveBeenCalled()
    })

    it('does not enter waiting_approval when the modal has no buttons array at all', () => {
        const { engine, transport, callbacks } = buildEngine()
        transport.getSnapshot = () => makeSnap({ screenText: 'spinner tick' })
        transport.runParseSession = () => ({
            status: 'waiting_approval',
            messages: [],
            activeModal: { message: 'Allow Bash command?' } as any,
        })
        engine.isWaitingForResponse = true
        engine.currentTurnScope = { prompt: 'do the thing' } as any

        engine.evaluateSettled(transport.getSnapshot())

        expect(engine.currentStatus).not.toBe('waiting_approval')
        expect(engine.activeModal).toBe(null)
        expect(callbacks.onStatusChange).not.toHaveBeenCalled()
    })

    it('does not fire repeatedly across several settle passes that keep re-parsing an empty-buttons modal', () => {
        const { engine, transport, callbacks } = buildEngine()
        transport.getSnapshot = () => makeSnap({ screenText: 'Running Bash command...' })
        transport.runParseSession = () => ({
            status: 'waiting_approval',
            messages: [],
            activeModal: { message: 'Allow Bash command?', buttons: [] },
        })
        engine.isWaitingForResponse = true
        engine.currentTurnScope = { prompt: 'do the thing' } as any

        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(1000)
            engine.evaluateSettled(transport.getSnapshot())
        }

        expect(engine.currentStatus).not.toBe('waiting_approval')
        expect(engine.activeModal).toBe(null)
        expect(callbacks.onStatusChange).not.toHaveBeenCalled()
    })

    it('still enters waiting_approval once a LATER settle pass observes a genuinely actionable modal (no regression to real approvals)', () => {
        const { engine, transport, callbacks } = buildEngine()
        transport.getApprovalKeyForIndex = () => '\r'
        transport.getSnapshot = () => makeSnap({ screenText: 'Running Bash command...' })
        transport.runParseSession = () => ({
            status: 'waiting_approval',
            messages: [],
            activeModal: { message: 'Allow Bash command?', buttons: [] },
        })
        engine.isWaitingForResponse = true
        engine.currentTurnScope = { prompt: 'do the thing' } as any
        engine.evaluateSettled(transport.getSnapshot())
        expect(engine.currentStatus).not.toBe('waiting_approval')

        // The frame finishes rendering: buttons are now present.
        transport.getSnapshot = () => makeSnap({ screenText: 'Allow Bash command?\n1. Yes' })
        transport.runParseSession = () => ({
            status: 'waiting_approval',
            messages: [],
            activeModal: { message: 'Allow Bash command?', buttons: ['Yes'] },
        })
        engine.evaluateSettled(transport.getSnapshot())

        expect(engine.currentStatus).toBe('waiting_approval')
        expect(engine.activeModal).toEqual({ message: 'Allow Bash command?', buttons: ['Yes'] })
        expect(callbacks.onStatusChange).toHaveBeenCalled()
    })
})
