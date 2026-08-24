/**
 * The quota-busy fallback toggle must actually be reachable in the UI.
 *
 * Owner requirement: a per-mesh switch, on the SCHEDULING tab, defaulting ON.
 * The daemon-side default is asserted in daemon-core's
 * mesh-quota-busy-fallback.test.ts; this file guards the half that a
 * typecheck cannot catch — that the control is rendered inside the scheduling
 * tab (not merely defined), that it writes the nested quotaRouting sub-object
 * rather than a flat policy key, and that every shipped locale has its strings.
 *
 * INJECTION CHECK: deleting the <select> from schedulingTabContent, moving it to
 * another tab, flattening the patch to `onUpdatePolicy({ quotaBusyFallback })`,
 * or dropping a locale key turns this red.
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
 * The scheduling tab's JSX, from its declaration to the next TOP-LEVEL tab
 * declaration. Anchored on the `const <name>TabContent` sibling rather than any
 * `const`, since the tab body itself contains nested consts — slicing at the
 * first one would silently truncate the region under test and pass/fail for
 * the wrong reason.
 */
function schedulingTabSource(): string {
    const start = source.indexOf('const schedulingTabContent')
    expect(start).toBeGreaterThan(-1)
    const rest = source.slice(start + 'const schedulingTabContent'.length)
    const next = rest.search(/\n\s*const \w+TabContent\b/)
    return rest.slice(0, next > -1 ? next : undefined)
}

describe('quota-busy fallback toggle — placement', () => {
    it('renders inside the scheduling tab', () => {
        // Owner: "메시세팅하는곳 스케줄링 탭에 만들어 두면 좋아보임".
        expect(schedulingTabSource()).toContain('repoMesh.detail.quotaBusyFallback')
    })

    it('is registered as a real tab the operator can open', () => {
        expect(source).toMatch(/key:\s*'scheduling'[\s\S]{0,120}content:\s*schedulingTabContent/)
    })

    it('offers exactly the two on/off choices', () => {
        const tab = schedulingTabSource()
        expect(tab).toContain('repoMesh.detail.quotaBusyFallbackOn')
        expect(tab).toContain('repoMesh.detail.quotaBusyFallbackOff')
    })
})

describe('quota-busy fallback toggle — binding', () => {
    it('patches the NESTED quotaRouting sub-object, preserving sibling thresholds', () => {
        // A flat `onUpdatePolicy({ quotaBusyFallback })` would land the field at
        // the wrong level and be dropped by the daemon's policy normalizer; not
        // spreading the current value would silently clear the other quota
        // thresholds the operator has configured.
        expect(schedulingTabSource()).toMatch(
            /onUpdatePolicy\(\{\s*quotaRouting:\s*\{\s*\.\.\.qr,\s*quotaBusyFallback:/,
        )
    })

    it('treats only an explicit false as off, matching the daemon default', () => {
        // Default ON: an unset field must render as "on", so the UI and
        // resolveQuotaRoutingPolicy cannot disagree about what a fresh mesh does.
        expect(schedulingTabSource()).toContain('qr.quotaBusyFallback !== false')
    })
})

describe('quota-busy fallback toggle — i18n', () => {
    const KEYS = [
        'quotaBusyFallback',
        'quotaBusyFallbackHint',
        'quotaBusyFallbackOn',
        'quotaBusyFallbackOff',
    ]

    for (const [locale, bundle] of Object.entries(LOCALES)) {
        it(`${locale} ships every string (no raw key leaking into the UI)`, () => {
            for (const key of KEYS) {
                const value = bundle?.repoMesh?.detail?.[key]
                expect(typeof value, `${locale}.repoMesh.detail.${key}`).toBe('string')
                expect(value.length, `${locale}.repoMesh.detail.${key}`).toBeGreaterThan(0)
            }
        })
    }
})
