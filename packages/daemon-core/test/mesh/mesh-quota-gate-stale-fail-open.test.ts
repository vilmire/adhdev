/**
 * The OWNER-VISIBLE symptom of the 2026-08-15 defect, pinned at the routing
 * layer: `weeklyMinRemainingPercent: 80` was configured to steer work OFF
 * claude-cli (68% weekly left) and ONTO codex-cli (91% left), and it did
 * nothing — every task still went to claude-cli.
 *
 * This file demonstrates WHY, using the owner's real numbers. The gate itself
 * is correct; it was being fed snapshots older than staleAfterMs, and a stale
 * snapshot fails OPEN by design. With every candidate stale the threshold
 * applies to nobody, so selection silently falls back to slot order — which
 * lists claude-cli/opus before codex-cli for `difficult` tasks.
 *
 * The FIX is in quota/refresh.ts (the idle machine now re-fetches a snapshot
 * that has aged past the routing horizon, so the fresh branch below is the one
 * that occurs in practice). These cases guard the routing half of the contract:
 * fresh readings must gate, and the stale fail-open must stay fail-open — it is
 * a deliberate safety property, NOT the thing to "fix" by gating on old data.
 */
import { describe, expect, it } from 'vitest'
import { evaluateProviderQuotaGate, rankProvidersByQuotaGate } from '../../src/mesh/mesh-quota-routing.js'

const MINUTE = 60_000
const NOW = 1_800_000_000_000

/** The owner's mesh policy: steer work away from anything under 80% weekly. */
const POLICY = { weeklyMinRemainingPercent: 80 }

/**
 * A node carrying the owner's observed readings. `ageMinutes` sets how old each
 * snapshot is at report time — the single variable that decides whether the
 * gate acts or fails open.
 */
function nodeWithQuota(ageMinutes: number) {
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
                    weekly: { usedPercent: 32, windowMinutes: 10080, resetsAt: NOW + 4000 * MINUTE },
                    updatedAt,
                    error: null,
                    metadata: {},
                },
                // 9% used ⇒ 91% left ⇒ ABOVE the floor ⇒ should stay usable.
                'codex-cli': {
                    provider: 'codex-cli',
                    status: 'ok',
                    session: null,
                    weekly: { usedPercent: 9, windowMinutes: 10080, resetsAt: NOW + 4000 * MINUTE },
                    updatedAt,
                    error: null,
                    metadata: {},
                },
            },
        },
    }
}

describe('quota gate with FRESH snapshots — the configured threshold is honoured', () => {
    const node = nodeWithQuota(5) // well inside staleAfterMs (30 min)

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

describe('quota gate with STALE snapshots — the defect, and why it was invisible', () => {
    // The owner's live readings were ~160 and ~187 minutes old.
    const node = nodeWithQuota(180)

    it('fails OPEN on claude-cli despite it being under the floor', () => {
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW)).toBeNull()
    })

    it('gates NOBODY, so the 80% setting has no effect at all', () => {
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli', 'codex-cli'], POLICY, NOW)
        expect(ranked.gated).toEqual([])
        // Both survive, and with no quota signal to reorder them the caller's
        // order (slot order — claude-cli first) decides. That is how every task
        // kept landing on claude-cli while the owner's threshold said otherwise.
        expect(ranked.clear).toEqual(['claude-cli', 'codex-cli'])
    })
})
