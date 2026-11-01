/**
 * Release badge on a mission row (design 2026-11-01-release-objects §7): which release this mission
 * belongs to, with "move to another release" in place. Shows nothing when the daemon has no release
 * support or the mission is in no release. A move is an explicit click — `release_scope.move`.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useReleasesContext } from './useReleases'

export default function ReleaseBadge({ missionId }: { missionId: string }) {
    const { t } = useTranslation('common')
    const releases = useReleasesContext()
    const [open, setOpen] = useState(false)
    const membership = releases?.list?.membership[missionId]
    if (!releases?.list || !membership) return null
    const targets = releases.list.releases.filter(r => r.id !== membership.releaseId && r.status !== 'superseded' && r.status !== 'cancelled')
    return (
        <span className="inline-flex min-w-0 flex-col" data-testid="mission-release">
            <button
                type="button"
                data-testid="mission-release-badge"
                className="rounded px-1.5 py-0.5 text-3xs font-bold"
                style={{ background: 'color-mix(in srgb, var(--accent-primary) 16%, transparent)', color: 'var(--accent-primary)' }}
                title={t('mesh.overview.releases.badgeTitle', { name: membership.name })}
                aria-expanded={open}
                onClick={() => setOpen(v => !v)}
            >{membership.name}</button>
            {open && targets.length > 0 && (
                <select
                    data-testid="mission-release-move"
                    aria-label={t('mesh.overview.releases.moveBadge')}
                    className="mt-1 max-w-full rounded border border-border-subtle bg-bg-card px-1 py-0.5 text-3xs"
                    value=""
                    disabled={releases.busy}
                    onChange={e => {
                        const to = e.target.value
                        if (to) void releases.scope(membership.releaseId, { move: [{ missionId, toReleaseId: to }] }).then(() => setOpen(false))
                    }}
                >
                    <option value="">{t('mesh.overview.releases.moveTo')}</option>
                    {targets.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
            )}
        </span>
    )
}
