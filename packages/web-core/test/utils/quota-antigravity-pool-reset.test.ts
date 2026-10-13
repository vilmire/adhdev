/**
 * Antigravity multi-pool + reset tooltip — synthetic LIVE_RESPONSE-shaped
 * fixtures only. No live account / auth / network.
 *
 * Pins: two pools when buckets exist, one/missing pool never invented,
 * absolute local + relative reset (or explicit unknown), selectMachineQuotaChips
 * for fleet/row/overview modes, and stale cue still rides the chip label.
 */
import { describe, expect, it } from 'vitest'
import {
    buildQuotaDisplayModel,
    describeQuotaChipTooltip,
    describeQuotaResetDetail,
    ENGLISH_QUOTA_TEXT,
    formatAbsoluteQuotaReset,
    selectMachineQuotaChips,
    shortQuotaChipLabel,
} from '../../src/utils/quota-format'

const NOW = Date.parse('2026-08-16T12:00:00Z')
const GEMINI_5H_RESET = Date.parse('2026-08-16T14:34:54Z')
const CLAUDE_5H_RESET = Date.parse('2026-08-16T13:58:17Z')

/** LIVE_RESPONSE-shaped buckets (antigravity-quota.test.ts fixture). */
function antigravityTwoPools(overrides: Record<string, unknown> = {}) {
    return {
        provider: 'antigravity-cli',
        status: 'ok',
        updatedAt: NOW,
        error: null,
        session: { usedPercent: 1.34, windowMinutes: 300, resetsAt: CLAUDE_5H_RESET },
        weekly: { usedPercent: 2.35, windowMinutes: 10080, resetsAt: Date.parse('2026-08-16T13:50:47Z') },
        buckets: [
            { name: 'Gemini Models · Five Hour Limit Remaining', usedPercent: 0, windowMinutes: 300, resetsAt: GEMINI_5H_RESET },
            { name: 'Gemini Models · Weekly Limit Remaining', usedPercent: 0.32, windowMinutes: 10080, resetsAt: Date.parse('2026-08-17T16:28:23Z') },
            { name: 'Claude and GPT models · Five Hour Limit Remaining', usedPercent: 1.34, windowMinutes: 300, resetsAt: CLAUDE_5H_RESET },
            { name: 'Claude and GPT models · Weekly Limit Remaining', usedPercent: 2.35, windowMinutes: 10080, resetsAt: Date.parse('2026-08-16T13:50:47Z') },
        ],
        ...overrides,
    } as any
}

describe('describeQuotaResetDetail — absolute local + relative / unknown', () => {
    it('pairs absolute local timezone with relative remaining', () => {
        const detail = describeQuotaResetDetail(GEMINI_5H_RESET, NOW, ENGLISH_QUOTA_TEXT, 'en-US')
        expect(detail).not.toContain('reset time unknown')
        expect(detail.startsWith('resets ')).toBe(true)
        expect(detail).toContain('·')
        expect(detail).toMatch(/resets in 2h 3[45]m/)
        const abs = formatAbsoluteQuotaReset(GEMINI_5H_RESET, 'en-US')
        expect(abs).toBeTruthy()
        expect(detail).toContain(abs!)
    })

    it('states reset time unknown when resetsAt is missing — never invents from windowMinutes', () => {
        expect(describeQuotaResetDetail(null, NOW)).toBe('reset time unknown')
        expect(describeQuotaResetDetail(undefined, NOW)).toBe('reset time unknown')
        expect(describeQuotaResetDetail(0, NOW)).toBe('reset time unknown')
        expect(formatAbsoluteQuotaReset(null)).toBeNull()
    })
})

describe('buildQuotaDisplayModel + selectMachineQuotaChips — pool visibility', () => {
    it('two LIVE pools → four bucket chips; compactChip stays worst-headline; fleet/row/all show pools', () => {
        const model = buildQuotaDisplayModel(antigravityTwoPools(), NOW)
        expect(model.kind).toBe('chips')
        expect(model.chips.every((c) => c.hint === 'bucket')).toBe(true)
        expect(model.chips.map((c) => c.key)).toEqual([
            'Claude and GPT 5h',
            'Claude and GPT 7d',
            'Gemini 5h',
            'Gemini 7d',
        ])
        // Pool labels stay distinct — LIVE group "Claude and GPT models" trims to "Claude and GPT".
        expect(model.chips.some((c) => c.key.startsWith('Gemini'))).toBe(true)
        expect(model.chips.some((c) => c.key.startsWith('Claude and GPT'))).toBe(true)
        expect(model.compactChip).toMatchObject({ hint: 'session', usedPercent: 1.34 })
        expect(selectMachineQuotaChips(model, 'fleet')).toHaveLength(4)
        expect(selectMachineQuotaChips(model, 'row')).toHaveLength(4)
        expect(selectMachineQuotaChips(model, 'all')).toHaveLength(4)
        expect(model.chips.find((c) => c.key === 'Gemini 5h')?.resetsAt).toBe(GEMINI_5H_RESET)
        expect(model.chips.find((c) => c.key === 'Claude and GPT 5h')?.resetsAt).toBe(CLAUDE_5H_RESET)
    })

    it('single-axis provider (no buckets) → fleet shows session/weekly; row uses compactChip only', () => {
        const model = buildQuotaDisplayModel({
            provider: 'claude-cli',
            status: 'ok',
            updatedAt: NOW,
            error: null,
            session: { usedPercent: 26, windowMinutes: 300, resetsAt: null },
            weekly: { usedPercent: 92, windowMinutes: 10080, resetsAt: null },
        } as any, NOW)
        expect(model.chips.every((c) => c.hint !== 'bucket')).toBe(true)
        expect(selectMachineQuotaChips(model, 'fleet').map((c) => c.key)).toEqual(['session', 'weekly'])
        expect(selectMachineQuotaChips(model, 'row')).toEqual([model.compactChip])
        expect(selectMachineQuotaChips(model, 'row')[0]?.resetsAt).toBeNull()
        expect(describeQuotaChipTooltip(selectMachineQuotaChips(model, 'row')[0]!, 'session hint', NOW))
            .toContain('reset time unknown')
    })

    it('one bucket only → axes path (never fabricates a second pool)', () => {
        const model = buildQuotaDisplayModel({
            provider: 'antigravity-cli',
            status: 'ok',
            updatedAt: NOW,
            error: null,
            session: { usedPercent: 10, windowMinutes: 300, resetsAt: GEMINI_5H_RESET },
            weekly: null,
            buckets: [
                { name: 'Gemini Models · Five Hour Limit Remaining', usedPercent: 10, windowMinutes: 300, resetsAt: GEMINI_5H_RESET },
            ],
        } as any, NOW)
        expect(model.chips.every((c) => c.hint === 'bucket')).toBe(false)
        expect(model.chips.map((c) => c.key)).toEqual(['session'])
        expect(selectMachineQuotaChips(model, 'fleet')).toHaveLength(1)
    })

    it('stale retained reading keeps cue in chip labels for every selected chip', () => {
        const model = buildQuotaDisplayModel(antigravityTwoPools({
            status: 'error',
            error: 'Antigravity access token expired — run `agy` once.',
            metadata: { failureKind: 'expired-token', lastGoodWindows: true },
        }), NOW)
        expect(model.cue).toBe('stale')
        expect(model.chips.every((c) => c.label.includes('stale'))).toBe(true)
        expect(selectMachineQuotaChips(model, 'fleet').every((c) => c.label.includes('stale'))).toBe(true)
    })

    it('shortQuotaChipLabel keeps full reset detail out of the visible fleet cell', () => {
        const model = buildQuotaDisplayModel(antigravityTwoPools(), NOW)
        const gemini = model.chips.find((c) => c.key === 'Gemini 5h')!
        expect(shortQuotaChipLabel(gemini)).toBe('Gemini 5h 0%')
        expect(gemini.label).toContain('resets in')
    })
})
