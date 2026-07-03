/**
 * OverviewTab — System stats and resources for the machine.
 *
 * Workspaces are handled by the dedicated Workspace tab — this view stays
 * focused on the host (uptime, memory) and session counts.
 */
import { formatUptime, formatBytes } from '../../utils/daemon-utils'
import ProgressBar from '../../components/ProgressBar'
import StatCard from '../../components/StatCard'
import Card from '../../components/Card'
import { IconClock, IconMonitor, IconTerminal, IconBot } from '../../components/Icons'
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry } from './types'

interface OverviewTabProps {
    machine: MachineData
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
}

export default function OverviewTab({
    machine, ideSessions, cliSessions, acpSessions,
}: OverviewTabProps) {
    const hasRuntimeStats = typeof machine.uptime === 'number'
        || typeof machine.freeMem === 'number'
        || typeof machine.availableMem === 'number'
        || (Array.isArray(machine.loadavg) && machine.loadavg.length > 0)
    const memAvail = machine.availableMem ?? machine.freeMem ?? machine.totalMem
    const memUsedPct = hasRuntimeStats && machine.totalMem > 0
        ? Math.min(100, Math.max(0, Math.round(((machine.totalMem - memAvail) / machine.totalMem) * 100)))
        : 0
    const loadAvg1m = machine.loadavg?.[0] || 0
    return (
        <div>
            {/* System Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5">
                <StatCard icon={<IconClock size={16} />} label="Uptime" value={typeof machine.uptime === 'number' ? formatUptime(machine.uptime) : 'Waiting…'} />
                <StatCard icon={<IconMonitor size={16} />} label="IDEs" value={`${ideSessions.length}`} />
                <StatCard icon={<IconTerminal size={16} />} label="CLIs" value={`${cliSessions.length}`} />
                <StatCard icon={<IconBot size={16} />} label="ACPs" value={`${acpSessions.length}`} />
            </div>

            {/* Resource Usage */}
            <Card padding="lg" className="mb-5">
                <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-3">
                    Resource Usage
                </div>
                <div className="flex gap-6">
                    <ProgressBar value={hasRuntimeStats ? Math.min(Math.round(loadAvg1m / machine.cpus * 100), 100) : 0} max={100} label="CPU Load" color="#8b5cf6" detail={hasRuntimeStats ? `${loadAvg1m.toFixed(2)} avg / ${machine.cpus} cores` : 'Polled from machine page'} />
                    <ProgressBar value={memUsedPct} max={100} label="Memory" color="#3b82f6" detail={hasRuntimeStats ? `${formatBytes(machine.totalMem - memAvail)} / ${formatBytes(machine.totalMem)}${machine.platform === 'darwin' ? ' (approx.)' : ''}` : `Polled from machine page · ${formatBytes(machine.totalMem)} total`} />
                </div>
            </Card>

            {/*
              * Workspaces live in the dedicated Workspace tab. Keeping a copy
              * here in Overview duplicated the surface and made the System
              * column feel like it owned Workspaces; both were the same data.
              */}
        </div>
    )
}
