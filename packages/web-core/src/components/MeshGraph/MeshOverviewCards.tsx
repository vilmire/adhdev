import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next'
import { queueTaskDisplayText } from '../../utils/queue-task-label';
import { Tooltip } from '../ui/InfoTip'
import { filterLedgerEntriesForDisplay, ledgerEntryNodeLabel } from './meshLedgerEvents';
import type {
    RepoMeshLedgerEntryStatus,
    RepoMeshLedgerSummaryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueSummary,
    RepoMeshQueueTask,
    RepoMeshStatus,
} from '@adhdev/daemon-core';
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme';
import type { MeshGraphSessionDetail } from '../../utils/mesh-visualization'
import PendingApprovalsInbox, { type PendingApprovalAction } from './PendingApprovalsInbox'
import { nodeDisplayName, nodeHealthText, sessionElapsedLabel, sessionRoleText, sessionStatusLabel, sessionStatusText } from './MeshObservabilitySurface/meshSurfaceHelpers'
import {
    RECENT_QUEUE_MAX,
    sessionStatusTone,
    nodeDriftSummary,
    missionStatusTone,
    missionStatusLabel,
    healthTone,
    queueTaskTone,
    queueTaskStatusLabel,
    difficultyTone,
    difficultyLabel,
    queueTaskSortRank,
    relativeTime,
    ledgerKindLabel,
    ledgerKindTone,
    payloadSummary,
    Card,
    StatusBadge,
    StatTile,
    EmptyHint,
    ListRow,
    MoreToggle,
    useRecentList,
    type MeshMissionDisplay,
    type Tone,
    type AsyncRefineJob,
} from './meshOverviewPrimitives';
import { MeshOverviewDetailModal } from './MeshOverviewDetails';

const EMPTY_LEDGER_SUMMARY: RepoMeshLedgerSummaryStatus = {
    meshId: '',
    totalEntries: 0,
    taskDispatched: 0,
    taskCompleted: 0,
    taskFailed: 0,
    taskStalled: 0,
    sessionLaunched: 0,
    checkpointCreated: 0,
    lastActivityAt: null,
    recentFailures: 0,
}

// ── detail modal selection ───────────────────────────────────────────────────

export type DetailSelection =
    | { kind: 'mission'; mission: MeshMissionDisplay }
    | { kind: 'ledger'; entry: RepoMeshLedgerEntryStatus }
    | { kind: 'queue'; task: RepoMeshQueueTask }
    | { kind: 'session'; node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }

/**
 * Detail navigation as a stack: opening a related item from inside the detail
 * panel pushes it (Back returns), instead of silently replacing the panel.
 */
export function useDetailStack() {
    const [stack, setStack] = useState<DetailSelection[]>([])
    const open = useCallback((selection: DetailSelection) => setStack(current => [...current, selection]), [])
    const back = useCallback(() => setStack(current => current.slice(0, -1)), [])
    const close = useCallback(() => setStack([]), [])
    return { detail: stack[stack.length - 1] ?? null, canGoBack: stack.length > 1, open, back, close }
}

/** Command seam used to fetch the verbose (full-goal) mission payload on demand. */
export type MeshCommandSeam = {
    daemonId?: string | null
    meshId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}

export default function MeshOverviewCards({
    status: canonicalStatus,
    daemonId = null,
    meshId = null,
    sendDaemonCommand = null,
}: { status: RepoMeshStatus } & MeshCommandSeam) {
    // `status` is already canonicalized once at the data boundary by the parent
    // (MeshObservabilitySurface calls canonicalizeRepoMeshStatus and passes the
    // result in), so nodes/queue/ledger are guaranteed arrays and we do NOT
    // canonicalize a second time here — a canonical status is the SSOT that flows
    // down. Aliased to `canonicalStatus` to make that contract explicit.
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    const queueSummary: RepoMeshQueueSummary | null = canonicalStatus.queue?.summary ?? null
    const queueTasks: RepoMeshQueueTask[] = canonicalStatus.queue?.tasks ?? []
    const ledgerSummary = canonicalStatus.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const ledgerEntries: RepoMeshLedgerEntryStatus[] = canonicalStatus.ledger?.entries ?? []
    const missions = (canonicalStatus as RepoMeshStatus).missions ?? []
    const missionTitleById = useMemo(() => {
        const map: Record<string, string> = {}
        for (const mission of missions) { if (mission.id && mission.title) map[mission.id] = mission.title }
        return map
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canonicalStatus])
    const liveMissions = missions.filter(m => m.status === 'active' || m.status === 'paused')
    const historyMissions = missions.filter(m => m.status === 'completed' || m.status === 'abandoned')
    const asyncRefineJobs = ((canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined) ?? []

    const { detail, canGoBack, open: setDetail, back: backDetail, close: closeDetail } = useDetailStack()

    // Resolve a mesh-wide pending approval through the daemon command seam. Routes to the
    // coordinator's mesh_approve, which forwards resolve_action to the target node+session.
    // Null seam (no daemon connection) → no-op; the inbox stays read-only in that case.
    const resolveApproval = useCallback(
        async (nodeId: string, sessionId: string, action: PendingApprovalAction) => {
            if (!daemonId || !sendDaemonCommand) return
            await sendDaemonCommand(daemonId, 'mesh_approve', {
                meshId: meshId ?? undefined,
                node_id: nodeId,
                session_id: sessionId,
                action,
            })
        },
        [daemonId, meshId, sendDaemonCommand],
    )

    // nodeId → friendly machine label (nickname → workspace·host·provider), so
    // ledger rows show the human-readable machine instead of a raw node_/daemon_ id.
    // Falls back to the raw id when the node isn't in the current snapshot.
    const resolveNodeLabel = useCallback((nodeId: string | undefined | null): string => {
        if (!nodeId) return ''
        const node = canonicalStatus.nodes.find(n => n.nodeId === nodeId)
        return node ? nodeDisplayName(node) : nodeId
    }, [canonicalStatus.nodes])

    // SHOW-TASK-DIFFICULTY: sessionId -> difficulty, from queue tasks currently
    // claimed by that session. The session axis itself carries no difficulty.
    const difficultyBySessionId = useMemo(() => {
        const map = new Map<string, string>()
        for (const task of queueTasks) {
            if (task.assignedSessionId && task.difficulty) map.set(task.assignedSessionId, task.difficulty)
        }
        return map
    }, [queueTasks])

    const sessionEntries = useMemo(() => {
        const entries: { node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }[] = []
        for (const node of canonicalStatus.nodes) {
            const sessions: MeshGraphSessionDetail[] = (node.activeSessionDetails && node.activeSessionDetails.length > 0)
                ? node.activeSessionDetails as MeshGraphSessionDetail[]
                : (node.activeSessions ?? []).map(sessionId => ({ sessionId, workspace: node.workspace, isCached: true }))
            for (const session of sessions) {
                const difficulty = difficultyBySessionId.get(session.sessionId)
                entries.push({ node, session: difficulty ? { ...session, difficulty } : session })
            }
        }
        return entries
    }, [canonicalStatus.nodes, difficultyBySessionId])

    return (
        // Plain flow content — the scroll container lives one level up in
        // MeshObservabilitySurface (the Overview tab wrapper). Keeping this a
        // non-scrolling, non-flex-1 column lets the wrapper's overflow-y-auto own
        // scrolling so all cards remain reachable in the dashboard full view.
        <div className="flex flex-col gap-3 pb-2">
            <PendingApprovalsInbox nodes={canonicalStatus.nodes} onResolve={resolveApproval} />

            <MissionsCard
                meshTheme={meshTheme}
                liveMissions={liveMissions}
                historyMissions={historyMissions}
                hasMissionField={Array.isArray((canonicalStatus as RepoMeshStatus).missions)}
                onSelect={mission => setDetail({ kind: 'mission', mission })}
            />

            <div className="grid gap-3 sm:grid-cols-2">
                <LedgerCard
                    meshTheme={meshTheme}
                    ledgerSummary={ledgerSummary}
                    entries={ledgerEntries}
                    resolveNodeLabel={resolveNodeLabel}
                    onSelect={entry => setDetail({ kind: 'ledger', entry })}
                />
                <QueueCard
                    meshTheme={meshTheme}
                    queueSummary={queueSummary}
                    tasks={queueTasks}
                    onSelect={task => setDetail({ kind: 'queue', task })}
                />
            </div>

            <NodesCard meshTheme={meshTheme} nodes={canonicalStatus.nodes} />

            <div className="grid gap-3 sm:grid-cols-2">
                <SessionsCard
                    meshTheme={meshTheme}
                    entries={sessionEntries}
                    onSelect={(node, session) => setDetail({ kind: 'session', node, session })}
                />
                <RefineJobsCard meshTheme={meshTheme} jobs={asyncRefineJobs} />
            </div>

            {detail && (
                <MeshOverviewDetailModal
                    meshTheme={meshTheme}
                    detail={detail}
                    onClose={closeDetail}
                    onBack={canGoBack ? backDetail : undefined}
                    daemonId={daemonId}
                    meshId={meshId ?? canonicalStatus.meshId ?? null}
                    sendDaemonCommand={sendDaemonCommand}
                    resolveNodeLabel={resolveNodeLabel}
                    queueTasks={queueTasks}
                    onOpenTask={task => setDetail({ kind: 'queue', task })}
                    missionTitles={missionTitleById}
                    onOpenMission={missionId => {
                        const mission = missions.find(candidate => candidate.id === missionId)
                        if (mission) setDetail({ kind: 'mission', mission })
                    }}
                />
            )}
        </div>
    )
}

// ── missions ──────────────────────────────────────────────────────────────

function MissionRow({ meshTheme, mission, onSelect }: {
    meshTheme: MeshGraphTheme
    mission: MeshMissionDisplay
    onSelect: () => void
}) {
    const { t } = useTranslation('common')
    const taskStats = mission.tasks
    const lastActivity = relativeTime(taskStats.lastActivityAt)
    // A mission with zero attached tasks carries no progress signal — mute the
    // whole row so the ones with real work stand out.
    const muted = taskStats.total === 0
    return (
        <ListRow meshTheme={meshTheme} onClick={onSelect} dimmed={muted}>
            <StatusBadge meshTheme={meshTheme} label={missionStatusLabel(mission.status, t)} tone={missionStatusTone(mission.status)} />
            <span className={`min-w-0 flex-1 truncate font-medium ${muted ? meshTheme.textSecondary : meshTheme.textPrimary}`}>{mission.title}</span>
            {taskStats.total > 0 && <span className={`shrink-0 tabular-nums text-2xs ${meshTheme.textMuted}`}>✓{taskStats.completed}/{taskStats.total}</span>}
            {lastActivity && <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{lastActivity}</span>}
        </ListRow>
    )
}

function MissionsCard({ meshTheme, liveMissions, historyMissions, hasMissionField, onSelect }: {
    meshTheme: MeshGraphTheme
    liveMissions: MeshMissionDisplay[]
    historyMissions: MeshMissionDisplay[]
    hasMissionField: boolean
    onSelect: (mission: MeshMissionDisplay) => void
}) {
    const { t } = useTranslation('common')
    const [showHistory, setShowHistory] = useState(false)
    const [showPaused, setShowPaused] = useState(false)
    // Active missions are the working set; paused ones fold behind a disclosure
    // (mirroring the completed/abandoned history) so a long paused backlog does
    // not bury the live work. When NOTHING is active, paused missions show
    // inline — an all-paused mesh would otherwise render as deceptively empty.
    const activeMissions = useMemo(() => liveMissions.filter(m => m.status === 'active'), [liveMissions])
    const pausedMissions = useMemo(() => liveMissions.filter(m => m.status !== 'active'), [liveMissions])
    const inlineMissions = activeMissions.length > 0 ? activeMissions : pausedMissions
    const foldedPaused = activeMissions.length > 0 ? pausedMissions : []
    const live = useRecentList(inlineMissions)
    return (
        <Card
            meshTheme={meshTheme}
            title={t('mesh.overview.missionCard')}
            count={liveMissions.length || undefined}
        >
            {inlineMissions.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                    {live.visible.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} onSelect={() => onSelect(m)} />)}
                    <MoreToggle meshTheme={meshTheme} expanded={live.expanded} hiddenCount={live.hiddenCount} onToggle={live.toggle} />
                </div>
            ) : (
                <EmptyHint meshTheme={meshTheme}>
                    {hasMissionField
                        ? t('mesh.overview.noActiveMissions')
                        : t('mesh.overview.missionDataUnavailable')}
                </EmptyHint>
            )}

            {foldedPaused.length > 0 && (
                <div className="mt-3 border-t border-border-subtle pt-2">
                    <button
                        type="button"
                        onClick={() => setShowPaused(v => !v)}
                        className={`flex w-full items-center gap-1.5 text-2xs font-medium ${meshTheme.textSecondary}`}
                    >
                        <span className={`inline-block transition-transform ${showPaused ? 'rotate-90' : ''}`}>▸</span>
                        <span>{t('mesh.overview.pausedMissions')}</span>
                        <span className={`tabular-nums ${meshTheme.textMuted}`}>{foldedPaused.length}</span>
                    </button>
                    {showPaused && (
                        <div className="mt-2 flex flex-col gap-0.5">
                            {foldedPaused.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} onSelect={() => onSelect(m)} />)}
                        </div>
                    )}
                </div>
            )}

            {historyMissions.length > 0 && (
                <div className="mt-3 border-t border-border-subtle pt-2">
                    <button
                        type="button"
                        onClick={() => setShowHistory(v => !v)}
                        className={`flex w-full items-center gap-1.5 text-2xs font-medium ${meshTheme.textSecondary}`}
                    >
                        <span className={`inline-block transition-transform ${showHistory ? 'rotate-90' : ''}`}>▸</span>
                        <span>{t('mesh.overview.completedHistory')}</span>
                        <span className={`tabular-nums ${meshTheme.textMuted}`}>{historyMissions.length}</span>
                    </button>
                    {showHistory && (
                        <div className="mt-2 flex flex-col gap-0.5">
                            {historyMissions.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} onSelect={() => onSelect(m)} />)}
                        </div>
                    )}
                </div>
            )}
        </Card>
    )
}

// ── ledger / queue ──────────────────────────────────────────────────────────

function LedgerCard({ meshTheme, ledgerSummary, entries, resolveNodeLabel, onSelect }: {
    meshTheme: MeshGraphTheme
    ledgerSummary: RepoMeshLedgerSummaryStatus
    entries: RepoMeshLedgerEntryStatus[]
    resolveNodeLabel: (nodeId: string | undefined | null) => string
    onSelect: (entry: RepoMeshLedgerEntryStatus) => void
}) {
    const { t } = useTranslation('common')
    const lastActivity = relativeTime(ledgerSummary.lastActivityAt)
    // Internal bookkeeping kinds are hidden unless the user asks for them.
    const [showAll, setShowAll] = useState(false)
    // Newest-first; ledger entries arrive oldest→newest from the daemon.
    const allRecent = useMemo(() => [...entries].reverse(), [entries])
    const recent = useMemo(() => filterLedgerEntriesForDisplay(allRecent, showAll), [allRecent, showAll])
    const hasHiddenKinds = recent.length !== allRecent.length || showAll
    const list = useRecentList(recent)
    return (
        <Card
            meshTheme={meshTheme}
            title={t('mesh.overview.ledgerCard')}
            // The tiles are ALL-TIME ledger totals, not current state — without
            // this caption "78 stalled" reads as 78 tasks stuck right now.
            action={<span className={`text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.ledgerAllTime')}</span>}
        >
            <div className="grid grid-cols-3 gap-1.5">
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statDispatched')} value={ledgerSummary.taskDispatched} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCompleted')} value={ledgerSummary.taskCompleted} tone="emerald" />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statFailed')} value={ledgerSummary.taskFailed} tone={ledgerSummary.taskFailed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statStalled')} value={ledgerSummary.taskStalled} tone={ledgerSummary.taskStalled > 0 ? 'amber' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statSessions')} value={ledgerSummary.sessionLaunched} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCheckpoints')} value={ledgerSummary.checkpointCreated} />
            </div>
            {allRecent.length > 0 && (
                <div className="mt-3 border-t border-border-subtle pt-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className={`text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.recentActivity')}</span>
                        {hasHiddenKinds && (
                            <button type="button" onClick={() => setShowAll(v => !v)} className={`text-3xs font-medium hover:underline ${meshTheme.textSecondary}`}>
                                {showAll ? t('mesh.activity.showKey') : t('mesh.activity.showAll')}
                            </button>
                        )}
                    </div>
                    {recent.length === 0 && <EmptyHint meshTheme={meshTheme}>{t('mesh.activity.noKeyEvents')}</EmptyHint>}
                    <div className="flex flex-col gap-0.5">
                        {list.visible.map(entry => {
                            const summary = payloadSummary(entry.payload)
                            return (
                                <ListRow key={entry.id} meshTheme={meshTheme} onClick={() => onSelect(entry)}>
                                    <StatusBadge meshTheme={meshTheme} label={ledgerKindLabel(entry.kind, t, entry.payload)} tone={ledgerKindTone(entry.kind)} />
                                    <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`}>{summary || ledgerEntryNodeLabel(entry, resolveNodeLabel) || '—'}</span>
                                    <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{relativeTime(entry.timestamp) ?? ''}</span>
                                </ListRow>
                            )
                        })}
                        <MoreToggle meshTheme={meshTheme} expanded={list.expanded} hiddenCount={list.hiddenCount} onToggle={list.toggle} />
                    </div>
                </div>
            )}
            {(ledgerSummary.recentFailures > 0 || (lastActivity && recent.length === 0)) && (
                <div className={`mt-2 flex items-center justify-between text-2xs ${meshTheme.textMuted}`}>
                    {ledgerSummary.recentFailures > 0
                        ? <span className="text-status-warning">{t('mesh.overview.recentFailures', { count: ledgerSummary.recentFailures })}</span>
                        : <span />}
                    {lastActivity && recent.length === 0 && <span>{lastActivity}</span>}
                </div>
            )}
        </Card>
    )
}

function QueueCard({ meshTheme, queueSummary, tasks, onSelect }: {
    meshTheme: MeshGraphTheme
    queueSummary: RepoMeshQueueSummary | null
    tasks: RepoMeshQueueTask[]
    onSelect: (task: RepoMeshQueueTask) => void
}) {
    // Live work (assigned/pending) first, then newest-updated history. Bound the
    // list to RECENT_QUEUE_MAX so both the "+N more" count and the expanded view
    // stay capped — the queue can hold thousands of historical rows.
    const recent = useMemo(() => {
        return [...tasks].sort((a, b) => {
            const rank = queueTaskSortRank(a.status) - queueTaskSortRank(b.status)
            if (rank !== 0) return rank
            return (b.updatedAt || '').localeCompare(a.updatedAt || '')
        }).slice(0, RECENT_QUEUE_MAX)
    }, [tasks])
    const list = useRecentList(recent)

    const { t } = useTranslation('common')
    if (!queueSummary) {
        return (
            <Card meshTheme={meshTheme} title={t('mesh.overview.queueCard')}>
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noQueueActivity')}</EmptyHint>
            </Card>
        )
    }
    return (
        <Card meshTheme={meshTheme} title={t('mesh.overview.queueCard')} count={queueSummary.active > 0 ? t('mesh.overview.activeCount', { count: queueSummary.active }) : undefined}>
            <div className="grid grid-cols-3 gap-1.5">
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statPending')} value={queueSummary.pending} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statAssigned')} value={queueSummary.assigned} tone={queueSummary.assigned > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statActive')} value={queueSummary.active} tone={queueSummary.active > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCompleted')} value={queueSummary.completed} tone="emerald" />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statFailed')} value={queueSummary.failed} tone={queueSummary.failed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCancelled')} value={queueSummary.cancelled} tone="muted" />
            </div>
            {recent.length > 0 && (
                <div className="mt-3 border-t border-border-subtle pt-2">
                    <div className={`mb-1 text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.recentTasks')}</div>
                    <div className="flex flex-col gap-0.5">
                        {list.visible.map(task => (
                            <ListRow key={task.id} meshTheme={meshTheme} onClick={() => onSelect(task)}>
                                <StatusBadge meshTheme={meshTheme} label={queueTaskStatusLabel(task.status, t)} tone={queueTaskTone(task.status)} />
                                {task.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(task.difficulty, t)} tone={difficultyTone()} />}
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={task.message || undefined}>{queueTaskDisplayText(task.message) || task.id}</span>
                                <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{relativeTime(task.updatedAt) ?? ''}</span>
                            </ListRow>
                        ))}
                        <MoreToggle meshTheme={meshTheme} expanded={list.expanded} hiddenCount={list.hiddenCount} onToggle={list.toggle} />
                    </div>
                </div>
            )}
        </Card>
    )
}

// ── nodes ───────────────────────────────────────────────────────────────────

function convergenceBadge(node: RepoMeshNodeStatus, t: (key: string) => string): { label: string; tone: Tone; hint?: string } | null {
    if (node.autoFastForwardEligible || node.suggestedAction === 'auto_fast_forward') return { label: t('mesh.status.badgeFastForwardReady'), tone: 'sky', hint: t('mesh.status.badgeFastForwardReadyTitle') }
    if (node.launchBlockedReason) return { label: t('mesh.blueprint.list.sectionBlocked'), tone: 'rose', hint: node.launchBlockedReason }
    return null
}

function NodesCard({ meshTheme, nodes }: { meshTheme: MeshGraphTheme; nodes: RepoMeshNodeStatus[] }) {
    const { t } = useTranslation('common')
    return (
        <Card meshTheme={meshTheme} title={t('mesh.overview.nodesCard')} count={nodes.length}>
            {nodes.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noNodes')}</EmptyHint>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {nodes.map(node => {
                        const sessionCount = (node.activeSessionDetails?.length ?? 0) || (node.activeSessions?.length ?? 0)
                        const conv = convergenceBadge(node, t)
                        const drift = nodeDriftSummary(node)
                        const branch = node.git?.branch ?? node.worktreeBranch ?? null
                        return (
                            <div key={node.nodeId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden rounded-lg border border-border-subtle bg-bg-glass px-3 py-2">
                                <StatusBadge meshTheme={meshTheme} label={nodeHealthText(node.health, t)} tone={healthTone(node.health)} />
                                <span className={`min-w-0 max-w-full flex-1 truncate text-sm font-medium ${meshTheme.textPrimary}`} title={node.workspace}>{nodeDisplayName(node)}</span>
                                {branch && <span className={`max-w-full truncate font-mono text-2xs ${meshTheme.textSecondary}`} title={branch}>{branch}</span>}
                                {drift && <span className={`max-w-full truncate font-mono text-3xs ${meshTheme.textMuted}`}>{drift}</span>}
                                {sessionCount > 0 && <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.sessionCount', { count: sessionCount })}</span>}
                                {typeof node.daemonBuildVersion === 'string' && node.daemonBuildVersion && (
                                    <Tooltip content={t('mesh.statusTab.daemonVersionHint')}>
                                        <span className={`shrink-0 font-mono text-3xs ${meshTheme.textMuted}`}>v{node.daemonBuildVersion}</span>
                                    </Tooltip>
                                )}
                                {conv && (
                                    <Tooltip content={conv.hint}>
                                        <StatusBadge meshTheme={meshTheme} label={conv.label} tone={conv.tone} />
                                    </Tooltip>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </Card>
    )
}

// ── sessions / refine jobs ──────────────────────────────────────────────────

function SessionsCard({ meshTheme, entries, onSelect }: {
    meshTheme: MeshGraphTheme
    entries: { node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }[]
    onSelect: (node: RepoMeshNodeStatus, session: MeshGraphSessionDetail) => void
}) {
    const { t } = useTranslation('common')
    const list = useRecentList(entries)
    return (
        <Card meshTheme={meshTheme} title={t('mesh.overview.sessionsCard')} count={entries.length || undefined}>
            {entries.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noActiveSessions')}</EmptyHint>
            ) : (
                <div className="flex flex-col gap-0.5">
                    {list.visible.map(({ node, session }) => {
                        const label = sessionStatusLabel(session)
                        // Where + who, not a raw session id: the machine (with worktree
                        // branch when applicable), the session's mesh role, provider and
                        // age. The raw id stays available in the row tooltip / detail.
                        const where = nodeDisplayName(node)
                        const elapsed = sessionElapsedLabel(session)
                        return (
                            <ListRow key={session.sessionId} meshTheme={meshTheme} onClick={() => onSelect(node, session)}>
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`}>
                                    {where}
                                </span>
                                <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{sessionRoleText(session, t)}</span>
                                <span className={`shrink-0 ${meshTheme.textMuted}`}>{session.providerType || '?'}</span>
                                {!elapsed.includes('not reported') && <span className={`shrink-0 text-3xs tabular-nums ${meshTheme.textMuted}`}>{elapsed}</span>}
                                <StatusBadge meshTheme={meshTheme} label={sessionStatusText(session, t)} tone={sessionStatusTone(label)} />
                            </ListRow>
                        )
                    })}
                    <MoreToggle meshTheme={meshTheme} expanded={list.expanded} hiddenCount={list.hiddenCount} onToggle={list.toggle} />
                </div>
            )}
        </Card>
    )
}

function RefineJobsCard({ meshTheme, jobs }: { meshTheme: MeshGraphTheme; jobs: AsyncRefineJob[] }) {
    const { t } = useTranslation('common')
    const failed = jobs.filter(j => j.status === 'failed').length
    return (
        <Card
            meshTheme={meshTheme}
            title={t('mesh.overview.refineCard')}
            count={jobs.length || undefined}
            action={failed > 0 ? <StatusBadge meshTheme={meshTheme} label={t('mesh.overview.failedCount', { count: failed })} tone="rose" /> : undefined}
        >
            {jobs.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noRefineJobs')}</EmptyHint>
            ) : (
                <div className="flex flex-col gap-1">
                    {jobs.slice(0, 8).map(job => {
                        // Failed jobs surface WHY inline — the last lifecycle event carries
                        // the failure code (e.g. patch_equivalence_failed) that otherwise
                        // required digging through mesh_task_history.
                        const failureReason = job.status === 'failed' ? (job.lastEvent || job.lastLedgerKind || '') : ''
                        return (
                            <div key={job.jobId} className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2 text-xs">
                                    <span className={`min-w-0 flex-1 truncate font-mono text-3xs ${meshTheme.textMuted}`}>
                                        {job.branch ?? job.jobId.slice(0, 14)}{job.into ? ` → ${job.into}` : ''}
                                    </span>
                                    <span className={`shrink-0 text-3xs font-semibold ${
                                        job.status === 'failed' ? 'text-status-error'
                                        : job.status === 'running' || job.status === 'accepted' ? 'text-accent'
                                        : 'text-status-online'
                                    }`}>{job.status}</span>
                                </div>
                                {failureReason && (
                                    <div className="truncate pl-1 text-3xs text-status-error" title={failureReason}>
                                        {failureReason}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </Card>
    )
}
