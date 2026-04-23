import React from 'react'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import type { LiveSessionInboxState } from './DashboardMobileChatShared'
import PaneGroup from './PaneGroup'

interface DashboardPaneWorkspaceProps {
    containerRef: React.RefObject<HTMLDivElement>
    isSplitMode: boolean
    numGroups: number
    groupSizes: number[]
    groupedConvs: ActiveConversation[][]
    clearedTabs: Record<string, number>
    ides: DaemonData[]
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setActionLogs: React.Dispatch<React.SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    hasRegisteredMachines: boolean
    userName?: string
    focusedGroup: number
    focusGroup: (groupIndex: number) => void
    moveTabToGroup: (tabKey: string, targetGroup: number) => void
    splitTabRelative: (tabKey: string, targetGroup: number, side: 'left' | 'right') => void
    closeGroup: (groupIdx: number) => void
    handleResizeStart: (dividerIdx: number, event: React.MouseEvent) => void
    groupActiveTabIds: Record<number, string | null>
    setGroupActiveTab: (groupIndex: number, tabKey: string | null) => void
    groupTabOrders: Record<number, string[]>
    setGroupTabOrder: (groupIndex: number, order: string[]) => void
    toggleHiddenTab: (tabKey: string) => void
    onOpenNewSession?: () => void
    allowTabShortcuts?: boolean
    liveSessionInboxState: Map<string, LiveSessionInboxState>
}

export default function DashboardPaneWorkspace({
    containerRef,
    isSplitMode,
    numGroups,
    groupSizes,
    groupedConvs,
    clearedTabs,
    ides,
    actionLogs,
    sendDaemonCommand,
    setActionLogs,
    isStandalone,
    hasRegisteredMachines,
    userName,
    focusedGroup,
    focusGroup,
    moveTabToGroup,
    splitTabRelative,
    closeGroup,
    handleResizeStart,
    groupActiveTabIds,
    setGroupActiveTab,
    groupTabOrders,
    setGroupTabOrder,
    toggleHiddenTab,
    onOpenNewSession,
    allowTabShortcuts = true,
    liveSessionInboxState,
}: DashboardPaneWorkspaceProps) {
    return (
        <div ref={containerRef} className={`flex-1 min-h-0 flex ${isSplitMode ? 'flex-row' : 'flex-col'} overflow-hidden`}>
            {groupedConvs.map((convs, groupIndex) => {
                const flexBasis = isSplitMode && groupSizes.length === numGroups
                    ? `${groupSizes[groupIndex]}%`
                    : undefined

                return (
                    <React.Fragment key={groupIndex}>
                        {isSplitMode && groupIndex > 0 && (
                            <div
                                className="shrink-0 w-1 cursor-col-resize hover:bg-accent/30 transition-colors relative group"
                                style={{ background: 'var(--border-subtle)' }}
                                onMouseDown={event => handleResizeStart(groupIndex - 1, event)}
                                onDoubleClick={() => closeGroup(groupIndex)}
                                title="Drag to resize · Double-click to merge"
                            >
                                <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-accent/10" />
                            </div>
                        )}

                        <PaneGroup
                            style={isSplitMode ? {
                                flexBasis: flexBasis ?? `${100 / numGroups}%`,
                                flexGrow: flexBasis ? 0 : 1,
                                flexShrink: flexBasis ? 0 : 1,
                            } : undefined}
                            conversations={convs}
                            clearedTabs={clearedTabs}
                            ides={ides}
                            actionLogs={actionLogs}
                            sendDaemonCommand={sendDaemonCommand}
                            setActionLogs={setActionLogs}
                            isStandalone={isStandalone}
                            hasRegisteredMachines={hasRegisteredMachines}
                            userName={userName}
                            groupIndex={groupIndex}
                            isFocused={isSplitMode && focusedGroup === groupIndex}
                            onFocus={() => focusGroup(groupIndex)}
                            isSplitMode={isSplitMode}
                            numGroups={numGroups}
                            onMoveTab={(tabKey, direction) => {
                                if (direction === 'left' && groupIndex > 0) moveTabToGroup(tabKey, groupIndex - 1)
                                else if (direction === 'right' && groupIndex < numGroups - 1) moveTabToGroup(tabKey, groupIndex + 1)
                                else if (direction === 'split-left' && numGroups < 4) splitTabRelative(tabKey, groupIndex, 'left')
                                else if (direction === 'split-right' && numGroups < 4) splitTabRelative(tabKey, groupIndex, 'right')
                            }}
                            onReceiveTab={tabKey => moveTabToGroup(tabKey, groupIndex)}
                            onActiveTabChange={tabKey => setGroupActiveTab(groupIndex, tabKey)}
                            initialActiveTabId={groupActiveTabIds[groupIndex]}
                            initialTabOrder={groupTabOrders[groupIndex]}
                            onTabOrderChange={order => setGroupTabOrder(groupIndex, order)}
                            onHideTab={toggleHiddenTab}
                            onOpenNewSession={onOpenNewSession}
                            allowTabShortcuts={allowTabShortcuts}
                            liveSessionInboxState={liveSessionInboxState}
                        />
                    </React.Fragment>
                )
            })}
        </div>
    )
}
