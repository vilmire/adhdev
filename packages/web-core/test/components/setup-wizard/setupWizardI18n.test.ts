/**
 * setupWizard i18n parity — every setupWizard.* key must exist in all shipped
 * locales (the wizard renders nothing but these keys; a missing one shows a
 * raw key to the user). Also pins the two nav labels added for the wizard
 * entry points (standalone.nav.setupWizard, cloud.layout.navSetupWizard).
 *
 * Pattern mirrors test/pages/quota-toggle-render.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const LOCALES = ['en', 'ko', 'ja', 'zh-CN', 'es']

function loadLocale(lang: string): any {
    const file = path.join(import.meta.dirname, `../../../src/i18n/locales/${lang}/common.json`)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Recursively collect dotted key paths of every leaf under `node`. */
function leafPaths(node: any, prefix = ''): string[] {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return [prefix]
    return Object.entries(node).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
}

function dig(node: any, dotted: string): unknown {
    return dotted.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? (acc as any)[k] : undefined), node)
}

describe('setupWizard i18n parity', () => {
    const en = loadLocale('en')
    const paths = leafPaths(en.setupWizard, 'setupWizard')

    it('the en locale actually carries the wizard keys (guard against a vacuous pass)', () => {
        // quotaPolicy alone is ~18 keys; the shell + 4 new steps push this well past 50.
        expect(paths.length).toBeGreaterThan(50)
        expect(en.setupWizard?.title).toBeTruthy()
        expect(en.setupWizard?.steps?.machines).toBeTruthy()
        expect(en.setupWizard?.finish?.apply).toBeTruthy()
    })

    for (const lang of LOCALES.filter(l => l !== 'en')) {
        it(`every setupWizard key exists in ${lang}`, () => {
            const dict = loadLocale(lang)
            for (const p of paths) {
                expect(dig(dict, p), `${lang} is missing ${p}`).toBeTruthy()
            }
        })
    }

    it('wizard nav labels exist in all shipped locales', () => {
        for (const lang of LOCALES) {
            const dict = loadLocale(lang)
            expect(dict.standalone?.nav?.setupWizard, `${lang} is missing standalone.nav.setupWizard`).toBeTruthy()
            expect(dict.cloud?.layout?.navSetupWizard, `${lang} is missing cloud.layout.navSetupWizard`).toBeTruthy()
        }
    })
})
