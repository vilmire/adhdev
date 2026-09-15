/**
 * BlueprintScopeChips — the section filters replacing the old single
 * "Include finished" checkbox. Running/Blocked toggle their sections,
 * History reveals the terminal strip (Recent 10 + load-more), By mission
 * regroups the visible rows under mission headers (P1 scope of the future
 * mission accordion).
 *
 * Default view = Running + Blocked only — the list opens on the live plan,
 * with history one tap away, not one scroll-wall away.
 */
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'

export interface BlueprintScope {
    running: boolean
    blocked: boolean
    /** Terminal rows (Recent + History sections). */
    history: boolean
    /** Regroup visible rows under mission headers. */
    byMission: boolean
}

export const DEFAULT_BLUEPRINT_SCOPE: BlueprintScope = {
    running: true,
    blocked: true,
    history: false,
    byMission: false,
}

export default function BlueprintScopeChips({ scope, onToggle, meshTheme }: {
    scope: BlueprintScope
    onToggle: (key: keyof BlueprintScope) => void
    meshTheme: MeshGraphTheme
}) {
    const { t } = useTranslation('common')
    const chip = (key: keyof BlueprintScope, label: string) => {
        const active = scope[key]
        return (
            <button
                type="button"
                onClick={() => onToggle(key)}
                aria-pressed={active}
                className={`shrink-0 whitespace-nowrap rounded-md border px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide transition-colors ${active
                    ? (meshTheme.isDark ? 'border-sky-400/30 bg-sky-500/15 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700')
                    : (meshTheme.isDark ? 'border-white/8 bg-transparent text-slate-500 hover:bg-white/[0.05]' : 'border-slate-200 bg-transparent text-slate-400 hover:bg-slate-50')}`}
            >
                {label}
            </button>
        )
    }
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {chip('running', t('mesh.blueprint.list.sectionRunning'))}
            {chip('blocked', t('mesh.blueprint.list.sectionBlocked'))}
            {chip('byMission', t('mesh.blueprint.list.chipByMission'))}
            {chip('history', t('mesh.blueprint.list.sectionHistory'))}
        </div>
    )
}
