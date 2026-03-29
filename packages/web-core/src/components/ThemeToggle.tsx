/**
 * ThemeToggle — Compact dark/light/system toggle for sidebar use.
 * Cycles: dark → light → system → dark
 * Uses useTheme hook internally. Import from web-core.
 */
import { useTheme } from '../hooks/useTheme'
import { IconSun, IconMoon, IconSystem } from './Icons'

interface ThemeToggleProps {
    collapsed?: boolean
}

const LABELS = {
    dark: 'Dark',
    light: 'Light',
    system: 'System',
} as const

export default function ThemeToggle({ collapsed }: ThemeToggleProps) {
    const { preference, cycleTheme } = useTheme()

    const icon = preference === 'dark'
        ? <IconMoon size={16} />
        : preference === 'light'
            ? <IconSun size={16} />
            : <IconSystem size={16} />

    return (
        <div
            className={`nav-item cursor-pointer ${collapsed ? 'justify-center py-2.5 px-0' : ''}`}
            onClick={cycleTheme}
            title={`Theme: ${LABELS[preference]} (click to cycle)`}
        >
            <span className="nav-icon">{icon}</span>
            {!collapsed && <span className="text-xs">{LABELS[preference]}</span>}
        </div>
    )
}
