/**
 * PendingApprovalsInbox — mesh-wide approval inbox.
 *
 * The per-session ApprovalBanner (components/dashboard/ApprovalBanner) only surfaces the
 * approval for the ONE conversation a user is looking at. This component aggregates EVERY
 * session across the mesh that is awaiting an approval decision into a single list, so an
 * operator can see and clear the whole pending set from the mesh dashboard — the UI peer of
 * the mesh_list_pending_approvals coordinator tool.
 *
 * Data source: the dashboard's existing RepoMeshStatus node/session snapshot. `derivePendingApprovals`
 * filters each node's activeSessionDetails to the sessions whose reported state indicates an
 * approval is blocking (mirrors the daemon-side `awaiting_approval` classification). No new fetch
 * path — the parent already holds the status. Each row routes its Approve/Reject through the
 * injected `onResolve(nodeId, sessionId, action)` seam (typically a mesh resolve_action / mesh_approve
 * call), so this file imports no daemon-core VALUE — only presentation + a props-injected callback.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshNodeStatus, RepoMeshSessionStatus } from '@adhdev/daemon-core'
import { IconWarning } from '../Icons'

export type PendingApprovalAction = 'approve' | 'reject'

/** One session awaiting an approval decision — the self-contained shape this inbox renders. */
export interface PendingApprovalItem {
    nodeId: string
    sessionId: string
    providerType?: string
    /** Human-readable node/machine label for display (falls back to nodeId). */
    machineLabel?: string
    /** Optional short summary of what needs approval (modal message / title), when available. */
    detail?: string | null
}

/** Fields that carry a session's live status text — union of the mesh session-status shape. */
function sessionStatusText(session: RepoMeshSessionStatus): string {
    return `${session.state ?? ''} ${session.chatStatus ?? ''} ${session.lifecycle ?? ''}`.toLowerCase()
}

/**
 * Pure derivation: pull every session awaiting an approval decision out of the mesh node
 * snapshot. Mirrors the daemon-side signal (a session whose status text contains "approval")
 * so the inbox and the coordinator's mesh_list_pending_approvals agree on what is pending.
 * Skips sessions without a resolvable sessionId — an approval that cannot be routed to a
 * concrete node+session is not actionable inbox content.
 */
export function derivePendingApprovals(nodes: RepoMeshNodeStatus[] | undefined | null): PendingApprovalItem[] {
    if (!Array.isArray(nodes)) return []
    const items: PendingApprovalItem[] = []
    for (const node of nodes) {
        const sessions = node.activeSessionDetails
        if (!Array.isArray(sessions)) continue
        for (const session of sessions) {
            if (!session?.sessionId) continue
            if (!sessionStatusText(session).includes('approval')) continue
            items.push({
                nodeId: node.nodeId,
                sessionId: session.sessionId,
                providerType: session.providerType,
                machineLabel: node.machineLabel || node.nodeId,
                detail: session.statusNote ?? session.title ?? null,
            })
        }
    }
    return items
}

interface Props {
    /**
     * Pending approvals to render. Pass a pre-derived list, or omit and pass `nodes` to have
     * the component derive it via derivePendingApprovals.
     */
    approvals?: PendingApprovalItem[]
    /** Alternative to `approvals`: the raw mesh node snapshot; the component derives the list. */
    nodes?: RepoMeshNodeStatus[] | null
    /** Resolve a single pending approval. Returns a promise so the row can show a pending state. */
    onResolve: (nodeId: string, sessionId: string, action: PendingApprovalAction) => void | Promise<unknown>
    /** Hide the whole component when there is nothing pending (default true). */
    hideWhenEmpty?: boolean
}

export default function PendingApprovalsInbox({ approvals, nodes, onResolve, hideWhenEmpty = true }: Props) {
    const { t } = useTranslation()
    const items = useMemo(
        () => approvals ?? derivePendingApprovals(nodes),
        [approvals, nodes],
    )
    // Track which (sessionId) is mid-resolve so its buttons disable — mirrors ApprovalBanner.
    const [pending, setPending] = useState<Record<string, PendingApprovalAction>>({})

    if (hideWhenEmpty && items.length === 0) return null

    const handle = (item: PendingApprovalItem, action: PendingApprovalAction) => {
        if (pending[item.sessionId]) return
        setPending(prev => ({ ...prev, [item.sessionId]: action }))
        void Promise.resolve(onResolve(item.nodeId, item.sessionId, action)).finally(() => {
            setPending(prev => {
                const next = { ...prev }
                delete next[item.sessionId]
                return next
            })
        })
    }

    return (
        <div
            className="rounded-lg border p-3"
            style={{
                borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)',
                background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)',
            }}
        >
            <div className="flex items-center gap-2 mb-2 font-black text-xs" style={{ color: 'var(--status-warning)' }}>
                <IconWarning size={14} />
                {t('meshGraph.approvals.title')}
                <span className="opacity-70 font-semibold">({items.length})</span>
            </div>

            {items.length === 0 ? (
                <div className="text-[11px] opacity-70">{t('meshGraph.approvals.empty')}</div>
            ) : (
                <ul className="flex flex-col gap-2">
                    {items.map(item => {
                        const active = pending[item.sessionId] ?? null
                        const disabled = active !== null
                        return (
                            <li
                                key={`${item.nodeId}:${item.sessionId}`}
                                className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2"
                                style={{ background: 'color-mix(in srgb, var(--surface-primary) 82%, transparent)' }}
                            >
                                <div className="min-w-0">
                                    <div className="text-xs font-semibold truncate">
                                        {item.machineLabel || item.nodeId}
                                        {item.providerType && (
                                            <span className="ml-2 opacity-60 font-normal">{item.providerType}</span>
                                        )}
                                    </div>
                                    <div className="text-[10px] opacity-60 truncate">
                                        {item.detail
                                            ? item.detail.replace(/[\n\r]+/g, ' ').slice(0, 120)
                                            : t('meshGraph.approvals.sessionFallback', { id: item.sessionId })}
                                    </div>
                                </div>
                                <div className="flex gap-2 shrink-0">
                                    <button
                                        onClick={() => handle(item, 'approve')}
                                        disabled={disabled}
                                        className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 font-extrabold ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                                        style={{ color: 'var(--status-warning)', background: 'var(--surface-primary)' }}
                                    >
                                        {active === 'approve' ? '⏳ ...' : t('meshGraph.approvals.approve')}
                                    </button>
                                    <button
                                        onClick={() => handle(item, 'reject')}
                                        disabled={disabled}
                                        className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 font-semibold text-white bg-red-500/30 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                                    >
                                        {active === 'reject' ? '⏳ ...' : t('meshGraph.approvals.reject')}
                                    </button>
                                </div>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
