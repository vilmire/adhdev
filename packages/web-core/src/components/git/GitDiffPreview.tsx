import { useEffect, useRef } from 'react'

export interface GitDiffPreviewProps {
    diff: string
    binary?: boolean
    truncated?: boolean
    loading?: boolean
    error?: string | null
    className?: string
}

function renderDiffLine(line: string, idx: number) {
    let cls = 'text-text-secondary'
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'bg-status-online/10 text-status-online'
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'bg-status-error/10 text-status-error'
    else if (line.startsWith('@@')) cls = 'text-accent-primary'
    else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) cls = 'text-text-secondary'

    return (
        <div key={idx} className={`px-3 ${cls}`}>
            <code className="whitespace-pre font-mono text-[11px] leading-5">{line}</code>
        </div>
    )
}

export default function GitDiffPreview({ diff, binary, truncated, loading, error, className = '' }: GitDiffPreviewProps) {
    const scrollRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0
    }, [diff])

    if (loading) {
        return (
            <div className={`flex items-center justify-center py-8 text-xs text-text-secondary ${className}`}>
                Loading diff…
            </div>
        )
    }

    if (error) {
        return (
            <div className={`px-3 py-4 text-xs text-status-error ${className}`}>
                {error}
            </div>
        )
    }

    if (binary) {
        return (
            <div className={`px-3 py-4 text-xs text-text-secondary ${className}`}>
                Binary file — diff not available.
            </div>
        )
    }

    if (!diff) {
        return (
            <div className={`px-3 py-4 text-xs text-text-secondary ${className}`}>
                No diff available.
            </div>
        )
    }

    const lines = diff.split('\n')

    return (
        <div ref={scrollRef} className={`overflow-auto ${className}`}>
            <div className="py-1">
                {lines.map((line, idx) => renderDiffLine(line, idx))}
            </div>
            {truncated && (
                <p className="px-3 py-1.5 text-[10px] text-text-secondary border-t border-border/30">
                    Diff truncated — run <code className="font-mono">git diff</code> locally for full output.
                </p>
            )}
        </div>
    )
}
