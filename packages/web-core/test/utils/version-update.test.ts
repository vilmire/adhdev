import { describe, expect, it } from 'vitest'
import { isVersionMismatch, isVersionUpdateRequired } from '../../src/utils/version-update'
import type { DaemonData } from '../../src/types'

function daemon(version: string, flags: Partial<DaemonData> = {}): DaemonData {
    return { version, ...flags } as DaemonData
}

describe('isVersionMismatch', () => {
    it('does not flag a preview build whose base equals the target release', () => {
        // rc builds are successors of the previous stable — "upgrade to 0.9.82"
        // shown to a 0.9.82-rc.373 daemon was a downgrade suggestion.
        expect(isVersionMismatch(daemon('0.9.82-rc.373'), '0.9.82')).toBe(false)
    })

    it('does not flag a release daemon against an rc target of the same base', () => {
        expect(isVersionMismatch(daemon('0.9.82'), '0.9.82-rc.373')).toBe(false)
    })

    it('flags an older rc against a newer rc of the same base', () => {
        expect(isVersionMismatch(daemon('0.9.82-rc.100'), '0.9.82-rc.373')).toBe(true)
        expect(isVersionMismatch(daemon('0.9.82-rc.373'), '0.9.82-rc.100')).toBe(false)
    })

    it('flags a daemon behind on base version, rc or not', () => {
        expect(isVersionMismatch(daemon('0.9.81'), '0.9.82')).toBe(true)
        expect(isVersionMismatch(daemon('0.9.81-rc.5'), '0.9.82')).toBe(true)
        expect(isVersionMismatch(daemon('0.9.81'), '0.9.82-rc.1')).toBe(true)
    })

    it('does not flag a daemon ahead of the target', () => {
        expect(isVersionMismatch(daemon('0.9.83'), '0.9.82')).toBe(false)
        expect(isVersionMismatch(daemon('0.9.83-rc.1'), '0.9.82')).toBe(false)
    })

    it('honors the explicit server-provided mismatch flag', () => {
        expect(isVersionMismatch(daemon('0.9.82-rc.373', { versionMismatch: true }), '0.9.82')).toBe(true)
    })

    it('falls back to string inequality for unparseable versions', () => {
        expect(isVersionMismatch(daemon('dev'), '0.9.82')).toBe(true)
        expect(isVersionMismatch(daemon('dev'), 'dev')).toBe(false)
    })

    it('returns false when either side is missing', () => {
        expect(isVersionMismatch(daemon(''), '0.9.82')).toBe(false)
        expect(isVersionMismatch(daemon('0.9.82'), null)).toBe(false)
    })
})

describe('isVersionUpdateRequired', () => {
    it('requires update only across major/minor gaps', () => {
        expect(isVersionUpdateRequired(daemon('0.8.90'), '0.9.82')).toBe(true)
        expect(isVersionUpdateRequired(daemon('0.9.81'), '0.9.82')).toBe(false)
    })

    it('never requires update for an equal-base prerelease', () => {
        expect(isVersionUpdateRequired(daemon('0.9.82-rc.373'), '0.9.82')).toBe(false)
    })

    it('honors the explicit flag', () => {
        expect(isVersionUpdateRequired(daemon('0.9.82', { versionUpdateRequired: true }), '0.9.82')).toBe(true)
    })
})
