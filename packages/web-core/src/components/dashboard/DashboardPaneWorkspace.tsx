import React from 'react'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import PaneGroup from './PaneGroup'

interface DashboardPaneWorkspaceProps {
    containerRef: React.RefObject<HTMLDivElement>
    isSplitMode: boolean
    numGroups: number
    groupSizes: number[]
    groupedConvs: ActiveConversation[][]
    clearedTabs: Record<string, number>
    ides: DaemonData[]
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: React.Dispatch<React.SetStateAction<Record<string, any[]>>>
    setActionLogs: React.Dispatch<React.SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    userName?: string
    focusedGroup: number
    setFocusedGroup: React.Dispatch<React.SetStateAction<number>>
    moveTabToGroup: (tabKey: string, targetGroup: number) => void
    splitTabRelative: (tabKey: string, targetGroup: number, side: 'left' | 'right') => void
    closeGroup: (groupIdx: number) => void
    handleResizeStart: (dividerIdx: number, event: React.MouseEvent) => void
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[]
    handleLaunchIde?: (ideType: string) => void
    groupActiveTabIds: Record<number, string | null>
    setGroupActiveTabIds: React.Dispatch<React.SetStateAction<Record<number, string | null>>>
    groupTabOrders: Record<number, string[]>
    setGroupTabOrders: React.Dispatch<React.SetStateAction<Record<number, string[]>>>
    toggleHiddenTab: (tabKey: string) => void
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
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    userName,
    focusedGroup,
    setFocusedGroup,
    moveTabToGroup,
    splitTabRelative,
    closeGroup,
    handleResizeStart,
    detectedIdes,
    handleLaunchIde,
    groupActiveTabIds,
    setGroupActiveTabIds,
    groupTabOrders,
    setGroupTabOrders,
    toggleHiddenTab,
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
                            setLocalUserMessages={setLocalUserMessages}
                            setActionLogs={setActionLogs}
                            isStandalone={isStandalone}
                            userName={userName}
                            groupIndex={groupIndex}
                            isFocused={isSplitMode && focusedGroup === groupIndex}
                            onFocus={() => setFocusedGroup(groupIndex)}
                            isSplitMode={isSplitMode}
                            numGroups={numGroups}
                            onMoveTab={(tabKey, direction) => {
                                if (direction === 'left' && groupIndex > 0) moveTabToGroup(tabKey, groupIndex - 1)
                                else if (direction === 'right' && groupIndex < numGroups - 1) moveTabToGroup(tabKey, groupIndex + 1)
                                else if (direction === 'split-left' && numGroups < 4) splitTabRelative(tabKey, groupIndex, 'left')
                                else if (direction === 'split-right' && numGroups < 4) splitTabRelative(tabKey, groupIndex, 'right')
                            }}
                            onReceiveTab={tabKey => moveTabToGroup(tabKey, groupIndex)}
                            detectedIdes={groupIndex === 0 ? detectedIdes : undefined}
                            handleLaunchIde={groupIndex === 0 ? handleLaunchIde : undefined}
                            onActiveTabChange={tabKey => setGroupActiveTabIds(prev => {
                                if ((prev[groupIndex] ?? null) === (tabKey ?? null)) return prev
                                return { ...prev, [groupIndex]: tabKey }
                            })}
                            initialActiveTabId={groupActiveTabIds[groupIndex]}
                            initialTabOrder={groupTabOrders[groupIndex]}
                            onTabOrderChange={order => setGroupTabOrders(prev => {
                                const current = prev[groupIndex] || []
                                if (current.length === order.length && current.every((tabKey, index) => tabKey === order[index])) {
                                    return prev
                                }
                                return { ...prev, [groupIndex]: order }
                            })}
                            onHideTab={toggleHiddenTab}
                        />
                    </React.Fragment>
                )
            })}
        </div>
    )
}
