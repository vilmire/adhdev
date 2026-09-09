// O10 (2026-09, owner decision): delete billing/plan-limit i18n keys with
// zero source references. G2 (fdb93b801) already removed 9 such keys by
// deleting their call sites (Team seat management UI, About.tsx 4th feature
// bullet, Landing.tsx mesh bullet) without touching the locale JSON, leaving
// the strings orphaned. This pass re-counted from current-tree usage and
// found 24 actually-unused keys (not 11 — the original estimate predates
// G2's landing and undercounted).
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'

const LOCALES = [...SUPPORTED_LANGUAGES]

const REMOVED_KEYS = [
    'cloud.account.limitWebhooks',
    'cloud.billing.title',
    'cloud.billing.subtitle',
    'cloud.billing.statTeam',
    'cloud.billing.planLimitsTitle',
    'cloud.billing.limitApiCalls',
    'cloud.billing.limitSharedSessions',
    'cloud.billing.limitScreenshotMinutes',
    'cloud.billing.limitDescMachines',
    'cloud.billing.limitDescPush',
    'cloud.billing.limitDescWebhooks',
    'cloud.billing.limitDescApiCalls',
    'cloud.billing.limitDescSharedSessions',
    'cloud.billing.limitDescScreenshotMinutes',
    'cloud.billing.teamSeats',
    'cloud.billing.seatsUsed',
    'cloud.billing.pricePerMonth',
    'cloud.billing.cannotReduceSeats',
    'cloud.billing.removeSeat',
    'cloud.billing.addSeat',
    'cloud.about.plans.freeFeature4',
    'cloud.about.plans.proFeature4',
    'landing.pricing.plans.free.features.mesh',
    'landing.pricing.plans.pro.features.mesh',
]

// Keys that look similar (same namespace, adjacent names) but ARE referenced
// in source and must survive. Kept here as a control group so a future
// "clean up more unused keys" pass doesn't sweep these up by pattern-matching
// the names above instead of checking real usage.
const LIVE_CONTROL_KEYS = [
    'cloud.billing.resetsInHours_one', // i18next plural variant of a live base key
    'cloud.billing.resetsInMinutes_one',
    'cloud.account.limitMachines',
    'cloud.account.limitP2P',
    'cloud.account.limitPushNotifications',
    'cloud.account.limitTurnRelay',
    'cloud.planCard.teamMemberPlural', // legacy Team-plan fallback branch, still reachable
    'cloud.planCard.teamMemberSingular',
    'landing.pricing.plans.ultra.features.webhooks', // O2 repurposed this slot, did not remove it
]

function getPath(obj: any, path: string): unknown {
    return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj)
}

async function loadCommon(locale: string): Promise<any> {
    return (await import(`../../src/i18n/locales/${locale}/common.json`)).default
}

describe('unused billing/plan-limit i18n keys stay removed (O10)', () => {
    for (const locale of LOCALES) {
        it(`${locale}: none of the 24 confirmed-dead keys are present`, async () => {
            const common = await loadCommon(locale)
            for (const key of REMOVED_KEYS) {
                expect(getPath(common, key)).toBeUndefined()
            }
        })

        it(`${locale}: adjacent live keys were not accidentally swept up`, async () => {
            const common = await loadCommon(locale)
            for (const key of LIVE_CONTROL_KEYS) {
                expect(getPath(common, key)).toBeDefined()
            }
        })
    }
})
