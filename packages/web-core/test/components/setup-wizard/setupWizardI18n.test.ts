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
        // The wizard is one step (create/attach) that hands off to the mesh page;
        // the staged steps 2-5 and their shell/finish keys are gone. quotaPolicy is
        // retained for the pending port of quota routing onto the mesh page.
        expect(paths.length).toBeGreaterThan(30)
        expect(en.setupWizard?.title).toBeTruthy()
        expect(en.setupWizard?.machines?.title).toBeTruthy()
        expect(en.setupWizard?.continueToMesh).toBeTruthy()
    })

    it('does not retain keys for the removed staged steps', () => {
        // These rendered the multi-step shell and the Finish commit. Leaving them
        // behind is how a locale accumulates strings no code can reach.
        for (const dead of ['steps', 'stepOf', 'back', 'skip', 'next', 'finish', 'staged', 'slots', 'scheduling', 'approvals']) {
            expect(en.setupWizard?.[dead], `setupWizard.${dead} is orphaned`).toBeUndefined()
        }
    })

    for (const lang of LOCALES.filter(l => l !== 'en')) {
        it(`every setupWizard key exists in ${lang}`, () => {
            const dict = loadLocale(lang)
            for (const p of paths) {
                expect(dig(dict, p), `${lang} is missing ${p}`).toBeTruthy()
            }
        })
    }

    it('no locale still carries the removed sidebar nav labels', () => {
        // Setup lost its sidebar entry (onboarding hands off to Mesh), so these two
        // labels have no renderer left. Pinned as absent so they are not resurrected
        // as dead strings.
        for (const lang of LOCALES) {
            const dict = loadLocale(lang)
            expect(dict.standalone?.nav?.setupWizard, `${lang} still has standalone.nav.setupWizard`).toBeUndefined()
            expect(dict.cloud?.layout?.navSetupWizard, `${lang} still has cloud.layout.navSetupWizard`).toBeUndefined()
        }
    })
})
