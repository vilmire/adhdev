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
import { InfoTip, Tooltip } from '../../ui/InfoTip'
import {
    SCHEDULING_STRATEGY_LABELS,
    collectMachineQuotaGroups,
    machineKeyForMeshNode,
    bindQuotaDisplayModel,
    createQuotaTextFormatter,
    formatQuotaAccount,
    formatQuotaFreshness,
    healthTone,
    quotaProviderLabel,
    schedulingReasonLabel,
    claudeQuotaHint,
    shortCommit,
    summarizeNodeDrift,
    type MachineQuotaGroup,
    type QuotaChipHint,
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
            <div className={`${meshTheme.cardClass} flex items-center gap-1 rounded-2xl p-4 text-xs ${meshTheme.textSecondary}`}>
                <span>{t('mesh.status.schedulingNotReported')}</span>
                <InfoTip content={t('mesh.status.schedulingNotReportedHint')} />
            </div>
        )
    }
    // Concurrency is governed per-node/per-slot (shown on the node rows below);
    // the mesh-level block carries the strategy only.
    return (
        <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-1 text-xs font-semibold ${meshTheme.textPrimary}`}>
                    {t('mesh.status.schedulingTitle')}
                    <InfoTip content={t('mesh.status.distributionTitle')} />
                </span>
                <Badge label={SCHEDULING_STRATEGY_LABELS[scheduling.strategy] ?? scheduling.strategy} tone="info" />
            </div>
        </div>
    )
}

function MeshNodeSchedulingBadges({ scheduling }: { scheduling?: RepoMeshNodeSchedulingStatus }) {
    const { t } = useTranslation('common')
    if (!scheduling) return null
    return (
        <>
            <Badge label={t('mesh.statusTab.load', { count: scheduling.load })} tone={scheduling.load > 0 ? 'info' : 'default'} title={t('mesh.statusTab.loadHint')} />
            {typeof scheduling.schedulingPriority === 'number' && scheduling.schedulingPriority !== 0 && (
                <Badge label={t('mesh.statusTab.priority', { value: scheduling.schedulingPriority })} tone="default" title={t('mesh.statusTab.priorityHint')} />
            )}
            {(scheduling.providerRoles ?? []).map(role => (
                <Badge
                    key={role.providerType}
                    label={`${role.providerType} ${role.activeAssigned}${typeof role.maxParallel === 'number' ? `/${role.maxParallel}` : ''}`}
                    tone={role.capReached ? 'warn' : 'default'}
                    title={t('mesh.statusTab.providerCapHint')}
                />
            ))}
            {scheduling.capReached && (scheduling.capReasons ?? []).map(reason => (
                <Badge key={reason} label={schedulingReasonLabel(reason)} tone="warn" title={t('mesh.statusTab.blockedReasonHint')} />
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
/** Hint per chip kind — mesh-card styling; the chip CONTENT comes from the shared model. */
const QUOTA_CHIP_HINT_KEYS: Record<QuotaChipHint, string> = {
    bucket: 'machine.quota.bucketHint',
    session: 'machine.quota.sessionHint',
    weekly: 'machine.quota.weeklyHint',
    monthly: 'machine.quota.monthlyHint',
    usage: 'machine.quota.usageHint',
}

export function MeshMachineQuotaCard({ machine, providerVersions }: { machine: MachineQuotaGroup; providerVersions?: Array<[string, string]> }) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    const quotaText = createQuotaTextFormatter(t)
    // Localized binding; keeps the one-argument model call the drift guard pins.
    const buildQuotaDisplayModel = bindQuotaDisplayModel(quotaText)
    const freshness = formatQuotaFreshness(machine.reportedAt, Date.now(), quotaText)
    return (
        <div className={`rounded-xl border p-3 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`text-xs font-semibold ${meshTheme.textPrimary}`}>{machine.label}</span>
                {machine.daemonBuildVersion && (
                    <Badge label={machine.daemonBuildVersion} tone="default" title={t('mesh.statusTab.daemonVersionHint')} />
                )}
                {machine.nodeCount > 1 && (
                    <Badge
                        label={t('mesh.statusTab.nodeCount', { count: machine.nodeCount })}
                        tone="default"
                        title={t('mesh.statusTab.nodeCountHint')}
                    />
                )}
                {freshness && (
                    <Tooltip content={t('mesh.status.quotaFreshnessHint')}>
                        <span className={`text-3xs ${meshTheme.textSecondary}`}>{freshness}</span>
                    </Tooltip>
                )}
            </div>
            {machine.quota.length === 0 ? (
                <div className={`mt-1.5 flex items-center gap-1 text-2xs ${meshTheme.textSecondary}`}>
                    {/* Two different silences, kept apart: a machine that has sent
                        no runtime facts at all (offline/degraded peer — we simply
                        have not heard from it) vs one that reports but whose
                        quota refresh has not run yet. Neither invents a number. */}
                    <span>
                        {machine.hasReported
                            ? t('mesh.status.quotaNotCollected')
                            : t('mesh.status.machineNotReporting')}
                    </span>
                    <InfoTip content={machine.hasReported ? t('mesh.status.quotaNotCollectedHint') : t('mesh.status.machineNotReportingHint')} />
                </div>
            ) : (
                <div className="mt-2 flex flex-col gap-1.5">
                    {machine.quota.map(({ provider, quota }) => {
                        // ALL content decisions (cue, bucket-replaces-axes,
                        // monthly axis, usage fallback, ok-without-windows vs
                        // failure) live in the shared view-model — this card
                        // only chooses HOW each kind looks (Badge styling).
                        const model = buildQuotaDisplayModel(quota)
                        const claudeHint = claudeQuotaHint(provider, quota)
                        return (
                            <div key={provider} className="flex flex-wrap items-center gap-1.5">
                                <span className={`text-2xs ${meshTheme.textPrimary}`}>{quotaProviderLabel(provider)}</span>
                                {/* Whose quota this is. Absent for providers that
                                    report no account (Claude Code exposes none), and
                                    then nothing renders — no placeholder. */}
                                {formatQuotaAccount(quota) && (
                                    <Tooltip content={t('mesh.status.quotaAccountHint')}>
                                        <span className={`text-3xs ${meshTheme.textSecondary}`}>{formatQuotaAccount(quota)}</span>
                                    </Tooltip>
                                )}
                                {model.kind === 'chips' && model.chips.map(chip => (
                                    <Badge
                                        key={chip.key}
                                        label={chip.label}
                                        tone={chip.tone}
                                        title={t(QUOTA_CHIP_HINT_KEYS[chip.hint])}
                                    />
                                ))}
                                {model.kind === 'usage' && (
                                    <Badge
                                        label={model.usageLabel!}
                                        tone="info"
                                        title={t(QUOTA_CHIP_HINT_KEYS.usage)}
                                    />
                                )}
                                {model.kind === 'okNoWindows' && (
                                    <Tooltip content={model.message ? `${model.message}\n${t('mesh.statusTab.quotaOkNoWindowHint')}` : t('mesh.statusTab.quotaOkNoWindowHint')}>
                                        <span className={`text-2xs ${meshTheme.textSecondary}`}>{t('mesh.status.quotaOkNoWindows')}</span>
                                    </Tooltip>
                                )}
                                {model.kind === 'failure' && (
                                    <Tooltip content={t('mesh.statusTab.quotaFailedHint')}>
                                        <span className={`text-2xs ${meshTheme.textSecondary}`}>{model.message}</span>
                                    </Tooltip>
                                )}
                                {/* Claude-only action for the existing failure: install a
                                    missing/broken capture bridge, or open one session when
                                    an installed bridge merely has an aged-out reading. */}
                                {claudeHint && (
                                    <Badge
                                        label={t(claudeHint === 'setup' ? 'mesh.status.quotaClaudeSetupChip' : 'mesh.status.quotaClaudeRefreshChip')}
                                        tone="warn"
                                        title={t(claudeHint === 'setup'
                                            ? 'mesh.status.quotaClaudeSetupHint'
                                            : 'mesh.status.quotaClaudeRefreshHint')}
                                    />
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
            {providerVersions && providerVersions.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {providerVersions.map(([provider, version]) => (
                        <Badge key={provider} label={`${provider}@${version}`} tone="info" title={t('mesh.status.machineVersionsTitle')} />
                    ))}
                </div>
            )}
        </div>
    )
}

function MeshMachinesSection({ status, previewVersion }: { status: RepoMeshStatus; previewVersion?: string }) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    const machines = collectMachineQuotaGroups(status)
    if (machines.length === 0) return null
    // The machine ⊃ nodes hierarchy, rendered literally: one section per
    // machine (plan quota + provider-version consensus on the machine card),
    // its base node first, then its worktrees as ⎇ branch rows underneath.
    const nodesByMachine = new Map<string, RepoMeshNodeStatus[]>()
    for (const node of status.nodes) {
        const key = machineKeyForMeshNode(node)
        const list = nodesByMachine.get(key)
        if (list) list.push(node)
        else nodesByMachine.set(key, [node])
    }
    const sortNodes = (nodes: RepoMeshNodeStatus[]) => [...nodes].sort((a, b) => {
        const aWorktree = a.isLocalWorktree === true || !!a.worktreeBranch
        const bWorktree = b.isLocalWorktree === true || !!b.worktreeBranch
        if (aWorktree !== bWorktree) return aWorktree ? 1 : -1
        return (a.worktreeBranch || a.nodeId).localeCompare(b.worktreeBranch || b.nodeId)
    })
    const machineVersionsFor = (nodes: RepoMeshNodeStatus[]): Record<string, string> | undefined => {
        // Consensus = the base node's report, else the first node reporting any.
        for (const node of nodes) {
            const versions = node.providerVersions
            if (versions && typeof versions === 'object' && Object.keys(versions).length > 0) return versions
        }
        return undefined
    }
    const reported = machines.filter(machine => machine.hasReported)
    const unreported = machines.filter(machine => !machine.hasReported)
    return (
        <div className="flex flex-col gap-2">
            <span className={`px-1 text-xs font-semibold ${meshTheme.textPrimary}`}>
                {t('mesh.status.machinesSection')}
            </span>
            {reported.map(machine => {
                const nodes = sortNodes(nodesByMachine.get(machine.machineKey) ?? [])
                const machineVersions = machineVersionsFor(nodes)
                return (
                    <div key={machine.machineKey} className="flex flex-col gap-1.5">
                        <MeshMachineQuotaCard
                            machine={machine}
                            providerVersions={machineVersions ? Object.entries(machineVersions).filter(([, v]) => typeof v === 'string' && v) : undefined}
                        />
                        {nodes.length > 0 && (
                            <div className={`ml-3 flex flex-col gap-1.5 border-l pl-3 ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                                {nodes.map(node => (
                                    <MeshNodeRuntimeRow key={node.nodeId} node={node} previewVersion={previewVersion} machineVersions={machineVersions} />
                                ))}
                            </div>
                        )}
                    </div>
                )
            })}
            {unreported.length > 0 && (
                <div className="px-1">
                    <Badge
                        tone="warn"
                        label={t('mesh.status.machinesNotReporting', { count: unreported.length })}
                        title={t('mesh.status.offlineMachinesTitle', { machines: unreported.map(machine => machine.label).join(', ') })}
                    />
                </div>
            )}
        </div>
    )
}

/**
 * Best-effort explanation for a degraded/unknown node health, derived from the
 * fields the wire already carries — the daemon does not send an explicit
 * healthReason, and "DEGRADED" alone forces the operator to guess.
 */
function nodeWorkspaceBasename(workspace: string | null | undefined): string | null {
    if (!workspace) return null
    const trimmed = workspace.replace(/[\\/]+$/, '')
    const segments = trimmed.split(/[\\/]/)
    return segments[segments.length - 1] || null
}

function describeNodeHealthIssue(node: RepoMeshNodeStatus, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
    if (node.health !== 'degraded' && node.health !== 'unknown') return null
    if (typeof node.error === 'string' && node.error) return node.error
    const git = node.git as { isGitRepo?: boolean } | undefined
    if (git && git.isGitRepo === false) return t('mesh.status.healthNotGitRepo')
    if ((node as { gitProbePending?: boolean }).gitProbePending) return t('mesh.status.healthProbePending')
    const connectionState = node.connection?.state
    if (connectionState && connectionState !== 'connected' && connectionState !== 'self') {
        return t('mesh.status.healthPeerConnection', { state: connectionState })
    }
    return t('mesh.status.healthNoLiveReport')
}

/**
 * The per-node runtime chips (health issue, worktree/bootstrap, connection,
 * sessions, update state, scheduling load). Shared by the Diagnostics list and
 * the Map tab's node side panel so the two cannot drift.
 */
export function MeshNodeRuntimeChips({ node, previewVersion, machineVersions, hideHealth = false }: { node: RepoMeshNodeStatus; previewVersion?: string; machineVersions?: Record<string, string>; hideHealth?: boolean }) {
    const { t } = useTranslation('common')
    const healthIssue = describeNodeHealthIssue(node, t)
    const sessionCount = (node.activeSessionDetails?.length ?? node.activeSessions?.length ?? 0)
    const isWorktree = node.isLocalWorktree === true
    const bootstrap = node.worktreeBootstrap as { status?: string } | undefined
    const staleBuild = node.staleDaemonBuild
    // T7: detected provider CLI versions on this node. Machine ⊃ nodes:
    // versions are a machine property rendered once on the machine card; a node
    // row only surfaces SKEW — a provider whose reported version differs from
    // the machine consensus (stale report / partial env).
    const providerVersions = node.providerVersions && typeof node.providerVersions === 'object'
        ? node.providerVersions
        : undefined
    const providerVersionEntries = providerVersions
        ? Object.entries(providerVersions).filter(([provider, version]) =>
            typeof version === 'string' && version
            && machineVersions !== undefined
            && machineVersions[provider] !== undefined
            && machineVersions[provider] !== version)
        : []
    const daemonBuildVersion = typeof node.daemonBuildVersion === 'string' && node.daemonBuildVersion
        ? node.daemonBuildVersion
        : undefined
    // Versioned facts bundle: prefer its build identity (version + COMMIT) over
    // the legacy flat version string.
    const factsBuild = node.nodeFacts?.daemonBuild
    const buildLabel = factsBuild?.commitShort
        ? `${factsBuild.version || daemonBuildVersion || '?'}@${factsBuild.commitShort}`
        : daemonBuildVersion
    // Deploy-lag is compared on the VERSION axis (daemon build version vs the
    // last deployed preview version), NOT commits: the daemon build stamps the
    // oss submodule commit while previewFreshness.currentMainCommit is a ROOT
    // repo commit — comparing those cross-repo hashes flagged every node as
    // deploy-lagged forever (observed live on 1.0.50-rc.1 right after a clean
    // fleet restart). Versions come from the same release axis on both sides.
    const nodeVersion = (factsBuild?.version || daemonBuildVersion || '').trim().toLowerCase()
    const deployLag = !!(nodeVersion && previewVersion && nodeVersion !== previewVersion.trim().toLowerCase())
    // Stale build and deploy lag are one user-facing fact: this machine is not
    // running the latest code yet. One chip; the specifics ride in its tooltip.
    const updatePendingHint = [
        buildLabel ? `${t('mesh.statusTab.daemonBuildHint')}: ${buildLabel}` : null,
        staleBuild ? t('mesh.status.badgeStaleBuildTitle') : null,
        deployLag ? `${t('mesh.status.badgeDeployLagTitle')} (${previewVersion})` : null,
    ].filter(Boolean).join('\n')
    return (
        <>
            <div className="flex flex-wrap items-center gap-1.5">
                {!hideHealth && <Badge label={node.health} tone={healthTone(node.health)} />}
                {healthIssue && (typeof node.error === 'string' && node.error
                    ? <Badge label={t('mesh.status.healthErrorChip')} tone="warn" title={node.error} />
                    : <Badge label={healthIssue} tone="warn" />)}
                {isWorktree && <Badge label={t('mesh.status.badgeWorktree')} tone="info" title={node.worktreeBranch ? t('mesh.status.badgeWorktreeBranchTitle', { branch: node.worktreeBranch }) : t('mesh.status.badgeWorktreeTitle')} />}
                {bootstrap?.status && bootstrap.status !== 'ready' && (
                    <Badge label={t('mesh.status.badgeBootstrap')} tone="warn" title={`${t('mesh.status.badgeBootstrapTitle')} (${bootstrap.status})`} />
                )}
                {node.connection?.state && node.connection.state !== 'self' && node.connection.state !== 'connected' && (
                    <Badge label={node.connection.state} tone="warn" title={t('mesh.status.badgeConnectionTitle')} />
                )}
                {sessionCount > 0 && <Badge label={t('mesh.status.badgeSessions', { count: sessionCount })} tone="default" />}
                {node.autoFastForwardEligible && <Badge label={t('mesh.status.badgeFastForwardReady')} tone="info" title={t('mesh.status.badgeFastForwardReadyTitle')} />}
                {(staleBuild || deployLag) && <Badge label={t('mesh.status.badgeUpdatePending')} tone="warn" title={updatePendingHint} />}
                <MeshNodeSchedulingBadges scheduling={node.scheduling} />
            </div>
            {providerVersionEntries.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {providerVersionEntries.map(([provider, version]) => (
                        <Badge key={provider} label={`${provider}@${version}`} tone="warn" title={t('mesh.status.versionSkewTitle')} />
                    ))}
                </div>
            )}
        </>
    )
}

function MeshNodeRuntimeRow({ node, previewVersion, machineVersions }: { node: RepoMeshNodeStatus; previewVersion?: string; machineVersions?: Record<string, string> }) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)
    const head = shortCommit(node.git?.headCommit)
    const isWorktree = node.isLocalWorktree === true
    const daemonBuildVersion = typeof node.daemonBuildVersion === 'string' && node.daemonBuildVersion ? node.daemonBuildVersion : undefined
    const factsBuild = node.nodeFacts?.daemonBuild
    const buildLabel = factsBuild?.commitShort
        ? `${factsBuild.version || daemonBuildVersion || '?'}@${factsBuild.commitShort}`
        : daemonBuildVersion
    return (
        <div className={`rounded-xl border p-3 ${meshTheme.isDark ? 'border-white/10 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className={`text-xs font-semibold ${meshTheme.textPrimary}`}>
                    {isWorktree
                        ? `⎇ ${node.worktreeBranch || nodeWorkspaceBasename(node.workspace) || node.nodeId.slice(0, 8)}`
                        : (nodeWorkspaceBasename(node.workspace) || node.machineLabel || node.nodeId)}
                </span>
                {/* Diagnostics keeps the exact build visible (it is what an
                    operator compares here); the node panel hides it. */}
                {buildLabel && <Badge label={buildLabel} tone="default" title={t('mesh.statusTab.daemonBuildHint')} />}
            </div>
            <MeshNodeRuntimeChips node={node} previewVersion={previewVersion} machineVersions={machineVersions} />
            <div className={`mt-1.5 text-2xs ${meshTheme.textSecondary}`}>
                {summarizeNodeDrift(node, t)}
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
                <span className={`text-xs font-semibold ${meshTheme.textPrimary}`}>{t('mesh.status.protocolTitle')}</span>
                {metrics && (
                    <Badge
                        label={`v2 ${Math.round(metrics.v2Ratio * 100)}% (${metrics.v2}/${metrics.total})`}
                        tone={metrics.total > 0 && metrics.v2 === metrics.total ? 'good' : 'info'}
                        title={t('mesh.statusTab.v2RatioHint')}
                    />
                )}
                {skew.length > 0 && (
                    <Badge label={t('mesh.statusTab.providerSkew', { count: skew.length })} tone="warn" title={t('mesh.statusTab.providerSkewHint')} />
                )}
            </div>
            {metrics && Object.keys(metrics.scopes).length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {Object.entries(metrics.scopes).map(([scope, count]) => (
                        <Badge key={scope} label={`${scope}: ${count}`} tone="default" title={t('mesh.statusTab.v2ScopeHint')} />
                    ))}
                </div>
            )}
            {skew.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                    {skew.map(entry => (
                        <div key={entry.provider} className="flex flex-wrap items-center gap-1.5">
                            <span className={`text-2xs font-semibold ${meshTheme.textPrimary}`}>{entry.provider}</span>
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
                <p className={`mt-2 text-2xs ${meshTheme.textSecondary}`}>{status.providerVersionSkewWarning}</p>
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
            <MeshMachinesSection
                status={canonicalStatus}
                previewVersion={typeof canonicalStatus.previewFreshness?.previewVersion === 'string' ? canonicalStatus.previewFreshness.previewVersion : undefined}
            />
            {canonicalStatus.nodes.length === 0 && (
                <div className={`rounded-xl border p-3 text-xs ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    {t('mesh.status.noNodesReporting')}
                </div>
            )}
        </div>
    )
}
