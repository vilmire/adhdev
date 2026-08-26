/**
 * The OWNER-VISIBLE symptom of the 2026-08-15 defect, pinned at the routing
 * layer: `weeklyMinRemainingPercent: 80` was configured to steer work OFF
 * claude-cli (68% weekly left) and ONTO codex-cli (91% left), and it did
 * nothing — every task still went to claude-cli, because every snapshot was
 * older than staleAfterMs and a stale snapshot failed OPEN wholesale.
 *
 * 2026-08-24 owner decision — window-boundary validity: a measured window now
 * keeps gating until ITS OWN resetsAt passes, regardless of wall-clock age.
 * Usage within a window is monotonic, so an old low-headroom reading is a
 * LOWER bound on usage now — exactly the safe direction for a gate. That
 * makes the owner's original expectation hold even on old readings: the
 * STALE-BUT-WITHIN-WINDOW block below shows the 80% floor working where it
 * used to be silently inert. The safety property the old fail-open protected
 * (never exclude a node on data that no longer describes it) survives as the
 * RESET-ELAPSED branch: once a window's reset passes, the reading describes a
 * previous window and drops out — self-healing, no permanent exclusion. A
 * window with no reset stamp keeps the wall-clock staleAfterMs fallback.
 */
import { describe, expect, it } from 'vitest'
import {
    evaluateProviderQuotaGate,
    quotaSpreadBonusByProvider,
    rankProvidersByQuotaGate,
} from '../../src/mesh/mesh-quota-routing.js'

const MINUTE = 60_000
const NOW = 1_800_000_000_000

/** The owner's mesh policy: steer work away from anything under 80% weekly. */
const POLICY = { weeklyMinRemainingPercent: 80 }

/**
 * A node carrying the owner's observed readings. `ageMinutes` sets how old
 * each snapshot is at report time; `resetsInMinutes` places the weekly reset
 * relative to NOW (negative = already reset) — under window-boundary validity
 * the reset boundary, not the age, decides whether the gate acts.
 */
function nodeWithQuota(ageMinutes: number, resetsInMinutes = 4000) {
    const updatedAt = NOW - ageMinutes * MINUTE
    return {
        id: 'node_owner',
        nodeFacts: {
            reportedAt: NOW,
            quota: {
                // 32% used ⇒ 68% left ⇒ BELOW the 80% floor ⇒ should be gated.
                'claude-cli': {
                    provider: 'claude-cli',
                    status: 'ok',
                    session: { usedPercent: 5, windowMinutes: 300, resetsAt: NOW + 60 * MINUTE },
                    weekly: { usedPercent: 32, windowMinutes: 10080, resetsAt: NOW + resetsInMinutes * MINUTE },
                    updatedAt,
                    error: null,
                    metadata: {},
                },
                // 9% used ⇒ 91% left ⇒ ABOVE the floor ⇒ should stay usable.
                'codex-cli': {
                    provider: 'codex-cli',
                    status: 'ok',
                    session: null,
                    weekly: { usedPercent: 9, windowMinutes: 10080, resetsAt: NOW + resetsInMinutes * MINUTE },
                    updatedAt,
                    error: null,
                    metadata: {},
                },
            },
        },
    }
}

describe('quota gate with FRESH snapshots — the configured threshold is honoured', () => {
    const node = nodeWithQuota(5) // well inside staleAfterMs

    it('gates claude-cli at 68% weekly against an 80% floor', () => {
        const block = evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW)
        expect(block).toMatchObject({
            reason: 'provider_quota_weekly_low',
            window: 'weekly',
            remainingPercent: 68,
            thresholdPercent: 80,
        })
    })

    it('leaves codex-cli at 91% weekly usable', () => {
        expect(evaluateProviderQuotaGate(node, 'codex-cli', POLICY, NOW)).toBeNull()
    })

    it('ranks codex-cli as the only clear candidate, so work leaves claude-cli', () => {
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli', 'codex-cli'], POLICY, NOW)
        expect(ranked.clear).toEqual(['codex-cli'])
        expect(ranked.gated.map(g => g.providerType)).toEqual(['claude-cli'])
    })
})

describe('quota gate with STALE-BUT-WITHIN-WINDOW snapshots — measured values keep governing', () => {
    // The owner's live readings were ~160 and ~187 minutes old — far past
    // staleAfterMs, but the weekly window they measured had NOT reset yet.
    const node = nodeWithQuota(180)

    it('still gates claude-cli under the floor — the old reading is a lower bound on usage', () => {
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW)).toMatchObject({
            reason: 'provider_quota_weekly_low',
            window: 'weekly',
            remainingPercent: 68,
            thresholdPercent: 80,
        })
    })

    it('so the 80% setting steers work onto codex-cli exactly as configured', () => {
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli', 'codex-cli'], POLICY, NOW)
        expect(ranked.clear).toEqual(['codex-cli'])
        expect(ranked.gated.map(g => g.providerType)).toEqual(['claude-cli'])
    })
})

describe('quota gate after the window RESET — the reading no longer describes anything', () => {
    // Same stale readings, but the weekly reset has PASSED: the measured
    // window is a previous one. Gating on it would be the misexclusion trap
    // the fail-open contract exists to prevent — and it self-heals here.
    const node = nodeWithQuota(180, -10)

    it('fails OPEN on claude-cli — no permanent exclusion from a dead window', () => {
        // (The 5%-used session window is still within ITS boundary and above
        // any session floor, so only the weekly axis is in play.)
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW)).toBeNull()
    })

    it('gates nobody, restoring the pre-quota slot-order fallback', () => {
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli', 'codex-cli'], POLICY, NOW)
        expect(ranked.gated).toEqual([])
        expect(ranked.clear).toEqual(['claude-cli', 'codex-cli'])
    })
})

describe('quota gate with NO reset stamp — the wall-clock fallback remains', () => {
    function nodeWithoutResetStamp(ageMinutes: number) {
        const node = nodeWithQuota(ageMinutes)
        for (const entry of Object.values(node.nodeFacts.quota)) {
            if (entry.weekly) (entry.weekly as { resetsAt?: number | null }).resetsAt = null
            if (entry.session) (entry.session as { resetsAt?: number | null }).resetsAt = null
        }
        return node
    }

    it('a fresh unstamped reading still gates', () => {
        expect(evaluateProviderQuotaGate(nodeWithoutResetStamp(5), 'claude-cli', POLICY, NOW)).toMatchObject({
            reason: 'provider_quota_weekly_low',
        })
    })

    it('a stale unstamped reading fails open — nothing bounds its validity', () => {
        expect(evaluateProviderQuotaGate(nodeWithoutResetStamp(180), 'claude-cli', POLICY, NOW)).toBeNull()
    })
})

describe('2026-08-25 Claude retained-window incident — validity is per reset boundary', () => {
    const INCIDENT_NOW = 1_787_700_060_000 // 2026-08-25 23:21Z
    const OBSERVED_WEEKLY_RESET = 1_787_698_800_000 // 23:00Z, 21 minutes elapsed
    const CURRENT_SESSION_RESET = 1_787_716_800_000 // 2026-08-26 04:00Z
    const UPDATED_AT_304_MINUTES_AGO = INCIDENT_NOW - 304 * MINUTE

    function retainedClaude(weeklyResetsAt: number) {
        return {
            id: 'incident_node',
            nodeFacts: {
                reportedAt: INCIDENT_NOW,
                quota: {
                    'claude-cli': {
                        provider: 'claude-cli',
                        status: 'error',
                        session: { usedPercent: 30, windowMinutes: 300, resetsAt: CURRENT_SESSION_RESET },
                        weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: weeklyResetsAt },
                        updatedAt: UPDATED_AT_304_MINUTES_AGO,
                        error: 'Claude quota reading is stale (304 min old)',
                        metadata: { source: 'statusline', failureKind: 'no-data', lastGoodWindows: true },
                    },
                },
            },
        }
    }

    it('drops the expired 99% weekly window from both the gate and spread bonus', () => {
        const node = retainedClaude(OBSERVED_WEEKLY_RESET)

        // The weekly low-water mark belongs to the previous window, so it
        // cannot gate. The still-current 70%-remaining session window alone
        // contributes 30 * 0.70 = 21 points to the spread bonus.
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, INCIDENT_NOW)).toBeNull()
        expect(quotaSpreadBonusByProvider(node, null, INCIDENT_NOW)['claude-cli']).toBe(21)
    })

    it('keeps lastGoodWindows fallback when the same stale window resets in the future', () => {
        const node = retainedClaude(INCIDENT_NOW + 24 * 60 * MINUTE)

        // This is the overcorrection guard: wall-clock age does not discard a
        // retained measurement while its own reset boundary is still ahead.
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, INCIDENT_NOW)).toMatchObject({
            reason: 'provider_quota_weekly_low',
            window: 'weekly',
            remainingPercent: 1,
        })
        expect(quotaSpreadBonusByProvider(node, null, INCIDENT_NOW)['claude-cli']).toBe(0)
    })
})
