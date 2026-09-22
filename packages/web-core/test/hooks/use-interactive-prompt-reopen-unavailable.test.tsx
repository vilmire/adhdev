// @vitest-environment jsdom
//
// SILENT-REOPEN-FAILURE (remote-answer-picker-parse): reopen() used to only
// clear the shared dismissal. When the daemon-side parse of the captured
// screen fails to produce a usable InteractivePrompt (the class of bug fixed
// in interactive-prompt.ts's footer-drift fallback), the session that a
// moment ago reported an active prompt can flip back to having none at all —
// findInteractivePromptSession then returns null, so reopen() cleared a
// dismissal that changes nothing on screen: the "Answer the question" button
// silently did nothing, with no way for the owner to tell a dead tap from a
// working one. reopen() must surface that case as an explicit responseError
// instead of failing silent.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInteractivePrompt } from '../../src/hooks/useInteractivePrompt'
import type { DaemonData } from '../../src/types'

const SESSION_ID = 'sess-unavailable'

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

/** Same session id, but no activeInteractivePrompt — the parse-failure shape. */
function sessionWithoutPrompt(): DaemonData {
    return {
        id: `daemon-1:cli:${SESSION_ID}`,
        daemonId: 'daemon-1',
        sessionId: SESSION_ID,
        type: 'claude-cli',
        status: 'waiting_approval',
    } as DaemonData
}

let hook: ReturnType<typeof useInteractivePrompt>
function Probe() {
    hook = useInteractivePrompt(SESSION_ID)
    return null
}

let container: HTMLDivElement
let root: Root
let promptSeq = 0

beforeEach(() => {
    promptSeq += 1
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    ides = []
})

function render() {
    act(() => root.render(<Probe />))
}

describe('useInteractivePrompt — reopen() when the prompt is unavailable', () => {
    it('reopen() sets responseError when foundSession is null (nothing to reopen — the silent-failure fix)', () => {
        ides = [sessionWithoutPrompt()]
        render()
        expect(hook.hasActivePrompt).toBe(false)
        expect(hook.promptSession).toBeNull()
        expect(hook.responseError).toBeNull()

        act(() => hook.reopen())

        expect(hook.promptSession).toBeNull()
        expect(hook.responseError).not.toBeNull()
    })

    it('reopen() clears responseError normally when a session IS resolvable (no regression)', () => {
        const promptId = `prompt-reopen-ok-${promptSeq}`
        ides = [sessionWithPrompt(promptId)]
        render()
        expect(hook.hasActivePrompt).toBe(true)

        act(() => hook.cancel())
        expect(hook.promptSession).toBeNull()

        act(() => hook.reopen())

        expect(hook.promptSession?.prompt.promptId).toBe(promptId)
        expect(hook.responseError).toBeNull()
    })

    it('a prompt that disappears between render and reopen() (parse-failure race) surfaces the error too', () => {
        const promptId = `prompt-reopen-race-${promptSeq}`
        ides = [sessionWithPrompt(promptId)]
        render()
        expect(hook.hasActivePrompt).toBe(true)

        // Simulate the daemon's next status report losing the captured prompt —
        // exactly what a TUI/spec parse failure leaves behind.
        ides = [sessionWithoutPrompt()]
        render()
        expect(hook.hasActivePrompt).toBe(false)

        act(() => hook.reopen())

        expect(hook.promptSession).toBeNull()
        expect(hook.responseError).not.toBeNull()
    })
})
