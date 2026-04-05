/**
 * OverviewTab — System stats, resources, workspaces.
 */
import { useState } from 'react'
import { formatUptime, formatBytes, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import ProgressBar from '../../components/ProgressBar'
import StatCard from '../../components/StatCard'
import { IconClock, IconMonitor, IconFolder, IconTerminal, IconBot } from '../../components/Icons'
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry } from './types'
import type { useMachineActions } from './useMachineActions'

interface OverviewTabProps {
    machine: MachineData
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
    actions: ReturnType<typeof useMachineActions>
}

export default function OverviewTab({
    machine, ideSessions, cliSessions, acpSessions,
    actions,
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
                    <button type="button" className="btn bg-[#ffffff0a] hover:bg-[#ffffff14] text-text-muted hover:text-text-primary px-3 py-1.5 rounded transition-colors text-xs" disabled={workspaceBusy} onClick={async () => { if (await handleWorkspaceAdd(newWorkspacePath)) setNewWorkspacePath('') }}>
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
            </div>

        </div>
    )
}
