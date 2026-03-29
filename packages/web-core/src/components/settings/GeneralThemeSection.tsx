import { useTheme, ThemePreference } from '../../hooks/useTheme'

const THEME_OPTIONS: { id: ThemePreference; label: string; icon: string }[] = [
    { id: 'dark', label: 'Dark', icon: '🌙' },
    { id: 'light', label: 'Light', icon: '☀️' },
    { id: 'system', label: 'System', icon: '💻' }
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
                            ? 'bg-accent border-accent text-white' 
                            : 'bg-bg-glass border-border-subtle hover:bg-bg-secondary text-text-muted hover:text-text-primary'
                    }`}
                >
                    <span>{opt.icon}</span>
                    {opt.label}
                </button>
            ))}
        </div>
    )
}
