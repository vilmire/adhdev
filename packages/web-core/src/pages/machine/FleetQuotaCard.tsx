/**
 * FleetQuotaCard — every machine's plan quota on one grid (machines × CLIs).
 *
 * The per-machine Overview card answers "how is this box doing"; the queue's
 * routing question is "which subscription, on which machine, still has room".
 * Each cell shows the shared display model's chips: Antigravity per-pool
 * buckets when the API returned them, otherwise the 5h/weekly axes — never a
 * fabricated second pool. Compact worst-headline stays available for routing
 * consumers; this grid must not collapse pools back to one compactChip.
 *
 * Renders nothing until at least one machine has reported a quota reading.
 */
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ProviderLogo } from '../../components/ProviderLogo'
import {
    bindQuotaDisplayModel,
    collectQuotaEntries,
    createQuotaTextFormatter,
    quotaProviderLabel,
    selectMachineQuotaChips,
    shortQuotaChipLabel,
    type QuotaChipHint,
} from '../../utils/quota-format'
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'
import { MachineQuotaChip } from './MachineQuotaChip'

const QUOTA_CHIP_TITLE_KEYS: Record<QuotaChipHint, string> = {
    bucket: 'machine.quota.bucketHint',
    session: 'machine.quota.sessionHint',
    weekly: 'machine.quota.weeklyHint',
    monthly: 'machine.quota.monthlyHint',
    usage: 'machine.quota.usageHint',
}

export interface FleetQuotaMachine {
    machineId: string
    label: string
    quota: Record<string, MeshNodeFactsProviderQuota> | undefined
}

export default function FleetQuotaCard({ machines }: { machines: FleetQuotaMachine[] }) {
    const { t, i18n } = useTranslation('common')
    const navigate = useNavigate()
    const fmt = createQuotaTextFormatter(t)
    const buildModel = bindQuotaDisplayModel(fmt)

    const rows = machines
        .map(machine => ({ machine, entries: collectQuotaEntries(machine.quota) }))
        .filter(row => row.entries.length > 0)
    if (rows.length === 0) return null

    const providers = Array.from(new Set(rows.flatMap(row => row.entries.map(entry => entry.provider))))
        .sort((a, b) => quotaProviderLabel(a).localeCompare(quotaProviderLabel(b)))

    return (
        <div className="mb-6 rounded-xl border border-border-subtle bg-bg-glass p-4">
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-text-muted">{t('machine.fleetQuota.title')}</div>
            <div className="mb-3 text-xs text-text-secondary">{t('machine.fleetQuota.subtitle')}</div>
            <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-y-1 text-left">
                    <thead>
                        <tr>
                            <th className="pr-3 text-3xs font-medium text-text-muted">{t('machine.fleetQuota.machine')}</th>
                            {providers.map(provider => (
                                <th key={provider} className="px-2 text-3xs font-medium text-text-muted">
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                        <ProviderLogo type={provider} label={quotaProviderLabel(provider)} size={14} />
                                        {quotaProviderLabel(provider)}
                                    </span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(({ machine, entries }) => {
                            const byProvider = new Map(entries.map(entry => [entry.provider, entry.quota]))
                            return (
                                <tr key={machine.machineId}>
                                    <td className="pr-3 align-top">
                                        <button
                                            type="button"
                                            onClick={() => navigate(`/machines/${encodeURIComponent(machine.machineId)}`)}
                                            className="whitespace-nowrap text-xs font-medium text-text-primary hover:underline"
                                        >
                                            {machine.label}
                                        </button>
                                    </td>
                                    {providers.map(provider => {
                                        const quota = byProvider.get(provider)
                                        if (!quota) {
                                            return <td key={provider} className="px-2 align-top text-3xs text-text-muted">·</td>
                                        }
                                        const model = buildModel(quota)
                                        const shown = selectMachineQuotaChips(model, 'fleet')
                                        return (
                                            <td key={provider} className="px-2 align-top">
                                                <div className="flex max-w-[18rem] flex-wrap gap-1">
                                                    {shown.map(chip => (
                                                        <MachineQuotaChip
                                                            key={chip.key}
                                                            chip={chip}
                                                            kindHint={t(QUOTA_CHIP_TITLE_KEYS[chip.hint])}
                                                            label={shortQuotaChipLabel(chip)}
                                                            fmt={fmt}
                                                            locale={i18n.language}
                                                        />
                                                    ))}
                                                    {shown.length === 0 && (
                                                        <span
                                                            title={model.message ?? model.usageLabel ?? undefined}
                                                            className="text-3xs text-text-muted"
                                                        >
                                                            {model.kind === 'failure' ? t('machine.fleetQuota.unreadable') : '—'}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                        )
                                    })}
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
