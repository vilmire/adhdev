import { IconChat, IconTerminal } from '../Icons'
import { useTranslation } from 'react-i18next'
import type { CliConversationViewMode } from './types'

interface CliViewModeToggleProps {
    mode: CliConversationViewMode
    onChange: (mode: CliConversationViewMode) => void
    /** Kept for callers; every toolbar now uses the same icon size. */
    compact?: boolean
}

export default function CliViewModeToggle({
    mode,
    onChange,
}: CliViewModeToggleProps) {
    const { t } = useTranslation('common')
    const size = 16;
    // An action button ("Switch to …"), not a pressed-state toggle: the label
    // names what a press does, so it must be the accessible name too.
    const label = mode === 'chat' ? t('cliView.switchToTerminal') : t('cliView.switchToChat')

    return (
        <button
            type="button"
            onClick={() => onChange(mode === 'chat' ? 'terminal' : 'chat')}
            className="btn btn-icon cli-view-mode-toggle"
            data-mode={mode}
            title={label}
            aria-label={label}
        >
            {mode === 'chat' ? <IconTerminal size={size} /> : <IconChat size={size} />}
        </button>
    )
}
