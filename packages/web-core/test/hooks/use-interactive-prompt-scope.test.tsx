// @vitest-environment jsdom
//
// Behavioural coverage for the prompt surface a dashboard shell mounts —
// i.e. what `useInteractivePrompt(selectedSessionId)` actually resolves to.
//
// WHY THIS FILE EXISTS: the selector `findInteractivePromptSession` was already
// unit-tested and green while the standalone gate was live-broken, because
// nothing tested the *hook* the gate calls. The selector tests passed the scope
// explicitly; the gate passed nothing at all. That gap is the whole defect, so
// these assertions go through the hook rather than the selector.
//
// Two live defects are locked down here:
//   1. an unscoped gate rendered the FIRST prompt-bearing session in `ides`
//      order (a status-report merge artifact), so with `wsA` selected the
//      modal showed `e2e-ws`'s question after a refresh;
//   2. hidden (`surfaceHidden`) mesh workers must stay suppressed — adding a
//      scope must not re-open that leak, which is why `sessionId` and
//      `includeHidden` are separate axes on the selector contract.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInteractivePrompt } from '../../src/hooks/useInteractivePrompt'
import type { DaemonData } from '../../src/types'

// The hook pulls entries from BaseDaemonContext and a sender from
// TransportContext; neither is under test here, so both are stubbed.
const ides: DaemonData[] = []

vi.mock('../../src/context/BaseDaemonContext', () => ({
    useBaseDaemons: () => ({ ides, isP2PActive: false, p2pStates: {} }),
}))

vi.mock('../../src/context/TransportContext', () => ({
    useTransport: () => ({ sendCommand: async () => ({}) }),
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}))

function promptFor(promptId: string) {
    return {
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
    }
}

function sessionEntry(sessionId: string, opts: { surfaceHidden?: boolean } = {}): DaemonData {
    return {
        id: `daemon-1:cli:${sessionId}`,
        daemonId: 'daemon-1',
        sessionId,
        type: 'claude-cli',
        status: 'waiting_choice',
        activeInteractivePrompt: promptFor(`prompt-${sessionId}`),
        ...(opts.surfaceHidden ? { surfaceHidden: true } : {}),
    } as DaemonData
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    ides.length = 0
})

/** Render the hook exactly as a gate does and report what it would surface. */
function resolveVia(sessionId: string | null): { sessionId?: string; promptId?: string } | null {
    let seen: { sessionId?: string; promptId?: string } | null = null
    function Probe() {
        const { promptSession } = useInteractivePrompt(sessionId)
        seen = promptSession
            ? { sessionId: promptSession.sessionId, promptId: promptSession.prompt.promptId }
            : null
        return null
    }
    act(() => root.render(<Probe />))
    return seen
}

describe('interactive prompt gate scoping', () => {
    it('does not surface another session\'s prompt when the selected session has none', () => {
        // Live repro: `e2e-ws` holds a question, the user has `wsA` selected.
        // `e2e-ws` is first in ides order, so an unscoped scan returned it.
        ides.push(sessionEntry('e2e-ws'), { id: 'daemon-1:cli:wsA', daemonId: 'daemon-1', sessionId: 'wsA', type: 'claude-cli', status: 'idle' } as DaemonData)

        expect(resolveVia('wsA')).toBeNull()
    })

    it('surfaces the selected session\'s own prompt', () => {
        ides.push(sessionEntry('e2e-ws'), sessionEntry('wsA'))

        expect(resolveVia('wsA')).toMatchObject({ sessionId: 'wsA', promptId: 'prompt-wsA' })
    })

    it('keeps a hidden mesh worker suppressed even when it is the scoped session', () => {
        // Regression guard: `includeHidden` must stay defaulted off. A hidden
        // worker has no tab and no pane, so its full-screen modal would be
        // unanswerable and would cover the owner's dashboard.
        ides.push(sessionEntry('hidden-worker', { surfaceHidden: true }))

        expect(resolveVia('hidden-worker')).toBeNull()
    })

    it('keeps a hidden worker suppressed on an unscoped lookup too', () => {
        ides.push(sessionEntry('hidden-worker', { surfaceHidden: true }))

        expect(resolveVia(null)).toBeNull()
    })
})
