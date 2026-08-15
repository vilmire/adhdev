import { useTheme, ThemePreference } from '../../hooks/useTheme'
import { IconMoon, IconSun, IconSystem } from '../Icons'

const THEME_OPTIONS: { id: ThemePreference; label: string; icon: typeof IconMoon }[] = [
    { id: 'dark', label: 'Dark', icon: IconMoon },
    { id: 'light', label: 'Light', icon: IconSun },
    { id: 'system', label: 'System', icon: IconSystem }
]

export function GeneralThemeSection() {
    const { preference, setPreference } = useTheme()

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
                    {opt.label}
                </button>
            ))}
        </div>
    )
}
