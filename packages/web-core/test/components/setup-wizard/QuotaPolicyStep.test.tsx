/**
 * QuotaPolicyStep — the draft→overrides conversion the step emits to onSave.
 *
 * The contract this pins: the step emits OVERRIDES ONLY (a blank field means
 * "inherit the default", never 0), and the two duration fields are shown in
 * minutes but stored in milliseconds. Both matter at the daemon boundary —
 * setMeshQuotaRouting persists exactly what arrives here, and the launch gate
 * reads that object, so a blank field leaking through as 0 would silently
 * become a real threshold nobody configured.
 */
import { describe, expect, it } from 'vitest'
import { quotaPolicyDraftToOverrides } from '../../../src/components/setup-wizard/QuotaPolicyStep'

const BLANK = {
    sessionMinRemainingPercent: '',
    weeklyMinRemainingPercent: '',
    sessionResetImminentMinutes: '',
    staleAfterMinutes: '',
    spreadBonusMax: '',
    sessionAxisWeeklyHeadroomPercent: '',
}

describe('quotaPolicyDraftToOverrides', () => {
    it('emits nothing for an all-blank draft (every field inherits its default)', () => {
        expect(quotaPolicyDraftToOverrides(BLANK)).toEqual({})
    })

    it('omits blank fields rather than zeroing them', () => {
        const out = quotaPolicyDraftToOverrides({ ...BLANK, sessionMinRemainingPercent: '80' })
        expect(out).toEqual({ sessionMinRemainingPercent: 80 })
        expect('weeklyMinRemainingPercent' in out).toBe(false)
        expect('staleAfterMs' in out).toBe(false)
    })

    it('converts the minute-denominated duration fields back to milliseconds', () => {
        const out = quotaPolicyDraftToOverrides({
            ...BLANK,
            sessionResetImminentMinutes: '5',
            staleAfterMinutes: '30',
        })
        expect(out.sessionResetImminentMs).toBe(5 * 60 * 1000)
        expect(out.staleAfterMs).toBe(30 * 60 * 1000)
    })

    it('keeps an explicit 0 — a deliberate "never gate on this window" is not the same as blank', () => {
        const out = quotaPolicyDraftToOverrides({ ...BLANK, sessionMinRemainingPercent: '0' })
        expect(out.sessionMinRemainingPercent).toBe(0)
    })

    it('drops unparseable input instead of emitting NaN to the daemon writer', () => {
        // The form blocks save while a field is invalid; this is the belt-and-braces
        // guarantee that a NaN can never reach setMeshQuotaRouting even if it did.
        const out = quotaPolicyDraftToOverrides({ ...BLANK, spreadBonusMax: 'abc' })
        expect(out).toEqual({})
    })

    it('round-trips a full override set', () => {
        const out = quotaPolicyDraftToOverrides({
            sessionMinRemainingPercent: '25',
            weeklyMinRemainingPercent: '40',
            sessionResetImminentMinutes: '10',
            staleAfterMinutes: '60',
            spreadBonusMax: '50',
            sessionAxisWeeklyHeadroomPercent: '35',
        })
        expect(out).toEqual({
            sessionMinRemainingPercent: 25,
            weeklyMinRemainingPercent: 40,
            sessionResetImminentMs: 10 * 60 * 1000,
            staleAfterMs: 60 * 60 * 1000,
            spreadBonusMax: 50,
            sessionAxisWeeklyHeadroomPercent: 35,
        })
    })
})
