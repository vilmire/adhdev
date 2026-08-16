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
    collectMachineQuotaGroups,
    describeQuotaFailure,
    formatQuotaAccount,
    formatQuotaFreshness,
    formatQuotaWindow,
    healthTone,
    quotaProviderLabel,
    quotaUsageTone,
    schedulingReasonLabel,
    shouldShowClaudeSetupHint,
    shortCommit,
    summarizeNodeDrift,
    type MachineQuotaGroup,
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
    // Global write/readonly cap numbers are legacy: current daemons deliberately
    // emit `scheduling: { strategy }` only (mesh-status.ts — real concurrency is
    // governed per-node/per-slot, shown on the node rows below). Render the cap
    // badges ONLY when an older daemon actually reports the numbers; otherwise
    // they showed as "write undefined/undefined".
    const hasGlobalCaps = typeof scheduling.activeWriteAssigned === 'number' && typeof scheduling.maxParallelTasks === 'number'
    return (
        <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>{t('mesh.status.schedulingTitle')}</span>
                <Badge label={SCHEDULING_STRATEGY_LABELS[scheduling.strategy] ?? scheduling.strategy} tone="info" />
                {hasGlobalCaps && (
                    <Badge
                        label={`write ${scheduling.activeWriteAssigned}/${scheduling.maxParallelTasks}`}
                        tone={scheduling.globalWriteCapReached ? 'warn' : 'good'}
                        title="Active write (non-readonly) assigned tasks vs the global parallel cap"
                    />
                )}
                {hasGlobalCaps && typeof scheduling.activeReadonlyAssigned === 'number' && typeof scheduling.maxReadonlyParallelTasks === 'number' && (
                    <Badge
                        label={`readonly ${scheduling.activeReadonlyAssigned}/${scheduling.maxReadonlyParallelTasks}`}
                        tone={scheduling.globalReadonlyCapReached ? 'warn' : 'default'}
                        title="Active read-only diagnosis tasks vs their (2× write) cap"
                    />
                )}
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

// Provider plan quota, rendered PER MACHINE — not per node.
//
// Quota is a machine property: the codex/kimi/claude credentials are machine
// local and the 5h/7d windows belong to that machine's plan. It arrives on
// MeshNodeFacts (a per-node envelope) purely because git_status is the
// transport, and letting the transport dictate the display unit is what put
// the same numbers on every card: a machine with N worktree nodes repeated one
// codex reading N times, which reads as N independent quotas. Nodes are
// grouped by canonical daemon id so each machine's quota appears exactly once.
//
// Three states stay visually distinct here exactly as they did per node; see
// the helper block in meshSurfaceHelpers.ts for why conflating them misleads:
//   - unreported: no quota key yet. NORMAL for a daemon started < ~15min ago or
//     one sitting idle, so it renders as a muted line, never a warning badge.
//   - unavailable/error: the machine looked and could not read it — failureKind
//     shown, because that is what tells "not installed" from "channel broken".
//   - ok: the 5h / 7d windows, tinted at the same 70/90% thresholds the
//     `adhdev quota` CLI uses.
function MeshMachineQuotaCard({ machine }: { machine: MachineQuotaGroup }) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    const freshness = formatQuotaFreshness(machine.reportedAt)
    return (
        <div className={`rounded-xl border p-3 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[12px] font-semibold ${meshTheme.textPrimary}`}>{machine.label}</span>
                {machine.daemonBuildVersion && (
                    <Badge label={machine.daemonBuildVersion} tone="default" title="Daemon build version running on this machine" />
                )}
                {machine.nodeCount > 1 && (
                    <Badge
                        label={`${machine.nodeCount} nodes`}
                        tone="default"
                        title="Mesh nodes (workspaces/worktrees) hosted by this machine — they share this one plan quota"
                    />
                )}
                {freshness && (
                    <span className={`text-[10px] ${meshTheme.textSecondary}`} title={t('mesh.status.quotaFreshnessHint')}>
                        {freshness}
                    </span>
                )}
            </div>
            {machine.quota.length === 0 ? (
                <div className={`mt-1.5 text-[11px] ${meshTheme.textSecondary}`}>
                    {/* Two different silences, kept apart: a machine that has sent
                        no runtime facts at all (offline/degraded peer — we simply
                        have not heard from it) vs one that reports but whose
                        quota refresh has not run yet. Neither invents a number. */}
                    {machine.hasReported
                        ? t('mesh.status.quotaNotCollected')
                        : t('mesh.status.machineNotReporting')}
                </div>
            ) : (
                <div className="mt-2 flex flex-col gap-1.5">
                    {machine.quota.map(({ provider, quota }) => {
                        const isLastGood = quota.metadata?.lastGoodWindows === true
                        const session = formatQuotaWindow(quota.session, undefined, isLastGood)
                        const weekly = formatQuotaWindow(quota.weekly, undefined, isLastGood)
                        const hasWindows = !!(session || weekly)
                        return (
                            <div key={provider} className="flex flex-wrap items-center gap-1.5">
                                <span className={`text-[11px] ${meshTheme.textPrimary}`}>{quotaProviderLabel(provider)}</span>
                                {/* Whose quota this is. Absent for providers that
                                    report no account (Claude Code exposes none), and
                                    then nothing renders — no placeholder. */}
                                {formatQuotaAccount(quota) && (
                                    <span className={`text-[10px] ${meshTheme.textSecondary}`} title={t('mesh.status.quotaAccountHint')}>
                                        {formatQuotaAccount(quota)}
                                    </span>
                                )}
                                {session && (
                                    <Badge
                                        label={`5h ${session}`}
                                        tone={quotaUsageTone(quota.session?.usedPercent ?? NaN)}
                                        title="Rolling 5-hour plan window reported by this machine"
                                    />
                                )}
                                {weekly && (
                                    <Badge
                                        label={`7d ${weekly}`}
                                        tone={quotaUsageTone(quota.weekly?.usedPercent ?? NaN)}
                                        title="Rolling 7-day plan window reported by this machine"
                                    />
                                )}
                                {!hasWindows && (
                                    <span className={`text-[11px] ${meshTheme.textSecondary}`} title="This machine reported that it could not read this provider's quota">
                                        {describeQuotaFailure(quota)}
                                    </span>
                                )}
                                {/* Claude-only: the daemon's message already names the
                                    command, so this adds the missing REASON — Claude Code
                                    has no outbound quota API, unlike codex/kimi. Not a
                                    fourth state; a hint on the existing failure line. */}
                                {shouldShowClaudeSetupHint(provider, quota) && (
                                    <span className={`text-[11px] ${meshTheme.textSecondary} opacity-80`}>
                                        {t('mesh.status.quotaClaudeSetupHint')}
                                    </span>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

function MeshMachinesQuotaSection({ status }: { status: RepoMeshStatus }) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    const machines = collectMachineQuotaGroups(status)
    // Empty only when the mesh has no nodes at all — a machine with nodes always
    // gets a card now, reporting or not. Nothing to head when there is nothing.
    if (machines.length === 0) return null
    return (
        <div className="flex flex-col gap-2">
            <span className={`px-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textSecondary}`}>
                {t('mesh.status.machinesQuota')}
            </span>
            {machines.map(machine => <MeshMachineQuotaCard key={machine.machineKey} machine={machine} />)}
        </div>
    )
}

function MeshNodeRuntimeRow({ node, mainAnchorCommit }: { node: RepoMeshNodeStatus; mainAnchorCommit?: string }) {
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
    // Versioned facts bundle: prefer its build identity (version + COMMIT) over
    // the legacy flat version string — the commit is the deploy-lag anchor.
    const factsBuild = node.nodeFacts?.daemonBuild
    const buildChipLabel = factsBuild?.commitShort
        ? `build ${factsBuild.version || daemonBuildVersion || '?'}@${factsBuild.commitShort}`
        : daemonBuildVersion ? `build ${daemonBuildVersion}` : undefined
    // Global deploy-lag anchor: the running daemon's build commit vs origin/main
    // (previewFreshness.currentMainCommit). Complements the node-LOCAL
    // staleDaemonBuild marker (build vs this workspace HEAD) — a daemon can be
    // current for its workspace yet behind the deployed main line.
    const deployLag = !!(factsBuild?.commit && mainAnchorCommit && factsBuild.commit !== mainAnchorCommit)
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
                {buildChipLabel && <Badge label={buildChipLabel} tone={staleBuild || deployLag ? 'warn' : 'default'} title="Daemon build (version@commit) reported by this node — the running daemon's actual code identity" />}
                {deployLag && <Badge label={`deploy-lag vs main@${shortCommit(mainAnchorCommit)}`} tone="warn" title="Running daemon build commit differs from origin/main — deploy + restart pending for this node" />}
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
            {/* Machines before nodes: quota is a machine property, and several
                nodes can share one machine. Grouping it here keeps each plan
                reading in exactly one place instead of repeating it on every
                worktree card below. */}
            <MeshMachinesQuotaSection status={canonicalStatus} />
            <div className="flex flex-col gap-2">
                <span className={`px-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textSecondary}`}>
                    {t('mesh.status.nodesRuntime')}
                </span>
                {canonicalStatus.nodes.length === 0 ? (
                    <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                        {t('mesh.status.noNodesReporting')}
                    </div>
                ) : (
                    canonicalStatus.nodes.map(node => <MeshNodeRuntimeRow key={node.nodeId} node={node} mainAnchorCommit={typeof canonicalStatus.previewFreshness?.currentMainCommit === 'string' ? canonicalStatus.previewFreshness.currentMainCommit : undefined} />)
                )}
            </div>
        </div>
    )
}
