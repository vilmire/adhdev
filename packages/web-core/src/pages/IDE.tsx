/**
 * IDE Detail Page — v2 (complete rewrite)
 * 
 * 2-panel layout: Chat (left) + Remote Desktop (right)
 * All connection state from DaemonContext — no local duplication.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import RemoteView from '../components/RemoteView'
import ChatPane from '../components/dashboard/ChatPane'
import HistoryModal from '../components/dashboard/HistoryModal'
import type { ActiveConversation } from '../components/dashboard/types'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
import { useDaemons, connectionManager } from '../compat'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import { deriveStreamConversationStatus, getAgentDisplayName, getMachineDisplayName } from '../utils/daemon-utils'
type ConnectionState = string
import './IDE.css'
import { IconChat, IconMonitor, IconScroll } from '../components/Icons'

interface IDEPageProps {
    /** Optional render prop for extra header buttons (e.g. Share) */
    renderHeaderActions?: (context: { daemonId: string; ideInstanceId: string }) => React.ReactNode
}

function getStreamKey(stream: { sessionId?: string; instanceId?: string; agentType: string }): string {
    return stream.sessionId || stream.instanceId || stream.agentType
}


// ─── Helper: extract doId from composite ideId ─
function extractDoId(ideId: string): string {
    return ideId.split(':')[0] || ''
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
    const doId = useMemo(() => extractDoId(ideId || ''), [ideId])
    const ideData = useMemo(() => globalIdes.find(i => i.id === ideId), [globalIdes, ideId])
    const ideType = (ideData?.type as string) || undefined
    const ideName = ideType ? ideType.charAt(0).toUpperCase() + ideType.slice(1) : 'IDE'
    const activeChat = ideData?.activeChat || null
    const agentStreams = ideData?.agentStreams || []
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
    // Unified tab: 'native' for IDE chat, or agentType string for extensions
    const [activeChatTab, setActiveChatTab] = useState<string>('native')
    const [historyModalOpen, setHistoryModalOpen] = useState(false)
    const [isCreatingChat, setIsCreatingChat] = useState(false)
    const [isRefreshingHistory, setIsRefreshingHistory] = useState(false)
    const [agentInput, setAgentInput] = useState('')
    const [isSendingChat, setIsSendingChat] = useState(false)
    const [connScreenshot, setConnScreenshot] = useState<string | null>(null)
    const [screenshotUsage, setScreenshotUsage] = useState<{ dailyUsedMinutes: number; dailyBudgetMinutes: number; budgetExhausted: boolean } | null>(null)
    const [toasts, setToasts] = useState<{ id: number; message: string; type: 'success' | 'info' | 'warning' }[]>([])
    const historyRefreshedRef = useRef(false)

    // Native IDE tab should reflect native chat state only.
    const derivedStatus = normalizeManagedStatus(activeChat?.status, { activeModal: activeChat?.activeModal });

    // Build ActiveConversation for native IDE ChatPane
    const nativeConv: ActiveConversation = useMemo(() => ({
        ideId: ideId || '',
        sessionId: (ideData as any)?.sessionId || ideData?.instanceId,
        daemonId: doId,
        agentName: getAgentDisplayName(ideType || ''),
        agentType: ideType || '',
        status: derivedStatus,
        title: activeChat?.title || '',
        messages: activeChat?.messages || [],
        ideType: ideType || '',
        workspaceName: (ideData as any)?.workspaceName || '',
        displayPrimary: ideName,
        displaySecondary: (ideData as any)?.workspaceName || '',
        cdpConnected: true,
        modalButtons: activeChat?.activeModal?.buttons,
        modalMessage: activeChat?.activeModal?.message,
        streamSource: 'native' as const,
        tabKey: `ide-${ideId}`,
    }), [ideId, doId, ideType, activeChat, ideData, ideName, derivedStatus])

    // Build ActiveConversation for each agent stream (extension)
    const streamConvs: ActiveConversation[] = useMemo(() =>
        agentStreams.map(stream => {
            const streamStatus = deriveStreamConversationStatus(stream);
            const streamKey = getStreamKey(stream as any);
            return {
                ideId: ideId || '',
                sessionId: (stream as any).sessionId || (stream as any).instanceId,
                daemonId: doId,
                agentName: stream.agentName,
                agentType: stream.agentType,
                status: streamStatus,
                title: (stream as any).title || '',
                messages: stream.messages.map((m: any, i: number) => ({
                    role: m.role, content: m.content, kind: (m as any).kind,
                    id: `${streamKey}-${i}`, receivedAt: m.timestamp,
                })),
                ideType: stream.agentType,
                workspaceName: '',
                displayPrimary: (stream as any).title || stream.agentName,
                displaySecondary: '',
                cdpConnected: true,
                modalButtons: stream.activeModal?.buttons,
                modalMessage: stream.activeModal?.message,
                streamSource: 'agent-stream' as const,
                tabKey: `agent-stream-${streamKey}`,
            };
        }),
    [agentStreams, ideId, doId])

    // Currently active conversation (native or extension)
    const activeConv = useMemo(() => {
        if (activeChatTab === 'native') return nativeConv;
        return streamConvs.find(c => c.tabKey === activeChatTab) || nativeConv;
    }, [activeChatTab, nativeConv, streamConvs])

    const getProviderArgs = useCallback(() => (
        activeConv.streamSource === 'agent-stream'
            ? { targetSessionId: activeConv.sessionId, agentType: activeConv.agentType }
            : (activeConv.sessionId ? { targetSessionId: activeConv.sessionId } : {})
    ), [activeConv])

    // ─── Connection screenshot listener ─────────────
    useEffect(() => {
        if (!doId) return
        const unsub = connectionManager.onScreenshot('ide-page', (sourceDaemonId: string, blob: Blob) => {
            if (sourceDaemonId !== doId) return
            const reader = new FileReader()
            reader.onload = () => setConnScreenshot(reader.result as string)
            reader.readAsDataURL(blob)
        })
        return unsub
    }, [doId])

    useEffect(() => {
        if (connState !== 'connected') {
            setConnScreenshot(null)
        }
    }, [connState])

    // ─── Status report listener (screenshot usage) ────
    useEffect(() => {
        if (!doId) return
        const unsub = connectionManager.onStatus?.((sourceDaemonId: string, payload: any) => {
            if (sourceDaemonId !== doId) return
            if (payload?.screenshotUsage) {
                setScreenshotUsage(payload.screenshotUsage)
            }
        })
        return unsub || (() => {})
    }, [doId])


    // ─── Screenshot streaming control ───────────────
    // Extract managerKey from ideId (e.g. "doId:ide:cursor_remote_vs" → "cursor_remote_vs")
    // This is more specific than ideType ("cursor") and distinguishes multi-window instances
    const screenshotTarget = useMemo(() => {
        if (!ideId) return ideType
        const parts = ideId.split(':')
        if (parts.length >= 3 && parts[1] === 'ide') return parts.slice(2).join(':')
        return ideType
    }, [ideId, ideType])

    // Clear the previous frame immediately when the remote target changes.
    // This avoids flashing the old IDE screenshot while the new stream warms up.
    useEffect(() => {
        setConnScreenshot(null)
    }, [doId, ideId, screenshotTarget])

    useEffect(() => {
        const conn = doId ? connectionManager.get(doId) : null
        if (!conn) return
        const isReady = connState === 'connected'
        if (!isReady) return
        if (viewMode !== 'chat' && screenshotTarget) {
            conn.startScreenshots(screenshotTarget)
        } else {
            conn.stopScreenshots(screenshotTarget)
        }
    }, [viewMode, connState, screenshotTarget, doId])



    // ─── Command execution ─────────────────────────────
    // Cloud: TransportContext = P2P (p2pManager.sendCommand with built-in recovery)
    // Standalone: TransportContext = WS (sendCommandViaWs)
    const executeCommand = useCallback(async (commandType: string, data: Record<string, unknown> = {}): Promise<any> => {
        if (!ideId) throw new Error('No IDE ID')
        return await sendDaemonCommand(ideId, commandType, data)
    }, [ideId])

    // ─── Handlers ───────────────────────────────────
    const handleSendAgent = async () => {
        const message = agentInput.trim()
        if (!message || !ideId || isSendingChat) return
        setAgentInput('')
        setIsSendingChat(true)
        try {
            // Both native IDE and extension use send_chat — daemon routes by agentType
            await executeCommand('send_chat', {
                message,
                text: message,
                waitForResponse: true,
                ...(activeConv.sessionId && { targetSessionId: activeConv.sessionId }),
                ...(activeChatTab !== 'native' && { agentType: activeConv.agentType }),
            })
        } catch (e) {
            console.error('[IDE] Send failed:', e)
        } finally {
            setIsSendingChat(false)
        }
    }

    const pushToast = useCallback((message: string, type: 'success' | 'info' | 'warning' = 'warning') => {
        const id = Date.now() + Math.floor(Math.random() * 1000)
        setToasts(prev => [...prev, { id, message, type }])
        window.setTimeout(() => {
            setToasts(prev => prev.filter(toast => toast.id !== id))
        }, 5000)
    }, [])

    const handleRefreshHistory = useCallback(async () => {
        if (!ideId || isRefreshingHistory) return
        setIsRefreshingHistory(true)
        try {
            const res: any = await sendDaemonCommand(ideId, 'list_chats', {
                forceExpand: true,
                ...getProviderArgs(),
            })
            const chats = res?.chats || res?.result?.chats
            if (res?.success && Array.isArray(chats)) {
                updateIdeChats(ideId, chats)
            }
        } catch (e) {
            console.error('[IDE] Refresh history failed:', e)
            pushToast('히스토리 새로고침에 실패했습니다.', 'warning')
        } finally {
            setIsRefreshingHistory(false)
        }
    }, [ideId, isRefreshingHistory, sendDaemonCommand, getProviderArgs, updateIdeChats, pushToast])

    const handleSwitchSession = useCallback(async (_targetIdeId: string, sessionId: string) => {
        if (!ideId) return
        try {
            const res: any = await sendDaemonCommand(ideId, 'switch_chat', {
                id: sessionId,
                sessionId,
                ...getProviderArgs(),
            })
            const scriptResult = res?.result
            const ok = res?.success === true || scriptResult === 'switched' || scriptResult === 'switched-by-title'
            if (!ok) {
                if (scriptResult === false || scriptResult === 'not_found') {
                    pushToast('세션 탭을 찾지 못했습니다. 히스토리를 새로고침해 보세요.', 'warning')
                } else if (typeof scriptResult === 'string' && scriptResult.startsWith('error:')) {
                    pushToast(`세션 전환 오류: ${scriptResult}`, 'warning')
                } else {
                    pushToast('세션 전환에 실패했습니다.', 'warning')
                }
            }
        } catch (e: any) {
            console.error('[IDE] Switch session failed:', e)
            pushToast(`세션 전환 실패: ${e?.message || 'connection error'}`, 'warning')
        }
    }, [ideId, sendDaemonCommand, getProviderArgs, pushToast])

    const handleNewChat = useCallback(async () => {
        if (!ideId || isCreatingChat) return
        setIsCreatingChat(true)
        try {
            await sendDaemonCommand(ideId, 'new_chat', {
                ...getProviderArgs(),
            })
        } catch (e) {
            console.error('[IDE] New chat failed:', e)
            pushToast('새 채팅 생성에 실패했습니다.', 'warning')
        } finally {
            setIsCreatingChat(false)
        }
    }, [ideId, isCreatingChat, sendDaemonCommand, getProviderArgs, pushToast])

    useEffect(() => {
        if (!historyModalOpen) {
            historyRefreshedRef.current = false
            return
        }
        if (historyRefreshedRef.current || isRefreshingHistory) return
        if (!ideData?.chats || ideData.chats.length === 0) {
            historyRefreshedRef.current = true
            handleRefreshHistory()
        }
    }, [historyModalOpen, ideData?.chats, isRefreshingHistory, handleRefreshHistory])

    useEffect(() => {
        if (activeChatTab === 'native') return
        if (!streamConvs.some(conv => conv.tabKey === activeChatTab)) {
            setActiveChatTab(streamConvs[0]?.tabKey || 'native')
        }
    }, [activeChatTab, streamConvs])



    // ─── Derived values ─────────────────────────────
    const hasExtensions = agentStreams.length > 0

    if (!ideId) return <div className="ide-empty">No IDE selected</div>

    return (
        <div className="ide-page">
            {/* ─── Header ─────────────────────────────────── */}
            <header className="ide-header">
                <div className="ide-header-left">
                    <div className="ide-title">
                        <IconChat size={16} />
                        <span className="ide-name">{ideName}</span>
                        <span className="ide-name-mobile">IDE</span>
                        {workspaceName && <span className="ide-workspace">{workspaceName}</span>}
                        <span className="ide-badge">REMOTE</span>
                    </div>
                    <div className="ide-status-pill">
                        <span className={`ide-dot ${connState === 'connected' ? 'online' : 'connecting'}`} />
                        <span className="ide-status-text">{connState === 'connected' ? 'Connected' : connState === 'connecting' ? 'Connecting' : 'WS'}</span>
                    </div>
                    {machineName && <span className="ide-machine-label">{machineName}</span>}
                </div>
                <div className="ide-header-right">
                    {(['chat', 'split', 'remote'] as const).map(mode => (
                        <button
                            key={mode}
                            className="btn btn-secondary btn-sm"
                            style={{
                                border: viewMode === mode ? '1px solid var(--accent-primary)' : 'none',
                                background: viewMode === mode ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                                padding: '6px 10px',
                                color: viewMode === mode ? 'var(--accent-primary)' : undefined,
                            }}
                            onClick={() => setViewMode(mode)}
                        >
                            {mode === 'chat' ? <IconChat size={14} /> : mode === 'split' ? '⊞' : <IconMonitor size={14} />}
                        </button>
                    ))}
                    <button
                        className="btn btn-secondary btn-sm flex items-center justify-center shrink-0"
                        onClick={() => setHistoryModalOpen(true)}
                        title="Chat History"
                    >
                        <IconScroll size={14} />
                    </button>
                    {renderHeaderActions && renderHeaderActions({ daemonId: doId, ideInstanceId: ideId || '' })}
                    <button
                        className="btn btn-primary btn-sm flex items-center justify-center shrink-0"
                        onClick={() => navigate(-1)}
                    >
                        ←<span className="hidden md:inline ml-1">Back</span>
                    </button>
                </div>
            </header>

            {/* ─── Main Content ───────────────────────────── */}
            <div className="ide-content">
                {/* Chat Panel */}
                <div className={`ide-chat-panel ${viewMode === 'chat' ? 'full' : ''} ${viewMode === 'remote' ? 'hidden' : ''}`}>
                        {/* Unified chat tabs: IDE native + extension agents */}
                        {hasExtensions && (
                            <div className="ide-chat-tabs">
                                <button
                                    className={`ide-chat-tab ${activeChatTab === 'native' ? 'active' : ''}`}
                                    onClick={() => setActiveChatTab('native')}
                                >
                                    {ideName}
                                </button>
                                {agentStreams.map(stream => {
                                    const streamKey = getStreamKey(stream as any);
                                    const tabKey = `agent-stream-${streamKey}`;
                                    const isActive = activeChatTab === tabKey;
                                    const normalizedStatus = deriveStreamConversationStatus(stream);
                                    const needsApproval = normalizedStatus === 'waiting_approval';
                                    const isGenerating = normalizedStatus === 'generating';
                                    return (
                                        <button
                                            key={tabKey}
                                            className={`ide-chat-tab ${isActive ? 'active' : ''}`}
                                            onClick={() => setActiveChatTab(tabKey)}
                                        >
                                            <span
                                                style={{
                                                    display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 5,
                                                    background: needsApproval ? '#f59e0b' : isGenerating ? 'var(--accent-primary)' : '#64748b',
                                                    boxShadow: isGenerating ? '0 0 6px var(--accent-primary)' : 'none',
                                                }}
                                            />
                                            {(stream as any).title || stream.agentName}
                                            {needsApproval && <span className="ide-ext-badge" style={{background:'#f59e0b22',color:'#f59e0b',marginLeft:4}}>!</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {/* Unified ChatPane for all tabs */}
                        <ChatPane
                            activeConv={activeConv}
                            ides={globalIdes}
                            agentInput={agentInput}
                            setAgentInput={setAgentInput}
                            handleSendChat={handleSendAgent}
                            handleFocusAgent={() => {}}
                            isFocusingAgent={false}
                            messageReceivedAt={{}}
                            actionLogs={[]}
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
                            onAction={async (action, params) => {
                                const conn = doId ? connectionManager.get(doId) : null
                                if (!conn || connState !== 'connected') {
                                    console.warn('[RemoteInput] P2P not connected')
                                    return { success: false, error: 'P2P not connected' }
                                }
                                // Pass UUID instanceId so daemon can route to correct CDP manager
                                const instanceUuid = ideData?.instanceId || screenshotTarget
                                return await conn.sendInput(action, params, instanceUuid)
                            }}
                        />
                </div>
            </div>

            {/* ─── Toasts ─────────────────────────────────── */}
            {toasts.length > 0 && (
                <div className="ide-toasts">
                    {toasts.map(t => (
                        <div key={t.id} className={`ide-toast ${t.type}`} onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}>
                            {t.message}
                        </div>
                    ))}
                </div>
            )}
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
