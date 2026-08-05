/**
 * OverviewTab — System stats and resources for the machine.
 *
 * Workspaces are handled by the dedicated Workspace tab — this view stays
 * focused on the host (uptime, memory) and session counts.
 */
import { useTranslation } from 'react-i18next'
import { formatUptime, formatBytes } from '../../utils/daemon-utils'
import ProgressBar from '../../components/ProgressBar'
import StatCard from '../../components/StatCard'
import Card from '../../components/Card'
import { IconClock, IconMonitor, IconTerminal, IconBot } from '../../components/Icons'
import {
    collectQuotaEntries,
    describeQuotaFailure,
    formatQuotaWindow,
    quotaProviderLabel,
    quotaUsageTone,
} from '../../utils/quota-format'
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry } from './types'

/** Badge tone → the page's existing colour vocabulary. */
const QUOTA_TONE_CLASS: Record<string, string> = {
    good: 'bg-emerald-500/10 text-emerald-500',
    warn: 'bg-amber-500/10 text-amber-500',
    danger: 'bg-red-500/10 text-red-500',
    default: 'bg-white/5 text-text-secondary',
    info: 'bg-blue-500/10 text-blue-500',
}

function QuotaChip({ label, tone, title }: { label: string; tone: string; title?: string }) {
    return (
        <span title={title} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${QUOTA_TONE_CLASS[tone] ?? QUOTA_TONE_CLASS.default}`}>
            {label}
        </span>
    )
}

/**
 * Plan quota for this machine (MachineInfo.quota — the same cache the
 * `adhdev quota` CLI reads, so the two agree).
 *
 * Renders NOTHING when the machine has reported no quota at all: that is the
 * normal state for a daemon whose 15-minute refresh has not ticked yet, and an
 * empty "Plan quota" card would imply a reading exists. A provider the machine
 * DID report but could not read still shows, with its failureKind — "never told
 * us" and "looked and could not tell" are different facts.
 */
function PlanQuotaCard({ machine }: { machine: MachineData }) {
    const { t } = useTranslation('common')
    const entries = collectQuotaEntries(machine.quota)
    if (entries.length === 0) return null
    return (
        <Card padding="lg" className="mb-5">
            <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-3">
                {t('machine.quota.title')}
            </div>
            <div className="flex flex-col gap-2">
                {entries.map(({ provider, quota }) => {
                    const session = formatQuotaWindow(quota.session)
                    const weekly = formatQuotaWindow(quota.weekly)
                    return (
                        <div key={provider} className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] text-text-primary min-w-[92px]">{quotaProviderLabel(provider)}</span>
                            {session && (
                                <QuotaChip label={`5h ${session}`} tone={quotaUsageTone(quota.session?.usedPercent ?? NaN)} title={t('machine.quota.sessionHint')} />
                            )}
                            {weekly && (
                                <QuotaChip label={`7d ${weekly}`} tone={quotaUsageTone(quota.weekly?.usedPercent ?? NaN)} title={t('machine.quota.weeklyHint')} />
                            )}
                            {!session && !weekly && (
                                <span className="text-[11px] text-text-secondary" title={t('machine.quota.failureHint')}>
                                    {describeQuotaFailure(quota)}
                                </span>
                            )}
                        </div>
                    )
                })}
            </div>
        </Card>
    )
}

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

            {/* Plan quota — self-hiding when this machine has reported none. */}
            <PlanQuotaCard machine={machine} />

            {/*
              * Workspaces live in the dedicated Workspace tab. Keeping a copy
              * here in Overview duplicated the surface and made the System
              * column feel like it owned Workspaces; both were the same data.
              */}
        </div>
    )
}
