/**
 * LanguageSelector — Compact language switcher for sidebar/header use.
 *
 * Mirrors ThemeToggle's `nav-item` look. Uses useLanguage() to read/switch the
 * active language; setLanguage drives i18next.changeLanguage, updates <html lang>,
 * and persists to localStorage('lang'). Labels are native-language (English /
 * 한국어 / 日本語 / 中文(简体) / Español).
 *
 * A transparent native <select> overlays the row so it stays keyboard- and
 * screen-reader-accessible while matching the sidebar visual language.
 */
import { useTranslation } from 'react-i18next'

import { useLanguage } from '../i18n/useLanguage'
import { LANGUAGE_OPTIONS, type SupportedLanguage } from '../i18n/languages'
import { IconGlobe } from './Icons'

interface LanguageSelectorProps {
    collapsed?: boolean
}

export default function LanguageSelector({ collapsed }: LanguageSelectorProps) {
    const { language, setLanguage } = useLanguage()
    const { t } = useTranslation('common')

    const current = LANGUAGE_OPTIONS.find((option) => option.code === language) ?? LANGUAGE_OPTIONS[0]
    const selectLabel = t('language.select', { defaultValue: 'Select language' })

    return (
        <div
            className={`nav-item relative cursor-pointer ${collapsed ? 'justify-center py-2.5 px-0' : ''}`}
            title={`${t('language.label', { defaultValue: 'Language' })}: ${current.label}`}
        >
            <span className="nav-icon"><IconGlobe size={16} /></span>
            {!collapsed && <span className="text-xs">{current.label}</span>}
            <select
                aria-label={selectLabel}
                value={language}
                onChange={(event) => setLanguage(event.target.value as SupportedLanguage)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            >
                {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
