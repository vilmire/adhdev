/**
 * Lazy boundary for the mesh graph dialog.
 *
 * DashboardMeshGraphDialog pulls the whole mesh observability stack —
 * MeshObservabilitySurface, the @xyflow/react canvases and elkjs's bundled
 * layout engine (~1.5 MB raw) — but it only opens on an explicit click (the
 * dashboard header's mesh button, the /mesh detail "graph" button). Importing it
 * statically put all of that on the critical path of every route, /terms
 * included. Both mount sites import THIS module instead, so the heavy stack is
 * fetched the first time a dialog actually opens.
 *
 * `import type` keeps the prop contract single-sourced without creating a
 * runtime edge back to the heavy module.
 */
import { lazy, Suspense, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import type DashboardMeshGraphDialogComponent from './DashboardMeshGraphDialog'
import { DialogShell } from '../ui/Dialog'
import LoadingSpinner from '../ui/LoadingSpinner'

export type DashboardMeshGraphDialogProps = ComponentProps<typeof DashboardMeshGraphDialogComponent>

/** Start fetching the dialog chunk ahead of the first open (e.g. on hover). */
export function preloadDashboardMeshGraphDialog() {
    return import('./DashboardMeshGraphDialog')
}

const DashboardMeshGraphDialogImpl = lazy(preloadDashboardMeshGraphDialog)

function DashboardMeshGraphDialogFallback({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation()
    const label = t('connection.loadingShort')
    return (
        <DialogShell onClose={onClose} size="sm" ariaLabel={label}>
            <div className="flex items-center justify-center p-8" data-testid="mesh-graph-dialog-loading">
                <LoadingSpinner label={label} />
            </div>
        </DialogShell>
    )
}

export default function LazyDashboardMeshGraphDialog(props: DashboardMeshGraphDialogProps) {
    return (
        <Suspense fallback={<DashboardMeshGraphDialogFallback onClose={props.onClose} />}>
            <DashboardMeshGraphDialogImpl {...props} />
        </Suspense>
    )
}
