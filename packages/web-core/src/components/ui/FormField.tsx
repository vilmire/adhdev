import React from 'react'
import { cn } from '../../lib/utils'

/* ── FormField ─────────────────────────────────────── */
interface FormFieldProps {
    label: string
    hint?: string
    children: React.ReactNode
    className?: string
}

export function FormField({ label, hint, children, className }: FormFieldProps) {
    return (
        <div className={cn("mb-5", className)}>
            <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
                {label}
            </label>
            {children}
            {hint && <p className="text-xs text-text-muted mt-1.5">{hint}</p>}
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
