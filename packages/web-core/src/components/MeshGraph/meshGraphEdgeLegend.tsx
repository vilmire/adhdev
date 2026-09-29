/**
 * Edge colours + the edge-type legend for the mesh topology map. Kept out of
 * MeshGraphView (React Flow + ELK) so the legend popover can render without
 * pulling — or depending on — the canvas module.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeshGraphEdge } from './types'

/**
 * Edge stroke. Every mesh edge is a neutral line (theme token, resolved as a
 * CSS var in SVG `style`); the dash pattern tells kinds apart. The only
 * coloured edge is the needs-follow-up (orphan) link, in the semantic
 * attention colour — per-kind hues made the map read as a rainbow.
 */
export function edgeColor(edge: MeshGraphEdge): string {
    return edge.type === 'orphanLink' ? 'var(--status-warning)' : 'var(--text-muted)'
}

/** Dash pattern per edge kind — shared by the canvas and the legend. */
export function edgeDash(type: MeshGraphEdge['type']): string | undefined {
    return LEGEND_EDGE_DASH[type]
}

/** Legend rows in display order — only the types present in the graph render. */
const LEGEND_EDGE_ORDER: MeshGraphEdge['type'][] = [
    'parentBranch',
    'cloneLink',
    'worktreeLink',
    'submoduleLink',
    'sessionLink',
    'orphanLink',
]

const LEGEND_EDGE_LABEL_KEY: Record<MeshGraphEdge['type'], string> = {
    parentBranch: 'mesh.legendEdge.parentBranch',
    cloneLink: 'mesh.legendEdge.cloneLink',
    worktreeLink: 'mesh.legendEdge.worktreeLink',
    submoduleLink: 'mesh.legendEdge.submoduleLink',
    sessionLink: 'mesh.legendEdge.sessionLink',
    orphanLink: 'mesh.legendEdge.orphanLink',
}

const LEGEND_EDGE_DASH: Partial<Record<MeshGraphEdge['type'], string>> = {
    // parentBranch: solid
    cloneLink: '6 3',
    worktreeLink: '2 3',
    submoduleLink: '8 3 2 3',
    sessionLink: '1 4',
    orphanLink: '5 4',
}

/**
 * Edge-type legend (only the types present in `edges`). Rendered by the host
 * inside its Legend popover — it used to float over the canvas and cover
 * nodes on small screens.
 */
export function MeshGraphEdgeLegend({ edges }: { edges: MeshGraphEdge[] }) {
    const { t } = useTranslation('common')
    const present = useMemo(() => {
        const types = new Set<MeshGraphEdge['type']>()
        for (const edge of edges) types.add(edge.type)
        return LEGEND_EDGE_ORDER.filter(type => types.has(type))
    }, [edges])
    if (present.length === 0) return null
    return (
        <div className="flex flex-col gap-1">
            {present.map(type => (
                <span key={type} className="flex items-center gap-2 text-2xs">
                    <svg width="18" height="4" aria-hidden>
                        <line
                            x1="0" y1="2" x2="18" y2="2"
                            style={{ stroke: edgeColor({ type } as MeshGraphEdge) }}
                            strokeWidth="1.5"
                            strokeDasharray={LEGEND_EDGE_DASH[type]}
                        />
                    </svg>
                    {t(LEGEND_EDGE_LABEL_KEY[type])}
                </span>
            ))}
        </div>
    )
}
