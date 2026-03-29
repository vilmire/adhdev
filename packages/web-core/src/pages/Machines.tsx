import { useNavigate } from 'react-router-dom'
import { useDaemons } from '../compat'
import {
    buildProviderMaps, PLATFORM_ICONS,
    formatUptime, formatBytes,
    isAgentActive, groupByMachine,
} from '../utils/daemon-utils'
import ProgressBar from '../components/ProgressBar'
import ConnectionBadge from '../components/ConnectionBadge'
import InstallCommand from '../components/InstallCommand'
import { IconServer, IconMonitor } from '../components/Icons'
import { useHiddenTabs } from '../hooks/useHiddenTabs'

// ─── Compact Agent Row (replaces full IdeCard/CliCard) ──────────
function AgentRow({ icon, name, status, workspace, isActive, onClick, isHidden, onToggleVisibility }: {
    icon: string; name: string; status: string; workspace?: string
    isActive: boolean; onClick: () => void
    isHidden?: boolean; onToggleVisibility?: () => void
}) {
    return (
        <div
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all ${
                isHidden ? 'opacity-40' : ''
            } ${
                isActive ? 'bg-orange-500/[0.04] border border-orange-500/10' : 'bg-bg-glass border border-border-subtle'
            }`}
        >
            {onToggleVisibility && (
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleVisibility(); }}
                    className={`shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] transition-all ${
                        isHidden
                            ? 'bg-zinc-500/10 text-zinc-400 hover:bg-zinc-500/20'
                            : 'bg-violet-500/10 text-violet-400 hover:bg-violet-500/20'
                    }`}
                    title={isHidden ? 'Show on Dashboard' : 'Hide from Dashboard'}
                >
                    {isHidden ? '👁‍🗨' : '👁'}
                </button>
            )}
            <div
                onClick={(e) => { e.stopPropagation(); onClick() }}
                className="flex-1 flex items-center gap-2 cursor-pointer min-w-0"
            >
                <span className="text-sm">{icon}</span>
                <span className="font-semibold text-[11px] text-text-primary">{name}</span>
                {workspace && (
                    <span className="text-[9px] text-text-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-[100px]">{workspace}</span>
                )}
                <span className={`ml-auto flex items-center gap-1 text-[9px] font-medium ${isActive ? 'text-orange-400' : 'text-text-muted'}`}>
                    {isActive && <span>⚡</span>}
                    {status}
                </span>
                <span
                    className="w-[5px] h-[5px] rounded-full shrink-0"
                    style={{
                        background: isActive ? '#f97316' : status === 'stopped' ? '#ef4444' : '#22c55e',
                        animation: isActive ? 'pulse-dot 1.5s infinite' : 'none',
                    }}
                />
                <span className="text-[9px] text-text-muted">→</span>
            </div>
        </div>
    )
}

// ─── Page ────────────────────────────────────────────
export default function MachinesPage() {
    const navigate = useNavigate()
    const daemonCtx = useDaemons() as any
    const { ides: daemons } = daemonCtx
    const connectionStates = daemonCtx.connectionStates || {}
    const connectionTransports = daemonCtx.connectionTransports || {}
    const { icons: providerIcons, labels: providerLabels } = buildProviderMaps(daemons)
    const getIcon = (type: string) => providerIcons[type] || ''
    const machines = groupByMachine(daemons, providerLabels)
    const onlineCount = machines.filter(m => m.daemonIde.status === 'online').length
    const { isHidden, toggleTab } = useHiddenTabs()

    // Cross-machine active agents
    const allActiveAgents: { name: string; machine: string; machineId: string; status: string; type: string; targetId: string; isCli: boolean; workspace: string }[] = []
    for (const m of machines) {
        for (const ide of m.managedIdes) {
            if (isAgentActive(ide.agents, ide.agentStreams, ide.activeChat)) {
                const agentName = ide.agentStreams.find(s => s.status === 'streaming' || s.status === 'generating')?.agentName
                    || ide.agents.find(a => a.status === 'generating' || a.status === 'streaming')?.name
                    || ide.name
                allActiveAgents.push({
                    name: agentName, machine: m.nickname || m.hostname,
                    machineId: m.machineId, status: 'generating', type: ide.type,
                    targetId: ide.id, isCli: false,
                    workspace: ide.workspace || '',
                })
            }
        }
        for (const cli of m.managedClis) {
            if (cli.agentStreams?.some(s => s.status === 'streaming' || s.status === 'generating')) {
                allActiveAgents.push({
                    name: cli.cliName, machine: m.nickname || m.hostname,
                    machineId: m.machineId, status: 'generating', type: cli.cliType,
                    targetId: cli.id, isCli: true,
                    workspace: cli.workspace?.split('/').pop() || '',
                })
            }
        }
        for (const acp of m.managedAcps) {
            if (acp.agentStreams?.some(s => s.status === 'streaming' || s.status === 'generating')) {
                allActiveAgents.push({
                    name: acp.acpName, machine: m.nickname || m.hostname,
                    machineId: m.machineId, status: 'generating', type: acp.acpType,
                    targetId: acp.id, isCli: false,
                    workspace: acp.workspace?.split('/').pop() || '',
                })
            }
        }
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="dashboard-header">
                <div>
                    <h1 className="header-title flex items-center gap-2">
                        <IconServer size={20} /> Burrows
                    </h1>
                    <div className="header-subtitle flex gap-3 flex-wrap">
                        <span>{machines.length} burrow{machines.length !== 1 ? 's' : ''}</span>
                        <span className="text-green-500">● {onlineCount} online</span>
                        {allActiveAgents.length > 0 && (
                            <span className="text-orange-500">⚡ {allActiveAgents.length} agent{allActiveAgents.length > 1 ? 's' : ''} active</span>
                        )}
                    </div>
                </div>
            </div>

            <div className="page-content">

                {/* Cross-Machine Active Agents Feed */}
                {allActiveAgents.length > 0 && (
                    <div className="bg-bg-secondary border border-orange-500/10 rounded-xl px-4 py-3 mb-4">
                        <div className="text-[10px] text-text-muted uppercase tracking-wide font-bold mb-2 flex items-center gap-1.5">
                            <span
                                className="w-1.5 h-1.5 rounded-full bg-orange-500"
                                style={{ animation: 'pulse-dot 1.5s infinite' }}
                            />
                            Active Now
                        </div>
                        <div className="flex flex-col gap-1">
                            {allActiveAgents.map((agent, idx) => (
                                <div
                                    key={idx}
                                    onClick={() => {
                                        if (agent.isCli) navigate(`/dashboard?tab=terminal`)
                                        else navigate(`/dashboard?activeTab=${encodeURIComponent(agent.targetId)}`)
                                    }}
                                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-orange-500/[0.04] cursor-pointer transition-colors duration-150 hover:bg-orange-500/10"
                                >
                                    <span className="text-sm">{getIcon(agent.type)}</span>
                                    <span className="text-xs text-orange-400 font-semibold">{agent.name}</span>
                                    {agent.workspace && <span className="text-[9px] text-text-muted max-w-20 overflow-hidden text-ellipsis whitespace-nowrap">· {agent.workspace}</span>}
                                    <span className="text-[10px] text-text-muted">on {agent.machine}</span>
                                    <span className="ml-auto text-[10px] text-orange-500 flex items-center gap-1">
                                        <span
                                            className="w-1 h-1 rounded-full bg-orange-500"
                                            style={{ animation: 'pulse-dot 1s infinite' }}
                                        />
                                        generating...
                                    </span>
                                    <span className="text-[10px] text-text-muted">→</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Machine Cards Grid */}
                <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: machines.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))' }}
                >
                    {machines.map((machine) => {
                        const isOnline = machine.daemonIde.status === 'online'
                        const memAvail = machine.system?.availableMem ?? machine.system?.freeMem ?? 0
                        const memUsedFrac = machine.system?.totalMem
                            ? Math.min(1, Math.max(0, 1 - memAvail / machine.system.totalMem))
                            : 0
                        const cpuLoad = machine.system?.loadavg?.[0] || 0
                        const cpuPct = machine.system?.cpus ? Math.min(Math.round((cpuLoad / machine.system.cpus) * 100), 100) : 0
                        const connState = connectionStates[machine.machineId]
                        const transport = connectionTransports[machine.machineId]
                        const isConnecting = isOnline && (connState === 'new' || connState === 'connecting')
                        const totalAgents = machine.managedIdes.length + machine.managedClis.length + machine.managedAcps.length

                        return (
                            <div
                                key={machine.machineId}
                                className={`machine-card${isOnline ? '' : ' offline'}`}
                            >
                                {/* Connection overlay */}
                                {isConnecting && (
                                    <div className="p2p-overlay">
                                        <div
                                            className="w-7 h-7 rounded-full border-[2.5px] border-violet-500/25"
                                            style={{ borderTopColor: '#a78bfa', animation: 'spin 0.9s linear infinite' }}
                                        />
                                        <div className="text-[11px] text-violet-600 font-semibold tracking-tight">
                                            Connecting...
                                        </div>
                                        <div className="text-[10px] text-text-muted">
                                            {machine.nickname || machine.hostname}
                                        </div>
                                    </div>
                                )}
                                {/* Status accent line */}
                                <div className={`machine-accent${isOnline ? '' : ' offline'}`} />

                                <div className="px-5 py-4">
                                    {/* Header Row — clickable to machine detail */}
                                    <div
                                        onClick={() => navigate(`/machines/${machine.machineId}`)}
                                        className="flex justify-between items-center mb-3.5 cursor-pointer"
                                    >
                                        <div className="flex items-center gap-2.5">
                                            <div
                                                className={`w-9 h-9 rounded-[10px] flex items-center justify-center text-lg ${
                                                    isOnline ? 'bg-violet-500/[0.08] border border-violet-500/15' : 'bg-gray-500/[0.06] border border-gray-500/10'
                                                }`}
                                            >
                                                {PLATFORM_ICONS[machine.platform] || <IconMonitor size={20} />}
                                            </div>
                                            <div className="overflow-hidden min-w-0">
                                                <div className="font-bold text-sm text-text-primary tracking-tight overflow-hidden text-ellipsis whitespace-nowrap">
                                                    {machine.nickname || machine.hostname}
                                                </div>
                                                <div className="text-[10px] text-text-muted flex gap-1 items-center">
                                                    {machine.system && <span>{machine.system.cpus ?? 0} cores · {formatBytes(machine.system.totalMem ?? 0)}</span>}
                                                    {machine.system && <span className="opacity-30">·</span>}
                                                    {machine.system && <span>{formatUptime(machine.system.uptime ?? 0)}</span>}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                            {machine.p2p?.available && (
                                                <ConnectionBadge connection={{
                                                    status: machine.p2p.state,
                                                    label: 'P2P',
                                                    peers: machine.p2p.peers,
                                                }} />
                                            )}
                                            {/* Transport type badge */}
                                            {connState === 'connected' && transport && transport !== 'unknown' && (
                                                <span
                                                    className={`text-[9px] font-semibold px-[5px] py-px rounded ${
                                                        transport === 'relay'
                                                            ? 'bg-orange-500/[0.08] border border-orange-500/20 text-orange-400'
                                                            : 'bg-green-500/[0.08] border border-green-500/20 text-green-500'
                                                    }`}
                                                    title={transport === 'relay' ? 'TURN relay — direct connection failed' : 'Direct connection (STUN/host)'}
                                                >
                                                    {transport === 'relay' ? '🔀 relay' : '🔗 direct'}
                                                </span>
                                            )}
                                            <div
                                                className="w-2 h-2 rounded-full"
                                                style={{
                                                    background: isOnline ? '#22c55e' : '#64748b',
                                                    boxShadow: isOnline ? '0 0 8px rgba(34,197,94,0.4)' : 'none',
                                                    animation: isOnline ? 'pulse-dot 2s infinite' : 'none',
                                                }}
                                            />
                                        </div>
                                    </div>

                                    {/* System Stats (mini bars) — always shown for consistent card height */}
                                    <div className="flex gap-3 mb-3.5">
                                        <ProgressBar value={machine.system && isOnline ? cpuPct : 0} max={100} color="#8b5cf6" label="CPU" compact />
                                        <ProgressBar value={machine.system && isOnline ? Math.round(memUsedFrac * 100) : 0} max={100} color="#3b82f6" label="MEM" compact />
                                    </div>

                                    {/* Compact Agent List — IDEs */}
                                    {machine.managedIdes.length > 0 && (
                                        <div className="mb-1.5">
                                            <div className="text-[9px] text-text-muted uppercase tracking-wide font-semibold mb-1">IDEs</div>
                                            <div className="flex flex-col gap-0.5">
                                                {machine.managedIdes.map(ide => {
                                                    const active = isAgentActive(ide.agents, ide.agentStreams, ide.activeChat)
                                                    const statusText = active ? 'generating'
                                                        : ide.activeChat?.status === 'waiting_approval' ? 'approval'
                                                        : 'idle'
                                                    // Extensions / agent streams running inside this IDE
                                                    const activeStreams = (ide.agentStreams || []).filter(
                                                        s => s.status === 'generating' || s.status === 'streaming' || s.status === 'active'
                                                    )
                                                    return (
                                                        <div key={ide.id}>
                                                            <AgentRow
                                                                icon={getIcon(ide.type)}
                                                                name={ide.name}
                                                                status={statusText}
                                                                workspace={ide.workspace}
                                                                isActive={active}
                                                                isHidden={isHidden(ide.id)}
                                                                onToggleVisibility={() => toggleTab(ide.id)}
                                                                onClick={() => navigate(`/dashboard?activeTab=${encodeURIComponent(ide.id)}`)}
                                                            />
                                                            {/* Extension sub-rows */}
                                                            {activeStreams.length > 0 && (
                                                                <div className="ml-7 flex flex-col gap-px">
                                                                    {activeStreams.map((stream, si) => (
                                                                        <div
                                                                            key={si}
                                                                            className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] text-text-secondary"
                                                                        >
                                                                            <span className="text-[8px]">{getIcon(stream.agentName) || '🧩'}</span>
                                                                            <span className="font-medium">{stream.agentName}</span>
                                                                            <span className={`ml-auto text-[9px] ${
                                                                                stream.status === 'generating' || stream.status === 'streaming'
                                                                                    ? 'text-orange-400' : 'text-text-muted'
                                                                            }`}>
                                                                                {stream.status === 'generating' || stream.status === 'streaming' ? '⚡ generating' : stream.status}
                                                                            </span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Compact Agent List — CLIs */}
                                    {machine.managedClis.length > 0 && (
                                        <div className="mb-1.5">
                                            <div className="text-[9px] text-text-muted uppercase tracking-wide font-semibold mb-1">CLIs</div>
                                            <div className="flex flex-col gap-0.5">
                                                {machine.managedClis.map(cli => {
                                                    const active = cli.agentStreams?.some(s => s.status === 'streaming' || s.status === 'generating')
                                                    return (
                                                        <AgentRow
                                                            key={cli.id}
                                                            icon={getIcon(cli.cliType)}
                                                            name={cli.cliName}
                                                            status={active ? 'generating' : cli.status === 'stopped' ? 'stopped' : 'idle'}
                                                            workspace={cli.workspace?.split('/').pop()}
                                                            isActive={!!active}
                                                            isHidden={isHidden(cli.id)}
                                                            onToggleVisibility={() => toggleTab(cli.id)}
                                                            onClick={() => navigate(`/dashboard?activeTab=${encodeURIComponent(cli.id)}`)}
                                                        />
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Compact Agent List — ACP Agents */}
                                    {machine.managedAcps.length > 0 && (
                                        <div className="mb-1.5">
                                            <div className="text-[9px] text-text-muted uppercase tracking-wide font-semibold mb-1">ACP Agents</div>
                                            <div className="flex flex-col gap-0.5">
                                                {machine.managedAcps.map(acp => {
                                                    const active = acp.agentStreams?.some(s => s.status === 'streaming' || s.status === 'generating')
                                                    return (
                                                        <AgentRow
                                                            key={acp.id}
                                                            icon={getIcon(acp.acpType)}
                                                            name={acp.acpName}
                                                            status={active ? 'generating' : acp.status === 'stopped' ? 'stopped' : 'idle'}
                                                            workspace={acp.workspace?.split('/').pop()}
                                                            isActive={!!active}
                                                            isHidden={isHidden(acp.id)}
                                                            onToggleVisibility={() => toggleTab(acp.id)}
                                                            onClick={() => navigate(`/dashboard?activeTab=${encodeURIComponent(acp.id)}`)}
                                                        />
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Nothing running */}
                                    {totalAgents === 0 && isOnline && (
                                        <div className="text-[11px] text-text-muted italic">
                                            No agents running yet ·{' '}
                                            <span
                                                onClick={(e) => { e.stopPropagation(); navigate(`/machines/${machine.machineId}`) }}
                                                className="text-violet-500 cursor-pointer not-italic"
                                            >Launch →</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )
                    })}

                    {/* Empty state */}
                    {machines.length === 0 && (
                        <div className="col-span-full py-16 px-10 text-center bg-bg-secondary border-2 border-dashed border-border-subtle rounded-[20px] shadow-sm relative overflow-hidden">
                            <div className="absolute inset-0 bg-gradient-to-b from-violet-500/5 to-transparent pointer-events-none" />
                            <img src="/otter-logo.png" alt="ADHDev" className="w-14 h-14 object-contain mb-5 mx-auto opacity-90 animate-bounce" style={{ animationDuration: '3s' }} />
                            <h3 className="text-text-primary mb-2 text-xl font-bold tracking-tight">Welcome to ADHDev</h3>
                            <p className="text-[13px] text-text-muted max-w-[420px] mx-auto leading-relaxed mb-6">
                                Connect your first machine to the dashboard. Run setup once, then start ADHDev on that machine:
                            </p>
                            
                            <InstallCommand />
                            
                            <p className="text-[12px] text-text-muted mt-8">
                                <a href="https://docs.adhf.dev" target="_blank" rel="noopener noreferrer" className="text-accent font-semibold hover:underline flex items-center justify-center gap-1">
                                    📚 Read the documentation →
                                </a>
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
