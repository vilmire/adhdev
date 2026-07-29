import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcileIdes } from '../../src/context/BaseDaemonContext'
import type { DaemonData } from '../../src/types'

/**
 * Regression tests for the cross-clock-domain comparison in the equal-richness
 * branch of reconcileIdes.
 *
 * `ide.timestamp` is the DAEMON's remote clock; `existing._lastUpdate` is the
 * BROWSER's local Date.now() stamped at merge time. When the device clock runs
 * ahead of the daemon (e.g. a phone), `_lastUpdate` lands in the "future" of
 * every daemon timestamp, so the legacy comparison `(ide.timestamp || now) >=
 * (existing._lastUpdate || ...)` rejected every fresh remote payload and a
 * stale status (working/generating) pinned forever. The fix compares remote
 * update ordering against `existing.timestamp` (also daemon-clock) whenever
 * both sides carry a remote timestamp, falling back to the legacy comparison
 * only when either side lacks one.
 */

// Daemon clock base — deliberately far BELOW the mocked phone clock so the
// phone's `_lastUpdate` stamps sit in the "future" of every daemon timestamp.
const DAEMON_T0 = 1_000_000
const PHONE_NOW = 9_999_999_999_999

function sessionEntry(overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id: 'node-1:cli:term-1',
        daemonId: 'node-1',
        type: 'cli',
        timestamp: DAEMON_T0,
        workspace: '/repo/adhdev',
        ...overrides,
    } as DaemonData
}

describe('reconcileIdes — equal-richness clock-domain compare (device clock ahead)', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('fresh idle incoming WINS even though _lastUpdate was stamped by a clock far ahead of the daemon', () => {
        vi.useFakeTimers()
        vi.setSystemTime(PHONE_NOW)

        // Seed the stale working entry; reconcile stamps _lastUpdate with the
        // phone's local clock — far ahead of any daemon timestamp.
        const prev = reconcileIdes([sessionEntry({ status: 'generating', timestamp: DAEMON_T0 })], [])
        expect(prev[0]._lastUpdate).toBe(PHONE_NOW)

        // Fresh daemon payload: session went idle, newer REMOTE timestamp.
        // Legacy compare: DAEMON_T0+1000 >= PHONE_NOW is false (stale pins).
        // Remote-domain compare: DAEMON_T0+1000 >= DAEMON_T0 is true (merge).
        const result = reconcileIdes([sessionEntry({ status: 'idle', timestamp: DAEMON_T0 + 1000 })], prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.status).toBe('idle')
        expect(entry?.timestamp).toBe(DAEMON_T0 + 1000)
    })

    it('genuinely older incoming remote timestamp still loses', () => {
        vi.useFakeTimers()
        vi.setSystemTime(PHONE_NOW)

        const prev = reconcileIdes([sessionEntry({ status: 'generating', timestamp: DAEMON_T0 })], [])
        const result = reconcileIdes([sessionEntry({ status: 'idle', timestamp: DAEMON_T0 - 1000 })], prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.status).toBe('generating')
        expect(entry?.timestamp).toBe(DAEMON_T0)
    })

    it('tracks the last merged remote timestamp on the existing entry across sequential merges', () => {
        vi.useFakeTimers()
        vi.setSystemTime(PHONE_NOW)

        // All entries carry activeChat so every step stays in the EQUAL-richness
        // branch (a merged entry stores activeChat:null, which payloadRichness
        // counts as defined — a bare replay would take the weak-metadata path,
        // which is designed to apply status updates and is not what this tests).
        const chat = (status: string) => ({ messages: [], status }) as DaemonData['activeChat']
        let state = reconcileIdes([sessionEntry({ status: 'generating', timestamp: DAEMON_T0, activeChat: chat('generating') })], [])
        state = reconcileIdes([sessionEntry({ status: 'idle', timestamp: DAEMON_T0 + 1000, activeChat: chat('idle') })], state)
        expect(state[0].status).toBe('idle')
        expect(state[0].timestamp).toBe(DAEMON_T0 + 1000)

        // A replayed older snapshot (still newer than the original daemon ts)
        // must lose against the last merged remote timestamp.
        state = reconcileIdes([sessionEntry({ status: 'generating', timestamp: DAEMON_T0 + 500, activeChat: chat('generating') })], state)
        expect(state[0].status).toBe('idle')
        expect(state[0].timestamp).toBe(DAEMON_T0 + 1000)
    })

    it('fallback: when the incoming payload lacks a remote timestamp the legacy local-clock comparison applies', () => {
        vi.useFakeTimers()
        vi.setSystemTime(PHONE_NOW)

        const prev = reconcileIdes([sessionEntry({ status: 'generating', timestamp: DAEMON_T0 })], [])
        // No remote timestamp on the incoming payload → legacy path:
        // incomingTs = now (phone clock) >= existingTs = _lastUpdate → merge,
        // exactly as timestamp-less payload flows behaved before the fix.
        const incoming = sessionEntry({ status: 'idle' })
        delete incoming.timestamp
        const result = reconcileIdes([incoming], prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.status).toBe('idle')
    })

    it('richness invariant unchanged: a weak payload still cannot overwrite rich chat data', () => {
        vi.useFakeTimers()
        vi.setSystemTime(PHONE_NOW)

        const prev = reconcileIdes([
            sessionEntry({
                timestamp: DAEMON_T0,
                activeChat: { messages: [{ role: 'assistant', content: 'hi' }], status: 'idle' } as DaemonData['activeChat'],
            }),
        ], [])

        // Weak incoming (no workspace / activeChat → richness 0) with a NEWER
        // remote timestamp: must never discard the rich fields, regardless of
        // which clock-domain comparison the equal-richness branch would make.
        const weak = {
            id: 'node-1:cli:term-1',
            daemonId: 'node-1',
            type: 'cli',
            timestamp: DAEMON_T0 + 5000,
        } as DaemonData
        const result = reconcileIdes([weak], prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.activeChat).toBeDefined()
        expect(entry?.workspace).toBe('/repo/adhdev')
    })

    it('richness invariant unchanged: a richer incoming payload still wins outright', () => {
        vi.useFakeTimers()
        vi.setSystemTime(PHONE_NOW)

        const prev = reconcileIdes([sessionEntry({ status: 'generating', timestamp: DAEMON_T0 })], [])
        const richer = sessionEntry({
            status: 'idle',
            timestamp: DAEMON_T0 + 1000,
            activeChat: { messages: [], status: 'idle' } as DaemonData['activeChat'],
        })
        const result = reconcileIdes([richer], prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.status).toBe('idle')
        expect(entry?.activeChat).toBeDefined()
    })
})
