import { IconChat, IconTerminal } from '../Icons'
import type { CliConversationViewMode } from './types'

interface CliViewModeToggleProps {
    mode: CliConversationViewMode
    onChange: (mode: CliConversationViewMode) => void
    compact?: boolean
}

export default function CliViewModeToggle({
    mode,
    onChange,
    compact = false,
}: CliViewModeToggleProps) {
    const size = compact ? 14 : 15;

    return (
        <button
            type="button"
            onClick={() => onChange(mode === 'chat' ? 'terminal' : 'chat')}
            className="btn btn-sm btn-secondary"
            title={mode === 'chat' ? 'Switch to Terminal view' : 'Switch to Chat view'}
        >
            {mode === 'chat' ? <IconTerminal size={size} /> : <IconChat size={size} />}
        </button>
    )
}
