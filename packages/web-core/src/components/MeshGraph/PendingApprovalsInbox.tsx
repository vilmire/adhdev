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
import { IconSpinner } from '../Icons'
import { nodeDisplayName } from './MeshObservabilitySurface/meshSurfaceHelpers'

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
    /**
     * Epoch ms the session was last seen entering/holding the approval. Drives the
     * "waiting for N" age column. Absent when the source snapshot carries no timestamp
     * (the mesh node path) — the row then omits the age rather than inventing one.
     */
    waitingSince?: number | null
    /**
     * The provider's own button labels for this modal, when the modal detail has been
     * hydrated. Presentation-only here; resolution still goes through `onResolve`, which
     * owns the approve/reject mapping.
     */
    options?: string[]
}

/** Render a wait duration compactly (`45s`, `12m`, `3h 04m`). */
export function formatApprovalWait(waitingSince: number | null | undefined, nowMs: number): string | null {
    // Guard on null/undefined explicitly — `0` is a falsy but legitimate epoch value.
    if (waitingSince === null || waitingSince === undefined || !Number.isFinite(waitingSince)) return null
    const ms = nowMs - waitingSince
    if (!Number.isFinite(ms) || ms < 0) return null
    const totalSeconds = Math.floor(ms / 1000)
    if (totalSeconds < 60) return `${totalSeconds}s`
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
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
                machineLabel: nodeDisplayName(node) || node.nodeId,
                detail: session.statusNote ?? session.title ?? null,
            })
        }
    }
    return items
}

/**
 * The subset of ActiveConversation this derivation reads. Declared structurally rather than
 * importing the dashboard type so the mesh component keeps no dependency on dashboard internals.
 */
export interface ApprovalConversationSource {
    routeId?: string
    sessionId?: string
    daemonId?: string
    status?: string
    agentType?: string
    title?: string
    machineName?: string
    workspaceName?: string
    modalMessage?: string
    modalButtons?: string[]
    lastUpdated?: number
}

/**
 * Cross-machine derivation: pull every session awaiting an approval out of the dashboard's
 * flattened conversation list, which already spans EVERY connected daemon (buildConversations
 * folds all machines' sessions into one array). This is what makes the inbox account-wide
 * rather than mesh-scoped — `derivePendingApprovals` above only sees one selected mesh.
 *
 * Status is matched exactly against the normalized `waiting_approval` managed status rather
 * than by substring, so a session is listed iff the daemon classifies it as blocking. (The
 * mesh path substring-matches because its snapshot carries no normalized status.)
 *
 * `nodeId` is filled from daemonId so the resolve seam can route the command back to the
 * owning daemon; sessions without a routable id are skipped as unactionable.
 */
export function deriveApprovalsFromConversations(
    conversations: ApprovalConversationSource[] | undefined | null,
): PendingApprovalItem[] {
    if (!Array.isArray(conversations)) return []
    const items: PendingApprovalItem[] = []
    const seen = new Set<string>()
    for (const conv of conversations) {
        if (!conv) continue
        if (String(conv.status ?? '').trim().toLowerCase() !== 'waiting_approval') continue
        const sessionId = conv.sessionId || conv.routeId
        const nodeId = conv.daemonId || conv.routeId
        if (!sessionId || !nodeId) continue
        const key = `${nodeId}:${sessionId}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
            nodeId,
            sessionId,
            providerType: conv.agentType,
            machineLabel: conv.machineName || conv.workspaceName || nodeId,
            // modalMessage is only present once the session's modal detail has been
            // hydrated (the live status profile strips it); fall back to the title so a
            // not-yet-opened session still shows an identifiable row.
            detail: conv.modalMessage ?? conv.title ?? null,
            options: conv.modalButtons,
            waitingSince: conv.lastUpdated ?? null,
        })
    }
    // Longest-waiting first — mirrors mesh_list_pending_approvals' ordering so the coordinator
    // tool and this screen agree on which approval is most urgent.
    return items.sort((a, b) => (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity))
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
    /**
     * "Now" in epoch ms, for rendering wait ages. Injected so the render stays a pure
     * function of props (the test asserts a fixed age; the page ticks this on an interval).
     * Defaults to Date.now() at render time.
     */
    nowMs?: number
}

export default function PendingApprovalsInbox({ approvals, nodes, onResolve, hideWhenEmpty = true, nowMs }: Props) {
    const { t } = useTranslation()
    const resolvedNow = nowMs ?? Date.now()
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
                <div className="text-2xs opacity-70">{t('meshGraph.approvals.empty')}</div>
            ) : (
                <ul className="flex flex-col gap-2">
                    {items.map(item => {
                        const active = pending[item.sessionId] ?? null
                        const disabled = active !== null
                        const waitLabel = formatApprovalWait(item.waitingSince, resolvedNow)
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
                                        {waitLabel && (
                                            <span
                                                className="ml-2 font-bold text-3xs"
                                                style={{ color: 'var(--status-warning)' }}
                                                title={t('meshGraph.approvals.waitingFor', { duration: waitLabel })}
                                            >
                                                {waitLabel}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-3xs opacity-60 truncate">
                                        {item.detail
                                            ? item.detail.replace(/[\n\r]+/g, ' ').slice(0, 120)
                                            : t('meshGraph.approvals.sessionFallback', { id: item.sessionId })}
                                    </div>
                                    {item.options && item.options.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {item.options.slice(0, 4).map((option, i) => (
                                                <span
                                                    key={`${option}-${i}`}
                                                    className="text-4xs px-1.5 py-0.5 rounded opacity-70"
                                                    style={{ background: 'color-mix(in srgb, var(--text-muted) 15%, transparent)' }}
                                                >
                                                    {option.replace(/[⌥⏎⇧⌫⌘⌃]/g, '').trim().slice(0, 32)}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="flex gap-2 shrink-0">
                                    <button
                                        onClick={() => handle(item, 'approve')}
                                        disabled={disabled}
                                        className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 font-extrabold ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                                        style={{ color: 'var(--status-warning)', background: 'var(--surface-primary)' }}
                                    >
                                        {active === 'approve' ? <IconSpinner size={12} /> : t('meshGraph.approvals.approve')}
                                    </button>
                                    <button
                                        onClick={() => handle(item, 'reject')}
                                        disabled={disabled}
                                        className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 font-semibold text-white bg-red-500/30 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                                    >
                                        {active === 'reject' ? <IconSpinner size={12} /> : t('meshGraph.approvals.reject')}
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
