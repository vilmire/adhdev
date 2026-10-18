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

    return (
        <button
            type="button"
            onClick={() => onChange(mode === 'chat' ? 'terminal' : 'chat')}
            className="btn btn-icon"
            title={mode === 'chat' ? t('cliView.switchToTerminal') : t('cliView.switchToChat')}
        >
            {mode === 'chat' ? <IconTerminal size={size} /> : <IconChat size={size} />}
        </button>
    )
}
