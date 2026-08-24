// Unit tests for utils/remembered-choice — the localStorage-backed "last used
// selection" store. The contract under test:
//   - values round-trip through `adhdev.remember.<scope>` keys,
//   - empty values are pruned on write (all-empty writes clear the scope),
//   - broken/foreign JSON reads as null (fail-open — the dialog falls back to
//     its defaults instead of erroring),
//   - throwing/absent storage is fully swallowed (feature disappears, no crash).
// The suite runs in the node environment and installs a minimal `window` shim,
// so the util's `typeof window === 'undefined'` guard is also exercised.
import { afterEach, describe, expect, it } from 'vitest'
import { readRememberedChoice, writeRememberedChoice } from '../../src/utils/remembered-choice'

type StorageShim = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const g = globalThis as { window?: { localStorage: StorageShim } }

function installStorage(overrides: Partial<StorageShim> = {}): Map<string, string> {
    const store = new Map<string, string>()
    g.window = {
        localStorage: {
            getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
            setItem: (key: string, value: string) => { store.set(key, value) },
            removeItem: (key: string) => { store.delete(key) },
            ...overrides,
        },
    }
    return store
}

afterEach(() => {
    delete g.window
})

describe('remembered-choice', () => {
    it('round-trips values through the adhdev.remember.<scope> key', () => {
        const store = installStorage()
        writeRememberedChoice('test-scope', { machineId: 'machine-2', mode: 'mesh' })

        expect(store.has('adhdev.remember.test-scope')).toBe(true)
        expect(readRememberedChoice('test-scope')).toEqual({ machineId: 'machine-2', mode: 'mesh' })
        // Other scopes are untouched.
        expect(readRememberedChoice('other-scope')).toBeNull()
    })

    it('prunes empty-string values on write', () => {
        installStorage()
        writeRememberedChoice('scope', { target: 'codex', model: '', thinkingLevel: '' })

        expect(readRememberedChoice('scope')).toEqual({ target: 'codex' })
    })

    it('clears the scope when the written record prunes down to nothing', () => {
        const store = installStorage()
        writeRememberedChoice('scope', { target: 'codex' })
        expect(store.size).toBe(1)

        writeRememberedChoice('scope', { target: '', model: '' })
        expect(store.size).toBe(0)
        expect(readRememberedChoice('scope')).toBeNull()
    })

    it('returns null for broken JSON instead of throwing', () => {
        const store = installStorage()
        store.set('adhdev.remember.scope', '{not json')

        expect(readRememberedChoice('scope')).toBeNull()
    })

    it('returns null for stored JSON that is not a plain object', () => {
        const store = installStorage()
        for (const raw of ['"a string"', '[1,2,3]', '42', 'null', 'true']) {
            store.set('adhdev.remember.scope', raw)
            expect(readRememberedChoice('scope'), `raw=${raw}`).toBeNull()
        }
    })

    it('drops non-string entries and reports an all-non-string record as null', () => {
        const store = installStorage()
        store.set('adhdev.remember.scope', JSON.stringify({ a: 'keep', b: 5, c: null, d: { nested: true }, e: '' }))
        expect(readRememberedChoice('scope')).toEqual({ a: 'keep' })

        store.set('adhdev.remember.scope', JSON.stringify({ b: 5, c: false }))
        expect(readRememberedChoice('scope')).toBeNull()
    })

    it('swallows throwing storage (private mode / quota): reads null, writes no-op', () => {
        installStorage({
            getItem: () => { throw new Error('SecurityError') },
            setItem: () => { throw new Error('QuotaExceededError') },
        })

        expect(readRememberedChoice('scope')).toBeNull()
        expect(() => writeRememberedChoice('scope', { target: 'codex' })).not.toThrow()
    })

    it('is a no-op without a window (SSR / node)', () => {
        // No shim installed at all.
        expect(readRememberedChoice('scope')).toBeNull()
        expect(() => writeRememberedChoice('scope', { target: 'codex' })).not.toThrow()
    })

    it('ignores blank scopes', () => {
        const store = installStorage()
        writeRememberedChoice('', { target: 'codex' })
        writeRememberedChoice('   ', { target: 'codex' })

        expect(store.size).toBe(0)
        expect(readRememberedChoice('')).toBeNull()
        expect(readRememberedChoice('   ')).toBeNull()
    })
})
