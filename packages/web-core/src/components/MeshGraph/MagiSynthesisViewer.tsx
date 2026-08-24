/**
 * MAGI Synthesis Viewer — read the persisted cross-verification synthesis.
 *
 * A MAGI fan-out (mesh_magi_review) dispatches the SAME question to N independent
 * (node × provider) replicas; mesh_magi_collect then synthesizes their answers and
 * persists a BOUNDED summary to the mesh ledger as a `magi_synthesis` entry. The
 * daemon folds that summary into `mesh_status` under `status.magiActivity[]` (one
 * `MeshMagiActivitySummary` per consensusGroupId, status 'running' | 'synthesized').
 * That folded summary — needs_verification counts + a bounded preview, the agreed
 * count, the independence banner, git skew, open questions — is the ONLY MAGI
 * synthesis data that survives without a live coordinator session, so it is the
 * viewer's primary source.
 *
 * RAW REPLICA ANSWERS ARE NOT PERSISTED. The per-replica raw end-user text
 * (`MagiResponseSource.rawAnswer`) is stripped from the persisted ledger entry to
 * bound payload growth; it is surfaced ONLY by `mesh_magi_collect verbose` against a
 * coordinator that still has the replica sessions/transcripts reachable. So raw is
 * recoverable ONLY when a live coordinator daemon is reachable AND the replicas have
 * not aged out. The "Load raw answers" action below is a best-effort live fetch; when
 * it returns no raw text (default-stripped, aged out, or no live session) the viewer
 * says so rather than implying the data was lost.
 *
 * Talks to the daemon through the SAME `sendDaemonCommand` seam the rest of the mesh
 * surface uses. Pure-render otherwise — the synthesis summary comes straight off the already
 * loaded `status`.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import type { MagiSynthesis, MagiResponseSource } from '@adhdev/mesh-shared'
import { useTheme } from '../../hooks/useTheme'
import Button from '../ui/Button'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import { nodeDisplayName } from './MeshObservabilitySurface/meshSurfaceHelpers'

/** One folded synthesis summary as carried in status.magiActivity[]. Mirrors
 *  daemon-core's MeshMagiActivitySummary without importing the value module. */
interface MagiActivitySummaryView {
    consensusGroupId: string
    status: 'running' | 'synthesized'
    missionId?: string
    panel?: string
    question?: string
    replicaCount?: number
    answered?: number
    missing?: number
    staleReplicas?: number
    needsVerificationCount?: number
    agreedCount?: number
    independenceBanner?: string | null
    gitSkew?: { skewed?: boolean; distinctBranches?: number; branches?: string[]; note?: string }
    needsVerification?: { claim: string; category: string }[]
    openQuestions?: string[]
    lastLedgerKind?: string
    lastUpdatedAt?: string
}

interface MagiSynthesisViewerProps {
    status: RepoMeshStatus
    daemonId?: string | null
    meshId: string
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}

function readActivity(status: RepoMeshStatus): MagiActivitySummaryView[] {
    const raw = (status as { magiActivity?: unknown }).magiActivity
    return Array.isArray(raw) ? (raw as MagiActivitySummaryView[]) : []
}

const unwrap = (raw: any): any => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

/** Pull the verbose synthesis (with rawAnswer per replica) out of a mesh_magi_collect response. */
function extractCollectSynthesis(raw: any): MagiSynthesis | null {
    const body = unwrap(raw)
    const synthesis = body?.synthesis ?? body?.result?.synthesis
    return synthesis && typeof synthesis === 'object' ? synthesis as MagiSynthesis : null
}

export default function MagiSynthesisViewer({ status, daemonId, meshId, sendDaemonCommand }: MagiSynthesisViewerProps) {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const meshTheme: MeshGraphTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const dk = meshTheme.isDark

    const groups = useMemo(() => readActivity(status), [status])
    const canCommand = !!daemonId && !!sendDaemonCommand

    // Resolve a replica's nodeId to its friendly machine label (nickname →
    // workspace·host·provider). Falls back to the raw id when the node isn't in the
    // current status snapshot, so a stale replica id still renders something.
    const nodeLabelById = useMemo(() => {
        const map = new Map<string, string>()
        for (const node of status.nodes ?? []) {
            if (node.nodeId) map.set(node.nodeId, nodeDisplayName(node))
        }
        return map
    }, [status.nodes])
    const resolveNodeLabel = useCallback((nodeId: string) => nodeLabelById.get(nodeId) || nodeId, [nodeLabelById])

    // Per-group live raw-answer fetch state, keyed by consensusGroupId.
    const [rawByGroup, setRawByGroup] = useState<Record<string, { loading: boolean; error: string | null; replicas: MagiResponseSource[] | null; fetched: boolean }>>({})

    const loadRaw = useCallback(async (consensusGroupId: string) => {
        if (!daemonId || !sendDaemonCommand) return
        setRawByGroup(prev => ({ ...prev, [consensusGroupId]: { loading: true, error: null, replicas: prev[consensusGroupId]?.replicas ?? null, fetched: prev[consensusGroupId]?.fetched ?? false } }))
        try {
            // verbose=true is what surfaces per-replica rawAnswer; it is stripped otherwise.
            const raw = await sendDaemonCommand(daemonId, 'mesh_magi_collect', { meshId, consensusGroupId, consensus_group_id: consensusGroupId, verbose: true })
            const synthesis = extractCollectSynthesis(raw)
            const replicas = Array.isArray(synthesis?.replicas) ? synthesis!.replicas : []
            setRawByGroup(prev => ({ ...prev, [consensusGroupId]: { loading: false, error: null, replicas, fetched: true } }))
        } catch (err) {
            setRawByGroup(prev => ({ ...prev, [consensusGroupId]: { loading: false, error: err instanceof Error ? err.message : t('meshGraph.synthesis.errorLoadRaw'), replicas: null, fetched: true } }))
        }
    }, [daemonId, sendDaemonCommand, meshId, t])

    if (groups.length === 0) {
        return (
            <div className={`rounded-xl border p-4 text-[12px] ${meshTheme.textSecondary} ${dk ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
                {t('meshGraph.synthesis.empty')}
            </div>
        )
    }

    const sepClass = `border-t ${dk ? 'border-white/8' : 'border-slate-200'}`

    return (
        <div className="flex flex-col gap-3">
            {groups.map(group => {
                const rawState = rawByGroup[group.consensusGroupId]
                const isSynthesized = group.status === 'synthesized'
                const branches = group.gitSkew?.branches ?? []
                const rawReplicas = (rawState?.replicas ?? []).filter(r => typeof r.rawAnswer === 'string' && r.rawAnswer)
                return (
                    <div key={group.consensusGroupId} className={`rounded-2xl border p-4 ${dk ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
                        {/* Header */}
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${meshTheme.textPrimary}`} title={group.question || group.consensusGroupId}>
                                {group.question || group.panel || group.consensusGroupId}
                            </span>
                            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-3xs font-semibold uppercase tracking-[0.14em] ${
                                isSynthesized
                                    ? (dk ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-emerald-300 bg-emerald-50 text-emerald-700')
                                    : (dk ? 'border-sky-400/25 bg-sky-500/10 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700')
                            }`}>
                                {isSynthesized ? t('meshGraph.synthesis.synthesized') : t('meshGraph.synthesis.running')}
                            </span>
                        </div>

                        {/* Counts */}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
                            {typeof group.answered === 'number' && (
                                <span className={meshTheme.textSecondary}>
                                    {t('meshGraph.synthesis.answered', { answered: group.answered, total: group.replicaCount ?? '?' })}
                                </span>
                            )}
                            {typeof group.needsVerificationCount === 'number' && group.needsVerificationCount > 0 && (
                                <span className={`rounded-md px-1.5 py-0.5 ${dk ? 'bg-amber-500/12 text-amber-200' : 'bg-amber-50 text-amber-700'}`}>
                                    {t('meshGraph.synthesis.needsVerificationCount', { count: group.needsVerificationCount })}
                                </span>
                            )}
                            {typeof group.agreedCount === 'number' && group.agreedCount > 0 && (
                                <span className={`rounded-md px-1.5 py-0.5 ${dk ? 'bg-emerald-500/10 text-emerald-200' : 'bg-emerald-50 text-emerald-700'}`}>
                                    {t('meshGraph.synthesis.agreedCount', { count: group.agreedCount })}
                                </span>
                            )}
                            {typeof group.staleReplicas === 'number' && group.staleReplicas > 0 && (
                                <span className={`rounded-md px-1.5 py-0.5 ${dk ? 'bg-rose-500/12 text-rose-200' : 'bg-rose-50 text-rose-700'}`}>
                                    {t('meshGraph.synthesis.staleCount', { count: group.staleReplicas })}
                                </span>
                            )}
                        </div>

                        {/* Independence banner */}
                        {group.independenceBanner && (
                            <div className={`mt-2 rounded-lg border px-2.5 py-1.5 text-2xs ${dk ? 'border-amber-500/25 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                                {group.independenceBanner}
                            </div>
                        )}

                        {/* Git skew */}
                        {group.gitSkew?.skewed && (
                            <div className={`mt-2 text-2xs ${meshTheme.textSecondary}`}>
                                <span className={dk ? 'text-amber-300' : 'text-amber-600'}>{t('meshGraph.synthesis.gitSkewLabel')}</span>
                                {group.gitSkew.note || t('meshGraph.synthesis.gitSkewNote', { count: branches.length, branches: branches.join(', ') })}
                            </div>
                        )}

                        {/* needs_verification preview (bounded) */}
                        {group.needsVerification && group.needsVerification.length > 0 && (
                            <div className={`mt-3 pt-3 ${sepClass}`}>
                                <span className={`text-2xs font-semibold uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>{t('meshGraph.synthesis.needsVerification')}</span>
                                <ul className="mt-1.5 flex flex-col gap-1">
                                    {group.needsVerification.map((item, i) => (
                                        <li key={i} className={`flex items-start gap-2 text-[12px] ${meshTheme.textPrimary}`}>
                                            <span className={`mt-0.5 shrink-0 rounded px-1 py-0.5 text-4xs uppercase ${dk ? 'bg-white/8 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{item.category}</span>
                                            <span className="min-w-0">{item.claim}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Open questions */}
                        {group.openQuestions && group.openQuestions.length > 0 && (
                            <div className={`mt-3 pt-3 ${sepClass}`}>
                                <span className={`text-2xs font-semibold uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>{t('meshGraph.synthesis.openQuestions')}</span>
                                <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4">
                                    {group.openQuestions.map((q, i) => (
                                        <li key={i} className={`text-[12px] ${meshTheme.textPrimary}`}>{q}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Raw answers — live-only, not persisted */}
                        <div className={`mt-3 pt-3 ${sepClass}`}>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-2xs font-semibold uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>{t('meshGraph.synthesis.rawReplicaAnswers')}</span>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => void loadRaw(group.consensusGroupId)}
                                    disabled={!canCommand || rawState?.loading}
                                    title={canCommand
                                        ? t('meshGraph.synthesis.rawTitleLive')
                                        : t('meshGraph.synthesis.rawTitleOffline')}
                                >
                                    {rawState?.loading ? t('meshGraph.synthesis.loading') : rawState?.fetched ? t('meshGraph.synthesis.reloadRaw') : t('meshGraph.synthesis.loadRaw')}
                                </Button>
                            </div>
                            <p className={`mt-1 text-2xs ${meshTheme.textMuted}`}>
                                {t('meshGraph.synthesis.rawNotice')}
                            </p>
                            {rawState?.error && (
                                <div className={`mt-2 text-2xs ${dk ? 'text-rose-300' : 'text-rose-600'}`}>{rawState.error}</div>
                            )}
                            {rawState?.fetched && !rawState.error && rawReplicas.length === 0 && (
                                <div className={`mt-2 text-2xs ${meshTheme.textMuted}`}>
                                    {t('meshGraph.synthesis.rawEmpty')}
                                </div>
                            )}
                            {rawReplicas.length > 0 && (
                                <div className="mt-2 flex flex-col gap-2">
                                    {rawReplicas.map((replica, i) => (
                                        <details key={replica.taskId || i} className={`rounded-lg border text-[12px] ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
                                            <summary className={`flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 [&::-webkit-details-marker]:hidden ${meshTheme.textSecondary}`}>
                                                <span className="flex-1 truncate" title={replica.nodeId || undefined}>{replica.provider || '?'}{replica.nodeId ? ` @ ${resolveNodeLabel(replica.nodeId)}` : ''}</span>
                                                {replica.rawAnswerTruncated && <span className={meshTheme.textMuted}>{t('meshGraph.synthesis.truncated')}</span>}
                                            </summary>
                                            <pre className={`max-h-64 overflow-auto whitespace-pre-wrap px-2.5 pb-2 font-mono text-2xs ${meshTheme.textPrimary}`}>{replica.rawAnswer}</pre>
                                        </details>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
