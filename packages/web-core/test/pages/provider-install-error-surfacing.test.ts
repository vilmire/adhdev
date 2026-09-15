/**
 * Channel-install failure surfacing.
 *
 * The property: when the daemon REFUSES a channel install, the dashboard shows
 * why. Before this, `handleInstallNewType` awaited `activate_provider_updates`
 * and threw the whole response away, so a DIGEST_MISMATCH refusal rendered
 * exactly like a successful no-op — the row stayed in the "new on the channel"
 * list with no reason anywhere on screen.
 *
 * Two halves, because either alone is a proxy:
 *   1. the extractor really pulls the typed errors out of the daemon's actual
 *      response shape (including the `{ result }` wrapper the dashboard's
 *      sendDaemonCommand returns), and
 *   2. ProvidersTab really consumes it and really renders it — asserted
 *      against the component source, because an extractor that nothing calls
 *      would otherwise leave this file green while the UI stays silent.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    extractChannelSyncErrors,
    hasDigestMismatch,
} from '../../src/pages/machine/providerChannelErrors'

/** The real daemon shape: handler.ts returns { success, activated, channelSync }. */
const DIGEST_MISMATCH_RESPONSE = {
    result: {
        success: true,
        activated: [],
        channelSync: {
            channel: 'stable',
            status: 'error',
            activated: [],
            skipped: [],
            errors: [
                {
                    code: 'DIGEST_MISMATCH',
                    message: 'tree digest mismatch for "kimi": channel=sha256:aaa recomputed=sha256:bbb — refusing activation',
                    providerType: 'kimi',
                },
            ],
        },
    },
}

describe('provider channel install error surfacing', () => {
    it('extracts the typed DIGEST_MISMATCH reason from the daemon response', () => {
        const errors = extractChannelSyncErrors(DIGEST_MISMATCH_RESPONSE)
        expect(errors).toHaveLength(1)
        expect(errors[0].code).toBe('DIGEST_MISMATCH')
        expect(errors[0].providerType).toBe('kimi')
        expect(errors[0].message).toContain('refusing activation')
        expect(hasDigestMismatch(errors)).toBe(true)
    })

    it('handles an unwrapped response identically', () => {
        const errors = extractChannelSyncErrors(DIGEST_MISMATCH_RESPONSE.result)
        expect(errors.map((e) => e.code)).toEqual(['DIGEST_MISMATCH'])
    })

    /**
     * Sync-level failures carry NO providerType. Filtering errors by the
     * requested type would drop exactly these — the ones that explain why
     * nothing installed at all.
     */
    it('keeps sync-level errors that carry no providerType', () => {
        const errors = extractChannelSyncErrors({
            result: {
                success: true,
                channelSync: {
                    status: 'error',
                    errors: [
                        { code: 'CHANNEL_METADATA_UNAVAILABLE', message: 'registry unreachable' },
                        { code: 'TRANSPORT_FAILED', message: 'provider tarball transport failed: HTTP 503' },
                    ],
                },
            },
        })
        expect(errors.map((e) => e.code)).toEqual(['CHANNEL_METADATA_UNAVAILABLE', 'TRANSPORT_FAILED'])
        expect(hasDigestMismatch(errors)).toBe(false)
    })

    it('surfaces the command-level failure path', () => {
        const errors = extractChannelSyncErrors({ result: { success: false, error: 'invalid type: %%%' } })
        expect(errors).toEqual([{ code: 'COMMAND_FAILED', message: 'invalid type: %%%' }])
    })

    it('reports nothing for a clean install', () => {
        expect(extractChannelSyncErrors({
            result: { success: true, activated: [{ providerType: 'kimi' }], channelSync: { status: 'activated', errors: [] } },
        })).toEqual([])
        expect(extractChannelSyncErrors(null)).toEqual([])
        expect(extractChannelSyncErrors(undefined)).toEqual([])
    })

    /**
     * The half that makes the above matter: ProvidersTab must actually call
     * the extractor and render what it returns. Asserting on the source keeps
     * an unwired extractor from passing as "surfaced".
     */
    it('is wired into ProvidersTab — captured on install and rendered', () => {
        const source = readFileSync(
            join(__dirname, '../../src/pages/machine/ProvidersTab.tsx'),
            'utf-8',
        )
        // Captured from the install call rather than discarded.
        expect(source).toContain('extractChannelSyncErrors(res)')
        expect(source).toContain('setInstallErrors')
        // Rendered: the digest-specific explanation and the full error list.
        expect(source).toContain('installFailedDigestMismatch')
        expect(source).toContain('hasDigestMismatch(errors)')
        expect(source).toContain('errors.map(')
        // The install call must not be a bare await that drops the response.
        expect(source).not.toMatch(/await sendDaemonCommand\(machineId, 'activate_provider_updates', \{ types: \[providerType\] \}\)\s*\n\s*\} finally/)
    })
})
