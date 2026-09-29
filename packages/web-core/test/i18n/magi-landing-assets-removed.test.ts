// MAGI (the multi-agent cross-verification engine) was retired in favour of a
// coordinator prompt recipe (send the same question to several workers with
// mesh_send_task and synthesize the answers). Its landing section had already
// been removed (commit d8292be1f, 2026-07-22, plus the dead assets in O9); with the
// engine gone, the dashboard editor keys, the glossary entries and the landing
// copy that named it went too. The capability the landing copy describes — asking
// several machines and models the same question — is still offered, by name only
// no longer.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'

const LOCALES = [...SUPPORTED_LANGUAGES]

async function loadCommon(locale: string): Promise<any> {
    return (await import(`../../src/i18n/locales/${locale}/common.json`)).default
}

function localePath(locale: string): string {
    return fileURLToPath(new URL(`../../src/i18n/locales/${locale}/common.json`, import.meta.url))
}

describe('MAGI is gone from every locale', () => {
    for (const locale of LOCALES) {
        it(`${locale}: no MAGI key or text anywhere`, () => {
            const text = readFileSync(localePath(locale), 'utf-8')
            expect(text).not.toMatch(/MAGI|"magi/)
        })

        it(`${locale}: the cross-check landing copy survives, reworded`, async () => {
            const common = await loadCommon(locale)
            expect(common.landing.mesh.crossSubtitle).toBeTruthy()
            expect(common.landing.mesh.crossDesc).toBeTruthy()
            expect(common.landing.compare.rowCrossCheckAdhdev).toBeTruthy()
            expect(common.mesh.magiKind).toBeUndefined()
            expect(common.mesh.help.sections.magi).toBeUndefined()
        })
    }

    it('the two dead /public MAGI images stay gone', () => {
        const diagram = fileURLToPath(
            new URL('../../../../../packages/web-cloud/public/landing-magi-diagram.svg', import.meta.url),
        )
        const synthesis = fileURLToPath(
            new URL('../../../../../packages/web-cloud/public/landing-magi-synthesis.jpg', import.meta.url),
        )
        expect(existsSync(diagram)).toBe(false)
        expect(existsSync(synthesis)).toBe(false)
    })

    it('landing.css no longer defines .magi-media rules', () => {
        // packages/web-cloud is the proprietary root package and does not
        // exist in the oss-only (vilmire/adhdev) checkout that runs this
        // suite in CI, so the content invariant is only checked when present.
        const css = fileURLToPath(
            new URL('../../../../../packages/web-cloud/src/landing.css', import.meta.url),
        )
        if (!existsSync(css)) return
        expect(readFileSync(css, 'utf-8')).not.toMatch(/\.magi-media\b/)
    })
})
