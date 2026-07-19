/**
 * Vitest global setup for web-core.
 *
 * web-core components call react-i18next's useTranslation(). In production the
 * i18next instance is booted by initI18n() during App init; the test harness
 * does not run that boot, so without this setup components render raw i18n keys
 * (and emit "react-i18next:: NO_I18NEXT_INSTANCE" warnings), breaking assertions
 * that expect the resolved English copy.
 *
 * We boot the SAME production instance via initI18n() (not a fresh i18next
 * instance) so react-i18next sees one instance — avoiding the monorepo
 * multi-instance warning — with the exact production config (all catalogs,
 * supportedLngs, fallback). We only stub localStorage so resolveInitialLanguage()
 * pins the language to `en` (the source-of-truth catalog assertions expect)
 * without depending on a real browser environment. `en` is also the fallback,
 * so any locale would resolve the same values, but pinning keeps output stable.
 */
import { initI18n } from '../src/i18n/config'

// initI18n() → resolveInitialLanguage() reads localStorage('lang') first, then
// falls back to navigator.language. Under vitest's node environment `navigator`
// is defined (e.g. `ko-KR` on a Korean host), so without a pinned stored language
// the harness would boot a non-`en` catalog and every guard test that asserts the
// English source-of-truth copy would fail nondeterministically per host locale.
//
// We must pin the language to `en` unconditionally. The previous guard only
// installed the stub when `localStorage` was `undefined`, but vitest v4 already
// exposes a `localStorage` object whose `getItem('lang')` returns `undefined`, so
// the guard never fired and `navigator.language` leaked through. Install an
// in-memory stub that always returns `en` for the language key regardless of any
// pre-existing `localStorage`, so the boot is deterministic and browser/host-free.
//
// The stub uses the literal `'lang'`/`'en'` values on purpose: importing the
// LANG_STORAGE_KEY / DEFAULT_LANGUAGE constants and referencing them inside the
// getItem closure hits a vite SSR live-binding ordering issue (the binding reads
// back `undefined` when the closure runs during setup), which silently defeats
// the pin. These literals match src/i18n/languages.ts (DEFAULT_LANGUAGE='en') and
// src/i18n/config.ts (LANG_STORAGE_KEY='lang').
//
// This pins ONLY the test-harness locale to the `en` source of truth; it does not
// touch the production default locale.
;(globalThis as { localStorage?: Partial<Storage> }).localStorage = {
    getItem: (key: string) => (key === 'lang' ? 'en' : null),
    setItem: () => {},
    removeItem: () => {},
}

initI18n()
