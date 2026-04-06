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
        <div className={`flex justify-between items-center ${disabled ? 'opacity-60' : ''}`}>
            <div className="pr-4">
                <div className="font-medium text-sm">{label}</div>
                <div className="text-[11px] text-text-muted mt-0.5">{description}</div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
                {extra}
                <button
                    type="button"
                    role="switch"
                    aria-checked={checked}
                    aria-disabled={disabled}
                    disabled={disabled}
                    onClick={() => onChange(!checked)}
                    className={`relative inline-flex items-center ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                >
                    <div 
                        className="w-[40px] h-[22px] rounded-full transition-colors duration-200 ease-in-out"
                        style={{ backgroundColor: checked ? 'var(--accent-primary)' : 'color-mix(in srgb, var(--surface-primary) 60%, var(--border-default))' }}
                    />
                    <div 
                        className={`absolute left-[1.5px] top-[1.5px] w-[19px] h-[19px] bg-white rounded-full transition-transform duration-200 ease-in-out shadow-[0_1px_2px_rgba(0,0,0,0.15)] ${
                            checked ? 'translate-x-[18px]' : 'translate-x-0'
                        }`}
                    />
                </button>
            </div>
        </div>
    )
}
