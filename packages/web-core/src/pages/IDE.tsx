/**
 * IDE Detail Page — v2 (complete rewrite)
 * 
 * 2-panel layout: Chat (left) + Remote Desktop (right)
 * All connection state from DaemonContext — no local duplication.
 */
import { useState, useMemo } from 'react'
import RemoteView from '../components/RemoteView'
import ChatPane from '../components/dashboard/ChatPane'
import HistoryModal from '../components/dashboard/HistoryModal'
import ApprovalBanner from '../components/dashboard/ApprovalBanner'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import IDEChatTabs from '../components/ide/IDEChatTabs'
import IDEHeader from '../components/ide/IDEHeader'
import IDEToastStack from '../components/ide/IDEToastStack'
import { getMachineDisplayName } from '../utils/daemon-utils'
import { parseDaemonRouteId } from '../utils/route-id'
import { useIdeCommands } from '../hooks/useIdeCommands'
import { useIdeConversations } from '../hooks/useIdeConversations'
import { useIdeRemoteStream } from '../hooks/useIdeRemoteStream'
import { useIdeToasts } from '../hooks/useIdeToasts'
import { useDashboardConversationCommands } from '../hooks/useDashboardConversationCommands'
import { useDashboardConversationMeta } from '../hooks/useDashboardConversationMeta'
import { useDashboardEventManager } from '../hooks/useDashboardEventManager'
type ConnectionState = string
import './IDE.css'

interface IDEPageProps {
    /** Optional render prop for extra header buttons (e.g. Share) */
    renderHeaderActions?: (context: { daemonId: string; ideInstanceId: string }) => React.ReactNode
}

// ═════════════════════════════════════════════════════════
// ─── Main Component ─────────────────────────────────────
// ═════════════════════════════════════════════════════════
export default function IDEPage({ renderHeaderActions }: IDEPageProps = {}) {
    const { id: ideId } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const daemonCtx = useDaemons() as any
    const globalIdes: DaemonData[] = daemonCtx.ides || []
    const updateIdeChats = daemonCtx.updateIdeChats || (() => {})
    const connectionStates = daemonCtx.connectionStates || {}
    const { sendCommand: sendDaemonCommand } = useTransport()

    // ─── Derived from global context ─────────────────
    const doId = useMemo(() => parseDaemonRouteId(ideId || '').daemonId, [ideId])
    const ideData = useMemo(() => globalIdes.find(i => i.id === ideId), [globalIdes, ideId])
    const ideType = (ideData?.type as string) || undefined
    const ideName = ideType ? ideType.charAt(0).toUpperCase() + ideType.slice(1) : 'IDE'
    const isGlobalConnected = daemonCtx.isConnected ?? true
    const connState = (connectionStates[doId] || (isGlobalConnected ? 'connected' : 'new')) as ConnectionState
    const transportType = daemonCtx.connectionTransports?.[doId] || 'unknown'
    // Machine + workspace info
    const daemonEntry = useMemo(() => globalIdes.find(i => i.id === doId || i.daemonId === doId), [globalIdes, doId])
    const machineName = daemonEntry ? getMachineDisplayName(daemonEntry as any, { fallbackId: doId }) : ''
    const workspaceName = ideData?.workspace || ''

    // ─── Local UI state ────────────────────────────────
    const [searchParams] = useSearchParams()
    const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
    const initialView = (searchParams.get('view') as 'split' | 'remote' | 'chat') || (isMobile ? 'chat' : 'split')
    const [viewMode, setViewMode] = useState<'split' | 'remote' | 'chat'>(initialView)
    const [historyModalOpen, setHistoryModalOpen] = useState(false)
    const { toasts, setToasts, dismissToast, pushToast } = useIdeToasts()
    const [actionLogs, setActionLogs] = useState<{ ideId: string; text: string; timestamp: number }[]>([])
    const [localUserMessages, setLocalUserMessages] = useState<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>({})
    const [clearedTabs, setClearedTabs] = useState<Record<string, number>>({})
    const {
        activeChatTab,
        setActiveChatTab,
        activeConv,
        conversations,
        extensionTabs,
        hasExtensions,
        resolveConversationByTarget,
    } = useIdeConversations({
        ideData,
        allIdes: globalIdes,
        connectionStates,
        localUserMessages,
        ideName,
    })
    useDashboardConversationMeta({
        conversations,
        visibleConversations: conversations,
        clearedTabs,
        setClearedTabs,
        setActionLogs,
    })
    const {
        connScreenshot,
        screenshotUsage,
        handleRemoteAction,
    } = useIdeRemoteStream({
        doId,
        ideId: ideId || '',
        ideType,
        connState,
        viewMode,
        instanceId: ideData?.instanceId,
    })
    const daemonEntryIsStandalone = !!globalIdes.find(ide => ide.type === 'adhdev-daemon')
    const convoCmds = useDashboardConversationCommands({
        sendDaemonCommand,
        activeConv,
        setLocalUserMessages,
        setActionLogs,
        isStandalone: daemonEntryIsStandalone,
    })
    const {
        isCreatingChat,
        isRefreshingHistory,
        handleRefreshHistory,
        handleSwitchSession,
        handleNewChat,
    } = useIdeCommands({
        ideId: ideId || '',
        activeConv,
        historyModalOpen,
        chats: ideData?.chats,
        sendDaemonCommand,
        updateIdeChats,
        pushToast,
    })
    useDashboardEventManager({
        ides: globalIdes,
        sendDaemonCommand,
        setToasts: setToasts as any,
        setLocalUserMessages,
        resolveConversationByTarget,
    })

    if (!ideId) return <div className="ide-empty">No IDE selected</div>
    if (!activeConv) return <div className="ide-empty">IDE session not available</div>

    return (
        <div className="ide-page">
            <IDEHeader
                ideName={ideName}
                workspaceName={workspaceName}
                connState={connState}
                machineName={machineName}
                viewMode={viewMode}
                onChangeView={setViewMode}
                onOpenHistory={() => setHistoryModalOpen(true)}
                headerActions={renderHeaderActions?.({ daemonId: doId, ideInstanceId: ideId || '' })}
                onBack={() => navigate(-1)}
            />

            {/* ─── Main Content ───────────────────────────── */}
            <div className="ide-content">
                {/* Chat Panel */}
                <div className={`ide-chat-panel ${viewMode === 'chat' ? 'full' : ''} ${viewMode === 'remote' ? 'hidden' : ''}`}>
                    <IDEChatTabs
                        hasExtensions={hasExtensions}
                        ideName={ideName}
                        activeChatTab={activeChatTab}
                        extensionTabs={extensionTabs}
                        onSelectTab={(tabKey) => {
                            setActiveChatTab(tabKey)
                            const nextConv = conversations.find(conversation => conversation.tabKey === tabKey)
                            if (nextConv?.streamSource === 'agent-stream') {
                                void sendDaemonCommand(nextConv.ideId, 'focus_session', {
                                    agentType: nextConv.agentType,
                                    ...(nextConv.sessionId && { targetSessionId: nextConv.sessionId }),
                                }).catch(() => {})
                            }
                        }}
                    />

                    <ApprovalBanner activeConv={activeConv} onModalButton={convoCmds.handleModalButton} />
                    <ChatPane
                        activeConv={activeConv}
                        ideEntry={globalIdes.find(ide => ide.id === activeConv.ideId)}
                        handleSendChat={convoCmds.handleSendChat}
                        isSendingChat={convoCmds.isSendingChat}
                        handleFocusAgent={convoCmds.handleFocusAgent}
                        isFocusingAgent={convoCmds.isFocusingAgent}
                        actionLogs={actionLogs}
                        userName={daemonCtx.userName}
                    />
                </div>

                {/* Remote Desktop Panel */}
                <div className={`ide-remote-panel ${viewMode === 'remote' ? 'full' : ''} ${viewMode === 'chat' ? 'hidden' : ''}`}>
                        <RemoteView
                            addLog={() => {}}
                            connState={connState as any}
                            connScreenshot={connScreenshot}
                            screenshotUsage={screenshotUsage}
                            transportType={transportType}
                            onAction={handleRemoteAction}
                        />
                </div>
            </div>

            <IDEToastStack toasts={toasts} onDismiss={dismissToast} />
            {historyModalOpen && (
                <HistoryModal
                    activeConv={activeConv}
                    ides={globalIdes}
                    isCreatingChat={isCreatingChat}
                    isRefreshingHistory={isRefreshingHistory}
                    onClose={() => setHistoryModalOpen(false)}
                    onNewChat={handleNewChat}
                    onSwitchSession={handleSwitchSession}
                    onRefreshHistory={handleRefreshHistory}
                />
            )}
        </div>
    )
}

// ═════════════════════════════════════════════════════════
// ─── Sub-components ─────────────────────────────────────
// ═════════════════════════════════════════════════════════
