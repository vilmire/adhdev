import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { IconAssistant, IconBell, IconBellOff, IconSettings, IconChat, IconEyeOff, IconMesh, IconMoreHorizontal, IconX } from '../Icons'
import InstallCommand from '../InstallCommand'
import { countGeneratingConversations, formatRelativeTime, getConversationViewStates, type MobileConversationListItem, type MobileMachineCard } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import DashboardMobileBottomNav, { type DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationMetaText, getConversationStatusHint, getConversationTitle } from './conversation-presenters'
import { isMeshGraphAvailableFor } from './conversation-mesh-role'
import { MeshRoleIcon } from './ConversationMeshRoleMarker'
import { buildChatDebugBundleClipboardText, buildChatDebugBundleToastMessage, buildChatFrontendDebugSnapshot, copyChatDebugBundleTextToClipboard } from './chat-debug-bundle'
import { isMobileDebugBundleEnabled } from '../../utils/debug-flags'
import { eventManager } from '../../managers/EventManager'
import { getProviderArgs, getRouteTarget } from '../../hooks/dashboardCommandUtils'
import { unwrapCommandResult } from '../../hooks/useDashboardConversationCommands'
import GitStatusPill from '../git/GitStatusPill'
import LoadingSpinner from '../ui/LoadingSpinner'
import { isAssistantConversation } from './assistant-session'
import { getMobileInboxRowType, type MobileInboxRowType } from './dashboard-mobile-chat-mode-helpers'
import StartAssistantButton from './StartAssistantButton'
import type { StartAssistantState } from '../../hooks/useStartAssistant'
import DashboardMobileApprovalsLink from './DashboardMobileApprovalsLink'
import DashboardHiddenConversationsList from './DashboardHiddenConversationsList'
import {
    computeAnchoredMenuPlacement,
    resolveVisibleViewport,
    type AnchoredMenuPlacement,
} from './anchored-menu-position'

type MobileInboxDebugBundleCollector = (conversation: ActiveConversation) => void | Promise<void>

interface DashboardMobileChatInboxProps {
    section: DashboardMobileSection
    /** The personal assistant, pinned above every bucket (see `groupMobileInboxItems`). */
    assistantItems?: MobileConversationListItem[]
    /**
     * The dashboard's one "Start assistant" state (`useStartAssistant`, owned by
     * DashboardMainView for desktop header and mobile alike). Its entry is shown
     * pinned while `visible` — no assistant session yet and a machine can host one.
     */
    startAssistant?: StartAssistantState | null
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
    /** Restores one hidden conversation back into the visible list without switching screens. */
    onRestoreHiddenConversation?: (conversation: ActiveConversation) => void
    /** Restores one hidden conversation — the hide toast's Undo. */
    onShowHiddenConversation?: (conversation: ActiveConversation) => void
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
    /** Cloud-only: roster-derived pending provider decisions (includes hidden workers). */
    pendingProviderApprovalCount?: number
    onOpenApprovals?: () => void
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

/**
 * Row overflow ("…") for one inbox conversation: Mute, Hide and Stop in one
 * small menu instead of three always-visible icon buttons. Hide acts at once
 * (with an Undo toast from the parent); only Stop keeps its confirmation.
 *
 * The menu is portaled to <body> and positioned `fixed`: the rows and list
 * sections keep `overflow-hidden` for their rounded card visuals, so an inline
 * `absolute` popup was clipped on the last card of a bucket — Hide ended up
 * painted (and hit-tested) under the next group. Placement comes from
 * anchored-menu-position (flip up near the bottom nav, clamp into the visible
 * viewport, cap height with in-menu scrolling), mirroring the existing
 * ConversationActionsMenu / languageMenuPosition primitives.
 */
const useIsomorphicMenuLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect

/** CSS env(safe-area-inset-*) is only reachable through a computed style. */
function readSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
    const probe = document.createElement('div')
    probe.style.cssText =
        'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
        'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px)'
    document.body.appendChild(probe)
    const style = getComputedStyle(probe)
    const insets = {
        top: parseFloat(style.paddingTop) || 0,
        right: parseFloat(style.paddingRight) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
        left: parseFloat(style.paddingLeft) || 0,
    }
    probe.remove()
    return insets
}

function MobileInboxRowMenu({
    title,
    isMuted,
    onToggleMute,
    onHide,
    onStop,
}: {
    title: string
    isMuted?: boolean
    onToggleMute?: () => void
    onHide?: () => void
    onStop?: () => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [placement, setPlacement] = useState<AnchoredMenuPlacement | null>(null)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const openAnchorRef = useRef<{ top: number; left: number } | null>(null)
    const openVisualViewportRef = useRef<{ offsetTop: number; offsetLeft: number } | null>(null)
    const didFocusOnOpenRef = useRef(false)
    const menuId = useId()

    const close = useCallback((restoreFocus = false) => {
        setOpen(false)
        // Escape (and actions whose row survives) return focus to the trigger
        // without scrolling the list under the user.
        if (restoreFocus && triggerRef.current?.isConnected) {
            triggerRef.current.focus({ preventScroll: true })
        }
    }, [])

    const updatePlacement = useCallback(() => {
        if (typeof window === 'undefined') return null
        const triggerEl = triggerRef.current
        const menuEl = menuRef.current
        if (!triggerEl || !triggerEl.isConnected || !menuEl) return null
        const triggerRect = triggerEl.getBoundingClientRect()
        let viewport = resolveVisibleViewport({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            visualViewport: window.visualViewport ?? null,
            safeAreaInsets: readSafeAreaInsets(),
        })
        const menuSize = {
            width: menuEl.offsetWidth || 192,
            height: menuEl.offsetHeight || 96,
        }
        // When the trigger sits inside the inbox scroll region, the docked bottom
        // navigation bar is immediately below that scroller. Bound the bottom of
        // the available region to the scroller bottom (when the scroller can fit
        // the menu) so a card near the bottom nav flips up instead of painting
        // over the bottom nav.
        const scrollerEl = triggerEl.closest<HTMLElement>('.overflow-y-auto')
        if (scrollerEl) {
            const scrollerRect = scrollerEl.getBoundingClientRect()
            const currentBottom = viewport.top + viewport.height
            if (scrollerRect.height > 0 && scrollerRect.bottom > viewport.top && scrollerRect.bottom < currentBottom) {
                const candidateHeight = scrollerRect.bottom - viewport.top
                if (candidateHeight >= menuSize.height + 16) {
                    viewport = { ...viewport, height: candidateHeight }
                }
            }
        }
        const next = computeAnchoredMenuPlacement({
            trigger: triggerRect,
            menu: menuSize,
            viewport,
        })
        setPlacement(next)
        return next
    }, [])

    // Measure the just-opened menu while it is still hidden offscreen, then
    // place it against the visible viewport (visualViewport offsets and
    // safe-area insets combined exactly once in resolveVisibleViewport).
    useIsomorphicMenuLayoutEffect(() => {
        if (!open || typeof window === 'undefined') {
            setPlacement(null)
            openAnchorRef.current = null
            openVisualViewportRef.current = null
            didFocusOnOpenRef.current = false
            return
        }
        const triggerRect = triggerRef.current?.getBoundingClientRect()
        if (!triggerRect || !menuRef.current) return
        if (!openAnchorRef.current) {
            openAnchorRef.current = { top: triggerRect.top, left: triggerRect.left }
        }
        if (!openVisualViewportRef.current && window.visualViewport) {
            openVisualViewportRef.current = {
                offsetTop: window.visualViewport.offsetTop,
                offsetLeft: window.visualViewport.offsetLeft,
            }
        }
        updatePlacement()
    }, [open, updatePlacement])

    // Keyboard opening lands in the menu; preventScroll so focusing can never
    // scroll the list (which the scroll listener would read as dismissal).
    useIsomorphicMenuLayoutEffect(() => {
        if (!open || !placement || didFocusOnOpenRef.current) return
        didFocusOnOpenRef.current = true
        menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    }, [open, placement])

    useEffect(() => {
        if (!open || typeof window === 'undefined') return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close(true)
            } else if (event.key === 'Tab') {
                close(false)
            }
        }
        const onPointerDown = (event: Event) => {
            const target = event.target as Node | null
            if (!target) return
            // The menu lives in a body portal, so both the trigger AND the
            // portal contents count as "inside".
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
            close(false)
        }
        const onScroll = (event: Event) => {
            // The menu's own overflow scrolling must not close it.
            if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
            const triggerEl = triggerRef.current
            if (!triggerEl || !triggerEl.isConnected) {
                close(false)
                return
            }
            const rect = triggerEl.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0 && triggerEl.offsetWidth === 0 && triggerEl.offsetHeight === 0) {
                // In non-layout environments (e.g. jsdom), any external scroll closes the menu.
                close(false)
                return
            }
            const scrollerEl = triggerEl.closest<HTMLElement>('.overflow-y-auto')
            if (scrollerEl) {
                const scrollerRect = scrollerEl.getBoundingClientRect()
                if (scrollerRect.height > 0 && (rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom)) {
                    close(false)
                    return
                }
            }
            const anchor = openAnchorRef.current
            const drift = anchor ? Math.hypot(rect.top - anchor.top, rect.left - anchor.left) : 0
            if (drift <= 6) {
                updatePlacement()
                return
            }
            close(false)
        }
        const onViewportResize = () => close(false)
        const onVisualViewportScroll = () => {
            const vv = window.visualViewport
            const openVv = openVisualViewportRef.current
            if (vv && openVv && Math.hypot(vv.offsetTop - openVv.offsetTop, vv.offsetLeft - openVv.offsetLeft) <= 6) {
                updatePlacement()
                return
            }
            close(false)
        }
        window.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('mousedown', onPointerDown, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onViewportResize)
        window.visualViewport?.addEventListener('resize', onViewportResize)
        window.visualViewport?.addEventListener('scroll', onVisualViewportScroll)
        return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('mousedown', onPointerDown, true)
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onViewportResize)
            window.visualViewport?.removeEventListener('resize', onViewportResize)
            window.visualViewport?.removeEventListener('scroll', onVisualViewportScroll)
        }
    }, [close, open, updatePlacement])

    if (!onToggleMute && !onHide && !onStop) return null
    const itemClass = 'flex min-h-[44px] w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-3 py-2.5 text-left text-sm font-medium text-text-secondary hover:bg-bg-secondary hover:text-text-primary focus-visible:bg-bg-secondary focus-visible:text-text-primary focus-visible:outline-none'
    const run = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        action()
        if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true })
    }
    const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
        if (buttons.length === 0) return
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home'
            ? buttons[0]
            : event.key === 'End'
                ? buttons[buttons.length - 1]
                : buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
        next?.focus({ preventScroll: true })
    }
    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`mobile-inbox-row-menu-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    isMuted
                        ? 'bg-amber-500/15 text-amber-500'
                        : 'text-text-muted hover:text-text-primary hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]'
                }`}
                onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setOpen(value => !value)
                }}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                aria-label={t('mobileInbox.moreActionsFor', { title })}
                title={t('dashboard.header.moreActions')}
            >
                {isMuted ? <IconBellOff size={13} /> : <IconMoreHorizontal size={14} />}
            </button>
            {open && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-label={t('dashboard.header.moreActions')}
                    onKeyDown={onMenuKeyDown}
                    className="fixed z-[var(--z-popover)] flex w-48 flex-col overflow-y-auto rounded-xl border border-border-default bg-bg-card p-1 shadow-xl"
                    style={placement
                        ? { top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }
                        : { top: -9999, left: -9999, visibility: 'hidden' }}
                >
                    {onToggleMute && (
                        <button type="button" role="menuitem" className={`mobile-inbox-mute-button ${itemClass}`} onClick={run(onToggleMute)}>
                            {isMuted ? <IconBell size={15} /> : <IconBellOff size={15} />}
                            {isMuted ? t('conversation.unmuteThis') : t('conversation.muteThis')}
                        </button>
                    )}
                    {onHide && (
                        <button type="button" role="menuitem" className={`mobile-inbox-hide-button ${itemClass}`} onClick={run(onHide)}>
                            <IconEyeOff size={15} />
                            {t('mobileInbox.hide')}
                        </button>
                    )}
                    {onStop && (
                        <button type="button" role="menuitem" className={`mobile-inbox-stop-button ${itemClass} !text-status-error`} onClick={run(onStop)}>
                            <IconX size={15} />
                            {t('mobileInbox.stopSessionTitle')}
                        </button>
                    )}
                </div>,
                document.body,
            )}
        </>
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
    type: MobileInboxRowType
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
    const { isReconnecting, isConnecting, isErrored } = getConversationViewStates(item.conversation)
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
    const meshGraphAvailable = isMeshGraphAvailableFor(item.conversation)
    const isAssistant = isAssistantConversation(item.conversation)
    const warningTextClassName = 'text-[color:var(--status-warning)]'
    const handleConversationContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
        if (!onCollectChatDebugBundle) return
        // G8-12: a long-press (Android fires `contextmenu` for it) used to run
        // this unconditionally — sending a daemon command AND silently
        // overwriting the user's clipboard just from trying to select text or
        // open the native menu. Gate behind an explicit opt-in debug flag.
        if (!isMobileDebugBundleEnabled()) return
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
                        {isAssistant ? <IconAssistant size={18} /> : getAvatarText(title)}
                    </span>
                    {meshGraphAvailable && onOpenMeshGraph && (
                        <button
                            type="button"
                            className="mobile-inbox-mesh-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[color:var(--mesh-coordinator)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--mesh-coordinator)_10%,transparent)]"
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
                    <div className="flex items-center gap-1.5 pr-[92px]">
                        <MeshRoleIcon conversation={item.conversation} size={13} />
                        <span className={`text-[15px] leading-[22px] font-bold truncate tracking-tight ${titleClassName}`}>{title}</span>
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
                        ) : statusHint === 'Action needed' ? (
                            <>
                                <span className="mx-1 opacity-50">·</span>
                                <span className={warningTextClassName}>{t('mobileInbox.actionNeeded')}</span>
                            </>
                        ) : isErrored && (
                            <>
                                <span className="mx-1 opacity-50">·</span>
                                <span className="text-[color:var(--status-error)]">{t('mobileInbox.needsAttention')}</span>
                            </>
                        )}
                    </div>
                    <div className={`mt-0.5 truncate text-xxs ${previewClassName}`}>
                        {item.preview}
                    </div>
                </button>
                <div className="mobile-inbox-corner-actions absolute top-3 right-3 flex items-center gap-1.5">
                    {shouldShowTimestamp && (
                        <span className={`mr-0.5 text-2xs font-medium shrink-0 ${timestampClassName}`}>{formatRelativeTime(item.timestamp)}</span>
                    )}
                    {isTaskComplete && (
                        <span className="rounded-full border border-accent-primary/16 bg-accent-primary/10 px-2 py-0.5 text-3xs font-bold text-accent-primary">
                            {t('mobileInbox.done')}
                        </span>
                    )}
                    <MobileInboxRowMenu
                        title={title}
                        isMuted={isMuted}
                        onToggleMute={onToggleMute}
                        onHide={onRequestHideConversation}
                        onStop={onRequestStopCli}
                    />
                </div>
            </div>
        </div>
    )
}

/**
 * Pinned "Start assistant" entry — the mobile counterpart of the desktop
 * header's split button, which it reuses as is (same default target, same
 * CLI / machine / model picker, same `launch_assistant` call).
 */
function MobileStartAssistantCard({ startAssistant }: { startAssistant: StartAssistantState }) {
    const { t } = useTranslation()
    return (
        <div className="flex items-start gap-3.5 px-4 py-3.5" data-testid="mobile-inbox-start-assistant">
            <span className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 border border-accent-primary/22 bg-[color:color-mix(in_oklab,var(--bg-primary)_82%,var(--accent-primary)_18%)] text-accent-primary">
                <IconAssistant size={18} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[15px] leading-[22px] font-bold tracking-tight text-text-primary">{t('dashboard.assistant.label')}</span>
                    <span className="text-xs text-text-secondary">{t('dashboard.assistant.startHint')}</span>
                </div>
                <StartAssistantButton
                    className="self-start"
                    onStart={() => { void startAssistant.start() }}
                    onStartWith={(target) => { void startAssistant.start(target) }}
                    machines={startAssistant.machines}
                    defaultTarget={startAssistant.defaultTarget}
                    pending={startAssistant.pending}
                    error={startAssistant.error}
                />
                {startAssistant.error && (
                    <span className="text-xxs text-[color:var(--status-error)]" role="alert">
                        {t('dashboard.assistant.startFailed', { error: startAssistant.error })}
                    </span>
                )}
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
    assistantItems = [],
    startAssistant = null,
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
    onRestoreHiddenConversation,
    onShowHiddenConversation,
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
    pendingProviderApprovalCount = 0,
    onOpenApprovals,
}: DashboardMobileChatInboxProps) {
    const { t } = useTranslation()
    const [hiddenTabsExpanded, setHiddenTabsExpanded] = useState(false)
    const isDisconnected = wsStatus === 'disconnected' || wsStatus === 'reconnecting' || wsStatus === 'offline' || wsStatus === 'auth_failed'
    // Distinct from isDisconnected: the socket is up, the data just is not here yet.
    // Machine-section scope — gated on the daemon discovery snapshot.
    const isBootstrapping = !isDisconnected && !initialDataLoaded
    // Conversation-section scope — additionally waits for the P2P session snapshot,
    // which lands strictly after the daemon snapshot on cloud.
    const isConversationBootstrapping = !isDisconnected && !(conversationsLoaded ?? initialDataLoaded)
    const hasMachines = machineCards.length > 0
    const hasAnyConversation = assistantItems.length > 0 || attentionItems.length > 0 || unreadItems.length > 0 || workingItems.length > 0 || completedItems.length > 0
    const showStartAssistant = !!startAssistant?.visible && assistantItems.length === 0
    const pinnedNoticeCount = assistantItems.filter(item => item.requiresAction || item.unread).length
    const noticeCount = attentionItems.length + unreadItems.length + pinnedNoticeCount
    const inboxTitle = section === 'machines'
        ? t('mobileInbox.machines')
        : t('mobileInbox.chats')
    const headerPaddingClass = isStandalone
        ? 'px-5 pt-4 pb-4'
        : 'px-5 pt-[calc(16px+var(--mobile-flow-header-safe-top,0px))] pb-4'
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
            chatState: {
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
    // Hide is reversible, so it acts immediately and offers Undo instead of a
    // confirm dialog. Undo restores just that conversation (or all hidden ones
    // when the host has no single-conversation restore).
    const hideConversationWithUndo = useCallback((conversation: ActiveConversation) => {
        if (!onHideConversation) return
        onHideConversation(conversation)
        eventManager.showToast(t('mobileInbox.hiddenToast', { title: getConversationTitle(conversation) }), 'info', {
            duration: 6000,
            actions: [{
                label: t('mobileInbox.undo'),
                variant: 'primary',
                onClick: () => {
                    if (onRestoreHiddenConversation) onRestoreHiddenConversation(conversation)
                    else if (onShowHiddenConversation) onShowHiddenConversation(conversation)
                    else onShowAllHidden()
                },
            }],
        })
    }, [onHideConversation, onRestoreHiddenConversation, onShowAllHidden, onShowHiddenConversation, t])

    return (
        <div className="flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary">
            <div className={`z-10 shrink-0 bg-bg-primary ${headerPaddingClass}`}>
                <div className="flex items-center justify-between gap-3">
                    <div className="text-2xl font-black tracking-tight text-text-primary px-1">
                        {inboxTitle}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        {section === 'chats' && noticeCount > 0 && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-accent-primary/16 bg-accent-primary/10 text-accent-primary text-2xs font-bold shadow-[0_8px_20px_rgba(0,0,0,0.05)]">
                                <IconBell size={13} />
                                <span>{noticeCount}</span>
                            </div>
                        )}
                        <button onClick={onOpenSettings} className="w-9 h-9 -mr-1.5 inline-flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] transition-colors shrink-0">
                            <IconSettings size={18} />
                        </button>
                    </div>
                </div>
                {!isStandalone
                    && onOpenApprovals
                    && typeof pendingProviderApprovalCount === 'number'
                    && Number.isFinite(pendingProviderApprovalCount)
                    && pendingProviderApprovalCount > 0 ? (
                    <div className="mt-3 px-1">
                        <DashboardMobileApprovalsLink
                            pendingCount={pendingProviderApprovalCount}
                            onOpen={onOpenApprovals}
                        />
                    </div>
                ) : null}
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
                                                <span className="text-[15px] leading-[22px] font-bold text-text-primary truncate tracking-tight">{machine.label}</span>
                                                <span className="flex items-center gap-2 text-2xs font-medium text-text-muted shrink-0">
                                                    <MobileGeneratingIndicator
                                                        count={machine.generatingCount}
                                                        label={t('mobileInbox.generatingCount', { count: machine.generatingCount })}
                                                    />
                                                    {machine.statusLabel === 'Connecting' ? t('mobileInbox.machineStatusConnecting') : machine.unread > 0 ? <span className="text-accent-primary">{t('mobileInbox.newCount', { count: machine.unread })}</span> : machine.total > 0 ? t('mobileInbox.chatCount', { count: machine.total }) : t('mobileInbox.idle')}
                                                </span>
                                            </div>
                                            <div className="text-xs font-medium text-text-secondary truncate">{machine.subtitle}</div>
                                            {machine.total > 0 ? (
                                                <div className="text-xxs text-text-muted mt-0.5">
                                                    {t('mobileInbox.chatCount', { count: machine.total })}{machine.unread > 0 ? t('mobileInbox.unreadSuffix', { count: machine.unread }) : ''}{machine.generatingCount > 0 ? t('mobileInbox.collapsedGeneratingSuffix', { count: machine.generatingCount }) : ''}
                                                </div>
                                            ) : machine.generatingCount > 0 ? (
                                                <div className="text-xxs text-accent-primary mt-0.5 font-medium">
                                                    {t('mobileInbox.generatingCount', { count: machine.generatingCount })}
                                                </div>
                                            ) : machine.statusLabel === 'Connecting' ? (
                                                <div className="text-xxs text-text-muted mt-0.5 italic opacity-70">
                                                    {t('mobileInbox.machineStatusConnecting')}
                                                </div>
                                            ) : (
                                                <div className="text-xxs text-text-muted mt-0.5 italic opacity-70">
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

                {section === 'chats' && (assistantItems.length > 0 || showStartAssistant) && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch" data-testid="mobile-inbox-pinned">
                        <InboxSectionHeader title={t('mobileInbox.pinned')} className="mb-0" />
                        <InboxListSection>
                            {showStartAssistant && startAssistant ? (
                                <MobileStartAssistantCard startAssistant={startAssistant} />
                            ) : assistantItems.map((item, index) => (
                                <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                    <DashboardMobileChatItem
                                        item={item}
                                        type={getMobileInboxRowType(item)}
                                        getAvatarText={getAvatarText}
                                        onOpenConversation={onOpenConversation}
                                        onRequestHideConversation={onHideConversation ? () => hideConversationWithUndo(item.conversation) : undefined}
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
                                        onRequestHideConversation={onHideConversation ? () => hideConversationWithUndo(item.conversation) : undefined}
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
                                        onRequestHideConversation={onHideConversation ? () => hideConversationWithUndo(item.conversation) : undefined}
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
                                        onRequestHideConversation={onHideConversation ? () => hideConversationWithUndo(item.conversation) : undefined}
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
                                            onRequestHideConversation={onHideConversation ? () => hideConversationWithUndo(item.conversation) : undefined}
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
                        {!isDisconnected && machineCards.some(m => m.statusLabel === 'Connecting') && (
                            <div className="flex flex-col gap-1.5 px-2 pt-1" data-testid="mobile-inbox-connecting-machines">
                                {machineCards.filter(m => m.statusLabel === 'Connecting').map(machine => (
                                    <div key={machine.id} className="flex items-center justify-between gap-2 rounded-xl border border-border-subtle/60 bg-bg-secondary/25 px-3 py-2 text-xs text-text-muted">
                                        <span className="font-semibold text-text-secondary truncate">{machine.label}</span>
                                        <span className="shrink-0">{t('mobileInbox.machineStatusConnecting')}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                )}

                {section === 'chats' && hiddenConversations.length > 0 && (() => {
                    const hiddenGeneratingCount = countGeneratingConversations(hiddenConversations)
                    return (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch" data-testid="mobile-hidden-tabs-card">
                        <InboxListSection className="mt-4 border-dashed bg-bg-secondary/20">
                            <div className="flex items-center justify-between gap-3 px-4 py-3 text-left">
                                <button
                                    type="button"
                                    className="flex min-h-[44px] min-w-0 flex-1 items-center justify-between gap-2 text-left"
                                    aria-expanded={hiddenTabsExpanded}
                                    data-testid="mobile-hidden-tabs-toggle"
                                    onClick={() => setHiddenTabsExpanded(expanded => !expanded)}
                                >
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">{t('mobileInbox.hiddenTabs')}</span>
                                            <MobileGeneratingIndicator
                                                count={hiddenGeneratingCount}
                                                label={t('mobileInbox.generatingCount', { count: hiddenGeneratingCount })}
                                            />
                                        </div>
                                        <div className="mt-0.5 text-xxs text-text-muted">
                                            {t('mobileInbox.collapsedCount', { count: hiddenConversations.length })}
                                            {hiddenGeneratingCount > 0 ? t('mobileInbox.collapsedGeneratingSuffix', { count: hiddenGeneratingCount }) : ''}
                                        </div>
                                    </div>
                                    <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                        className={`shrink-0 text-text-muted transition-transform ${hiddenTabsExpanded ? 'rotate-180' : ''}`}
                                    >
                                        <polyline points="6 9 12 15 18 9" />
                                    </svg>
                                </button>
                                <button
                                    type="button"
                                    className="min-h-[36px] shrink-0 rounded-full border border-border-subtle bg-bg-primary/70 px-3 py-1.5 text-xs font-semibold text-accent-primary hover:border-border-default"
                                    data-testid="mobile-hidden-tabs-restore-all"
                                    onClick={onShowAllHidden}
                                >
                                    {t('mobileInbox.restoreAll')}
                                </button>
                            </div>
                            {hiddenTabsExpanded && (
                                <DashboardHiddenConversationsList
                                    conversations={hiddenConversations}
                                    variant="mobile"
                                    onOpenConversation={conversation => {
                                        (onRestoreHiddenConversation ?? onShowHiddenConversation)?.(conversation)
                                        onOpenConversation(conversation)
                                    }}
                                />
                            )}
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

            <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
        </div>
    )
}
