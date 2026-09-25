// Localized copy seams added by the 2026-09-25 i18n sweep: the helpers keep
// their English defaults (existing tests pin those), and render in the user's
// language once a `t` is supplied. Uses getFixedT so the global test language
// (pinned to `en` in test/setup.ts) is never switched.
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { LOCALIZED_PROVIDER_SETTING_KEYS, localizeProviderSetting } from '../../src/utils/provider-setting-copy'
import { buildQuotaDisplayModel, createQuotaTextFormatter, formatQuotaFreshness, QUOTA_WINDOW_RESET_TEXT } from '../../src/utils/quota-format'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'

const ko = i18next.getFixedT('ko', 'common')
const en = i18next.getFixedT('en', 'common')

describe('provider setting copy', () => {
    it('translates known setting keys by key, not by the English manifest label', () => {
        const copy = localizeProviderSetting(ko, { key: 'executablePath', label: 'Executable path', description: 'Optional absolute path…' }, 'Claude Code')
        expect(copy.label).toBe('실행 파일 경로')
        expect(copy.description).toContain('Claude Code')
        expect(copy.description).not.toContain('Optional')
    })

    it('falls back to the daemon label (then the key) for unknown settings', () => {
        expect(localizeProviderSetting(ko, { key: 'someVendorFlag', label: 'Vendor flag', description: 'd' })).toEqual({ label: 'Vendor flag', description: 'd' })
        expect(localizeProviderSetting(ko, { key: 'bareKey' })).toEqual({ label: 'bareKey', description: '' })
    })

    it('ships a non-empty label + description for every known key in every locale', () => {
        for (const lng of SUPPORTED_LANGUAGES) {
            const t = i18next.getFixedT(lng, 'common')
            for (const key of LOCALIZED_PROVIDER_SETTING_KEYS) {
                for (const part of ['label', 'description']) {
                    const full = `machine.providerSettings.${key}.${part}`
                    expect(i18next.exists(full, { lng, ns: 'common', fallbackLng: false } as any), `${lng} ${full}`).toBe(true)
                    expect(t(full, { provider: 'X' })).not.toBe(full)
                }
            }
        }
    })
})

describe('quota text formatter', () => {
    const NOW = Date.parse('2026-09-25T12:00:00Z')

    it('English formatter reproduces the historical default text', () => {
        const q = { status: 'ok', session: { usedPercent: 26, windowMinutes: 300, resetsAt: NOW + 2 * 3600_000 + 14 * 60_000 } } as any
        expect(buildQuotaDisplayModel(q, NOW, createQuotaTextFormatter(en)).compactChip?.label)
            .toBe(buildQuotaDisplayModel(q, NOW).compactChip?.label)
        expect(createQuotaTextFormatter(en).windowReset()).toBe(QUOTA_WINDOW_RESET_TEXT)
    })

    it('renders chips, the reset state, failures and freshness in Korean', () => {
        const fmt = createQuotaTextFormatter(ko)
        const live = buildQuotaDisplayModel({ status: 'ok', session: { usedPercent: 40, windowMinutes: 300, resetsAt: NOW + 2 * 3600_000 } } as any, NOW, fmt)
        expect(live.compactChip?.label).toBe('5h 40.0% 사용 · 2시간 0분 후 초기화')
        const reset = buildQuotaDisplayModel({ status: 'error', session: { usedPercent: 100, windowMinutes: 300, resetsAt: NOW - 60_000 }, metadata: { failureKind: 'no-data' } } as any, NOW, fmt)
        expect(reset.chips[0].label).toBe('5h 초기화됨 · 새 값 대기 중')
        const failed = buildQuotaDisplayModel({ status: 'error', metadata: { failureKind: 'expired-token' } } as any, NOW, fmt)
        expect(failed.message).toBe('로그인 만료')
        expect(formatQuotaFreshness(NOW - 5 * 60_000, NOW, fmt)).toBe('5분 전')
    })
})
