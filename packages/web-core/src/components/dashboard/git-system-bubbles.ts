import type { GitCompactSummary } from '@adhdev/daemon-core'
import type { ActiveConversation, DashboardMessage } from './types'

export interface BuildGitSystemBubbleOptions {
    /** Default ON: show daemon-derived Git work summary bubbles in chat. */
    enabled?: boolean
}

type GitBubblePhase = 'working' | 'complete'

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`
}

function sanitizeIdPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._:-]+/g, '-').slice(0, 80) || 'latest'
}

function isGitWorkspace(conversation: Pick<ActiveConversation, 'workspacePath' | 'git'>): conversation is Pick<ActiveConversation, 'workspacePath'> & { git: GitCompactSummary } {
    return typeof conversation.workspacePath === 'string'
        && conversation.workspacePath.trim().length > 0
        && !!conversation.git
        && conversation.git.isGitRepo === true
}

function isWorkingConversation(conversation: Pick<ActiveConversation, 'status' | 'inboxBucket'>): boolean {
    return conversation.status === 'generating'
        || conversation.status === 'streaming'
        || conversation.status === 'working'
        || conversation.inboxBucket === 'working'
}

function getCompletionMarker(conversation: Pick<ActiveConversation, 'completionMarker' | 'lastMessageHash' | 'lastMessageAt' | 'lastUpdated'>): string {
    const marker = typeof conversation.completionMarker === 'string' ? conversation.completionMarker.trim() : ''
    if (marker) return marker
    if (conversation.lastMessageHash) return conversation.lastMessageHash
    if (conversation.lastMessageAt) return String(conversation.lastMessageAt)
    if (conversation.lastUpdated) return String(conversation.lastUpdated)
    return ''
}

function isCompletedConversation(conversation: Pick<ActiveConversation, 'status' | 'inboxBucket' | 'completionMarker' | 'lastMessageHash' | 'lastMessageAt' | 'lastUpdated'>): boolean {
    if (isWorkingConversation(conversation)) return false
    return conversation.inboxBucket === 'task_complete' && getCompletionMarker(conversation).length > 0
}

function getGitBranchLabel(git: GitCompactSummary): string {
    return git.branch || 'detached HEAD'
}

export function getGitSystemBubbleSummaryText(git: GitCompactSummary): string {
    if (git.error) return `${getGitBranchLabel(git)} · Git error: ${git.error}`

    const parts = [getGitBranchLabel(git)]
    if (git.changedFiles > 0) {
        parts.push(pluralize(git.changedFiles, 'file') + ' changed')
    } else if (!git.dirty) {
        parts.push('clean')
    }
    if (git.ahead > 0) parts.push(`ahead ${git.ahead}`)
    if (git.behind > 0) parts.push(`behind ${git.behind}`)
    if (git.hasConflicts) parts.push('conflicts')
    return parts.join(' · ')
}

function buildGitSystemBubbleContent(phase: GitBubblePhase, git: GitCompactSummary): string {
    const action = phase === 'working' ? 'work started' : 'work completed'
    return `Git workspace · ${action} · ${getGitSystemBubbleSummaryText(git)}`
}

function getGitSystemBubbleTimestamp(conversation: ActiveConversation, git: GitCompactSummary): number {
    return conversation.lastUpdated || conversation.lastMessageAt || git.lastCheckedAt || 0
}

export function buildGitSystemBubbleMessages(
    conversation: ActiveConversation,
    options: BuildGitSystemBubbleOptions = {},
): DashboardMessage[] {
    if (options.enabled === false) return []
    if (!isGitWorkspace(conversation)) return []

    const phase: GitBubblePhase | null = isWorkingConversation(conversation)
        ? 'working'
        : isCompletedConversation(conversation)
            ? 'complete'
            : null
    if (!phase) return []

    const completionMarker = phase === 'complete' ? getCompletionMarker(conversation) : ''
    const id = phase === 'complete'
        ? `git-system:${conversation.sessionId || conversation.tabKey}:complete:${sanitizeIdPart(completionMarker)}`
        : `git-system:${conversation.sessionId || conversation.tabKey}:working`

    return [{
        id,
        role: 'system',
        kind: 'system',
        content: buildGitSystemBubbleContent(phase, conversation.git),
        timestamp: getGitSystemBubbleTimestamp(conversation, conversation.git),
        meta: {
            source: 'git-system-bubble',
            phase,
            workspace: conversation.workspacePath,
            repoRoot: conversation.git.repoRoot,
            branch: conversation.git.branch,
            changedFiles: conversation.git.changedFiles,
            hasConflicts: conversation.git.hasConflicts,
        },
    }]
}
