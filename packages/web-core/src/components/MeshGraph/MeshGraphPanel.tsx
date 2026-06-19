/**
 * MeshGraphPanel — Detail panel for a selected mesh graph node
 */

import { useMemo } from 'react'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme } from './meshGraphTheme'
import { formatMeshConnectionSummary } from '../../utils/mesh-visualization'
import type { MeshGraphNode } from './types'

interface MeshGraphPanelProps {
    node: MeshGraphNode | null
    onClose?: () => void
}

function Field({
    label,
    value,
    rowClass,
    labelClass,
    valueClass,
}: {
    label: string
    value: string | number | null
    rowClass: string
    labelClass: string
    valueClass: string
}) {
    if (value === null || value === undefined || value === '') return null
    return (
        <div className={rowClass}>
            <span className={labelClass}>{label}</span>
            <span className={valueClass}>{String(value)}</span>
        </div>
    )
}

function HealthBadge({ health, isDark }: { health: string; isDark: boolean }) {
    const darkColors: Record<string, string> = {
        online: 'bg-green-500/10 text-green-400 border-green-500/20',
        dirty: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        degraded: 'bg-red-500/10 text-red-400 border-red-500/20',
        wrong_branch: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
        offline: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
        unknown: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
    }
    const lightColors: Record<string, string> = {
        online: 'bg-green-50 text-green-700 border-green-300',
        dirty: 'bg-amber-50 text-amber-700 border-amber-300',
        degraded: 'bg-rose-50 text-rose-700 border-rose-300',
        wrong_branch: 'bg-violet-50 text-violet-700 border-violet-300',
        offline: 'bg-slate-100 text-slate-600 border-slate-300',
        unknown: 'bg-slate-100 text-slate-600 border-slate-300',
    }
    const colors = isDark ? darkColors : lightColors
    return (
        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${colors[health] || colors.unknown}`}>
            {health}
        </span>
    )
}

function summarizeHead(node: MeshGraphNode): string | null {
    if (node.type === 'submoduleNode') {
        return node.submoduleCommit ? node.submoduleCommit.slice(0, 7) : null
    }
    const source = node.source
    if ('kind' in source) return null
    const headCommit = source.git?.headCommit ? source.git.headCommit.slice(0, 7) : null
    const headMessage = source.git?.headMessage?.trim() || null
    if (!headCommit && !headMessage) return null
    return [headCommit, headMessage].filter(Boolean).join(' · ')
}

function formatUpstreamState(node: MeshGraphNode): string | null {
    if (!node.upstream) return null
    switch (node.upstreamStatus) {
        case 'fresh':
            return 'verified'
        case 'stale':
            return 'unverified (fetch failed)'
        case 'unchecked':
            return 'unverified'
        case 'unavailable':
            return 'unavailable'
        case 'no_upstream':
        default:
            return null
    }
}

function sessionStatusLabel(session: MeshGraphNode['sessionDetails'][number]): string {
    const raw = (session.chatStatus || session.state || session.lifecycle || '').trim()
    if (!raw) return 'unknown'
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized.includes('approval')) return 'awaiting approval'
    if (normalized.includes('generating') || normalized.includes('running') || normalized.includes('busy')) return 'generating'
    if (normalized.includes('idle') || normalized.includes('ready') || normalized.includes('waiting_input')) return 'idle'
    return normalized.replace(/_/g, ' ')
}

function sessionRoleLabel(session: MeshGraphNode['sessionDetails'][number]): string {
    if (session.isSelfCoordinator) return 'coordinator'
    const role = typeof session.role === 'string' ? session.role.trim() : ''
    return role || 'worker'
}

function sessionElapsedLabel(session: MeshGraphNode['sessionDetails'][number]): string {
    const startedAt = session.startedAt || session.createdAt || null
    if (!startedAt) return 'runtime age not reported'
    const parsed = Date.parse(startedAt)
    if (!Number.isFinite(parsed)) return 'runtime age not reported'
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000))
    if (elapsedSeconds < 60) return `${elapsedSeconds}s`
    const minutes = Math.floor(elapsedSeconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h ${minutes % 60}m`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
}

function shortSessionId(sessionId: string): string {
    if (sessionId.length <= 18) return sessionId
    return `${sessionId.slice(0, 10)}...${sessionId.slice(-4)}`
}

export default function MeshGraphPanel({ node, onClose }: MeshGraphPanelProps) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    if (!node) {
        return (
            <div className={`${meshTheme.panelEmptyClass} md:w-64`}>
                Select a node to view details.
            </div>
        )
    }

    const isSubmoduleNode = node.type === 'submoduleNode'
    const headSummary = summarizeHead(node)
    // Transport (direct/relay) + RTT is no longer drawn inline on the graph canvas —
    // surface it here in the detail panel instead. Submodule nodes inherit the parent
    // node's connection, so we skip it for them to avoid duplication.
    const connectionSummary = !isSubmoduleNode ? formatMeshConnectionSummary(node) : null

    return (
        <div className={`${meshTheme.panelShellClass} md:w-64`}>
            <div className="flex items-center justify-between">
                <span className={`${meshTheme.panelTitleClass}`}>{node.label}</span>
                {onClose && (
                    <button onClick={onClose} className={meshTheme.panelCloseButtonClass}>✕</button>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <HealthBadge health={node.health} isDark={meshTheme.isDark} />
                {isSubmoduleNode && <span className={meshTheme.isDark ? 'rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-200' : 'rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700'}>Submodule</span>}
                {node.dirty && <span className={meshTheme.isDark ? 'px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/10 text-yellow-400 border border-yellow-500/20' : 'px-1.5 py-0.5 rounded text-[10px] bg-amber-50 text-amber-700 border border-amber-300'}>Dirty</span>}
                {node.outOfSync && <span className={meshTheme.isDark ? 'px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20' : 'px-1.5 py-0.5 rounded text-[10px] bg-rose-50 text-rose-700 border border-rose-300'}>Out of sync</span>}
                {node.hasConflicts && <span className={meshTheme.isDark ? 'px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20' : 'px-1.5 py-0.5 rounded text-[10px] bg-rose-50 text-rose-700 border border-rose-300'}>Conflict</span>}
                {node.isOrphan && <span className={meshTheme.isDark ? 'px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20' : 'px-1.5 py-0.5 rounded text-[10px] bg-rose-50 text-rose-700 border border-rose-300'}>Orphan</span>}
            </div>

            <div className="flex flex-col gap-0.5 mt-1">
                <Field label="Workspace" value={node.workspace} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Branch" value={node.branch} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Upstream" value={!isSubmoduleNode ? (node.upstream ?? null) : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Upstream state" value={!isSubmoduleNode ? formatUpstreamState(node) : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="HEAD" value={headSummary} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Submodule path" value={node.submodulePath ?? null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Submodule commit" value={node.submoduleCommit ?? null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Parent node" value={isSubmoduleNode ? (node.machineLabel || node.parentNodeId || null) : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Ahead" value={!isSubmoduleNode && (!node.upstream || node.upstreamStatus === 'fresh') && node.ahead > 0 ? `+${node.ahead}` : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Behind" value={!isSubmoduleNode && (!node.upstream || node.upstreamStatus === 'fresh') && node.behind > 0 ? `-${node.behind}` : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Dirty files" value={node.dirtyFiles > 0 ? node.dirtyFiles : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Active sessions" value={node.activeSessionCount > 0 ? node.activeSessionCount : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Providers" value={!isSubmoduleNode ? (node.providers.join(', ') || null) : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Connection" value={connectionSummary} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Link note" value={connectionSummary ? (node.connectionReason ?? null) : null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
                <Field label="Error" value={node.error ?? null} rowClass={meshTheme.panelFieldRowClass} labelClass={meshTheme.panelFieldLabelClass} valueClass={meshTheme.panelFieldValueClass} />
            </div>

            {node.orphanReasons.length > 0 && (
                <div className="mt-1">
                    <div className={meshTheme.isDark ? 'mb-1 text-[10px] font-semibold text-red-400' : 'mb-1 text-[10px] font-semibold text-rose-700'}>Orphan reasons</div>
                    <ul className={meshTheme.isDark ? 'list-disc list-inside text-[10px] text-red-300 space-y-0.5' : 'list-disc list-inside text-[10px] text-rose-700 space-y-0.5'}>
                        {node.orphanReasons.map((r, i) => (
                            <li key={i}>{r}</li>
                        ))}
                    </ul>
                </div>
            )}

            {node.sessionDetails.length > 0 && (
                <div className="mt-2">
                    <div className={meshTheme.isDark ? 'mb-1 text-[10px] font-semibold text-slate-300' : 'mb-1 text-[10px] font-semibold text-slate-700'}>Attached chats</div>
                    <div className="flex flex-col gap-1.5">
                        {node.sessionDetails.map(session => (
                            <div
                                key={session.sessionId}
                                className={meshTheme.isDark ? 'rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5 text-[10px] text-slate-300' : 'rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] text-slate-600'}
                                title={[
                                    `Session ID: ${session.sessionId}`,
                                    session.providerType ? `Provider: ${session.providerType}` : null,
                                    `Status: ${sessionStatusLabel(session)}`,
                                    `Role: ${sessionRoleLabel(session)}`,
                                    session.startedAt || session.createdAt ? `Started: ${session.startedAt || session.createdAt}` : 'Started: not reported',
                                    session.statusNote ? `Note: ${session.statusNote}` : null,
                                ].filter(Boolean).join('\n')}
                            >
                                <div className="flex min-w-0 items-center justify-between gap-2">
                                    <span className="min-w-0 truncate font-mono select-text">{shortSessionId(session.sessionId)}</span>
                                    <span>{sessionStatusLabel(session)}</span>
                                </div>
                                <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
                                    <span className="truncate">{session.providerType || 'provider unknown'}</span>
                                    <span>{sessionRoleLabel(session)}</span>
                                    <span>{sessionElapsedLabel(session)}</span>
                                </div>
                                {session.statusNote && (
                                    <div className="mt-1 leading-4">
                                        {session.statusNote}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {node.nextStepHint && (
                <div className={`${meshTheme.infoCalloutClass}`}>
                    💡 {node.nextStepHint}
                </div>
            )}
        </div>
    )
}
