// @vitest-environment jsdom
//
// "Open chat" from a surface with no DashboardMainView mounted (the standalone
// /mesh page) used to be a silent no-op: requestOpenSessionChat returned false
// and every caller ignored it. Now the request is held, the app navigates to
// the dashboard (SessionChatDashboardNavigator, mounted by AppShell), and the
// request is replayed once the dashboard subscribes. A session the dashboard
// cannot find still ends in the subscriber's `chatNotFound` toast; with no way
// to navigate at all the bus says so with its own toast.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventManager } from '../../src/managers/EventManager'
import SessionChatDashboardNavigator from '../../src/components/app/SessionChatDashboardNavigator'
import {
    SESSION_CHAT_REPLAY_RETRY_MS,
    SESSION_CHAT_REPLAY_WINDOW_MS,
    onOpenSessionChat,
    registerSessionChatNavigator,
    requestOpenSessionChat,
    resetSessionChatNavForTests,
    type SessionChatNavRequest,
} from '../../src/utils/session-nav'

beforeEach(() => {
    vi.useFakeTimers()
    resetSessionChatNavForTests()
})
afterEach(() => {
    resetSessionChatNavForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('session-nav bus', () => {
    it('delivers straight to a mounted subscriber (dashboard) without navigating', () => {
        const navigate = vi.fn()
        registerSessionChatNavigator(navigate)
        const listener = vi.fn(() => 'opened' as const)
        onOpenSessionChat(listener)
        expect(requestOpenSessionChat({ sessionId: 's1', source: 'test' })).toBe(true)
        expect(navigate).not.toHaveBeenCalled()
        expect(listener).toHaveBeenCalledWith({ sessionId: 's1', source: 'test' })
    })

    it('no subscriber → navigates, then replays to the subscriber that mounts', () => {
        const navigate = vi.fn()
        registerSessionChatNavigator(navigate)
        expect(requestOpenSessionChat({ sessionId: 's1', source: 'mesh-overview-session-modal' })).toBe(true)
        expect(navigate).toHaveBeenCalledTimes(1)

        const listener = vi.fn<(request: SessionChatNavRequest) => 'opened'>(() => 'opened')
        onOpenSessionChat(listener)
        vi.advanceTimersByTime(0)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener.mock.calls[0][0]).toMatchObject({ sessionId: 's1', deferMiss: true })

        // Opened: nothing further is replayed.
        vi.advanceTimersByTime(SESSION_CHAT_REPLAY_WINDOW_MS * 2)
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('a replay miss is retried quietly while the dashboard mounts its tabs', () => {
        registerSessionChatNavigator(vi.fn())
        requestOpenSessionChat({ sessionId: 's1', source: 'test' })
        let ready = false
        const listener = vi.fn<(request: SessionChatNavRequest) => 'opened' | 'not_found'>(() => (ready ? 'opened' : 'not_found'))
        onOpenSessionChat(listener)
        vi.advanceTimersByTime(0)
        expect(listener).toHaveBeenCalledTimes(1)
        ready = true
        vi.advanceTimersByTime(SESSION_CHAT_REPLAY_RETRY_MS)
        expect(listener).toHaveBeenCalledTimes(2)
        expect(listener.mock.calls.every(([request]) => request.deferMiss === true)).toBe(true)
        vi.advanceTimersByTime(SESSION_CHAT_REPLAY_WINDOW_MS)
        expect(listener).toHaveBeenCalledTimes(2)
    })

    it('a session the dashboard never finds gets one final, non-deferred delivery (→ chatNotFound toast)', () => {
        registerSessionChatNavigator(vi.fn())
        requestOpenSessionChat({ sessionId: 'remote-session', source: 'test' })
        const listener = vi.fn<(request: SessionChatNavRequest) => 'not_found'>(() => 'not_found')
        onOpenSessionChat(listener)
        vi.advanceTimersByTime(SESSION_CHAT_REPLAY_WINDOW_MS + SESSION_CHAT_REPLAY_RETRY_MS)
        const finals = listener.mock.calls.filter(([request]) => request.deferMiss === false)
        expect(finals).toHaveLength(1)
        expect(listener.mock.calls.at(-1)?.[0].deferMiss).toBe(false)
        const count = listener.mock.calls.length
        vi.advanceTimersByTime(SESSION_CHAT_REPLAY_WINDOW_MS)
        expect(listener.mock.calls.length).toBe(count)
    })

    it('neither a subscriber nor a navigator → toast instead of silence', () => {
        const toast = vi.spyOn(eventManager, 'showToast').mockImplementation(() => {})
        expect(requestOpenSessionChat({ sessionId: 's1', source: 'test' })).toBe(false)
        expect(toast).toHaveBeenCalledWith("Can't open this chat from here — open it from the dashboard.", 'info')
    })

    it('navigated but no dashboard ever subscribed → toast at the deadline', () => {
        const toast = vi.spyOn(eventManager, 'showToast').mockImplementation(() => {})
        registerSessionChatNavigator(vi.fn())
        requestOpenSessionChat({ sessionId: 's1', source: 'test' })
        expect(toast).not.toHaveBeenCalled()
        vi.advanceTimersByTime(SESSION_CHAT_REPLAY_WINDOW_MS)
        expect(toast).toHaveBeenCalledTimes(1)
    })
})

describe('DashboardMainView subscriber honours deferMiss', () => {
    it('stays quiet on a deferred miss and reports not_found / opened to the bus', () => {
        const source = readFileSync(join(__dirname, '../../src/components/dashboard/DashboardMainView.tsx'), 'utf8')
        const start = source.indexOf('onOpenSessionChat(request =>')
        const block = source.slice(start, source.indexOf('}), [', start))
        expect(block.match(/if \(!request\.deferMiss\) eventManager\.showToast\(t\('sessionNav\.chatNotFound'\), 'info'\)/g)).toHaveLength(2)
        expect(block.match(/return 'not_found'/g)).toHaveLength(2)
        expect(block).toContain("return 'opened'")
    })
})

describe('/mesh → /dashboard navigation (router)', () => {
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
    })

    it('an open request on /mesh moves to /dashboard and the dashboard receives it', () => {
        const received: SessionChatNavRequest[] = []
        const seen: string[] = []
        function LocationProbe() {
            const location = useLocation()
            seen.push(location.pathname)
            return null
        }
        function FakeDashboard() {
            useEffect(() => onOpenSessionChat(request => {
                received.push(request)
                return 'opened'
            }), [])
            return <div>dashboard</div>
        }
        act(() => {
            root.render(
                <MemoryRouter initialEntries={['/mesh']}>
                    <SessionChatDashboardNavigator />
                    <LocationProbe />
                    <Routes>
                        <Route path="/mesh" element={<div>mesh</div>} />
                        <Route path="/dashboard" element={<FakeDashboard />} />
                    </Routes>
                </MemoryRouter>,
            )
        })
        expect(container.textContent).toContain('mesh')
        act(() => { requestOpenSessionChat({ sessionId: 'sess-1', source: 'mesh-topology-panel' }) })
        expect(seen.at(-1)).toBe('/dashboard')
        expect(container.textContent).toContain('dashboard')
        act(() => { vi.advanceTimersByTime(0) })
        expect(received).toEqual([{ sessionId: 'sess-1', source: 'mesh-topology-panel', deferMiss: true }])
    })
})
