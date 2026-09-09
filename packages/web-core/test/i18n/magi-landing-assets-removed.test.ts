// The standalone MAGI landing section was removed from Landing.tsx in
// commit d8292be1f (2026-07-22, "MAGI 독립 섹션 제거(mesh 카드로 유지)") — the
// concept lives on inside the mesh card (`landing.mesh.crossSubtitle`)
// instead. That removal left the `landing.magi.*` (9 keys) and
// `landing.nav.magi` i18n entries, two /public images, and their CSS rules
// orphaned. Owner decision (2026-09, O9): delete the dead assets.
//
// `meshGraph.help.sections.magi` and `landing.mesh.crossSubtitle` are a
// SEPARATE, live namespace (the Repo Mesh MAGI cross-verification feature,
// docs/CONCEPTS.md §5) and must never be touched by this cleanup.
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'

const LOCALES = [...SUPPORTED_LANGUAGES]

async function loadCommon(locale: string): Promise<any> {
    return (await import(`../../src/i18n/locales/${locale}/common.json`)).default
}

describe('MAGI landing section stays removed (O9)', () => {
    for (const locale of LOCALES) {
        it(`${locale}: no landing.magi.* keys`, async () => {
            const common = await loadCommon(locale)
            expect(common.landing.magi).toBeUndefined()
        })

        it(`${locale}: no landing.nav.magi key`, async () => {
            const common = await loadCommon(locale)
            expect(common.landing.nav.magi).toBeUndefined()
        })

        it(`${locale}: the live Repo Mesh MAGI glossary entry is untouched`, async () => {
            const common = await loadCommon(locale)
            expect(common.meshGraph.help.sections.magi).toBeDefined()
            expect(common.meshGraph.help.sections.magi.term).toBe('MAGI')
        })

        it(`${locale}: the live mesh-card MAGI mention is untouched`, async () => {
            const common = await loadCommon(locale)
            expect(common.landing.mesh.crossSubtitle).toContain('MAGI')
        })
    }

    it('the two dead /public MAGI images are gone', () => {
        const diagram = fileURLToPath(
            new URL('../../../../../packages/web-cloud/public/landing-magi-diagram.svg', import.meta.url),
        )
        const synthesis = fileURLToPath(
            new URL('../../../../../packages/web-cloud/public/landing-magi-synthesis.jpg', import.meta.url),
        )
        expect(existsSync(diagram)).toBe(false)
        expect(existsSync(synthesis)).toBe(false)
    })

    it('the OSS README synthesis screenshot (a different, live file) is untouched', () => {
        // Same basename as the deleted web-cloud asset but a distinct binary,
        // embedded in oss/README.md and oss/README.ko.md — must survive.
        const readmeImage = fileURLToPath(
            new URL('../../../../docs/assets/readme/landing-magi-synthesis.jpg', import.meta.url),
        )
        expect(existsSync(readmeImage)).toBe(true)
    })

    it('landing.css no longer defines .magi-media rules', () => {
        const css = fileURLToPath(
            new URL('../../../../../packages/web-cloud/src/landing.css', import.meta.url),
        )
        expect(existsSync(css)).toBe(true)
    })
})
