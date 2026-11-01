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

describe('cursor usage and failure labels', () => {
    it('a spent included allowance reads as used, never as unlimited, with a 7d cycle label and auto/api split', () => {
        const quota = {
            provider: 'cursor-cli', status: 'ok', error: null, updatedAt: NOW, session: null, weekly: null,
            monthly: win(100, 10080, NOW + H),
            buckets: [{ name: 'auto', ...win(100, 10080, NOW + H) }, { name: 'api', ...win(0, 10080, NOW + H) }],
            metadata: { cursorUsage: { kind: 'unlimited', usedDollars: 0, enabled: true, displayMessage: "You've hit your usage limit" } },
        } as unknown as MeshNodeFactsProviderQuota
        const model = buildQuotaDisplayModel(quota, NOW)
        expect(model.kind).toBe('chips')
        expect(model.chips.map(shortQuotaChipLabel)).toEqual(['7d 100%', 'Auto 100% · API 0%'])
        expect(model.chips[0].usedPercent).toBe(100)
        expect(JSON.stringify(model)).not.toMatch(/unlimited/i)
    })
    it('names not-signed-in and expired-token instead of a generic failure', () => {
        const mk = (failureKind: string) => ({ provider: 'grok-cli', status: 'unavailable', error: 'Not signed in', updatedAt: NOW, session: null, weekly: null, metadata: { failureKind } }) as unknown as MeshNodeFactsProviderQuota
        expect(buildQuotaDisplayModel(mk('missing-credentials'), NOW).failureLabel).toBe('missing credentials')
        expect(buildQuotaDisplayModel(mk('expired-token'), NOW).failureLabel).toBe('expired token')
        expect(buildQuotaDisplayModel(mk('parse'), NOW).failureLabel).toBeUndefined()
    })
})

describe('antigravity idle-expired token', () => {
    const buckets = [
        { name: 'Gemini Models · 5h', ...win(0.7, 300, NOW + H) },
        { name: 'Gemini Models · 7d', ...win(1.5, 10080, NOW + 24 * H) },
        { name: 'Claude/GPT · 7d', ...win(100, 10080, NOW + 24 * H) },
    ]
    const base = { provider: 'antigravity-cli', status: 'unavailable', error: 'Antigravity quota reading unavailable until next CLI use', updatedAt: NOW - 3 * H, metadata: { failureKind: 'expired-token' } }
    it('keeps last-good numbers with age and says they update on the next agy run', () => {
        const quota = { ...base, session: win(0.7, 300, NOW + H), weekly: win(100, 10080, NOW + 24 * H), buckets, metadata: { ...base.metadata, lastGoodWindows: true } } as unknown as MeshNodeFactsProviderQuota
        const model = buildQuotaDisplayModel(quota, NOW)
        expect(model.kind).toBe('chips')
        expect(model.chips.length).toBe(3)
        const labels = model.chips.map(shortQuotaChipLabel)
        expect(labels.every(l => l.includes('updates on next agy run') && l.includes('3h 0m ago'))).toBe(true)
        expect(labels.join(' ')).not.toMatch(/stale|token expired/i)
    })
    it('a kept copy in the unconfirmed-account slot also reads "updates on next agy run", not "account unconfirmed"', () => {
        const quota = { ...base, session: null, weekly: null, buckets: [], metadata: { ...base.metadata, unconfirmedReading: { measuredAt: NOW - 34 * 60_000, buckets } } } as unknown as MeshNodeFactsProviderQuota
        const model = buildQuotaDisplayModel(quota, NOW)
        expect(model.kind).toBe('chips')
        const labels = model.chips.map(shortQuotaChipLabel)
        expect(labels.length).toBe(3)
        expect(labels.every(l => l.includes('updates on next agy run') && l.includes('34m ago'))).toBe(true)
        expect(labels.join(' ')).not.toMatch(/unconfirmed/i)
    })
    it('without any earlier reading says to run agy once, not "token expired"', () => {
        const quota = { ...base, session: null, weekly: null, buckets: [] } as unknown as MeshNodeFactsProviderQuota
        const model = buildQuotaDisplayModel(quota, NOW)
        expect(model.kind).toBe('failure')
        expect(model.failureLabel).toBe('run agy once to read usage')
        expect(model.message).toBe('run agy once to read usage')
    })
    it('other providers keep the generic expired-token label; grok sign-in label only for missing-credentials', () => {
        const mk = (provider: string, failureKind: string) => ({ provider, status: 'unavailable', error: null, updatedAt: NOW, session: null, weekly: null, metadata: { failureKind } }) as unknown as MeshNodeFactsProviderQuota
        expect(buildQuotaDisplayModel(mk('grok-cli', 'expired-token'), NOW).failureLabel).toBe('expired token')
        expect(buildQuotaDisplayModel(mk('kimi', 'expired-token'), NOW).failureLabel).toBe('expired token')
        expect(buildQuotaDisplayModel(mk('grok-cli', 'missing-credentials'), NOW).failureLabel).toBe('missing credentials')
    })
})
