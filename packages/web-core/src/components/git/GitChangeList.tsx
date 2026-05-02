import type { GitFileChange, GitFileChangeStatus } from '@adhdev/daemon-core'

export interface GitChangeListProps {
    files: GitFileChange[]
    truncated?: boolean
    onFileClick?: (file: GitFileChange) => void
    selectedPath?: string | null
    className?: string
}

const STATUS_LABEL: Record<GitFileChangeStatus, string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: '?',
    conflict: '!',
}

const STATUS_CLASS: Record<GitFileChangeStatus, string> = {
    added: 'text-emerald-400',
    modified: 'text-orange-400',
    deleted: 'text-red-400',
    renamed: 'text-sky-400',
    copied: 'text-sky-400',
    untracked: 'text-zinc-400',
    conflict: 'text-red-400 font-bold',
}

function basename(path: string): string {
    return path.split('/').pop() ?? path
}

function dirname(path: string): string {
    const idx = path.lastIndexOf('/')
    return idx > 0 ? path.slice(0, idx) : ''
}

export default function GitChangeList({ files, truncated, onFileClick, selectedPath, className = '' }: GitChangeListProps) {
    if (files.length === 0) {
        return <p className="px-3 py-2 text-xs text-text-secondary">No changed files.</p>
    }

    return (
        <div className={`flex flex-col ${className}`}>
            <ul className="min-w-0 divide-y divide-border/30">
                {files.map((file) => {
                    const isSelected = selectedPath === file.path
                    const label = STATUS_LABEL[file.status] ?? '?'
                    const labelClass = STATUS_CLASS[file.status] ?? 'text-zinc-400'
                    const dir = dirname(file.path)
                    const name = basename(file.path)
                    const stagedDot = file.staged
                        ? <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" title="Staged" />
                        : null

                    return (
                        <li
                            key={`${file.path}-${file.staged ? 'S' : 'U'}`}
                            className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-elevated/60 ${isSelected ? 'bg-surface-elevated' : ''}`}
                            onClick={() => onFileClick?.(file)}
                        >
                            <span className={`w-3 shrink-0 font-mono font-bold ${labelClass}`} title={file.status}>
                                {label}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                                {dir && <span className="text-text-secondary">{dir}/</span>}
                                <span className="text-text-primary">{name}</span>
                                {file.oldPath && (
                                    <span className="ml-1 text-text-secondary">← {basename(file.oldPath)}</span>
                                )}
                                {stagedDot}
                            </span>
                            {!file.binary && (file.insertions > 0 || file.deletions > 0) && (
                                <span className="shrink-0 font-mono text-[10px]">
                                    {file.insertions > 0 && <span className="text-emerald-500">+{file.insertions}</span>}
                                    {file.insertions > 0 && file.deletions > 0 && <span className="text-text-secondary"> </span>}
                                    {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
                                </span>
                            )}
                            {file.binary && <span className="shrink-0 text-[10px] text-text-secondary">bin</span>}
                        </li>
                    )
                })}
            </ul>
            {truncated && (
                <p className="px-3 py-1.5 text-[10px] text-text-secondary">
                    File list truncated — run <code className="font-mono">git status</code> locally for full output.
                </p>
            )}
        </div>
    )
}
