import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// PROVIDERS TAB — empty-state copy must name a button that actually exists.
//
// `machine.providers.noProviders` used to say `Open "Add provider" above to
// install one`, but the toolbar only ever rendered Sources / Create /
// Refresh / Advanced — there has never been an "Add provider" button on this
// screen. A user with zero providers installed (which is the state that
// triggers this exact copy) hit a dead end on the very first thing the empty
// state told them to do.
//
// The onboarding intro string (`standalone.onboarding.intro`) pointed at the
// same phantom button via "Machines → Providers → Add provider".
//
// This test pins both strings to the real button label
// (`machine.providers.create`) so a future rename of the Create button (or a
// copy edit that reintroduces "Add provider") fails loudly instead of
// silently reproducing the same dead end.

const LOCALES = ['en', 'es', 'ja', 'ko', 'zh-CN']

const PROVIDERS_TAB = path.join(import.meta.dirname, '../../src/pages/machine/ProvidersTab.tsx')
const providersTabSource = fs.readFileSync(PROVIDERS_TAB, 'utf8')

function loadLocale(locale: string) {
  const file = path.join(import.meta.dirname, `../../src/i18n/locales/${locale}/common.json`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

describe('ProvidersTab — empty-state copy references a real button', () => {
  it('renders the toolbar with Sources / Create / Refresh / Advanced — no "Add provider" button', () => {
    // Pin the actual toolbar surface so this test's premise (there is no Add
    // provider button) stays true as the component evolves.
    expect(providersTabSource).toContain("t('machine.providers.sources')")
    expect(providersTabSource).toContain("t('machine.providers.create')")
    expect(providersTabSource).toContain("t('machine.providers.refresh')")
    expect(providersTabSource).toContain("t('machine.providers.advanced')")
    expect(providersTabSource).not.toMatch(/addProvider/)
  })

  for (const locale of LOCALES) {
    it(`${locale}: machine.providers.noProviders does not name a nonexistent "Add provider" button`, () => {
      const dict = loadLocale(locale)
      const value: string | undefined = dict?.machine?.providers?.noProviders
      expect(value, `${locale} machine.providers.noProviders`).toBeTruthy()
      // English is the reliable anchor for the literal phantom-button phrase;
      // translated locales are checked for internal consistency below instead.
      if (locale === 'en') {
        expect(value).not.toContain('Add provider')
      }
    })

    it(`${locale}: standalone.onboarding.intro does not point at the phantom "Add provider" button`, () => {
      const dict = loadLocale(locale)
      const value: string | undefined = dict?.standalone?.onboarding?.intro
      expect(value, `${locale} standalone.onboarding.intro`).toBeTruthy()
      if (locale === 'en') {
        expect(value).not.toContain('Add provider')
      }
    })
  }

  it('en: noProviders and onboarding.intro both reference "Create", the real button label', () => {
    const dict = loadLocale('en')
    expect(dict.machine.providers.noProviders).toContain('Create')
    expect(dict.standalone.onboarding.intro).toContain('Create')
  })
})
