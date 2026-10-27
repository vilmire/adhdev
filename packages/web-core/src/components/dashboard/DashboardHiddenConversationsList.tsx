import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActiveConversation } from './types'
import { isConversationGenerating } from './DashboardMobileChatShared'
import { getConversationTitle } from './conversation-presenters'
import { getConversationMachineLabel, getConversationProviderLabel } from './conversation-selectors'
import { isAssistantConversation } from './assistant-session'
import { MeshRoleIcon } from './ConversationMeshRoleMarker'
import LoadingSpinner from '../ui/LoadingSpinner'
import { useSingleFlightAction } from '../../hooks/useSingleFlightAction'
import { auditTouchTargets } from '../../utils/touch-target'

export interface DashboardHiddenConversationsListProps {
    conversations: ActiveConversation[]
    /**
     * Restores the hidden chat AND opens it (desktopOpen-only, owner decision
     * rc35: there is no secondary restore-without-open per row; "Restore all"
     * stays on the surrounding card/popover). May return a promise — the row
     * then single-flights with a left spinner until it settles; Escape cancels.
     */
    onOpenConversation?: (conversation: ActiveConversation, signal?: AbortSignal) => unknown
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
    onOpenConversation,
    variant = 'desktop',
    showShortcuts = false,
}: DashboardHiddenConversationsListProps) {
    const { t } = useTranslation()
    const isMobileVariant = variant === 'mobile'
    const flight = useSingleFlightAction()
    const listRef = useRef<HTMLDivElement>(null)
    useEffect(() => { auditTouchTargets(listRef.current, '[data-testid="hidden-conversation-open"]', 'hidden-tab row') }, [conversations.length])

    const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            if (!flight.pendingKey) return
            // First Escape cancels the in-flight open; the next one is the popover's.
            event.preventDefault()
            event.stopPropagation()
            flight.cancel()
            return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-testid="hidden-conversation-open"]'))
        if (buttons.length === 0) return
        event.preventDefault()
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home'
            ? buttons[0]
            : event.key === 'End'
                ? buttons[buttons.length - 1]
                : buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
        next?.focus({ preventScroll: true })
    }

    return (
        <div
            ref={listRef}
            className={`dashboard-header-hidden-list ${isMobileVariant ? 'px-3 pb-3 pt-2' : ''}`.trim()}
            data-testid={isMobileVariant ? 'mobile-hidden-tabs-list' : 'desktop-hidden-tabs-list'}
            onKeyDown={onListKeyDown}
        >
            {conversations.map((conversation, index) => {
                const title = getHiddenConversationRowTitle(conversation)
                const meta = getHiddenConversationRowMeta(conversation)
                const statusKind = getHiddenConversationStatusKind(conversation)
                const isGenerating = statusKind === 'in_progress'
                const statusLabel = isGenerating
                    ? t('dashboard.hidden.statusInProgress')
                    : t('dashboard.hidden.statusCollapsed')
                const isPending = flight.pendingKey === conversation.tabKey
                const isBlocked = !!flight.pendingKey && !isPending

                return (
                    <div
                        key={conversation.tabKey}
                        className="dashboard-header-inbox-item dashboard-hidden-row"
                        data-testid="hidden-conversation-row"
                        data-tab-key={conversation.tabKey}
                        data-session-id={conversation.sessionId}
                    >
                        <button
                            type="button"
                            data-testid="hidden-conversation-open"
                            className="dashboard-hidden-row-button flex min-h-[52px] w-full min-w-0 items-center gap-2.5 text-left"
                            aria-busy={isPending || undefined}
                            aria-disabled={isBlocked || undefined}
                            onClick={() => {
                                if (!onOpenConversation) return
                                flight.run(conversation.tabKey, signal => onOpenConversation(conversation, signal))
                            }}
                        >
                            {/* Left slot: the open's own spinner while it runs, else the
                                session's generating spinner; empty keeps titles aligned. */}
                            <span data-testid="hidden-conversation-leading" className="dashboard-hidden-row-leading inline-flex w-4 shrink-0 items-center justify-center">
                                {isPending ? (
                                    <LoadingSpinner size={14} thickness={2} label={t('dashboard.hidden.opening')} />
                                ) : isGenerating ? (
                                    <LoadingSpinner
                                        size={12}
                                        thickness={2}
                                        color="success"
                                        label={t('dashboard.header.generating')}
                                    />
                                ) : null}
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                                <span className="dashboard-header-inbox-item-title flex w-full min-w-0 items-center justify-between gap-2">
                                    <span className="flex min-w-0 items-center gap-1.5">
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
                            </span>
                        </button>
                    </div>
                )
            })}
        </div>
    )
}
