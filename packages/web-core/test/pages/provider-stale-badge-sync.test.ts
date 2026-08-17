import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const DETAIL = path.join(import.meta.dirname, '../../src/pages/MachineDetail.tsx')
const detailSource = fs.readFileSync(DETAIL, 'utf8')

describe('provider stale badge — one-click sync', () => {
    it('sends activate_provider_updates, not a new command', () => {
        expect(detailSource).toContain('PROVIDER_CHANNEL_SYNC_COMMAND')
        expect(detailSource).toContain("from '../utils/provider-channel-sync'")
        expect(detailSource).not.toContain("'sync_provider_channel'")
        expect(detailSource).not.toContain("'providers sync'")
    })

    it('wires the Providers-tab stale count as a clickable action with toast', () => {
        expect(detailSource).toContain('handleProviderStaleBadgeClick')
        expect(detailSource).toContain('eventManager.showToast')
        expect(detailSource).toContain('machine.detail.providerSyncSuccess')
        expect(detailSource).toContain('machine.detail.providerSyncFailed')
        expect(detailSource).toContain('machine.detail.providerStaleBadgeHint')
    })

    it('does not turn the workspace session count into a sync button', () => {
        const badgeBlock = detailSource.slice(
            detailSource.indexOf("tab.id === 'providers' && providerStaleness"),
        )
        expect(badgeBlock).toContain('handleProviderStaleBadgeClick')
        expect(detailSource).toContain("tab.id === 'providers' && providerStaleness")
    })
})

describe('i18n', () => {
    it('ships stale-badge copy in every locale', () => {
        const keys = [
            'providerStaleBadgeHint',
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
        }
    })
})
