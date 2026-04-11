/**
 * ADHDev — Machine Detail Page (v3 — Refactored)
 *
 * Orchestrator component that:
 * - Derives machine/IDE/CLI/ACP data from DaemonContext
 * - Renders header with tabs
 * - Delegates each tab to its own sub-component
 *
 * Sub-components in ./machine/:
 *   OverviewTab, AgentTab (unified IDE/CLI/ACP), ProvidersTab, LogsTab, LaunchPickModal
 *
 * Shared hook: useMachineActions (launch/stop/restart/workspace handlers)
 * Shared types: ./machine/types.ts
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import { useDaemonMetadataLoader } from '../hooks/useDaemonMetadataLoader'
import { useDaemonMachineRuntimeSubscription } from '../hooks/useDaemonMachineRuntimeSubscription'
import type { DaemonData } from '../types'
import { isCliEntry, isAcpEntry, dedupeAgents, getMachineDisplayName, getMachineHostnameLabel } from '../utils/daemon-utils'
import { IconBarChart, IconMonitor, IconSettings, IconClipboard, IconServer } from '../components/Icons'
import type { ReactNode } from 'react'
import { eventManager, type ToastConfig } from '../managers/EventManager'
import ToastContainer from '../components/dashboard/ToastContainer'

// Machine sub-components
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry, MachineRecentLaunch, TabId, ProviderInfo } from './machine/types'
import { useMachineActions } from './machine/useMachineActions'
import OverviewTab from './machine/OverviewTab'
import ProvidersTab from './machine/ProvidersTab'
import LogsTab from './machine/LogsTab'
import SessionHostPanel from './machine/SessionHostPanel'
import LaunchPickModal from './machine/LaunchPickModal'
import MachineCommandCenter from './machine/MachineCommandCenter'
import MachineWorkspaceTab from './machine/MachineWorkspaceTab'
import LaunchConfirmDialog from '../components/machine/LaunchConfirmDialog'
import { buildLaunchWorkspaceOptions } from '../components/machine/launchWorkspaceOptions'
import type { LaunchWorkspaceOption } from './machine/types'
import { buildScopedIdeConversations } from '../components/dashboard/buildConversations'
import { getConversationActivityAt } from '../components/dashboard/conversation-sort'
import type { ActiveConversation } from '../components/dashboard/types'

// ─── Component ───────────────────────────────────────
interface MachineDetailProps {
    onNicknameSynced?: (args: { machineRuntimeId: string; registeredMachineId?: string | null; nickname: string }) => Promise<void>
}

type MachineDaemonEntry = DaemonData & {
    type: 'adhdev-daemon'
    activeWorkspaceId?: string | null
    activeWorkspacePath?: string | null
}

export default function MachineDetail({ onNicknameSynced }: MachineDetailProps = {}) {
    const { id: machineId } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const location = useLocation()
    const { sendCommand: sendDaemonCommand } = useTransport()
    const loadDaemonMetadata = useDaemonMetadataLoader()
    const daemonCtx = useDaemons()
    const allIdes: DaemonData[] = daemonCtx.ides || []
    const initialLoaded: boolean = daemonCtx.initialLoaded ?? true
    const machineEntry = allIdes.find((entry): entry is MachineDaemonEntry => entry.id === machineId && entry.type === 'adhdev-daemon')
    const isStandalone = allIdes.some(entry => entry.type === 'adhdev-daemon')
    const [activeTab, setActiveTab] = useState<TabId>('workspace')
    const [workspaceCategoryHint, setWorkspaceCategoryHint] = useState<'ide' | 'cli' | 'acp'>('ide')
    const recentLaunchActionRef = useRef<(() => Promise<void>) | null>(null)
    const [recentLaunchConfirm, setRecentLaunchConfirm] = useState<{
        title: string
        description: string
        details: Array<{ label: string; value: string }>
        confirmLabel: string
        workspaceOptions: LaunchWorkspaceOption[]
    } | null>(null)
    const recentLaunchWorkspaceKeyRef = useRef('__home__')
    const [recentLaunchWorkspaceKey, setRecentLaunchWorkspaceKey] = useState('__home__')
    const [recentLaunchBusy, setRecentLaunchBusy] = useState(false)
    const logsEndRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!machineId || !machineEntry) return
        const needsMetadata = !machineEntry.workspaces
            || !machineEntry.availableProviders
            || !machineEntry.detectedIdes
            || !machineEntry.recentLaunches
        if (!needsMetadata) return
        void loadDaemonMetadata(machineId, { minFreshMs: 30_000 }).catch(() => {})
    }, [loadDaemonMetadata, machineEntry, machineId])

    useDaemonMachineRuntimeSubscription(
        machineId && activeTab === 'overview' ? [machineId] : [],
        { enabled: activeTab === 'overview', intervalMs: 15_000 },
    )

    const handleBack = () => {
        if (isStandalone) {
            navigate('/dashboard', {
                state: { mobileSection: 'machines' as const },
            })
            return
        }
        navigate('/machines')
    }

    // ─── Actions hook ────────────────────────────────
    const actions = useMachineActions({
        machineId,
        registeredMachineId: machineEntry?.machineId || null,
        sendDaemonCommand,
        onNicknameSynced,
        logsEndRef,
    })

    // ─── Setup Toast Listener ────────────────────────
    useEffect(() => {
        const unsubToast = eventManager.onToast((toast: ToastConfig) => {
            daemonCtx.setToasts((prev) => {
                // Dedup
                const isDup = prev.some(t => t.message === toast.message && (toast.timestamp - t.timestamp) < 3000)
                if (isDup) return prev
                const newToast = {
                    id: toast.id, message: toast.message, type: toast.type,
                    timestamp: toast.timestamp, targetKey: toast.targetKey,
                    actions: toast.actions,
                }
                return [...prev.slice(-4), newToast]
            })
            const dur = toast.duration || 5000
            setTimeout(() => daemonCtx.setToasts((prev) => prev.filter(t => t.id !== toast.id)), dur)
        })
        return unsubToast
    }, [daemonCtx])

    // ─── Derive machine data ─────────────────────────
    // Build provider info from daemon
    const providers: ProviderInfo[] = machineEntry?.availableProviders || []
    const providerIconMap: Record<string, string> = {}
    for (const p of providers) { providerIconMap[p.type] = p.icon }
    const getIcon = (type: string) => providerIconMap[type] || ''

    const machine: MachineData | null = machineEntry ? {
        id: machineEntry.id,
        hostname: getMachineHostnameLabel(machineEntry, { fallbackId: machineEntry.id }),
        platform: machineEntry.machine?.platform || 'unknown',
        arch: machineEntry.machine?.arch || '',
        cpus: machineEntry.machine?.cpus || 0,
        totalMem: machineEntry.machine?.totalMem || 0,
        freeMem: machineEntry.machine?.freeMem,
        availableMem: machineEntry.machine?.availableMem,
        loadavg: machineEntry.machine?.loadavg,
        uptime: machineEntry.machine?.uptime,
        release: machineEntry.machine?.release || '',
        cdpConnected: !!machineEntry.cdpConnected,
        machineNickname: machineEntry.machineNickname || null,
        p2p: machineEntry.p2p
            ? { screenshotActive: false, ...machineEntry.p2p }
            : { available: false, state: 'unavailable', peers: 0, screenshotActive: false },
        detectedIdes: machineEntry.detectedIdes || [],
        workspaces: machineEntry.workspaces || [],
        defaultWorkspaceId: machineEntry.defaultWorkspaceId ?? machineEntry.activeWorkspaceId ?? null,
        defaultWorkspacePath: machineEntry.defaultWorkspacePath ?? machineEntry.activeWorkspacePath ?? null,
    } : null

    const ideSessions: IdeSessionEntry[] = allIdes
        .filter(i => i.daemonId === machineId && i.type !== 'adhdev-daemon')
        .filter(i => !isCliEntry(i) && !isAcpEntry(i))
        .map(i => ({
            id: i.id, sessionId: i.sessionId, type: i.type, version: i.version || '',
            instanceId: i.instanceId || '', status: i.status,
            workspace: i.workspace || null,
            terminals: i.terminals || 0,
            aiAgents: dedupeAgents(
                i.aiAgents
                    || (i.agents || []).map((agent) => ({
                        id: agent.name,
                        name: agent.name,
                        status: agent.status,
                        version: agent.version,
                    })),
            ),
            activeChat: i.activeChat || null,
            chats: i.chats || [],
            childSessions: i.childSessions || [],
            cdpConnected: i.cdpConnected || false,
            daemonId: machineId!,
        }))

    const cliSessions: CliSessionEntry[] = allIdes
        .filter(i => i.daemonId === machineId && isCliEntry(i))
        .map(i => ({
            id: i.id, sessionId: i.sessionId, type: i.type, cliName: i.cliName || i.type,
            status: i.status,
            workspace: i.workspace || '',
            activeChat: i.activeChat || null,
            providerSessionId: i.providerSessionId,
            mode: i.mode,
            runtimeKey: i.runtimeKey,
            runtimeDisplayName: i.runtimeDisplayName,
            runtimeWorkspaceLabel: i.runtimeWorkspaceLabel,
            runtimeWriteOwner: i.runtimeWriteOwner || null,
            runtimeAttachedClients: i.runtimeAttachedClients || [],
            daemonId: machineId!,
        }))

    const acpSessions: AcpSessionEntry[] = allIdes
        .filter(i => i.daemonId === machineId && isAcpEntry(i))
        .map(i => ({
            id: i.id, sessionId: i.sessionId, type: i.type, acpName: i.cliName || i.type,
            status: i.status,
            workspace: i.workspace || '',
            activeChat: i.activeChat || null,
            providerSessionId: i.providerSessionId,
            currentModel: i.currentModel,
            currentPlan: i.currentPlan,
            daemonId: machineId!,
        }))

    const displayName = machineEntry ? getMachineDisplayName(machineEntry, { fallbackId: machineId }) : ''
    const defaultTab: TabId = 'workspace'
    const locationState = (location.state as {
        initialMachineTab?: TabId
        initialWorkspaceCategory?: 'ide' | 'cli' | 'acp'
        initialWorkspaceId?: string | null
        initialWorkspacePath?: string | null
    } | null)
    const requestedMachineTab = locationState?.initialMachineTab
    const requestedWorkspaceCategory = locationState?.initialWorkspaceCategory
    const requestedWorkspaceId = locationState?.initialWorkspaceId
    const requestedWorkspacePath = locationState?.initialWorkspacePath
    const effectiveTab: TabId = requestedMachineTab === 'ides' || requestedMachineTab === 'clis' || requestedMachineTab === 'acps'
        ? 'workspace'
        : (requestedMachineTab || defaultTab)
    const initialWorkspaceCategory = requestedMachineTab === 'ides'
        ? 'ide'
        : requestedMachineTab === 'clis'
            ? 'cli'
            : requestedMachineTab === 'acps'
                ? 'acp'
                : requestedWorkspaceCategory
    const fallbackRecentLaunches: MachineRecentLaunch[] = [
        ...ideSessions.map(session => ({
            id: `ide:${session.type}:${session.workspace || ''}`,
            label: session.activeChat?.title || session.type,
            kind: 'ide' as const,
            providerType: session.type,
            subtitle: session.workspace || undefined,
            workspace: session.workspace || undefined,
            timestamp: session.activeChat?.messages?.at?.(-1)?.timestamp || 0,
        })),
        ...cliSessions.map(session => ({
            id: `cli:${session.type}:${session.workspace || ''}`,
            label: session.activeChat?.title || session.cliName,
            kind: 'cli' as const,
            providerType: session.type,
            providerSessionId: session.providerSessionId,
            subtitle: session.workspace || undefined,
            workspace: session.workspace || undefined,
            timestamp: session.activeChat?.messages?.at?.(-1)?.timestamp || 0,
        })),
        ...acpSessions.map(session => ({
            id: `acp:${session.type}:${session.workspace || ''}`,
            label: session.activeChat?.title || session.acpName,
            kind: 'acp' as const,
            providerType: session.type,
            providerSessionId: session.providerSessionId,
            subtitle: session.currentModel || session.workspace || undefined,
            workspace: session.workspace || undefined,
            currentModel: session.currentModel,
            timestamp: session.activeChat?.messages?.at?.(-1)?.timestamp || 0,
        })),
    ]
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(({ timestamp, ...session }) => session)
    const recentLaunches: MachineRecentLaunch[] = (machineEntry?.recentLaunches || []).length > 0
        ? (machineEntry?.recentLaunches || []).map((launch) => ({
            id: launch.id,
            label: launch.title || launch.providerName || launch.providerType,
            kind: launch.kind,
            providerType: launch.providerType,
            providerSessionId: launch.providerSessionId,
            subtitle: launch.currentModel || launch.workspace || undefined,
            workspace: launch.workspace,
            currentModel: launch.currentModel,
        }))
        : fallbackRecentLaunches
    const currentConversations = useMemo<ActiveConversation[]>(() => {
        const connectionState = daemonCtx.connectionStates?.[machineId || ''] || undefined
        return allIdes
            .filter(entry => entry.daemonId === machineId && entry.type !== 'adhdev-daemon')
            .flatMap(entry => buildScopedIdeConversations(entry, {}, {
                connectionStates: machineId && connectionState ? { [machineId]: connectionState } : undefined,
                defaultConnectionState: connectionState,
            }))
            .filter(conversation => !(conversation.transport === 'pty' && conversation.mode === 'terminal'))
            .sort((left, right) => getConversationActivityAt(right) - getConversationActivityAt(left))
    }, [allIdes, daemonCtx.connectionStates, machineId])

    const handleOpenConversation = useCallback((conversation: ActiveConversation) => {
        const targetKey = conversation.sessionId || conversation.tabKey
        if (!targetKey) return
        navigate(`/dashboard?activeTab=${encodeURIComponent(targetKey)}`)
    }, [navigate])

    const handleConfirmRecentLaunch = useCallback(() => {
        if (!recentLaunchActionRef.current) return
        setRecentLaunchBusy(true)
        void recentLaunchActionRef.current()
            .finally(() => {
                recentLaunchActionRef.current = null
                setRecentLaunchBusy(false)
                setRecentLaunchConfirm(null)
            })
    }, [])

    const handleOpenRecent = useCallback((session: MachineRecentLaunch) => {
        if (!machine) return
        const { options, selectedKey } = buildLaunchWorkspaceOptions({
            machine,
            currentWorkspacePath: session.workspace,
        })
        const openWorkspaceFallback = async () => {
            setWorkspaceCategoryHint(session.kind)
            setActiveTab('workspace')
        }
        recentLaunchActionRef.current = async () => {
            const selectedWorkspace = options.find(option => option.key === recentLaunchWorkspaceKeyRef.current)
            const workspacePath = selectedWorkspace?.workspacePath ?? null
            const workspaceId = selectedWorkspace?.workspaceId ?? null
            if (session.kind === 'ide' && session.providerType) {
                await actions.handleLaunchIde(
                    session.providerType,
                    workspacePath ? { workspace: workspacePath } : undefined,
                )
                return
            }
            if ((session.kind === 'cli' || session.kind === 'acp') && session.providerType) {
                await actions.runLaunchCliCore({
                    cliType: session.providerType,
                    dir: workspaceId ? undefined : (workspacePath || ''),
                    workspaceId: workspaceId || undefined,
                    model: session.kind === 'acp' ? session.currentModel : undefined,
                    resumeSessionId: session.providerSessionId,
                })
                return
            }
            await openWorkspaceFallback()
        }
        recentLaunchWorkspaceKeyRef.current = selectedKey
        setRecentLaunchWorkspaceKey(selectedKey)
        setRecentLaunchConfirm({
            title: `Launch ${session.label}?`,
            description: 'Recent launches now require one more confirmation before they start.',
            confirmLabel: 'Launch',
            workspaceOptions: options,
            details: [
                { label: 'Mode', value: session.kind.toUpperCase() },
                ...(session.providerType ? [{ label: 'Provider', value: session.providerType }] : []),
            ],
        })
    }, [actions, machine])

    useEffect(() => {
        setActiveTab(effectiveTab)
    }, [defaultTab, effectiveTab, machineId])

    useEffect(() => {
        if (initialWorkspaceCategory) {
            setWorkspaceCategoryHint(initialWorkspaceCategory)
        }
    }, [initialWorkspaceCategory, machineId])

    // ─── Loading / Not Found ─────────────────────────
    if (!machine) {
        if (!initialLoaded) {
            return <div className="p-10 text-center text-text-muted"><p>⏳ Loading machine...</p></div>
        }
        return (
            <div className="p-10 text-center text-text-muted">
                <h2 className="text-text-primary">Machine not found</h2>
                <p className="mt-3">The machine may be offline or not yet connected.</p>
                <button onClick={handleBack} className="machine-btn-back">← Back</button>
            </div>
        )
    }

    const TABS: { id: TabId; label: string | ReactNode; count?: number }[] = [
        { id: 'workspace', label: <span className="flex items-center gap-1.5"><IconMonitor size={14} /> Workspace</span>, count: ideSessions.length + cliSessions.length + acpSessions.length },
        { id: 'session-host', label: <span className="flex items-center gap-1.5"><IconServer size={14} /> Session Host</span> },
        { id: 'providers', label: <span className="flex items-center gap-1.5"><IconSettings size={14} /> Providers</span> },
        { id: 'overview', label: <span className="flex items-center gap-1.5"><IconBarChart size={14} /> System</span> },
        { id: 'logs', label: <span className="flex items-center gap-1.5"><IconClipboard size={14} /> Logs</span> },
    ]

    return (
        <div className="flex flex-col h-full">
            {/* ═══ Header ═══ */}
            <div className="flex flex-col w-full bg-bg-surface px-4 md:px-8 pt-6 pb-0 shrink-0 border-b border-[#ffffff0a]">
                <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-3 w-full min-w-0">
                        <button onClick={handleBack} className="flex items-center justify-center w-8 h-8 rounded-full bg-[#ffffff0a] hover:bg-[#ffffff14] text-text-muted hover:text-text-primary transition-colors shrink-0">
                            ←
                        </button>
                        <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-3">
                                {!actions.editingNickname ? (
                                    <h1
                                        className="text-xl md:text-2xl font-bold text-text-primary cursor-pointer truncate hover:text-accent-primary transition-colors"
                                        onClick={() => { actions.setEditingNickname(true); actions.setNicknameInput(machine.machineNickname || '') }}
                                        title="Click to set nickname"
                                    >
                                        {displayName}
                                    </h1>
                                ) : (
                                    <div className="flex gap-1.5 items-center">
                                        <input
                                            autoFocus
                                            value={actions.nicknameInput}
                                            onChange={e => actions.setNicknameInput(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') actions.handleSaveNickname(); if (e.key === 'Escape') actions.setEditingNickname(false) }}
                                            placeholder="Machine nickname..."
                                            className="px-2.5 py-1 rounded-md border border-violet-500/30 bg-bg-secondary text-text-primary text-sm font-semibold w-[140px] md:w-[200px]"
                                        />
                                        <button onClick={actions.handleSaveNickname} className="flex items-center justify-center px-3 py-1 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 text-sm font-medium transition-colors">Save</button>
                                        <button onClick={() => actions.setEditingNickname(false)} className="flex items-center justify-center px-3 py-1 rounded bg-[#ffffff0a] text-text-muted hover:bg-[#ffffff14] hover:text-text-primary text-sm font-medium transition-colors">Cancel</button>
                                    </div>
                                )}
                                <span className="w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] shrink-0" />
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 items-center mt-1.5 text-xs text-text-secondary opacity-80">
                                <span className="font-mono bg-[#ffffff08] px-1.5 py-0.5 rounded">{machine.platform} · {machine.arch}</span>
                                <span>{machine.cpus} cores</span>
                                {machineEntry?.version && <span>v{machineEntry.version}</span>}
                                {machine.p2p.available && (
                                    <span>P2P {machine.p2p.state === 'connected' ? 'connected' : machine.p2p.state}</span>
                                )}
                                {machine.machineNickname && (
                                    <span className="text-text-muted opacity-60 shrink-0">{machine.hostname}</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Tabs */}
                {/* Tabs */}
                <div className="flex overflow-x-auto overflow-y-hidden mt-4 gap-6 px-1 border-b border-[#ffffff0a]">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`pb-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 px-1 whitespace-nowrap ${
                                activeTab === tab.id
                                    ? 'border-accent-primary text-accent-primary'
                                    : 'border-transparent text-text-secondary hover:text-text-primary'
                            }`}
                        >
                            {tab.label}
                            {tab.count !== undefined && (
                                <span className={`px-1.5 py-0.5 rounded-full text-[10px] ml-1 ${
                                    activeTab === tab.id ? 'bg-accent-primary/20 text-accent-primary' : 'bg-[#ffffff10] text-text-muted'
                                }`}>
                                    {tab.count}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

            </div>

            {/* ═══ Content ═══ */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 py-6">
                <div className="max-w-7xl mx-auto h-full">
                    <div className="h-full">
                        {activeTab === 'workspace' && (
                            <div className="flex flex-col md:flex-row gap-6 md:gap-10 h-full">
                                <MachineCommandCenter
                                    machineEntry={machineEntry!}
                                    providers={providers}
                                    recentLaunches={recentLaunches}
                                    currentConversations={currentConversations}
                                    onUpgradeDaemon={async () => {
                                        try { await sendDaemonCommand(machineId!, 'daemon_upgrade', {}) } catch {}
                                    }}
                                    onOpenRecent={handleOpenRecent}
                                    onOpenConversation={handleOpenConversation}
                                />
                                <MachineWorkspaceTab
                                    machine={machine}
                                    machineId={machineId!}
                                    providers={providers}
                                    ideSessions={ideSessions}
                                    cliSessions={cliSessions}
                                    acpSessions={acpSessions}
                                actions={actions}
                                getIcon={getIcon}
                                initialCategory={workspaceCategoryHint}
                                initialWorkspaceId={requestedWorkspaceId}
                                initialWorkspacePath={requestedWorkspacePath}
                                sendDaemonCommand={sendDaemonCommand}
                                />
                            </div>
                        )}

                        {activeTab === 'providers' && (
                            <ProvidersTab
                                machineId={machineId!}
                                providers={providers}
                                sendDaemonCommand={sendDaemonCommand}
                            />
                        )}

                        {activeTab === 'overview' && (
                            <OverviewTab
                                machineId={machineId!}
                                machine={machine}
                                ideSessions={ideSessions}
                                cliSessions={cliSessions}
                                acpSessions={acpSessions}
                                actions={actions}
                                sendDaemonCommand={sendDaemonCommand}
                            />
                        )}

                        {activeTab === 'session-host' && (
                            <SessionHostPanel
                                machineId={machineId!}
                                cliSessions={cliSessions}
                                sendDaemonCommand={sendDaemonCommand}
                            />
                        )}

                        {activeTab === 'logs' && (
                            <LogsTab
                                machineId={machineId!}
                                sendDaemonCommand={sendDaemonCommand}
                            />
                        )}
                    </div>
                </div>
            </div>

            {actions.launchPick && machine && (
                <LaunchPickModal
                    machine={machine}
                    launchPick={actions.launchPick}
                    actions={actions}
                />
            )}
            {recentLaunchConfirm && (
                <LaunchConfirmDialog
                    title={recentLaunchConfirm.title}
                    description={recentLaunchConfirm.description}
                    details={recentLaunchConfirm.details}
                    workspaceOptions={recentLaunchConfirm.workspaceOptions}
                    selectedWorkspaceKey={recentLaunchWorkspaceKey}
                    onWorkspaceChange={(key) => {
                        recentLaunchWorkspaceKeyRef.current = key
                        setRecentLaunchWorkspaceKey(key)
                    }}
                    confirmLabel={recentLaunchConfirm.confirmLabel}
                    busy={recentLaunchBusy}
                    onConfirm={handleConfirmRecentLaunch}
                    onCancel={() => {
                        recentLaunchActionRef.current = null
                        setRecentLaunchConfirm(null)
                    }}
                />
            )}

            {/* Toast Notifications */}
            <ToastContainer
                toasts={daemonCtx.toasts || []}
                onDismiss={(id) => daemonCtx.setToasts((prev) => prev.filter(t => t.id !== id))}
                onClickToast={(toast) => {
                    if (toast.targetKey) {
                        navigate(`/dashboard?activeTab=${encodeURIComponent(toast.targetKey)}`)
                    }
                }}
            />
            <style>{`
            @keyframes toast-in {
                from { opacity: 0; transform: translateX(40px); }
                to { opacity: 1; transform: translateX(0); }
            }
            `}</style>
        </div>
    )
}
