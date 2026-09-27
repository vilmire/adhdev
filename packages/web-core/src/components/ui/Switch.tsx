/**
 * Switch — the one on/off control for every settings surface (cloud and
 * standalone). Replaces the hand-rolled toggles that drifted in size and
 * colour (#8b5cf6 purple vs the accent token) across pages.
 *
 * Accessible by construction: role="switch" + aria-checked, Space/Enter
 * toggle, disabled/busy states are announced. Colours are theme tokens only.
 *
 * `as="span"` renders a focusable span instead of a <button> for the rare
 * placement inside another button (e.g. an expandable row header), where a
 * nested <button> would be invalid HTML. Click events never bubble to that
 * parent either way.
 */
import type { KeyboardEvent, MouseEvent } from 'react'
import { cn } from '../../lib/utils'

export type SwitchSize = 'sm' | 'md'

export interface SwitchProps {
    checked: boolean
    onChange: (next: boolean) => void
    disabled?: boolean
    /** Shows a wait cursor and ignores input (e.g. while a save is in flight). */
    busy?: boolean
    size?: SwitchSize
    /** Accessible name when there is no visible <label> pointing at `id`. */
    'aria-label'?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
    id?: string
    title?: string
    className?: string
    as?: 'button' | 'span'
}

const TRACK: Record<SwitchSize, string> = {
    sm: 'w-[34px] h-[19px]',
    md: 'w-[40px] h-[22px]',
}
const THUMB: Record<SwitchSize, { base: string; on: string }> = {
    sm: { base: 'w-[16px] h-[16px]', on: 'translate-x-[15px]' },
    md: { base: 'w-[19px] h-[19px]', on: 'translate-x-[18px]' },
}

export function Switch({
    checked,
    onChange,
    disabled = false,
    busy = false,
    size = 'md',
    id,
    title,
    className,
    as = 'button',
    ...aria
}: SwitchProps) {
    const inert = disabled || busy
    const toggle = (event: MouseEvent | KeyboardEvent) => {
        event.stopPropagation()
        if (inert) return
        onChange(!checked)
    }
    const common = {
        id,
        title,
        role: 'switch' as const,
        'aria-checked': checked,
        'aria-disabled': disabled || undefined,
        'aria-busy': busy || undefined,
        'aria-label': aria['aria-label'],
        'aria-labelledby': aria['aria-labelledby'],
        'aria-describedby': aria['aria-describedby'],
        'data-state': checked ? 'on' : 'off',
        className: cn(
            'relative inline-flex shrink-0 items-center rounded-full border-none bg-transparent p-0 outline-none',
            'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-primary',
            disabled ? 'cursor-not-allowed opacity-50' : busy ? 'cursor-wait opacity-60' : 'cursor-pointer',
            className,
        ),
    }
    const visual = (
        <>
            <span
                aria-hidden
                className={cn('inline-block rounded-full transition-colors duration-200 ease-in-out', TRACK[size])}
                style={{ backgroundColor: checked ? 'var(--accent-primary)' : 'color-mix(in srgb, var(--surface-primary) 60%, var(--border-default))' }}
            />
            <span
                aria-hidden
                className={cn(
                    'absolute left-[1.5px] top-[1.5px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.15)] transition-transform duration-200 ease-in-out',
                    THUMB[size].base,
                    checked ? THUMB[size].on : 'translate-x-0',
                )}
            />
        </>
    )
    if (as === 'span') {
        return (
            <span
                {...common}
                tabIndex={disabled ? -1 : 0}
                onClick={toggle}
                onKeyDown={event => {
                    if (event.key === ' ' || event.key === 'Enter') {
                        event.preventDefault()
                        toggle(event)
                    }
                }}
            >
                {visual}
            </span>
        )
    }
    return (
        <button type="button" {...common} disabled={disabled} onClick={toggle}>
            {visual}
        </button>
    )
}

export default Switch
