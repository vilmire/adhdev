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
    const buttonClass = compact ? 'h-7 w-7' : 'h-8 w-8'

    return (
        <div
            className="inline-flex items-center rounded-lg border border-border-subtle bg-bg-secondary/80 p-0.5 shadow-sm"
            role="tablist"
            aria-label="CLI view mode"
        >
            <button
                type="button"
                role="tab"
                aria-selected={mode === 'chat'}
                onClick={() => onChange('chat')}
                className={`${buttonClass} inline-flex items-center justify-center rounded-md transition-colors ${
                    mode === 'chat'
                        ? 'bg-violet-500/15 text-violet-300'
                        : 'text-text-muted hover:text-text-primary hover:bg-bg-glass'
                }`}
                title="Parsed chat view"
            >
                <IconChat size={15} />
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={mode === 'terminal'}
                onClick={() => onChange('terminal')}
                className={`${buttonClass} inline-flex items-center justify-center rounded-md transition-colors ${
                    mode === 'terminal'
                        ? 'bg-sky-500/15 text-sky-300'
                        : 'text-text-muted hover:text-text-primary hover:bg-bg-glass'
                }`}
                title="Terminal view"
            >
                <IconTerminal size={15} />
            </button>
        </div>
    )
}
