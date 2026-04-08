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
import { getPreferredConversationForIde } from './conversation-sort'
import { IconMonitor, IconScroll, IconSplitView } from '../Icons'
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
        preferredTabKey: activeConv.streamSource === 'native' ? undefined : activeConv.tabKey,
    })
    const preferredConversation = useMemo(
        () => activeIdeEntry ? getPreferredConversationForIde(conversations, activeIdeEntry.id) : null,
        [activeIdeEntry, conversations],
    )

    useEffect(() => {
        if (activeConv.streamSource === 'native') {
            setDialogChatTab(
                preferredConversation?.streamSource === 'agent-stream'
                    ? preferredConversation.tabKey
                    : 'native',
            )
            return
        }
        setDialogChatTab(activeConv.tabKey)
    }, [activeConv.streamSource, activeConv.tabKey, preferredConversation])

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
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-0 md:p-3 bg-[#030617]/[0.56] backdrop-blur-md" onClick={onClose}>
            <div
                className="w-full h-[100dvh] md:h-[calc(100vh-24px)] md:w-[calc(100vw-24px)] flex flex-col overflow-hidden md:rounded-[14px] md:border border-border-default bg-surface-primary shadow-[0_24px_80px_rgba(2,6,23,0.32)]"
                role="dialog"
                aria-modal="true"
                onClick={stopPropagation}
            >
                <div className="sticky top-0 z-20 flex flex-col gap-3 md:flex-row md:items-center md:justify-between px-4 pt-[calc(14px+env(safe-area-inset-top,0px))] pb-3 border-b border-border-subtle bg-bg-primary/96 backdrop-blur-md shrink-0 overflow-visible">
                    <div className="flex items-center justify-between gap-3 min-w-0 w-full md:w-auto md:flex-1">
                        <div className="min-w-0 flex-1 flex flex-col justify-center">
                            <div className="flex items-center gap-2.5 min-w-0 font-extrabold text-[18px] md:text-xl tracking-tight text-text-primary">
                                <span className="w-7 h-7 flex items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary shrink-0">
                                    <IconMonitor size={16} />
                                </span>
                                <span className="truncate">{effectiveConv.displayPrimary || effectiveConv.agentName || 'Remote'}</span>
                            </div>
                        </div>
                        <button className="btn btn-primary btn-sm h-8 px-4 rounded-lg font-bold md:hidden shrink-0" onClick={onClose}>
                            Close
                        </button>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 w-full md:w-auto justify-between md:justify-end">
                        <div className="flex items-center gap-2 mr-auto md:mr-0">
                            {(['split', 'remote'] as const).map(mode => {
                                const isActive = viewMode === mode
                                return (
                                    <button
                                        key={mode}
                                        className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                                            isActive 
                                                ? 'bg-accent-primary/12 border border-accent-primary/35 text-accent-primary shadow-glow'
                                                : 'bg-bg-secondary border border-border-subtle text-text-secondary hover:bg-bg-glass hover:text-text-primary'
                                        }`}
                                        onClick={() => setViewMode(mode)}
                                        title={mode === 'split' ? 'Split view' : 'Remote only'}
                                    >
                                        {mode === 'split' ? <IconSplitView size={15} /> : <IconMonitor size={15} />}
                                    </button>
                                )
                            })}
                        </div>
                        <div className="hidden md:block w-[1px] h-5 bg-border-subtle mx-1" />
                        <button
                            className="btn btn-secondary btn-sm h-8 px-2.5 md:px-3 rounded-lg"
                            onClick={() => onOpenHistory(effectiveConv)}
                            title="Chat History"
                        >
                            <IconScroll size={14} className="md:mr-1.5" />
                            <span className="hidden md:inline">History</span>
                        </button>
                        <button className="hidden md:inline-flex btn btn-primary btn-sm h-8 px-4 rounded-lg font-bold" onClick={onClose}>
                            Close
                        </button>
                    </div>
                </div>

                <div className={`flex-1 min-h-0 grid bg-bg-primary ${
                    viewMode === 'split' ? 'grid-cols-1 grid-rows-[1fr_minmax(320px,42vh)] md:grid-cols-[minmax(360px,0.92fr)_minmax(420px,1.08fr)] md:grid-rows-1' :
                    'grid-cols-1 grid-rows-1'
                }`}>
                    {viewMode !== 'remote' && (
                        <div className={`flex flex-col min-w-0 min-h-0 bg-bg-primary ${
                            viewMode === 'split' ? 'order-2 md:order-1 border-b md:border-b-0 md:border-r border-border-subtle' : ''
                        }`}>
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
                                showMetaChips={false}
                                handleSendChat={cmds.handleSendChat}
                                isSendingChat={cmds.isSendingChat}
                                handleFocusAgent={cmds.handleFocusAgent}
                                isFocusingAgent={cmds.isFocusingAgent}
                                actionLogs={visibleActionLogs}
                                userName={userName}
                            />
                        </div>
                    )}

                    <div className={`flex flex-col min-w-0 min-h-0 bg-black ${viewMode === 'split' ? 'order-1 md:order-2' : ''}`}>
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
