/**
 * Structured-mission facts on the Overview mission cards (design 2026-10-28 §7): the mission's
 * one-line summary, open item counts and a decision badge linking to `/needs-you?mesh=…`.
 * The facts come from the owner-decision inbox state (`mission_decisions_list` with
 * `includeMissions`) rather than the strict mesh.status mission wire, so older daemons simply
 * show nothing extra. Also hosts the carry-over title localization.
 */
import { useInRouterContext, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useNeedsYou } from '../../context/NeedsYouContext'
import { missionDisplayTitle, type NeedsYouMissionStructure } from '../needs-you/needs-you-model'
import type { MeshGraphTheme } from './meshGraphTheme'

export function useMissionStructure(meshId: string | undefined, missionId: string): { structure?: NeedsYouMissionStructure; decisions: number } {
    const { snapshot } = useNeedsYou()
    const structure = snapshot.missions.find(m => m.missionId === missionId && (!meshId || m.meshId === meshId))
    const decisions = snapshot.decisions.filter(d => d.missionId === missionId && (!meshId || d.meshId === meshId)).length
    return { structure, decisions }
}

/** The mission's display title: the auto carry-over mission is shown through the locale string. */
export function useMissionTitle(mission: { id: string; meshId?: string; title: string }): string {
    const { t } = useTranslation('common')
    const { structure } = useMissionStructure(mission.meshId, mission.id)
    return missionDisplayTitle({ title: mission.title, carryOver: structure?.carryOver }, t('needsYou.carryOverTitle'))
}

function DecisionBadge({ meshId, count }: { meshId?: string; count: number }) {
    const { t } = useTranslation('common')
    const navigate = useNavigate()
    const to = `/needs-you${meshId ? `?mesh=${encodeURIComponent(meshId)}` : ''}`
    return (
        <button
            type="button"
            data-testid="mission-decision-badge"
            className="rounded px-1.5 py-0.5 text-3xs font-bold"
            style={{ background: 'color-mix(in srgb, var(--status-warning) 20%, transparent)', color: 'var(--status-warning)' }}
            title={t('needsYou.decisionBadgeLabel')}
            onClick={() => navigate(to)}
        >{t('needsYou.decisionsWaiting', { count })}</button>
    )
}

export default function MissionStructureLine({ meshTheme, mission }: {
    meshTheme: MeshGraphTheme
    mission: { id: string; meshId?: string }
}) {
    const { t } = useTranslation('common')
    const inRouter = useInRouterContext()
    const { structure, decisions } = useMissionStructure(mission.meshId, mission.id)
    const open = structure ? structure.openItems.remaining + structure.openItems.live_check + structure.openItems.evidence : 0
    if (!structure?.summary && open === 0 && decisions === 0) return null
    return (
        <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 pb-1 text-3xs ${meshTheme.textMuted}`} data-testid="mission-structure-line">
            {structure?.summary && <span className="min-w-0 flex-1 truncate" title={structure.summary}>{structure.summary}</span>}
            {open > 0 && <span className="tabular-nums">{t('needsYou.openItems', { count: open })}</span>}
            {structure && structure.openItems.live_check > 0 && <span className="tabular-nums">{t('needsYou.liveChecksOpen', { count: structure.openItems.live_check })}</span>}
            {decisions > 0 && (inRouter
                ? <DecisionBadge meshId={mission.meshId} count={decisions} />
                : <span className="font-bold">{t('needsYou.decisionsWaiting', { count: decisions })}</span>)}
        </div>
    )
}
