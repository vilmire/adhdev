/**
 * ConversationActionsMenu — the "…" overflow for one conversation.
 *
 * The pane toolbar keeps the primary actions visible — Stop, and for a mesh
 * coordinator its dedicated Mesh graph button (ConversationMeshGraphButton:
 * opened often, and the visible cue that this is a coordinator). Everything
 * else a user occasionally needs — history, remote control, mute, session
 * info, git status — lives here, in one place, on desktop and on the mobile
 * chat header alike. Items that do not apply to the conversation (no git,
 * CLI without a remote view) are simply not listed, so the menu never
 * offers a dead action.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { cn } from '../../lib/utils'
import { IconBell, IconBellOff, IconGitBranch, IconInfo, IconMonitor, IconMoreHorizontal, IconScroll } from '../Icons'
import SessionInfoDialog from './SessionInfoDialog'
import { resolveConversationTargetEntry } from './conversation-selectors'
import type { ActiveConversation } from './types'
import { isCliConv } from './types'
import { useConversationMute } from './useConversationMute'

export interface ConversationActionsMenuProps {
    conversation: ActiveConversation
    onOpenHistory?: (conversation: ActiveConversation) => void
    /** Remote control view — only offered for IDE (non CLI) conversations. */
    onOpenRemote?: (conversation: ActiveConversation) => void
    onOpenGit?: (daemonId: string, workspace: string) => void
    /** Button classes (the host toolbar's button style). */
    className?: string
    iconSize?: number
}

interface MenuItem {
    key: string
    label: string
    icon: ReactNode
    onSelect: () => void
    pressed?: boolean
}

const MENU_WIDTH = 220

// Re-exported for existing importers; the rule lives in conversation-mesh-role.
export { isMeshGraphAvailableFor } from './conversation-mesh-role'

export default function ConversationActionsMenu({
    conversation,
    onOpenHistory,
    onOpenRemote,
    onOpenGit,
    className,
    iconSize = 16,
}: ConversationActionsMenuProps) {
    const { t } = useTranslation('common')
    const { ides } = useBaseDaemons()
    const { sendCommand } = useTransport()
    const [open, setOpen] = useState(false)
    const [infoOpen, setInfoOpen] = useState(false)
    const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)

    const isCli = isCliConv(conversation)
    const targetEntry = useMemo(() => {
        const ideEntry = ides.find(ide => ide.id === conversation.routeId)
        return resolveConversationTargetEntry(conversation, ideEntry)
    }, [conversation, ides])
    const mute = useConversationMute({
        sessionId: conversation.sessionId,
        daemonId: conversation.daemonId,
        muted: !!targetEntry?.muted,
        sendDaemonCommand: sendCommand,
    })

    const items: MenuItem[] = []
    if (onOpenHistory) {
        items.push({ key: 'history', label: t('dashboard.header.chatHistory'), icon: <IconScroll size={15} />, onSelect: () => onOpenHistory(conversation) })
    }
    if (onOpenRemote && !isCli) {
        items.push({ key: 'remote', label: t('dashboard.header.remoteControl'), icon: <IconMonitor size={15} />, onSelect: () => onOpenRemote(conversation) })
    }
    if (onOpenGit && conversation.git && conversation.daemonId && conversation.workspacePath) {
        const daemonId = conversation.daemonId
        const workspace = conversation.workspacePath
        items.push({ key: 'git', label: t('dashboard.header.openGitStatus'), icon: <IconGitBranch size={15} />, onSelect: () => onOpenGit(daemonId, workspace) })
    }
    if (mute.available) {
        items.push({
            key: 'mute',
            label: mute.muted ? t('conversation.unmuteThis') : t('conversation.muteThis'),
            icon: mute.muted ? <IconBellOff size={15} /> : <IconBell size={15} />,
            onSelect: mute.toggle,
            pressed: mute.muted,
        })
    }
    if (conversation.sessionId && conversation.daemonId) {
        items.push({ key: 'info', label: t('sessionInfo.title'), icon: <IconInfo size={15} />, onSelect: () => setInfoOpen(true) })
    }

    const close = useCallback((focusButton = false) => {
        setOpen(false)
        if (focusButton) buttonRef.current?.focus()
    }, [])

    useLayoutEffect(() => {
        if (!open || typeof window === 'undefined') { setPosition(null); return }
        const rect = buttonRef.current?.getBoundingClientRect()
        if (!rect) return
        const left = Math.min(Math.max(8, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8)
        setPosition({ top: rect.bottom + 6, left })
    }, [open])

    useEffect(() => {
        if (!open || typeof window === 'undefined') return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            close(true)
        }
        const onPointerDown = (event: MouseEvent | PointerEvent) => {
            const target = event.target as Node | null
            if (!target) return
            if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
            close()
        }
        const onResize = () => close()
        window.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('mousedown', onPointerDown, true)
        window.addEventListener('resize', onResize)
        return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('mousedown', onPointerDown, true)
            window.removeEventListener('resize', onResize)
        }
    }, [close, open])

    useEffect(() => {
        if (!open) return
        menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }, [open, position])

    if (items.length === 0) return null

    const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
        next?.focus()
    }

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                data-testid="conversation-actions-menu"
                aria-label={t('dashboard.header.moreActions')}
                title={t('dashboard.header.moreActions')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
                className={className ?? 'btn btn-secondary btn-sm'}
                style={{ pointerEvents: 'auto' }}
            >
                <IconMoreHorizontal size={iconSize} />
            </button>
            {open && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={t('dashboard.header.moreActions')}
                    onKeyDown={onMenuKeyDown}
                    className="fixed z-[var(--z-popover)] flex flex-col rounded-xl border border-border-default bg-bg-card p-1 shadow-xl backdrop-blur-xl"
                    style={position ? { top: position.top, left: position.left, width: MENU_WIDTH } : { top: -9999, left: -9999, width: MENU_WIDTH, visibility: 'hidden' }}
                >
                    {items.map(item => (
                        <button
                            key={item.key}
                            type="button"
                            role="menuitem"
                            data-menu-item={item.key}
                            aria-pressed={item.pressed}
                            onClick={() => {
                                close()
                                item.onSelect()
                            }}
                            className={cn(
                                'flex w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-2.5 py-2 text-left text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary focus-visible:bg-bg-secondary focus-visible:text-text-primary focus-visible:outline-none',
                                item.pressed && 'text-amber-500',
                            )}
                        >
                            <span className="flex w-4 shrink-0 justify-center" aria-hidden>{item.icon}</span>
                            <span className="min-w-0 truncate">{item.label}</span>
                        </button>
                    ))}
                </div>,
                document.body,
            )}
            {infoOpen && conversation.sessionId && conversation.daemonId && (
                <SessionInfoDialog
                    sessionId={conversation.sessionId}
                    daemonId={conversation.daemonId}
                    conv={conversation}
                    onClose={() => setInfoOpen(false)}
                />
            )}
        </>
    )
}
