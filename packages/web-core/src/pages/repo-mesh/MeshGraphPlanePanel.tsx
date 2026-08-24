/**
 * MeshGraphPlanePanel — the graph control plane, finally visible to a human
 * (G5 MVP). The persistent orchestration graphs (worker nodes + coordinator
 * gates + next-required-action) previously surfaced ONLY through the
 * coordinator's mesh_graph_view MCP tool; owner-action gates (approval /
 * publish) sat invisible for days. This panel lists the mesh's graphs and
 * makes gates operable: claim → (verify, optionally guided by convergence
 * evidence) → release with an outcome, or abandon a gate whose work is dead.
 *
 * Data flow: `mesh_graph_overview` / `mesh_gate_*` daemon commands (same
 * engine the MCP tools call) over the established transport; responses are
 * unwrapped with the canonical envelope helper so both transport shapes work.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { unwrapDaemonCommandBody } from '../../utils/daemon-command-envelope'
import ConfirmDialog from '../../components/ConfirmDialog'
import { IconRefresh } from '../../components/Icons'

interface GraphGateView {
    gateId: string
    ref?: string
    state: string
    action: string
    instructions?: string
    deadlineAt?: string
    leaseOwnerSessionId?: string
    convergenceEvidence?: {
        allReachedMain: boolean | null
        hint?: string
        commits?: Array<{ sha: string; reachedMain: boolean | 'unknown' }>
    }
}

interface GraphNodeView {
    nodeId: string
    ref?: string
    kind: string
    state: string
}

interface GraphView {
    graphId: string
    status: string
    createdAt?: string
    updatedAt?: string
    taskCount?: number
    gateCount?: number
    nodes?: GraphNodeView[]
    gates?: GraphGateView[]
}

interface ClaimedLease {
    gateId: string
    leaseGeneration: number
    fencingToken: string
    instructions?: string
    evidenceHint?: string
}

const STALE_MS = 24 * 60 * 60 * 1000

function statusChipClass(status: string): string {
    switch (status) {
        case 'completed': return 'text-green-500 bg-green-500/10'
        case 'failed': case 'compensation_required': return 'text-red-400 bg-red-500/10'
        case 'cancelled': return 'text-text-muted bg-bg-glass'
        case 'waiting_gate': return 'text-amber-500 bg-amber-500/10'
        default: return 'text-accent-primary bg-accent-primary/10'
    }
}

function ageLabel(iso: string | undefined, nowMs: number): string {
    if (!iso) return '—'
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return '—'
    const mins = Math.max(0, Math.floor((nowMs - t) / 60_000))
    if (mins < 60) return `${mins}m`
    const hours = Math.floor(mins / 60)
    return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export default function MeshGraphPlanePanel({ meshId, daemonId, sendCommand }: {
    meshId: string
    daemonId: string
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}) {
    const { t } = useTranslation('common')
    const [graphs, setGraphs] = useState<GraphView[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [includeTerminal, setIncludeTerminal] = useState(false)
    const [expandedGraphId, setExpandedGraphId] = useState<string | null>(null)
    const [busyGateId, setBusyGateId] = useState<string | null>(null)
    const [lease, setLease] = useState<ClaimedLease | null>(null)
    const [releaseOutcome, setReleaseOutcome] = useState<'passed' | 'failed' | 'rejected'>('passed')
    const [releaseEvidence, setReleaseEvidence] = useState('')
    const [abandonTarget, setAbandonTarget] = useState<GraphGateView | null>(null)
    const [notice, setNotice] = useState('')
    const nowMs = useMemo(() => Date.now(), [graphs])

    const refresh = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
            const raw = await sendCommand(daemonId, 'mesh_graph_overview', { meshId, includeTerminal })
            const body = unwrapDaemonCommandBody<{ success?: boolean; error?: string; graphs?: GraphView[] }>(raw)
            if (!body || body.success === false) throw new Error(body?.error || 'graph overview failed')
            setGraphs(Array.isArray(body.graphs) ? body.graphs : [])
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setLoading(false)
        }
    }, [daemonId, includeTerminal, meshId, sendCommand])

    useEffect(() => { void refresh() }, [refresh])

    const runGateCommand = useCallback(async (command: string, payload: Record<string, unknown>) => {
        const raw = await sendCommand(daemonId, command, { meshId, ...payload })
        const body = unwrapDaemonCommandBody<Record<string, any>>(raw)
        if (!body || body.success === false) throw new Error(body?.error || `${command} failed`)
        return body
    }, [daemonId, meshId, sendCommand])

    const handleClaim = useCallback(async (gate: GraphGateView) => {
        setBusyGateId(gate.gateId)
        setNotice('')
        setError('')
        try {
            const body = await runGateCommand('mesh_gate_claim', { gateId: gate.gateId })
            setLease({
                gateId: gate.gateId,
                leaseGeneration: Number(body.leaseGeneration),
                fencingToken: String(body.fencingToken),
                instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
                evidenceHint: body.convergenceEvidence?.hint,
            })
            setReleaseOutcome('passed')
            setReleaseEvidence('')
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setBusyGateId(null)
            void refresh()
        }
    }, [refresh, runGateCommand])

    const handleRelease = useCallback(async () => {
        if (!lease) return
        setBusyGateId(lease.gateId)
        setNotice('')
        setError('')
        try {
            await runGateCommand('mesh_gate_release', {
                gateId: lease.gateId,
                leaseGeneration: lease.leaseGeneration,
                fencingToken: lease.fencingToken,
                outcome: releaseOutcome,
                ...(releaseEvidence.trim() ? { evidence: releaseEvidence.trim() } : {}),
            })
            setNotice(t('repoMesh.graphs.released'))
            setLease(null)
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setBusyGateId(null)
            void refresh()
        }
    }, [lease, refresh, releaseEvidence, releaseOutcome, runGateCommand, t])

    const handleAbandon = useCallback(async (gate: GraphGateView) => {
        setBusyGateId(gate.gateId)
        setNotice('')
        setError('')
        try {
            await runGateCommand('mesh_gate_abandon', { gateId: gate.gateId })
            setNotice(t('repoMesh.graphs.abandoned'))
            if (lease?.gateId === gate.gateId) setLease(null)
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setBusyGateId(null)
            void refresh()
        }
    }, [lease, refresh, runGateCommand, t])

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <div className="text-2xs text-text-muted">{t('repoMesh.graphs.subtitle')}</div>
                <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-2xs text-text-muted cursor-pointer">
                        <input type="checkbox" checked={includeTerminal} onChange={e => setIncludeTerminal(e.target.checked)} />
                        {t('repoMesh.graphs.includeTerminal')}
                    </label>
                    <button
                        type="button"
                        className="btn btn-sm btn-secondary flex items-center gap-1.5"
                        disabled={loading}
                        onClick={() => void refresh()}
                    ><IconRefresh size={13} /> {t('repoMesh.graphs.refresh')}</button>
                </div>
            </div>

            {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
            {notice && <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-500">{notice}</div>}
            {loading && graphs.length === 0 && <div className="text-xs text-text-muted py-4">{t('repoMesh.graphs.loading')}</div>}
            {!loading && graphs.length === 0 && !error && (
                <div className="text-xs text-text-muted py-4">{t('repoMesh.graphs.empty')}</div>
            )}

            {graphs.map(graph => {
                const updatedMs = graph.updatedAt ? Date.parse(graph.updatedAt) : NaN
                const isStale = Number.isFinite(updatedMs) && nowMs - updatedMs > STALE_MS
                    && (graph.status === 'active' || graph.status === 'waiting_gate')
                const expanded = expandedGraphId === graph.graphId
                const gates = graph.gates ?? []
                return (
                    <div key={graph.graphId} className={`rounded-xl border px-4 py-3 bg-bg-primary ${isStale ? 'border-amber-500/40' : 'border-border-subtle'}`}>
                        <button
                            type="button"
                            className="w-full flex items-center gap-2 text-left"
                            onClick={() => setExpandedGraphId(expanded ? null : graph.graphId)}
                        >
                            <span className={`transition-transform text-text-muted ${expanded ? 'rotate-90' : ''}`} aria-hidden>▸</span>
                            <span className="font-mono text-2xs text-text-secondary">{graph.graphId.slice(0, 8)}</span>
                            <span className={`chip text-3xs font-semibold rounded px-1.5 py-0.5 ${statusChipClass(graph.status)}`}>{graph.status}</span>
                            {isStale && <span className="text-3xs text-amber-500">{t('repoMesh.graphs.stale', { age: ageLabel(graph.updatedAt, nowMs) })}</span>}
                            <span className="ml-auto text-3xs text-text-muted">
                                {t('repoMesh.graphs.counts', { tasks: graph.taskCount ?? (graph.nodes?.filter(n => n.kind === 'worker_task').length ?? 0), gates: graph.gateCount ?? gates.length })}
                                {' · '}{ageLabel(graph.updatedAt, nowMs)}
                            </span>
                        </button>

                        {expanded && (
                            <div className="mt-3 flex flex-col gap-2">
                                {(graph.nodes ?? []).map(node => (
                                    <div key={node.nodeId} className="flex items-center gap-2 text-2xs px-2 py-1 rounded bg-bg-glass">
                                        <span className="text-text-muted font-mono">{node.kind === 'coordinator_gate' ? '⛩' : '•'}</span>
                                        <span className="text-text-primary">{node.ref || node.nodeId.slice(0, 8)}</span>
                                        <span className="text-text-muted">{node.state}</span>
                                    </div>
                                ))}

                                {gates.map(gate => {
                                    const actionable = gate.state === 'awaiting_coordinator' || gate.state === 'expired' || gate.state === 'claimed'
                                    const isLeased = lease?.gateId === gate.gateId
                                    return (
                                        <div key={gate.gateId} className="rounded-lg border border-border-subtle bg-bg-secondary/50 px-3 py-2 flex flex-col gap-2">
                                            <div className="flex items-center gap-2 text-2xs">
                                                <span className="font-semibold text-text-primary">⛩ {gate.ref || gate.gateId.slice(0, 8)}</span>
                                                <span className="text-text-muted">({gate.action}, {gate.state})</span>
                                                {actionable && !isLeased && (
                                                    <span className="ml-auto flex gap-1.5">
                                                        <button type="button" className="btn btn-sm btn-secondary" disabled={busyGateId === gate.gateId}
                                                            onClick={() => void handleClaim(gate)}>{t('repoMesh.graphs.claim')}</button>
                                                        <button type="button" className="btn btn-sm btn-danger" disabled={busyGateId === gate.gateId}
                                                            onClick={() => setAbandonTarget(gate)}>{t('repoMesh.graphs.abandon')}</button>
                                                    </span>
                                                )}
                                            </div>
                                            {gate.instructions && <div className="text-3xs text-text-muted whitespace-pre-line">{gate.instructions}</div>}
                                            {gate.convergenceEvidence?.hint && (
                                                <div className="text-3xs text-green-500">{gate.convergenceEvidence.hint}</div>
                                            )}
                                            {isLeased && (
                                                <div className="flex flex-col gap-2 rounded-md border border-accent-primary/30 bg-accent-primary/5 px-3 py-2">
                                                    {lease?.evidenceHint && <div className="text-3xs text-green-500">{lease.evidenceHint}</div>}
                                                    <div className="flex items-center gap-2 text-2xs">
                                                        <span className="text-text-muted">{t('repoMesh.graphs.outcome')}</span>
                                                        <select
                                                            className="bg-bg-primary border border-border-subtle rounded px-2 py-1 text-2xs"
                                                            value={releaseOutcome}
                                                            onChange={e => setReleaseOutcome(e.target.value as 'passed' | 'failed' | 'rejected')}
                                                        >
                                                            <option value="passed">passed</option>
                                                            <option value="failed">failed</option>
                                                            <option value="rejected">rejected</option>
                                                        </select>
                                                        <input
                                                            type="text"
                                                            className="flex-1 min-w-0 bg-bg-primary border border-border-subtle rounded px-2 py-1 text-2xs"
                                                            placeholder={t('repoMesh.graphs.evidencePlaceholder')}
                                                            value={releaseEvidence}
                                                            onChange={e => setReleaseEvidence(e.target.value)}
                                                        />
                                                        <button type="button" className="btn btn-sm btn-primary" disabled={busyGateId === gate.gateId}
                                                            onClick={() => void handleRelease()}>{t('repoMesh.graphs.release')}</button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                )
            })}

            {abandonTarget && (
                <ConfirmDialog
                    title={t('repoMesh.graphs.abandonConfirmTitle')}
                    description={t('repoMesh.graphs.abandonConfirmDescription', { gate: abandonTarget.ref || abandonTarget.gateId.slice(0, 8) })}
                    confirmLabel={t('repoMesh.graphs.abandon')}
                    tone="danger"
                    onCancel={() => setAbandonTarget(null)}
                    onConfirm={() => {
                        const gate = abandonTarget
                        setAbandonTarget(null)
                        if (gate) void handleAbandon(gate)
                    }}
                />
            )}
        </div>
    )
}
