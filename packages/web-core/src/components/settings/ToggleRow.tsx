/**
 * ToggleRow — A settings row with label, description, and a checkbox toggle.
 * Shared between cloud and standalone settings pages.
 */

export interface ToggleRowProps {
    label: React.ReactNode
    description: string
    checked: boolean
    disabled?: boolean
    onChange: (value: boolean) => void
    extra?: React.ReactNode
}

export function ToggleRow({ label, description, checked, disabled, onChange, extra }: ToggleRowProps) {
    return (
        <label className="flex justify-between items-center cursor-pointer">
            <div>
                <div className="font-medium text-sm">{label}</div>
                <div className="text-[11px] text-text-muted">{description}</div>
            </div>
            <div className="flex items-center gap-2">
                {extra}
                <input
                    type="checkbox" checked={checked} disabled={disabled}
                    onChange={(e) => onChange(e.target.checked)}
                    className="w-5 h-5 accent-accent"
                />
            </div>
        </label>
    )
}
