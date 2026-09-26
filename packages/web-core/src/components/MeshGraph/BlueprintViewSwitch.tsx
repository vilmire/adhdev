/**
 * BlueprintViewSwitch — the List / Graph segmented control on the Blueprint
 * header row. Stateless: MeshBlueprintView owns (and persists) the mode.
 */
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'
import type { BlueprintViewMode } from './blueprintViewMode'

export default function BlueprintViewSwitch({ mode, onChange, meshTheme }: {
    mode: BlueprintViewMode
    onChange: (mode: BlueprintViewMode) => void
    meshTheme: MeshGraphTheme
}) {
    const { t } = useTranslation('common')
    const option = (value: BlueprintViewMode, label: string) => {
        const active = mode === value
        return (
            <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`blueprint-view-${value}`}
                onClick={() => { if (!active) onChange(value) }}
                className={`rounded-full px-2 py-0.5 text-3xs font-semibold transition-colors ${active
                    ? (meshTheme.isDark ? 'bg-sky-500/20 text-sky-100' : 'bg-sky-100 text-sky-800')
                    : (meshTheme.isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800')}`}
            >
                {label}
            </button>
        )
    }
    return (
        <div
            role="radiogroup"
            aria-label={t('mesh.blueprint.graph.viewSwitchLabel')}
            className={`flex shrink-0 items-center gap-0.5 rounded-full border p-0.5 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/60' : 'border-slate-200 bg-white/90'}`}
        >
            {option('list', t('mesh.blueprint.graph.viewList'))}
            {option('graph', t('mesh.blueprint.graph.viewGraph'))}
        </div>
    )
}
