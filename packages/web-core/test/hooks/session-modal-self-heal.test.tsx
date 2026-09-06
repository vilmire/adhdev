// @vitest-environment jsdom
//
// (STATUS-LANE-SELFHEAL) The status lane must recover from a DROPPED push.
//
// WHY THIS FILE EXISTS: `useSessionModalSubscription` was push-only. It had no
// watchdog, no `visibilitychange`, no `pageshow`, no reconnect re-pull and no
// lease — its effect deps were `[daemonId, routeId, sessionId, sendData]` and
// nothing else. So a single lost `session.modal` update left the pane showing
// "Agent generating…" until unmount, which is exactly the symptom the owner
// observed after a coordinator had already finished replying.
//
// The transcript lane next door (session-chat-tail-controller) already had all
// of these recovery edges. This asserts the status lane now has them too.
//
// ★ The assertions are deliberately about RE-SUBSCRIBING, not about polling.
// Recovery must ride the existing SubscriptionManager contract (the daemon
// answers a subscribe with current state), and must not introduce a timer —
// iOS suspends background timers, which is precisely the environment where the
// resume path has to work.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionModalSubscription } from '../../src/hooks/useSessionModalSubscription'
import type { ActiveConversation } from '../../src/components/dashboard/types'

const DAEMON_ID = 'daemon_alpha'
const SESSION_ID = 'sess_1'

// Records every payload the hook hands to the transport, so a "subscribe" send
// is distinguishable from silence.
let sent: Array<{ daemonId: string; data: any }> = []
let connected = true

const sendData = vi.fn((daemonId: string, data: any) => {
    sent.push({ daemonId, data })
    return true
})

vi.mock('../../src/context/TransportContext', () => ({
    useTransport: () => ({
        sendData,
        isConnected: (_id: string) => connected,
    }),
}))

// The real SubscriptionManager is used deliberately — re-subscription is the
// mechanism under test, so stubbing it would assert nothing.
import { subscriptionManager } from '../../src/managers/SubscriptionManager'

function conversation(): ActiveConversation {
    return {
        daemonId: DAEMON_ID,
        routeId: `${DAEMON_ID}:${SESSION_ID}`,
        sessionId: SESSION_ID,
        tabKey: 'tab-1',
    } as unknown as ActiveConversation
}

let container: HTMLDivElement
let root: Root
let observed: { status?: string } = {}

function Probe() {
    observed = useSessionModalSubscription(conversation())
    return null
}

function mount() {
    act(() => {
        root.render(<Probe />)
    })
}

/** Deliver a `session.modal` update the way the transport would. */
function pushModal(status: string) {
    act(() => {
        subscriptionManager.publish({
            topic: 'session.modal',
            key: `daemon:${DAEMON_ID}:session-modal:${SESSION_ID}`,
            status,
        } as any)
    })
}

function subscribeSends() {
    return sent.filter((s) => s.data?.type === 'subscribe' && s.data?.topic === 'session.modal')
}

beforeEach(() => {
    sent = []
    connected = true
    sendData.mockClear()
    observed = {}
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
})

describe('status lane self-heal', () => {
    it('★ recovers a DROPPED push when the tab returns to visible', () => {
        mount()
        // Live state arrives normally.
        pushModal('generating')
        expect(observed.status).toBe('generating')

        const beforeResync = subscribeSends().length

        // ── The defect: the daemon's "idle" push is LOST in flight. ──────────
        // Nothing is delivered, so the pane is now stale — it still says
        // "generating" for a session that has actually finished.
        expect(observed.status).toBe('generating')

        // The user backgrounds the app and returns.
        act(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
            document.dispatchEvent(new Event('visibilitychange'))
        })

        // ★ RED WITHOUT THE FIX: the push-only hook sends nothing here, so the
        // daemon is never asked again and the pane stays stale forever.
        expect(subscribeSends().length).toBeGreaterThan(beforeResync)

        // And the re-subscribe is what carries the truth back.
        pushModal('idle')
        expect(observed.status).toBe('idle')
    })

    it('★ recovers on a BFCache restore (iOS app-switch return)', () => {
        mount()
        pushModal('generating')
        const before = subscribeSends().length

        // iOS fires `pageshow{persisted:true}` INSTEAD of visibilitychange on
        // the app-switch return path. Before this fix `useShellFreshness` was
        // the only `pageshow` listener in the whole repo, so both data lanes
        // were blind to this resume.
        act(() => {
            const ev = new Event('pageshow') as any
            ev.persisted = true
            window.dispatchEvent(ev)
        })

        expect(subscribeSends().length).toBeGreaterThan(before)
    })

    it('does NOT re-subscribe on a non-persisted pageshow', () => {
        // A normal load already subscribed via the mount effect; re-arming there
        // would be a redundant send on every navigation.
        mount()
        const before = subscribeSends().length

        act(() => {
            const ev = new Event('pageshow') as any
            ev.persisted = false
            window.dispatchEvent(ev)
        })

        expect(subscribeSends().length).toBe(before)
    })

    it('★ re-subscribes on the transport reconnect edge', () => {
        mount()
        pushModal('generating')

        // Connection drops — the daemon-side subscription is gone with it.
        connected = false
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })
        const afterDrop = subscribeSends().length

        // Reconnect. The subscription must be re-established, because the
        // daemon no longer knows this client wants session.modal.
        connected = true
        act(() => {
            window.dispatchEvent(new Event('online'))
        })

        expect(subscribeSends().length).toBeGreaterThan(afterDrop)
    })

    it('installs NO timer — recovery is edge-driven only', () => {
        // iOS suspends background timers, so a watchdog interval is exactly the
        // mechanism that cannot be relied on for the resume this fixes.
        const setInterval = vi.spyOn(globalThis, 'setInterval')
        mount()
        pushModal('generating')
        expect(setInterval).not.toHaveBeenCalled()
        setInterval.mockRestore()
    })
})
