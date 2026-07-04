/**
 * Button — React wrapper over the canonical `.btn` CSS classes (index.css).
 *
 * This wave introduces NO new button styling. Each variant maps 1:1 to an
 * existing `.btn-*` class so rendered output is identical to the ~392 raw
 * `className="btn btn-primary"` call sites already in the codebase. The value
 * is a typed, discoverable primitive that later waves migrate those sites onto.
 *
 *   <Button variant="primary">Save</Button>       // .btn .btn-primary
 *   <Button variant="danger" size="sm">Delete</Button>
 *   <Button variant="ghost" className="w-8 p-0"><IconX/></Button>
 */
import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

export type ButtonVariant = 'primary' | 'secondary' | 'warning' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

/** Variant → canonical `.btn-*` class (defined in index.css, unchanged). */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    warning: 'btn-warning',
    danger: 'btn-danger',
    ghost: 'btn-ghost',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    /** Visual variant. Default `secondary`. */
    variant?: ButtonVariant
    /** `sm` adds `.btn-sm`; `md` (default) uses the base `.btn` padding. */
    size?: ButtonSize
}

/**
 * Renders `<button class="btn btn-<variant> [btn-sm]">`. `className` is merged
 * last via `cn()` so any call site can append or override (width, padding, etc.).
 * Defaults `type` to `"button"` to avoid accidental form submits.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = 'secondary', size = 'md', type, className, ...rest },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type ?? 'button'}
            className={cn('btn', VARIANT_CLASS[variant], size === 'sm' && 'btn-sm', className)}
            {...rest}
        />
    )
})

export default Button
