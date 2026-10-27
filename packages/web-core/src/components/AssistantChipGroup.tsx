import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSingleFlightAction } from '../hooks/useSingleFlightAction'
import LoadingSpinner from './ui/LoadingSpinner'
import { auditTouchTargets } from '../utils/touch-target'

export interface AssistantChip {
    id: string
    label: string
}

interface AssistantChipGroupProps {
    chips: AssistantChip[]
    /**
     * Sends the tapped chip's label. A returned promise latches the group until
     * it settles (one send at a time); the signal aborts on Cancel/Escape.
     */
    onChoose: (label: string, signal: AbortSignal) => unknown
    className?: string
    chipClassName?: string
    testId?: string
}

/**
 * One-tap assistant chips — the starter requests of a new assistant chat and
 * the answer buttons under its latest question. Shared so both behave the
 * same: one send in flight (spinner on the left of the tapped chip, the rest
 * disabled), a Cancel while it runs, arrow-key navigation, and no contact with
 * the composer: a chip sends its own label and leaves the typed draft alone.
 *
 * Cancel releases the chips locally; a send already handed to the daemon is
 * not recalled (its queued bubble keeps its own cancel).
 */
export default function AssistantChipGroup({ chips, onChoose, className = '', chipClassName = '', testId }: AssistantChipGroupProps) {
    const { t } = useTranslation('common')
    const flight = useSingleFlightAction()
    const groupRef = useRef<HTMLDivElement>(null)
    useEffect(() => { auditTouchTargets(groupRef.current, '[data-chip-id]', 'assistant chip') }, [chips.length])

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            if (!flight.pendingKey) return
            event.preventDefault()
            event.stopPropagation()
            flight.cancel()
            return
        }
        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
        const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        if (!forward && !backward && event.key !== 'Home' && event.key !== 'End') return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-chip-id]'))
        if (buttons.length === 0) return
        event.preventDefault()
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home'
            ? buttons[0]
            : event.key === 'End'
                ? buttons[buttons.length - 1]
                : buttons[(index + (forward ? 1 : -1) + buttons.length) % buttons.length]
        next?.focus({ preventScroll: true })
    }

    return (
        <div ref={groupRef} className={`assistant-chip-group ${className}`.trim()} data-testid={testId} role="group" onKeyDown={onKeyDown}>
            {chips.map(chip => {
                const isPending = flight.pendingKey === chip.id
                const isBlocked = !!flight.pendingKey && !isPending
                return (
                    <button
                        key={chip.id}
                        type="button"
                        data-chip-id={chip.id}
                        className={`assistant-chip ${chipClassName}`.trim()}
                        aria-busy={isPending || undefined}
                        aria-disabled={isBlocked || undefined}
                        onClick={() => { flight.run(chip.id, signal => onChoose(chip.label, signal)) }}
                    >
                        {isPending && (
                            <span data-testid="assistant-chip-spinner" className="assistant-chip-spinner">
                                <LoadingSpinner size={12} thickness={2} label={t('chat.sending')} />
                            </span>
                        )}
                        {chip.label}
                    </button>
                )
            })}
            {flight.pendingKey && (
                <button
                    type="button"
                    data-testid="assistant-chip-cancel"
                    className="btn btn-quiet assistant-chip-cancel"
                    onClick={flight.cancel}
                >
                    {t('common.cancel')}
                </button>
            )}
        </div>
    )
}
