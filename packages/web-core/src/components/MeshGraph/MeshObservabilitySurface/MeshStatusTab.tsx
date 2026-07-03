import { useContext, useMemo } from 'react'
import type {
    RepoMeshNodeSchedulingStatus,
    RepoMeshNodeStatus,
    RepoMeshSchedulingStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { extractMagiActivity, type MagiGroupActivity } from '../../../utils/magi-activity'
import { MeshGraphThemeContext } from './meshSurfaceTheme'
import { Badge } from './meshSurfacePrimitives'
import {
    SCHEDULING_STRATEGY_LABELS,
    healthTone,
    schedulingReasonLabel,
    shortCommit,
    summarizeNodeDrift,
} from './meshSurfaceHelpers'

// ─── Status / Runtime tab ───────────────────────────────────────────────────
// The dedicated runtime surface: separates "what the mesh is doing right now"
// (health, sessions, assigned work, git drift, worktree bootstrap, auto-ff /
// stale-build signals, and the live scheduling picture) from the static config
// editors that live on the mesh detail page. Reuses the same Badge/theme/health
// helpers as the graph detail panel so the visual language stays consistent.

function MeshSchedulingCard({ scheduling }: { scheduling?: RepoMeshSchedulingStatus }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    if (!scheduling) {
        return (
            <div className={`${meshTheme.cardClass} rounded-2xl p-4 text-[12px] ${meshTheme.textSecondary}`}>
                Scheduling runtime not reported by this daemon (older build). Update the
                coordinator daemon to surface distribution, parallel caps, and per-node load.
            </div>
        )
    }
    const writeTone = scheduling.globalWriteCapReached ? 'warn' : 'good'
    return (
        <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>Scheduling</span>
                <Badge label={SCHEDULING_STRATEGY_LABELS[scheduling.strategy] ?? scheduling.strategy} tone="info" />
                <Badge
                    label={`write ${scheduling.activeWriteAssigned}/${scheduling.maxParallelTasks}`}
                    tone={writeTone}
                    title="Active write (non-readonly) assigned tasks vs the global parallel cap"
                />
                <Badge
                    label={`readonly ${scheduling.activeReadonlyAssigned}/${scheduling.maxReadonlyParallelTasks}`}
                    tone={scheduling.globalReadonlyCapReached ? 'warn' : 'default'}
                    title="Active read-only diagnosis tasks vs their (2× write) cap"
                />
            </div>
            <p className={`mt-2 text-[11px] ${meshTheme.textSecondary}`}>
                Distribution only governs how untargeted work is spread across eligible
                nodes. Per-node load, priority, and provider caps are below.
            </p>
        </div>
    )
}

function MeshNodeSchedulingBadges({ scheduling }: { scheduling?: RepoMeshNodeSchedulingStatus }) {
    if (!scheduling) return null
    return (
        <>
            <Badge label={`load ${scheduling.load}`} tone={scheduling.load > 0 ? 'info' : 'default'} title="Active assigned tasks on this node" />
            {typeof scheduling.schedulingPriority === 'number' && scheduling.schedulingPriority !== 0 && (
                <Badge label={`priority ${scheduling.schedulingPriority}`} tone="default" title="Soft scheduling priority (higher = preferred)" />
            )}
            {(scheduling.providerRoles ?? []).map(role => (
                <Badge
                    key={role.providerType}
                    label={`${role.providerType} ${role.activeAssigned}${typeof role.maxParallel === 'number' ? `/${role.maxParallel}` : ''}`}
                    tone={role.capReached ? 'warn' : 'default'}
                    title="Per-(node, provider) active assignments vs declared maxParallel cap"
                />
            ))}
            {scheduling.capReached && (scheduling.capReasons ?? []).map(reason => (
                <Badge key={reason} label={schedulingReasonLabel(reason)} tone="warn" title="Why this node cannot currently claim a new write task" />
            ))}
        </>
    )
}

function MeshNodeRuntimeRow({ node }: { node: RepoMeshNodeStatus }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const sessionCount = (node.activeSessionDetails?.length ?? node.activeSessions?.length ?? 0)
    const head = shortCommit(node.git?.headCommit)
    const isWorktree = node.isLocalWorktree === true
    const bootstrap = node.worktreeBootstrap as { status?: string } | undefined
    const staleBuild = node.staleDaemonBuild
    return (
        <div className={`rounded-xl border p-3 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>{node.machineLabel || node.nodeId}</span>
                <Badge label={node.health} tone={healthTone(node.health)} />
                {isWorktree && <Badge label="worktree" tone="info" title={node.worktreeBranch ? `Worktree branch ${node.worktreeBranch}` : 'Local worktree node'} />}
                {bootstrap?.status && bootstrap.status !== 'ready' && (
                    <Badge label={`bootstrap ${bootstrap.status}`} tone="warn" title="Worktree bootstrap is still in progress" />
                )}
                {node.connection?.state && node.connection.state !== 'self' && (
                    <Badge label={node.connection.state} tone={node.connection.state === 'connected' ? 'good' : 'warn'} title="Mesh peer connection state" />
                )}
                {sessionCount > 0 && <Badge label={`${sessionCount} session${sessionCount === 1 ? '' : 's'}`} tone="default" />}
                {node.autoFastForwardEligible && <Badge label="fast-forward ready" tone="info" title="Clean, behind upstream — safe for fast-forward" />}
                {!!staleBuild && <Badge label="stale build" tone="warn" title="Live daemon was built behind workspace HEAD — merged fixes may not be live" />}
                <MeshNodeSchedulingBadges scheduling={node.scheduling} />
            </div>
            <div className={`mt-1.5 text-[11px] ${meshTheme.textSecondary}`}>
                {summarizeNodeDrift(node)}
                {head ? <span className="ml-2 font-mono opacity-70">@{head}</span> : null}
            </div>
        </div>
    )
}

function MagiGroupRow({ group }: { group: MagiGroupActivity }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const { counts } = group
    return (
        <div className={`rounded-xl border p-3 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`min-w-0 truncate text-[12px] font-semibold ${meshTheme.textPrimary}`} title={group.question || group.consensusGroupId}>
                    {group.question || group.missionTitle || group.consensusGroupId}
                </span>
                {group.missionStatus && <Badge label={group.missionStatus} tone={group.missionStatus === 'completed' ? 'good' : group.missionStatus === 'abandoned' ? 'danger' : 'info'} title="Mission status" />}
                <Badge label={group.terminal ? 'done' : 'running'} tone={group.terminal ? 'good' : 'info'} title="Whether every replica has reached a terminal status" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge label={`${counts.completed}/${group.replicaCount} done`} tone="default" title="Completed replicas vs total dispatched" />
                {counts.pending > 0 && <Badge label={`${counts.pending} pending`} tone="default" />}
                {counts.assigned > 0 && <Badge label={`${counts.assigned} running`} tone="info" />}
                {counts.failed > 0 && <Badge label={`${counts.failed} failed`} tone="danger" />}
                {counts.cancelled > 0 && <Badge label={`${counts.cancelled} cancelled`} tone="warn" />}
                {group.source === 'queue' ? (
                    <Badge
                        label={group.coupled ? `coupled · ${group.distinctProviders}p × ${group.distinctNodes}m` : `independent · ${group.distinctProviders}p × ${group.distinctNodes}m`}
                        tone={group.coupled ? 'warn' : 'good'}
                        title={group.coupled
                            ? 'Replicas collapse to a single provider or machine — eventual agreements would be flagged source-coupled by MAGI synthesis.'
                            : 'Replicas span ≥2 providers and ≥2 machines — agreements would be independent.'}
                    />
                ) : (
                    <Badge label="replicas aged out" tone="default" title="Per-replica tasks have left the bounded mesh_status queue tail; only the mission aggregate is reachable." />
                )}
            </div>
        </div>
    )
}

function MagiActivityCard({ status }: { status: RepoMeshStatus }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const magi = useMemo(() => extractMagiActivity(status), [status])
    if (magi.totalGroups === 0 && magi.ledgerEvents.length === 0) return null
    return (
        <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>MAGI cross-verification</span>
                {magi.activeGroups > 0 && <Badge label={`${magi.activeGroups} running`} tone="info" />}
                <Badge label={`${magi.totalGroups} quorum${magi.totalGroups === 1 ? '' : 's'}`} tone="default" />
            </div>
            <div className="mt-2 flex flex-col gap-2">
                {magi.groups.map(group => <MagiGroupRow key={group.consensusGroupId} group={group} />)}
            </div>
            <p className={`mt-2 text-[11px] ${meshTheme.textSecondary}`}>
                Showing the reachable subset — quorum missions, per-replica progress, and provider/machine
                independence. Synthesis (claim clusters, the needs-verification list, open questions) is computed
                inside the mesh_magi_review tool and not persisted, so it is not yet surfaced here.
            </p>
        </div>
    )
}

// Receives the already-canonicalized status from MeshObservabilitySurface (the
// single boundary canonicalize), so `nodes` is guaranteed an array and no
// re-guard / re-canonicalize is needed here.
export function MeshStatusTab({ canonicalStatus }: { canonicalStatus: RepoMeshStatus }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return (
        <div className="flex flex-col gap-3 p-1">
            <MeshSchedulingCard scheduling={canonicalStatus.scheduling} />
            <MagiActivityCard status={canonicalStatus} />
            <div className="flex flex-col gap-2">
                <span className={`px-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textSecondary}`}>
                    Nodes — runtime
                </span>
                {canonicalStatus.nodes.length === 0 ? (
                    <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                        No nodes reporting runtime yet.
                    </div>
                ) : (
                    canonicalStatus.nodes.map(node => <MeshNodeRuntimeRow key={node.nodeId} node={node} />)
                )}
            </div>
        </div>
    )
}
