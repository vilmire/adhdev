import { useTranslation } from 'react-i18next'
import type { ActiveConversation } from './types'
import { isConversationGenerating } from './DashboardMobileChatShared'
import { getConversationTitle } from './conversation-presenters'
import { getConversationMachineLabel, getConversationProviderLabel } from './conversation-selectors'
import { isAssistantConversation } from './assistant-session'
import { MeshRoleIcon } from './ConversationMeshRoleMarker'
import LoadingSpinner from '../ui/LoadingSpinner'

export interface DashboardHiddenConversationsListProps {
    conversations: ActiveConversation[]
    onRestoreConversation?: (conversation: ActiveConversation) => void
    onOpenConversation?: (conversation: ActiveConversation) => void
    variant?: 'desktop' | 'mobile'
    showShortcuts?: boolean
}

export function getHiddenConversationRowTitle(conversation: ActiveConversation): string {
    if (isAssistantConversation(conversation)) return getConversationTitle(conversation)
    return conversation.displayPrimary?.trim()
        || conversation.title?.trim()
        || getConversationTitle(conversation)
}

export function getHiddenConversationRowMeta(conversation: ActiveConversation): string {
    const primary = getHiddenConversationRowTitle(conversation)
    const parts: string[] = []
    const seen = new Set<string>()
    const recordSeen = (value: string) => {
        for (const token of value.split('·')) {
            const normalized = token.trim().toLowerCase()
            if (normalized) seen.add(normalized)
        }
        const full = value.trim().toLowerCase()
        if (full) seen.add(full)
    }
    if (primary) recordSeen(primary)

    const pushIfNew = (candidate: string | null | undefined) => {
        const trimmed = candidate?.trim()
        if (!trimmed) return
        const candidateTokens = trimmed
            .split('·')
            .map(token => token.trim())
            .filter(Boolean)
        const remaining = candidateTokens.filter(token => !seen.has(token.toLowerCase()))
        if (remaining.length === 0) return
        const joined = remaining.join(' · ')
        parts.push(joined)
        recordSeen(joined)
    }

    pushIfNew(conversation.title)
    pushIfNew(conversation.displaySecondary)
    pushIfNew(getConversationProviderLabel(conversation))
    pushIfNew(conversation.workspaceName)
    pushIfNew(getConversationMachineLabel(conversation))

    return parts.join(' · ')
}

export function getHiddenConversationStatusKind(
    conversation: Pick<ActiveConversation, 'status' | 'connectionState'>,
): 'in_progress' | 'collapsed' {
    return isConversationGenerating(conversation) ? 'in_progress' : 'collapsed'
}

export default function DashboardHiddenConversationsList({
    conversations,
    onRestoreConversation,
    onOpenConversation,
    variant = 'desktop',
    showShortcuts = false,
}: DashboardHiddenConversationsListProps) {
    const { t } = useTranslation()
    const isMobileVariant = variant === 'mobile'

    return (
        <div
            className={`dashboard-header-hidden-list ${isMobileVariant ? 'px-3 pb-3 pt-2' : ''}`.trim()}
            data-testid={isMobileVariant ? 'mobile-hidden-tabs-list' : 'desktop-hidden-tabs-list'}
        >
            {conversations.map((conversation, index) => {
                const title = getHiddenConversationRowTitle(conversation)
                const meta = getHiddenConversationRowMeta(conversation)
                const statusKind = getHiddenConversationStatusKind(conversation)
                const isGenerating = statusKind === 'in_progress'
                const statusLabel = isGenerating
                    ? t('dashboard.hidden.statusInProgress')
                    : t('dashboard.hidden.statusCollapsed')

                return (
                    <div
                        key={conversation.tabKey}
                        className="dashboard-header-inbox-item"
                        data-testid="hidden-conversation-row"
                        data-tab-key={conversation.tabKey}
                        data-session-id={conversation.sessionId}
                    >
                        <button
                            type="button"
                            className="flex w-full min-w-0 flex-col items-start gap-1 text-left"
                            onClick={() => (onOpenConversation ?? onRestoreConversation)?.(conversation)}
                        >
                            <span className="dashboard-header-inbox-item-title flex w-full min-w-0 items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-1.5">
                                    {isGenerating && (
                                        <LoadingSpinner
                                            size={12}
                                            thickness={2}
                                            color="success"
                                            label={t('dashboard.header.generating')}
                                        />
                                    )}
                                    <MeshRoleIcon conversation={conversation} size={12} />
                                    <span className="truncate">{title}</span>
                                </span>
                                <span
                                    data-testid="hidden-conversation-status"
                                    data-status={statusKind}
                                    className={`shrink-0 rounded-full border px-2 py-0.5 text-3xs font-semibold ${
                                        isGenerating
                                            ? 'border-accent-primary/25 bg-accent-primary/10 text-accent-primary'
                                            : 'border-border-subtle bg-bg-primary/60 text-text-muted'
                                    }`}
                                >
                                    {statusLabel}
                                </span>
                            </span>
                            <span className="dashboard-header-inbox-item-meta block w-full truncate">
                                {showShortcuts && index < 9 ? (
                                    <span className="dashboard-header-item-shortcut">⌥{index + 1}</span>
                                ) : null}
                                {meta}
                            </span>
                        </button>
                        <div className="mt-2 flex w-full items-center justify-end gap-2">
                            <button
                                type="button"
                                data-testid="hidden-conversation-restore"
                                className="inline-flex min-h-9 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/80 px-3.5 py-1.5 text-xs font-semibold text-text-primary transition-colors hover:border-border-default active:scale-[0.99]"
                                aria-label={t('dashboard.hidden.restoreOneAria', { title })}
                                onClick={() => (onRestoreConversation ?? onOpenConversation)?.(conversation)}
                            >
                                {t('dashboard.hidden.restoreOne')}
                            </button>
                            <button
                                type="button"
                                data-testid="hidden-conversation-open"
                                className="inline-flex min-h-9 items-center justify-center rounded-full border border-accent-primary/30 bg-accent-primary/10 px-3.5 py-1.5 text-xs font-semibold text-accent-primary transition-colors hover:bg-accent-primary/15 active:scale-[0.99]"
                                aria-label={t('dashboard.hidden.openOneAria', { title })}
                                onClick={() => (onOpenConversation ?? onRestoreConversation)?.(conversation)}
                            >
                                {t('dashboard.hidden.openOne')}
                            </button>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
