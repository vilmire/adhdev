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
    currentStatus,
}: ChatControlsSectionProps) {
    const { isVisible } = useControlsBarVisibility()
    const visibleBarControls = getVisibleBarControls(controls, {
        hostIdeType,
        providerType,
        currentStatus,
    })

    if (!isActive || isCliTerminal || visibleBarControls.length === 0 || !isVisible) {
        return null
    }

    return (
        <div className="shrink-0 bg-[var(--surface-primary)] border-t border-border-subtle">
            <ControlsBar
                routeId={routeId}
                sessionId={sessionId}
                hostIdeType={hostIdeType}
                providerType={providerType}
                displayLabel={displayLabel}
                controls={visibleBarControls}
                controlValues={controlValues}
                currentStatus={currentStatus}
            />
        </div>
    )
}
