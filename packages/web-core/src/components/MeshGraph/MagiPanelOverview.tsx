/**
 * MAGI Panel Overview — READ-ONLY mesh-overview surface for machine-local MAGI
 * panels. It lists the saved (node × provider) cross-verification quorums using the
 * same `MagiPanelSummaryRow` the CRUD editor renders, so the read and edit views
 * never drift. There is NO create / edit / delete affordance here: panel CRUD lives
 * only on the /mesh detail page (MeshDetailView → MagiPanelManager). This component
 * is mounted as a sibling of the overview cards inside MeshObservabilitySurface so
 * the mesh dialog and the /mesh page both show the panels at a glance, while only
 * /mesh can mutate them.
 *
 * Data comes through the SAME `sendDaemonCommand` seam MagiPanelManager uses
 * (`magi_panel_list`) — cloud routes it P2P-only, standalone over localhost:3847.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MagiPanelMap } from '@adhdev/mesh-shared'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import type { MagiResolveNode } from '../../utils/magi-panel-resolve'
import { MagiPanelSummaryRow } from './MagiPanelManager'

interface MagiPanelOverviewProps {
    status: RepoMeshStatus
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}

export default function MagiPanelOverview({ status, daemonId, sendDaemonCommand }: MagiPanelOverviewProps) {
    const { theme } = useTheme()
    const meshTheme: MeshGraphTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    const [panels, setPanels] = useState<MagiPanelMap>({})
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const liveNodes: MagiResolveNode[] = useMemo(
        () => status.nodes.map(n => ({ nodeId: n.nodeId, providers: n.providers, providerPriority: n.providerPriority })),
        [status.nodes],
    )

    const canCommand = !!daemonId && !!sendDaemonCommand

    const unwrap = (raw: any) => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

    const loadPanels = useCallback(async () => {
        if (!daemonId || !sendDaemonCommand) return
        setLoading(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'magi_panel_list', {})
            const result = unwrap(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to load MAGI panels')
            setPanels((result?.panels && typeof result.panels === 'object') ? result.panels : {})
        } catch (e: any) {
            setError(e?.message || 'Failed to load MAGI panels')
        } finally {
            setLoading(false)
        }
    }, [daemonId, sendDaemonCommand])

    useEffect(() => { void loadPanels() }, [loadPanels])

    const panelEntries = useMemo(() => Object.entries(panels).sort((a, b) => a[0].localeCompare(b[0])), [panels])

    // Nothing to show and nothing to say when the mesh can't be queried — stay quiet
    // so the overview isn't cluttered with an inert panel block on disconnected views.
    if (!canCommand && panelEntries.length === 0) return null

    return (
        <div className={`${meshTheme.cardClass} flex flex-col gap-2 rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>MAGI panels</span>
                <span className={`text-[11px] ${meshTheme.textSecondary}`}>
                    Saved (machine × AI) cross-verification quorums. Manage them on the Mesh page.
                </span>
                {loading && <span className={`text-[10px] ${meshTheme.textMuted}`}>Loading…</span>}
            </div>

            {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">{error}</div>
            )}

            {panelEntries.length === 0 && !loading && !error ? (
                <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    No MAGI panels configured on this machine yet. Create one from the Mesh page.
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {panelEntries.map(([name, panel]) => (
                        <div key={name} className={`rounded-xl border p-3 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
                            <MagiPanelSummaryRow name={name} panel={panel} liveNodes={liveNodes} meshTheme={meshTheme} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
