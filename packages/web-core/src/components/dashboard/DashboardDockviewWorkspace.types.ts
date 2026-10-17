import type { Dispatch, SetStateAction } from 'react'
import type { ActiveConversation, CliConversationViewMode } from './types'
import type { DaemonData } from '../../types'
import type { DashboardActionShortcutId } from '../../hooks/useActionShortcuts'
import type { DashboardLayoutProfile } from '../../utils/dashboardLayoutStorage'
import type { LiveSessionInboxState } from './DashboardMobileChatShared'
import type { DashboardScrollToBottomIntent } from './dashboard-scroll-to-bottom'

/** Props of DashboardDockviewWorkspace (moved out of the component file to keep it under the file-size gate). */
export interface DashboardDockviewWorkspaceProps {
    visibleConversations: ActiveConversation[]
    clearedTabs: Record<string, number>
    ides: DaemonData[]
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    hasRegisteredMachines: boolean
    initialDataLoaded: boolean
    userName?: string
    toggleHiddenTab: (tabKey: string) => void
    actionShortcuts: Partial<Record<DashboardActionShortcutId, string>>
    registerActionHandlers?: (handlers: {
        setShortcutForActiveTab: () => void
        restoreHiddenTabToSavedLocation: (tabKey: string) => void
        activateConversationTab: (tabKey: string) => boolean
        resetAllPanelsToMain: () => void
        activatePreviousTabInGroup: () => void
        activateNextTabInGroup: () => void
        floatActiveTab: () => void
        popoutActiveTab: () => void
        dockActiveTab: () => void
        splitActiveTabRight: () => void
        splitActiveTabDown: () => void
        focusLeftPane: () => void
        focusRightPane: () => void
        focusUpPane: () => void
        focusDownPane: () => void
        moveActiveTabToLeftPane: () => void
        moveActiveTabToRightPane: () => void
        moveActiveTabToUpPane: () => void
        moveActiveTabToDownPane: () => void
    } | null) => void
    onActiveTabChange: (tabKey: string | null) => void
    onOpenNewSession?: () => void
    onRequestScrollToBottom?: (tabKey: string | null | undefined, intent: DashboardScrollToBottomIntent) => void
    requestedActiveTabKey?: string | null
    requestedRemoteIdeId?: string | null
    onRequestedActiveTabConsumed?: () => void
    scrollToBottomRequest?: { tabKey: string; nonce: number } | null
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    layoutProfile: DashboardLayoutProfile
    /** Lets a panel switch its CLI conversation to the terminal view (owner-attention notice). */
    setCliViewModeOverrides?: Dispatch<SetStateAction<Record<string, CliConversationViewMode>>>
}
