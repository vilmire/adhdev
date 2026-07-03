/**
 * Card — shared card-container primitive.
 *
 * Extracts the repeated `rounded-* border border-border-subtle bg-bg-secondary p-*`
 * surface pattern found across the dashboards into a single primitive.
 *
 * Design goals (survey finding C5):
 * - Impose only the common-denominator styling (radius + subtle border + secondary
 *   surface). Everything else is overridable so replacing an inline card never
 *   causes a visual regression.
 * - `radius` / `padding` are enumerated presets that map to the exact utility
 *   classes already used at call sites, so migrations stay pixel-identical.
 * - `className` is merged last via `cn()` (tailwind-merge), letting each call site
 *   append or override any class (margins, text tokens, bg opacity, hover, etc.).
 */
import { forwardRef } from 'react'
import { cn } from '../lib/utils'

export type CardRadius = 'lg' | 'xl' | '2xl'

/**
 * Padding presets. `none` lets the caller (or child content) own padding.
 * The named presets map to the concrete utility combos already in use so that
 * migrating an inline card produces byte-identical markup.
 */
export type CardPadding =
    | 'none'
    | 'sm' // p-3
    | 'md' // px-4 py-3.5
    | 'lg' // px-5 py-4

const RADIUS_CLASS: Record<CardRadius, string> = {
    lg: 'rounded-lg',
    xl: 'rounded-xl',
    '2xl': 'rounded-2xl',
}

const PADDING_CLASS: Record<CardPadding, string> = {
    none: '',
    sm: 'p-3',
    md: 'px-4 py-3.5',
    lg: 'px-5 py-4',
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
    /** Corner radius preset. Default `xl` — the dominant card radius. */
    radius?: CardRadius
    /** Padding preset. Default `md` (`px-4 py-3.5`). Use `none` for custom padding via className. */
    padding?: CardPadding
}

/**
 * Card container. Renders the common surface classes and merges `className` last
 * so any of them can be overridden.
 *
 *   <Card>…</Card>                                  // rounded-xl + subtle border + bg-secondary + px-4 py-3.5
 *   <Card radius="2xl" padding="lg">…</Card>
 *   <Card padding="none" className="p-6 mb-4">…</Card>
 *   <Card className="bg-bg-secondary/60">…</Card>    // tailwind-merge overrides the base bg
 */
const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
    { radius = 'xl', padding = 'md', className, ...rest },
    ref,
) {
    return (
        <div
            ref={ref}
            className={cn(
                'border border-border-subtle bg-bg-secondary',
                RADIUS_CLASS[radius],
                PADDING_CLASS[padding],
                className,
            )}
            {...rest}
        />
    )
})

export default Card
