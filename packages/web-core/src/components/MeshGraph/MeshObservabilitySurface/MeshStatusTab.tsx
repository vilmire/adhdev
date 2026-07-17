import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type {
    RepoMeshNodeSchedulingStatus,
    RepoMeshNodeStatus,
    RepoMeshSchedulingStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
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
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    if (!scheduling) {
        return (
            <div className={`${meshTheme.cardClass} rounded-2xl p-4 text-[12px] ${meshTheme.textSecondary}`}>
                {t('mesh.status.schedulingNotReported')}
            </div>
        )
    }
    const writeTone = scheduling.globalWriteCapReached ? 'warn' : 'good'
    return (
        <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>{t('mesh.status.schedulingTitle')}</span>
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
                {t('mesh.status.distributionTitle')}
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
    // T7: detected provider CLI/ACP versions on this node, rendered as
    // `provider@version` chips so a version skew across nodes is visible at a glance.
    const providerVersions = node.providerVersions && typeof node.providerVersions === 'object'
        ? node.providerVersions
        : undefined
    const providerVersionEntries = providerVersions
        ? Object.entries(providerVersions).filter(([, v]) => typeof v === 'string' && v)
        : []
    const daemonBuildVersion = typeof node.daemonBuildVersion === 'string' && node.daemonBuildVersion
        ? node.daemonBuildVersion
        : undefined
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
                {daemonBuildVersion && <Badge label={`build ${daemonBuildVersion}`} tone="default" title="Daemon build version reported by this node" />}
                <MeshNodeSchedulingBadges scheduling={node.scheduling} />
            </div>
            {providerVersionEntries.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {providerVersionEntries.map(([provider, version]) => (
                        <Badge key={provider} label={`${provider}@${version}`} tone="info" title="Detected provider version on this node" />
                    ))}
                </div>
            )}
            <div className={`mt-1.5 text-[11px] ${meshTheme.textSecondary}`}>
                {summarizeNodeDrift(node)}
                {head ? <span className="ml-2 font-mono opacity-70">@{head}</span> : null}
            </div>
        </div>
    )
}

// T7 (B4): mesh-protocol-v2 adoption + provider-version-skew visibility card.
// Renders only when the daemon surfaced either signal (both are omitted by
// daemons predating the exposure), so it self-hides on older meshes.
function MeshProtocolVisibilityCard({ status }: { status: RepoMeshStatus }) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    const metrics = status.meshProtocolMetrics
    const skew = Array.isArray(status.providerVersionSkew) ? status.providerVersionSkew : []
    if (!metrics && skew.length === 0) return null
    return (
        <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>{t('mesh.status.protocolTitle')}</span>
                {metrics && (
                    <Badge
                        label={`v2 ${Math.round(metrics.v2Ratio * 100)}% (${metrics.v2}/${metrics.total})`}
                        tone={metrics.total > 0 && metrics.v2 === metrics.total ? 'good' : 'info'}
                        title="Share of pending coordinator events carrying a mesh-protocol-v2 envelope in this drain"
                    />
                )}
                {skew.length > 0 && (
                    <Badge label={`${skew.length} provider skew`} tone="warn" title="Providers running different versions across nodes" />
                )}
            </div>
            {metrics && Object.keys(metrics.scopes).length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {Object.entries(metrics.scopes).map(([scope, count]) => (
                        <Badge key={scope} label={`${scope}: ${count}`} tone="default" title="v2 event scope breakdown" />
                    ))}
                </div>
            )}
            {skew.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                    {skew.map(entry => (
                        <div key={entry.provider} className="flex flex-wrap items-center gap-1.5">
                            <span className={`text-[11px] font-semibold ${meshTheme.textPrimary}`}>{entry.provider}</span>
                            {entry.versions.map(v => (
                                <Badge
                                    key={v.version}
                                    label={`${v.version} · ${v.nodeIds.length} node${v.nodeIds.length === 1 ? '' : 's'}`}
                                    tone="default"
                                    title={v.nodeIds.join(', ')}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            )}
            {status.providerVersionSkewWarning && (
                <p className={`mt-2 text-[11px] ${meshTheme.textSecondary}`}>{status.providerVersionSkewWarning}</p>
            )}
        </div>
    )
}

// Receives the already-canonicalized status from MeshObservabilitySurface (the
// single boundary canonicalize), so `nodes` is guaranteed an array and no
// re-guard / re-canonicalize is needed here.
export function MeshStatusTab({ canonicalStatus }: { canonicalStatus: RepoMeshStatus }) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    return (
        <div className="flex flex-col gap-3 p-1">
            <MeshSchedulingCard scheduling={canonicalStatus.scheduling} />
            <MeshProtocolVisibilityCard status={canonicalStatus} />
            <div className="flex flex-col gap-2">
                <span className={`px-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textSecondary}`}>
                    {t('mesh.status.nodesRuntime')}
                </span>
                {canonicalStatus.nodes.length === 0 ? (
                    <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                        {t('mesh.status.noNodesReporting')}
                    </div>
                ) : (
                    canonicalStatus.nodes.map(node => <MeshNodeRuntimeRow key={node.nodeId} node={node} />)
                )}
            </div>
        </div>
    )
}
