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
import { useState, useRef, useEffect } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import { useHiddenTabs } from '../hooks/useHiddenTabs'
import type { DaemonData } from '../types'
import { isCliEntry, isAcpEntry, dedupeAgents, getMachineDisplayName, getMachineHostnameLabel } from '../utils/daemon-utils'
import { IconBarChart, IconMonitor, IconSettings, IconClipboard } from '../components/Icons'
import type { ReactNode } from 'react'
import { eventManager, type ToastConfig } from '../managers/EventManager'
import ToastContainer from '../components/dashboard/ToastContainer'

// Machine sub-components
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry, MachineRecentLaunch, TabId, ProviderInfo } from './machine/types'
import { useMachineActions } from './machine/useMachineActions'
import OverviewTab from './machine/OverviewTab'
import ProvidersTab from './machine/ProvidersTab'
import LogsTab from './machine/LogsTab'
import LaunchPickModal from './machine/LaunchPickModal'
import MachineCommandCenter from './machine/MachineCommandCenter'
import MachineWorkspaceTab from './machine/MachineWorkspaceTab'

// ─── Component ───────────────────────────────────────
interface MachineDetailProps {
    onNicknameSynced?: (args: { machineRuntimeId: string; registeredMachineId?: string | null; nickname: string }) => Promise<void>
}

export default function MachineDetail({ onNicknameSynced }: MachineDetailProps = {}) {
    const { id: machineId } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const location = useLocation()
    const { sendCommand: sendDaemonCommand } = useTransport()
    const daemonCtx = useDaemons() as any
    const allIdes: DaemonData[] = daemonCtx.ides || []
    const initialLoaded: boolean = daemonCtx.initialLoaded ?? true
    const { isHidden, toggleTab } = useHiddenTabs()
    const machineEntry = allIdes.find(i => i.id === machineId && (i as any).daemonMode)
    const [activeTab, setActiveTab] = useState<TabId>('workspace')
    const [workspaceCategoryHint, setWorkspaceCategoryHint] = useState<'ide' | 'cli' | 'acp'>('ide')
    const logsEndRef = useRef<HTMLDivElement>(null)

    // ─── Actions hook ────────────────────────────────
    const actions = useMachineActions({
        machineId,
        registeredMachineId: (machineEntry as any)?.machineId || null,
        sendDaemonCommand,
        onNicknameSynced,
        logsEndRef,
    })

    // ─── Setup Toast Listener ────────────────────────
    useEffect(() => {
        const unsubToast = eventManager.onToast((toast: ToastConfig) => {
            daemonCtx.setToasts((prev: any[]) => {
                // Dedup
                const isDup = prev.some(t => t.message === toast.message && (toast.timestamp - t.timestamp) < 3000)
                if (isDup) return prev
                const newToast = {
                    id: toast.id, message: toast.message, type: toast.type,
                    timestamp: toast.timestamp, targetKey: toast.targetKey,
                    actions: toast.actions as any,
                }
                return [...prev.slice(-4), newToast]
            })
            const dur = toast.duration || 5000
            setTimeout(() => daemonCtx.setToasts((prev: any[]) => prev.filter(t => t.id !== toast.id)), dur)
        })
        return unsubToast
    }, [daemonCtx])

    // ─── Derive machine data ─────────────────────────
    // Build provider info from daemon
    const providers: ProviderInfo[] = (((machineEntry as any)?.availableProviders || []) as ProviderInfo[])
    const providerIconMap: Record<string, string> = {}
    for (const p of providers) { providerIconMap[p.type] = p.icon }
    const getIcon = (type: string) => providerIconMap[type] || ''

    const machine: MachineData | null = machineEntry ? {
        id: machineEntry.id,
        hostname: getMachineHostnameLabel(machineEntry as any, { fallbackId: machineEntry.id }),
        platform: (machineEntry as any).machine?.platform || 'unknown',
        arch: (machineEntry as any).machine?.arch || '',
        cpus: (machineEntry as any).machine?.cpus || 0,
        totalMem: (machineEntry as any).machine?.totalMem || 0,
        freeMem: (machineEntry as any).machine?.freeMem || 0,
        availableMem: (machineEntry as any).machine?.availableMem,
        loadavg: (machineEntry as any).machine?.loadavg || [],
        uptime: (machineEntry as any).machine?.uptime || 0,
        release: (machineEntry as any).machine?.release || '',
        cdpConnected: !!(machineEntry as any).cdpConnected,
        machineNickname: (machineEntry as any).machineNickname || null,
        p2p: (machineEntry as any).p2p || { available: false, state: 'unavailable', peers: 0, screenshotActive: false },
        detectedIdes: (machineEntry as any).detectedIdes || [],
        workspaces: (machineEntry as any).workspaces || [],
        defaultWorkspaceId: (machineEntry as any).defaultWorkspaceId ?? (machineEntry as any).activeWorkspaceId ?? null,
        defaultWorkspacePath: (machineEntry as any).defaultWorkspacePath ?? (machineEntry as any).activeWorkspacePath ?? null,
    } : null

    const ideSessions: IdeSessionEntry[] = allIdes
        .filter(i => (i as any).daemonId === machineId && !(i as any).daemonMode)
        .filter(i => !isCliEntry(i) && !isAcpEntry(i))
        .map(i => ({
            id: i.id, sessionId: i.sessionId, type: i.type, version: i.version || '',
            instanceId: (i as any).instanceId || '', status: i.status,
            workspace: (i as any).workspace || null,
            terminals: (i as any).terminals || 0,
            aiAgents: dedupeAgents((i as any).aiAgents || i.agents || []),
            activeChat: (i as any).activeChat || null,
            chats: (i as any).chats || [],
            childSessions: (i as any).childSessions || [],
            cdpConnected: (i as any).cdpConnected || false,
            daemonId: machineId!,
        }))

    const cliSessions: CliSessionEntry[] = allIdes
        .filter(i => (i as any).daemonId === machineId && isCliEntry(i))
        .map(i => ({
            id: i.id, sessionId: i.sessionId, type: i.type, cliName: (i as any).cliName || i.type,
            status: i.status,
            workspace: (i as any).workspace || '',
            activeChat: (i as any).activeChat || null,
            daemonId: machineId!,
        }))

    const acpSessions: AcpSessionEntry[] = allIdes
        .filter(i => (i as any).daemonId === machineId && isAcpEntry(i))
        .map(i => ({
            id: i.id, sessionId: i.sessionId, type: i.type, acpName: (i as any).cliName || i.type,
            status: i.status,
            workspace: (i as any).workspace || '',
            activeChat: (i as any).activeChat || null,
            currentModel: (i as any).currentModel,
            currentPlan: (i as any).currentPlan,
            daemonId: machineId!,
        }))

    // ─── Loading / Not Found ─────────────────────────
    if (!machine) {
        if (!initialLoaded) {
            return <div className="p-10 text-center text-text-muted"><p>⏳ Loading machine...</p></div>
        }
        return (
            <div className="p-10 text-center text-text-muted">
                <h2 className="text-text-primary">Machine not found</h2>
                <p className="mt-3">The machine may be offline or not yet connected.</p>
                <button onClick={() => navigate('/machines')} className="machine-btn-back">← Back to Burrows</button>
            </div>
        )
    }

    const displayName = getMachineDisplayName(machineEntry as any, { fallbackId: machine.id })
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
            subtitle: session.workspace || undefined,
            workspace: session.workspace || undefined,
            timestamp: session.activeChat?.messages?.at?.(-1)?.timestamp || 0,
        })),
        ...acpSessions.map(session => ({
            id: `acp:${session.type}:${session.workspace || ''}`,
            label: session.activeChat?.title || session.acpName,
            kind: 'acp' as const,
            providerType: session.type,
            subtitle: session.currentModel || session.workspace || undefined,
            workspace: session.workspace || undefined,
            currentModel: session.currentModel,
            timestamp: session.activeChat?.messages?.at?.(-1)?.timestamp || 0,
        })),
    ]
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(({ timestamp, ...session }) => session)
    const recentLaunches: MachineRecentLaunch[] = ((machineEntry as any).recentLaunches || []).length > 0
        ? ((machineEntry as any).recentLaunches as any[]).map((launch) => ({
            id: launch.id,
            label: launch.title || launch.providerName || launch.providerType,
            kind: launch.kind,
            providerType: launch.providerType,
            subtitle: launch.currentModel || launch.workspace || undefined,
            workspace: launch.workspace,
            currentModel: launch.currentModel,
        }))
        : fallbackRecentLaunches

    const handleOpenRecent = async (session: MachineRecentLaunch) => {
        if (session.kind === 'ide' && session.providerType) {
            await actions.handleLaunchIde(
                session.providerType,
                session.workspace ? { workspace: session.workspace } : undefined,
            )
            return
        }
        if ((session.kind === 'cli' || session.kind === 'acp') && session.providerType) {
            await actions.runLaunchCliCore({
                cliType: session.providerType,
                dir: session.workspace || '',
                model: session.kind === 'acp' ? session.currentModel : undefined,
            })
            return
        }
        setWorkspaceCategoryHint(session.kind)
        setActiveTab('workspace')
    }

    useEffect(() => {
        setActiveTab(effectiveTab)
    }, [defaultTab, effectiveTab, machine.id])

    useEffect(() => {
        if (initialWorkspaceCategory) {
            setWorkspaceCategoryHint(initialWorkspaceCategory)
        }
    }, [initialWorkspaceCategory, machine.id])

    const TABS: { id: TabId; label: string | ReactNode; count?: number }[] = [
        { id: 'workspace', label: <span className="flex items-center gap-1.5"><IconMonitor size={14} /> Workspace</span>, count: ideSessions.length + cliSessions.length + acpSessions.length },
        { id: 'providers', label: <span className="flex items-center gap-1.5"><IconSettings size={14} /> Providers</span> },
        { id: 'overview', label: <span className="flex items-center gap-1.5"><IconBarChart size={14} /> System</span> },
        { id: 'logs', label: <span className="flex items-center gap-1.5"><IconClipboard size={14} /> Logs</span> },
    ]

    return (
        <div className="flex flex-col h-full">
            {/* ═══ Header ═══ */}
            <div className="dashboard-header machine-detail-header !flex-col !items-stretch">
                <div className="flex items-center justify-between w-full">
                    <div className="machine-detail-header-row flex items-center gap-2 md:gap-3.5 w-full min-w-0">
                        <button onClick={() => navigate('/machines')} className="machine-btn-back flex shrink-0">
                            ←
                        </button>
                        <div className="machine-detail-title-wrap min-w-0">
                            <div className="flex items-center gap-2">
                                {!actions.editingNickname ? (
                                    <h1
                                        className="header-title cursor-pointer truncate"
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
                                        <button onClick={actions.handleSaveNickname} className="machine-btn text-green-500 border-green-500/30 shrink-0">✓</button>
                                        <button onClick={() => actions.setEditingNickname(false)} className="machine-btn shrink-0">✕</button>
                                    </div>
                                )}
                                <span className="status-dot-md online shrink-0" />
                            </div>
                            <div className="header-subtitle machine-detail-subtitle mt-1 flex-wrap gap-1 md:gap-2 items-center display-none-mobile">
                                <span>{machine.platform} · {machine.arch}</span>
                                <span>{machine.cpus} cores</span>
                                {(machineEntry as any)?.version && <span>v{(machineEntry as any).version}</span>}
                                {machine.p2p.available && (
                                    <span>P2P {machine.p2p.state === 'connected' ? 'connected' : machine.p2p.state}</span>
                                )}
                                {machine.cdpConnected && <span>CDP ready</span>}
                                {machine.machineNickname && (
                                    <span className="text-text-muted opacity-80 shrink-0">{machine.hostname}</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Tabs */}
                <div className="machine-tabs w-full overflow-x-auto overflow-y-hidden pb-1 -mb-1 mt-2">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`machine-tab shrink-0${activeTab === tab.id ? ' active' : ''}`}
                        >
                            {tab.label}
                            {tab.count !== undefined && (
                                <span className="tab-count">{tab.count}</span>
                            )}
                        </button>
                        ))}
                    </div>

            </div>

            {/* ═══ Content ═══ */}
            <div className="page-content">
                <div className="machine-page-shell">
                    <div className="machine-tab-panel">
                        {activeTab === 'workspace' && (
                            <div className="machine-workspace-panel">
                                <MachineCommandCenter
                                    machineEntry={machineEntry as DaemonData}
                                    providers={providers}
                                    recentLaunches={recentLaunches}
                                    onUpgradeDaemon={async () => {
                                        try { await sendDaemonCommand(machineId!, 'daemon_upgrade', {}) } catch {}
                                    }}
                                    onOpenLogs={() => setActiveTab('logs')}
                                    onOpenRecent={handleOpenRecent}
                                    onOpenWorkspace={(kind) => {
                                        setWorkspaceCategoryHint(kind)
                                        setActiveTab('workspace')
                                    }}
                                    onGoTab={setActiveTab}
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
                                isDashboardHidden={isHidden}
                                onToggleDashboardVisibility={toggleTab}
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
                                machine={machine}
                                ideSessions={ideSessions}
                                cliSessions={cliSessions}
                                acpSessions={acpSessions}
                                actions={actions}
                                isDashboardHidden={isHidden}
                                onToggleDashboardVisibility={toggleTab}
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

            {/* Toast Notifications */}
            <ToastContainer
                toasts={daemonCtx.toasts || []}
                onDismiss={(id) => daemonCtx.setToasts((prev: any[]) => prev.filter(t => t.id !== id))}
                onClickToast={(toast) => {
                    if (toast.targetKey) {
                        // Switch to the appropriate tab depending on the agent type if we had enough context,
                        // but for now we just let the user see the notification.
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
