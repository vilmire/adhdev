import React from 'react'
import { cn } from '../../lib/utils'

/* ── Types ─────────────────────────────────────────── */
interface Column<T> {
    key: string
    header: string
    render: (row: T) => React.ReactNode
    className?: string
}

interface DataTableProps<T> {
    columns: Column<T>[]
    data: T[]
    rowKey: (row: T) => string
    emptyMessage?: string
    onRowClick?: (row: T) => void
    className?: string
}

/* ── DataTable ─────────────────────────────────────── */
export function DataTable<T>({ columns, data, rowKey, emptyMessage, onRowClick, className }: DataTableProps<T>) {
    if (data.length === 0) {
        return (
            <div className="py-12 text-center text-text-muted text-sm">
                {emptyMessage || 'No records found.'}
            </div>
        )
    }

    return (
        <div className={cn("overflow-x-auto rounded-xl border border-border-subtle", className)}>
            <table className="w-full text-sm border-collapse">
                <thead>
                    <tr className="border-b border-border-subtle bg-white/[0.03]">
                        {columns.map(col => (
                            <th
                                key={col.key}
                                className={cn(
                                    "text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3",
                                    col.className
                                )}
                            >
                                {col.header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.map(row => (
                        <tr
                            key={rowKey(row)}
                            onClick={() => onRowClick?.(row)}
                            className={cn(
                                "border-b border-border-subtle/50 transition-colors",
                                "hover:bg-bg-glass-hover",
                                onRowClick && "cursor-pointer"
                            )}
                        >
                            {columns.map(col => (
                                <td key={col.key} className={cn("px-4 py-3 text-text-primary", col.className)}>
                                    {col.render(row)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

export default DataTable
