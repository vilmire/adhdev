/**
 * The quota-busy fallback toggle must actually be reachable in the UI.
 *
 * Owner requirement: a per-mesh switch, defaulting ON. Since the 2026-09-27
 * settings simplification it lives in the Advanced tab's "Quota routing"
 * group, next to the quota thresholds it belongs with (quotaRouting is ONE
 * nested policy object). The daemon-side default is asserted in daemon-core's
 * mesh-quota-busy-fallback.test.ts; this file guards the half that a
 * typecheck cannot catch — that the control is rendered inside a real tab
 * (not merely defined), that it writes the nested quotaRouting sub-object
 * rather than a flat policy key, that saving the thresholds does not drop it,
 * and that every shipped locale has its strings.
 *
 * INJECTION CHECK: deleting the Switch from advancedTabContent, flattening the
 * patch to `onUpdatePolicy({ quotaBusyFallback })`, dropping the carry-over in
 * the threshold save, or dropping a locale key turns this red.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const LOCALES: Record<string, any> = { en, ko, ja, 'zh-CN': zhCN, es }

const source = readFileSync(
    fileURLToPath(new URL('../../../src/pages/repo-mesh/MeshDetailView.tsx', import.meta.url)),
    'utf8',
)

/**
 * The advanced tab's JSX, from its declaration to the next TOP-LEVEL
 * declaration. Anchored on the `const <name>TabContent` / `const tabs` sibling
 * rather than any `const`, since the tab body itself contains nested consts —
 * slicing at the first one would silently truncate the region under test.
 */
function advancedTabSource(): string {
    const start = source.indexOf('const advancedTabContent')
    expect(start).toBeGreaterThan(-1)
    const rest = source.slice(start + 'const advancedTabContent'.length)
    const next = rest.search(/\n\s*const (\w+TabContent|tabs)\b/)
    return rest.slice(0, next > -1 ? next : undefined)
}

describe('quota-busy fallback toggle — placement', () => {
    it('renders inside the advanced tab, in the quota routing group', () => {
        const tab = advancedTabSource()
        expect(tab).toContain('mesh.detail.quotaBusyFallback')
        expect(tab).toContain('<QuotaPolicyStep')
    })

    it('is registered as a real tab the operator can open', () => {
        expect(source).toMatch(/key:\s*'advanced'[\s\S]{0,160}content:\s*advancedTabContent/)
    })

    it('is an on/off Switch', () => {
        expect(advancedTabSource()).toMatch(/<Switch[\s\S]{0,80}checked=\{quotaBusyFallbackOn\}/)
    })
})

describe('quota-busy fallback toggle — binding', () => {
    it('patches the NESTED quotaRouting sub-object, preserving sibling thresholds', () => {
        // A flat `onUpdatePolicy({ quotaBusyFallback })` would land the field at
        // the wrong level and be dropped by the daemon's policy normalizer; not
        // spreading the current value would silently clear the other quota
        // thresholds the operator has configured.
        expect(advancedTabSource()).toMatch(
            /onUpdatePolicy\(\{\s*quotaRouting:\s*\{\s*\.\.\.quotaRouting,\s*quotaBusyFallback:/,
        )
    })

    it('saving the thresholds carries the busy fallback over instead of dropping it', () => {
        expect(advancedTabSource()).toMatch(/quotaRouting\.quotaBusyFallback !== undefined \? \{ quotaBusyFallback: quotaRouting\.quotaBusyFallback \}/)
    })

    it('treats only an explicit false as off, matching the daemon default', () => {
        // Default ON: an unset field must render as "on", so the UI and
        // resolveQuotaRoutingPolicy cannot disagree about what a fresh mesh does.
        expect(source).toContain('quotaRouting.quotaBusyFallback !== false')
    })
})

describe('quota-busy fallback toggle — i18n', () => {
    const KEYS = [
        'quotaBusyFallback',
        'quotaBusyFallbackHint',
    ]

    for (const [locale, bundle] of Object.entries(LOCALES)) {
        it(`${locale} ships every string (no raw key leaking into the UI)`, () => {
            for (const key of KEYS) {
                const value = bundle?.mesh?.detail?.[key]
                expect(typeof value, `${locale}.mesh.detail.${key}`).toBe('string')
                expect(value.length, `${locale}.mesh.detail.${key}`).toBeGreaterThan(0)
            }
        })
    }
})
