import type { ProviderApproval, ProviderApprovalTarget } from '@adhdev/mesh-shared'
/** Provider decisions are a separate Inbox lane. Only confirmed live tool
 * modals with an exact target offer actions; setup and incomplete evidence
 * remain attention rows. Ordinary conversations retain their visibility policy. */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshNodeStatus, RepoMeshSessionStatus } from '@adhdev/daemon-core'
import { IconWarning } from '../Icons'
import { IconSpinner } from '../Icons'
import { nodeDisplayName } from './MeshObservabilitySurface/meshSurfaceHelpers'

export type PendingApprovalAction = 'approve' | 'reject'

/** One session awaiting an approval decision — the self-contained shape this inbox renders. */
export interface PendingApprovalItem {
    actionable?: boolean
    approvalTarget?: ProviderApprovalTarget
    approvalType?: ProviderApproval['type']
    evidence?: ProviderApproval['evidence']
    runtimeDirectory?: string
    displayedDirectory?: string | null
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

export function derivePendingApprovals(nodes: RepoMeshNodeStatus[] | undefined | null): PendingApprovalItem[] {
    if (!Array.isArray(nodes)) return []
    const items: PendingApprovalItem[] = []
    for (const node of nodes) {
        const sessions = node.activeSessionDetails
        if (!Array.isArray(sessions)) continue
        for (const session of sessions) {
            if (!session?.sessionId) continue
            if (!sessionStatusText(session).includes('approval')) continue
            const approval = session.providerApproval
            if (!approval || approval.source !== 'provider_modal' || approval.lifecycle !== 'pending') continue
            const actionable = Array.isArray(approval.buttons) && approval.buttons.some(button => typeof button === 'string' && button.trim()) && approval.type === 'tool_permission' && approval.evidence === 'live' && approval.actionable && !!approval.modalKey && !session.isCached && node.health === 'online'
            items.push({
                actionable, approvalType: approval.type, evidence: session.isCached ? 'cached' : approval.evidence,
                runtimeDirectory: approval.runtimeDirectory, displayedDirectory: approval.displayedDirectory,
                approvalTarget: actionable ? { modalKey: approval.modalKey!, attemptId: approval.attemptId ?? null, generation: approval.generation ?? null } : undefined,
                waitingSince: approval.createdAt,
                nodeId: node.nodeId,
                sessionId: session.sessionId,
                providerType: session.providerType,
                machineLabel: nodeDisplayName(node) || node.nodeId,
                detail: null,
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
    providerApproval?: ProviderApproval | null
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

export function deriveApprovalsFromConversations(
    conversations: ApprovalConversationSource[] | undefined | null,
): PendingApprovalItem[] {
    if (!Array.isArray(conversations)) return []
    const items: PendingApprovalItem[] = []
    const seen = new Set<string>()
    for (const conv of conversations) {
        if (!conv) continue
        if (String(conv.status ?? '').trim().toLowerCase() !== 'waiting_approval') continue
        const approval = conv.providerApproval
        if (!approval || approval.source !== 'provider_modal' || approval.lifecycle !== 'pending' || approval.type !== 'tool_permission' || approval.evidence !== 'live' || !approval.actionable || !approval.modalKey || !Array.isArray(approval.buttons) || !approval.buttons.some(button => typeof button === 'string' && button.trim())) continue
        const sessionId = conv.sessionId || conv.routeId
        const nodeId = conv.daemonId || conv.routeId
        if (!sessionId || !nodeId) continue
        const key = `${nodeId}:${sessionId}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
            nodeId,
            sessionId,
            actionable: true, approvalType: approval.type, evidence: approval.evidence,
            approvalTarget: { modalKey: approval.modalKey, attemptId: approval.attemptId ?? null, generation: approval.generation ?? null },
            providerType: conv.agentType,
            machineLabel: conv.machineName || conv.workspaceName || nodeId,
            detail: null,
            waitingSince: approval.createdAt,
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
    onResolve: (nodeId: string, sessionId: string, action: PendingApprovalAction, target?: ProviderApprovalTarget) => void | Promise<unknown>
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
        if (!item.actionable || !item.approvalTarget || pending[`${item.nodeId}:${item.sessionId}:${item.approvalTarget.modalKey}`]) return
        const key = `${item.nodeId}:${item.sessionId}:${item.approvalTarget.modalKey}`
        setPending(prev => ({ ...prev, [key]: action }))
        void Promise.resolve(onResolve(item.nodeId, item.sessionId, action, item.approvalTarget)).finally(() => {
            setPending(prev => {
                const next = { ...prev }
                delete next[key]
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
                {t('mesh.approvals.title')}
                <span className="opacity-70 font-semibold">({items.filter(item => item.actionable).length})</span>
            </div>

            {items.length === 0 ? (
                <div className="text-2xs opacity-70">{t('mesh.approvals.empty')}</div>
            ) : (
                <ul className="flex flex-col gap-2">
                    {items.map(item => {
                        const active = pending[`${item.nodeId}:${item.sessionId}:${item.approvalTarget?.modalKey}`] ?? null
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
                                                title={t('mesh.approvals.waitingFor', { duration: waitLabel })}
                                            >
                                                {waitLabel}
                                            </span>
                                        )}
                                    </div>
                                    {item.approvalType && <div className="text-3xs opacity-70">{t(`mesh.approvals.types.${item.approvalType}`)} · {t(`mesh.approvals.evidence.${item.evidence || 'unavailable'}`)}</div>}
                                    <div className="text-3xs opacity-60 truncate">
                                        {item.detail
                                            ? item.detail.replace(/[\n\r]+/g, ' ').slice(0, 120)
                                            : t('mesh.approvals.sessionFallback', { id: item.sessionId })}
                                    </div>
                                    {item.runtimeDirectory && <div className="text-3xs break-all">{t('mesh.approvals.runtimeDirectory')}: {item.runtimeDirectory}</div>}
                                    {item.approvalType === 'provider_setup' && <div className="text-3xs break-all">{t('mesh.approvals.displayedDirectory')}: {item.displayedDirectory || t('mesh.approvals.directoryUnknown')}</div>}
                                    <a className="text-3xs underline" href={`/dashboard?activeTab=${encodeURIComponent(`session:${item.sessionId}`)}`}>{t('mesh.approvals.openSession')}</a>
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
                                {item.actionable && item.approvalTarget ? <div className="flex gap-2 shrink-0">
                                    <button
                                        onClick={() => handle(item, 'approve')}
                                        disabled={disabled}
                                        className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 font-extrabold ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                                        style={{ color: 'var(--status-warning)', background: 'var(--surface-primary)' }}
                                    >
                                        {active === 'approve' ? <IconSpinner size={12} /> : t('mesh.approvals.approve')}
                                    </button>
                                    <button
                                        onClick={() => handle(item, 'reject')}
                                        disabled={disabled}
                                        className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 font-semibold text-white bg-red-500/30 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                                    >
                                        {active === 'reject' ? <IconSpinner size={12} /> : t('mesh.approvals.reject')}
                                    </button>
                                </div> : <span className="text-3xs opacity-60">{t('mesh.approvals.needsAttention')}</span>}
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
