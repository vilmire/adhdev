import { describe, expect, it } from 'vitest'
import { machineCoreFromDaemonId, daemonIdsEquivalent, expandDaemonIdForms, canonicalDaemonId } from '../src/daemon-normalize'

const MACH = 'mach_1b46842a15d3409d96ad33e767a916dd'

describe('machineCoreFromDaemonId', () => {
    it('strips the cloud `daemon_` prefix to the bare machine id', () => {
        expect(machineCoreFromDaemonId(`daemon_${MACH}`)).toBe(MACH)
    })

    it('strips the `standalone_` prefix to the bare machine id', () => {
        expect(machineCoreFromDaemonId(`standalone_${MACH}`)).toBe(MACH)
    })

    it('returns a bare machine id unchanged', () => {
        expect(machineCoreFromDaemonId(MACH)).toBe(MACH)
    })

    it('returns a non-machine id unchanged (no underscore-prefixed form)', () => {
        expect(machineCoreFromDaemonId('node-daemon-id')).toBe('node-daemon-id')
    })

    it('returns undefined for empty/absent input', () => {
        expect(machineCoreFromDaemonId('')).toBeUndefined()
        expect(machineCoreFromDaemonId('   ')).toBeUndefined()
        expect(machineCoreFromDaemonId(null)).toBeUndefined()
        expect(machineCoreFromDaemonId(undefined)).toBeUndefined()
    })
})

describe('daemonIdsEquivalent', () => {
    it('treats the three forms of one machine as equivalent', () => {
        expect(daemonIdsEquivalent(`daemon_${MACH}`, MACH)).toBe(true)
        expect(daemonIdsEquivalent(`daemon_${MACH}`, `standalone_${MACH}`)).toBe(true)
        expect(daemonIdsEquivalent(MACH, `standalone_${MACH}`)).toBe(true)
    })

    it('does not equate different machines', () => {
        expect(daemonIdsEquivalent(`daemon_${MACH}`, 'daemon_mach_other')).toBe(false)
        expect(daemonIdsEquivalent(MACH, 'mach_other')).toBe(false)
    })

    it('never matches when either side is empty', () => {
        expect(daemonIdsEquivalent('', MACH)).toBe(false)
        expect(daemonIdsEquivalent(MACH, undefined)).toBe(false)
    })
})

describe('canonicalDaemonId — single CANON producer form', () => {
    it('canonicalizes all three forms of one machine to the cloud `daemon_` form', () => {
        expect(canonicalDaemonId(MACH)).toBe(`daemon_${MACH}`)
        expect(canonicalDaemonId(`daemon_${MACH}`)).toBe(`daemon_${MACH}`)
        expect(canonicalDaemonId(`standalone_${MACH}`)).toBe(`daemon_${MACH}`)
    })

    it('is idempotent', () => {
        expect(canonicalDaemonId(canonicalDaemonId(MACH))).toBe(`daemon_${MACH}`)
    })

    it('collapses two producer forms to the SAME string so even a raw === dedup agrees', () => {
        // The exact double-dispatch root cause: the queue path stamps bare `mach_X`
        // while the MCP path stamps `daemon_mach_X`. Canonicalizing both makes the two
        // producers emit one identical coordinator-id string.
        expect(canonicalDaemonId(MACH)).toBe(canonicalDaemonId(`daemon_${MACH}`))
    })

    it('leaves a non-machine id unchanged (never balloons into a daemon_ form)', () => {
        expect(canonicalDaemonId('node-daemon-id')).toBe('node-daemon-id')
    })

    it('returns undefined for empty/absent input', () => {
        expect(canonicalDaemonId('')).toBeUndefined()
        expect(canonicalDaemonId('   ')).toBeUndefined()
        expect(canonicalDaemonId(null)).toBeUndefined()
        expect(canonicalDaemonId(undefined)).toBeUndefined()
    })

    it('the canon form stays equivalent to every other form under daemonIdsEquivalent', () => {
        const canon = canonicalDaemonId(`standalone_${MACH}`)!
        expect(daemonIdsEquivalent(canon, MACH)).toBe(true)
        expect(daemonIdsEquivalent(canon, `daemon_${MACH}`)).toBe(true)
    })
})

describe('expandDaemonIdForms', () => {
    it('expands a bare machine id to all three forms', () => {
        const out = expandDaemonIdForms(MACH)
        expect(out).toContain(MACH)
        expect(out).toContain(`daemon_${MACH}`)
        expect(out).toContain(`standalone_${MACH}`)
    })

    it('expands a full `daemon_` form so a bare-form coordinator matches it (base-node surface bug)', () => {
        // The exact regression: a completion stamped `daemon_mach_X` must be reachable
        // by a coordinator whose self-id set was resolved as bare `mach_X`.
        const coordinatorSelfIds = expandDaemonIdForms([MACH])
        expect(coordinatorSelfIds).toContain(`daemon_${MACH}`)
    })

    it('keeps the first ORIGINAL id at [0] so JSONL primary file naming is preserved', () => {
        const out = expandDaemonIdForms([`standalone_${MACH}`, MACH])
        expect(out[0]).toBe(`standalone_${MACH}`)
    })

    it('stays within one machine core — never invents a different machine\'s forms', () => {
        const out = expandDaemonIdForms(`daemon_${MACH}`)
        expect(out.every(id => machineCoreFromDaemonId(id) === MACH)).toBe(true)
        expect(out).not.toContain('mach_other')
        expect(out).not.toContain('daemon_mach_other')
    })

    it('de-duplicates across overlapping input forms', () => {
        const out = expandDaemonIdForms([MACH, `daemon_${MACH}`, `standalone_${MACH}`])
        expect(new Set(out).size).toBe(out.length)
        // exactly the three machine forms
        expect(out.sort()).toEqual([`daemon_${MACH}`, MACH, `standalone_${MACH}`].sort())
    })

    it('passes non-machine ids through without prefixed expansion', () => {
        const out = expandDaemonIdForms(['node-daemon-id'])
        expect(out).toEqual(['node-daemon-id'])
    })

    it('drops empty/absent entries', () => {
        expect(expandDaemonIdForms([null, undefined, '', '   '])).toEqual([])
        expect(expandDaemonIdForms(undefined)).toEqual([])
    })
})
