/**
 * MeshGraphPanel — Detail panel for a selected mesh graph node
 */

import type { MeshGraphNode } from './types'

interface MeshGraphPanelProps {
    node: MeshGraphNode | null
    onClose?: () => void
}

function Field({ label, value }: { label: string; value: string | number | null }) {
    if (value === null || value === undefined || value === '') return null
    return (
        <div className="flex justify-between gap-3 text-[11px] py-0.5 border-b border-border-subtle/50">
            <span className="text-text-muted">{label}</span>
            <span className="text-right break-all text-text-secondary font-medium">{String(value)}</span>
        </div>
    )
}

function HealthBadge({ health }: { health: string }) {
    const colors: Record<string, string> = {
        online: 'bg-green-500/10 text-green-400 border-green-500/20',
        dirty: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        degraded: 'bg-red-500/10 text-red-400 border-red-500/20',
        wrong_branch: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
        offline: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
        unknown: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
    }
    return (
        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${colors[health] || colors.unknown}`}>
            {health}
        </span>
    )
}

export default function MeshGraphPanel({ node, onClose }: MeshGraphPanelProps) {
    if (!node) {
        return (
            <div className="w-full max-w-full rounded-xl border border-border-subtle bg-bg-panel p-4 text-text-muted text-xs md:w-64">
                Select a node to view details.
            </div>
        )
    }

    const isSubmoduleNode = node.type === 'submoduleNode'

    return (
        <div className="w-full max-w-full rounded-xl border border-border-subtle bg-bg-panel p-4 flex flex-col gap-2 shadow-lg md:w-64">
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-text-primary truncate">{node.label}</span>
                {onClose && (
                    <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xs">✕</button>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <HealthBadge health={node.health} />
                {isSubmoduleNode && <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-500/10 text-violet-300 border border-violet-500/20">Submodule</span>}
                {node.dirty && <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">Dirty</span>}
                {node.outOfSync && <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20">Out of sync</span>}
                {node.hasConflicts && <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20">Conflict</span>}
                {node.isOrphan && <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20">Orphan</span>}
            </div>

            <div className="flex flex-col gap-0.5 mt-1">
                <Field label="Workspace" value={node.workspace} />
                <Field label="Branch" value={node.branch} />
                <Field label="Submodule path" value={node.submodulePath ?? null} />
                <Field label="Submodule commit" value={node.submoduleCommit ?? null} />
                <Field label="Parent node" value={isSubmoduleNode ? (node.machineLabel || node.parentNodeId || null) : null} />
                <Field label="Ahead" value={!isSubmoduleNode && node.ahead > 0 ? `+${node.ahead}` : null} />
                <Field label="Behind" value={!isSubmoduleNode && node.behind > 0 ? `-${node.behind}` : null} />
                <Field label="Dirty files" value={node.dirtyFiles > 0 ? node.dirtyFiles : null} />
                <Field label="Active sessions" value={node.activeSessionCount > 0 ? node.activeSessionCount : null} />
                <Field label="Providers" value={!isSubmoduleNode ? (node.providers.join(', ') || null) : null} />
                <Field label="Error" value={node.error ?? null} />
            </div>

            {node.orphanReasons.length > 0 && (
                <div className="mt-1">
                    <div className="text-[10px] font-semibold text-red-400 mb-1">Orphan reasons</div>
                    <ul className="list-disc list-inside text-[10px] text-red-300 space-y-0.5">
                        {node.orphanReasons.map((r, i) => (
                            <li key={i}>{r}</li>
                        ))}
                    </ul>
                </div>
            )}

            {node.nextStepHint && (
                <div className="mt-1 px-2 py-1.5 rounded bg-blue-500/10 border border-blue-500/20 text-[10px] text-blue-300">
                    💡 {node.nextStepHint}
                </div>
            )}
        </div>
    )
}
