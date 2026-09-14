// @vitest-environment jsdom
//
// PICKER-DISMISS-SHARED-STORE (live defect, 2026-09-15, owner-verified on mobile):
// the session sat in "QUESTION WAITING" but the picker modal never re-opened —
// tapping "Answer the question" did nothing. Permanent deadlock.
//
// Root cause: `dismissedPromptId` was a per-hook-instance `useState`, but the
// dashboard mounts `useInteractivePrompt` more than once — the modal surface
// (Dashboard → DashboardOverlays) and each ApprovalBanner CTA are SEPARATE
// instances. Closing the modal dismissed only the modal's instance; the banner's
// reopen() reset only its own (already-null) instance, so the CTA was a dead
// button. The dismissal is now a module-level store shared by every instance,
// keyed by promptId.
//
// These tests mount the hook the way the dashboard does — one "modal" instance
// plus separate "banner" instances — and drive the exact dead-button round trip.
// With the dismissal back on per-instance useState, the round-trip test is RED:
// reopening from the banner cannot clear the modal instance's dismissal.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInteractivePrompt } from '../../src/hooks/useInteractivePrompt'
import type { DaemonData } from '../../src/types'

const SESSION_ID = 'sess-picker'

// Reassigned (never mutated) so the hook's useMemo sees a fresh `ides` identity
// when the daemon reports a new question.
let ides: DaemonData[] = []

vi.mock('../../src/context/BaseDaemonContext', () => ({
    useBaseDaemons: () => ({ ides, isP2PActive: false, p2pStates: {} }),
}))

vi.mock('../../src/context/TransportContext', () => ({
    useTransport: () => ({ sendCommand: async () => ({}) }),
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}))

function sessionWithPrompt(promptId: string): DaemonData {
    return {
        id: `daemon-1:cli:${SESSION_ID}`,
        daemonId: 'daemon-1',
        sessionId: SESSION_ID,
        type: 'claude-cli',
        status: 'waiting_choice',
        activeInteractivePrompt: {
            promptId,
            origin: 'cli' as const,
            providerType: 'claude-cli',
            createdAt: 1,
            questions: [{
                questionId: 'q1',
                question: `Question from ${promptId}`,
                multiSelect: false,
                options: [{ label: 'Yes' }, { label: 'No' }],
            }],
        },
    } as DaemonData
}

// One "modal" instance (Dashboard → DashboardOverlays) and two "banner" instances
// (ApprovalBanner is mounted from both PaneGroupContent and DashboardRemoteDialog).
let modal: ReturnType<typeof useInteractivePrompt>
let bannerA: ReturnType<typeof useInteractivePrompt>
let bannerB: ReturnType<typeof useInteractivePrompt>

function ModalProbe() {
    modal = useInteractivePrompt(SESSION_ID)
    return null
}
function BannerAProbe() {
    bannerA = useInteractivePrompt(SESSION_ID)
    return null
}
function BannerBProbe() {
    bannerB = useInteractivePrompt(SESSION_ID)
    return null
}

let container: HTMLDivElement
let root: Root
let promptSeq = 0
let promptId: string

beforeEach(() => {
    // The shared dismissal is module-level and keyed by promptId; each test asks a
    // NEW question so no test inherits another's dismissal.
    promptId = `prompt-shared-${promptSeq++}`
    ides = [sessionWithPrompt(promptId)]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    ides = []
})

function renderAll() {
    act(() => root.render(<><ModalProbe /><BannerAProbe /><BannerBProbe /></>))
}

describe('interactive prompt — dismissal shared across hook instances', () => {
    it('reopening from the banner restores the modal the modal instance dismissed (the dead-button round trip)', () => {
        renderAll()
        expect(modal.promptSession?.prompt.promptId).toBe(promptId)

        // User closes the picker (Close button or Escape) — the modal instance dismisses.
        act(() => modal.cancel())
        expect(modal.promptSession).toBeNull()
        // The banner keeps its reopen affordance: hasActivePrompt is dismiss-independent.
        expect(bannerA.hasActivePrompt).toBe(true)

        // The "Answer the question" CTA lives on the banner instance. Before the
        // shared store this reset only the banner's own (already-null) dismissal.
        act(() => bannerA.reopen())

        expect(modal.promptSession?.prompt.promptId).toBe(promptId)
    })

    it('reopening works from either banner mount point', () => {
        renderAll()
        act(() => modal.cancel())
        expect(modal.promptSession).toBeNull()

        // The second mount point (DashboardRemoteDialog) must behave identically.
        act(() => bannerB.reopen())
        expect(modal.promptSession?.prompt.promptId).toBe(promptId)
    })

    it('a dismissal sticks even when a fresh hook instance mounts afterwards', () => {
        // The banner can mount (or remount) AFTER the modal dismissed — e.g. the
        // user opens the remote dialog. A late-mounted instance must agree the
        // prompt is dismissed rather than popping the modal back open.
        renderAll()
        act(() => modal.cancel())

        let late: ReturnType<typeof useInteractivePrompt>
        function LateProbe() {
            late = useInteractivePrompt(SESSION_ID)
            return null
        }
        act(() => root.render(<><ModalProbe /><LateProbe /></>))

        expect(late!.promptSession).toBeNull()
        expect(late!.hasActivePrompt).toBe(true)
    })

    it('a NEW question (different promptId) is not born pre-dismissed', () => {
        renderAll()
        act(() => modal.cancel())
        expect(modal.promptSession).toBeNull()

        // The picker moves on to a new question with a new promptId. The old
        // dismissal is keyed to the old promptId and must not suppress the new one.
        const nextPromptId = `prompt-shared-next-${promptSeq++}`
        ides = [sessionWithPrompt(nextPromptId)]
        renderAll()

        expect(modal.promptSession?.prompt.promptId).toBe(nextPromptId)
    })

    it('a dismissed promptId stays dismissed while the SAME question is still up', () => {
        renderAll()
        act(() => modal.cancel())
        expect(modal.promptSession).toBeNull()

        // Status refresh re-delivers the same prompt (new array identity, same id).
        ides = [sessionWithPrompt(promptId)]
        renderAll()

        expect(modal.promptSession).toBeNull()
        expect(bannerA.hasActivePrompt).toBe(true)
    })
})
