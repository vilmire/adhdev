import React from 'react'
import { cn } from '../../lib/utils'
import { InfoTip } from './InfoTip'

/* ── FormField ─────────────────────────────────────── */
interface FormFieldProps {
    label: string
    /** Explanation shown as an ⓘ tip beside the label (details on demand). */
    hint?: React.ReactNode
    /** Render the hint as visible text under the control instead (warnings only). */
    hintInline?: boolean
    children: React.ReactNode
    className?: string
}

export function FormField({ label, hint, hintInline = false, children, className }: FormFieldProps) {
    return (
        <div className={cn("mb-5", className)}>
            <div className="mb-2 flex items-center gap-1">
                <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider">
                    {label}
                </label>
                {hint && !hintInline && <InfoTip content={hint} />}
            </div>
            {children}
            {hint && hintInline && <p className="text-xs text-text-muted mt-1.5">{hint}</p>}
        </div>
    )
}

/* ── Input ─────────────────────────────────────────── */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
    const { className: extraClass, ...rest } = props
    return (
        <input
            {...rest}
            className={cn(
                "w-full px-4 py-3 rounded-xl border border-border-subtle bg-bg-secondary",
                "text-text-primary text-sm outline-none",
                "focus:border-accent transition-colors",
                extraClass
            )}
        />
    )
}

/* ── Textarea ──────────────────────────────────────── */
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { className?: string }) {
    const { className: extraClass, ...rest } = props
    return (
        <textarea
            {...rest}
            className={cn(
                "w-full px-4 py-3 rounded-xl border border-border-subtle bg-bg-secondary",
                "text-text-primary text-sm outline-none resize-y",
                "focus:border-accent transition-colors",
                extraClass
            )}
        />
    )
}

export default FormField
