// The browser transcript worker ships INERT (design §8 unit 4: foundation
// only; consumer cutover is unit 5). These cases pin the fail-closed default,
// because the failure mode of getting it wrong is invisible in tests but very
// visible in production: an accidental `on` spawns a Worker, takes an
// exclusive OPFS lock, and makes the daemon dial a seqscribe data channel for
// every dashboard peer, all to feed a replica nothing reads yet.
import { describe, expect, it } from 'vitest'
import { isTranscriptWorkerEnabled } from '../../src/transcript-transport/web-transcript-flag.js'

describe('isTranscriptWorkerEnabled', () => {
    it('defaults to OFF when the flag is absent', () => {
        expect(isTranscriptWorkerEnabled({})).toBe(false)
        expect(isTranscriptWorkerEnabled({ VITE_ADHDEV_TRANSCRIPT_WORKER: undefined })).toBe(false)
    })

    it('enables only on the exact string "on", case/whitespace insensitive', () => {
        for (const raw of ['on', 'ON', 'On', ' on ', '\ton\n']) {
            expect(isTranscriptWorkerEnabled({ VITE_ADHDEV_TRANSCRIPT_WORKER: raw })).toBe(true)
        }
    })

    it('fails closed on truthy-looking values that are not "on"', () => {
        // ★ `true`/`1`/`yes` are the values someone reaches for by habit. They
        // must NOT work: there is exactly one spelling, so an approximate
        // setting stays off rather than silently arming the transport.
        for (const raw of ['true', '1', 'yes', 'enabled', 'shadow', 'primary', 'off', '']) {
            expect(isTranscriptWorkerEnabled({ VITE_ADHDEV_TRANSCRIPT_WORKER: raw })).toBe(false)
        }
    })

    it('fails closed on non-string values', () => {
        for (const raw of [true, 1, {}, [], null]) {
            expect(isTranscriptWorkerEnabled({ VITE_ADHDEV_TRANSCRIPT_WORKER: raw })).toBe(false)
        }
    })
})
