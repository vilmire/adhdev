/**
 * ToggleRow — A settings row with a label, an optional ⓘ explanation, and the
 * shared Switch. Shared between cloud and standalone settings pages.
 */
import { useId } from 'react'
import { InfoTip } from '../ui/InfoTip'
import { Switch } from '../ui/Switch'

export interface ToggleRowProps {
    label: React.ReactNode
    /** Optional explanation — shown as an ⓘ tip beside the label by default. */
    description?: React.ReactNode
    /** Render the description as visible text under the label (warnings only). */
    descriptionInline?: boolean
    checked: boolean
    disabled?: boolean
    onChange: (value: boolean) => void
    extra?: React.ReactNode
}

export function ToggleRow({ label, description, descriptionInline = false, checked, disabled, onChange, extra }: ToggleRowProps) {
    const labelId = useId()
    return (
        <div className={`flex justify-between items-center ${disabled ? 'opacity-60' : ''}`}>
            <div className="pr-4 min-w-0">
                <div className="font-medium text-sm flex items-center gap-1">
                    <span id={labelId}>{label}</span>
                    {description && !descriptionInline && <InfoTip content={description} />}
                </div>
                {description && descriptionInline && <div className="text-2xs text-text-muted mt-0.5">{description}</div>}
            </div>
            <div className="flex items-center gap-3 shrink-0">
                {extra}
                <Switch checked={checked} disabled={disabled} onChange={onChange} aria-labelledby={labelId} />
            </div>
        </div>
    )
}
