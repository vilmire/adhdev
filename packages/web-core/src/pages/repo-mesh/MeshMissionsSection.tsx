/**
 * Missions section — list the mesh's missions with an on-demand full-goal fetch.
 *
 * `mesh_status` returns missions in the SLIM projection by default (MeshMissionSlimSummary:
 * `goalPreview` + `goalTruncated`, the full `goal` elided to bound the per-poll payload).
 * So the page can show every mission's title/status/task-aggregate and a goal PREVIEW for
 * free off the already-loaded `status.missions`, but the full goal text needs an explicit
 * verbose fetch.
 *
 * fix(b): "Show full goal" calls `mesh_status` with `verbose: true`, which restores the
 * dashboard-grade missions (full `goal` text) — the backend verbose goal path already
 * exists; this only wires the front end. The verbose result is matched back by mission id
 * and the full goal cached per-mission so a second expand is instant.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { Section } from '../../components/ui/Section'

type MissionLike = {
    id: string
    title?: string
    status?: string
    goal?: string
    goalPreview?: string
    goalTruncated?: boolean
    tasks?: { total?: number; completed?: number; failed?: number }
}

interface MeshMissionsSectionProps {
    status: RepoMeshStatus | null
    daemonId: string
    meshId: string
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

const unwrap = (raw: any): any => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

/** Pull RepoMeshStatus out of a mesh_status response (cloud/P2P wraps under result / result.status). */
function extractStatus(raw: any): any {
    const body = unwrap(raw)
    if (body && typeof body === 'object' && body.status && typeof body.status === 'object' && Array.isArray(body.status.missions)) return body.status
    return body
}

function readMissions(status: RepoMeshStatus | null): MissionLike[] {
    const raw = (status as { missions?: unknown } | null)?.missions
    return Array.isArray(raw) ? (raw as MissionLike[]) : []
}

function goalPreviewOf(m: MissionLike): { text: string; truncated: boolean } {
    if (typeof m.goal === 'string' && m.goal) return { text: m.goal, truncated: false }
    return { text: m.goalPreview ?? '', truncated: m.goalTruncated === true }
}

const STATUS_FILTERS = ['active', 'paused', 'completed', 'abandoned'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number] | 'all'

/** Missions without a status are treated as active (the ledger default). */
function missionStatusOf(m: MissionLike): string {
    return (m.status || 'active').toLowerCase()
}

const COLLAPSED_LIMIT = 8

export function MeshMissionsSection({ status, daemonId, meshId, sendCommand }: MeshMissionsSectionProps) {
    const { t } = useTranslation('common')
    const missions = useMemo(() => readMissions(status), [status])
    // Full goal text fetched on demand, keyed by mission id.
    const [fullGoals, setFullGoals] = useState<Record<string, string>>({})
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    const [fetching, setFetching] = useState(false)
    const [fetchError, setFetchError] = useState<string | null>(null)
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
    const [showAll, setShowAll] = useState(false)

    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = {}
        for (const m of missions) {
            const s = missionStatusOf(m)
            counts[s] = (counts[s] || 0) + 1
        }
        return counts
    }, [missions])

    const filtered = useMemo(
        () => (statusFilter === 'all' ? missions : missions.filter(m => missionStatusOf(m) === statusFilter)),
        [missions, statusFilter],
    )
    const visible = showAll ? filtered : filtered.slice(0, COLLAPSED_LIMIT)
    const hiddenCount = filtered.length - visible.length

    const canCommand = !!daemonId && missions.length > 0

    const fetchFullGoals = useCallback(async () => {
        if (!daemonId) return
        setFetching(true)
        setFetchError(null)
        try {
            const raw = await sendCommand(daemonId, 'mesh_status', { meshId, verbose: true })
            const verbose = extractStatus(raw)
            const verboseMissions: MissionLike[] = Array.isArray(verbose?.missions) ? verbose.missions : []
            const next: Record<string, string> = {}
            for (const m of verboseMissions) {
                if (m.id && typeof m.goal === 'string' && m.goal) next[m.id] = m.goal
            }
            setFullGoals(prev => ({ ...prev, ...next }))
        } catch (err) {
            setFetchError(err instanceof Error ? err.message : t('repoMesh.missions.errorFetch'))
        } finally {
            setFetching(false)
        }
    }, [daemonId, meshId, sendCommand, t])

    const toggle = useCallback((id: string) => {
        setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
        // Lazily fetch full goals the first time any goal is expanded.
        if (!expanded[id] && !fullGoals[id]) void fetchFullGoals()
    }, [expanded, fullGoals, fetchFullGoals])

    if (missions.length === 0) return null

    return (
        <Section title={t('repoMesh.missions.title')} description={t('repoMesh.missions.description')}>
            {fetchError && <div className="mb-3 text-[12px] text-amber-400">{fetchError}</div>}
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {STATUS_FILTERS.filter(s => (statusCounts[s] || 0) > 0).map(s => (
                    <button
                        key={s}
                        type="button"
                        onClick={() => { setStatusFilter(s); setShowAll(false) }}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors ${
                            statusFilter === s
                                ? 'border-accent-primary text-accent-primary'
                                : 'border-border-subtle text-text-muted hover:text-text-secondary'
                        }`}
                    >
                        {s} {statusCounts[s]}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => { setStatusFilter('all'); setShowAll(false) }}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                        statusFilter === 'all'
                            ? 'border-accent-primary text-accent-primary'
                            : 'border-border-subtle text-text-muted hover:text-text-secondary'
                    }`}
                >
                    All {missions.length}
                </button>
            </div>
            {filtered.length === 0 && (
                <div className="text-[12px] text-text-muted">{t('repoMesh.missions.empty', { status: statusFilter })}</div>
            )}
            <div className="flex flex-col gap-2">
                {visible.map(mission => {
                    const isOpen = expanded[mission.id] === true
                    const full = fullGoals[mission.id]
                    const preview = goalPreviewOf(mission)
                    const goalText = isOpen && full ? full : preview.text
                    const stillTruncated = isOpen && !full && preview.truncated
                    const total = mission.tasks?.total ?? 0
                    return (
                        <div key={mission.id} className="rounded-lg border border-border-subtle bg-bg-secondary/60 px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={mission.title}>
                                    {mission.title || mission.id}
                                </span>
                                {mission.status && (
                                    <span className="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                                        {mission.status}
                                    </span>
                                )}
                                {total > 0 && (
                                    <span className="shrink-0 text-[11px] text-text-muted">{t('repoMesh.missions.taskCount', { count: total })}</span>
                                )}
                            </div>
                            {goalText && (
                                <div className={`mt-1.5 whitespace-pre-wrap text-[12px] leading-5 text-text-secondary ${isOpen ? 'max-h-72 overflow-y-auto' : 'line-clamp-2'}`}>
                                    {goalText}
                                    {stillTruncated && <span className="text-text-muted">{t('repoMesh.missions.goalUnavailable')}</span>}
                                </div>
                            )}
                            {(preview.truncated || full) && canCommand && (
                                <button
                                    type="button"
                                    className="mt-1.5 text-[12px] text-accent-primary hover:underline disabled:opacity-50"
                                    onClick={() => toggle(mission.id)}
                                    disabled={fetching}
                                >
                                    {isOpen ? t('repoMesh.missions.showLess') : fetching && !full ? t('repoMesh.missions.loading') : t('repoMesh.missions.showFullGoal')}
                                </button>
                            )}
                        </div>
                    )
                })}
            </div>
            {hiddenCount > 0 && (
                <button
                    type="button"
                    className="mt-2 text-[12px] text-accent-primary hover:underline"
                    onClick={() => setShowAll(true)}
                >
                    {t('repoMesh.missions.showMore', { count: hiddenCount })}
                </button>
            )}
        </Section>
    )
}

export default MeshMissionsSection
