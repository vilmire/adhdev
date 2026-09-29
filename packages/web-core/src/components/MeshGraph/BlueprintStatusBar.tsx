/**
 * BlueprintStatusBar — the one-line rollup at the top of the blueprint list:
 * `Active N | Blocked N | Recent N | Missions N`. Each segment is a real
 * button: Active/Blocked/Recent toggle their section's scope chip, Missions
 * toggles the by-mission grouping — the bar is navigation, not decoration
 * (same rule the old canvas's stat chips followed).
 */
import { useTranslation } from 'react-i18next'
import { meshToggleChipClass, type MeshGraphTheme } from './meshGraphTheme'
import type { BlueprintGroupCounts } from './useBlueprintGroups'
import type { BlueprintScope } from './BlueprintScopeChips'

export default function BlueprintStatusBar({ counts, scope, onToggle }: {
    counts: BlueprintGroupCounts
    scope: BlueprintScope
    onToggle: (key: keyof BlueprintScope) => void
    meshTheme: MeshGraphTheme
}) {
    const { t } = useTranslation('common')
    const segment = (label: string, active: boolean, urgent: boolean, onClick: () => void) => (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={urgent
                ? `inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full border border-status-warning/40 px-2.5 text-3xs font-medium leading-none text-status-warning transition-colors hover:bg-bg-glass-hover ${active ? '' : 'opacity-70'}`
                : meshToggleChipClass(active)}
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
