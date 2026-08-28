// @vitest-environment jsdom
//
// seqscribe Beacon advisory badge (design §7.1, mission b60d70b8).
//
// ── What this file exists to prevent ────────────────────────────────────────
// The badge's whole job is to carry a THREE-VALUED sole-copy verdict to the
// screen without collapsing it. §7.1.2.1 requires judgement to be DEFERRED when
// the server truncated the peer board, because the peer list compared against
// is then only part of the fleet. Two opposite UI regressions would each undo
// that, and both look reasonable in a diff:
//
//   - treating `'unknown'` as "fine" (hiding the badge) tells the user their
//     data is replicated when nothing established that;
//   - treating `'unknown'` as "sole copy" invents a data-loss scare.
//
// So the deferred case is asserted as its own rendering, in both directions.
//
// The other assertions are the quiet-by-default property: a healthy machine,
// a machine with no board yet, and every WS-only machine (beacon rides P2P
// alone) must render exactly nothing, so this never becomes chrome on cards
// that have nothing to say.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import BeaconAdvisoryBadge from '../../src/components/BeaconAdvisoryBadge'
import type { BeaconDiagnosticsSummary } from '../../src/types'

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

function render(beacon?: BeaconDiagnosticsSummary): void {
    act(() => {
        root.render(<BeaconAdvisoryBadge beacon={beacon} />)
    })
}

/** A fresh board — `boardAt` is "now" so the badge does not suppress on staleness. */
function beaconFixture(over: Partial<BeaconDiagnosticsSummary> = {}): BeaconDiagnosticsSummary {
    return {
        node: 'adhdev-1111111111111111',
        peers: [],
        maxBehind: 0,
        soleCopy: [],
        truncated: 0,
        soleCopyDeferred: false,
        topicScope: ['fleet.status'],
        boardAt: new Date().toISOString(),
        keyStaleAdvisory: [],
        ...over,
    }
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe('BeaconAdvisoryBadge — quiet unless it has something to say', () => {
    it('renders nothing when no beacon is present (the WS-only / standalone case)', () => {
        render(undefined)
        expect(container.textContent).toBe('')
    })

    it('renders nothing for a healthy, caught-up machine', () => {
        render(beaconFixture())
        expect(container.textContent).toBe('')
    })

    it('renders nothing when no board has arrived yet', () => {
        // boardAt null = the beacon armed but no GET has succeeded. "I do not
        // know" must not be drawn as a finding.
        render(beaconFixture({ boardAt: null, maxBehind: 99 }))
        expect(container.textContent).toBe('')
    })

    it('renders nothing when the board is older than the TTL', () => {
        // An idle daemon's board is SUPPOSED to age — the beacon only pushes
        // after an append — so a stale board is "quiet", not a stale claim.
        render(
            beaconFixture({
                boardAt: new Date(Date.now() - 10 * 60_000).toISOString(),
                maxBehind: 99,
            }),
        )
        expect(container.textContent).toBe('')
    })
})

describe('BeaconAdvisoryBadge — ①wake-up lag', () => {
    it('shows the behind badge with the entry count and names the worst topic in the tooltip', () => {
        render(
            beaconFixture({
                maxBehind: 42,
                peers: [
                    {
                        node: 'adhdev-2222222222222222',
                        behind: 42,
                        topics: [
                            { node: 'adhdev-2222222222222222', topic: 'mesh.mesh_abc.events', behind: 42 },
                        ],
                        lastSeen: new Date().toISOString(),
                    },
                ],
            }),
        )

        expect(q('beacon-behind-badge')).not.toBeNull()
        expect(q('beacon-behind-badge')!.textContent).toContain('42')
        const tooltip = container.querySelector('[title]')!.getAttribute('title')!
        expect(tooltip).toContain('42')
        expect(tooltip).toContain('mesh.mesh_abc.events')
    })
})

describe('BeaconAdvisoryBadge — ③sole-copy awareness', () => {
    const soleCopy = beaconFixture({
        soleCopy: [
            {
                topic: 'mesh.mesh_abc.events',
                writer: 'adhdev-1111111111111111',
                localSeq: 20,
                bestPeerSeq: 12,
                unreplicated: 8,
                verdict: 'sole-copy',
            },
        ],
    })

    it('shows the sole-copy badge for a CONFIRMED unreplicated position', () => {
        render(soleCopy)

        expect(q('beacon-sole-copy-badge')).not.toBeNull()
        expect(q('beacon-deferred-badge')).toBeNull()
        expect(container.querySelector('[title]')!.getAttribute('title')).toContain('8')
    })
})

describe('★BeaconAdvisoryBadge — a deferred verdict is neither "safe" nor "sole copy"', () => {
    /** What the daemon produces when the server truncated the board (§7.1.2.1). */
    const deferred = beaconFixture({
        truncated: 3,
        soleCopyDeferred: true,
        soleCopy: [
            {
                topic: 'mesh.mesh_abc.events',
                writer: 'adhdev-1111111111111111',
                localSeq: 20,
                bestPeerSeq: null,
                unreplicated: 0,
                verdict: 'unknown',
                unknownReason: 'truncated',
            },
        ],
    })

    it('★does NOT hide the badge — silence would read as "replicated"', () => {
        render(deferred)
        expect(container.textContent).not.toBe('')
        expect(q('beacon-deferred-badge')).not.toBeNull()
    })

    it('★does NOT render it as a confirmed sole copy — that would invent a scare', () => {
        render(deferred)
        expect(q('beacon-sole-copy-badge')).toBeNull()
    })

    it('★explains the deferral, so "can\'t tell" is attributable to a truncated board', () => {
        render(deferred)
        const tooltip = container.querySelector('[title]')!.getAttribute('title')!
        expect(tooltip.toLowerCase()).toContain('truncated')
    })

    it('prefers the confirmed finding when a real sole copy is also present', () => {
        // Both a confirmed and a deferred verdict: the actionable one is shown
        // as a chip, and the deferral stays in the tooltip rather than adding a
        // second competing chip.
        render(
            beaconFixture({
                truncated: 1,
                soleCopyDeferred: true,
                soleCopy: [
                    {
                        topic: 'a.b.c', writer: 'adhdev-1111111111111111',
                        localSeq: 9, bestPeerSeq: 4, unreplicated: 5, verdict: 'sole-copy',
                    },
                    {
                        topic: 'd.e.f', writer: 'adhdev-1111111111111111',
                        localSeq: 3, bestPeerSeq: null, unreplicated: 0,
                        verdict: 'unknown', unknownReason: 'truncated',
                    },
                ],
            }),
        )

        expect(q('beacon-sole-copy-badge')).not.toBeNull()
        expect(q('beacon-deferred-badge')).toBeNull()
        expect(container.querySelector('[title]')!.getAttribute('title')!.toLowerCase())
            .toContain('truncated')
    })
})

describe('★BeaconAdvisoryBadge — advisory only, never a gate (§5.7a)', () => {
    it('renders no disabling, blocking or confirm-required affordance', () => {
        render(
            beaconFixture({
                maxBehind: 7,
                soleCopyDeferred: true,
                soleCopy: [
                    {
                        topic: 'a.b.c', writer: 'adhdev-1111111111111111',
                        localSeq: 3, bestPeerSeq: null, unreplicated: 0,
                        verdict: 'unknown', unknownReason: 'truncated',
                    },
                ],
                keyStaleAdvisory: [
                    { topic: 'config.settings', key: 'hashed', latestKnown: null, haveLocally: false },
                ],
            }),
        )

        // The badge is display-only: no interactive element, nothing disabled,
        // no form control a user could be blocked by.
        expect(container.querySelector('button')).toBeNull()
        expect(container.querySelector('input')).toBeNull()
        expect(container.querySelector('[disabled]')).toBeNull()
        expect(container.querySelector('[aria-disabled="true"]')).toBeNull()
    })
})
