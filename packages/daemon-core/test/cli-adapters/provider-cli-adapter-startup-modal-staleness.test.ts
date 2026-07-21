/**
 * Regression: two independent stale-approval bypasses in provider-cli-adapter
 * (observed live on kimi-code v0.28.1/K3, standalone final-validation pass).
 *
 * cli-state-engine.ts's applyWaitingApproval already rejects a re-parsed
 * modal that matches an already-resolved one via a content-based signature
 * (isStaleResolvedApproval). But provider-cli-adapter.ts has TWO ad-hoc
 * re-parse fallbacks outside the settled-eval loop that previously had NO
 * staleness protection at all:
 *
 * 1. "startupModal" (getStatus() and getDebugState()) — an independent
 *    `runParseApproval(recentOutputBuffer)` gated by `startupParseGate`.
 * 2. The "live-detect" fallback inside getStatus() — gated by
 *    `!effectiveModal && engine.isWaitingForResponse` (NOT startupParseGate),
 *    which runs on EVERY getStatus() call — including the daemon's periodic
 *    background status heartbeat — for as long as a turn is in flight. Its
 *    own re-parse WRITES `engine.activeModal` directly, bypassing setStatus
 *    (rawStatus never flips) and bypassing recordTrace, so it silently
 *    re-corrupts the engine's own state with no observable transition at all.
 *    Live trace evidence confirmed this: after resolveModal() correctly
 *    cleared engine.activeModal, NO further trace entries were EVER recorded,
 *    yet getStatus()/getDebugState() kept reporting the identical
 *    already-resolved modal — proof the corruption happened via a path that
 *    doesn't call setStatus or recordTrace, i.e. fallback #2, not the
 *    settled-eval loop and not (this time) startupModal (startupParseGate
 *    was already false throughout).
 *
 * Fix: both fallbacks now reuse engine.isStaleResolvedApproval (the SAME
 * discriminator applyWaitingApproval uses) before letting a re-parsed modal
 * leak into the returned status/activeModal or into engine.activeModal
 * itself.
 */
import { describe, expect, it, vi } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

const MODAL = { message: 'Run this command?', buttons: ['Approve once', 'Reject'] }

function buildAdapter() {
    const adapter = new ProviderCliAdapter({
        type: 'kimi',
        name: 'Kimi Code',
        category: 'cli',
        binary: 'kimi',
        spawn: { command: 'kimi', args: [], shell: false, env: {} },
        scripts: {
            detectStatus: () => 'idle',
            parseApproval: () => null,
        },
        // Mirrors the real shipped kimi manifest's chromePatterns: "known
        // volatile repaint noise" the content signature strips before
        // comparing, so a footer/context-meter tick alone can't defeat it.
        tui: {
            transcriptPty: {
                chromePatterns: [
                    { regex: 'kimi thinking\\s+context:\\s*\\d+%' },
                ],
            },
        },
    } as any, '/tmp/project') as any

    adapter.ptyProcess = { write: vi.fn() }
    adapter.terminalScreen = { getText: () => '' }
    adapter.ready = true
    adapter.accumulatedBuffer = ''
    adapter.recentOutputBuffer = ''
    adapter.engine.isWaitingForResponse = false
    return adapter
}

/** Resolve MODAL through the real engine path, seeding lastApprovalResolvedAt
 *  / lastResolvedModalMessage / lastApprovalResolvedContentSignature exactly
 *  as a live resolveModal() call would. */
function resolveModalOnAdapter(adapter: any, screenText: string) {
    adapter.terminalScreen = { getText: () => screenText }
    adapter.engine.approvalEntrySeq = 1
    adapter.engine.activeModal = { ...MODAL }
    adapter.engine.getApprovalKeyForIndex = () => '\r'
    adapter.engine.resolveModal(0)
    expect(adapter.engine.activeModal).toBe(null)
    expect(adapter.engine.lastApprovalResolvedAt).toBeGreaterThan(0)
}

describe('ProviderCliAdapter startup-gate modal staleness (getStatus / getDebugState)', () => {
    it('getStatus() suppresses a stale already-resolved modal re-surfaced by the startup-gate parse', () => {
        const adapter = buildAdapter()
        const screen = '✨ Run the shell command: echo MARKER\n▶ Run this command?\n1. Approve once\n2. Reject'
        resolveModalOnAdapter(adapter, screen)

        // startupParseGate is STILL open and recentOutputBuffer/terminalScreen
        // still contain the identical (already-answered) approval text — the
        // exact live repro. The ad-hoc startup parse keeps matching it.
        adapter.startupParseGate = true
        adapter.recentOutputBuffer = screen
        adapter.runParseApproval = vi.fn(() => ({ ...MODAL }))

        const status = adapter.getStatus()
        expect(status.activeModal).toBe(null)
        expect(status.status).not.toBe('waiting_approval')
    })

    it('getDebugState() suppresses the same stale startup-gate re-parse', () => {
        const adapter = buildAdapter()
        const screen = '✨ Run the shell command: echo MARKER\n▶ Run this command?\n1. Approve once\n2. Reject'
        resolveModalOnAdapter(adapter, screen)

        adapter.startupParseGate = true
        adapter.recentOutputBuffer = screen
        adapter.runParseApproval = vi.fn(() => ({ ...MODAL }))

        const debugState = adapter.getDebugState()
        expect(debugState.activeModal).toBe(null)
        expect(debugState.status).not.toBe('waiting_approval')
        expect(debugState.rawStatus).toBe('generating') // engine's own state, unaffected either way
    })

    it('stays suppressed across pure chrome/footer repaint (identical approval-relevant content)', () => {
        const adapter = buildAdapter()
        const screen = '✨ Run the shell command: echo MARKER\n▶ Run this command?\n1. Approve once\n2. Reject\nkimi thinking  context: 0%'
        resolveModalOnAdapter(adapter, screen)

        adapter.startupParseGate = true
        // Same approval-relevant content, only the trailing chrome-ish text
        // differs (would defeat a pure output-timestamp discriminator).
        const repaint = '✨ Run the shell command: echo MARKER\n▶ Run this command?\n1. Approve once\n2. Reject\nkimi thinking  context: 3%'
        adapter.recentOutputBuffer = repaint
        adapter.terminalScreen = { getText: () => repaint }
        adapter.runParseApproval = vi.fn(() => ({ ...MODAL }))

        const status = adapter.getStatus()
        expect(status.activeModal).toBe(null)
        expect(status.status).not.toBe('waiting_approval')
    })

    it('still captures a genuinely new startup modal (real new surrounding content) — not over-suppressed', () => {
        const adapter = buildAdapter()
        const screen = '✨ Run the shell command: echo MARKER1\n▶ Run this command?\n1. Approve once\n2. Reject'
        resolveModalOnAdapter(adapter, screen)

        adapter.startupParseGate = true
        // Real new content: the first command's result landed, and a
        // genuinely new second approval request followed.
        const freshScreen = [
            '✨ Run the shell command: echo MARKER1',
            '● Ran a command',
            '   Command executed successfully.',
            '● Done.',
            '',
            '✨ Run the shell command: echo MARKER2',
            '▶ Run this command?',
            '1. Approve once',
            '2. Reject',
        ].join('\n')
        adapter.recentOutputBuffer = freshScreen
        adapter.terminalScreen = { getText: () => freshScreen }
        adapter.runParseApproval = vi.fn(() => ({ ...MODAL }))

        const status = adapter.getStatus()
        expect(status.activeModal).toEqual(MODAL)
        expect(status.status).toBe('waiting_approval')
    })

    it('preserves legitimate startup approval detection when nothing has ever been resolved', () => {
        // engine cleared / fresh session: lastApprovalResolvedAt is 0, so the
        // staleness check is a no-op and a genuine startup modal must still
        // surface normally.
        const adapter = buildAdapter()
        adapter.startupParseGate = true
        const screen = '✨ Trust this workspace?\n▶ Do you want to proceed?\n1. Yes\n2. No'
        adapter.recentOutputBuffer = screen
        adapter.terminalScreen = { getText: () => screen }
        const TRUST_MODAL = { message: 'Do you want to proceed?', buttons: ['Yes', 'No'] }
        adapter.runParseApproval = vi.fn(() => ({ ...TRUST_MODAL }))

        expect(adapter.engine.lastApprovalResolvedAt).toBe(0)
        const status = adapter.getStatus()
        expect(status.activeModal).toEqual(TRUST_MODAL)
        expect(status.status).toBe('waiting_approval')

        const debugState = adapter.getDebugState()
        expect(debugState.activeModal).toEqual(TRUST_MODAL)
    })

    it('does not affect a non-approval startup parse (no modal at all)', () => {
        const adapter = buildAdapter()
        adapter.startupParseGate = true
        adapter.recentOutputBuffer = '❯ '
        adapter.terminalScreen = { getText: () => '❯ ' }
        adapter.runParseApproval = vi.fn(() => null)

        const status = adapter.getStatus()
        expect(status.activeModal).toBe(null)
    })

    describe('getStatus() live-detect fallback (startupParseGate CLOSED — the confirmed live-repro shape)', () => {
        // This mirrors the exact live trace evidence: startupParseGate is
        // false throughout (so the OTHER fallback never engages at all), yet
        // a turn is still in flight (isWaitingForResponse=true) and the
        // resolved approval's text is still matched by the live re-parse.
        function buildLiveDetectAdapter() {
            const adapter = buildAdapter()
            adapter.startupParseGate = false
            adapter.engine.isWaitingForResponse = true
            adapter.runDetectStatus = vi.fn(() => 'waiting_approval')
            return adapter
        }

        it('does not write engine.activeModal from a stale re-parse of an already-resolved approval', () => {
            const adapter = buildLiveDetectAdapter()
            const screen = '✨ Run the shell command: echo MARKER\n▶ Run this command?\n1. Approve once\n2. Reject'
            resolveModalOnAdapter(adapter, screen)
            expect(adapter.engine.currentStatus).toBe('generating')

            // Identical content still in view; runDetectStatus/runParseApproval
            // keep matching it exactly as the live buffer would.
            adapter.recentOutputBuffer = screen
            adapter.terminalScreen = { getText: () => screen }
            adapter.runParseApproval = vi.fn(() => ({ ...MODAL }))

            const status = adapter.getStatus()

            // The bug: this used to silently set engine.activeModal WITHOUT
            // ever calling setStatus, so rawStatus stayed 'generating' while
            // activeModal/status still reported the stale modal.
            expect(adapter.engine.activeModal).toBe(null)
            expect(adapter.engine.currentStatus).toBe('generating')
            expect(status.activeModal).toBe(null)
        })

        it('still captures a genuinely new live modal when isWaitingForResponse and no prior resolve exists', () => {
            // Baseline: nothing has ever been resolved (lastApprovalResolvedAt
            // is 0), so the live-detect fallback must still work normally.
            const adapter = buildLiveDetectAdapter()
            const screen = '✨ Trust this workspace?\n▶ Do you want to proceed?\n1. Yes\n2. No'
            adapter.recentOutputBuffer = screen
            adapter.terminalScreen = { getText: () => screen }
            const TRUST_MODAL = { message: 'Do you want to proceed?', buttons: ['Yes', 'No'] }
            adapter.runParseApproval = vi.fn(() => ({ ...TRUST_MODAL }))

            const status = adapter.getStatus()
            expect(status.activeModal).toEqual(TRUST_MODAL)
            expect(adapter.engine.activeModal).toEqual(TRUST_MODAL)
        })

        it('captures a genuinely new approval via live-detect once real new content appears after a resolve', () => {
            const adapter = buildLiveDetectAdapter()
            const screen1 = '✨ Run the shell command: echo MARKER1\n▶ Run this command?\n1. Approve once\n2. Reject'
            resolveModalOnAdapter(adapter, screen1)

            const freshScreen = [
                '✨ Run the shell command: echo MARKER1',
                '● Ran a command',
                '   Command executed successfully.',
                '● Done.',
                '',
                '✨ Run the shell command: echo MARKER2',
                '▶ Run this command?',
                '1. Approve once',
                '2. Reject',
            ].join('\n')
            adapter.recentOutputBuffer = freshScreen
            adapter.terminalScreen = { getText: () => freshScreen }
            adapter.runParseApproval = vi.fn(() => ({ ...MODAL }))

            const status = adapter.getStatus()
            expect(status.activeModal).toEqual(MODAL)
            expect(adapter.engine.activeModal).toEqual(MODAL)
        })
    })
})
