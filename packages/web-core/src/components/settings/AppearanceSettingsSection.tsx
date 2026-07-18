import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { GeneralThemeSection } from './GeneralThemeSection'
import { ChatThemeSection } from './ChatThemeSection'
import { MobileDashboardModeSection } from './MobileDashboardModeSection'

export interface AppearanceSettingsSectionProps {
    /** Description shown under the "Theme" heading. */
    themeDescription?: string
    /** Description shown under the "Mobile" heading. */
    mobileDescription?: string
    /**
     * Optional extra block (e.g. standalone-only font overrides) rendered
     * between the Theme and Mobile blocks. Each host injects its own wiring.
     */
    fontsSlot?: ReactNode
}

const DEFAULT_THEME_DESCRIPTION =
    'Choose a preset or create a fully custom theme. Custom themes control the entire app — backgrounds, text, borders, and chat bubbles.'
const DEFAULT_MOBILE_DESCRIPTION =
    'Choose whether the dashboard opens like a chat app on phones or keeps the full workspace layout.'

/**
 * Shared Appearance settings body used by both the cloud and standalone
 * dashboards. Renders the Mode / Theme / (optional Fonts) / Mobile blocks.
 *
 * The surrounding <Section> wrapper (title, top-level description) stays with
 * each host so they can keep their own copy and framing.
 */
export function AppearanceSettingsSection({
    themeDescription = DEFAULT_THEME_DESCRIPTION,
    mobileDescription = DEFAULT_MOBILE_DESCRIPTION,
    fontsSlot,
}: AppearanceSettingsSectionProps) {
    const { t } = useTranslation('common')
    return (
        <div className="flex flex-col gap-5">
            {/* Mode */}
            <div>
                <div className="text-xs text-text-muted mb-2 font-medium">{t('settings.appearance.modeLabel')}</div>
                <GeneralThemeSection />
            </div>

            {/* Theme */}
            <div className="border-t border-border-subtle pt-4">
                <div className="text-xs text-text-muted mb-1 font-medium">{t('settings.appearance.themeLabel')}</div>
                <p className="text-[11px] text-text-muted mb-3">{themeDescription}</p>
                <ChatThemeSection />
            </div>

            {/* Fonts (optional, standalone-only) */}
            {fontsSlot}

            {/* Mobile */}
            <div className="border-t border-border-subtle pt-4">
                <div className="text-xs text-text-muted mb-1 font-medium">{t('settings.appearance.mobileLabel')}</div>
                <p className="text-[11px] text-text-muted mb-3">{mobileDescription}</p>
                <MobileDashboardModeSection />
            </div>
        </div>
    )
}
