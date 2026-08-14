import { describe, expect, it } from 'vitest'
import { isPhantomDaemonEntry, isRawDaemonDoId } from '../src/daemon-normalize'

// A raw 64-hex Cloudflare DO id — the shape a daemon gets keyed by when the
// `X-ADHDEV-Daemon` instanceId header is missing, so every reconnect mints a new one.
const RAW_DO_ID = '88c47acee3924e0ccd98603a5ffe0fc1a2b3c4d5e6f708192a3b4c5d6e7f8091'
const CANONICAL_ID = 'daemon_mach_4462a75330c548be9c2e74dd9f7f6ffb'

describe('isRawDaemonDoId', () => {
    it('accepts a bare 64-hex DO id', () => {
        expect(isRawDaemonDoId(RAW_DO_ID)).toBe(true)
        expect(isRawDaemonDoId(RAW_DO_ID.toUpperCase())).toBe(true)
    })

    it('rejects canonical prefixed daemon ids', () => {
        expect(isRawDaemonDoId(CANONICAL_ID)).toBe(false)
        expect(isRawDaemonDoId('standalone_mach_4462a75330c548be9c2e74dd9f7f6ffb')).toBe(false)
        expect(isRawDaemonDoId('mach_4462a75330c548be9c2e74dd9f7f6ffb')).toBe(false)
    })

    it('decides by FORMAT, not by length', () => {
        // The canonical name is 43+ chars, so a `length > 32` heuristic would
        // misclassify it as a raw DO id. Length alone must never be the test.
        expect(CANONICAL_ID.length).toBeGreaterThan(32)
        expect(isRawDaemonDoId(CANONICAL_ID)).toBe(false)
        // 63 and 65 hex chars are not DO ids either.
        expect(isRawDaemonDoId(RAW_DO_ID.slice(0, 63))).toBe(false)
        expect(isRawDaemonDoId(`${RAW_DO_ID}a`)).toBe(false)
        // Right length, but not hex.
        expect(isRawDaemonDoId('z'.repeat(64))).toBe(false)
    })

    it('returns false for empty/absent input', () => {
        expect(isRawDaemonDoId('')).toBe(false)
        expect(isRawDaemonDoId('   ')).toBe(false)
        expect(isRawDaemonDoId(null)).toBe(false)
        expect(isRawDaemonDoId(undefined)).toBe(false)
    })
})

describe('isPhantomDaemonEntry', () => {
    it('suppresses a raw-DO-id entry with no machine evidence at all', () => {
        // The exact shape the owner photographed: hash as the name, hash as the
        // subtitle, "0 workspace(s) detected".
        expect(isPhantomDaemonEntry({ id: RAW_DO_ID })).toBe(true)
    })

    it('keeps a canonical daemon even when it reports no machine evidence yet', () => {
        // Condition (1) alone must not drop anything — a freshly connected canonical
        // daemon whose metadata has not arrived is still a real, attachable machine.
        expect(isPhantomDaemonEntry({ id: CANONICAL_ID })).toBe(false)
    })

    // Condition (2) is the safety condition: a legacy / not-yet-reauthed daemon
    // keyed by a raw DO id that ACTUALLY reports itself must still render.
    it.each([
        ['machineNickname', { machineNickname: 'vilmireui-MacBookAir-4' }],
        ['nickname', { nickname: 'work-laptop' }],
        ['hostname', { hostname: 'macbook.local' }],
        ['platform', { platform: 'darwin' }],
        ['machineId', { machineId: 'mach_4462a75330c548be9c2e74dd9f7f6ffb' }],
        ['machine.hostname', { machine: { hostname: 'macbook.local' } }],
        ['machine.platform', { machine: { platform: 'darwin' } }],
        ['sessions', { sessions: [{ id: 's1' }] }],
    ])('keeps a raw-DO-id entry that reports %s', (_label, evidence) => {
        expect(isPhantomDaemonEntry({ id: RAW_DO_ID, ...evidence })).toBe(false)
    })

    it('treats whitespace-only and empty-array evidence as no evidence', () => {
        expect(isPhantomDaemonEntry({ id: RAW_DO_ID, machineNickname: '   ' })).toBe(true)
        expect(isPhantomDaemonEntry({ id: RAW_DO_ID, hostname: '' })).toBe(true)
        expect(isPhantomDaemonEntry({ id: RAW_DO_ID, sessions: [] })).toBe(true)
    })

    it('returns false for a missing entry or a missing id', () => {
        expect(isPhantomDaemonEntry(null)).toBe(false)
        expect(isPhantomDaemonEntry(undefined)).toBe(false)
        expect(isPhantomDaemonEntry({})).toBe(false)
    })
})
