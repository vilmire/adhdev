import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { GeneralThemeSection } from './GeneralThemeSection'
import { ChatThemeSection } from './ChatThemeSection'
import { ChatActivitySection } from './ChatActivitySection'
import { MobileDashboardModeSection } from './MobileDashboardModeSection'

export interface AppearanceSettingsSectionProps {
    /**
     * Optional extra block (e.g. standalone-only font overrides) rendered
     * between the Theme and Mobile blocks. Each host injects its own wiring.
     */
    fontsSlot?: ReactNode
}


/**
 * Shared Appearance settings body used by both the cloud and standalone
 * dashboards. Renders the Mode / Theme / (optional Fonts) / Mobile blocks.
 *
 * The surrounding <Section> wrapper (title, top-level description) stays with
 * each host so they can keep their own copy and framing.
 */
export function AppearanceSettingsSection({
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
                <div className="text-xs text-text-muted mb-2 font-medium">{t('settings.appearance.themeLabel')}</div>
                <ChatThemeSection />
            </div>

            {/* Chat transcript */}
            <div className="border-t border-border-subtle pt-4">
                <div className="text-xs text-text-muted mb-1 font-medium">{t('settings.appearance.chatLabel')}</div>
                <ChatActivitySection />
            </div>

            {/* Fonts (optional, standalone-only) */}
            {fontsSlot}

            {/* Mobile */}
            <div className="border-t border-border-subtle pt-4">
                <div className="text-xs text-text-muted mb-2 font-medium">{t('settings.appearance.mobileLabel')}</div>
                <MobileDashboardModeSection />
            </div>
        </div>
    )
}
