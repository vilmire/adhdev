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
import { DEFAULT_LANGUAGE, initI18n } from '../src/i18n/config'

// initI18n() reads localStorage('lang') first; provide a minimal in-memory stub
// that returns `en` so the boot is deterministic and browser-free.
if (typeof (globalThis as { localStorage?: Storage }).localStorage === 'undefined') {
    ;(globalThis as { localStorage?: Partial<Storage> }).localStorage = {
        getItem: (key: string) => (key === 'lang' ? DEFAULT_LANGUAGE : null),
        setItem: () => {},
        removeItem: () => {},
    }
}

initI18n()
