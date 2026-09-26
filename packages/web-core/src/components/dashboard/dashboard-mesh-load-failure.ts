/**
 * Where a failed mesh_status load is surfaced in the mesh graph dialog.
 *
 * The page-level (red) banner is reserved for "the dashboard could not get an
 * answer from the coordinator and has nothing to show" — the first load, or a
 * refresh the user explicitly asked for. A BACKGROUND refresh (auto-retry,
 * interval, revision push) failing while a graph is already on screen is shown
 * quietly: the graph is the coordinator's last answer and remote-node slowness
 * is already expressed per node (age / unreachable markers).
 */
export type DashboardMeshLoadFailureSurface = 'banner' | 'quiet'

export function classifyDashboardMeshLoadFailure(args: { background: boolean; hasGraph: boolean }): DashboardMeshLoadFailureSurface {
    return args.background && args.hasGraph ? 'quiet' : 'banner'
}
