import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import { isAcpConv } from './types'
import { useDashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import DashboardMobileChatRoom from './DashboardMobileChatRoom'
import DashboardMobileChatInbox from './DashboardMobileChatInbox'
import DashboardMobileMachineScreen from './DashboardMobileMachineScreen'
import type { MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { isAcpEntry, isCliEntry } from '../../utils/daemon-utils'
import type { MachineRecentSession } from '../../pages/machine/types'

const MOBILE_CHAT_READS_KEY = 'adhdev_mobileChatReads_v1'
declare const __APP_VERSION__: string

type ReadStateMap = Record<string, number>

interface DashboardMobileChatModeProps {
    conversations: ActiveConversation[]
    ides: DaemonData[]
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
    userName?: string
    requestedActiveTabKey?: string | null
    onRequestedActiveTabConsumed?: () => void
    onOpenHistory: (conversation?: ActiveConversation) => void
    onOpenRemote: (conversation: ActiveConversation) => void
}

function readStoredReadState(): ReadStateMap {
    try {
        const raw = localStorage.getItem(MOBILE_CHAT_READS_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const next: ReadStateMap = {}
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                next[key] = value
            }
        }
        return next
    } catch {
        return {}
    }
}

function writeStoredReadState(next: ReadStateMap) {
    try {
        localStorage.setItem(MOBILE_CHAT_READS_KEY, JSON.stringify(next))
    } catch {
        // noop
    }
}

function normalizePreviewText(content: unknown) {
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim()
    if (Array.isArray(content)) {
        return content
            .map(block => {
                if (typeof block === 'string') return block
                if (block && typeof block === 'object' && 'text' in block) return String((block as any).text || '')
                return ''
            })
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
    }
    if (content && typeof content === 'object' && 'text' in content) {
        return String((content as any).text || '').replace(/\s+/g, ' ').trim()
    }
    return ''
}

function getConversationTimestamp(conversation: ActiveConversation) {
    const lastMessage = conversation.messages[conversation.messages.length - 1] as any
    const ts = lastMessage?.timestamp || lastMessage?.receivedAt || 0
    return typeof ts === 'number' ? ts : Date.parse(String(ts)) || 0
}

function getConversationPreview(conversation: ActiveConversation) {
    const lastMessage = conversation.messages[conversation.messages.length - 1] as any
    const preview = normalizePreviewText(lastMessage?.content)
    if (preview) return preview
    if (conversation.title) return conversation.title
    return conversation.displaySecondary || 'No messages yet'
}

function getConversationKind(conversation: ActiveConversation): 'ide' | 'cli' | 'acp' {
    if (conversation.transport === 'acp') return 'acp'
    if (conversation.transport === 'pty') return 'cli'
    return 'ide'
}

function getAvatarText(primary: string) {
    const text = primary.trim()
    if (!text) return '?'
    return text[0]!.toUpperCase()
}

export default function DashboardMobileChatMode({
    conversations,
    ides,
    actionLogs,
    sendDaemonCommand,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
    userName,
    requestedActiveTabKey,
    onRequestedActiveTabConsumed,
    onOpenHistory,
    onOpenRemote,
}: DashboardMobileChatModeProps) {
    const [selectedTabKey, setSelectedTabKey] = useState<string | null>(() => conversations[0]?.tabKey || null)
    const [screen, setScreen] = useState<'inbox' | 'chat' | 'machine'>(() => (conversations[0] ? 'chat' : 'inbox'))
    const [section, setSection] = useState<'machines' | 'chats' | 'settings'>('chats')
    const [readState, setReadState] = useState<ReadStateMap>(() => readStoredReadState())
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
    const [machineActionState, setMachineActionState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
    const [machineActionMessage, setMachineActionMessage] = useState('')
    const navigate = useNavigate()
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null

    const selectedConversation = useMemo(
        () => conversations.find(conversation => conversation.tabKey === selectedTabKey) || conversations[0] || null,
        [conversations, selectedTabKey],
    )
    const selectedIdeEntry = useMemo(
        () => selectedConversation ? ides.find(ide => ide.id === selectedConversation.ideId) : undefined,
        [ides, selectedConversation],
    )
    const machineEntries = useMemo(
        () => ides.filter((entry: any) => entry.type === 'adhdev-daemon' || entry.daemonMode),
        [ides],
    )
    const selectedMachineEntry = useMemo(
        () => machineEntries.find(machine => machine.id === selectedMachineId) || null,
        [machineEntries, selectedMachineId],
    )
    const mobileInboxConversations = useMemo(
        () => conversations.filter(conversation => {
            if (conversation.streamSource !== 'native' || conversation.transport !== 'cdp-page') return true
            return !conversations.some(other => (
                other.ideId === conversation.ideId
                && other.tabKey !== conversation.tabKey
                && other.streamSource === 'agent-stream'
            ))
        }),
        [conversations],
    )

    const cmds = useDashboardConversationCommands({
        sendDaemonCommand,
        activeConv: selectedConversation || undefined,
        setLocalUserMessages,
        setActionLogs,
        isStandalone,
    })

    const markConversationRead = useCallback((conversation: ActiveConversation | null) => {
        if (!conversation) return
        const readAt = Math.max(Date.now(), getConversationTimestamp(conversation))
        setReadState(prev => {
            const next = { ...prev }
            const readKey = conversation.recentKey || conversation.tabKey
            if ((next[readKey] || 0) >= readAt) return prev
            next[readKey] = readAt
            writeStoredReadState(next)
            return next
        })
        void sendDaemonCommand(conversation.daemonId || conversation.ideId, 'mark_recent_seen', {
            recentKey: conversation.recentKey,
            kind: getConversationKind(conversation),
            providerType: conversation.agentType || conversation.ideType,
            workspace: conversation.workspaceName || null,
            seenAt: readAt,
        }).catch(() => {})
    }, [sendDaemonCommand])

    useEffect(() => {
        if (!selectedConversation) {
            setScreen('inbox')
            setSelectedTabKey(conversations[0]?.tabKey || null)
            return
        }
        if (screen === 'chat') markConversationRead(selectedConversation)
    }, [conversations, markConversationRead, screen, selectedConversation])

    useEffect(() => {
        if (!requestedActiveTabKey) return
        const matched = conversations.find(conversation => conversation.tabKey === requestedActiveTabKey)
        if (!matched) return
        setSelectedTabKey(matched.tabKey)
        setScreen('chat')
        onRequestedActiveTabConsumed?.()
    }, [conversations, onRequestedActiveTabConsumed, requestedActiveTabKey])

    const items = useMemo<MobileConversationListItem[]>(() => mobileInboxConversations.map(conversation => {
        const timestamp = getConversationTimestamp(conversation)
        const preview = getConversationPreview(conversation)
        const daemonBucket = conversation.inboxBucket || 'idle'
        const isWorking = daemonBucket === 'working'
        const requiresAction = daemonBucket === 'needs_attention'
        const isOpenConversation = screen === 'chat' && selectedConversation?.tabKey === conversation.tabKey
        const readKey = conversation.recentKey || conversation.tabKey
        const daemonSeenAt = conversation.lastSeenAt || 0
        const localSeenAt = readState[readKey] || 0
        const hasOptimisticRead = localSeenAt > daemonSeenAt && timestamp > 0 && timestamp <= localSeenAt
        const unread = (
            daemonBucket === 'task_complete'
            && !isOpenConversation
            && !!conversation.unread
            && !hasOptimisticRead
        )
        const inboxBucket: MobileConversationListItem['inboxBucket'] = requiresAction
            ? 'needs_attention'
            : isWorking
                ? 'working'
                : unread
                    ? 'task_complete'
                    : 'idle'
        return {
            conversation,
            timestamp,
            preview,
            unread,
            requiresAction,
            isWorking,
            inboxBucket,
        }
    }).sort((a, b) => b.timestamp - a.timestamp), [mobileInboxConversations, readState, screen, selectedConversation])

    const attentionItems = useMemo(
        () => items.filter(item => item.requiresAction),
        [items],
    )

    const unreadItems = useMemo(
        () => items.filter(item => item.unread && !item.requiresAction),
        [items],
    )
    const workingItems = useMemo(
        () => items.filter(item => !item.unread && !item.requiresAction && item.isWorking),
        [items],
    )
    const completedItems = useMemo(
        () => items.filter(item => !item.unread && !item.requiresAction && !item.isWorking),
        [items],
    )
    const selectedMachineConversations = useMemo(
        () => selectedMachineEntry
            ? items.filter(item => item.conversation.daemonId === selectedMachineEntry.id || item.conversation.ideId === selectedMachineEntry.id)
            : [],
        [items, selectedMachineEntry],
    )
    const selectedMachineRecentSessions = useMemo<MachineRecentSession[]>(
        () => {
            if (!selectedMachineEntry) return []
            const snapshotRecent = ((selectedMachineEntry as any).recentSessions || []) as any[]
            if (snapshotRecent.length > 0) {
                return snapshotRecent.map((session) => ({
                    id: session.id,
                    sessionId: session.sessionId || session.id,
                    label: session.title || session.providerName || session.providerType,
                    kind: session.kind,
                    providerType: session.providerType,
                    subtitle: session.currentModel || session.workspace || undefined,
                    workspace: session.workspace,
                    currentModel: session.currentModel,
                }))
            }

            return ides
                .filter((entry: any) => !(entry as any).daemonMode && (entry as any).daemonId === selectedMachineEntry.id)
                .map((entry: any) => {
                    const kind: MachineRecentSession['kind'] = isCliEntry(entry) ? 'cli' : isAcpEntry(entry) ? 'acp' : 'ide'
                    return {
                        id: entry.id,
                        sessionId: entry.id,
                        label: entry.activeChat?.title
                            || (isCliEntry(entry)
                                ? ((entry as any).cliName || entry.type)
                                : isAcpEntry(entry)
                                    ? ((entry as any).cliName || entry.type)
                                    : entry.type),
                        kind,
                        providerType: entry.type,
                        subtitle: isAcpEntry(entry)
                            ? ((entry as any).currentModel || (entry as any).workspace || undefined)
                            : ((entry as any).workspace || undefined),
                        workspace: (entry as any).workspace || undefined,
                        currentModel: (entry as any).currentModel,
                        timestamp: entry.activeChat?.messages?.at?.(-1)?.timestamp || 0,
                    }
                })
                .sort((a, b) => b.timestamp - a.timestamp)
                .map(({ timestamp, ...session }) => session)
        },
        [ides, selectedMachineEntry],
    )
    const selectedMachineVersion = selectedMachineEntry?.version || (selectedMachineEntry as any)?.daemonVersion || null
    const selectedMachineNeedsUpgrade = !!selectedMachineEntry && !!selectedMachineVersion && !!appVersion && selectedMachineVersion !== appVersion
    const selectedMachineProviders = useMemo(
        () => ((selectedMachineEntry as any)?.availableProviders || []) as Array<{ type: string; displayName?: string; icon?: string; category?: string }>,
        [selectedMachineEntry],
    )
    const selectedMachineCliProviders = useMemo(
        () => selectedMachineProviders
            .filter(provider => provider.category === 'cli')
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )
    const selectedMachineAcpProviders = useMemo(
        () => selectedMachineProviders
            .filter(provider => provider.category === 'acp')
            .map(provider => ({
                type: provider.type,
                displayName: provider.displayName || provider.type,
                icon: provider.icon,
            })),
        [selectedMachineProviders],
    )

    const machineCards = useMemo<MobileMachineCard[]>(() => {
        const grouped = new Map<string, MobileMachineCard>()

        for (const item of items) {
            const key = item.conversation.daemonId || item.conversation.ideId
            const existing = grouped.get(key)
            if (!existing) {
                grouped.set(key, {
                    id: key,
                    label: item.conversation.machineName || item.conversation.displaySecondary || 'Machine',
                    subtitle: item.conversation.connectionState === 'connected'
                        ? 'Connected'
                        : item.conversation.connectionState || 'Unknown',
                    unread: item.unread ? 1 : 0,
                    total: 1,
                    latestConversation: item.conversation,
                })
                continue
            }
            existing.total += 1
            if (item.unread) existing.unread += 1
            if (getConversationTimestamp(item.conversation) > getConversationTimestamp(existing.latestConversation)) {
                existing.latestConversation = item.conversation
            }
        }

        return Array.from(grouped.values()).sort((a, b) => (
            getConversationTimestamp(b.latestConversation) - getConversationTimestamp(a.latestConversation)
        ))
    }, [items])

    const handleOpenConversation = useCallback((conversation: ActiveConversation) => {
        setSelectedTabKey(conversation.tabKey)
        setScreen('chat')
        markConversationRead(conversation)
    }, [markConversationRead])

    const handleBackFromConversation = useCallback(() => {
        markConversationRead(selectedConversation)
        setScreen('inbox')
    }, [markConversationRead, selectedConversation])

    const handleOpenMachine = useCallback((machineId: string) => {
        setSelectedMachineId(machineId)
        setMachineActionState('idle')
        setMachineActionMessage('')
        setScreen('machine')
    }, [])

    const handleLaunchDetectedIde = useCallback(async (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage(`Launching ${ideType}…`)
            const payload: Record<string, unknown> = {
                ideType,
                enableCdp: true,
            }
            if (opts?.workspacePath?.trim()) payload.workspace = opts.workspacePath.trim()
            await sendDaemonCommand(machineId, 'launch_ide', payload)
            setMachineActionState('done')
            setMachineActionMessage(`${ideType} launch requested`)
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Launch IDE failed')
            console.error('Launch IDE failed', error)
        }
    }, [sendDaemonCommand])

    const handleAddWorkspace = useCallback(async (
        machineId: string,
        path: string,
        opts?: { createIfMissing?: boolean },
    ) => {
        if (!path.trim()) return
        try {
            setMachineActionState('loading')
            setMachineActionMessage(opts?.createIfMissing ? 'Creating folder…' : 'Saving workspace…')
            const res: any = await sendDaemonCommand(machineId, 'workspace_add', {
                path: path.trim(),
                createIfMissing: opts?.createIfMissing === true,
            })
            if (res?.success) {
                setMachineActionState('done')
                setMachineActionMessage(opts?.createIfMissing ? 'Folder created and workspace saved' : 'Workspace saved')
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.error || 'Could not save workspace')
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Could not save workspace')
        }
    }, [sendDaemonCommand])

    const handleMachineUpgrade = useCallback(async (machineId: string) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage('Installing latest daemon…')
            const res: any = await sendDaemonCommand(machineId, 'daemon_upgrade', {})
            if (res?.result?.upgraded || res?.result?.success) {
                setMachineActionState('done')
                setMachineActionMessage(`Upgrading to v${res?.result?.version || 'latest'} and restarting…`)
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.result?.error || 'Upgrade failed')
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Upgrade failed')
        }
    }, [sendDaemonCommand])

    const handleLaunchWorkspaceProvider = useCallback(async (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: { workspaceId?: string | null; workspacePath?: string | null },
    ) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage(`Launching ${providerType}…`)
            const payload: Record<string, unknown> = { cliType: providerType }
            if (opts?.workspacePath?.trim()) payload.dir = opts.workspacePath.trim()
            else if (opts?.workspaceId) payload.workspaceId = opts.workspaceId
            const res: any = await sendDaemonCommand(machineId, 'launch_cli', payload)
            const result = res?.result || res
            if (res?.success && result?.id) {
                setMachineActionState('done')
                setMachineActionMessage(`${providerType} launched`)
                navigate(`/dashboard?activeTab=${encodeURIComponent(result.id)}`)
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.error || result?.error || `Could not launch ${kind.toUpperCase()} workspace`)
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : `Could not launch ${kind.toUpperCase()} workspace`)
        }
    }, [navigate, sendDaemonCommand])

    const handleOpenRecent = useCallback(async (session: MachineRecentSession) => {
        if (session.sessionId) {
            navigate(`/dashboard?activeTab=${encodeURIComponent(session.sessionId)}`)
            return
        }
        if (!selectedMachineEntry) return
        if (session.kind === 'ide' && session.providerType) {
            await handleLaunchDetectedIde(selectedMachineEntry.id, session.providerType, {
                workspacePath: session.workspace || null,
            })
            return
        }
        if ((session.kind === 'cli' || session.kind === 'acp') && session.providerType) {
            await handleLaunchWorkspaceProvider(selectedMachineEntry.id, session.kind, session.providerType, {
                workspacePath: session.workspace || null,
            })
            return
        }
    }, [handleLaunchDetectedIde, handleLaunchWorkspaceProvider, selectedMachineEntry])

    return (
        <div className="dashboard-mobile-chat">
            {screen === 'chat' && selectedConversation ? (
                <DashboardMobileChatRoom
                    selectedConversation={selectedConversation}
                    isAcp={isAcpConv(selectedConversation)}
                    selectedIdeEntry={selectedIdeEntry}
                    actionLogs={actionLogs}
                    userName={userName}
                    isSendingChat={cmds.isSendingChat}
                    isFocusingAgent={cmds.isFocusingAgent}
                    onBack={handleBackFromConversation}
                    onOpenHistory={onOpenHistory}
                    onOpenRemote={onOpenRemote}
                    handleSendChat={cmds.handleSendChat}
                    handleFocusAgent={cmds.handleFocusAgent}
                />
            ) : screen === 'machine' && selectedMachineEntry ? (
                <DashboardMobileMachineScreen
                    selectedMachineEntry={selectedMachineEntry}
                    selectedMachineConversations={selectedMachineConversations}
                    selectedMachineRecentSessions={selectedMachineRecentSessions}
                    cliProviders={selectedMachineCliProviders}
                    acpProviders={selectedMachineAcpProviders}
                    selectedMachineNeedsUpgrade={selectedMachineNeedsUpgrade}
                    appVersion={appVersion}
                    machineAction={{ state: machineActionState, message: machineActionMessage }}
                    onBack={() => setScreen('inbox')}
                    onOpenConversation={handleOpenConversation}
                    onOpenRecent={handleOpenRecent}
                    onOpenMachineDetails={() => navigate(`/machines/${selectedMachineEntry.id}`)}
                    onMachineUpgrade={() => handleMachineUpgrade(selectedMachineEntry.id)}
                    onLaunchDetectedIde={(ideType, opts) => handleLaunchDetectedIde(selectedMachineEntry.id, ideType, opts)}
                    onAddWorkspace={(path, opts) => handleAddWorkspace(selectedMachineEntry.id, path, opts)}
                    onLaunchWorkspaceProvider={(kind, providerType, opts) => handleLaunchWorkspaceProvider(selectedMachineEntry.id, kind, providerType, opts)}
                />
            ) : (
                <DashboardMobileChatInbox
                    section={section}
                    attentionItems={attentionItems}
                    unreadItems={unreadItems}
                    workingItems={workingItems}
                    completedItems={completedItems}
                    machineCards={machineCards}
                    getAvatarText={getAvatarText}
                    getConversationPreview={getConversationPreview}
                    onOpenConversation={handleOpenConversation}
                    onOpenMachine={handleOpenMachine}
                    onOpenSettings={() => navigate('/settings')}
                    onSectionChange={setSection}
                />
            )}
        </div>
    )
}
