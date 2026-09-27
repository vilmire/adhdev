/**
 * Only the `en` catalog (the fallback) is bundled; ko/ja/zh-CN/es (~250-315 KB of
 * JSON each) load on demand through `lazyLocaleBackend`. Uses isolated i18next
 * instances built with the production init options so the shared instance the
 * setup file pinned to `en` is untouched.
 */
import fs from 'node:fs'
import path from 'node:path'
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'

import { createI18nInitOptions, lazyLocaleBackend, loadLocaleCatalog } from '../../src/i18n/config'
import enCommon from '../../src/i18n/locales/en/common.json'
import koCommon from '../../src/i18n/locales/ko/common.json'
import jaCommon from '../../src/i18n/locales/ja/common.json'

const configSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/i18n/config.ts'), 'utf8')

function newInstance() {
    return i18next.createInstance().use(lazyLocaleBackend)
}

describe('lazy locale catalogs', () => {
    it('statically imports only the en catalog', () => {
        const staticLocaleImports = [...configSource.matchAll(/^import\s+\w+\s+from\s+'\.\/locales\/([^/]+)\/common\.json'/gm)].map(m => m[1])
        expect(staticLocaleImports).toEqual(['en'])
        for (const lng of ['ko', 'ja', 'zh-CN', 'es']) {
            expect(configSource).toContain(`import('./locales/${lng}/common.json')`)
        }
    })

    it('boots a non-en language by loading its catalog; en stays the bundled fallback', async () => {
        const inst = newInstance()
        const ready = inst.init(createI18nInitOptions('ko'))
        // Synchronously after init(): en is there, ko is still being fetched.
        expect(inst.hasResourceBundle('en', 'common')).toBe(true)
        expect(inst.hasResourceBundle('ko', 'common')).toBe(false)

        await ready
        expect(inst.language).toBe('ko')
        expect(inst.hasResourceBundle('ko', 'common')).toBe(true)
        expect(inst.t('connection.loadingShort')).toBe(koCommon.connection.loadingShort)
        // ko leaves this string empty on purpose; returnEmptyString:false → en fallback.
        expect(koCommon.cloud.webhooks.secretShownOncePrefix).toBe('')
        expect(inst.t('cloud.webhooks.secretShownOncePrefix')).toBe(enCommon.cloud.webhooks.secretShownOncePrefix)
    })

    it('an en boot is ready synchronously and never calls the backend', async () => {
        const inst = newInstance()
        void inst.init(createI18nInitOptions('en'))
        expect(inst.isInitialized).toBe(true)
        expect(inst.hasLoadedNamespace('common')).toBe(true)
        expect(inst.t('connection.loadingShort')).toBe(enCommon.connection.loadingShort)
        expect(inst.hasResourceBundle('ja', 'common')).toBe(false)
    })

    it('changeLanguage loads the catalog first and only then switches (no English flash)', async () => {
        const inst = newInstance()
        await inst.init(createI18nInitOptions('en'))
        const seen: string[] = []
        inst.on('languageChanged', lng => seen.push(`${lng}:${inst.hasResourceBundle(lng, 'common')}`))

        const switching = inst.changeLanguage('ja')
        // Still rendering the old language while ja is in flight.
        expect(inst.language).toBe('en')
        await switching
        expect(inst.language).toBe('ja')
        expect(seen).toEqual(['ja:true'])
        expect(inst.t('connection.loadingShort')).toBe(jaCommon.connection.loadingShort)
    })

    it('loadLocaleCatalog returns null for the bundled default and unsupported tags', async () => {
        await expect(loadLocaleCatalog('en')).resolves.toBeNull()
        await expect(loadLocaleCatalog('fr')).resolves.toBeNull()
        await expect(loadLocaleCatalog('ko')).resolves.toMatchObject({ connection: { loadingShort: koCommon.connection.loadingShort } })
    })
})
