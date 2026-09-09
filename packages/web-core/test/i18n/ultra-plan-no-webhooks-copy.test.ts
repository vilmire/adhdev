// The Ultra plan card advertised "More webhooks & API calls" as a selling
// point, but Webhooks is a FROZEN surface (docs/FROZEN_SURFACES.md) — its UI
// is hidden behind FEATURE_FLAGS.webhooks=false. Advertising a hidden feature
// as a paid-tier benefit violates docs/CONCEPTS.md §7's "쓰면 안 되는 것"
// list (Webhooks·API Keys dashboard: selling point 금지). Owner decision
// (2026-09, O2): drop the Webhooks mention, keep the API calls mention since
// `monthlyApiCalls` is a live plan-limits axis.
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'

const LOCALES = [...SUPPORTED_LANGUAGES]

async function loadCommon(locale: string): Promise<Record<string, unknown>> {
    return (await import(`../../src/i18n/locales/${locale}/common.json`)).default
}

function getUltraFeatures(common: Record<string, unknown>): Record<string, string> {
    const landing = common.landing as any
    return landing.pricing.plans.ultra.features
}

describe('Ultra plan card no longer sells Webhooks (O2)', () => {
    for (const locale of LOCALES) {
        it(`${locale}: ultra pricing features never mention webhook`, async () => {
            const common = await loadCommon(locale)
            const features = getUltraFeatures(common)
            for (const value of Object.values(features)) {
                expect(value.toLowerCase()).not.toContain('webhook')
            }
        })

        it(`${locale}: ultra pricing still mentions API`, async () => {
            const common = await loadCommon(locale)
            const features = getUltraFeatures(common)
            // The `webhooks` key name is retained (only its copy changed) —
            // it is the feature slot that used to carry the Webhooks mention.
            // Every locale keeps "API" untranslated, so this is a real signal
            // rather than a non-empty-string tautology.
            expect(features.webhooks).toContain('API')
        })
    }
})
