import type React from 'react'
import { createPortal } from 'react-dom'
import { IconExternalWindow, IconArrowBack, IconKeyboard, IconX, IconEyeOff, IconFloat, IconDock } from '../Icons'
import type { DashboardDockviewContextMenuItem } from './dockviewContextMenuItems'

type ContextMenuActionId = Extract<DashboardDockviewContextMenuItem, { type: 'action' }>['id']

function preventContextMenuButtonFocus(event: React.MouseEvent<HTMLButtonElement>) {
    // Context-menu actions are overlays on the active chat. Let click still fire,
    // but do not move DOM focus into the portal/body: browser focus correction can
    // scroll the underlying chat pane back to its first focusable content.
    event.preventDefault()
}

function contextMenuIcon(itemId: ContextMenuActionId) {
    switch (itemId) {
        case 'dockInWindow':
        case 'dockBackToGrid':
            return <IconDock size={13} className="shrink-0 opacity-70" />
        case 'moveBackToMain':
            return <IconArrowBack size={13} className="shrink-0 opacity-70" />
        case 'floatAsPanel':
            return <IconFloat size={13} className="shrink-0 opacity-70" />
        case 'openInNewWindow':
            return <IconExternalWindow size={13} className="shrink-0 opacity-70" />
        case 'removeShortcut':
            return <IconX size={13} className="shrink-0 opacity-70" />
        case 'hideTab':
            return <IconEyeOff size={13} className="shrink-0 opacity-70" />
        default:
            return <IconKeyboard size={13} className="shrink-0 opacity-70" />
    }
}

/**
 * The Dockview tab context menu, portalled into the document the tab lives in (the
 * main window or a popout). Rendering only — the workspace decides what each item does.
 */
export default function DockviewTabContextMenu({
    x,
    y,
    sourceDocument,
    items,
    onSelect,
}: {
    x: number
    y: number
    sourceDocument: Document
    items: DashboardDockviewContextMenuItem[]
    onSelect: (itemId: ContextMenuActionId, event: React.MouseEvent<HTMLButtonElement>) => void
}) {
    return createPortal(
        <div
            data-dockview-tab-context-menu
            className="fixed z-[var(--z-popover)] min-w-[220px] rounded-xl border border-border-subtle bg-bg-primary shadow-2xl py-1"
            style={{ left: x, top: y }}
        >
            {items.map(item => {
                if (item.type === 'separator') {
                    return <div key={item.id} className="border-t border-border-subtle my-1" />
                }
                return (
                    <button
                        key={item.id}
                        type="button"
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors flex items-center gap-2 ${item.tone === 'muted' ? 'text-text-muted' : ''}`}
                        onMouseDown={preventContextMenuButtonFocus}
                        onClick={event => onSelect(item.id, event)}
                    >
                        {contextMenuIcon(item.id)}
                        <span className="flex-1 min-w-0">{item.label}</span>
                        {item.shortcut ? <span className="dashboard-dockview-menu-shortcut">{item.shortcut}</span> : null}
                    </button>
                )
            })}
        </div>,
        sourceDocument.body,
    )
}
