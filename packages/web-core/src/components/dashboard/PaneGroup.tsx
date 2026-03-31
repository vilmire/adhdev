/**
 * PaneGroup — One editor-group: its own tab bar + content area.
 *
 * Like VS Code editor groups: each group has independent tabs,
 * active tab selection, and content rendering.
 */
import { useRef, useCallback, type CSSProperties, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useTransport } from '../../context/TransportContext'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import { usePaneGroupDropZone } from '../../hooks/usePaneGroupDropZone'
import { usePaneGroupTabs } from '../../hooks/usePaneGroupTabs'
import { isCliConv, isAcpConv } from './types'
import type { ActiveConversation } from './types'
import type { DaemonData } from '../../types'
import type { CliTerminalHandle } from '../CliTerminal'
import PaneGroupContent from './PaneGroupContent'
import PaneGroupDropOverlay from './PaneGroupDropOverlay'
import PaneGroupEmptyState from './PaneGroupEmptyState'
import PaneGroupTabBar from './PaneGroupTabBar'

export interface PaneGroupProps {
    /** Conversations assigned to this group */
    conversations: ActiveConversation[];
    ides: DaemonData[];
    /** Shared state refs */
    messageReceivedAt: Record<string, number>;
    actionLogs: { ideId: string; text: string; timestamp: number }[];
    ptyBuffers: MutableRefObject<Map<string, string[]>>;
    screenshotMap: Record<string, string>;
    setScreenshotMap: (m: Record<string, string>) => void;
    /** Dashboard-level state setters */
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>;
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>;
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>;
    isStandalone: boolean;
    userName?: string;
    /** Group identity */
    groupIndex: number;
    onFocus: () => void;
    /** Split controls */
    isSplitMode: boolean;
    numGroups: number;
    onMoveTab?: (tabKey: string, direction: 'left' | 'right' | 'split-left' | 'split-right') => void;
    /** Drag-to-split: called when a tab is dropped into this group */
    onReceiveTab?: (tabKey: string) => void;
    /** CSS style override (for flex-basis resizing) */
    style?: CSSProperties;
    /** Standalone empty state */
    detectedIdes?: { type: string; name: string; running: boolean; id?: string }[];
    handleLaunchIde?: (ideType: string) => void;
    /** Notify parent when active tab changes */
    onActiveTabChange?: (tabKey: string | null) => void;
    /** Restore previously selected tab on mount */
    initialActiveTabId?: string | null;
    /** Restore tab order on mount */
    initialTabOrder?: string[];
    /** Notify parent when tab order changes */
    onTabOrderChange?: (order: string[]) => void;
    /** Hide tab from dashboard */
    onHideTab?: (tabKey: string) => void;
}

export default function PaneGroup({
    conversations, ides,
    messageReceivedAt, actionLogs, ptyBuffers,
    screenshotMap, setScreenshotMap,
    sendDaemonCommand, setLocalUserMessages, setActionLogs,
    isStandalone, userName,
    groupIndex, onFocus,
    isSplitMode, numGroups, onMoveTab, onReceiveTab,
    style: styleProp,
    detectedIdes, handleLaunchIde,
    onActiveTabChange,
    initialActiveTabId,
    initialTabOrder,
    onTabOrderChange,
    onHideTab,
}: PaneGroupProps) {
    const { sendCommand } = useTransport()
    const terminalRef = useRef<CliTerminalHandle>(null)
    const {
        activeTabId,
        activeConv,
        sortedConversations,
        previewOrderRef,
        draggingTabRef,
        selectTab,
        handleTabReorder,
        updatePreviewOrder,
        commitPreviewOrder,
        clearPreviewOrder,
        moveTabToEnd,
        setDraggingTabKey,
    } = usePaneGroupTabs({
        conversations,
        initialActiveTabId,
        initialTabOrder,
        onActiveTabChange,
        onTabOrderChange,
    })

    const cmds = useDashboardConversationCommands({
        sendDaemonCommand,
        activeConv,
        setLocalUserMessages,
        setActionLogs,
        isStandalone,
    })

    const {
        dragOver,
        dropAction,
        resetDragState,
        handleDragEnter,
        handleDragOver,
        handleDragLeave,
        handleDrop,
    } = usePaneGroupDropZone({
        conversations,
        numGroups,
        onMoveTab,
        onReceiveTab,
        onOwnTabDrop: moveTabToEnd,
        onClearPreviewOrder: clearPreviewOrder,
    })

    const isCli = activeConv && isCliConv(activeConv) && !isAcpConv(activeConv)

    const handleConversationActivated = useCallback((conv: ActiveConversation) => {
        if (conv.streamSource === 'agent-stream' && conv.agentType) {
            sendCommand(conv.ideId, 'focus_session', {
                agentType: conv.agentType,
                ...(conv.sessionId && { targetSessionId: conv.sessionId }),
            }).catch(() => {})
        }
        if (isCliConv(conv)) {
            setTimeout(() => terminalRef.current?.bumpResize?.(), 100)
        }
    }, [sendCommand])

    return (
        <div
            className="flex flex-col min-h-0 min-w-0 flex-1 overflow-hidden"
            onClick={onFocus}
            style={{
                ...styleProp,
                outline: dragOver ? '2px dashed var(--accent-primary)' : 'none',
                outlineOffset: '-2px',
                transition: 'outline 0.15s ease',
            }}
        >
            <PaneGroupTabBar
                conversations={sortedConversations}
                activeTabId={activeTabId}
                groupIndex={groupIndex}
                numGroups={numGroups}
                draggingTabRef={draggingTabRef}
                previewOrderRef={previewOrderRef}
                onFocus={onFocus}
                onSelectTab={selectTab}
                onConversationActivated={handleConversationActivated}
                onPreviewReorder={updatePreviewOrder}
                onReorderTab={handleTabReorder}
                onCommitPreviewOrder={commitPreviewOrder}
                onClearPreviewOrder={clearPreviewOrder}
                onDragStateReset={resetDragState}
                onDragTabKeyChange={setDraggingTabKey}
                onMoveTab={onMoveTab}
                onReceiveTab={onReceiveTab}
                onHideTab={onHideTab}
            />

            {/* ── Content Area ────────────────────── */}
            <div
                className="flex-1 min-h-0 flex flex-col overflow-hidden relative"
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {dragOver && <PaneGroupDropOverlay dropAction={dropAction} canSplit={!!(numGroups < 4 && onMoveTab)} />}
                {!activeConv ? (
                    <div className="flex-1 flex flex-col items-center justify-center">
                        <PaneGroupEmptyState
                            conversationsCount={conversations.length}
                            isSplitMode={isSplitMode}
                            isStandalone={isStandalone}
                            detectedIdes={detectedIdes}
                            handleLaunchIde={handleLaunchIde}
                        />
                    </div>
                ) : (
                    <PaneGroupContent
                        activeConv={activeConv}
                        isCli={!!isCli}
                        ides={ides}
                        screenshotMap={screenshotMap}
                        setScreenshotMap={setScreenshotMap}
                        ptyBuffers={ptyBuffers}
                        terminalRef={terminalRef}
                        handleModalButton={cmds.handleModalButton}
                        handleRelaunch={cmds.handleRelaunch}
                        agentInput={cmds.agentInput}
                        setAgentInput={cmds.setAgentInput}
                        handleSendChat={cmds.handleSendChat}
                        isSendingChat={cmds.isSendingChat}
                        handleFocusAgent={cmds.handleFocusAgent}
                        isFocusingAgent={cmds.isFocusingAgent}
                        messageReceivedAt={messageReceivedAt}
                        actionLogs={actionLogs}
                        userName={userName}
                    />
                )}
            </div>

        </div>
    )
}
