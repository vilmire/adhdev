/**
 * FleetQuotaCard — every machine's plan quota on one grid (machines × CLIs).
 *
 * The per-machine Overview card answers "how is this box doing"; the queue's
 * routing question is "which subscription, on which machine, still has room".
 * Each cell shows the 5h and weekly axes of one provider on one machine, built
 * by the same shared display model as the Overview card so the two agree.
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
    type QuotaDisplayChip,
} from '../../utils/quota-format'
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'

const TONE_CLASS: Record<string, string> = {
    good: 'bg-emerald-500/10 text-emerald-500',
    warn: 'bg-amber-500/10 text-amber-500',
    danger: 'bg-red-500/10 text-red-500',
    default: 'bg-white/5 text-text-secondary',
    info: 'bg-blue-500/10 text-blue-500',
}

export interface FleetQuotaMachine {
    machineId: string
    label: string
    quota: Record<string, MeshNodeFactsProviderQuota> | undefined
}

/** "5h 26.0% used · resets in 2h" → "5h 26%": the full text stays in the hover title. */
function shortChipLabel(chip: QuotaDisplayChip): string {
    const axis = chip.key === 'session' ? '5h' : chip.key === 'weekly' ? '7d' : chip.key === 'monthly' ? '30d' : chip.key
    // A window that just reset (or is awaiting its first reading) has no number
    // yet; the long cue text stays in the hover title, the grid shows a dash.
    if (chip.usedPercent === null) return chip.key === 'usage' ? chip.label : `${axis} —`
    return `${axis} ${Math.round(chip.usedPercent)}%`
}

export default function FleetQuotaCard({ machines }: { machines: FleetQuotaMachine[] }) {
    const { t } = useTranslation('common')
    const navigate = useNavigate()
    const buildModel = bindQuotaDisplayModel(createQuotaTextFormatter(t))

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
                                        const chips = model.chips.filter(chip => chip.key === 'session' || chip.key === 'weekly')
                                        const shown = chips.length > 0 ? chips : model.compactChip ? [model.compactChip] : []
                                        return (
                                            <td key={provider} className="px-2 align-top">
                                                <div className="flex flex-wrap gap-1">
                                                    {shown.map(chip => (
                                                        <span
                                                            key={chip.key}
                                                            title={chip.label}
                                                            className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-3xs font-medium ${TONE_CLASS[chip.tone] ?? TONE_CLASS.default}`}
                                                        >
                                                            {shortChipLabel(chip)}
                                                        </span>
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
