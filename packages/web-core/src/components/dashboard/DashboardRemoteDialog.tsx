import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import ApprovalBanner from './ApprovalBanner'
import ChatPane from './ChatPane'
import RemoteView from '../RemoteView'
import IDEChatTabs from '../ide/IDEChatTabs'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import { useIdeRemoteStream } from '../../hooks/useIdeRemoteStream'
import { useIdeConversations } from '../../hooks/useIdeConversations'
import { IconMonitor, IconScroll } from '../Icons'
import { formatIdeType } from '../../utils/daemon-utils'

type RemoteDialogViewMode = 'split' | 'remote'

interface DashboardRemoteDialogProps {
    activeConv: ActiveConversation
    ideEntry?: DaemonData
    ides: DaemonData[]
    connectionStates: Record<string, string>
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    localUserMessages: Record<string, any[]>
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    userName?: string
    onOpenHistory: (conversation?: ActiveConversation) => void
    onConversationChange?: (conversation: ActiveConversation) => void
    onClose: () => void
}

export default function DashboardRemoteDialog({
    activeConv,
    ideEntry,
    ides,
    connectionStates,
    actionLogs,
    localUserMessages,
    sendDaemonCommand,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    userName,
    onOpenHistory,
    onConversationChange,
    onClose,
}: DashboardRemoteDialogProps) {
    const [viewMode, setViewMode] = useState<RemoteDialogViewMode>('split')
    const [dialogChatTab, setDialogChatTab] = useState<string>(() => (
        activeConv.streamSource === 'native' ? 'native' : activeConv.tabKey
    ))
    const activeIdeEntry = useMemo(
        () => ideEntry || ides.find(ide => ide.id === activeConv.ideId),
        [activeConv.ideId, ideEntry, ides],
    )
    const ideDisplayName = useMemo(
        () => formatIdeType(activeIdeEntry?.type || ''),
        [activeIdeEntry?.type],
    )
    const {
        conversations,
        extensionTabs,
        hasExtensions,
    } = useIdeConversations({
        ideData: activeIdeEntry,
        allIdes: ides,
        connectionStates,
        localUserMessages,
        ideName: ideDisplayName || 'IDE',
        preferredTabKey: activeConv.streamSource === 'native' ? 'native' : activeConv.tabKey,
    })

    useEffect(() => {
        setDialogChatTab(activeConv.streamSource === 'native' ? 'native' : activeConv.tabKey)
    }, [activeConv.streamSource, activeConv.tabKey])

    const effectiveConv = useMemo(() => {
        if (dialogChatTab === 'native') {
            return conversations.find(conversation => conversation.streamSource === 'native') || activeConv
        }
        return conversations.find(conversation => conversation.tabKey === dialogChatTab)
            || activeConv
    }, [activeConv, conversations, dialogChatTab])

    const daemonRouteId = effectiveConv.daemonId || effectiveConv.ideId?.split(':')[0] || effectiveConv.ideId
    const cmds = useDashboardConversationCommands({
        sendDaemonCommand,
        activeConv: effectiveConv,
        setLocalUserMessages,
        setActionLogs,
        isStandalone,
    })
    const { connScreenshot, screenshotUsage, handleRemoteAction } = useIdeRemoteStream({
        doId: daemonRouteId,
        ideId: effectiveConv.ideId,
        ideType: effectiveConv.ideType,
        connState: effectiveConv.connectionState || 'new',
        viewMode,
        instanceId: activeIdeEntry?.instanceId,
    })
    const visibleActionLogs = useMemo(
        () => actionLogs.filter(log => log.ideId === effectiveConv.tabKey),
        [actionLogs, effectiveConv.tabKey],
    )

    useEffect(() => {
        onConversationChange?.(effectiveConv)
    }, [effectiveConv, onConversationChange])

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const stopPropagation = useCallback((event: ReactMouseEvent) => {
        event.stopPropagation()
    }, [])

    return (
        <div className="dashboard-remote-dialog-overlay" onClick={onClose}>
            <div
                className="dashboard-remote-dialog is-fullscreen"
                role="dialog"
                aria-modal="true"
                onClick={stopPropagation}
            >
                <div className="dashboard-remote-dialog-header">
                    <div className="dashboard-remote-dialog-title-block">
                        <div className="dashboard-remote-dialog-title">
                            <IconMonitor size={16} />
                            <span>{effectiveConv.displayPrimary || effectiveConv.agentName || 'Remote'}</span>
                        </div>
                        <div className="dashboard-remote-dialog-subtitle">
                            <span>{effectiveConv.displaySecondary}</span>
                            {effectiveConv.machineName && (
                                <>
                                    <span className="dashboard-remote-dialog-dot">·</span>
                                    <span>{effectiveConv.machineName}</span>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="dashboard-remote-dialog-actions">
                        {(['split', 'remote'] as const).map(mode => (
                            <button
                                key={mode}
                                className={`btn btn-secondary btn-sm dashboard-remote-dialog-mode${viewMode === mode ? ' is-active' : ''}`}
                                onClick={() => setViewMode(mode)}
                                title={mode === 'split' ? 'Split view' : 'Remote only'}
                            >
                                {mode === 'split' ? '⊞' : <IconMonitor size={14} />}
                            </button>
                        ))}
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => onOpenHistory(effectiveConv)}
                            title="Chat History"
                        >
                            <IconScroll size={14} />
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={onClose}>
                            Close
                        </button>
                    </div>
                </div>

                <div className={`dashboard-remote-dialog-body view-${viewMode}`}>
                    {viewMode !== 'remote' && (
                        <div className="dashboard-remote-dialog-chat">
                            <IDEChatTabs
                                hasExtensions={hasExtensions}
                                ideName={ideDisplayName || 'IDE'}
                                activeChatTab={dialogChatTab}
                                extensionTabs={extensionTabs}
                                onSelectTab={setDialogChatTab}
                            />
                            <ApprovalBanner activeConv={effectiveConv} onModalButton={cmds.handleModalButton} />
                            <ChatPane
                                activeConv={effectiveConv}
                                ideEntry={activeIdeEntry}
                                handleSendChat={cmds.handleSendChat}
                                isSendingChat={cmds.isSendingChat}
                                handleFocusAgent={cmds.handleFocusAgent}
                                isFocusingAgent={cmds.isFocusingAgent}
                                actionLogs={visibleActionLogs}
                                userName={userName}
                            />
                        </div>
                    )}

                    <div className="dashboard-remote-dialog-remote">
                        <RemoteView
                            addLog={() => {}}
                            connState={(effectiveConv.connectionState || 'new') as any}
                            connScreenshot={connScreenshot}
                            screenshotUsage={screenshotUsage}
                            transportType={effectiveConv.transport}
                            onAction={handleRemoteAction}
                        />
                    </div>
                </div>
            </div>
        </div>
    )
}
