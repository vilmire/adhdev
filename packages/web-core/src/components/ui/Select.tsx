/**
 * Select — canonical native `<select>` matching the FormField `Input` style.
 *
 * Uses the exact surface classes as `Input` (rounded-xl + subtle border +
 * bg-secondary + focus:border-accent) so form controls look uniform. No new
 * styling is invented in this wave.
 *
 *   <Select value={v} onChange={onChange}>
 *     <option value="a">A</option>
 *   </Select>
 *
 *   // or via the options convenience prop:
 *   <Select value={v} onChange={onChange} options={[{ value: 'a', label: 'A' }]} />
 *
 * Pairs with <FormField> for label/hint, exactly like <Input>.
 */
import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

export interface SelectOption {
    value: string
    label: string
    disabled?: boolean
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
    /** Optional convenience list of options. Ignored if `children` are provided. */
    options?: SelectOption[]
}

/**
 * Native select styled to match `Input`. `className` merges last so callers can
 * override width/padding. Renders `options` when given and no children.
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
    { options, children, className, ...rest },
    ref,
) {
    return (
        <select
            ref={ref}
            className={cn(
                'w-full px-4 py-3 rounded-xl border border-border-subtle bg-bg-secondary',
                'text-text-primary text-sm outline-none cursor-pointer',
                'focus:border-accent transition-colors',
                className,
            )}
            {...rest}
        >
            {children ??
                options?.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.disabled}>
                        {option.label}
                    </option>
                ))}
        </select>
    )
})

export default Select
