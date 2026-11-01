/**
 * ThemeToggle — Compact dark/light/system toggle for sidebar use.
 * Cycles: dark → light → system → dark
 * Uses useTheme hook internally. Import from web-core.
 */
import { useTranslation } from 'react-i18next'
import { useTheme } from '../hooks/useTheme'
import { IconSun, IconMoon, IconSystem } from './Icons'

interface ThemeToggleProps {
    collapsed?: boolean
}

const LABEL_KEYS = {
    dark: 'landing.theme.dark',
    light: 'landing.theme.light',
    system: 'landing.theme.system',
} as const

export default function ThemeToggle({ collapsed }: ThemeToggleProps) {
    const { preference, cycleTheme } = useTheme()
    const { t } = useTranslation()
    const label = t(LABEL_KEYS[preference])

    const icon = preference === 'dark'
        ? <IconMoon size={16} />
        : preference === 'light'
            ? <IconSun size={16} />
            : <IconSystem size={16} />

    return (
        <div
            className={`nav-item cursor-pointer ${collapsed ? 'justify-center py-2.5 px-0' : ''}`}
            onClick={cycleTheme}
            title={label}
        >
            <span className="nav-icon">{icon}</span>
            {!collapsed && <span className="text-xs">{label}</span>}
        </div>
    )
}
