import { describe, expect, it } from 'vitest'
import {
    WORKER_PROTOCOL_FOOTER_MARKER,
    appendWorkerProtocolFooter,
    hasWorkerProtocolFooter,
    renderCoordinatorWorkerSection,
    renderWorkerProtocolFooter,
    stripWorkerProtocolFooter,
} from '../src/worker-protocol'
import type { MissionBrief } from '../src/mission-brief'

/**
 * Wiring-unification Phase H2: `renderWorkerProtocolFooter` gained an optional
 * `missionBrief` input, rendered ABOVE the marker line. These tests pin that
 * the marker-based idempotency/strip contract (pre-existing, covered in
 * `vocabularies.test.ts`) is unchanged by the addition, and cover the new
 * brief-rendering behavior itself.
 */

const BRIEF: MissionBrief = { goal: 'Ship the thing', constraints: ['no npm install'] }

describe('renderWorkerProtocolFooter — missionBrief (H2)', () => {
    it('omits any brief block when missionBrief is not provided (unchanged default behavior)', () => {
        const footer = renderWorkerProtocolFooter({ taskId: 't1' })
        expect(footer.startsWith(WORKER_PROTOCOL_FOOTER_MARKER)).toBe(true)
        expect(footer).not.toContain('Mission goal:')
    })

    it('renders the brief block strictly above the marker line', () => {
        const footer = renderWorkerProtocolFooter({ taskId: 't1', missionBrief: BRIEF })
        const briefIdx = footer.indexOf('Mission goal: Ship the thing')
        const markerIdx = footer.indexOf(WORKER_PROTOCOL_FOOTER_MARKER)
        expect(briefIdx).toBeGreaterThanOrEqual(0)
        expect(markerIdx).toBeGreaterThan(briefIdx)
        expect(footer).toContain('- no npm install')
    })

    it('hasWorkerProtocolFooter is unaffected by a brief block (marker presence alone decides it)', () => {
        const withBrief = renderWorkerProtocolFooter({ taskId: 't1', missionBrief: BRIEF })
        const withoutBrief = renderWorkerProtocolFooter({ taskId: 't1' })
        expect(hasWorkerProtocolFooter(withBrief)).toBe(true)
        expect(hasWorkerProtocolFooter(withoutBrief)).toBe(true)
        // hasWorkerProtocolFooter is a substring test on the marker alone — a
        // string that HAS a brief block prepended but no marker must still read
        // as footer-less, proving detection never keys off the brief's presence.
        expect(hasWorkerProtocolFooter('Mission goal: g\n\nno marker here')).toBe(false)
    })

    it('appendWorkerProtocolFooter with a brief is idempotent (second append is a no-op) because idempotency still keys off the marker', () => {
        const once = appendWorkerProtocolFooter('Do the thing.', { taskId: 't1', missionBrief: BRIEF })
        expect(hasWorkerProtocolFooter(once)).toBe(true)
        expect(once).toContain('Mission goal: Ship the thing')
        const twice = appendWorkerProtocolFooter(once, { taskId: 't1', missionBrief: BRIEF })
        expect(twice).toBe(once)
    })

    it('stripWorkerProtocolFooter cuts at the marker: a brief block, sitting ABOVE it, is treated as authored content and survives the strip', () => {
        // This is the deliberate placement decision (see module doc): the brief is
        // from the coordinator's point of view, like the task message itself — not
        // part of the protocol contract the marker demarcates. So stripping an
        // appended footer-with-brief does NOT recover the pre-brief authored text;
        // it recovers "authored text + brief", which is correct because the brief
        // was rendered as content above the marker, not inside the protocol block.
        const authored = 'Do the thing.'
        const withFooter = appendWorkerProtocolFooter(authored, { taskId: 't1', missionBrief: BRIEF })
        const stripped = stripWorkerProtocolFooter(withFooter)
        expect(stripped.startsWith(authored)).toBe(true)
        expect(stripped).toContain('Mission goal: Ship the thing')
        expect(stripped).not.toContain(WORKER_PROTOCOL_FOOTER_MARKER)
    })

    it('stripWorkerProtocolFooter with no brief still recovers exactly the authored text (pre-existing contract, unchanged)', () => {
        const authored = 'Do the thing.'
        const withFooter = appendWorkerProtocolFooter(authored, { taskId: 't1' })
        expect(stripWorkerProtocolFooter(withFooter)).toBe(authored)
    })
})

describe('renderCoordinatorWorkerSection — owned_paths mention (H1 integration)', () => {
    it('mentions owned_paths enforcement at claim time and touched_files comparison', () => {
        const section = renderCoordinatorWorkerSection()
        expect(section).toMatch(/owned_paths/)
        expect(section).toMatch(/claim time/)
        expect(section).toMatch(/touched_files/)
    })
})
