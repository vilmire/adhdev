import { describe, expect, it } from 'vitest'
import { buildQuotaDisplayModel, shortQuotaChipLabel } from '../../src/utils/quota-format'
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'

const NOW = 1_800_000_000_000
const H = 3_600_000
const win = (usedPercent: number, windowMinutes: number, resetsAt: number | null) => ({ usedPercent, windowMinutes, resetsAt })

describe('retained usage stays visible with its age', () => {
    it('keeps a stale reading whose window already reset (expired-token provider)', () => {
        const quota = {
            provider: 'kimi', status: 'unavailable', error: 'x', updatedAt: NOW - 51 * H,
            session: win(30, 300, NOW - 40 * H), weekly: win(97, 10080, NOW - 20 * H),
            metadata: { failureKind: 'expired-token', lastGoodWindows: true, lastGood: { measuredAt: NOW - 51 * H } },
        } as unknown as MeshNodeFactsProviderQuota
        const model = buildQuotaDisplayModel(quota, NOW)
        expect(model.kind).toBe('chips')
        const labels = model.chips.map(shortQuotaChipLabel)
        expect(labels).toEqual(['5h 30% · stale · 2d 3h ago', '7d 97% · stale · 2d 3h ago'])
    })

    it('a fresh ok reading whose window reset still shows the single awaiting-refresh state', () => {
        const quota = {
            provider: 'codex-cli', status: 'ok', error: null, updatedAt: NOW - 1000,
            session: win(30, 300, NOW - 1), weekly: null, metadata: {},
        } as unknown as MeshNodeFactsProviderQuota
        expect(buildQuotaDisplayModel(quota, NOW).chips[0].usedPercent).toBeNull()
    })
})

describe('account-unconfirmed Claude reading', () => {
    const quota = {
        provider: 'claude-cli', status: 'unavailable', error: 'Quota account lineage could not be confirmed', updatedAt: NOW,
        session: null, weekly: null,
        metadata: { failureKind: 'no-data', lineageUncertain: true, unconfirmedReading: { measuredAt: NOW - 2 * H, session: win(40, 300, NOW + H), weekly: win(12, 10080, NOW + 24 * H) } },
    } as unknown as MeshNodeFactsProviderQuota
    it('renders the local numbers marked unconfirmed with age', () => {
        const model = buildQuotaDisplayModel(quota, NOW)
        expect(model.kind).toBe('chips')
        expect(model.cue).toBe('unconfirmed')
        expect(model.chips.map(shortQuotaChipLabel)).toEqual(['5h 40% · account unconfirmed · 2h 0m ago', '7d 12% · account unconfirmed · 2h 0m ago'])
    })
    it('ignores the display copy when the entry has live windows', () => {
        const live = { ...quota, status: 'ok', session: win(5, 300, NOW + H) } as unknown as MeshNodeFactsProviderQuota
        expect(buildQuotaDisplayModel(live, NOW).chips.map(c => c.usedPercent)).toEqual([5])
    })
})

describe('cursor unlimited and failure labels', () => {
    it('an unlimited plan with spent included usage is not 100% used', () => {
        const quota = {
            provider: 'cursor-cli', status: 'ok', error: null, updatedAt: NOW, session: null, weekly: null,
            monthly: win(100, 43200, NOW + H),
            metadata: { cursorUsage: { kind: 'unlimited', usedDollars: 0, enabled: true, displayMessage: "You've hit your usage limit" } },
        } as unknown as MeshNodeFactsProviderQuota
        const model = buildQuotaDisplayModel(quota, NOW)
        expect(model.kind).toBe('okNoWindows')
        expect(model.chips).toEqual([])
        expect(model.message).toBe('unlimited on-demand · $0.00 used')
    })
    it('names not-signed-in and expired-token instead of a generic failure', () => {
        const mk = (failureKind: string) => ({ provider: 'grok-cli', status: 'unavailable', error: 'Not signed in', updatedAt: NOW, session: null, weekly: null, metadata: { failureKind } }) as unknown as MeshNodeFactsProviderQuota
        expect(buildQuotaDisplayModel(mk('missing-credentials'), NOW).failureLabel).toBe('missing credentials')
        expect(buildQuotaDisplayModel(mk('expired-token'), NOW).failureLabel).toBe('expired token')
        expect(buildQuotaDisplayModel(mk('parse'), NOW).failureLabel).toBeUndefined()
    })
})
