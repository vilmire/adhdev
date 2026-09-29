/**
 * BlueprintViewSwitch — the List / Graph segmented control on the Blueprint
 * header row. Stateless: MeshBlueprintView owns (and persists) the mode.
 */
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'
import type { BlueprintViewMode } from './blueprintViewMode'

export default function BlueprintViewSwitch({ mode, onChange }: {
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
                className={`inline-flex h-5 items-center rounded-full px-2 text-3xs font-medium leading-none transition-colors ${active
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-muted hover:text-text-primary'}`}
            >
                {label}
            </button>
        )
    }
    return (
        <div
            role="radiogroup"
            aria-label={t('mesh.blueprint.graph.viewSwitchLabel')}
            className="flex h-6 shrink-0 items-center gap-0.5 rounded-full border border-border-default p-0.5"
        >
            {option('list', t('mesh.blueprint.graph.viewList'))}
            {option('graph', t('mesh.blueprint.graph.viewGraph'))}
        </div>
    )
}
