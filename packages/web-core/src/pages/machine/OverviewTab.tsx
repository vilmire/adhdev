/**
 * OverviewTab — System stats, resources, workspaces.
 */
import { useState } from 'react'
import { formatUptime, formatBytes, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import ProgressBar from '../../components/ProgressBar'
import StatCard from '../../components/StatCard'
import { IconClock, IconMonitor, IconFolder, IconTerminal, IconBot } from '../../components/Icons'
import { formatRelativeAgo, type MachineData, type IdeSessionEntry, type CliSessionEntry, type AcpSessionEntry } from './types'
import type { useMachineActions } from './useMachineActions'

interface OverviewTabProps {
    machine: MachineData
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
    actions: ReturnType<typeof useMachineActions>
    isDashboardHidden?: (tabKey: string) => boolean
    onToggleDashboardVisibility?: (tabKey: string) => void
}

export default function OverviewTab({
    machine, ideSessions, cliSessions, acpSessions,
    actions,
    isDashboardHidden,
    onToggleDashboardVisibility,
}: OverviewTabProps) {
    const {
        workspaceBusy,
        handleWorkspaceAdd, handleWorkspaceRemove, handleWorkspaceSetDefault,
    } = actions

    const [newWorkspacePath, setNewWorkspacePath] = useState('')

    const memAvail = machine.availableMem ?? machine.freeMem
    const memUsedPct = machine.totalMem > 0
        ? Math.min(100, Math.max(0, Math.round(((machine.totalMem - memAvail) / machine.totalMem) * 100)))
        : 0
    const loadAvg1m = machine.loadavg[0] || 0
    const recentWorkspaceActivity = [...(machine.workspaceActivity || [])]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, 5)
    const hiddenEntries = [
        ...ideSessions.map(entry => ({ id: entry.id, label: `IDE · ${entry.type}`, workspace: entry.workspace || '' })),
        ...cliSessions.map(entry => ({ id: entry.id, label: `CLI · ${entry.cliName}`, workspace: entry.workspace || '' })),
        ...acpSessions.map(entry => ({ id: entry.id, label: `ACP · ${entry.acpName}`, workspace: entry.workspace || '' })),
    ].filter(entry => isDashboardHidden?.(entry.id))

    return (
        <div>
            {/* System Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5">
                <StatCard icon={<IconClock size={16} />} label="Uptime" value={formatUptime(machine.uptime)} />
                <StatCard icon={<IconMonitor size={16} />} label="IDEs" value={`${ideSessions.length}`} />
                <StatCard icon={<IconTerminal size={16} />} label="CLIs" value={`${cliSessions.length}`} />
                <StatCard icon={<IconBot size={16} />} label="ACPs" value={`${acpSessions.length}`} />
            </div>

            {/* Resource Usage */}
            <div className="px-5 py-4 rounded-xl mb-5 bg-bg-secondary border border-border-subtle">
                <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-3">
                    Resource Usage
                </div>
                <div className="flex gap-6">
                    <ProgressBar value={Math.min(Math.round(loadAvg1m / machine.cpus * 100), 100)} max={100} label="CPU Load" color="#8b5cf6" detail={`${loadAvg1m.toFixed(2)} avg / ${machine.cpus} cores`} />
                    <ProgressBar value={memUsedPct} max={100} label="Memory" color="#3b82f6" detail={`${formatBytes(machine.totalMem - memAvail)} / ${formatBytes(machine.totalMem)}${machine.platform === 'darwin' ? ' (approx.)' : ''}`} />
                </div>
            </div>

            {/* Workspaces */}
            <div className="px-5 py-4 rounded-xl mb-5 bg-bg-secondary border border-border-subtle">
                <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider flex items-center gap-1.5 mb-3">
                    <IconFolder size={14} /> Workspaces
                </div>
                <div className="flex flex-wrap gap-2 items-center mb-3">
                    <span className="text-[10px] text-text-muted">Default:</span>
                    <select
                        className="text-xs bg-bg-primary border border-border-subtle rounded-lg px-2 py-1 max-w-[min(100%,420px)]"
                        disabled={workspaceBusy}
                        value={machine.defaultWorkspaceId || ''}
                        onChange={(e) => void handleWorkspaceSetDefault(e.target.value === '' ? null : e.target.value)}
                    >
                        <option value="">(none)</option>
                        {(machine.workspaces || []).map(w => (
                            <option key={w.id} value={w.id}>{w.label || w.path}</option>
                        ))}
                    </select>
                    {machine.defaultWorkspacePath && (
                        <span className="text-[10px] text-text-muted font-mono truncate max-w-[min(100%,360px)]" title={machine.defaultWorkspacePath}>
                            {machine.defaultWorkspacePath}
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap gap-2 items-end">
                    <input
                        className="flex-1 min-w-[200px] text-xs bg-bg-primary border border-border-subtle rounded-lg px-2.5 py-1.5"
                        placeholder="Add workspace path…"
                        value={newWorkspacePath}
                        disabled={workspaceBusy}
                        onChange={e => setNewWorkspacePath(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && void (async () => { if (await handleWorkspaceAdd(newWorkspacePath)) setNewWorkspacePath('') })()}
                    />
                    <button type="button" className="machine-btn text-xs px-3 py-1.5" disabled={workspaceBusy} onClick={async () => { if (await handleWorkspaceAdd(newWorkspacePath)) setNewWorkspacePath('') }}>
                        Add
                    </button>
                </div>
                {(machine.workspaces || []).length > 0 && (
                    <ul className="mt-3 space-y-1.5 max-h-40 overflow-y-auto">
                        {(machine.workspaces || []).map(w => (
                            <li key={w.id} className="flex items-start gap-2 text-[11px] text-text-muted rounded-lg border border-border-subtle bg-bg-primary px-2.5 py-2">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                        {w.id === machine.defaultWorkspaceId && <span className="text-[10px]">⭐</span>}
                                        <span className="font-medium text-text-primary truncate">
                                            {getWorkspaceDisplayLabel(w.path, w.label)}
                                        </span>
                                    </div>
                                    <div className="font-mono truncate text-[10px]" title={w.path}>{w.path}</div>
                                </div>
                                <button type="button" className="text-[10px] text-red-400/90 hover:underline shrink-0" disabled={workspaceBusy} onClick={() => void handleWorkspaceRemove(w.id)}>Remove</button>
                            </li>
                        ))}
                    </ul>
                )}
                {recentWorkspaceActivity.length > 0 && (
                    <div className="mt-4">
                        <div className="text-[10px] text-text-muted uppercase tracking-wide font-semibold mb-2">
                            Recent activity
                        </div>
                        <div className="space-y-1.5">
                            {recentWorkspaceActivity.map((item) => (
                                <div key={`${item.path}:${item.lastUsedAt}`} className="flex items-center gap-2 text-[11px] rounded-lg border border-border-subtle bg-bg-primary px-2.5 py-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-text-primary truncate">{getWorkspaceDisplayLabel(item.path)}</div>
                                        <div className="text-[10px] text-text-muted font-mono truncate" title={item.path}>{item.path}</div>
                                    </div>
                                    <span className="text-[10px] text-text-muted shrink-0">
                                        {item.kind ? `${item.kind} · ` : ''}{formatRelativeAgo(item.lastUsedAt)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {hiddenEntries.length > 0 && onToggleDashboardVisibility && (
                <div className="px-5 py-4 rounded-xl mb-5 bg-bg-secondary border border-border-subtle">
                    <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-3">
                        Hidden From Dashboard
                    </div>
                    <div className="flex flex-col gap-2">
                        {hiddenEntries.map((entry) => (
                            <div key={entry.id} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-primary px-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <div className="text-[12px] font-medium text-text-primary truncate">{entry.label}</div>
                                    {entry.workspace && (
                                        <div className="text-[10px] text-text-muted font-mono truncate" title={entry.workspace}>
                                            {entry.workspace}
                                        </div>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    className="machine-btn text-[11px] px-2.5 py-1 text-zinc-300 border-zinc-500/30"
                                    onClick={() => onToggleDashboardVisibility(entry.id)}
                                >
                                    Show
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
