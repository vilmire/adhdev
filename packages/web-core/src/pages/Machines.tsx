import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { isManagedStatusWaiting, isManagedStatusWorking, normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
import { useDaemons } from '../compat'
import { useDaemonMachineRuntimeSubscription } from '../hooks/useDaemonMachineRuntimeSubscription'
import { useDaemonMetadataLoader } from '../hooks/useDaemonMetadataLoader'
import { useDaemonMachineRuntimeLoader } from '../hooks/useDaemonMachineRuntimeLoader'
import {
    buildProviderMaps, PLATFORM_ICONS,
    formatUptime, formatBytes,
    isAgentActive, groupByMachine, getWorkspaceDisplayLabel,
} from '../utils/daemon-utils'
import { getDashboardActiveTabHref } from '../utils/dashboard-route-paths'
import ProgressBar from '../components/ProgressBar'
import ConnectionBadge from '../components/ConnectionBadge'
import BeaconAdvisoryBadge from '../components/BeaconAdvisoryBadge'
import InstallCommand from '../components/InstallCommand'
import { IconServer, IconMonitor, IconEyeOff, IconZap, IconShuffle, IconLink } from '../components/Icons'
import LoadingSpinner from '../components/ui/LoadingSpinner'
import { ProviderLogo } from '../components/ProviderLogo'

// ─── Compact Agent Row (replaces full IdeCard/CliCard) ──────────
function AgentRow({ type, name, status, statusTone = 'idle', workspace, isActive, hidden, onClick }: {
    type: string; name: string; status: string; statusTone?: 'active' | 'waiting' | 'idle' | 'offline'; workspace?: string
    isActive: boolean; hidden?: boolean; onClick: () => void
}) {
    const { t } = useTranslation('common')
    const statusDotColor = statusTone === 'active'
        ? '#f97316'
        : statusTone === 'waiting'
            ? 'var(--status-warning)'
            : statusTone === 'offline'
                ? '#ef4444'
                : '#64748b'

    return (
        <div
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all ${
                isActive ? 'bg-orange-500/[0.04] border border-orange-500/10' : 'bg-bg-glass border border-border-subtle'
            }`}
        >
            <div
                onClick={(e) => { e.stopPropagation(); onClick() }}
                className="flex-1 flex items-center gap-2 cursor-pointer min-w-0"
            >
                <ProviderLogo type={type} label={name} size={16} />
                <span className="font-semibold text-2xs text-text-primary">{name}</span>
                {hidden && (
                    <span
                        className="inline-flex shrink-0 text-text-muted"
                        title={t('machine.card.hidden')}
                        aria-label={t('machine.card.hidden')}
                    >
                        <IconEyeOff size={11} />
                    </span>
                )}
                {workspace && (
                    <span className="text-4xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-[100px]">{workspace}</span>
                )}
                <span className={`ml-auto flex items-center gap-1 text-4xs font-medium ${isActive ? 'text-orange-400' : 'text-text-muted'}`}>
                    {isActive && <IconZap size={10} />}
                    {status}
                </span>
                <span
                    className="w-[5px] h-[5px] rounded-full shrink-0"
                    style={{
                        background: statusDotColor,
                        animation: statusTone === 'active' ? 'pulse-dot 1.5s infinite' : 'none',
                    }}
                />
                <span className="text-4xs text-text-muted">→</span>
            </div>
        </div>
    )
}

// ─── Page ────────────────────────────────────────────
export default function MachinesPage() {
    const { t } = useTranslation('common')
    const navigate = useNavigate()
    const daemonCtx = useDaemons()
    const { ides: daemons, initialLoaded } = daemonCtx
    const loadDaemonMetadata = useDaemonMetadataLoader()
    const loadMachineRuntime = useDaemonMachineRuntimeLoader()
    const connectionStates = daemonCtx.connectionStates || {}
    const connectionTransports = daemonCtx.connectionTransports || {}
    const connectionRetryStatuses = daemonCtx.connectionRetryStatuses || {}
    const retryConnection = daemonCtx.retryConnection
    const { labels: providerLabels } = buildProviderMaps(daemons)
    const machines = groupByMachine(daemons, providerLabels)
    const machineIdsKey = Array.from(new Set(machines.map((machine) => machine.machineId).filter(Boolean))).join('|')
    const onlineCount = machines.filter(m => m.daemonIde.status === 'online').length

    useEffect(() => {
        const targets = machines
            .map((machine) => machine.daemonIde)
            .filter((entry) => {
                const info = entry.machine
                return !entry.detectedIdes
                    || !entry.availableProviders
                    || !entry.recentLaunches
                    || !entry.workspaces
                    || typeof info?.cpus !== 'number'
                    || typeof info?.totalMem !== 'number'
                    || typeof info?.arch !== 'string'
                    || typeof info?.release !== 'string'
            })
            .map((entry) => entry.id)

        for (const daemonId of targets) {
            void loadDaemonMetadata(daemonId, { minFreshMs: 30_000 }).catch(() => {})
        }

        for (const machine of machines) {
            const info = machine.daemonIde.machine
            const needsRuntime = typeof info?.cpus !== 'number'
                || typeof info?.totalMem !== 'number'
                || typeof info?.arch !== 'string'
                || typeof info?.release !== 'string'
            if (!needsRuntime) continue
            void loadMachineRuntime(machine.daemonIde.id, { minFreshMs: 30_000 }).catch(() => {})
        }
    }, [loadDaemonMetadata, loadMachineRuntime, machines])

    useDaemonMachineRuntimeSubscription(
        machineIdsKey ? machineIdsKey.split('|') : [],
        { enabled: true, intervalMs: 20_000 },
    )

    const openDashboardSession = (sessionId?: string | null, fallbackMachineId?: string | null) => {
        if (sessionId) {
            navigate(getDashboardActiveTabHref(sessionId))
            return
        }
        if (fallbackMachineId) navigate(`/machines/${encodeURIComponent(fallbackMachineId)}`)
    }

    // Cross-machine active agents
    const allActiveAgents: { name: string; machine: string; machineId: string; status: string; type: string; targetSessionId?: string; isCli: boolean; workspace: string }[] = []
    for (const m of machines) {
        for (const ide of m.ideSessions) {
            if (isAgentActive(ide.agents, ide.childSessions, ide.activeChat)) {
                const activeStream = ide.childSessions.find(s => isManagedStatusWorking(s.status))
                const agentName = activeStream?.providerName
                    || ide.agents.find(a => isManagedStatusWorking(a.status))?.name
                    || ide.name
                allActiveAgents.push({
                    name: agentName, machine: m.nickname || m.hostname,
                    machineId: m.machineId, status: 'generating', type: ide.type,
                    targetSessionId: activeStream?.id || ide.sessionId || undefined, isCli: false,
                    workspace: getWorkspaceDisplayLabel(ide.workspace || ''),
                })
            }
        }
        for (const cli of m.cliSessions) {
            if (isManagedStatusWorking(cli.status)) {
                allActiveAgents.push({
                    name: cli.cliName, machine: m.nickname || m.hostname,
                    machineId: m.machineId, status: 'generating', type: cli.cliType,
                    targetSessionId: cli.sessionId || undefined, isCli: true,
                    workspace: getWorkspaceDisplayLabel(cli.workspace || ''),
                })
            }
        }
        for (const acp of m.acpSessions) {
            if (isManagedStatusWorking(acp.status)) {
                allActiveAgents.push({
                    name: acp.acpName, machine: m.nickname || m.hostname,
                    machineId: m.machineId, status: 'generating', type: acp.acpType,
                    targetSessionId: acp.sessionId || undefined, isCli: false,
                    workspace: getWorkspaceDisplayLabel(acp.workspace || ''),
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
                        <IconServer size={20} /> {t('machine.card.pageTitle')}
                    </h1>
                    <div className="header-subtitle flex gap-3 flex-wrap">
                        {/*
                         * Same loading-vs-empty distinction as the body below:
                         * before `initial_state` lands, "0 machines / 0 online"
                         * is a claim we cannot yet make, so show the counters
                         * only once the numbers mean something.
                         */}
                        {initialLoaded && <span>{t('machine.card.burrowCount', { count: machines.length })}</span>}
                        {initialLoaded && <span className="text-green-500">● {t('machine.card.onlineCount', { count: onlineCount })}</span>}
                        {allActiveAgents.length > 0 && (
                            <span className="text-orange-500 inline-flex items-center gap-1"><IconZap size={11} />{t('machine.card.agentsActive', { count: allActiveAgents.length })}</span>
                        )}
                    </div>
                </div>
            </div>

            <div className="page-content">
                <div className="mx-auto w-full max-w-6xl">

                {/* Cross-Machine Active Agents Feed */}
                {allActiveAgents.length > 0 && (
                    <div className="bg-bg-secondary border border-orange-500/10 rounded-xl px-4 py-3 mb-4">
                        <div className="text-3xs text-text-muted uppercase tracking-wide font-bold mb-2 flex items-center gap-1.5">
                            <span
                                className="w-1.5 h-1.5 rounded-full bg-orange-500"
                                style={{ animation: 'pulse-dot 1.5s infinite' }}
                            />
                            {t('machine.card.activeNow')}
                        </div>
                        <div className="flex flex-col gap-1">
                            {allActiveAgents.map((agent, idx) => (
                                <div
                                    key={idx}
                                    onClick={() => {
                                        openDashboardSession(agent.targetSessionId, agent.machineId)
                                    }}
                                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-orange-500/[0.04] cursor-pointer transition-colors duration-150 hover:bg-orange-500/10"
                                >
                                    <ProviderLogo type={agent.type} label={agent.name} size={16} />
                                    <span className="text-xs text-orange-400 font-semibold">{agent.name}</span>
                                    {agent.workspace && <span className="text-4xs text-text-muted max-w-20 overflow-hidden text-ellipsis whitespace-nowrap">· {agent.workspace}</span>}
                                    <span className="text-3xs text-text-muted">on {agent.machine}</span>
                                    <span className="ml-auto text-3xs text-orange-500 flex items-center gap-1">
                                        <span
                                            className="w-1 h-1 rounded-full bg-orange-500"
                                            style={{ animation: 'pulse-dot 1s infinite' }}
                                        />
                                        {t('machine.card.generating')}
                                    </span>
                                    <span className="text-3xs text-text-muted">→</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Machine List — flat rows, matching the Account page pattern */}
                <div className="flex flex-col gap-3">
                    {machines.map((machine) => {
                        const isOnline = machine.daemonIde.status === 'online'
                        const hasRuntimeStats = typeof machine.system?.uptime === 'number'
                            || typeof machine.system?.freeMem === 'number'
                            || typeof machine.system?.availableMem === 'number'
                            || Array.isArray(machine.system?.loadavg)
                        const memAvail = machine.system?.availableMem ?? machine.system?.freeMem ?? 0
                        const memUsedFrac = machine.system?.totalMem
                            ? Math.min(1, Math.max(0, 1 - memAvail / machine.system.totalMem))
                            : 0
                        const cpuLoad = machine.system?.loadavg?.[0] || 0
                        const cpuPct = machine.system?.cpus ? Math.min(Math.round((cpuLoad / machine.system.cpus) * 100), 100) : 0
                        const connState = connectionStates[machine.machineId]
                        const transport = connectionTransports[machine.machineId]
                        const retryStatus = connectionRetryStatuses[machine.machineId]
                        const isBlocked = isOnline && !!retryStatus?.blocked
                        const isConnecting = isOnline && !isBlocked && (connState === 'new' || connState === 'connecting')
                        const machineDotColor = connState === 'connected'
                            ? '#22c55e'
                            : isBlocked
                                ? '#ef4444'
                                : isConnecting
                                    ? 'var(--accent-primary-light)'
                                    : '#64748b'
                        const totalAgents = machine.ideSessions.length + machine.cliSessions.length + machine.acpSessions.length

                        return (
                            <div
                                key={machine.machineId}
                                className={`bg-bg-glass rounded-xl border transition-colors ${
                                    isBlocked ? 'border-red-500/25' : 'border-border-subtle hover:border-border-default'
                                }`}
                            >
                                <div className="px-4 py-3.5">
                                    {/* Header Row — clickable to machine detail */}
                                    <div
                                        onClick={() => navigate(`/machines/${machine.machineId}`)}
                                        className="flex justify-between items-center gap-3 cursor-pointer"
                                    >
                                        <div className="flex items-center gap-2.5 min-w-0">
                                            <div
                                                className={`w-9 h-9 shrink-0 rounded-[10px] flex items-center justify-center text-lg border ${
                                                    isOnline ? 'bg-accent/[0.08] border-accent/15' : 'bg-bg-secondary border-border-subtle'
                                                }`}
                                            >
                                                {PLATFORM_ICONS[machine.platform] || <IconMonitor size={20} />}
                                            </div>
                                            <div className="overflow-hidden min-w-0">
                                                <div className="font-semibold text-sm text-text-primary tracking-tight overflow-hidden text-ellipsis whitespace-nowrap">
                                                    {machine.nickname || machine.hostname}
                                                </div>
                                                <div className="text-3xs text-text-muted flex gap-1 items-center">
                                                    {typeof machine.system?.cpus === 'number' && typeof machine.system?.totalMem === 'number' && (
                                                        <span>{machine.system.cpus} cores · {formatBytes(machine.system.totalMem)}</span>
                                                    )}
                                                    {typeof machine.system?.cpus === 'number' && typeof machine.system?.totalMem === 'number' && (
                                                        <span className="opacity-30">·</span>
                                                    )}
                                                    {machine.system && <span>{typeof machine.system.uptime === 'number' ? formatUptime(machine.system.uptime) : t('machine.card.runtimePolling')}</span>}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0">
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
                                                    className={`text-4xs font-semibold px-[5px] py-px rounded ${
                                                        transport === 'relay'
                                                            ? 'bg-orange-500/[0.08] border border-orange-500/20 text-orange-400'
                                                            : 'bg-green-500/[0.08] border border-green-500/20 text-green-500'
                                                    }`}
                                                    title={transport === 'relay' ? t('machine.card.transportRelay') : t('machine.card.transportDirect')}
                                                >
                                                    {transport === 'relay' ? <><IconShuffle size={10} /> relay</> : <><IconLink size={10} /> direct</>}
                                                </span>
                                            )}
                                            {/*
                                              seqscribe Beacon advisory (§7.1): "behind N" / "sole copy".
                                              Renders nothing when caught up, when no board has arrived, or
                                              when the board is stale — so a machine with healthy replication
                                              (and every WS-only machine, since beacon rides P2P alone) looks
                                              exactly as it does today.
                                            */}
                                            <BeaconAdvisoryBadge beacon={machine.daemonIde?.beacon} />
                                            <div
                                                className="w-2 h-2 rounded-full"
                                                style={{
                                                    background: machineDotColor,
                                                    boxShadow: connState === 'connected' ? '0 0 8px rgba(34,197,94,0.4)' : 'none',
                                                    animation: connState === 'connected' ? 'pulse-dot 2s infinite' : 'none',
                                                }}
                                            />
                                        </div>
                                    </div>

                                    {/* Connection status line (blocked / connecting) */}
                                    {isBlocked ? (
                                        <div className="flex items-center justify-between gap-2 mt-2.5 px-2.5 py-1.5 rounded-lg bg-red-500/[0.06] border border-red-500/15">
                                            <span className="text-2xs font-medium text-red-400">{t('machine.card.connectionFailed')}</span>
                                            {retryConnection && (
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); retryConnection(machine.machineId) }}
                                                    className="px-2.5 py-0.5 rounded-md text-3xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
                                                >
                                                    {t('machine.card.reconnect')}
                                                </button>
                                            )}
                                        </div>
                                    ) : isConnecting && (
                                        <div className="flex items-center gap-2 mt-2.5 px-2.5 py-1.5 rounded-lg bg-bg-secondary border border-border-subtle">
                                            <LoadingSpinner size={12} thickness={2} />
                                            <span className="text-2xs font-medium text-text-secondary">{t('machine.card.connecting')}</span>
                                        </div>
                                    )}

                                    {/* System Stats (mini bars) — always shown for consistent row height */}
                                    <div className="flex gap-3 mt-3 mb-2.5">
                                        <ProgressBar value={machine.system && isOnline && hasRuntimeStats ? cpuPct : 0} max={100} color="var(--accent-primary)" label={t('machine.card.cpu')} compact />
                                        <ProgressBar value={machine.system && isOnline && hasRuntimeStats ? Math.round(memUsedFrac * 100) : 0} max={100} color="var(--status-online)" label={t('machine.card.mem')} compact />
                                    </div>

                                    {/* Compact Agent List — IDEs */}
                                    {machine.ideSessions.length > 0 && (
                                        <div className="mb-1.5">
                                            <div className="text-4xs text-text-muted uppercase tracking-wide font-semibold mb-1">{t('machine.card.sectionIDEs')}</div>
                                            <div className="flex flex-col gap-0.5">
                                                {machine.ideSessions.map(ide => {
                                                    const active = isAgentActive(ide.agents, ide.childSessions, ide.activeChat)
                                                    const statusText = active ? t('machine.card.generating')
                                                        : isManagedStatusWaiting(ide.activeChat?.status, { activeModal: ide.activeChat?.activeModal }) ? 'approval'
                                                        : 'idle'
                                                    const statusTone = active
                                                        ? 'active'
                                                        : statusText === 'approval'
                                                            ? 'waiting'
                                                            : ide.status === 'stopped'
                                                                ? 'offline'
                                                                : 'idle'
                                                    // Extensions / agent streams running inside this IDE
                                                    const activeStreams = (ide.childSessions || []).filter(
                                                        s => isManagedStatusWorking(s.status)
                                                    )
                                                    return (
                                                        <div key={ide.id}>
                                                            <AgentRow
                                                                type={ide.type}
                                                                name={ide.name}
                                                                status={statusText}
                                                                statusTone={statusTone}
                                                                workspace={getWorkspaceDisplayLabel(ide.workspace)}
                                                                isActive={active}
                                                                hidden={ide.surfaceHidden}
                                                                onClick={() => openDashboardSession(ide.sessionId, machine.machineId)}
                                                            />
                                                            {/* Extension sub-rows */}
                                                            {activeStreams.length > 0 && (
                                                                <div className="ml-7 flex flex-col gap-px">
                                                                    {activeStreams.map((stream, si) => (
                                                                        <div
                                                                            key={si}
                                                                            className="flex items-center gap-1.5 px-2 py-0.5 text-3xs text-text-secondary"
                                                                        >
                                                                            <ProviderLogo type={stream.providerType} size={12} />
                                                                            <span className="font-medium">{stream.providerName}</span>
                                                                            <span className={`ml-auto text-4xs ${
                                                                                isManagedStatusWorking(stream.status)
                                                                                    ? 'text-orange-400' : 'text-text-muted'
                                                                            }`}>
                                                                                {isManagedStatusWorking(stream.status) ? `${t('machine.card.generating')}` : normalizeManagedStatus(stream.status)}
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
                                    {machine.cliSessions.length > 0 && (
                                        <div className="mb-1.5">
                                            <div className="text-4xs text-text-muted uppercase tracking-wide font-semibold mb-1">{t('machine.card.sectionCLIs')}</div>
                                            <div className="flex flex-col gap-0.5">
                                                {machine.cliSessions.map(cli => {
                                                    const active = isManagedStatusWorking(cli.status)
                                                    const statusTone = active
                                                        ? 'active'
                                                        : normalizeManagedStatus(cli.status) === 'stopped'
                                                            ? 'offline'
                                                            : 'idle'
                                                    return (
                                                        <AgentRow
                                                            key={cli.id}
                                                            type={cli.cliType}
                                                            name={cli.cliName}
                                                            status={active ? t('machine.card.generating') : normalizeManagedStatus(cli.status)}
                                                            statusTone={statusTone}
                                                            workspace={getWorkspaceDisplayLabel(cli.workspace)}
                                                            isActive={!!active}
                                                            hidden={cli.surfaceHidden}
                                                            onClick={() => openDashboardSession(cli.sessionId, machine.machineId)}
                                                        />
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Compact Agent List — ACP Agents */}
                                    {machine.acpSessions.length > 0 && (
                                        <div className="mb-1.5">
                                            <div className="text-4xs text-text-muted uppercase tracking-wide font-semibold mb-1">{t('machine.card.sectionACPAgents')}</div>
                                            <div className="flex flex-col gap-0.5">
                                                {machine.acpSessions.map(acp => {
                                                    const active = isManagedStatusWorking(acp.status)
                                                    const statusTone = active
                                                        ? 'active'
                                                        : normalizeManagedStatus(acp.status) === 'stopped'
                                                            ? 'offline'
                                                            : 'idle'
                                                    return (
                                                        <AgentRow
                                                            key={acp.id}
                                                            type={acp.acpType}
                                                            name={acp.acpName}
                                                            status={active ? t('machine.card.generating') : normalizeManagedStatus(acp.status)}
                                                            statusTone={statusTone}
                                                            workspace={getWorkspaceDisplayLabel(acp.workspace)}
                                                            isActive={!!active}
                                                            hidden={acp.surfaceHidden}
                                                            onClick={() => openDashboardSession(acp.sessionId, machine.machineId)}
                                                        />
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Nothing running */}
                                    {totalAgents === 0 && isOnline && (
                                        <div className="text-2xs text-text-muted italic">
                                            {t('machine.card.noAgentsRunning')} ·{' '}
                                            <span
                                                onClick={(e) => { e.stopPropagation(); navigate(`/machines/${machine.machineId}`) }}
                                                className="text-accent cursor-pointer not-italic"
                                            >{t('machine.card.launchCta')}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )
                    })}

                    {/*
                     * Bootstrap placeholder — shown while the very first
                     * `initial_state` is in flight. `daemons` starts as an empty
                     * array, so `machines.length === 0` is indistinguishable
                     * from "no data yet" until that message lands: rendering the
                     * first-run onboarding here told an existing user with four
                     * machines that they had none, and to go connect their
                     * first one. Deliberately neutral — it must not look like
                     * either terminal state (onboarding or a machine list),
                     * because which one applies is exactly what is not yet
                     * known. This is not a timed delay; it waits for the signal
                     * that decides between them. New users are unaffected: the
                     * daemon provider calls markLoaded() on `initial_state`
                     * even when the payload is empty, so a genuine zero-machine
                     * account still reaches onboarding on the first round trip.
                     */}
                    {!initialLoaded && (
                        <div className="flex flex-col items-center justify-center gap-3 py-24 text-text-muted">
                            <img src="/otter-logo.png" alt="" aria-hidden="true" className="w-10 h-10 object-contain opacity-60 animate-pulse" />
                            <p className="text-sm">{t('machine.card.loading')}</p>
                        </div>
                    )}

                    {/* Empty state — only once we know the list is genuinely empty */}
                    {initialLoaded && machines.length === 0 && (
                        <div className="bg-bg-glass rounded-xl border border-border-subtle p-10 text-center">
                            <img src="/otter-logo.png" alt="ADHDev" className="w-12 h-12 object-contain mb-4 mx-auto opacity-90" />
                            <h3 className="text-text-primary mb-2 text-lg font-bold tracking-tight">{t('machine.card.emptyHeadline')}</h3>
                            <p className="text-[13px] text-text-muted max-w-[420px] mx-auto leading-relaxed mb-6">
                                {t('machine.card.emptyBody')}
                            </p>

                            <InstallCommand />

                            <p className="text-[12px] text-text-muted mt-8">
                                <a href="https://docs.adhf.dev" target="_blank" rel="noopener noreferrer" className="text-accent font-semibold hover:underline flex items-center justify-center gap-1">
                                    {t('machine.card.emptyDocsLink')}
                                </a>
                            </p>
                        </div>
                    )}
                </div>
                </div>
            </div>
        </div>
    )
}
