import { IconEye, IconEyeOff } from '../Icons'
import { useControlsBarVisibility } from '../../hooks/useControlsBarVisibility'
import ControlsBar, { type ControlsBarProps, getVisibleBarControls } from './ControlsBar'

interface ChatControlsSectionProps extends ControlsBarProps {
    isActive?: boolean
    isCliTerminal?: boolean
}

export default function ChatControlsSection({
    isActive = true,
    isCliTerminal = false,
    routeId,
    sessionId,
    hostIdeType,
    providerType,
    displayLabel,
    controls,
    controlValues,
}: ChatControlsSectionProps) {
    const { isVisible, toggleVisibility } = useControlsBarVisibility()
    const visibleBarControls = getVisibleBarControls(controls, {
        hostIdeType,
        providerType,
    })

    if (!isActive || isCliTerminal || visibleBarControls.length === 0) {
        return null
    }

    return (
        <div className="shrink-0 bg-[var(--surface-primary)]">
            <div className={`px-3 py-1.5 flex justify-end ${!isVisible ? 'border-t border-border-subtle' : ''}`}>
                <button
                    type="button"
                    onClick={toggleVisibility}
                    aria-pressed={isVisible}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors border border-border-subtle bg-[var(--surface-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--surface-tertiary-hover)] hover:text-[var(--text-primary)]"
                    title={isVisible ? 'Hide controls bar' : 'Show controls bar'}
                >
                    {isVisible ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                    <span>{isVisible ? 'Hide controls' : 'Show controls'}</span>
                </button>
            </div>

            {isVisible && (
                <ControlsBar
                    routeId={routeId}
                    sessionId={sessionId}
                    hostIdeType={hostIdeType}
                    providerType={providerType}
                    displayLabel={displayLabel}
                    controls={visibleBarControls}
                    controlValues={controlValues}
                />
            )}
        </div>
    )
}
