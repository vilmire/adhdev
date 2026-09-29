/**
 * First-paint latency of the keyed chat lane — browser half, virtual clock.
 *
 * The real `StandaloneTranscriptLaneClient` runs against a simulated daemon
 * that follows seqscribe's rule: a SUB for a topic the lane does not grant
 * yet is refused ONCE and never retried; only a fresh SUB (the client's
 * deactivate → reactivate) can succeed after the topic is defined.
 *
 * Measured, for the same two scenarios:
 *   BEFORE — the pre-fix pair: the daemon defines a session's topic only on
 *            its first publish or on a `request_transcript_base`, sends no
 *            availability push, and the client re-SUBs on 3 s → 60 s backoff.
 *   AFTER  — the daemon defines the topic when the session registers and
 *            pushes `transcript_topics_available`; the client re-SUBs on it.
 *   AFTER (push lost) — the retry fallback alone, at its new 1 s first step.
 *
 * Scenario 1 (live repro): lane attached, pane open, the session's topic
 * appears later (session registered at 10 s, first publish at 10.5 s).
 * Scenario 2: daemon restart with an IDLE session — restored (registered) 2 s
 * after the lane re-attached, and never publishes.
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
    StandaloneTranscriptLaneClient,
    type LaneSocket,
    type StandaloneTranscriptLaneDeps,
} from '../src/standalone-transcript-lane.ts'
import {
    TRANSCRIPT_TOPICS_AVAILABLE_TYPE,
    parseTranscriptTopicsAvailable,
    sessionsToResubscribeOnAvailable,
} from '../../web-core/src/transcript-transport/topic-availability.ts'
import { sessionChatTopic } from '../../web-core/src/transcript-transport/topic-addressing.ts'

const DAEMON = 'standalone_mach_1'
const SESSION = 's1'
/** One-way latency of any frame (lane or /ws) in the simulation. */
const WIRE_MS = 20

interface DaemonModel {
    /** New daemon: `registered` defines the topic (warmSession). */
    readonly definesOnRegister: boolean
    /** New daemon: `transcript_topics_available` is sent (and delivered). */
    readonly pushes: boolean
}

interface Scenario {
    readonly registerAt: number
    /** First publish, or null for an idle session that never publishes. */
    readonly publishAt: number | null
    /** When the lane opens (default 0 — attached before the session exists). */
    readonly laneOpenAt?: number
}

function simulate(daemon: DaemonModel, scenario: Scenario, schedule?: { initialMs: number; maxMs: number }, horizonMs = 120_000) {
    let now = 0
    let seq = 0
    const queue: Array<{ at: number; seq: number; cb: () => void; cleared: boolean }> = []
    const at = (ms: number, cb: () => void) => {
        const t = { at: now + ms, seq: seq++, cb, cleared: false }
        queue.push(t)
        return t
    }

    let registered = false
    let defined = false
    let firstViewAt: number | null = null
    let definedAt: number | null = null
    let subs = 0
    let availabilityListener: ((topics: readonly string[]) => void) | null = null
    let onView: ((u: any) => void) | null = null
    let activation = new Set<string>()

    const define = () => {
        if (defined) return
        defined = true
        definedAt = now
        if (daemon.pushes) {
            // Grant first, then the /ws frame (daemon-core StandaloneTranscriptLane order).
            const frame = { type: TRANSCRIPT_TOPICS_AVAILABLE_TYPE, topics: [sessionChatTopic(SESSION)] }
            at(WIRE_MS, () => {
                const topics = parseTranscriptTopicsAvailable(JSON.parse(JSON.stringify(frame)))
                if (topics) availabilityListener?.(topics)
            })
        }
    }
    const sub = () => {
        subs += 1
        // The SUB reaches the daemon one wire hop later; refused unless defined then.
        at(WIRE_MS, () => {
            if (!defined) return // SUB_ERR ERR_ACL_DENIED — never retried by seqscribe
            at(WIRE_MS, () => onView?.({ sessionId: SESSION, view: { frame: 1, sessionId: SESSION }, reset: true }))
        })
    }

    at(scenario.registerAt, () => {
        registered = true
        if (daemon.definesOnRegister) define()
    })
    if (scenario.publishAt !== null) at(scenario.publishAt, () => { if (registered) define() })

    const socket: LaneSocket & { fire(t: 'open'): void } = {
        readyState: 0,
        send() {},
        close() {},
        listeners: { open: [] as Array<() => void> },
        addEventListener(type: string, cb: any) { if (type === 'open') (this as any).listeners.open.push(cb) },
        fire() { (this as any).readyState = 1; for (const cb of (this as any).listeners.open) cb() },
    } as any

    const deps: StandaloneTranscriptLaneDeps = {
        createSocket: () => socket,
        startHost: (_t, view) => {
            onView = view
            return {
                pendingCount: () => 0,
                running: () => true,
                activateSessions: (ids: readonly string[]) => {
                    const next = new Set(ids)
                    for (const id of next) if (!activation.has(id)) sub()
                    activation = next
                },
                view: () => null,
                stop: () => {},
            }
        },
        collectInterest: () => new Map([[DAEMON, [SESSION]]]),
        subscribeInterest: () => () => undefined,
        applyView: () => {
            if (firstViewAt === null) firstViewAt = now
            return 1
        },
        // The old daemon's only other definition path: a base request for a
        // registered session (requestBase → readPersistedChat → activate).
        // `request_transcript_base` is a /ws COMMAND (dispatch + stateFor →
        // readPersistedChat → activate), the SUB a library frame on the lane:
        // sent in the same tick, the SUB lands first — which is why a retry
        // that base-requests and re-SUBs together still gets refused once.
        requestBase: () => {
            at(3 * WIRE_MS, () => { if (registered) define() })
            return true
        },
        ...(daemon.pushes
            ? {
                subscribeTopicsAvailable: (listener: (topics: readonly string[]) => void) => {
                    availabilityListener = listener
                    return () => { availabilityListener = null }
                },
                selectResubscribe: sessionsToResubscribeOnAvailable,
            }
            : {}),
        setTimer: (cb, ms) => at(ms, cb),
        clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true },
        now: () => now,
        ...(schedule ? { subRetrySchedule: schedule } : {}),
    }

    const client = new StandaloneTranscriptLaneClient(deps)
    client.start()
    at(scenario.laneOpenAt ?? 0, () => socket.fire('open'))

    while (firstViewAt === null) {
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = queue.shift()
        if (!next || next.at > horizonMs) break
        if (next.cleared) continue
        now = next.at
        next.cb()
    }
    client.stop()
    return { firstViewAt, definableAt: Math.max(scenario.registerAt, scenario.laneOpenAt ?? 0), definedAt, subs }
}

const BEFORE_DAEMON: DaemonModel = { definesOnRegister: false, pushes: false }
const AFTER_DAEMON: DaemonModel = { definesOnRegister: true, pushes: true }
const PUSH_LOST: DaemonModel = { definesOnRegister: true, pushes: false }
const BEFORE_SCHEDULE = { initialMs: 3_000, maxMs: 60_000 }

function report(label: string, r: ReturnType<typeof simulate>): number {
    assert.notEqual(r.firstViewAt, null, `${label}: never painted`)
    const latency = r.firstViewAt! - r.definableAt
    console.info(`[first-paint] ${label}: first view at ${r.firstViewAt} ms (${latency} ms after the session existed and the lane was open; SUBs=${r.subs})`)
    return latency
}

describe('keyed chat first paint — lane client (virtual clock)', () => {
    it('scenario 1 — lane attached, topic appears 10 s later: push paints within one round trip', () => {
        const scenario: Scenario = { registerAt: 10_000, publishAt: 10_500 }
        const before = report('S1 BEFORE (lazy define, 3s→60s retry)', simulate(BEFORE_DAEMON, scenario, BEFORE_SCHEDULE))
        const after = report('S1 AFTER (define on register + push)', simulate(AFTER_DAEMON, scenario))
        const fallback = report('S1 AFTER, push lost (1s retry only)', simulate(PUSH_LOST, scenario))
        assert.ok(before >= 5_000, `before should reproduce the multi-second blank pane, got ${before}`)
        assert.ok(after <= 100, `after must paint within ~2 wire round trips, got ${after}`)
        assert.ok(fallback <= 6_000 && fallback < before, `fallback must beat before, got ${fallback}`)
    })

    it('scenario 2 — daemon restart, IDLE session restored 2 s after the lane re-attached', () => {
        const scenario: Scenario = { registerAt: 2_000, publishAt: null }
        const before = report('S2 BEFORE (idle never publishes)', simulate(BEFORE_DAEMON, scenario, BEFORE_SCHEDULE))
        const after = report('S2 AFTER (define on restore + push)', simulate(AFTER_DAEMON, scenario))
        const fallback = report('S2 AFTER, push lost (1s retry only)', simulate(PUSH_LOST, scenario))
        assert.ok(before >= 5_000, `before: ${before}`)
        assert.ok(after <= 100, `after: ${after}`)
        assert.ok(fallback < before, `fallback: ${fallback}`)
    })

    it('fresh page on an already-registered session: the first SUB succeeds, no retry and no push needed', () => {
        const r = simulate(AFTER_DAEMON, { registerAt: 0, publishAt: null, laneOpenAt: 5_000 })
        assert.equal(report('fresh page, topic defined at register', r), 2 * WIRE_MS)
        assert.equal(r.subs, 1)
    })

    it('a push for a DELIVERED session or a foreign topic re-SUBs nothing', () => {
        assert.deepEqual(sessionsToResubscribeOnAvailable(['a', 'b'], new Set(['a']), [sessionChatTopic('a')]), [])
        assert.deepEqual(sessionsToResubscribeOnAvailable(['a', 'b'], new Set(), [sessionChatTopic('zzz')]), [])
        assert.deepEqual(sessionsToResubscribeOnAvailable(['a', 'b'], new Set(), [sessionChatTopic('b')]), ['b'])
        assert.equal(parseTranscriptTopicsAvailable({ type: TRANSCRIPT_TOPICS_AVAILABLE_TYPE, topics: [1] }), null)
        assert.equal(parseTranscriptTopicsAvailable({ type: 'other', topics: [] }), null)
    })
})
