import { describe, expect, it } from 'vitest'
import { normalizeMeshSessionRecord } from '../src/session-normalize'

describe('normalizeMeshSessionRecord', () => {
    it('uses the explicit sessionId when present', () => {
        const s = normalizeMeshSessionRecord({ sessionId: 'sess_1', providerType: 'claude-code' })
        expect(s?.sessionId).toBe('sess_1')
        expect(s?.providerType).toBe('claude-code')
    })

    it('falls back through session_id → id', () => {
        expect(normalizeMeshSessionRecord({ session_id: 'sess_2' })?.sessionId).toBe('sess_2')
        expect(normalizeMeshSessionRecord({ id: 'sess_3' })?.sessionId).toBe('sess_3')
    })

    it('derives a DETERMINISTIC synthetic id when no explicit id is present', () => {
        const record = { workspace: '/Users/x/adhdev', providerType: 'claude-code', state: 'generating' }
        const a = normalizeMeshSessionRecord(record)
        const b = normalizeMeshSessionRecord({ ...record })
        expect(a?.sessionId).toBeDefined()
        expect(a?.sessionId.startsWith('synthetic:')).toBe(true)
        // Stable across two independent calls so dedupe survives refreshes.
        expect(a?.sessionId).toBe(b?.sessionId)
    })

    it('produces different synthetic ids for different content', () => {
        const a = normalizeMeshSessionRecord({ workspace: '/a', providerType: 'claude-code' })
        const b = normalizeMeshSessionRecord({ workspace: '/b', providerType: 'claude-code' })
        expect(a?.sessionId).not.toBe(b?.sessionId)
    })

    it('returns null only when the record has no identifying fields at all', () => {
        expect(normalizeMeshSessionRecord({})).toBeNull()
        expect(normalizeMeshSessionRecord(null)).toBeNull()
        expect(normalizeMeshSessionRecord({ isCached: true })).toBeNull()
    })
})
