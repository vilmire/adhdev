/**
 * Standalone dashboard transcript replica lane (wiring-unification G6
 * prerequisite) — the browser half, with every web-core / DOM dependency
 * injected as a fake. The daemon half is covered in daemon-core
 * (`standalone-transcript-lane.test.ts`, real nodes) and daemon-standalone
 * (`standalone-transcript-lane-e2e.vitest.ts`, real `ws` + auth gate).
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
    LANE_HEALTHY_OPEN_MS,
    LANE_RECONNECT_INITIAL_MS,
    STANDALONE_SEQSCRIBE_WS_PATH,
    SUB_RETRY_INITIAL_MS,
    SUB_RETRY_MAX_MS,
    StandaloneTranscriptLaneClient,
    buildStandaloneSeqscribeWsUrl,
    isStandaloneTranscriptLaneEnabled,
    isStandaloneWsDataFrame,
    type LaneSocket,
    type StandaloneTranscriptLaneDeps,
} from '../src/standalone-transcript-lane.ts'
import { routeStandaloneStatusEvent } from '../src/standalone-status-event.ts'

class FakeSocket implements LaneSocket {
    readyState = 0
    private listeners: Record<string, Array<(ev?: any) => void>> = { open: [], close: [], message: [] }
    closeCalls = 0
    send(): void {}
    close(): void {
        this.closeCalls += 1
        this.fire('close')
    }
    addEventListener(type: string, cb: (ev?: any) => void): void {
        this.listeners[type]!.push(cb)
    }
    fire(type: 'open' | 'close'): void {
        this.readyState = type === 'open' ? 1 : 3
        for (const cb of this.listeners[type]!) cb()
    }
}

interface FakeHost {
    activations: string[][]
    stopped: boolean
    onSnapshot: (message: any) => void
}

function harness(initialInterest: Map<string, string[]> = new Map([['standalone_mach_1', ['s1']]])) {
    const sockets: FakeSocket[] = []
    const hosts: FakeHost[] = []
    const applied: Array<{ daemonId: string; sessionId: string; snapshot: unknown; omittedBefore: boolean }> = []
    const fallbacks: Array<{ daemonId: string; sessionId: string; reason: string }> = []
    const allTimers: Array<{ cb: () => void; ms: number; cleared: boolean; fired: boolean; purpose: string }> = []
    let interest = initialInterest
    let interestListener: (() => void) | null = null
    let clock = 0
    let hostAvailable = true
    const deps: StandaloneTranscriptLaneDeps = {
        createSocket: () => {
            const s = new FakeSocket()
            sockets.push(s)
            return s
        },
        startHost: (_transport, onSnapshot) => {
            if (!hostAvailable) return null
            const host: FakeHost = { activations: [], stopped: false, onSnapshot }
            hosts.push(host)
            return {
                pendingCount: () => 0,
                running: () => !host.stopped,
                activateSessions: (ids: readonly string[]) => { host.activations.push([...ids]) },
                stop: () => { host.stopped = true },
            }
        },
        collectInterest: () => interest,
        subscribeInterest: (listener) => {
            interestListener = listener
            return () => { interestListener = null }
        },
        applySnapshot: (daemonId, sessionId, snapshot, options) => {
            applied.push({ daemonId, sessionId, snapshot, omittedBefore: options.omittedBefore })
            return 1
        },
        reportFallback: (daemonId, sessionId, reason) => { fallbacks.push({ daemonId, sessionId, reason }) },
        setTimer: (cb, ms, purpose) => {
            const t = { cb, ms, cleared: false, fired: false, purpose }
            allTimers.push(t)
            return t
        },
        clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true },
        now: () => clock,
    }
    return {
        client: new StandaloneTranscriptLaneClient(deps),
        sockets, hosts, applied, fallbacks,
        /** Reconnect timers ever scheduled, in order. */
        get timers() { return allTimers.filter((t) => t.purpose === 'reconnect') },
        /** Sub-retry timers that are still pending. */
        pendingSubRetries() { return allTimers.filter((t) => t.purpose === 'sub-retry' && !t.cleared && !t.fired) },
        setInterest(next: Map<string, string[]>) { interest = next; interestListener?.() },
        advance(ms: number) { clock += ms },
        runLastTimer() {
            const reconnects = allTimers.filter((t) => t.purpose === 'reconnect')
            const t = reconnects[reconnects.length - 1]!
            assert.equal(t.cleared, false)
            t.fired = true
            t.cb()
        },
        runSubRetry() {
            const t = allTimers.filter((x) => x.purpose === 'sub-retry' && !x.cleared && !x.fired)[0]!
            t.fired = true
            t.cb()
            return t.ms
        },
        setHostAvailable(v: boolean) { hostAvailable = v },
        hasInterestListener: () => interestListener !== null,
    }
}

function snapshotMessage(sessionId: string, omittedBefore = false) {
    return { kind: 'transcript-bridge-snapshot', sessionId, snapshot: { revision: 7, sessionId }, omittedBefore }
}

describe('standalone transcript lane — wire constants', () => {
    it('dials /ws/seqscribe with the same token /ws uses', () => {
        assert.equal(STANDALONE_SEQSCRIBE_WS_PATH, '/ws/seqscribe')
        assert.equal(buildStandaloneSeqscribeWsUrl({ protocol: 'http:', host: 'localhost:3847' }, null), 'ws://localhost:3847/ws/seqscribe')
        assert.equal(
            buildStandaloneSeqscribeWsUrl({ protocol: 'https:', host: 'box:3847' }, 'a b'),
            'wss://box:3847/ws/seqscribe?token=a%20b',
        )
    })

    it('is on by default; only the explicit off spelling disables it', () => {
        assert.equal(isStandaloneTranscriptLaneEnabled({}), true)
        assert.equal(isStandaloneTranscriptLaneEnabled(undefined), true)
        assert.equal(isStandaloneTranscriptLaneEnabled({ VITE_ADHDEV_TRANSCRIPT_WORKER: 'off' }), false)
        assert.equal(isStandaloneTranscriptLaneEnabled({ VITE_ADHDEV_TRANSCRIPT_WORKER: ' OFF ' }), false)
        assert.equal(isStandaloneTranscriptLaneEnabled({ VITE_ADHDEV_TRANSCRIPT_WORKER: 'on' }), true)
    })

    it('lets the controller report frame onto /ws, and nothing else beyond subscribe/unsubscribe', () => {
        assert.equal(isStandaloneWsDataFrame({ type: 'subscribe', topic: 'session.chat_tail' }), true)
        assert.equal(isStandaloneWsDataFrame({ type: 'unsubscribe', topic: 'x', key: 'k' }), true)
        // The exact frame SessionChatTailController.reportTransportSelection sends.
        assert.equal(isStandaloneWsDataFrame({ type: 'command', commandType: 'report_transcript_transport', data: { selection: 'replica' } }), true)
        assert.equal(isStandaloneWsDataFrame({ type: 'command', commandType: 'send_chat', data: {} }), false)
        assert.equal(isStandaloneWsDataFrame({ type: 'status' }), false)
        assert.equal(isStandaloneWsDataFrame(null), false)
    })
})

describe('StandaloneTranscriptLaneClient', () => {
    it('starts a worker host only once the lane opens, and activates the retained sessions', () => {
        const h = harness()
        h.client.start()
        assert.equal(h.sockets.length, 1)
        assert.equal(h.hosts.length, 0)
        h.sockets[0]!.fire('open')
        assert.equal(h.hosts.length, 1)
        assert.deepEqual(h.hosts[0]!.activations, [['s1']])
    })

    it('feeds every verified snapshot to the controllers of each daemon reading that session', () => {
        const h = harness(new Map([['standalone_mach_1', ['s1', 's2']]]))
        h.client.start()
        h.sockets[0]!.fire('open')
        h.hosts[0]!.onSnapshot(snapshotMessage('s1', true))
        assert.deepEqual(h.applied, [{
            daemonId: 'standalone_mach_1',
            sessionId: 's1',
            snapshot: { revision: 7, sessionId: 's1' },
            omittedBefore: true,
        }])
        // A snapshot for a session nobody retains is not delivered anywhere.
        h.hosts[0]!.onSnapshot(snapshotMessage('s-unknown'))
        assert.equal(h.applied.length, 1)
    })

    it('re-activates the host when the retained session set changes (absolute set, deduped)', () => {
        const h = harness()
        h.client.start()
        h.sockets[0]!.fire('open')
        h.setInterest(new Map([['standalone_mach_1', ['s2', 's1']], ['standalone', ['s1']]]))
        assert.deepEqual(h.hosts[0]!.activations, [['s1'], ['s1', 's2']])
        // Unchanged set → no redundant activation.
        h.setInterest(new Map([['standalone_mach_1', ['s1', 's2']]]))
        assert.equal(h.hosts[0]!.activations.length, 2)
        // s1 now maps to both daemon ids → both controller sets get the snapshot.
        h.setInterest(new Map([['standalone_mach_1', ['s1', 's2']], ['standalone', ['s1']]]))
        h.hosts[0]!.onSnapshot(snapshotMessage('s1'))
        assert.deepEqual(h.applied.map((a) => a.daemonId).sort(), ['standalone', 'standalone_mach_1'])
    })

    it('on lane close: stops the host, labels sessions no_node, and reconnects with backoff + fresh host', () => {
        const h = harness()
        h.client.start()
        h.sockets[0]!.fire('open')
        h.sockets[0]!.fire('close')
        assert.equal(h.hosts[0]!.stopped, true)
        assert.deepEqual(h.fallbacks, [{ daemonId: 'standalone_mach_1', sessionId: 's1', reason: 'no_node' }])
        assert.equal(h.timers.length, 1)
        assert.equal(h.timers[0]!.ms, LANE_RECONNECT_INITIAL_MS)
        h.runLastTimer()
        assert.equal(h.sockets.length, 2)
        h.sockets[1]!.fire('open')
        assert.equal(h.hosts.length, 2)
        assert.deepEqual(h.hosts[1]!.activations, [['s1']])
    })

    it('grows the backoff while lanes keep dying young, and resets it after a healthy lane', () => {
        const h = harness()
        h.client.start()
        // refused upgrade: close without open
        h.sockets[0]!.fire('close')
        h.runLastTimer()
        h.sockets[1]!.fire('close')
        assert.ok(h.timers[1]!.ms > h.timers[0]!.ms)
        h.runLastTimer()
        h.sockets[2]!.fire('open')
        h.advance(LANE_HEALTHY_OPEN_MS)
        h.sockets[2]!.fire('close')
        assert.equal(h.timers[2]!.ms, LANE_RECONNECT_INITIAL_MS)
        // A refused upgrade never started a host, so there is nothing to fall back from.
        assert.equal(h.fallbacks.length, 1)
    })

    it('stop() closes the lane and host without reconnecting or reporting fallback', () => {
        const h = harness()
        h.client.start()
        h.sockets[0]!.fire('open')
        h.client.stop()
        assert.equal(h.sockets[0]!.closeCalls, 1)
        assert.equal(h.hosts[0]!.stopped, true)
        assert.equal(h.timers.length, 0)
        assert.deepEqual(h.fallbacks, [])
        assert.equal(h.hasInterestListener(), false)
    })

    it('gives up (no reconnect loop) when the browser cannot run the transcript worker', () => {
        const h = harness()
        h.setHostAvailable(false)
        h.client.start()
        h.sockets[0]!.fire('open')
        assert.equal(h.client.isHostRunning(), false)
        assert.equal(h.sockets[0]!.closeCalls, 1)
        assert.equal(h.timers.length, 0)
    })
})

describe('re-SUB of sessions whose topic the daemon had not defined yet', () => {
    it('re-arms only undelivered sessions, with doubling cadence, until a snapshot arrives', () => {
        const h = harness(new Map([['standalone_mach_1', ['s1', 's2']]]))
        h.client.start()
        h.sockets[0]!.fire('open')
        h.hosts[0]!.onSnapshot(snapshotMessage('s1'))
        assert.equal(h.pendingSubRetries().length, 1)
        const first = h.runSubRetry()
        assert.equal(first, SUB_RETRY_INITIAL_MS)
        // close+reopen exactly s2's subscription; the delivered s1 stays subscribed throughout.
        assert.deepEqual(h.hosts[0]!.activations, [['s1', 's2'], ['s1'], ['s1', 's2']])
        assert.equal(h.pendingSubRetries()[0]!.ms, SUB_RETRY_INITIAL_MS * 2)
        h.hosts[0]!.onSnapshot(snapshotMessage('s2'))
        h.runSubRetry()
        // everything delivered → no further re-SUB and no further timer
        assert.equal(h.hosts[0]!.activations.length, 3)
        assert.equal(h.pendingSubRetries().length, 0)
    })

    it('caps the re-SUB cadence and cancels it with the host', () => {
        const h = harness()
        h.client.start()
        h.sockets[0]!.fire('open')
        let last = 0
        for (let i = 0; i < 10; i++) last = h.runSubRetry()
        assert.equal(last, SUB_RETRY_MAX_MS)
        h.sockets[0]!.fire('close')
        assert.equal(h.pendingSubRetries().length, 0)
    })
})

describe('status_event → transcript watchdog (D1 parity with web-cloud)', () => {
    it('routes a status event with a target session to the watchdog as well as the event manager', () => {
        const events: unknown[] = []
        const watched: Array<[string, string, unknown]> = []
        routeStandaloneStatusEvent(
            { type: 'status_event', payload: { event: 'agent:generating_completed', targetSessionId: 's1' } },
            'standalone_mach_1',
            { handleRawEvent: (p) => { events.push(p) } },
            (daemonId, sessionId, event) => { watched.push([daemonId, sessionId, event]) },
        )
        assert.equal(events.length, 1)
        assert.deepEqual(watched, [['standalone_mach_1', 's1', 'agent:generating_completed']])
    })
})
