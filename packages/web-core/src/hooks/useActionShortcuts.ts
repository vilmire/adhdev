import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type DashboardActionShortcutId =
    | 'openShortcutHelp'
    | 'hideCurrentTab'
    | 'toggleHiddenTabs'
    | 'openHistoryForActiveTab'
    | 'openRemoteForActiveTab'
    | 'splitActiveTabRight'
    | 'splitActiveTabDown'
    | 'focusLeftPane'
    | 'focusRightPane'
    | 'focusUpPane'
    | 'focusDownPane'
    | 'moveActiveTabToLeftPane'
    | 'moveActiveTabToRightPane'
    | 'moveActiveTabToUpPane'
    | 'moveActiveTabToDownPane'
    | 'triggerPrimaryApprovalAction'
    | 'triggerSecondaryApprovalAction'
    | 'triggerTertiaryApprovalAction'
    | 'setActiveTabShortcut'
    | 'selectPreviousGroupTab'
    | 'selectNextGroupTab'
    | 'toggleCliView'

export interface DashboardActionShortcutDefinition {
    id: DashboardActionShortcutId
    label: string
    description: string
    defaultShortcut: string
}

const ACTION_SHORTCUTS_KEY = 'adhdev-dashboard-action-shortcuts'
const SEQUENCE_TIMEOUT_MS = 1200
const LEGACY_ACTION_SHORTCUTS: Partial<Record<DashboardActionShortcutId, string>> = {
    toggleHiddenTabs: 'G H',
    setActiveTabShortcut: 'G S',
    selectPreviousGroupTab: 'G K',
    selectNextGroupTab: 'G J',
    splitActiveTabRight: '⌘+⌥+\\',
    focusLeftPane: '⌘+⌥+←',
    focusRightPane: '⌘+⌥+→',
    moveActiveTabToLeftPane: '⌘+⌥+⇧+←',
    moveActiveTabToRightPane: '⌘+⌥+⇧+→',
    triggerPrimaryApprovalAction: '⌥+A',
    triggerSecondaryApprovalAction: '⌥+D',
    toggleCliView: 'T',
}

function isMacPlatform() {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
}

function getDefaultShortcut(actionId: DashboardActionShortcutId, isMac: boolean) {
    switch (actionId) {
        case 'openShortcutHelp':
            return '?'
        case 'hideCurrentTab':
            return isMac ? '⌥+X' : 'Ctrl+Alt+X'
        case 'toggleHiddenTabs':
            return isMac ? '⌥+H' : 'Ctrl+Alt+H'
        case 'openHistoryForActiveTab':
            return isMac ? '⌥+Y' : 'Ctrl+Alt+Y'
        case 'openRemoteForActiveTab':
            return isMac ? '⌥+R' : 'Ctrl+Alt+R'
        case 'splitActiveTabRight':
            return isMac ? '⌘+⌥+=' : 'Ctrl+Alt+\\'
        case 'splitActiveTabDown':
            return isMac ? '⌘+⌥+-' : 'Ctrl+Alt+-'
        case 'focusLeftPane':
            return isMac ? '⌘+⌥+[' : 'Ctrl+Alt+←'
        case 'focusRightPane':
            return isMac ? '⌘+⌥+]' : 'Ctrl+Alt+→'
        case 'focusUpPane':
            return isMac ? '⌘+⌥+U' : 'Ctrl+Alt+↑'
        case 'focusDownPane':
            return isMac ? '⌘+⌥+J' : 'Ctrl+Alt+↓'
        case 'moveActiveTabToLeftPane':
            return isMac ? '⌘+⌥+,' : 'Ctrl+Alt+Shift+←'
        case 'moveActiveTabToRightPane':
            return isMac ? '⌘+⌥+.' : 'Ctrl+Alt+Shift+→'
        case 'moveActiveTabToUpPane':
            return isMac ? '⌘+⌥+I' : 'Ctrl+Alt+Shift+↑'
        case 'moveActiveTabToDownPane':
            return isMac ? '⌘+⌥+K' : 'Ctrl+Alt+Shift+↓'
        case 'triggerPrimaryApprovalAction':
            return isMac ? '⌥+J' : 'Ctrl+Alt+J'
        case 'triggerSecondaryApprovalAction':
            return isMac ? '⌥+K' : 'Ctrl+Alt+K'
        case 'triggerTertiaryApprovalAction':
            return isMac ? '⌥+L' : 'Ctrl+Alt+L'
        case 'setActiveTabShortcut':
            return isMac ? '⌥+S' : 'Ctrl+Alt+S'
        case 'selectPreviousGroupTab':
            return isMac ? '⌥+[' : 'Ctrl+Alt+['
        case 'selectNextGroupTab':
            return isMac ? '⌥+]' : 'Ctrl+Alt+]'
        case 'toggleCliView':
            return isMac ? '⌥+T' : 'Ctrl+Alt+T'
    }
}

function getActionShortcutDefinitions(isMac: boolean): DashboardActionShortcutDefinition[] {
    return [
        {
            id: 'openShortcutHelp',
            label: 'Open shortcuts',
            description: 'Show the keyboard shortcuts panel.',
            defaultShortcut: getDefaultShortcut('openShortcutHelp', isMac),
        },
        {
            id: 'hideCurrentTab',
            label: 'Hide current tab',
            description: 'Hide the currently active tab into Hidden tabs.',
            defaultShortcut: getDefaultShortcut('hideCurrentTab', isMac),
        },
        {
            id: 'toggleHiddenTabs',
            label: 'Toggle hidden tabs',
            description: 'Open or close the hidden tabs popover.',
            defaultShortcut: getDefaultShortcut('toggleHiddenTabs', isMac),
        },
        {
            id: 'openHistoryForActiveTab',
            label: 'Open history',
            description: 'Open history for the active session.',
            defaultShortcut: getDefaultShortcut('openHistoryForActiveTab', isMac),
        },
        {
            id: 'openRemoteForActiveTab',
            label: 'Open remote',
            description: 'Open remote control for the active session when available.',
            defaultShortcut: getDefaultShortcut('openRemoteForActiveTab', isMac),
        },
        {
            id: 'splitActiveTabRight',
            label: 'Move active tab to new right pane',
            description: 'Create a pane to the right and move the active tab into it.',
            defaultShortcut: getDefaultShortcut('splitActiveTabRight', isMac),
        },
        {
            id: 'splitActiveTabDown',
            label: 'Move active tab to new lower pane',
            description: 'Create a pane below and move the active tab into it.',
            defaultShortcut: getDefaultShortcut('splitActiveTabDown', isMac),
        },
        {
            id: 'focusLeftPane',
            label: 'Focus left pane',
            description: 'Move focus to the pane on the left.',
            defaultShortcut: getDefaultShortcut('focusLeftPane', isMac),
        },
        {
            id: 'focusRightPane',
            label: 'Focus right pane',
            description: 'Move focus to the pane on the right.',
            defaultShortcut: getDefaultShortcut('focusRightPane', isMac),
        },
        {
            id: 'focusUpPane',
            label: 'Focus upper pane',
            description: 'Move focus to the pane above.',
            defaultShortcut: getDefaultShortcut('focusUpPane', isMac),
        },
        {
            id: 'focusDownPane',
            label: 'Focus lower pane',
            description: 'Move focus to the pane below.',
            defaultShortcut: getDefaultShortcut('focusDownPane', isMac),
        },
        {
            id: 'moveActiveTabToLeftPane',
            label: 'Move active tab left',
            description: 'Move the active tab into the pane on the left.',
            defaultShortcut: getDefaultShortcut('moveActiveTabToLeftPane', isMac),
        },
        {
            id: 'moveActiveTabToRightPane',
            label: 'Move active tab right',
            description: 'Move the active tab into the pane on the right.',
            defaultShortcut: getDefaultShortcut('moveActiveTabToRightPane', isMac),
        },
        {
            id: 'moveActiveTabToUpPane',
            label: 'Move active tab up',
            description: 'Move the active tab into the pane above.',
            defaultShortcut: getDefaultShortcut('moveActiveTabToUpPane', isMac),
        },
        {
            id: 'moveActiveTabToDownPane',
            label: 'Move active tab down',
            description: 'Move the active tab into the pane below.',
            defaultShortcut: getDefaultShortcut('moveActiveTabToDownPane', isMac),
        },
        {
            id: 'triggerPrimaryApprovalAction',
            label: 'Approval action 1',
            description: 'Press the first approval/action button for the active session.',
            defaultShortcut: getDefaultShortcut('triggerPrimaryApprovalAction', isMac),
        },
        {
            id: 'triggerSecondaryApprovalAction',
            label: 'Approval action 2',
            description: 'Press the second approval/action button for the active session.',
            defaultShortcut: getDefaultShortcut('triggerSecondaryApprovalAction', isMac),
        },
        {
            id: 'triggerTertiaryApprovalAction',
            label: 'Approval action 3',
            description: 'Press the third approval/action button for the active session.',
            defaultShortcut: getDefaultShortcut('triggerTertiaryApprovalAction', isMac),
        },
        {
            id: 'setActiveTabShortcut',
            label: 'Set active tab shortcut',
            description: 'Start recording a direct shortcut for the active tab.',
            defaultShortcut: getDefaultShortcut('setActiveTabShortcut', isMac),
        },
        {
            id: 'selectPreviousGroupTab',
            label: 'Previous tab in group',
            description: 'Move to the previous tab inside the active Dockview group.',
            defaultShortcut: getDefaultShortcut('selectPreviousGroupTab', isMac),
        },
        {
            id: 'selectNextGroupTab',
            label: 'Next tab in group',
            description: 'Move to the next tab inside the active Dockview group.',
            defaultShortcut: getDefaultShortcut('selectNextGroupTab', isMac),
        },
        {
            id: 'toggleCliView',
            label: 'Toggle CLI view',
            description: 'Toggle the active CLI session between chat and terminal view.',
            defaultShortcut: getDefaultShortcut('toggleCliView', isMac),
        },
    ]
}

function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    const tagName = target.tagName
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

function readActionShortcuts(isMac: boolean) {
    const defaults = Object.fromEntries(
        getActionShortcutDefinitions(isMac).map(action => [action.id, action.defaultShortcut]),
    ) as Record<DashboardActionShortcutId, string>

    try {
        const parsed = JSON.parse(localStorage.getItem(ACTION_SHORTCUTS_KEY) || '{}') as Partial<Record<DashboardActionShortcutId, string>>
        const merged = { ...defaults, ...parsed }
        for (const [actionId, legacyShortcut] of Object.entries(LEGACY_ACTION_SHORTCUTS) as [DashboardActionShortcutId, string][]) {
            if (merged[actionId] === legacyShortcut) {
                merged[actionId] = defaults[actionId]
            }
        }
        return merged
    } catch {
        return defaults
    }
}

function normalizeKey(key: string) {
    if (key === ' ') return 'Space'
    if (key === 'Escape') return 'Esc'
    if (key === 'ArrowLeft') return '←'
    if (key === 'ArrowRight') return '→'
    if (key === 'ArrowUp') return '↑'
    if (key === 'ArrowDown') return '↓'
    return key.length === 1 ? key.toUpperCase() : key
}

interface UseActionShortcutsOptions {
    enabled?: boolean
    onTrigger: (actionId: DashboardActionShortcutId) => void
}

export function useActionShortcuts({
    enabled = true,
    onTrigger,
}: UseActionShortcutsOptions) {
    const isMac = isMacPlatform()
    const [actionShortcuts, setActionShortcuts] = useState<Record<DashboardActionShortcutId, string>>(() => readActionShortcuts(isMac))
    const [shortcutListening, setShortcutListening] = useState<DashboardActionShortcutId | null>(null)
    const [shortcutListeningDraft, setShortcutListeningDraft] = useState<string[]>([])
    const sequenceRef = useRef<{ parts: string[]; timer: number | null }>({ parts: [], timer: null })

    const encodeShortcut = useCallback((event: KeyboardEvent): string | null => {
        const parts: string[] = []
        if (event.metaKey) parts.push(isMac ? '⌘' : 'Meta')
        if (event.ctrlKey) parts.push('Ctrl')
        if (event.altKey) parts.push(isMac ? '⌥' : 'Alt')
        if (event.shiftKey && event.key.length !== 1) parts.push(isMac ? '⇧' : 'Shift')
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null
        parts.push(normalizeKey(event.key))
        return parts.join('+')
    }, [isMac])

    const saveShortcuts = useCallback((next: Record<DashboardActionShortcutId, string>) => {
        setActionShortcuts(next)
        try {
            localStorage.setItem(ACTION_SHORTCUTS_KEY, JSON.stringify(next))
        } catch {
            /* noop */
        }
    }, [])

    useEffect(() => {
        const migrated = readActionShortcuts(isMac)
        const currentEntries = Object.entries(actionShortcuts)
        const migratedEntries = Object.entries(migrated)
        if (
            currentEntries.length === migratedEntries.length
            && currentEntries.every(([key, value]) => migrated[key as DashboardActionShortcutId] === value)
        ) {
            return
        }
        saveShortcuts(migrated)
    }, [actionShortcuts, isMac, saveShortcuts])

    const resetSequence = useCallback(() => {
        if (typeof window !== 'undefined' && sequenceRef.current.timer != null) {
            window.clearTimeout(sequenceRef.current.timer)
        }
        sequenceRef.current = { parts: [], timer: null }
    }, [])

    const armSequenceTimeout = useCallback(() => {
        if (typeof window === 'undefined') return
        if (sequenceRef.current.timer != null) {
            window.clearTimeout(sequenceRef.current.timer)
        }
        sequenceRef.current.timer = window.setTimeout(() => {
            sequenceRef.current = { parts: [], timer: null }
        }, SEQUENCE_TIMEOUT_MS)
    }, [])

    useEffect(() => {
        if (!shortcutListening) return

        const handler = (event: KeyboardEvent) => {
            event.preventDefault()
            event.stopPropagation()

            if (event.key === 'Escape') {
                setShortcutListening(null)
                setShortcutListeningDraft([])
                return
            }

            const combo = encodeShortcut(event)
            if (!combo) return

            const hasModifier = event.metaKey || event.ctrlKey || event.altKey
            const isPlainLetterOrDigit = !hasModifier && /^[A-Z0-9]$/.test(combo)

            if (shortcutListeningDraft.length === 0 && isPlainLetterOrDigit) {
                setShortcutListeningDraft([combo])
                return
            }

            const finalParts = [...shortcutListeningDraft, combo].slice(0, 2)
            const finalShortcut = finalParts.join(' ')
            const next = { ...actionShortcuts }

            for (const [actionId, shortcut] of Object.entries(next) as [DashboardActionShortcutId, string][]) {
                if (shortcut === finalShortcut) delete next[actionId]
            }

            next[shortcutListening] = finalShortcut
            saveShortcuts(next)
            setShortcutListening(null)
            setShortcutListeningDraft([])
        }

        window.addEventListener('keydown', handler, true)
        return () => window.removeEventListener('keydown', handler, true)
    }, [actionShortcuts, encodeShortcut, saveShortcuts, shortcutListening, shortcutListeningDraft])

    useEffect(() => {
        if (!enabled || shortcutListening) return

        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return

            const combo = encodeShortcut(event)
            if (!combo) return

            const hasModifier = event.metaKey || event.ctrlKey || event.altKey
            if (isEditableTarget(event.target) && !hasModifier) return

            const currentParts = sequenceRef.current.parts
            const nextParts = hasModifier
                ? [combo]
                : [...currentParts.slice(-1), combo].slice(-2)
            const fullCandidate = nextParts.join(' ')
            const singleCandidate = nextParts[nextParts.length - 1]
            const entries = (Object.entries(actionShortcuts) as [DashboardActionShortcutId, string][])
                .filter(([, shortcut]) => !!shortcut)

            const exactFullMatch = entries.find(([, shortcut]) => shortcut === fullCandidate)
            if (exactFullMatch) {
                event.preventDefault()
                resetSequence()
                onTrigger(exactFullMatch[0])
                return
            }

            const fullPrefixMatch = entries.some(([, shortcut]) => shortcut.startsWith(`${fullCandidate} `))
            if (fullPrefixMatch) {
                event.preventDefault()
                sequenceRef.current.parts = nextParts
                armSequenceTimeout()
                return
            }

            const exactSingleMatch = entries.find(([, shortcut]) => shortcut === singleCandidate)
            if (exactSingleMatch) {
                event.preventDefault()
                resetSequence()
                onTrigger(exactSingleMatch[0])
                return
            }

            const singlePrefixMatch = entries.some(([, shortcut]) => shortcut.startsWith(`${singleCandidate} `))
            if (singlePrefixMatch) {
                event.preventDefault()
                sequenceRef.current.parts = [singleCandidate]
                armSequenceTimeout()
                return
            }

            resetSequence()
        }

        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [actionShortcuts, armSequenceTimeout, enabled, encodeShortcut, onTrigger, resetSequence, shortcutListening])

    useEffect(() => {
        return () => resetSequence()
    }, [resetSequence])

    const actionDefinitions = useMemo(() => getActionShortcutDefinitions(isMac), [isMac])

    return {
        isMac,
        actionDefinitions,
        actionShortcuts,
        shortcutListening,
        shortcutListeningDraft,
        setShortcutListening,
        setShortcutListeningDraft,
        saveShortcuts,
    }
}
