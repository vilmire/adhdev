/**
 * BlueprintStatusBar — the one-line rollup at the top of the blueprint list:
 * `Active N | Blocked N | Recent N | Missions N`. Each segment is a real
 * button: Active/Blocked/Recent toggle their section's scope chip, Missions
 * toggles the by-mission grouping — the bar is navigation, not decoration
 * (same rule the old canvas's stat chips followed).
 */
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'
import type { BlueprintGroupCounts } from './useBlueprintGroups'
import type { BlueprintScope } from './BlueprintScopeChips'

export default function BlueprintStatusBar({ counts, scope, onToggle, meshTheme }: {
    counts: BlueprintGroupCounts
    scope: BlueprintScope
    onToggle: (key: keyof BlueprintScope) => void
    meshTheme: MeshGraphTheme
}) {
    const { t } = useTranslation('common')
    const segment = (label: string, active: boolean, urgent: boolean, onClick: () => void) => (
        <button
            type="button"
            onClick={onClick}
            className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-3xs font-medium transition-colors ${urgent
                ? (meshTheme.isDark ? 'border-amber-400/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20' : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100')
                : active
                    ? (meshTheme.isDark ? 'border-white/15 bg-white/[0.07] text-slate-200 hover:bg-white/[0.12]' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')
                    : (meshTheme.isDark ? 'border-white/8 bg-transparent text-slate-500 hover:bg-white/[0.05]' : 'border-slate-200 bg-transparent text-slate-400 hover:bg-slate-50')}`}
        >
            {label}
        </button>
    )
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {segment(t('mesh.blueprint.list.barActive', { count: counts.running }), scope.running, false, () => onToggle('running'))}
            {segment(t('mesh.blueprint.list.barBlocked', { count: counts.blocked }), scope.blocked, counts.blocked > 0, () => onToggle('blocked'))}
            {segment(t('mesh.blueprint.list.barRecent', { count: counts.recent }), scope.history, false, () => onToggle('history'))}
            {segment(t('mesh.blueprint.list.barMissions', { count: counts.missions }), scope.byMission, false, () => onToggle('byMission'))}
        </div>
    )
}
