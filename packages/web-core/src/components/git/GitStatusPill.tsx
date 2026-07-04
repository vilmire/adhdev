import type { GitCompactSummary } from '@adhdev/daemon-core'

export interface GitStatusPillProps {
    git?: GitCompactSummary | null
    className?: string
    compact?: boolean
}

export function getGitStatusPillLabel(git?: GitCompactSummary | null): string | null {
    if (!git || git.isGitRepo === false || git.reason === 'not_git_repo') return null
    if (git.hasConflicts) return `${git.branch || 'Git'} · conflicts${git.changedFiles > 0 ? ` ${git.changedFiles}` : ''}`

    const parts: string[] = [git.branch || 'Git']
    if (git.changedFiles > 0) parts.push(`±${git.changedFiles}`)
    if (git.ahead > 0) parts.push(`↑${git.ahead}`)
    if (git.behind > 0) parts.push(`↓${git.behind}`)
    if (parts.length === 1 && git.dirty) parts.push('dirty')
    return parts.join(' ')
}

export function getGitStatusPillTone(git?: GitCompactSummary | null): 'quiet' | 'dirty' | 'conflict' | 'error' | null {
    if (!git || git.isGitRepo === false || git.reason === 'not_git_repo') return null
    if (git.hasConflicts) return 'conflict'
    if (git.error) return 'error'
    if (git.dirty || git.changedFiles > 0 || git.ahead > 0 || git.behind > 0) return 'dirty'
    return 'quiet'
}

function getToneClassName(tone: NonNullable<ReturnType<typeof getGitStatusPillTone>>): string {
    switch (tone) {
        case 'conflict':
            return 'border-status-error/40 bg-status-error/10 text-status-error'
        case 'error':
            return 'border-yellow-500/25 bg-yellow-500/[0.08] text-yellow-500'
        case 'dirty':
            return 'border-orange-500/25 bg-orange-500/[0.08] text-orange-400'
        case 'quiet':
        default:
            return 'border-status-online/40 bg-status-online/10 text-status-online'
    }
}

export default function GitStatusPill({ git, className = '', compact = false }: GitStatusPillProps) {
    const label = getGitStatusPillLabel(git)
    const tone = getGitStatusPillTone(git)
    if (!label || !tone) return null

    const titleParts = [
        git?.branch ? `Branch: ${git.branch}` : null,
        git?.changedFiles ? `Changed files: ${git.changedFiles}` : null,
        git?.ahead ? `Ahead: ${git.ahead}` : null,
        git?.behind ? `Behind: ${git.behind}` : null,
        git?.hasConflicts ? 'Conflicts detected' : null,
        git?.error ? `Git error: ${git.error}` : null,
    ].filter(Boolean)

    return (
        <span
            className={`inline-flex min-w-0 max-w-[12rem] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${getToneClassName(tone)} ${className}`.trim()}
            title={titleParts.join(' · ') || label}
            data-git-tone={tone}
        >
            <span aria-hidden="true">⑂</span>
            <span className={compact ? 'truncate' : 'truncate'}>{label}</span>
        </span>
    )
}
