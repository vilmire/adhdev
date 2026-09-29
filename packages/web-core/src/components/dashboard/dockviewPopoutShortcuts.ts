/**
 * Keyboard shortcuts inside a Dockview popout window. A popout is its own browser
 * window, so the dashboard's document-level shortcut listeners never see its key
 * events: this attaches the tab-select shortcuts and the pane/tab action shortcuts
 * (including two-part sequences) directly to the popout.
 */
import { readTabShortcuts } from '../../hooks/useTabShortcuts'
import { isEditableTarget, readActionShortcuts, type DashboardActionShortcutId } from '../../hooks/useActionShortcuts'

export interface PopoutShortcutHandlers {
    encodeShortcut: (event: KeyboardEvent) => string | null
    isMac: boolean
    isShortcutListening: () => boolean
    isVisibleTab: (tabKey: string) => boolean
    selectTabByShortcut: (tabKey: string) => void
    triggerAction: (actionId: DashboardActionShortcutId) => void
}

/** Attach the shortcut listeners to one popout window; returns their teardown. */
export function attachPopoutShortcutKeys(popup: Window, handlers: PopoutShortcutHandlers): () => void {
    const { encodeShortcut, isMac, isShortcutListening, isVisibleTab, selectTabByShortcut, triggerAction } = handlers
    let sequenceParts: string[] = []
    let sequenceTimer: number | null = null

    const resetSequence = () => {
        if (sequenceTimer != null) popup.clearTimeout(sequenceTimer)
        sequenceTimer = null
        sequenceParts = []
    }

    const armSequenceTimeout = () => {
        if (sequenceTimer != null) popup.clearTimeout(sequenceTimer)
        sequenceTimer = popup.setTimeout(() => {
            sequenceTimer = null
            sequenceParts = []
        }, 1200)
    }

    const handleTabShortcut = (event: KeyboardEvent) => {
        if (!event.ctrlKey && !event.metaKey && !event.altKey) return
        const combo = encodeShortcut(event)
        if (!combo) return

        const tabShortcuts = readTabShortcuts()
        for (const [tabKey, shortcut] of Object.entries(tabShortcuts)) {
            if (!isVisibleTab(tabKey)) continue
            if (shortcut !== combo) continue
            event.preventDefault()
            selectTabByShortcut(tabKey)
            return
        }
    }

    const handleActionShortcut = (event: KeyboardEvent) => {
        if (event.defaultPrevented || isShortcutListening()) return

        const combo = encodeShortcut(event)
        if (!combo) return

        const hasModifier = event.metaKey || event.ctrlKey || event.altKey
        if (isEditableTarget(event.target)) return

        const actionShortcuts = readActionShortcuts(isMac)
        const supportedEntries = (Object.entries(actionShortcuts) as [DashboardActionShortcutId, string][])
            .filter(([actionId, shortcut]) => !!shortcut && (
                actionId === 'splitActiveTabRight'
                || actionId === 'splitActiveTabDown'
                || actionId === 'floatActiveTab'
                || actionId === 'popoutActiveTab'
                || actionId === 'dockActiveTab'
                || actionId === 'focusLeftPane'
                || actionId === 'focusRightPane'
                || actionId === 'focusUpPane'
                || actionId === 'focusDownPane'
                || actionId === 'moveActiveTabToLeftPane'
                || actionId === 'moveActiveTabToRightPane'
                || actionId === 'moveActiveTabToUpPane'
                || actionId === 'moveActiveTabToDownPane'
                || actionId === 'selectPreviousGroupTab'
                || actionId === 'selectNextGroupTab'
                || actionId === 'setActiveTabShortcut'
                || actionId === 'hideCurrentTab'
            ))

        const nextParts = hasModifier
            ? [combo]
            : [...sequenceParts.slice(-1), combo].slice(-2)
        const fullCandidate = nextParts.join(' ')
        const singleCandidate = nextParts[nextParts.length - 1]

        const exactFullMatch = supportedEntries.find(([, shortcut]) => shortcut === fullCandidate)
        if (exactFullMatch) {
            event.preventDefault()
            resetSequence()
            triggerAction(exactFullMatch[0])
            return
        }

        const fullPrefixMatch = supportedEntries.some(([, shortcut]) => shortcut.startsWith(`${fullCandidate} `))
        if (fullPrefixMatch) {
            event.preventDefault()
            sequenceParts = nextParts
            armSequenceTimeout()
            return
        }

        const exactSingleMatch = supportedEntries.find(([, shortcut]) => shortcut === singleCandidate)
        if (exactSingleMatch) {
            event.preventDefault()
            resetSequence()
            triggerAction(exactSingleMatch[0])
            return
        }

        const singlePrefixMatch = supportedEntries.some(([, shortcut]) => shortcut.startsWith(`${singleCandidate} `))
        if (singlePrefixMatch) {
            event.preventDefault()
            sequenceParts = [singleCandidate]
            armSequenceTimeout()
            return
        }

        resetSequence()
    }

    popup.addEventListener('keydown', handleTabShortcut)
    popup.addEventListener('keydown', handleActionShortcut)

    return () => {
        resetSequence()
        popup.removeEventListener('keydown', handleTabShortcut)
        popup.removeEventListener('keydown', handleActionShortcut)
    }
}
