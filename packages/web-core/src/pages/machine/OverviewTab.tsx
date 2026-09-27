/**
 * OverviewTab — System stats and resources for the machine.
 *
 * Workspaces are handled by the dedicated Workspace tab — this view stays
 * focused on the host (uptime, memory) and session counts.
 */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatUptime, formatBytes, PLATFORM_LABELS } from '../../utils/daemon-utils'
import ProgressBar from '../../components/ProgressBar'
import StatCard from '../../components/StatCard'
import Card from '../../components/Card'
import { IconClock, IconMonitor, IconTerminal, IconBot } from '../../components/Icons'
import {
    bindQuotaDisplayModel,
    createQuotaTextFormatter,
    collectQuotaEntries,
    formatQuotaAccount,
    quotaProviderLabel,
    type QuotaChipHint,
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

/** Hover-title i18n key per chip kind — page styling; chip CONTENT comes from the shared model. */
const QUOTA_CHIP_TITLE_KEYS: Record<QuotaChipHint, string> = {
    bucket: 'machine.quota.bucketHint',
    session: 'machine.quota.sessionHint',
    weekly: 'machine.quota.weeklyHint',
    monthly: 'machine.quota.monthlyHint',
    usage: 'machine.quota.usageHint',
}

function QuotaChip({ label, tone, title }: { label: string; tone: string; title?: string }) {
    return (
        <span title={title} className={`rounded-full px-2 py-0.5 text-3xs font-medium ${QUOTA_TONE_CLASS[tone] ?? QUOTA_TONE_CLASS.default}`}>
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
    // Localized binding; keeps the one-argument model call the drift guard pins.
    const buildQuotaDisplayModel = bindQuotaDisplayModel(createQuotaTextFormatter(t))
    const entries = collectQuotaEntries(machine.quota)
    if (entries.length === 0) return null
    return (
        <Card padding="lg" className="mb-5">
            <div className="text-2xs text-text-muted font-semibold uppercase tracking-wider mb-3">
                {t('machine.quota.title')}
            </div>
            <div className="flex flex-col gap-2">
                {entries.map(({ provider, quota }) => {
                    // Content assembly (cue, buckets-replace-axes, monthly,
                    // usage fallback, ok-without-windows vs failure) is the
                    // shared view-model's job; this card only styles it.
                    const model = buildQuotaDisplayModel(quota)
                    return (
                        <div key={provider} className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-text-primary min-w-[92px]">{quotaProviderLabel(provider)}</span>
                            {/* Whose quota — omitted entirely for providers that
                                report no account (Claude Code exposes none). */}
                            {formatQuotaAccount(quota) && (
                                <span className="text-3xs text-text-secondary" title={t('machine.quota.accountHint')}>
                                    {formatQuotaAccount(quota)}
                                </span>
                            )}
                            {model.kind === 'chips' && model.chips.map(chip => (
                                <QuotaChip key={chip.key} label={chip.label} tone={chip.tone} title={t(QUOTA_CHIP_TITLE_KEYS[chip.hint])} />
                            ))}
                            {/* Usage-shaped provider (opencode): absolute tokens/cost,
                                no percent windows to chip. */}
                            {model.kind === 'usage' && (
                                <QuotaChip label={model.usageLabel!} tone="info" title={t('machine.quota.usageHint')} />
                            )}
                            {/* 'ok' with no windows at all = a successful reading whose
                                provider has no percentage axis (cursor included-usage) —
                                its own message, never the failure line. */}
                            {model.kind === 'okNoWindows' && (
                                <span className="text-2xs text-text-secondary" title={t('machine.quota.okNoWindowsHint')}>
                                    {model.message ?? t('machine.quota.okNoWindows')}
                                </span>
                            )}
                            {model.kind === 'failure' && (
                                <span className="text-2xs text-text-secondary" title={t('machine.quota.failureHint')}>
                                    {model.message}
                                </span>
                            )}
                        </div>
                    )
                })}
            </div>
        </Card>
    )
}

export type MachineDiagnosticsSection = 'hosted-runtimes' | 'logs'

interface OverviewTabProps {
    machine: MachineData
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
    daemonVersion?: string
    /** Hosted runtimes panel — mounted only once its disclosure opens. */
    renderHostedRuntimes?: () => ReactNode
    /** Daemon logs panel — mounted only once its disclosure opens. */
    renderLogs?: () => ReactNode
    /** Open this diagnostics section on first render (old deep links). */
    initialDiagnostics?: MachineDiagnosticsSection | null
}

/**
 * A disclosure whose body mounts only once opened (and then stays mounted so
 * polling panels keep their state). Troubleshooting views are opt-in: they
 * fetch nothing until someone actually looks.
 */
function LazyDisclosure({ title, defaultOpen = false, testId, children }: {
    title: string
    defaultOpen?: boolean
    testId?: string
    children: () => ReactNode
}) {
    const [open, setOpen] = useState(defaultOpen)
    const [mounted, setMounted] = useState(defaultOpen)
    return (
        <details
            className="group rounded-xl border border-border-subtle bg-bg-glass"
            open={open}
            data-testid={testId}
            onToggle={(event) => {
                const next = (event.currentTarget as HTMLDetailsElement).open
                setOpen(next)
                if (next) setMounted(true)
            }}
        >
            <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-text-primary [&::-webkit-details-marker]:hidden">
                <span className="inline-block text-text-muted transition-transform group-open:rotate-90" aria-hidden>▸</span>
                {title}
            </summary>
            {mounted && <div className="px-4 pb-4">{children()}</div>}
        </details>
    )
}

export default function OverviewTab({
    machine, ideSessions, cliSessions, acpSessions, daemonVersion,
    renderHostedRuntimes, renderLogs, initialDiagnostics = null,
}: OverviewTabProps) {
    const { t } = useTranslation('common')
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
                <StatCard icon={<IconClock size={16} />} label={t('machine.overview.uptime')} value={typeof machine.uptime === 'number' ? formatUptime(machine.uptime) : t('machine.overview.waiting')} />
                <StatCard icon={<IconMonitor size={16} />} label="IDEs" value={`${ideSessions.length}`} />
                <StatCard icon={<IconTerminal size={16} />} label="CLIs" value={`${cliSessions.length}`} />
                <StatCard icon={<IconBot size={16} />} label="ACPs" value={`${acpSessions.length}`} />
            </div>

            {/* Resource Usage */}
            <Card padding="lg" className="mb-5">
                <div className="text-2xs text-text-muted font-semibold uppercase tracking-wider mb-3">
                    {t('machine.overview.resourceUsage')}
                </div>
                <div className="flex gap-6">
                    <ProgressBar value={hasRuntimeStats ? Math.min(Math.round(loadAvg1m / machine.cpus * 100), 100) : 0} max={100} label={t('machine.overview.cpuLoad')} color="#8b5cf6" detail={hasRuntimeStats ? t('machine.overview.cpuDetail', { load: loadAvg1m.toFixed(2), cores: machine.cpus }) : t('machine.overview.waitingForStats')} />
                    <ProgressBar value={memUsedPct} max={100} label={t('machine.overview.memory')} color="#3b82f6" detail={hasRuntimeStats ? `${formatBytes(machine.totalMem - memAvail)} / ${formatBytes(machine.totalMem)}${machine.platform === 'darwin' ? ` ${t('machine.overview.approx')}` : ''}` : t('machine.overview.waitingForStatsWithTotal', { total: formatBytes(machine.totalMem) })} />
                </div>
            </Card>

            {/* Plan quota — self-hiding when this machine has reported none. */}
            <PlanQuotaCard machine={machine} />

            {/* The host facts the page header used to carry. */}
            <Card padding="lg" className="mb-5">
                <div className="text-2xs text-text-muted font-semibold uppercase tracking-wider mb-3">
                    {t('machine.overview.aboutMachine')}
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2" data-testid="machine-about">
                    <AboutRow label={t('machine.overview.hostname')} value={machine.hostname} />
                    <AboutRow label={t('machine.overview.platform')} value={[PLATFORM_LABELS[machine.platform] || machine.platform, machine.arch].filter(Boolean).join(' · ')} />
                    {machine.cpus > 0 && <AboutRow label={t('machine.overview.cores')} value={String(machine.cpus)} />}
                    {daemonVersion && <AboutRow label={t('machine.overview.daemonVersion')} value={`v${daemonVersion}`} />}
                    {machine.p2p?.available && (
                        <AboutRow
                            label={t('machine.overview.p2p')}
                            value={machine.p2p.state === 'connected' ? t('machine.detail.p2pConnected') : machine.p2p.state}
                        />
                    )}
                </dl>
            </Card>

            {(renderHostedRuntimes || renderLogs) && (
                <details className="group mb-5" data-testid="machine-diagnostics" open={initialDiagnostics ? true : undefined}>
                    <summary className="mb-3 flex cursor-pointer select-none list-none items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-text-muted [&::-webkit-details-marker]:hidden">
                        <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>▸</span>
                        {t('machine.overview.diagnostics')}
                    </summary>
                    <div className="flex flex-col gap-3">
                        {renderHostedRuntimes && (
                            <LazyDisclosure title={t('machine.detail.tabHostedRuntimes')} defaultOpen={initialDiagnostics === 'hosted-runtimes'} testId="machine-diagnostics-hosted-runtimes">
                                {renderHostedRuntimes}
                            </LazyDisclosure>
                        )}
                        {renderLogs && (
                            <LazyDisclosure title={t('machine.detail.tabLogs')} defaultOpen={initialDiagnostics === 'logs'} testId="machine-diagnostics-logs">
                                {renderLogs}
                            </LazyDisclosure>
                        )}
                    </div>
                </details>
            )}

            {/*
              * Workspaces live in the dedicated Workspace tab. Keeping a copy
              * here in Overview duplicated the surface and made the System
              * column feel like it owned Workspaces; both were the same data.
              */}
        </div>
    )
}

function AboutRow({ label, value }: { label: string; value: string }) {
    if (!value) return null
    return (
        <div className="flex min-w-0 items-baseline justify-between gap-3 sm:justify-start">
            <dt className="shrink-0 text-text-muted sm:w-28">{label}</dt>
            <dd className="m-0 min-w-0 truncate text-text-primary">{value}</dd>
        </div>
    )
}
