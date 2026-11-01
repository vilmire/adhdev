/**
 * QuotaPolicyStep — the draft→overrides conversion the step emits to onSave.
 *
 * The contract this pins: the step emits OVERRIDES ONLY (a blank field means
 * "inherit the default", never 0), and the duration field is shown in
 * minutes but stored in milliseconds. The reserve floors (session / weekly /
 * reset grace) are NOT mesh policy any more — they live in the machine quota
 * reserve card; this step must never emit them. Both matter at the daemon boundary —
 * setMeshQuotaRouting persists exactly what arrives here, and the launch gate
 * reads that object, so a blank field leaking through as 0 would silently
 * become a real threshold nobody configured.
 */
import { describe, expect, it } from 'vitest'
import { quotaPolicyDraftToOverrides } from '../../../src/components/setup-wizard/QuotaPolicyStep'

const BLANK = {
    staleAfterMinutes: '',
    spreadBonusMax: '',
    sessionAxisWeeklyHeadroomPercent: '',
}

describe('quotaPolicyDraftToOverrides', () => {
    it('emits nothing for an all-blank draft (every field inherits its default)', () => {
        expect(quotaPolicyDraftToOverrides(BLANK)).toEqual({})
    })

    it('omits blank fields rather than zeroing them', () => {
        const out = quotaPolicyDraftToOverrides({ ...BLANK, spreadBonusMax: '80' })
        expect(out).toEqual({ spreadBonusMax: 80 })
        expect('sessionAxisWeeklyHeadroomPercent' in out).toBe(false)
        expect('staleAfterMs' in out).toBe(false)
    })

    it('converts the minute-denominated duration field back to milliseconds', () => {
        const out = quotaPolicyDraftToOverrides({
            ...BLANK,
            staleAfterMinutes: '30',
        })
        expect(out.staleAfterMs).toBe(30 * 60 * 1000)
    })

    it('keeps an explicit 0 — a deliberate "never gate on this window" is not the same as blank', () => {
        const out = quotaPolicyDraftToOverrides({ ...BLANK, sessionAxisWeeklyHeadroomPercent: '0' })
        expect(out.sessionAxisWeeklyHeadroomPercent).toBe(0)
    })

    it('drops unparseable input instead of emitting NaN to the daemon writer', () => {
        // The form blocks save while a field is invalid; this is the belt-and-braces
        // guarantee that a NaN can never reach setMeshQuotaRouting even if it did.
        const out = quotaPolicyDraftToOverrides({ ...BLANK, spreadBonusMax: 'abc' })
        expect(out).toEqual({})
    })

    it('round-trips a full override set', () => {
        const out = quotaPolicyDraftToOverrides({
            staleAfterMinutes: '60',
            spreadBonusMax: '50',
            sessionAxisWeeklyHeadroomPercent: '35',
        })
        expect(out).toEqual({
            staleAfterMs: 60 * 60 * 1000,
            spreadBonusMax: 50,
            sessionAxisWeeklyHeadroomPercent: 35,
        })
    })
})
