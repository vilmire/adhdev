import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// PROVIDERS TAB — update hint is a DOT, not a number (owner feedback
// 2026-09-25: "a number on the update badge looks very strange; show an
// Update button next to the provider instead").
//
// The daemon's 24h read-only staleness probe still surfaces on the tab —
// that is the only signal, without opening the tab, that a provider fix is
// waiting (a published kimi fix once sat unadopted for a day). But the hint is
// a non-interactive dot; the action is the per-provider inline Update inside
// the tab (see providers-tab-behavior.test.tsx). The old badge was also a
// click target nested inside the tab <button> that synced everything, and the
// only producer of the refresh nonce that re-fetched on every status tick.

const DETAIL = path.join(import.meta.dirname, '../../src/pages/MachineDetail.tsx')
const detailSource = fs.readFileSync(DETAIL, 'utf8')

describe('providers tab update hint', () => {
    it('renders a labelled dot, not a count, for stale/new channel types', () => {
        expect(detailSource).toContain("t('machine.detail.providerUpdatesAvailable')")
        expect(detailSource).toContain('providers-update-dot')
        // No count derived from staleness on the providers tab entry.
        expect(detailSource).not.toMatch(/count:\s*providerStaleness/)
    })

    it('the hint is not a click target and no longer drives a refresh nonce', () => {
        expect(detailSource).not.toContain('handleProviderStaleBadgeClick')
        expect(detailSource).not.toContain('providerSyncNonce')
        expect(detailSource).not.toContain('refreshNonce')
        expect(detailSource).not.toContain('machine.detail.providerStaleBadgeHint')
    })

    it('the tab keeps the dot current from the Providers tab own read', () => {
        expect(detailSource).toContain('onChannelStaleness={setProviderStaleness}')
    })
})

describe('i18n', () => {
    it('ships the hint + update toast copy in every locale', () => {
        const keys = [
            'providerUpdatesAvailable',
            'providerSyncSuccess',
            'providerSyncAlreadyCurrent',
            'providerSyncFailed',
        ]
        for (const lang of ['en', 'ko', 'ja', 'zh-CN', 'es']) {
            const file = path.join(import.meta.dirname, `../../src/i18n/locales/${lang}/common.json`)
            const dict = JSON.parse(fs.readFileSync(file, 'utf8'))
            for (const key of keys) {
                expect(dict.machine?.detail?.[key], `${lang} is missing ${key}`).toBeTruthy()
            }
            expect(dict.machine?.detail?.providerStaleBadgeHint, `${lang} still ships the retired badge hint`).toBeUndefined()
        }
    })
})
