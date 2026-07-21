import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { CliStateEngine } from '../../src/cli-adapters/cli-state-engine.js'
import { CliScriptRunner } from '../../src/cli-adapters/cli-script-runner.js'
import type { CliTransportAccess, CliBufferSnapshot, CliStateEngineCallbacks } from '../../src/cli-adapters/cli-state-engine.js'
import type { CliProviderModule } from '../../src/cli-adapters/provider-cli-shared.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

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

interface TestContext {
    engine: CliStateEngine
    transport: CliTransportAccess & {
        written: string[]
        flushed: number
    }
    callbacks: {
        onStatusChange: ReturnType<typeof vi.fn>
        onApplyParsedSession: ReturnType<typeof vi.fn>
        onTurnCompleted: ReturnType<typeof vi.fn>
    }
    runner: CliScriptRunner
}

function buildEngine(
    providerOverrides: Partial<CliProviderModule> = {},
    transportOverrides: Partial<CliTransportAccess> = {},
): TestContext {
    const written: string[] = []
    let flushed = 0

    const transport: CliTransportAccess & { written: string[]; flushed: number } = {
        written,
        flushed,
        getSnapshot: () => makeSnap(),
        writeRaw: (data) => { written.push(String(data)) },
        getApprovalKeyForIndex: () => undefined,
        flushOutboundQueue: () => { flushed++ },
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CliStateEngine', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    // ── Status transitions ──────────────────────────────────────────────────

    describe('setStatus', () => {
        it('transitions the current status', () => {
            const { engine } = buildEngine()
            engine.setStatus('generating')
            expect(engine.currentStatus).toBe('generating')
        })

        it('is a no-op when status is already the target', () => {
            const { engine, callbacks } = buildEngine()
            // setStatus does not call onStatusChange directly (that's done by applyXxx helpers)
            engine.setStatus('idle')
            engine.setStatus('idle') // second call — no change
            // Status should still be idle, not double-recorded
            const history = engine.getStatusHistory()
            const idleEntries = history.filter(h => h.status === 'idle')
            expect(idleEntries).toHaveLength(1)
        })

        it('records status in history', () => {
            const { engine } = buildEngine()
            engine.setStatus('generating', 'test_trigger')
            const history = engine.getStatusHistory()
            expect(history.at(-1)).toMatchObject({ status: 'generating', trigger: 'test_trigger' })
        })
    })

    // ── Lifecycle ───────────────────────────────────────────────────────────

    describe('onSpawnReady', () => {
        it('sets status to starting and resets trace', () => {
            const { engine } = buildEngine()
            engine.onSpawnReady()
            expect(engine.currentStatus).toBe('starting')
            // Trace session ID is assigned
            expect(engine.getTraceSessionId()).not.toBe('')
        })
    })

    describe('onPtyExit', () => {
        it('sets status to stopped and clears all timers', () => {
            const { engine } = buildEngine()
            engine.setStatus('generating')
            engine.scheduleSettle()
            engine.onPtyExit()
            expect(engine.currentStatus).toBe('stopped')
            // Timer should be cleared — advancing time does not trigger evaluateSettled
            vi.advanceTimersByTime(5000)
            expect(engine.currentStatus).toBe('stopped')
        })
    })

    // ── Turn lifecycle ───────────────────────────────────────────────────────

    describe('onTurnStarted / finishResponse', () => {
        it('onTurnStarted sets turn scope and waiting flag', () => {
            const { engine } = buildEngine()
            engine.onTurnStarted({
                prompt: 'hello',
                startedAt: Date.now(),
                bufferStart: 0,
                rawBufferStart: 0,
            })
            expect(engine.isWaitingForResponse).toBe(true)
            expect(engine.currentTurnScope?.prompt).toBe('hello')
        })

        it('finishResponse clears turn when parseSession returns standard assistant', () => {
            const { engine, transport, callbacks } = buildEngine()
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'hello' },
                    { role: 'assistant', kind: 'standard', content: 'hi back' },
                ],
                activeModal: null,
            }))
            engine.currentStatus = 'idle' as any
            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'hello',
                startedAt: Date.now() - 1000,
                bufferStart: 0,
                rawBufferStart: 0,
            }

            engine.finishResponse()

            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentTurnScope).toBe(null)
            expect(engine.currentStatus).toBe('idle')
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })

        it('finishResponse with requiresFinalAssistantBeforeIdle defers when only tool messages', () => {
            const { engine, transport } = buildEngine({ requiresFinalAssistantBeforeIdle: true })
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'do it' },
                    { role: 'assistant', kind: 'tool', content: 'tool call' },
                ],
                activeModal: null,
            }))
            engine.currentStatus = 'idle' as any
            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'do it',
                startedAt: Date.now() - 1000,
                bufferStart: 0,
                rawBufferStart: 0,
            }

            engine.finishResponse()

            // Should defer — still waiting, still generating
            expect(engine.isWaitingForResponse).toBe(true)
            expect(engine.currentTurnScope).not.toBe(null)
            expect(engine.currentStatus).toBe('generating')
        })

        it('finishResponse with requiresFinalAssistantBeforeIdle completes when standard assistant present', () => {
            const { engine, transport, callbacks } = buildEngine({ requiresFinalAssistantBeforeIdle: true })
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'do it' },
                    { role: 'assistant', kind: 'standard', content: 'Done.' },
                ],
                activeModal: null,
            }))
            engine.currentStatus = 'idle' as any
            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'do it',
                startedAt: Date.now() - 1000,
                bufferStart: 0,
                rawBufferStart: 0,
            }

            engine.finishResponse()

            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentStatus).toBe('idle')
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })

        it('finishResponse returns early when submitPending guard is active', () => {
            const { engine, callbacks } = buildEngine()
            // submitPendingUntil set to far future blocks finishResponse
            engine.submitPendingUntil = Date.now() + 30_000
            engine.isWaitingForResponse = true
            engine.finishResponse()
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })
    })

    // ── Kimi K3: send→generating promptness (Live Run B mirror) ─────────────
    //
    // Regression (observed live on kimi-code v0.28.1/K3, Kimi standalone probe
    // Run A/B): transcriptAuthority:'provider' providers always parse messages:[]
    // from the PTY (the provider owns the transcript), so shouldHoldGenerating's
    // fast-path exception can never release early and recent_activity_hold ends up
    // carrying the entire "is this turn generating" signal — but that fallback only
    // fires once a settle tick runs, which needs PTY output to schedule. Kimi K3's
    // silent "high" thinking effort left the dashboard looking idle for 12-20s after
    // send, and a fast yolo/tool-use turn that completed within one settle debounce
    // window went idle→idle with NO generating transition ever recorded at all
    // (Run B: single 'idle' statusHistory entry across the whole 120s tool-use turn).
    describe('onTurnStarted — immediate generating for transcriptAuthority:"provider"', () => {
        it('sets status to generating immediately on turn start (no PTY output needed)', () => {
            const { engine } = buildEngine({ transcriptAuthority: 'provider' })
            engine.onTurnStarted({ prompt: 'do the thing', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 })

            expect(engine.currentStatus).toBe('generating')
            const history = engine.getStatusHistory()
            expect(history.at(-1)).toMatchObject({ status: 'generating', trigger: 'turn_started' })
        })

        it('a turn that completes within one settle window still surfaces a generating transition before idle', () => {
            // Mirrors Run B: send a yolo tool-use turn, then immediately confirm
            // completion (no intervening PTY-driven evaluateSettled). Without the
            // turn_started promotion, statusHistory would jump straight from
            // 'idle' to 'idle' with the turn's generating phase never observed.
            const { engine, transport } = buildEngine({ transcriptAuthority: 'provider' })
            engine.setStatus('idle')

            engine.onTurnStarted({ prompt: 'write a file and run it', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 })
            expect(engine.currentStatus).toBe('generating')

            // Authoritative completion evidence arrives and finishes the turn —
            // the promotion above did not weaken or bypass real completion detection.
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'write a file and run it' },
                    { role: 'assistant', kind: 'standard', content: 'Done.', meta: {} },
                ],
                activeModal: null,
            }))
            engine.finishResponse()
            // finishResponse defers the actual generating→idle flip by
            // IDLE_CONFIRMATION_GRACE_MS (2s) so the dashboard keeps the
            // spinner through short paint-blip windows; advance past it.
            vi.advanceTimersByTime(2050)

            expect(engine.currentStatus).toBe('idle')
            const history = engine.getStatusHistory()
            expect(history.some(h => h.status === 'generating' && h.trigger === 'turn_started')).toBe(true)
        })

        it('does NOT immediately flip to generating for PTY-authoritative providers (no transcriptAuthority)', () => {
            // Scoped fix: providers whose spinner/settled-prompt script already
            // drives generating promptly from real PTY evidence are unaffected.
            const { engine } = buildEngine()
            const before = engine.currentStatus
            engine.onTurnStarted({ prompt: 'hi', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 })
            expect(engine.currentStatus).toBe(before)
        })

        it('does not override an already-active waiting_approval status', () => {
            const { engine } = buildEngine({ transcriptAuthority: 'provider' })
            engine.setStatus('waiting_approval', 'script_detect')
            engine.onTurnStarted({ prompt: 'hi', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 })
            expect(engine.currentStatus).toBe('waiting_approval')
        })
    })

    // ── Modal / approval ────────────────────────────────────────────────────

    describe('resolveModal', () => {
        it('sends approval key and transitions to generating', () => {
            const { engine, transport, callbacks } = buildEngine()
            engine.activeModal = { message: 'Approve?', buttons: ['Yes', 'No'] }
            engine.isWaitingForResponse = true
            engine.currentStatus = 'waiting_approval' as any

            // Provide a known approval key for button 0
            transport.getApprovalKeyForIndex = (idx) => idx === 0 ? '\r' : undefined

            engine.resolveModal(0)

            expect(engine.activeModal).toBe(null)
            expect(engine.currentStatus).toBe('generating')
            expect(transport.written).toContain('\r')
            expect(callbacks.onStatusChange).toHaveBeenCalled()
        })

        it('navigates by arrow key when no approval key mapping', () => {
            const { engine, transport } = buildEngine()
            engine.activeModal = { message: 'Pick one', buttons: ['A', 'B', 'C'] }
            engine.isWaitingForResponse = true

            // No approval key mapping
            transport.getApprovalKeyForIndex = () => undefined

            engine.resolveModal(2) // button index 2 → 2 down arrows + enter

            const joined = transport.written.join('')
            expect(joined).toContain('\x1B[B\x1B[B\r') // 2 down + enter
        })

        it('isApprovalRecentlyResolved returns true right after resolveModal', () => {
            const { engine, transport } = buildEngine()
            engine.activeModal = { message: 'OK?', buttons: ['OK'] }
            transport.getApprovalKeyForIndex = () => '\r'
            engine.resolveModal(0)
            expect(engine.isApprovalRecentlyResolved()).toBe(true)
        })

        it('isApprovalRecentlyResolved returns false after cooldown expires', () => {
            const { engine, transport } = buildEngine()
            engine.activeModal = { message: 'OK?', buttons: ['OK'] }
            transport.getApprovalKeyForIndex = () => '\r'
            engine.resolveModal(0)
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.approvalCooldown + 1)
            expect(engine.isApprovalRecentlyResolved()).toBe(false)
        })

        it('suppresses a duplicate write for the SAME approval entry re-observed within cooldown', () => {
            // Same approval re-detected across TUI paint flaps (no fresh FSM
            // entry, so approvalEntrySeq is unchanged) must NOT write twice.
            const { engine, transport } = buildEngine()
            transport.getApprovalKeyForIndex = () => '\r'
            engine.approvalEntrySeq = 1
            engine.activeModal = { message: 'Run command?', buttons: ['Yes'] }

            engine.resolveModal(0)
            expect(transport.written.filter((w) => w === '\r')).toHaveLength(1)

            // Re-observe the identical approval well within the cooldown window.
            // resolveModal would re-parse the same modal; emulate by restoring it.
            engine.activeModal = { message: 'Run command?', buttons: ['Yes'] }
            vi.advanceTimersByTime(200)
            engine.resolveModal(0)
            // Still only one write — the flap-repaint was correctly swallowed.
            expect(transport.written.filter((w) => w === '\r')).toHaveLength(1)
        })

        // ── Regression: consecutive approvals stuck under auto-approval ──────
        it('writes the key for consecutive distinct approvals that share message text within cooldown', () => {
            // Repro of the stuck-auto-approval bug: claude-cli presents two
            // back-to-back approvals whose modal message is identical. The old
            // message-equality cooldown swallowed the SECOND key write, leaving
            // that approval stuck unresolved despite auto-approval being on.
            const { engine, transport } = buildEngine()
            transport.getApprovalKeyForIndex = () => '\r'

            // ── Approval #1 (fresh FSM entry → seq 1) ──
            engine.approvalEntrySeq = 1
            engine.activeModal = { message: 'Allow Bash command?', buttons: ['Yes'] }
            engine.resolveModal(0)
            expect(engine.activeModal).toBe(null)
            expect(transport.written.filter((w) => w === '\r')).toHaveLength(1)

            // ── Approval #2 arrives immediately (well within approvalCooldown),
            //    SAME message text, but it is a genuinely new approval so the
            //    FSM bumped approvalEntrySeq on its fresh waiting_approval entry. ──
            vi.advanceTimersByTime(150)
            expect(150).toBeLessThan(DEFAULT_TIMEOUTS.approvalCooldown)
            engine.approvalEntrySeq = 2
            engine.activeModal = { message: 'Allow Bash command?', buttons: ['Yes'] }
            engine.setStatus('waiting_approval', 'script_detect')

            engine.resolveModal(0)

            // The second approval must be resolved too — NOT stuck.
            expect(engine.activeModal).toBe(null)
            expect(engine.currentStatus).toBe('generating')
            expect(transport.written.filter((w) => w === '\r')).toHaveLength(2)
        })

        it('applyWaitingApproval bumps approvalEntrySeq for each fresh distinct approval', () => {
            // The seq must actually advance through the real FSM entry path so
            // the signature/cooldown discriminator has a value to key off of.
            const { engine, transport } = buildEngine()
            transport.getApprovalKeyForIndex = () => '\r'
            transport.runParseApproval = () => null
            engine.isWaitingForResponse = true

            const evalApproval = (message: string) => {
                // Drive the settled-eval approval branch directly.
                ;(engine as any).applyWaitingApproval({ modal: { message, buttons: ['Yes'] } })
            }

            evalApproval('Allow Bash command?')
            const seqAfterFirst = engine.approvalEntrySeq
            expect(seqAfterFirst).toBeGreaterThan(0)

            // Resolve #1, then a brand new approval (same text) enters the FSM.
            engine.resolveModal(0)
            evalApproval('Allow Bash command?')
            expect(engine.approvalEntrySeq).toBeGreaterThan(seqAfterFirst)
        })
    })

    // ── Stale-resolved-approval re-latch guard (Live Run C mirror) ──────────
    //
    // Regression (observed live on kimi-code v0.28.1/K3, standalone probe Run C):
    // after resolving a real approval modal (command approved, transport wrote the
    // key, kimi ran the command and finished the turn), a LATER settle pass
    // re-parsed the identical already-answered question text and re-latched
    // waiting_approval — with NO further PTY output ever arriving afterward, so
    // nothing triggered a correcting re-evaluation. The dashboard stayed pinned to
    // "waiting for approval" for minutes (until the 5-minute maxResponse watchdog),
    // even though recentOutputBuffer/responseBuffer/screenText no longer contained
    // any trace of the modal — proving the recapture read stale/transitional
    // buffer content, not a genuinely re-presented prompt.
    describe('applyWaitingApproval — stale-resolved-modal re-latch guard', () => {
        function resolveThenReparse(overrides: {
            reparseMessage?: string
            advanceMs?: number
            lastNonEmptyOutputAt: number
        }) {
            const { engine, transport } = buildEngine()
            transport.getApprovalKeyForIndex = () => '\r'
            engine.approvalEntrySeq = 1
            engine.activeModal = { message: 'Run this command?', buttons: ['Approve once', 'Reject'] }

            engine.resolveModal(0)
            expect(engine.activeModal).toBe(null)
            expect(engine.currentStatus).toBe('generating')

            const advanceMs = overrides.advanceMs ?? 50
            vi.advanceTimersByTime(advanceMs)

            ;(engine as any).applyWaitingApproval({
                modal: { message: overrides.reparseMessage ?? 'Run this command?', buttons: ['Approve once', 'Reject'] },
                now: Date.now(),
                lastNonEmptyOutputAt: overrides.lastNonEmptyOutputAt,
            })

            return { engine, transport }
        }

        it('rejects the identical already-resolved modal re-parsed shortly after with no new output since resolve', () => {
            const resolvedAt = Date.now()
            const { engine } = resolveThenReparse({
                advanceMs: 50,
                // No PTY activity since the resolve — the classic stale-buffer repro.
                lastNonEmptyOutputAt: resolvedAt,
            })

            // Must NOT re-latch: activeModal stays clear, status stays 'generating'
            // (whatever resolveModal already committed), not bounced back to
            // 'waiting_approval'.
            expect(engine.activeModal).toBe(null)
            expect(engine.currentStatus).toBe('generating')
        })

        // Regression (kimi-code v0.28.1/K3 live standalone repro): the guard used
        // to also require being within `timeouts.approvalCooldown` (a few seconds)
        // of the resolve. The real observed staleness window outlasted that bound
        // by a wide margin (30s+, tied to K3's "high" effort settle timing), so
        // the guard's protection expired before the stale content actually
        // cleared and the FSM re-latched anyway. The guard must now suppress the
        // stale repaint indefinitely — for as long as no genuinely new PTY output
        // has arrived — with no time cap at all.
        it('still rejects the identical already-resolved modal re-parsed 30+ seconds later with no new output', () => {
            const resolvedAt = Date.now()
            const { engine } = resolveThenReparse({
                advanceMs: 45_000, // far past any plausible fixed cooldown
                lastNonEmptyOutputAt: resolvedAt, // still no new output, ever
            })

            expect(engine.activeModal).toBe(null)
            expect(engine.currentStatus).toBe('generating')
        })

        it('captures a genuinely new approval with the SAME message text once fresh output has arrived', () => {
            // The load-bearing discriminator: consecutive real approvals sharing
            // identical text (a documented prior fix — see "writes the key for
            // consecutive distinct approvals that share message text within
            // cooldown") must keep working. A real follow-up approval necessarily
            // means the CLI produced new output first (ran the previous tool, then
            // asked again), so lastNonEmptyOutputAt advances past the resolve time.
            const resolvedAt = Date.now()
            const { engine } = resolveThenReparse({
                advanceMs: 50,
                lastNonEmptyOutputAt: resolvedAt + 25, // fresh output arrived after resolve
            })

            expect(engine.activeModal).toEqual({ message: 'Run this command?', buttons: ['Approve once', 'Reject'] })
            expect(engine.currentStatus).toBe('waiting_approval')
        })

        it('captures a genuinely new SAME-text approval even long after the resolve, as long as fresh output arrived', () => {
            // Mirrors the 30s+ rejection case above, but with genuinely fresh
            // output — proves the guard is governed purely by output freshness,
            // not elapsed time, in both directions.
            const resolvedAt = Date.now()
            const { engine } = resolveThenReparse({
                advanceMs: 45_000,
                lastNonEmptyOutputAt: resolvedAt + 44_000, // fresh output arrived, well after resolve
            })

            expect(engine.activeModal).toEqual({ message: 'Run this command?', buttons: ['Approve once', 'Reject'] })
            expect(engine.currentStatus).toBe('waiting_approval')
        })

        it('always captures a genuinely different modal regardless of output freshness or elapsed time', () => {
            const resolvedAt = Date.now()
            const { engine } = resolveThenReparse({
                reparseMessage: 'Apply this edit?',
                advanceMs: 45_000,
                lastNonEmptyOutputAt: resolvedAt, // no new output, but a different question
            })

            expect(engine.activeModal).toEqual({ message: 'Apply this edit?', buttons: ['Approve once', 'Reject'] })
            expect(engine.currentStatus).toBe('waiting_approval')
        })
    })

    // ── Stale idle guard ────────────────────────────────────────────────────

    describe('clearStaleIdleResponseGuard', () => {
        it('clears stale waiting state when terminal is idle and no modal', () => {
            const { engine, transport, callbacks } = buildEngine()
            transport.runDetectStatus = () => 'idle'

            engine.isWaitingForResponse = true
            engine.currentStatus = 'idle' as any
            engine.currentTurnScope = {
                prompt: 'hello',
                startedAt: Date.now() - 2000,
                bufferStart: 0,
                rawBufferStart: 0,
            }

            const snap = makeSnap({ recentOutputBuffer: '> ' })
            const cleared = engine.clearStaleIdleResponseGuard('pre_send', snap)

            expect(cleared).toBe(true)
            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentTurnScope).toBe(null)
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })

        it('does not clear when status is not idle', () => {
            const { engine, transport, callbacks } = buildEngine()
            transport.runDetectStatus = () => 'generating'

            engine.isWaitingForResponse = true
            engine.currentStatus = 'generating' as any

            const cleared = engine.clearStaleIdleResponseGuard('pre_send', makeSnap())
            expect(cleared).toBe(false)
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })

        it('does not clear when a modal is present', () => {
            const { engine, transport, callbacks } = buildEngine()
            transport.runDetectStatus = () => 'idle'
            transport.runParseApproval = () => ({ message: 'Approve?', buttons: ['Yes'] })

            engine.isWaitingForResponse = true
            engine.currentStatus = 'idle' as any

            const cleared = engine.clearStaleIdleResponseGuard('pre_send', makeSnap())
            expect(cleared).toBe(false)
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })
    })

    // ── scheduleSettle debounce ─────────────────────────────────────────────

    describe('scheduleSettle', () => {
        it('calls evaluateSettled after outputSettle timeout', () => {
            const { engine, transport } = buildEngine()
            transport.runParseSession = vi.fn(() => null) // parseSession → null → no-op

            engine.currentStatus = 'generating' as any
            engine.isWaitingForResponse = true
            engine.scheduleSettle()

            expect(transport.runParseSession).not.toHaveBeenCalled()
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.outputSettle + 10)
            expect(transport.runParseSession).toHaveBeenCalled()
        })

        it('resets the timer on each call (debounce)', () => {
            const { engine, transport } = buildEngine()
            const parseSpy = vi.fn(() => null)
            transport.runParseSession = parseSpy

            engine.scheduleSettle()
            vi.advanceTimersByTime(200) // half-way through settle
            engine.scheduleSettle() // reset
            vi.advanceTimersByTime(300) // not enough for the reset timer
            expect(parseSpy).not.toHaveBeenCalled()
            vi.advanceTimersByTime(250) // now enough
            expect(parseSpy).toHaveBeenCalledTimes(1)
        })
    })

    // ── false-idle regression guard ─────────────────────────────────────────

    describe('shouldHoldGenerating — quiet PTY during active turn', () => {
        it('holds generating when PTY has been quiet >statusActivityHold ms but turn is still active', () => {
            // claude-cli can pause 2s+ between chunks; a quiet period must NOT
            // fire false-idle while isWaitingForResponse && currentTurnScope.
            const { engine, transport, callbacks } = buildEngine()

            // Simulate stale output — lastNonEmptyOutputAt and lastScreenChangeAt
            // are far in the past (beyond statusActivityHold=2000ms)
            const stalePast = Date.now() - 5000
            transport.getSnapshot = () => makeSnap({
                lastNonEmptyOutputAt: stalePast,
                lastScreenChangeAt: stalePast,
                isWaitingForResponse: true,
            })
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [],
                activeModal: null,
            }))

            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'write me a long story',
                startedAt: Date.now() - 3000,
                bufferStart: 0,
                rawBufferStart: 0,
            }
            engine.setStatus('generating')

            // evaluateSettled sees status=idle from parser but we have an active turn
            engine.evaluateSettled(transport.getSnapshot())

            // Must NOT transition to idle — should hold generating
            expect(engine.currentStatus).toBe('generating')
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })

        it('bypasses the hold and falls through to applyIdle when parsedStatus=idle with final assistant after user', () => {
            // Even during an active turn, if the parser confirms idle + current-turn assistant,
            // the shouldHoldGenerating exception fires and applyIdle runs instead of hold.
            // applyIdle does not immediately set idle — it arms an idleFinishCandidate timer.
            // We verify it did NOT enter applyHoldGenerating (which records 'recent_activity_hold').
            const { engine, transport } = buildEngine()

            const stalePast = Date.now() - 5000
            transport.getSnapshot = () => makeSnap({
                lastNonEmptyOutputAt: stalePast,
                lastScreenChangeAt: stalePast,
                isWaitingForResponse: true,
            })
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'hello' },
                    { role: 'assistant', kind: 'standard', content: 'Done!', meta: {} },
                ],
                activeModal: null,
                parsedStatus: 'idle',
            }))

            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'hello',
                startedAt: Date.now() - 3000,
                bufferStart: 0,
                rawBufferStart: 0,
            }
            engine.setStatus('generating')

            engine.evaluateSettled(transport.getSnapshot())

            // applyHoldGenerating would record 'recent_activity_hold' as trigger.
            // Since the exception condition released the hold, that trigger should NOT appear.
            const history = engine.getStatusHistory()
            const holdEntry = history.find(h => h.trigger === 'recent_activity_hold')
            expect(holdEntry).toBeUndefined()
        })

        it('holds generating when parser shows assistant text but no user message yet (first chunk before tool call)', () => {
            // Regression: agent outputs first text chunk ("I'll explore..."), then immediately
            // begins tool calls. Between the text and the first tool call the PTY briefly shows
            // the prompt footer (❯). The old fast-path used !!lastParsedAssistant which matched
            // the just-emitted text and released the hold, causing false-idle.
            // The fixed fast-path requires a *current-turn* final standard assistant
            // (non-streaming, preceded by a user message). With no user message visible yet,
            // the hold must stay.
            const { engine, transport, callbacks } = buildEngine()

            const stalePast = Date.now() - 5000
            transport.getSnapshot = () => makeSnap({
                lastNonEmptyOutputAt: stalePast,
                lastScreenChangeAt: stalePast,
                isWaitingForResponse: true,
            })
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    // Only an assistant message visible — no user message yet in PTY
                    { role: 'assistant', kind: 'standard', content: "I'll explore the codebase first.", meta: {} },
                ],
                activeModal: null,
                parsedStatus: 'idle',
            }))

            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'implement feature X',
                startedAt: Date.now() - 500,
                bufferStart: 0,
                rawBufferStart: 0,
            }
            engine.setStatus('generating')

            engine.evaluateSettled(transport.getSnapshot())

            // Must hold generating — turn is still active, no confirmed current-turn completion
            expect(engine.currentStatus).toBe('generating')
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })

        it('holds generating when parser shows streaming assistant (meta.streaming=true)', () => {
            // A streaming assistant message is not a final completion signal.
            const { engine, transport, callbacks } = buildEngine()

            const stalePast = Date.now() - 5000
            transport.getSnapshot = () => makeSnap({
                lastNonEmptyOutputAt: stalePast,
                lastScreenChangeAt: stalePast,
                isWaitingForResponse: true,
            })
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'hello' },
                    { role: 'assistant', kind: 'standard', content: 'Still streaming...', meta: { streaming: true } },
                ],
                activeModal: null,
                parsedStatus: 'idle',
            }))

            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'hello',
                startedAt: Date.now() - 1000,
                bufferStart: 0,
                rawBufferStart: 0,
            }
            engine.setStatus('generating')

            engine.evaluateSettled(transport.getSnapshot())

            expect(engine.currentStatus).toBe('generating')
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })
    })

    // ── recent_activity_hold idle-finish: null detect verdict must not defer ──
    describe('applyHoldGenerating idle-finish — null detectStatus verdict', () => {
        beforeEach(() => { vi.useFakeTimers() })
        afterEach(() => { vi.useRealTimers() })

        // Regression (opencode generating→idle wedge): a native-source provider
        // whose PTY parser owns no messages (transcriptAuthority: provider →
        // parsed.messages === []) enters recent_activity_hold on every settle
        // because there is no PTY assistant to release the hold. Its idle cue is a
        // composer placeholder that momentarily falls out of frame, so
        // runDetectStatus returns NULL (onNoMatch: preserve-last) rather than a
        // positive verdict. shouldDeferIdleTimeoutFinish must treat that null as
        // "no evidence to defer" and let the hold's idle-finish timer run —
        // otherwise (the old `detect() || currentStatus` collapse to the held
        // 'generating') the finish deferred on every tick and the turn wedged in
        // generating forever even though its assistant reply had already landed.
        function armHold(detectVerdict: string | null) {
            const { engine, transport, callbacks } = buildEngine({
                requiresFinalAssistantBeforeIdle: true,
                transcriptAuthority: 'provider',
            })
            const stalePast = Date.now() - 5000
            transport.getSnapshot = () => makeSnap({
                lastNonEmptyOutputAt: stalePast,
                lastScreenChangeAt: stalePast,
                isWaitingForResponse: true,
            })
            // Native-source parser: idle status, NO messages (provider owns transcript).
            transport.runParseSession = vi.fn(() => ({ status: 'idle', messages: [], activeModal: null }))
            transport.runDetectStatus = vi.fn(() => detectVerdict)

            engine.isWaitingForResponse = true
            engine.currentTurnScope = { prompt: 'hi', startedAt: Date.now() - 3000, bufferStart: 0, rawBufferStart: 0 }
            engine.setStatus('generating')
            // Enters applyHoldGenerating (empty parsed messages → shouldHoldGenerating true),
            // which arms the generatingIdle idle-finish timer.
            engine.evaluateSettled(transport.getSnapshot())
            return { engine, callbacks }
        }

        it('runs finishResponse when the live detector returns null (no cue matched)', () => {
            const { engine, callbacks } = armHold(null)
            expect(engine.currentStatus).toBe('generating')
            // Advance past generatingIdle so the hold's idle-finish timer fires.
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle + 50)
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })

        it('still DEFERS when the live detector positively returns generating', () => {
            const { engine, callbacks } = armHold('generating')
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle + 50)
            // A real in-flight turn keeps deferring — the turn is not completed.
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })
    })

    // ── resetActiveTurnState ────────────────────────────────────────────────

    describe('resetActiveTurnState', () => {
        it('clears all turn-related state', () => {
            const { engine } = buildEngine()
            engine.isWaitingForResponse = true
            engine.currentTurnScope = { prompt: 'x', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 }
            engine.activeModal = { message: 'OK?', buttons: ['OK'] }

            engine.resetActiveTurnState()

            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentTurnScope).toBe(null)
            expect(engine.activeModal).toBe(null)
        })
    })

    // ── confirmPollStaticIdle (D4 static-idle wedge release) ─────────────────
    //
    // A hosted CLI whose boot banner drove the FSM to 'generating' (applyGenerating
    // sets currentStatus='generating' + isWaitingForResponse=true with NO
    // currentTurnScope) then sits at a static ready prompt. The caller (getStatus)
    // gates on no-recent-output / screen-detects-idle / no-modal; the engine adds
    // the structural guard here and performs the state transition.
    describe('confirmPollStaticIdle', () => {
        it('releases the boot-banner wedge: generating + no turn scope + no modal → idle', () => {
            const { engine } = buildEngine()
            // Exactly the wedge state applyGenerating leaves on a fresh hosted session.
            engine.setStatus('generating')
            engine.isWaitingForResponse = true
            engine.currentTurnScope = null
            engine.activeModal = null

            const flipped = engine.confirmPollStaticIdle('poll_static_idle')

            expect(flipped).toBe(true)
            expect(engine.currentStatus).toBe('idle')
            expect(engine.isWaitingForResponse).toBe(false)
        })

        it('is a no-op when a real turn is in flight (currentTurnScope set)', () => {
            const { engine } = buildEngine()
            engine.setStatus('generating')
            engine.isWaitingForResponse = true
            engine.currentTurnScope = { prompt: 'do work', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 }

            const flipped = engine.confirmPollStaticIdle('poll_static_idle')

            expect(flipped).toBe(false)
            expect(engine.currentStatus).toBe('generating')
            expect(engine.currentTurnScope).not.toBe(null)
        })

        it('is a no-op when an approval modal is active', () => {
            const { engine } = buildEngine()
            engine.setStatus('generating')
            engine.isWaitingForResponse = true
            engine.currentTurnScope = null
            engine.activeModal = { message: 'Proceed?', buttons: ['Yes', 'No'] }

            const flipped = engine.confirmPollStaticIdle('poll_static_idle')

            expect(flipped).toBe(false)
            expect(engine.currentStatus).toBe('generating')
            expect(engine.activeModal).not.toBe(null)
        })

        it('is a no-op when not currently generating', () => {
            const { engine } = buildEngine()
            engine.setStatus('idle')

            const flipped = engine.confirmPollStaticIdle('poll_static_idle')

            expect(flipped).toBe(false)
            expect(engine.currentStatus).toBe('idle')
        })
    })

    // ── FALSE-IDLE (Fix 2): applyIdle post-approval resume-grace hysteresis ──────
    //
    // An autonomous auto-approving mesh worker that auto-resolved a modal resumes the
    // same turn and falls briefly silent (the inter-approval quiet valley). At the FSM
    // level applyIdle must NOT tear the turn down during that valley — resetActiveTurnState
    // there is the root cause the downstream completion gate inherits as "turn closed".
    // The instance answers isInApprovalResumeGrace() via a callback; the engine only defers
    // while it returns true, bounded by APPROVAL_RESUME_IDLE_DEFER_CAP_MS.
    describe('applyIdle — post-approval resume grace hysteresis (Fix 2)', () => {
        // Reach applyIdle with an active turn + parsed idle + a current-turn final
        // standard assistant so shouldHoldGenerating is released and applyIdle runs.
        function driveIdleValley(inGrace: boolean) {
            const graceProbe = vi.fn(() => inGrace)
            const { engine, transport, callbacks } = buildEngine({}, {})
            ;(engine as any).callbacks.isInApprovalResumeGrace = graceProbe

            const stalePast = Date.now() - 5000
            const snap = makeSnap({
                lastNonEmptyOutputAt: stalePast,
                lastScreenChangeAt: stalePast,
                isWaitingForResponse: true,
            })
            transport.getSnapshot = () => snap
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'go' },
                    // A mid-turn assistant bubble — the FALSE-IDLE evidence.
                    { role: 'assistant', kind: 'standard', content: 'Working on it.', meta: {} },
                ],
                activeModal: null,
                parsedStatus: 'idle',
            }))

            engine.isWaitingForResponse = true
            engine.currentTurnScope = {
                prompt: 'go',
                startedAt: Date.now() - 3000,
                bufferStart: 0,
                rawBufferStart: 0,
            }
            engine.setStatus('generating')

            return { engine, transport, callbacks, graceProbe, snap }
        }

        it('(1) DEFERS finishResponse in the valley — turn scope is NOT torn down while in grace', () => {
            const { engine, callbacks, graceProbe } = driveIdleValley(true)

            engine.evaluateSettled(engine['transport'].getSnapshot())
            // Even after the idleFinish timeout would normally finish the turn, the
            // defer re-arms and re-evaluates rather than tearing the turn down.
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.idleFinish + 50)

            expect(graceProbe).toHaveBeenCalled()
            expect(engine.isWaitingForResponse).toBe(true)
            expect(engine.currentTurnScope).not.toBe(null)
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })

        // Drive applyIdle to actually FINISH: the first pass arms the idleFinishCandidate,
        // a second pass past idleFinishConfirm confirms it and calls finishResponse.
        function settleToFinish(engine: CliStateEngine, snap: CliBufferSnapshot) {
            engine.evaluateSettled(snap) // arm candidate
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.idleFinishConfirm + 50)
            engine.evaluateSettled(snap) // confirm → finishResponse
        }

        it('(2) stops deferring past APPROVAL_RESUME_IDLE_DEFER_CAP_MS (no infinite defer) — turn finishes', () => {
            const { engine, callbacks, snap } = driveIdleValley(true)

            // First evaluation starts the cap clock (defers, no finish).
            engine.evaluateSettled(snap)
            expect(engine.isWaitingForResponse).toBe(true)

            // Advance past the 18s cap; now the defer releases even though the probe still
            // says "in grace", and the candidate confirm-pass finishes the turn.
            vi.advanceTimersByTime(19_000)
            settleToFinish(engine, snap)

            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentTurnScope).toBe(null)
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })

        it('(3) REGRESSION: a normal turn (probe returns false) finishes normally — no defer', () => {
            const { engine, callbacks, graceProbe, snap } = driveIdleValley(false)

            settleToFinish(engine, snap)

            expect(graceProbe).toHaveBeenCalled()
            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentTurnScope).toBe(null)
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })

        it('(3b) REGRESSION: no callback registered ⇒ pre-fix behavior (finishes normally)', () => {
            const { engine, transport, callbacks } = buildEngine() // callbacks has no isInApprovalResumeGrace
            const stalePast = Date.now() - 5000
            const snap = makeSnap({ lastNonEmptyOutputAt: stalePast, lastScreenChangeAt: stalePast, isWaitingForResponse: true })
            transport.getSnapshot = () => snap
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'go' },
                    { role: 'assistant', kind: 'standard', content: 'Done.', meta: {} },
                ],
                activeModal: null,
                parsedStatus: 'idle',
            }))
            engine.isWaitingForResponse = true
            engine.currentTurnScope = { prompt: 'go', startedAt: Date.now() - 3000, bufferStart: 0, rawBufferStart: 0 }
            engine.setStatus('generating')

            settleToFinish(engine, snap)

            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentTurnScope).toBe(null)
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })
    })

    // ── FALSE-IDLE (screen-quiet gate): generating→idle requires ≥5s screen quiet ──
    //
    // A claude-cli mesh worker WAITING on a long-running foreground command (e.g. it
    // launched `npm run dev:standalone` then a `curl :3847/health` poll loop) is STILL
    // busy(generating): the spinner + streaming command output keep repainting the
    // screen. `lastScreenChangeAt` is bumped by the adapter on every visible screen
    // change, so the screen-diff quiet age never reaches SCREEN_QUIET_IDLE_MS (5000ms)
    // and the FSM must NOT arm idle / emit a weak completion. Only when the screen has
    // been byte-identical for ≥5s continuously may generating→idle finish.
    //
    // The mock uses a mutable `screenChangeAt` so the test can move the "last screen
    // change" forward in real (fake-timer) time — modelling a still-repainting screen —
    // and then hold it fixed to model a genuinely static screen.
    describe('generating→idle screen-quiet gate (false-idle fix)', () => {
        beforeEach(() => { vi.useFakeTimers() })
        afterEach(() => { vi.useRealTimers() })

        // parsedStatus='idle' but NO assistant / streaming so the primary applyGenerating
        // idle-finish timeout path (generatingIdle) is the one that would false-finish.
        function armGeneratingWaitOnCommand(screenChangeGetter: () => number) {
            const { engine, transport, callbacks } = buildEngine()
            transport.getSnapshot = () => makeSnap({
                lastNonEmptyOutputAt: Date.now(),
                lastScreenChangeAt: screenChangeGetter(),
                isWaitingForResponse: true,
            })
            // Parser reports 'generating' (worker is mid-turn running the command).
            transport.runParseSession = vi.fn(() => ({
                status: 'generating',
                messages: [{ role: 'user', content: 'run the health poll' }],
                activeModal: null,
                parsedStatus: 'generating',
            }))
            engine.isWaitingForResponse = true
            engine.currentTurnScope = { prompt: 'run the health poll', startedAt: Date.now() - 3000, bufferStart: 0, rawBufferStart: 0 }
            engine.setStatus('generating')
            engine.evaluateSettled(transport.getSnapshot()) // enters applyGenerating, arms generatingIdle timer
            return { engine, transport, callbacks }
        }

        it('does NOT finish while the screen keeps changing (spinner + streaming command output)', () => {
            // Screen last changed "just now" on every read — a live, repainting screen.
            const { engine, callbacks } = armGeneratingWaitOnCommand(() => Date.now())

            // Advance well past the generatingIdle idle-finish timeout. On a static-screen
            // FSM this would have finished the turn — here it must NOT, because the screen
            // quiet age is always ~0ms (< 5000ms).
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.generatingIdle + 5000)

            expect(engine.currentStatus).toBe('generating')
            expect(engine.isWaitingForResponse).toBe(true)
            expect(engine.currentTurnScope).not.toBe(null)
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })

        it('a screen change RESETS the quiet timer — 4s quiet then a repaint must not settle', () => {
            let screenChangeAt = Date.now()
            const { engine, callbacks } = armGeneratingWaitOnCommand(() => screenChangeAt)

            // 4s of quiet — not yet 5s.
            vi.advanceTimersByTime(4000)
            engine.evaluateSettled(engine['transport'].getSnapshot())
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()

            // A repaint lands (new curl output) → quiet timer resets.
            screenChangeAt = Date.now()
            vi.advanceTimersByTime(4000) // another 4s — still < 5s since the reset
            engine.evaluateSettled(engine['transport'].getSnapshot())

            expect(engine.currentStatus).toBe('generating')
            expect(callbacks.onTurnCompleted).not.toHaveBeenCalled()
        })

        it('DOES finish once the screen has been static ≥5s (genuine completion)', () => {
            // Screen (and output) changed once, then went permanently static. A single
            // pinned snapshot models "nothing changed since": lastScreenChangeAt and
            // lastOutputAt stay fixed across the candidate arm+confirm passes so the
            // idleFinishCandidate can confirm (mirrors the Fix-2 settleToFinish helper).
            const staticSince = Date.now() - 6000 // already >5s of screen quiet
            const { engine, transport, callbacks } = buildEngine()
            const snap = makeSnap({
                lastOutputAt: staticSince,
                lastNonEmptyOutputAt: staticSince,
                lastScreenChangeAt: staticSince, // never changes again
                isWaitingForResponse: true,
            })
            transport.getSnapshot = () => snap
            transport.runParseSession = vi.fn(() => ({
                status: 'idle',
                messages: [
                    { role: 'user', content: 'run the health poll' },
                    { role: 'assistant', kind: 'standard', content: 'Health check passed.', meta: {} },
                ],
                activeModal: null,
                parsedStatus: 'idle',
            }))
            engine.isWaitingForResponse = true
            engine.currentTurnScope = { prompt: 'run the health poll', startedAt: Date.now() - 3000, bufferStart: 0, rawBufferStart: 0 }
            engine.setStatus('generating')

            // Screen quiet is already ≥5s; run the candidate arm + confirm passes.
            engine.evaluateSettled(snap)           // arm idleFinishCandidate (screen quiet ≥5s)
            vi.advanceTimersByTime(DEFAULT_TIMEOUTS.idleFinishConfirm + 50)
            engine.evaluateSettled(snap)           // confirm → finishResponse

            expect(engine.isWaitingForResponse).toBe(false)
            expect(engine.currentTurnScope).toBe(null)
            expect(engine.currentStatus).toBe('idle')
            expect(callbacks.onTurnCompleted).toHaveBeenCalled()
        })
    })
})
