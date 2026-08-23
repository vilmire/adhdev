import { useCallback, useState } from 'react'
import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { IconBell, IconBellOff, IconSettings, IconChat, IconEyeOff, IconMesh, IconX } from '../Icons'
import InstallCommand from '../InstallCommand'
import { countGeneratingConversations, formatRelativeTime, getConversationViewStates, type MobileConversationListItem, type MobileMachineCard } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import DashboardMobileBottomNav, { type DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationMetaText, getConversationStatusHint, getConversationTitle, isMeshGraphConversation } from './conversation-presenters'
import { buildChatDebugBundleClipboardText, buildChatDebugBundleToastMessage, buildChatFrontendDebugSnapshot, copyChatDebugBundleTextToClipboard } from './chat-debug-bundle'
import { eventManager } from '../../managers/EventManager'
import { getProviderArgs, getRouteTarget } from '../../hooks/dashboardCommandUtils'
import { unwrapCommandResult } from '../../hooks/useDashboardConversationCommands'
import GitStatusPill from '../git/GitStatusPill'
import ModalPortal from '../ui/ModalPortal'
import LoadingSpinner from '../ui/LoadingSpinner'

type MobileInboxDebugBundleCollector = (conversation: ActiveConversation) => void | Promise<void>

interface DashboardMobileChatInboxProps {
    section: DashboardMobileSection
    attentionItems: MobileConversationListItem[]
    unreadItems: MobileConversationListItem[]
    workingItems: MobileConversationListItem[]
    completedItems: MobileConversationListItem[]
    hiddenConversations: ActiveConversation[]
    machineCards: MobileMachineCard[]
    getAvatarText: (primary: string) => string
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onOpenConversation: (conversation: ActiveConversation) => void
    onShowAllHidden: () => void
    onHideConversation?: (conversation: ActiveConversation) => void
    onOpenMeshGraph?: (conversation: ActiveConversation) => void
    /** Optional: stop (terminate) the underlying CLI/agent session for a conversation. */
    onStopCli?: (conversation?: ActiveConversation) => void | Promise<void>
    onOpenNewSession?: () => void
    onOpenMachine: (machineId: string) => void
    onOpenSettings: () => void
    onSectionChange: (section: DashboardMobileSection) => void
    wsStatus?: string
    /**
     * False while the first DAEMON snapshot is still in flight. `wsStatus` alone
     * does not cover this: the socket reports 'connected' as soon as it is up,
     * but the machine list stays empty until the snapshot lands — which is exactly
     * the window where the empty state claimed "no machines" against data that had
     * not arrived yet.
     *
     * Scope note: this covers the MACHINE list only. On cloud the daemon snapshot is
     * deliberately daemon-only, so conversations are still in flight when this turns
     * true — see `conversationsLoaded`.
     */
    initialDataLoaded?: boolean
    /**
     * False while the CONVERSATION list is still in flight. Distinct from
     * `initialDataLoaded` because conversations arrive over P2P strictly after the
     * daemon discovery snapshot (see `areConversationsLoaded`). Defaults to
     * `initialDataLoaded` so callers that do not distinguish the two keep the old
     * behaviour.
     */
    conversationsLoaded?: boolean
    isConnected?: boolean
    isStandalone?: boolean
    onCollectChatDebugBundle?: MobileInboxDebugBundleCollector
    /** Optional: returns true if the conversation is muted (standalone only). */
    isConversationMuted?: (conversation: ActiveConversation) => boolean
    /** Optional: toggle mute state for a conversation (standalone only). */
    onToggleMuteConversation?: (conversation: ActiveConversation) => void
}

function InboxSectionHeader({
    title,
    className = '',
}: {
    title: string
    className?: string
}) {
    return (
        <div className={`mx-1 flex items-center justify-between gap-2 px-1 py-1 text-xs ${className}`}>
            <span className="font-bold uppercase tracking-[0.18em] text-text-secondary">{title}</span>
        </div>
    )
}

function InboxListSection({
    children,
    className = '',
}: {
    children: React.ReactNode
    className?: string
}) {
    return (
        <div className={`w-full min-w-0 self-stretch overflow-hidden rounded-[24px] border border-border-subtle/80 bg-bg-secondary/40 shadow-[0_10px_30px_rgba(0,0,0,0.05)] ${className}`}>
            {children}
        </div>
    )
}

function MobileEmptyHero({ icon, title, subtitle, children }: {
    icon: React.ReactNode
    title: string
    subtitle: string
    children?: React.ReactNode
}) {
    return (
        <div className="flex w-full min-w-0 flex-col items-center justify-center gap-2 px-6 pt-12 pb-8 text-center">
            <div className="mb-2 rounded-2xl border border-accent-primary/10 bg-[color:color-mix(in_oklab,var(--bg-secondary)_90%,var(--accent-primary)_10%)] p-3 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">{icon}</div>
            <div className="text-lg font-bold tracking-tight text-text-primary">
                {title}
            </div>
            <div className="text-[13px] leading-relaxed text-text-secondary max-w-[320px]">
                {subtitle}
            </div>
            {children}
        </div>
    )
}

function HideConversationConfirmDialog({
    conversation,
    onCancel,
    onConfirm,
}: {
    conversation: ActiveConversation
    onCancel: () => void
    onConfirm: () => void
}) {
    const { t } = useTranslation()
    const title = getConversationTitle(conversation)

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-end justify-center overflow-y-auto px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4">
            <div onClick={onCancel} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-hide-confirm-title"
                className="card fade-in mobile-compact-dialog relative w-full sm:w-[min(92vw,420px)] md:w-[92%] md:max-w-[420px] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] flex flex-col overflow-hidden rounded-[24px] sm:rounded-[18px] shadow-[0_20px_40px_rgba(0,0,0,0.4)]"
            >
                <div className="px-4 py-4 md:px-6 md:py-5 border-b border-border-subtle bg-bg-primary">
                    <h3 id="mobile-hide-confirm-title" className="m-0 text-base md:text-lg font-extrabold">{t('mobileInbox.hideTitle', { title })}</h3>
                    <div className="mt-1 text-[13px] md:text-sm text-text-muted leading-relaxed">
                        {t('mobileInbox.hideDescription')}
                    </div>
                </div>

                <div className="px-4 py-4 md:px-6 md:py-5 bg-bg-primary flex flex-col gap-2.5">
                    <button
                        onClick={onConfirm}
                        className="btn btn-primary w-full justify-center min-h-[42px]"
                    >
                        {t('mobileInbox.hide')}
                    </button>
                    <button
                        onClick={onCancel}
                        className="btn btn-secondary w-full justify-center min-h-[42px]"
                    >
                        {t('common.cancel')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    )
}


function DashboardMobileChatItem({
    item,
    type,
    getAvatarText,
    onOpenConversation,
    onRequestHideConversation,
    onRequestStopCli,
    onOpenMeshGraph,
    onCollectChatDebugBundle,
    isMuted,
    onToggleMute,
}: {
    item: MobileConversationListItem
    type: 'needs_attention' | 'task_complete' | 'working' | 'earlier'
    getAvatarText: (primary: string) => string
    onOpenConversation: (c: ActiveConversation) => void
    onRequestHideConversation?: () => void
    onRequestStopCli?: () => void
    onOpenMeshGraph?: (conversation: ActiveConversation) => void
    onCollectChatDebugBundle?: MobileInboxDebugBundleCollector
    isMuted?: boolean
    onToggleMute?: () => void
}) {
    const { t } = useTranslation()
    const isUnread = type === 'needs_attention' || type === 'task_complete'
    const isWorking = type === 'working'
    const isEarlier = type === 'earlier'
    const isTaskComplete = type === 'task_complete'
    const { isReconnecting, isConnecting } = getConversationViewStates(item.conversation)
    const title = getConversationTitle(item.conversation)
    const metaText = getConversationMetaText(item.conversation)
    const statusHint = getConversationStatusHint(item.conversation, { requiresAction: type === 'needs_attention' })
    const rowClassName = isUnread
        ? 'bg-[color:color-mix(in_oklab,var(--bg-secondary)_92%,var(--accent-primary)_8%)]'
        : isWorking
            ? 'bg-[color:color-mix(in_oklab,var(--bg-secondary)_94%,var(--accent-primary)_6%)]'
            : isEarlier
                ? 'bg-[color:color-mix(in_oklab,var(--bg-secondary)_97%,var(--text-muted)_3%)]'
                : 'bg-transparent'
    const avatarClassName = isUnread
        ? 'bg-accent-primary shadow-glow'
        : isWorking
            ? 'bg-[color:color-mix(in_oklab,var(--bg-primary)_82%,var(--accent-primary)_18%)] border border-accent-primary/22 text-accent-primary'
            : isEarlier
                ? 'bg-[color:color-mix(in_oklab,var(--bg-primary)_95%,var(--text-muted)_5%)] border border-border-subtle/80 text-text-muted'
                : 'bg-bg-primary border border-border-subtle text-text-secondary'
    const titleClassName = isEarlier ? 'text-text-secondary' : 'text-text-primary'
    const metaClassName = isEarlier ? 'text-text-muted' : 'text-text-secondary'
    const previewClassName = isEarlier ? 'text-text-secondary opacity-80' : 'text-text-muted'
    const timestampClassName = isEarlier ? 'text-text-muted opacity-80' : 'text-text-muted'
    const shouldShowTimestamp = !isWorking && !isTaskComplete
    const meshGraphAvailable = isMeshGraphConversation(item.conversation)
    const warningTextClassName = 'text-[color:var(--status-warning)]'
    const handleConversationContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
        if (!onCollectChatDebugBundle) return
        event.preventDefault()
        event.stopPropagation()
        const result = onCollectChatDebugBundle?.(item.conversation)
        void Promise.resolve(result).catch((error) => {
            console.warn('[chat-debug-bundle] failed to collect mobile inbox debug bundle', error)
        })
    }
    
    return (
        <div
            key={item.conversation.tabKey}
            className={`group relative overflow-hidden transition-colors active:scale-[0.995] ${rowClassName}`}
        >
            <div className="relative flex w-full items-start gap-3.5 px-4 py-3.5 text-left">
                {(isUnread || isWorking) ? (
                    <span className="pointer-events-none absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full bg-accent-primary/80" />
                ) : null}
                <div className="mobile-inbox-leading-rail flex w-11 shrink-0 flex-col items-center gap-1.5">
                    <span
                        className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${avatarClassName}`}
                        style={isUnread ? { color: 'var(--accent-on-primary)' } : undefined}
                    >
                        {getAvatarText(title)}
                    </span>
                    {meshGraphAvailable && onOpenMeshGraph && (
                        <button
                            type="button"
                            className="mobile-inbox-mesh-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/70 text-text-muted transition-colors hover:border-border-default hover:text-text-primary"
                            onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                onOpenMeshGraph(item.conversation)
                            }}
                            aria-label={t('mobileInbox.openMeshGraphFor', { title })}
                            title={t('mobileInbox.openLiveMeshGraph')}
                        >
                            <IconMesh size={13} />
                        </button>
                    )}
                </div>
                <button
                    className="relative flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                    onClick={() => onOpenConversation(item.conversation)}
                    onContextMenu={handleConversationContextMenu}
                    type="button"
                >
                    <div className="flex items-center gap-2 pr-[124px]">
                        <span className={`text-[15px] font-bold truncate tracking-tight ${titleClassName}`}>{title}</span>
                    </div>
                    <div className={`text-xs font-medium truncate flex items-center ${metaClassName}`}>
                        <span className="truncate">{metaText}</span>
                        <GitStatusPill git={item.conversation.git} compact className="ml-1 max-w-[6.5rem] shrink-0" />
                        {isReconnecting ? (
                            <>
                                <span className="mx-1 opacity-50">·</span>
                                <span className={`${warningTextClassName} animate-pulse`}>{t('mobileInbox.reconnectingItem')}</span>
                            </>
                        ) : isConnecting ? (
                            <>
                                <span className="mx-1 opacity-50">·</span>
                                <span className="text-text-muted">{t('mobileInbox.connectingItem')}</span>
                            </>
                        ) : statusHint === 'Action needed' && (
                            <>
                                <span className="mx-1 opacity-50">·</span>
                                <span className={warningTextClassName}>{t('mobileInbox.actionNeeded')}</span>
                            </>
                        )}
                    </div>
                    <div className={`mt-0.5 truncate text-[13px] ${previewClassName}`}>
                        {item.preview}
                    </div>
                </button>
                <div className="mobile-inbox-corner-actions absolute top-3 right-3 flex items-center gap-1.5">
                    {shouldShowTimestamp && (
                        <span className={`mr-0.5 text-[11px] font-medium shrink-0 ${timestampClassName}`}>{formatRelativeTime(item.timestamp)}</span>
                    )}
                    {isTaskComplete && (
                        <span className="rounded-full border border-accent-primary/16 bg-accent-primary/10 px-2 py-0.5 text-[10px] font-bold text-accent-primary">
                            {t('mobileInbox.done')}
                        </span>
                    )}
                    {onToggleMute && (
                        <button
                            type="button"
                            className={`mobile-inbox-mute-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
                                isMuted
                                    ? 'border-amber-500/60 bg-amber-500 text-white hover:bg-amber-600'
                                    : 'border-border-subtle bg-bg-primary/70 text-text-muted hover:border-border-default hover:text-text-primary'
                            }`}
                            onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                onToggleMute()
                            }}
                            aria-label={isMuted ? t('mobileInbox.unmute', { title }) : t('mobileInbox.mute', { title })}
                            title={isMuted ? t('mobileInbox.mutedTitle') : t('mobileInbox.muteNotifications')}
                        >
                            {isMuted ? <IconBellOff size={13} /> : <IconBell size={13} />}
                        </button>
                    )}
                    {onRequestHideConversation && (
                        <button
                            type="button"
                            className="mobile-inbox-hide-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/70 text-text-muted transition-colors hover:border-border-default hover:text-text-primary"
                            onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                onRequestHideConversation()
                            }}
                            aria-label={t('mobileInbox.hideConversationAria', { title })}
                            title={t('mobileInbox.hideConversationTitle')}
                        >
                            <IconEyeOff size={13} />
                        </button>
                    )}
                    {onRequestStopCli && (
                        <button
                            type="button"
                            className="mobile-inbox-stop-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-status-error/30 bg-bg-primary/70 text-status-error transition-colors hover:border-status-error/60 hover:bg-status-error/10"
                            onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                onRequestStopCli()
                            }}
                            aria-label={t('mobileInbox.stopSessionAria', { title })}
                            title={t('mobileInbox.stopSessionTitle')}
                        >
                            <IconX size={13} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

/**
 * Compact "generating" indicator (pulsing dot + count) used to surface active
 * work on collapsed/hidden surfaces where the chat body itself isn't visible.
 */
function MobileGeneratingIndicator({ count, label }: { count: number; label: string }) {
    if (count <= 0) return null
    return (
        <span className="inline-flex items-center gap-1.5 text-accent-primary" aria-live="polite">
            <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-primary/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-primary" />
            </span>
            <span className="font-semibold">{label}</span>
        </span>
    )
}

export default function DashboardMobileChatInbox({
    section,
    attentionItems,
    unreadItems,
    workingItems,
    completedItems,
    hiddenConversations,
    machineCards,
    getAvatarText,
    actionLogs,
    sendDaemonCommand,
    onOpenConversation,
    onShowAllHidden,
    onHideConversation,
    onOpenMeshGraph,
    onStopCli,
    onOpenNewSession,
    onOpenMachine,
    onOpenSettings,
    onSectionChange,
    wsStatus = 'connected',
    initialDataLoaded = true,
    conversationsLoaded,
    isStandalone = false,
    onCollectChatDebugBundle,
    isConversationMuted,
    onToggleMuteConversation,
}: DashboardMobileChatInboxProps) {
    const { t } = useTranslation()
    const [hideConfirmConversation, setHideConfirmConversation] = useState<ActiveConversation | null>(null)
    const isDisconnected = wsStatus === 'disconnected' || wsStatus === 'reconnecting' || wsStatus === 'offline' || wsStatus === 'auth_failed'
    // Distinct from isDisconnected: the socket is up, the data just is not here yet.
    // Machine-section scope — gated on the daemon discovery snapshot.
    const isBootstrapping = !isDisconnected && !initialDataLoaded
    // Conversation-section scope — additionally waits for the P2P session snapshot,
    // which lands strictly after the daemon snapshot on cloud.
    const isConversationBootstrapping = !isDisconnected && !(conversationsLoaded ?? initialDataLoaded)
    const hasMachines = machineCards.length > 0
    const hasAnyConversation = attentionItems.length > 0 || unreadItems.length > 0 || workingItems.length > 0 || completedItems.length > 0
    const inboxTitle = section === 'machines'
        ? t('mobileInbox.machines')
        : t('mobileInbox.chats')
    const headerPaddingClass = isStandalone
        ? 'px-5 pt-4 pb-4'
        : 'px-5 pt-[calc(16px+env(safe-area-inset-top,0px))] pb-4'
    const contentPaddingClass = isStandalone
        ? 'px-3 pb-3'
        : 'px-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))]'
    const collectMobileInboxChatDebugBundle = useCallback(async (conversation: ActiveConversation) => {
        const routeTarget = getRouteTarget(conversation)
        if (!routeTarget) return
        const liveMessages = Array.isArray(conversation.messages) ? conversation.messages : []
        const frontendSnapshot = buildChatFrontendDebugSnapshot({
            activeConv: conversation,
            visibleMessages: liveMessages,
            actionLogs,
            visibleBarControlCount: 0,
            chatTailState: {
                hasMoreHistory: false,
                historyError: null,
                historyMessages: [],
            },
            ui: {
                controlsVisible: false,
                visibleLiveCount: liveMessages.length,
                hiddenLiveCount: 0,
                isInputActive: false,
                isVisible: true,
            },
        })
        const raw = await sendDaemonCommand(routeTarget, 'get_chat_debug_bundle', {
            ...getProviderArgs(conversation),
            delivery: 'daemon_file',
            frontendSnapshot,
        })
        const result = unwrapCommandResult(raw)
        const text = buildChatDebugBundleClipboardText(result)
        const locatorCopyStatus = await copyChatDebugBundleTextToClipboard(text)
        if (locatorCopyStatus === 'failed') {
            console.warn('[chat-debug-bundle] failed to copy or present mobile inbox debug bundle locator')
        }
        eventManager.showToast(
            buildChatDebugBundleToastMessage(result, { locatorCopyStatus }),
            locatorCopyStatus === 'failed' ? 'warning' : 'success',
        )
    }, [actionLogs, sendDaemonCommand])
    const effectiveCollectChatDebugBundle = onCollectChatDebugBundle || collectMobileInboxChatDebugBundle
    const handleConfirmHideConversation = useCallback(() => {
        if (!hideConfirmConversation) return
        onHideConversation?.(hideConfirmConversation)
        setHideConfirmConversation(null)
    }, [hideConfirmConversation, onHideConversation])

    return (
        <div className="flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary">
            <div className={`z-10 shrink-0 bg-bg-primary ${headerPaddingClass}`}>
                <div className="flex items-center justify-between gap-3">
                    <div className="text-2xl font-black tracking-tight text-text-primary px-1">
                        {inboxTitle}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        {section === 'chats' && (attentionItems.length > 0 || unreadItems.length > 0) && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-accent-primary/16 bg-accent-primary/10 text-accent-primary text-[11px] font-bold shadow-[0_8px_20px_rgba(0,0,0,0.05)]">
                                <IconBell size={13} />
                                <span>{attentionItems.length + unreadItems.length}</span>
                            </div>
                        )}
                        <button onClick={onOpenSettings} className="w-8 h-8 flex items-center justify-center rounded-full border border-border-subtle bg-bg-secondary/70 text-text-secondary hover:text-text-primary hover:border-border-default transition-colors">
                            <IconSettings size={18} />
                        </button>
                    </div>
                </div>
            </div>

            <div className={`flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch] ${contentPaddingClass}`}>
                {section === 'machines' && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        {isDisconnected ? (
                            <MobileEmptyHero
                                icon={<LoadingSpinner size={32} />}
                                title={
                                    wsStatus === 'offline'
                                        ? t('mobileInbox.networkOffline')
                                        : wsStatus === 'auth_failed'
                                            ? t('mobileInbox.sessionExpired')
                                            : t('mobileInbox.reconnecting')
                                }
                                subtitle={
                                    wsStatus === 'offline'
                                        ? t('mobileInbox.waitingForNetwork')
                                        : wsStatus === 'auth_failed'
                                            ? t('mobileInbox.pleaseLogInAgain')
                                            : t('mobileInbox.restoringConnection')
                                }
                            />
                        ) : isBootstrapping ? (
                            <MobileEmptyHero
                                icon={<LoadingSpinner size={32} />}
                                title={t('mobileInbox.loading')}
                                subtitle={t('mobileInbox.loadingSubtitle')}
                            />
                        ) : machineCards.length === 0 ? (
                            <MobileEmptyHero
                                icon={
                                    <img
                                        src="/otter-logo.png"
                                        alt="ADHDev"
                                        className="w-12 h-12 object-contain animate-bounce"
                                        style={{ animationDuration: '3s' }}
                                    />
                                }
                                title={isStandalone ? t('mobileInbox.waitingForDaemon') : t('mobileInbox.connectYourMachines')}
                                subtitle={
                                    isStandalone
                                        ? t('mobileInbox.waitingForDaemonSubtitle')
                                        : t('mobileInbox.connectYourMachinesSubtitle')
                                }
                            >
                                {!isStandalone && (
                                    <div className="w-full max-w-[360px] mt-4">
                                        <InstallCommand />
                                    </div>
                                )}
                            </MobileEmptyHero>
                        ) : (
                            <InboxListSection>
                                {machineCards.map((machine, index) => (
                                    <button
                                        key={machine.id}
                                        className={`flex items-start gap-3.5 px-4 py-3.5 w-full text-left transition-colors active:scale-[0.995] ${index > 0 ? 'border-t border-border-subtle/70' : ''}`}
                                        onClick={() => onOpenMachine(machine.id)}
                                        type="button"
                                    >
                                        <span className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 bg-[color:color-mix(in_oklab,var(--bg-primary)_82%,var(--accent-primary)_18%)] border border-accent-primary/16 text-text-primary shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
                                            {getAvatarText(machine.label)}
                                        </span>
                                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-[15px] font-bold text-text-primary truncate tracking-tight">{machine.label}</span>
                                                <span className="flex items-center gap-2 text-[11px] font-medium text-text-muted shrink-0">
                                                    <MobileGeneratingIndicator
                                                        count={machine.generatingCount}
                                                        label={t('mobileInbox.generatingCount', { count: machine.generatingCount })}
                                                    />
                                                    {machine.unread > 0 ? <span className="text-accent-primary">{t('mobileInbox.newCount', { count: machine.unread })}</span> : machine.total > 0 ? t('mobileInbox.chatCount', { count: machine.total }) : t('mobileInbox.idle')}
                                                </span>
                                            </div>
                                            <div className="text-xs font-medium text-text-secondary truncate">{machine.subtitle}</div>
                                            {machine.total > 0 ? (
                                                <div className="text-[13px] text-text-muted mt-0.5">
                                                    {t('mobileInbox.chatCount', { count: machine.total })}{machine.unread > 0 ? t('mobileInbox.unreadSuffix', { count: machine.unread }) : ''}{machine.generatingCount > 0 ? t('mobileInbox.collapsedGeneratingSuffix', { count: machine.generatingCount }) : ''}
                                                </div>
                                            ) : machine.generatingCount > 0 ? (
                                                <div className="text-[13px] text-accent-primary mt-0.5 font-medium">
                                                    {t('mobileInbox.generatingCount', { count: machine.generatingCount })}
                                                </div>
                                            ) : (
                                                <div className="text-[13px] text-text-muted mt-0.5 italic opacity-70">
                                                    {t('mobileInbox.noActiveChats')}
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                ))}
                            </InboxListSection>
                        )}
                    </section>
                )}

                {section === 'chats' && attentionItems.length > 0 && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <InboxSectionHeader title={t('mobileInbox.needsAttention')} className="mb-0" />
                        <InboxListSection>
                            {attentionItems.map((item, index) => (
                                <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                    <DashboardMobileChatItem
                                        item={item}
                                        type="needs_attention"
                                        getAvatarText={getAvatarText}
                                        onOpenConversation={onOpenConversation}
                                        onRequestHideConversation={onHideConversation ? () => setHideConfirmConversation(item.conversation) : undefined}
                                        onRequestStopCli={onStopCli ? () => onStopCli(item.conversation) : undefined}
                                        onOpenMeshGraph={onOpenMeshGraph}
                                        onCollectChatDebugBundle={effectiveCollectChatDebugBundle}
                                        isMuted={isConversationMuted?.(item.conversation)}
                                        onToggleMute={onToggleMuteConversation ? () => onToggleMuteConversation(item.conversation) : undefined}
                                    />
                                </div>
                            ))}
                        </InboxListSection>
                    </section>
                )}

                {section === 'chats' && unreadItems.length > 0 && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <InboxSectionHeader title={t('mobileInbox.taskComplete')} className="mb-0 mt-2" />
                        <InboxListSection>
                            {unreadItems.map((item, index) => (
                                <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                    <DashboardMobileChatItem
                                        item={item}
                                        type="task_complete"
                                        getAvatarText={getAvatarText}
                                        onOpenConversation={onOpenConversation}
                                        onRequestHideConversation={onHideConversation ? () => setHideConfirmConversation(item.conversation) : undefined}
                                        onRequestStopCli={onStopCli ? () => onStopCli(item.conversation) : undefined}
                                        onOpenMeshGraph={onOpenMeshGraph}
                                        onCollectChatDebugBundle={effectiveCollectChatDebugBundle}
                                        isMuted={isConversationMuted?.(item.conversation)}
                                        onToggleMute={onToggleMuteConversation ? () => onToggleMuteConversation(item.conversation) : undefined}
                                    />
                                </div>
                            ))}
                        </InboxListSection>
                    </section>
                )}

                {section === 'chats' && workingItems.length > 0 && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <InboxSectionHeader title={t('mobileInbox.workingNow')} className="mb-0 mt-2" />
                        <InboxListSection>
                            {workingItems.map((item, index) => (
                                <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                    <DashboardMobileChatItem
                                        item={item}
                                        type="working"
                                        getAvatarText={getAvatarText}
                                        onOpenConversation={onOpenConversation}
                                        onRequestHideConversation={onHideConversation ? () => setHideConfirmConversation(item.conversation) : undefined}
                                        onRequestStopCli={onStopCli ? () => onStopCli(item.conversation) : undefined}
                                        onOpenMeshGraph={onOpenMeshGraph}
                                        onCollectChatDebugBundle={effectiveCollectChatDebugBundle}
                                        isMuted={isConversationMuted?.(item.conversation)}
                                        onToggleMute={onToggleMuteConversation ? () => onToggleMuteConversation(item.conversation) : undefined}
                                    />
                                </div>
                            ))}
                        </InboxListSection>
                    </section>
                )}

                {section === 'chats' && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        {completedItems.length > 0 && (
                            <InboxSectionHeader title={t('mobileInbox.earlier')} className="mb-0 mt-2 border-border-subtle/80 bg-bg-secondary/35" />
                        )}
                        {completedItems.length > 0 ? (
                            <InboxListSection>
                                {completedItems.map((item, index) => (
                                    <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                        <DashboardMobileChatItem
                                            item={item}
                                            type="earlier"
                                            getAvatarText={getAvatarText}
                                            onOpenConversation={onOpenConversation}
                                            onRequestHideConversation={onHideConversation ? () => setHideConfirmConversation(item.conversation) : undefined}
                                            onRequestStopCli={onStopCli ? () => onStopCli(item.conversation) : undefined}
                                            onOpenMeshGraph={onOpenMeshGraph}
                                            onCollectChatDebugBundle={effectiveCollectChatDebugBundle}
                                            isMuted={isConversationMuted?.(item.conversation)}
                                            onToggleMute={onToggleMuteConversation ? () => onToggleMuteConversation(item.conversation) : undefined}
                                        />
                                    </div>
                                ))}
                            </InboxListSection>
                        ) : !hasAnyConversation ? (
                            isDisconnected ? (
                                <MobileEmptyHero
                                    icon={<LoadingSpinner size={28} />}
                                    title={t('mobileInbox.connecting')}
                                    subtitle={t('mobileInbox.connectingSubtitle')}
                                />
                            ) : isConversationBootstrapping ? (
                                <MobileEmptyHero
                                    icon={<LoadingSpinner size={28} />}
                                    title={t('mobileInbox.loading')}
                                    subtitle={t('mobileInbox.loadingSubtitle')}
                                />
                            ) : !hasMachines ? (
                                <MobileEmptyHero
                                    icon={
                                        <img
                                            src="/otter-logo.png"
                                            alt="ADHDev"
                                            className="w-10 h-10 object-contain opacity-70"
                                        />
                                    }
                                    title={t('mobileInbox.noMachinesConnected')}
                                    subtitle={t('mobileInbox.noMachinesSubtitle')}
                                />
                            ) : (
                                <MobileEmptyHero
                                    icon={
                                        <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-accent-primary/10 text-accent-primary-light">
                                            <IconChat size={20} />
                                        </div>
                                    }
                                    title={t('mobileInbox.noConversations')}
                                    subtitle={t('paneGroup.newSessionDescription')}
                                >
                                    {onOpenNewSession && (
                                        <button
                                            type="button"
                                            className="btn btn-secondary btn-sm inline-flex items-center gap-2 mt-4"
                                            onClick={onOpenNewSession}
                                            aria-label={t('paneGroup.newSession')}
                                            title={t('paneGroup.newSession')}
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                            <span>{t('paneGroup.newSession')}</span>
                                        </button>
                                    )}
                                </MobileEmptyHero>
                            )
                        ) : (
                            <div className="py-8 text-center text-sm font-medium text-text-muted">
                                {t('mobileInbox.allCaughtUp')}
                            </div>
                        )}
                    </section>
                )}

                {section === 'chats' && hiddenConversations.length > 0 && (() => {
                    const hiddenGeneratingCount = countGeneratingConversations(hiddenConversations)
                    return (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <InboxListSection className="mt-4 border-dashed bg-bg-secondary/20">
                            <div className="flex items-center justify-between gap-3 px-4 py-3 text-left">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">{t('mobileInbox.hiddenTabs')}</span>
                                        <MobileGeneratingIndicator
                                            count={hiddenGeneratingCount}
                                            label={t('mobileInbox.generatingCount', { count: hiddenGeneratingCount })}
                                        />
                                    </div>
                                    <div className="mt-0.5 text-[13px] text-text-muted">
                                        {t('mobileInbox.collapsedCount', { count: hiddenConversations.length })}
                                        {hiddenGeneratingCount > 0 ? t('mobileInbox.collapsedGeneratingSuffix', { count: hiddenGeneratingCount }) : ''}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="shrink-0 rounded-full border border-border-subtle bg-bg-primary/70 px-3 py-1.5 text-xs font-semibold text-accent-primary hover:border-border-default"
                                    onClick={onShowAllHidden}
                                >
                                    {t('mobileInbox.restoreAll')}
                                </button>
                            </div>
                        </InboxListSection>
                    </section>
                    )
                })()}
            </div>

            {section === 'chats' && onOpenNewSession && hasAnyConversation && (
                <button
                    className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom,0px)+64px+20px)] z-50 flex items-center justify-center w-14 h-14 rounded-full hover:scale-105 active:scale-95 transition-transform"
                    style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)', boxShadow: 'var(--shadow-md)' }}
                    onClick={onOpenNewSession}
                    aria-label={t('paneGroup.newSession')}
                    title={t('paneGroup.newSession')}
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
            )}

            {hideConfirmConversation && (
                <HideConversationConfirmDialog
                    conversation={hideConfirmConversation}
                    onCancel={() => setHideConfirmConversation(null)}
                    onConfirm={handleConfirmHideConversation}
                />
            )}

            <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
        </div>
    )
}
