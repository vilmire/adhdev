/**
 * The single picker for a launch model or thinking level, shared by the
 * new-session dialog, the mesh slot editor and the machine launch-defaults
 * card so they read and behave the same:
 *
 * - first entry "(provider default)", then the CLI's advertised options;
 * - a saved value missing from that list is kept as an extra entry, so the
 *   field always shows what will actually be sent;
 * - `allowCustom` adds "Custom…", which swaps in a text box with a way back;
 * - a CLI that advertises nothing gets a plain text box.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const CUSTOM_VALUE = '__custom__'

/** Advertised options plus a saved value the list does not contain. */
export function withSavedOption(options: readonly string[], value: string): string[] {
    const saved = value.trim()
    if (!saved || options.includes(saved)) return [...options]
    return [...options, saved]
}

interface LaunchOptionFieldProps {
    value: string
    options: readonly string[]
    onChange: (value: string) => void
    allowCustom?: boolean
    disabled?: boolean
    className?: string
    /** Extra attributes (data-*, aria-*) for the select / text box. */
    fieldAttrs?: Record<string, string>
    /** Shorter first-entry label for narrow menus (default "(provider default)"). */
    defaultLabel?: string
}

export default function LaunchOptionField({
    value, options, onChange, allowCustom = false, disabled, className, fieldAttrs, defaultLabel,
}: LaunchOptionFieldProps) {
    const { t } = useTranslation('common')
    const [typing, setTyping] = useState(false)
    const optionsKey = options.join('\n')
    // A different CLI brings a different list — start from the list again.
    useEffect(() => { setTyping(false) }, [optionsKey])

    if (options.length === 0 || typing) {
        return (
            <>
                <input
                    type="text"
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={typing ? t('newSession.typeModelName') : t('newSession.providerDefault')}
                    className={className}
                    disabled={disabled}
                    autoFocus={typing}
                    {...fieldAttrs}
                />
                {typing && (
                    <button
                        type="button"
                        className="self-start text-2xs text-accent-primary bg-transparent border-none cursor-pointer p-0"
                        onClick={() => { setTyping(false); onChange('') }}
                        disabled={disabled}
                    >
                        {t('newSession.backToModelList')}
                    </button>
                )}
            </>
        )
    }

    return (
        <select
            value={value.trim()}
            onChange={e => {
                if (e.target.value === CUSTOM_VALUE) { setTyping(true); onChange('') }
                else onChange(e.target.value)
            }}
            className={className}
            disabled={disabled}
            {...fieldAttrs}
        >
            <option value="">{defaultLabel ?? t('newSession.providerDefault')}</option>
            {withSavedOption(options, value).map(o => <option key={o} value={o}>{o}</option>)}
            {allowCustom && <option value={CUSTOM_VALUE}>{t('newSession.custom')}</option>}
        </select>
    )
}
