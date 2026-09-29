/**
 * Shared building blocks of the mesh Overview surface: tone/label mappers for
 * sessions, missions, queue tasks, health and ledger kinds, the small formatters,
 * and the card primitives (Card, StatTile, ListRow, MoreToggle, ModalRow …) both
 * the overview cards and their detail modal render with.
 */
import type { MeshMissionSummary, MeshMissionSlimSummary, RepoMeshNodeStatus, MeshMissionStatus, RepoMeshQueueTask } from '@adhdev/daemon-core';
import { meshChipTone, MESH_CHIP_BASE, type MeshGraphTheme } from './meshGraphTheme';
import { formatRelativeTimeLocalized } from '../../utils/time';
import { ledgerKindDisplayLabel, classifyLedgerKind } from './meshLedgerEvents';
import { useTranslation } from 'react-i18next';
import { useState, useCallback, type ReactNode } from 'react';

/**
 * Mission summary as it arrives on the wire: compact status calls send the slim
 * shape (`goalPreview`/`goalTruncated`, no `goal`), verbose sends the full
 * `goal`. Both may carry an optional `stats` rollup. Read `goal ?? goalPreview`.
 */
export type MeshMissionDisplay = MeshMissionSummary | MeshMissionSlimSummary

/**
 * MeshOverviewCards — the text/card "Overview" surface for a mesh. This is the
 * default tab shown by MeshObservabilitySurface; the graph lives behind the
 * "Graph" tab. It renders, top to bottom:
 *   1. Active/paused missions + a collapsible completed/abandoned history.
 *   2. Ledger and Queue stat-tile grids side by side.
 *   3. The node list (health, branch, drift, sessions, convergence/refine badges).
 *   4. Active sessions + refine jobs as a two-up row of small cards.
 *
 * Every overview card follows the same shape: a small stat header, a compact
 * "recent ~5" one-line list, a "+N more" toggle, and a click target on each row
 * that opens a shared detail modal (the same Row/Badge visual language the graph
 * surface's right panel uses). Hover is no longer the primary path to detail —
 * the user found clicking more effective — so rows are buttons that pin a modal.
 *
 * It is intentionally self-contained (no shared mutable state with the graph
 * surface) so the graph component stays untouched. Mission data is optional —
 * older daemons omit `status.missions`, in which case the mission card renders
 * an empty state.
 */

export type Tone = 'rose' | 'sky' | 'amber' | 'emerald' | 'muted' | 'default'

/** Tone → chip text + thin border (theme tokens). `sky` marks live/in-flight
 *  work, which the app signals with its single accent. */
function toneChipClass(tone: Tone): string {
    switch (tone) {
        case 'rose': return meshChipTone('danger')
        case 'amber': return meshChipTone('warn')
        case 'emerald': return meshChipTone('good')
        case 'sky': return 'border-accent/40 text-accent'
        default: return meshChipTone('neutral')
    }
}

/** Tone → text colour only (stat values, inline status words). */
function toneTextClass(tone: Tone | undefined, meshTheme: MeshGraphTheme): string {
    switch (tone) {
        case 'rose': return 'text-status-error'
        case 'amber': return 'text-status-warning'
        case 'emerald': return 'text-status-online'
        case 'sky': return 'text-accent'
        case 'muted': return meshTheme.textMuted
        default: return meshTheme.textPrimary
    }
}

/** How many rows each overview card shows before the "+N more" toggle. */
const RECENT_LIMIT = 5

/**
 * Hard cap on how many recent queue rows the expanded view will ever render.
 * The queue can hold thousands of historical tasks; the "+N more" toggle used
 * to dump every one into the DOM. Bound the list before it reaches the UI.
 */
export const RECENT_QUEUE_MAX = 40

export type AsyncRefineJob = {
    jobId: string
    status: 'accepted' | 'running' | 'completed' | 'failed'
    branch?: string
    into?: string
    completedAt?: string
    startedAt?: string
    /** Last refine lifecycle event/ledger kind — the failure code on failed jobs. */
    lastEvent?: string
    lastLedgerKind?: string
}

export function sessionStatusTone(label: string): Tone {
    if (label.includes('approval')) return 'amber'
    if (label.includes('generating')) return 'sky'
    if (label.includes('idle')) return 'emerald'
    if (label.includes('failed') || label.includes('stopped') || label.includes('interrupted')) return 'rose'
    return 'muted'
}

export function nodeDriftSummary(node: RepoMeshNodeStatus): string {
    const git = node.git
    if (!git) return ''
    const changes = (git.staged ?? 0) + (git.modified ?? 0) + (git.untracked ?? 0) + (git.deleted ?? 0) + (git.renamed ?? 0)
    const parts: string[] = []
    if (git.upstreamStatus === 'fresh' && ((git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0)) parts.push(`↑${git.ahead ?? 0}/↓${git.behind ?? 0}`)
    if (changes > 0) parts.push(`✎${changes}`)
    if (git.hasConflicts) parts.push('⚠')
    return parts.join(' · ')
}

export function missionStatusTone(status: MeshMissionStatus): Tone {
    switch (status) {
        case 'active': return 'emerald'
        case 'paused': return 'amber'
        case 'completed': return 'sky'
        case 'abandoned': return 'rose'
        default: return 'muted'
    }
}

/** Label for a mission's status badge — falls back to the raw value for forward-compat with an unrecognized future status (G5-3, same pattern as difficultyLabel below). */
export function missionStatusLabel(status: MeshMissionStatus, t: (key: string) => string): string {
    switch (status) {
        case 'active': return t('mesh.overview.statActive')
        case 'paused': return t('mesh.overview.statPaused')
        case 'completed': return t('mesh.overview.statCompleted')
        case 'abandoned': return t('mesh.overview.statAbandoned')
        default: return status
    }
}

export function healthTone(health: string): Tone {
    switch (health) {
        case 'online': return 'emerald'
        case 'dirty': return 'amber'
        case 'degraded':
        case 'offline': return 'rose'
        case 'wrong_branch': return 'sky'
        default: return 'muted'
    }
}

export function queueTaskTone(status: RepoMeshQueueTask['status']): Tone {
    switch (status) {
        case 'completed': return 'emerald'
        case 'failed': return 'rose'
        case 'cancelled': return 'muted'
        case 'assigned': return 'sky'
        case 'pending': return 'amber'
        default: return 'muted'
    }
}

/** Label for a queue task's status badge — reuses the existing stat-tile labels (same vocabulary, same casing) rather than inventing a parallel set. Falls back to the raw value for forward-compat with an unrecognized future status (G5-3, same pattern as difficultyLabel below). */
export function queueTaskStatusLabel(status: RepoMeshQueueTask['status'], t: (key: string) => string): string {
    switch (status) {
        case 'completed': return t('mesh.overview.statCompleted')
        case 'failed': return t('mesh.overview.statFailed')
        case 'cancelled': return t('mesh.overview.statCancelled')
        case 'assigned': return t('mesh.overview.statAssigned')
        case 'pending': return t('mesh.overview.statPending')
        default: return status
    }
}

/**
 * SHOW-TASK-DIFFICULTY: difficulty is a routing attribute, not a state, so it
 * renders as a neutral chip (the label carries the level) — same as the Map
 * cards. Semantic colour stays reserved for failure / attention.
 */
export function difficultyTone(): Tone {
    return 'default'
}

/** Label for a task's difficulty badge — falls back to the raw value for forward-compat with an unrecognized future difficulty. */
export function difficultyLabel(difficulty: string, t: (key: string) => string): string {
    switch (difficulty) {
        case 'easy': return t('mesh.difficulty.easy')
        case 'medium': return t('mesh.difficulty.medium')
        case 'difficult': return t('mesh.difficulty.difficult')
        case 'freeform': return t('mesh.difficulty.freeform')
        default: return difficulty
    }
}

/** Priority for the "recent queue" list: live work first, then newest history. */
export function queueTaskSortRank(status: RepoMeshQueueTask['status']): number {
    switch (status) {
        case 'assigned': return 0
        case 'pending': return 1
        // All historical statuses collapse to one rank so they interleave purely
        // by updatedAt desc (the tiebreaker) — a days-old failed task no longer
        // unconditionally pins above newer completed/cancelled rows.
        case 'completed':
        case 'failed':
        case 'cancelled': return 2
        default: return 3
    }
}

export function relativeTime(iso: string | null | undefined): string | null {
    return formatRelativeTimeLocalized(iso) || null
}

/** Human-readable duration from a millisecond span, e.g. 83000 → "1m 23s". */
export function formatDuration(ms: number | null | undefined): string | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
    if (ms < 1000) return `${Math.round(ms)}ms`
    const totalSeconds = Math.round(ms / 1000)
    const seconds = totalSeconds % 60
    const totalMinutes = Math.floor(totalSeconds / 60)
    const minutes = totalMinutes % 60
    const hours = Math.floor(totalMinutes / 60)
    const parts: string[] = []
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0) parts.push(`${minutes}m`)
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
    return parts.join(' ')
}

export function ledgerKindLabel(kind: string, t: (key: string) => string): string {
    return ledgerKindDisplayLabel(kind, t)
}

export function ledgerKindTone(kind: string): Tone {
    const event = classifyLedgerKind(kind)
    if (event === 'needsInput') return 'amber'
    if (event === 'nodeChanged') return 'muted'
    const k = kind.toLowerCase()
    if (k.includes('fail') || k.includes('stall') || k.includes('error')) return 'rose'
    if (k.includes('complete')) return 'emerald'
    if (k.includes('dispatch') || k.includes('launch') || k.includes('assign')) return 'sky'
    if (k.includes('checkpoint')) return 'amber'
    return 'muted'
}

export function payloadSummary(payload: Record<string, unknown> | undefined): string | null {
    if (!payload) return null
    const candidate = payload.message ?? payload.summary ?? payload.reason ?? payload.title
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    return null
}

// ── shared card primitives ───────────────────────────────────────────────

export function Card({ meshTheme, title, count, children, action }: {
    meshTheme: MeshGraphTheme
    title: string
    count?: number | string
    children: React.ReactNode
    action?: React.ReactNode
}) {
    // min-w-0 + overflow-hidden so this card can shrink inside a flex/grid parent
    // on narrow (~360px) viewports instead of forcing its track wider than the
    // viewport — the root cause of the mobile horizontal scroll.
    return (
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
                <span className={`text-xs font-semibold ${meshTheme.textPrimary}`}>{title}</span>
                {count !== undefined && (
                    <span className={`tabular-nums text-2xs ${meshTheme.textMuted}`}>{count}</span>
                )}
                {action && <span className="ml-auto">{action}</span>}
            </div>
            {children}
        </div>
    )
}

export function StatusBadge({ label, tone }: { meshTheme: MeshGraphTheme; label: string; tone: Tone }) {
    // The shared mesh chip (same geometry as the Map / Tasks chips and Badge):
    // sentence case, fixed height, tone on text + thin border only.
    return <span className={`${MESH_CHIP_BASE} align-middle ${toneChipClass(tone)}`}>{label}</span>
}

export function StatTile({ meshTheme, label, value, tone }: { meshTheme: MeshGraphTheme; label: string; value: number | string; tone?: Tone }) {
    return (
        <div className="flex flex-col items-center rounded-lg border border-border-subtle bg-bg-glass px-2 py-2">
            <span className={`tabular-nums text-base font-semibold leading-none ${toneTextClass(tone, meshTheme)}`}>{value}</span>
            <span className={`mt-1 text-3xs ${meshTheme.textMuted}`}>{label}</span>
        </div>
    )
}

export function EmptyHint({ meshTheme, children }: { meshTheme: MeshGraphTheme; children: React.ReactNode }) {
    return <div className={`text-xs ${meshTheme.textMuted}`}>{children}</div>
}

/**
 * Clickable one-line row used by every "recent N" list. The whole row is a
 * button so the click target opens the shared detail modal — consistent across
 * Mission / Ledger / Queue / Session cards.
 */
export function ListRow({ onClick, dimmed, children }: {
    meshTheme: MeshGraphTheme
    onClick?: () => void
    /** Visually mute the whole row (e.g. a mission with no tasks attached). */
    dimmed?: boolean
    children: React.ReactNode
}) {
    const hover = onClick ? 'hover:bg-bg-glass-hover' : ''
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            className={`flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-left text-xs transition ${hover} ${onClick ? 'cursor-pointer' : 'cursor-default'} ${dimmed ? 'opacity-55' : ''}`}
        >
            {children}
        </button>
    )
}

/** "+N more" / "show fewer" toggle shared by the recent lists. */
export function MoreToggle({ meshTheme, expanded, hiddenCount, onToggle }: {
    meshTheme: MeshGraphTheme
    expanded: boolean
    hiddenCount: number
    onToggle: () => void
}) {
    const { t } = useTranslation('common')
    if (hiddenCount <= 0) return null
    return (
        <button
            type="button"
            onClick={onToggle}
            className={`mt-1 self-start rounded-md px-1.5 py-0.5 text-2xs font-medium ${meshTheme.textSecondary} hover:underline`}
        >
            {expanded ? t('mesh.overview.showFewer') : t('mesh.overview.showMore', { count: hiddenCount })}
        </button>
    )
}

/** Drives the expand/collapse + "+N more" slice for a recent list. */
export function useRecentList<T>(items: T[], limit = RECENT_LIMIT) {
    const [expanded, setExpanded] = useState(false)
    const visible = expanded ? items : items.slice(0, limit)
    const hiddenCount = Math.max(0, items.length - limit)
    const toggle = useCallback(() => setExpanded(v => !v), [])
    return { visible, hiddenCount, expanded, toggle }
}

// ── shared detail modal ──────────────────────────────────────────────────────
// Reuses the graph surface's Row/Badge visual language so detail looks identical
// whether opened from the overview cards or the graph node panel.

export function ModalRow({ meshTheme, label, value }: { meshTheme: MeshGraphTheme; label: string; value: ReactNode }) {
    return (
        <div className={meshTheme.rowClass}>
            <span className={meshTheme.rowLabelClass}>{label}</span>
            <span className={meshTheme.rowValueClass}>{value}</span>
        </div>
    )
}
