import { useTranslation } from 'react-i18next'
import { useTheme, ThemePreference } from '../../hooks/useTheme'
import { IconMoon, IconSun, IconSystem } from '../Icons'

/** `labelKey` is an i18n key in the common namespace. */
const THEME_OPTIONS: { id: ThemePreference; labelKey: string; icon: typeof IconMoon }[] = [
    { id: 'dark', labelKey: 'settings.appearance.modeDark', icon: IconMoon },
    { id: 'light', labelKey: 'settings.appearance.modeLight', icon: IconSun },
    { id: 'system', labelKey: 'settings.appearance.modeSystem', icon: IconSystem }
]

export function GeneralThemeSection() {
    const { preference, setPreference } = useTheme()
    const { t } = useTranslation('common')

    return (
        <div className="flex gap-2">
            {THEME_OPTIONS.map(opt => (
                <button
                    key={opt.id}
                    onClick={() => setPreference(opt.id)}
                    className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors flex items-center gap-1.5 ${
                        preference === opt.id 
                            ? 'bg-accent border-accent' 
                            : 'bg-bg-glass border-border-subtle hover:bg-bg-secondary text-text-muted hover:text-text-primary'
                    }`}
                    style={preference === opt.id ? { color: 'var(--accent-on-primary)' } : undefined}
                >
                    <opt.icon size={14} />
                    {t(opt.labelKey)}
                </button>
            ))}
        </div>
    )
}
