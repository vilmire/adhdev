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
import { useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import { isCliEntry, isAcpEntry, dedupeAgents } from '../utils/daemon-utils'
import { IconBarChart, IconMonitor, IconPlug, IconBot, IconSettings, IconClipboard } from '../components/Icons'
import type { ReactNode } from 'react'

// Machine sub-components
import type { MachineData, ManagedIde, ManagedCli, ManagedAcp, TabId, ProviderInfo } from './machine/types'
import { useMachineActions } from './machine/useMachineActions'
import OverviewTab from './machine/OverviewTab'
import AgentTab from './machine/AgentTab'
import ProvidersTab from './machine/ProvidersTab'
import LogsTab from './machine/LogsTab'
import LaunchPickModal from './machine/LaunchPickModal'

// ─── Component ───────────────────────────────────────
export default function MachineDetail() {
    const { id: machineId } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const { sendCommand: sendDaemonCommand } = useTransport()
    const daemonCtx = useDaemons() as any
    const allIdes: DaemonData[] = daemonCtx.ides || []
    const initialLoaded: boolean = daemonCtx.initialLoaded ?? true
    const [activeTab, setActiveTab] = useState<TabId>('overview')
    const logsEndRef = useRef<HTMLDivElement>(null)

    // ─── Actions hook ────────────────────────────────
    const actions = useMachineActions({
        machineId, sendDaemonCommand, logsEndRef,
    })

    // ─── Derive machine data ─────────────────────────
    const machineEntry = allIdes.find(i => i.id === machineId && (i as any).daemonMode)

    // Build provider info from daemon
    const providers: ProviderInfo[] = ((machineEntry as any)?.availableProviders || []).map((p: any) => ({
        type: p.type, displayName: p.displayName, icon: p.icon, category: p.category,
    }))
    const providerIconMap: Record<string, string> = {}
    for (const p of providers) { providerIconMap[p.type] = p.icon }
    const getIcon = (type: string) => providerIconMap[type] || ''

    const machine: MachineData | null = machineEntry ? {
        id: machineEntry.id,
        hostname: (machineEntry as any).machine?.hostname || machineEntry.id,
        platform: (machineEntry as any).machine?.platform || 'unknown',
        arch: (machineEntry as any).machine?.arch || '',
        cpus: (machineEntry as any).machine?.cpus || 0,
        totalMem: (machineEntry as any).machine?.totalMem || 0,
        freeMem: (machineEntry as any).machine?.freeMem || 0,
        availableMem: (machineEntry as any).machine?.availableMem,
        loadavg: (machineEntry as any).machine?.loadavg || [],
        uptime: (machineEntry as any).machine?.uptime || 0,
        release: (machineEntry as any).machine?.release || '',
        cdpConnected: !!((machineEntry as any).ides || []).some((i: any) => i.cdpConnected),
        machineNickname: (machineEntry as any).machineNickname || null,
        p2p: (machineEntry as any).p2p || { available: false, state: 'unavailable', peers: 0, screenshotActive: false },
        detectedIdes: (machineEntry as any).detectedIdes || [],
        managedIdeIds: (machineEntry as any).managedIdeIds || [],
        managedCliIds: (machineEntry as any).managedCliIds || [],
        workspaces: (machineEntry as any).workspaces || [],
        defaultWorkspaceId: (machineEntry as any).defaultWorkspaceId ?? (machineEntry as any).activeWorkspaceId ?? null,
        defaultWorkspacePath: (machineEntry as any).defaultWorkspacePath ?? (machineEntry as any).activeWorkspacePath ?? null,
        workspaceActivity: (machineEntry as any).workspaceActivity || [],
    } : null

    const managedIdes: ManagedIde[] = allIdes
        .filter(i => (i as any).daemonId === machineId && !(i as any).daemonMode)
        .filter(i => !isCliEntry(i) && !isAcpEntry(i))
        .map(i => ({
            id: i.id, type: i.type, version: i.version || '',
            instanceId: (i as any).instanceId || '', status: i.status,
            workspace: (i as any).workspace || null,
            terminals: (i as any).terminals || 0,
            aiAgents: dedupeAgents((i as any).aiAgents || i.agents || []),
            activeChat: (i as any).activeChat || null,
            chats: (i as any).chats || [],
            agentStreams: (i as any).agentStreams || [],
            cdpConnected: (i as any).cdpConnected || false,
            daemonId: machineId!,
        }))

    const managedClis: ManagedCli[] = allIdes
        .filter(i => (i as any).daemonId === machineId && isCliEntry(i))
        .map(i => ({
            id: i.id, type: i.type, cliName: (i as any).cliName || i.type,
            status: i.status,
            workspace: (i as any).workspace || '',
            activeChat: (i as any).activeChat || null,
            daemonId: machineId!,
        }))

    const managedAcps: ManagedAcp[] = allIdes
        .filter(i => (i as any).daemonId === machineId && isAcpEntry(i))
        .map(i => ({
            id: i.id, type: i.type, acpName: (i as any).cliName || i.type,
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

    const displayName = machine.machineNickname || machine.hostname

    const TABS: { id: TabId; label: string | ReactNode; count?: number }[] = [
        { id: 'overview', label: <span className="flex items-center gap-1.5"><IconBarChart size={14} /> Overview</span> },
        { id: 'ides', label: <span className="flex items-center gap-1.5"><IconMonitor size={14} /> IDEs</span>, count: managedIdes.length },
        { id: 'clis', label: <span className="flex items-center gap-1.5"><IconPlug size={14} /> CLIs</span>, count: managedClis.length },
        { id: 'acps', label: <span className="flex items-center gap-1.5"><IconBot size={14} /> ACP Agents</span>, count: managedAcps.length },
        { id: 'providers', label: <span className="flex items-center gap-1.5"><IconSettings size={14} /> Providers</span> },
        { id: 'logs', label: <span className="flex items-center gap-1.5"><IconClipboard size={14} /> Logs</span> },
    ]

    return (
        <div className="flex flex-col h-full">
            {/* ═══ Header ═══ */}
            <div className="dashboard-header !flex-col !items-stretch">
                <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2 md:gap-3.5 w-full min-w-0">
                        <button onClick={() => navigate('/machines')} className="machine-btn-back flex shrink-0">
                            ←
                        </button>
                        <div className="min-w-0">
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
                            <div className="header-subtitle mt-1 flex-wrap gap-1 md:gap-2 items-center display-none-mobile">
                                <span>{machine.platform} · {machine.arch} · {machine.cpus} cores</span>
                                {(machineEntry as any)?.version && (
                                    <span className="px-1.5 py-px rounded text-[9px] font-semibold bg-bg-glass border border-border-subtle text-text-muted shrink-0">
                                        v{(machineEntry as any).version}
                                    </span>
                                )}
                                {(machineEntry as any)?.versionMismatch && (
                                    <button
                                        className="px-1.5 py-px rounded text-[9px] font-semibold bg-amber-500/[0.08] border border-amber-500/20 text-amber-400 cursor-pointer hover:bg-amber-500/[0.15] transition-colors shrink-0"
                                        onClick={async () => {
                                            try { await sendDaemonCommand(machineId!, 'daemon_upgrade', {}) } catch {}
                                        }}
                                    >
                                        🔄 Update to v{(machineEntry as any).serverVersion}
                                    </button>
                                )}
                                {machine.p2p.available && (
                                    <span
                                        className="px-1.5 py-px rounded text-[9px] font-semibold"
                                        style={{
                                            background: machine.p2p.state === 'connected' ? 'rgba(34,197,94,0.08)' : 'rgba(234,179,8,0.08)',
                                            color: machine.p2p.state === 'connected' ? '#22c55e' : '#eab308',
                                        }}
                                    >
                                        P2P {machine.p2p.state === 'connected' ? `● ${machine.p2p.peers}` : '○'}
                                    </span>
                                )}
                                {machine.cdpConnected && (
                                    <span className="px-1.5 py-px rounded text-[9px] font-semibold bg-green-500/[0.08] text-green-500 shrink-0">
                                        CDP ●
                                    </span>
                                )}
                                {machine.machineNickname && (
                                    <span className="text-text-muted opacity-80 shrink-0">({machine.hostname})</span>
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
                {activeTab === 'overview' && (
                    <OverviewTab
                        machine={machine}
                        managedIdes={managedIdes}
                        managedClis={managedClis}
                        managedAcps={managedAcps}
                        actions={actions}
                    />
                )}

                {activeTab === 'ides' && (
                    <AgentTab
                        category="ide"
                        machine={machine}
                        machineId={machineId!}
                        providers={providers}
                        managedEntries={managedIdes}
                        getIcon={getIcon}
                        actions={actions}
                        sendDaemonCommand={sendDaemonCommand}
                    />
                )}

                {activeTab === 'clis' && (
                    <AgentTab
                        category="cli"
                        machine={machine}
                        machineId={machineId!}
                        providers={providers}
                        managedEntries={managedClis}
                        getIcon={getIcon}
                        actions={actions}
                    />
                )}

                {activeTab === 'acps' && (
                    <AgentTab
                        category="acp"
                        machine={machine}
                        machineId={machineId!}
                        providers={providers}
                        managedEntries={managedAcps}
                        getIcon={getIcon}
                        actions={actions}
                    />
                )}

                {activeTab === 'providers' && (
                    <ProvidersTab
                        machineId={machineId!}
                        providers={providers}
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

            {actions.launchPick && machine && (
                <LaunchPickModal
                    machine={machine}
                    launchPick={actions.launchPick}
                    actions={actions}
                />
            )}
        </div>
    )
}
