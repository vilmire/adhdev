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

    it('verifies direction even when the server mismatch flag is set', () => {
        // Stale server flags advertised rc.18 to daemons already on rc.19 —
        // the flag alone must never force a mismatch.
        expect(isVersionMismatch(daemon('1.0.28-rc.19', { versionMismatch: true }), '1.0.28-rc.18')).toBe(false)
        expect(isVersionMismatch(daemon('1.0.28-rc.19', { versionMismatch: true }), '1.0.28-rc.20')).toBe(true)
        expect(isVersionMismatch(daemon('1.0.28-rc.19', { versionMismatch: true }), '1.0.28-rc.19')).toBe(false)
        expect(isVersionMismatch(daemon('1.0.28', { versionMismatch: true }), '1.0.28-rc.20')).toBe(false)
    })

    it('fails closed when the server flag is set but the target is missing or unparseable', () => {
        // Without a parseable target the direction can't be verified, so no
        // update is advertised (documented fail-closed choice).
        expect(isVersionMismatch(daemon('1.0.28-rc.19', { versionMismatch: true }), null)).toBe(false)
        expect(isVersionMismatch(daemon('1.0.28-rc.19', { versionMismatch: true }), 'not-a-version')).toBe(false)
    })

    it('falls back to string inequality for unparseable versions', () => {
        expect(isVersionMismatch(daemon('dev'), '0.9.82')).toBe(true)
        expect(isVersionMismatch(daemon('dev'), 'dev')).toBe(false)
    })

    it('returns false when either side is missing', () => {
        expect(isVersionMismatch(daemon(''), '0.9.82')).toBe(false)
        expect(isVersionMismatch(daemon('0.9.82'), null)).toBe(false)
    })

    it('drives the mobile machine gate by direction, not raw inequality', () => {
        // DashboardMobileChatMode gates the mobile "Update" button on this
        // helper (with the policy target / app version as target).
        expect(isVersionMismatch(daemon('1.0.28-rc.19'), '1.0.28-rc.18')).toBe(false)
        expect(isVersionMismatch(daemon('1.0.28-rc.18'), '1.0.28-rc.19')).toBe(true)
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
