import { describe, expect, it } from 'vitest'
import {
    STATUS_PROBE_ARG_KEY,
    withStatusProbeMarker,
    argsCarryStatusProbeMarker,
    stripStatusProbeMarker,
} from '../src/mesh-status-probe'

describe('mesh-status-probe marker (OFFLINE-NODE-STATUS-REFRESH)', () => {
    it('withStatusProbeMarker stamps the marker without mutating the input', () => {
        const args = { workspace: '/w', refreshUpstream: true }
        const marked = withStatusProbeMarker(args)
        expect(marked[STATUS_PROBE_ARG_KEY]).toBe(true)
        expect(marked).toMatchObject({ workspace: '/w', refreshUpstream: true })
        // input untouched
        expect(STATUS_PROBE_ARG_KEY in args).toBe(false)
    })

    it('withStatusProbeMarker defaults to an empty base', () => {
        expect(withStatusProbeMarker()).toEqual({ [STATUS_PROBE_ARG_KEY]: true })
    })

    it('argsCarryStatusProbeMarker only matches an explicit boolean-true marker', () => {
        expect(argsCarryStatusProbeMarker({ [STATUS_PROBE_ARG_KEY]: true })).toBe(true)
        expect(argsCarryStatusProbeMarker({ [STATUS_PROBE_ARG_KEY]: false })).toBe(false)
        expect(argsCarryStatusProbeMarker({ [STATUS_PROBE_ARG_KEY]: 'true' })).toBe(false)
        expect(argsCarryStatusProbeMarker({})).toBe(false)
        expect(argsCarryStatusProbeMarker(undefined)).toBe(false)
        expect(argsCarryStatusProbeMarker(null)).toBe(false)
    })

    it('stripStatusProbeMarker removes the marker and preserves real args', () => {
        const marked = withStatusProbeMarker({ workspace: '/w', refreshUpstream: true })
        const stripped = stripStatusProbeMarker(marked)
        expect(STATUS_PROBE_ARG_KEY in stripped).toBe(false)
        expect(stripped).toEqual({ workspace: '/w', refreshUpstream: true })
    })

    it('stripStatusProbeMarker returns the same reference when no marker is present', () => {
        const clean = { workspace: '/w' }
        expect(stripStatusProbeMarker(clean)).toBe(clean)
    })

    it('round-trips: stamp → detect → strip', () => {
        const stamped = withStatusProbeMarker({ a: 1 })
        expect(argsCarryStatusProbeMarker(stamped)).toBe(true)
        const clean = stripStatusProbeMarker(stamped)
        expect(argsCarryStatusProbeMarker(clean)).toBe(false)
        expect(clean).toEqual({ a: 1 })
    })
})
