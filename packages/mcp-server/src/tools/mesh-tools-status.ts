// Mesh tool implementations — status domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    COMPACT_DETAILED_NODES_BYTE_BUDGET,
    COMPACT_MAX_ACTIVE_WORK_ROWS,
    COMPACT_MISSIONS_BYTE_BUDGET,
    COMPACT_NODES_TOTAL_BYTE_BUDGET,
    annotateQuotaSnapshotFreshness,
    assignFullGitSnapshot,
    buildActiveWorkPollingGuidance,
    buildBranchConvergence,
    buildCompactStaleDirectWorkSummary,
    buildCoordinatorP2pRelayFailure,
    buildMeshActiveWork,
    buildMeshAsyncRefineJobs,
    buildMeshMagiActivity,
    summarizeMeshMagiActivity,
    buildMeshNodeProbeFreshness,
    buildMeshSchedulingRuntime,
    getLastQuotaRanking,
    buildNodeCapabilityExposure,
    buildNodeMachineIdentity,
    collectLiveStatusProbe,
    collectRelatedRepoStatuses,
    commandForNode,
    compactActiveWorkRecords,
    compactMeshStatusNode,
    compactNodeSeverity,
    computeMeshMissionStats,
    countUncommittedChanges,
    drainCoordinatorPendingEvents,
    extractGitStatus,
    extractReporterNodeFactsQuota,
    extractSubmodules,
    getActiveDirectDispatches,
    getLatestActiveLaunchFailure,
    getLedgerSummary,
    summarizeMeshUsage,
    getMeshStatusMissionSummaries,
    getMeshStatusMissionsCompact,
    getNodeLaunchReadiness,
    getQueue,
    getSessionRecoveryContext,
    isGitStatusDirty,
    isNoteworthyCompactNode,
    pinnedRepresentativeNodeIds,
    minimalCompactNode,
    readLedgerEntries,
    readNodeDaemonId,
    readNodeMachineId,
    readRelatedRepos,
    reconcileDirectDispatchesFromTranscriptEvidence,
    recordMeshCoordinatorToolCall,
    refreshMeshFromDaemon,
    summarizeBranchConvergence,
    summarizeMeshAsyncRefineJobs,
    summarizeNodeSessions,
} from './mesh-tools-internal.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';

// The v2 protocol version literal (mirrors MESH_PROTOCOL_VERSION_V2 in
// daemon-core mesh/contracts.ts). Kept as a local literal so this MCP-side
// summarizer stays dependency-free of daemon-core internals — the wire value is
// a stable contract, not an implementation detail.
const MESH_PROTOCOL_VERSION_V2_WIRE = '2.0';

/**
 * T7 (B4): summarize mesh-protocol-v2 adoption over the batch of pending events
 * surfaced in one mesh_status drain. Returns the count carrying a v2 envelope
 * (protocolVersion '2.0'), the count still on v1 (unstamped), the v2 adoption
 * ratio, and — for v2 events — a scope breakdown (unicast/broadcast/system).
 * Returns null when there is nothing to report (empty batch) so the caller can
 * omit the field. Read-only over the drained array — no store or counter mutation.
 */
export function summarizePendingEventProtocolMetrics(
    pendingEvents: any[],
): { total: number; v2: number; v1: number; v2Ratio: number; scopes: Record<string, number> } | null {
    if (!Array.isArray(pendingEvents) || pendingEvents.length === 0) return null;
    let v2 = 0;
    const scopes: Record<string, number> = {};
    for (const event of pendingEvents) {
        const protocolVersion = typeof event?.protocolVersion === 'string' ? event.protocolVersion : '';
        if (protocolVersion === MESH_PROTOCOL_VERSION_V2_WIRE) {
            v2 += 1;
            const scope = typeof event?.scope === 'string' && event.scope ? event.scope : 'unspecified';
            scopes[scope] = (scopes[scope] ?? 0) + 1;
        }
    }
    const total = pendingEvents.length;
    return {
        total,
        v2,
        v1: total - v2,
        v2Ratio: total > 0 ? Math.round((v2 / total) * 100) / 100 : 0,
        scopes,
    };
}



// ─── Tool Implementations ───────────────────────

export async function meshStatus(ctx: MeshContext, args: { includeStaleDirectWorkDetails?: boolean; includeTerminalDirectWork?: boolean; includeSessions?: boolean; includeUsage?: boolean; compact?: boolean; verbose?: boolean } = {}): Promise<string> {
    const rateResult = recordMeshCoordinatorToolCall(ctx, 'mesh_status');
    // Default to the slim payload for LLM callers; verbose forces the full payload.
    const compact = args.verbose === true ? false : (args.compact ?? true);

    await refreshMeshFromDaemon(ctx);
    const { mesh, transport } = ctx;

    let ledgerSummary = getLedgerSummary(mesh.id);

    // Scheduling-runtime projection (load-balancer's live view): tie-break strategy,
    // global parallel caps + consumption, and per-node load / priority / provider caps
    // with structured "why this node can't take more write work" reasons. Derived from
    // the mesh config + a queue snapshot (read-only) — never drives a scheduling
    // decision, only exposes the picture the claim path acts on. Computed once so each
    // node entry below can attach its slice and the response can carry the mesh rollup.
    const schedulingRuntime = buildMeshSchedulingRuntime(mesh, getQueue(mesh.id));
    const schedulingByNode = new Map(schedulingRuntime.nodes.map(n => [n.nodeId, n]));

    // Probe all nodes in parallel — git_status + session collection per node are independent.
    //
    // Dual-surface note (mesh-status-dual-surface): this coordinator-side node object
    // is assembled here independently of the daemon-core finalize path
    // (commands/high-family/mesh-status.ts, which stamps its own node via
    // buildMeshNodeMachineIdentity). The two surfaces are INTENTIONALLY distinct:
    //   • machine identity — buildNodeMachineIdentity (mesh-node-identity.ts) emits
    //     the SAME output shape as daemon-core's buildMeshNodeMachineIdentity
    //     (daemonId/machineId/hostname/machineName/displayName/coordinatorHostname/
    //     sameMachine/locality/localityReason/identityEvidence), so a field added to
    //     one must be added to the other. It cannot be collapsed into the daemon-core
    //     builder because the coordinator surface derives sameMachine/locality from
    //     richer control-plane evidence (isDirectLocalNode / isConfiguredCoordinatorNode /
    //     cloned-from tracing / local session evidence) that needs the full MeshContext,
    //     which the daemon-core `opts`-scalar signature does not carry.
    //   • capability exposure — buildNodeCapabilityExposure already delegates its tag
    //     computation to daemon-core's buildMeshNodeCapabilityTags (the SAME function
    //     the queue/dispatch matcher uses), so the exposed tags cannot drift from
    //     routing; only the exposure wrapper (byProvider map + raw capabilities) is local.
    // When adding a node field on either surface, update the peer surface too.
    const results = await Promise.all(mesh.nodes.map(async (node) => {
        const entry: any = {
            nodeId: node.id,
            workspace: node.workspace,
            machine: buildNodeMachineIdentity(ctx, node),
            daemonId: readNodeDaemonId(node),
            machineId: readNodeMachineId(node),
            // Needed by the compact fold to distinguish a machine (repo-root) node
            // from a worktree node: the per-daemon representative pin keeps machine
            // nodes out of the fold so a deploy roster can never lose a machine.
            isLocalWorktree: node.isLocalWorktree === true,
            ...getNodeLaunchReadiness(node),
            ...buildNodeCapabilityExposure(node),
        };

        // Per-node scheduling runtime (load, priority, provider caps, claim-block reasons).
        // Full detail is a dashboard/verbose concern; in compact mode it repeats per node
        // and would inflate the LLM payload past its byte budget, so compact keeps only the
        // two scalars a coordinator needs to reason about load (current load + cap-reached).
        // The mesh-level scheduling rollup (strategy/global caps) is always present below.
        const nodeScheduling = schedulingByNode.get(node.id);
        if (nodeScheduling) {
            // Drop the redundant nodeId — the entry already carries it.
            const { nodeId: _omit, ...rest } = nodeScheduling;
            entry.scheduling = compact
                ? { load: rest.load, capReached: rest.capReached }
                : rest;
        }

        // OBSERVABILITY (quota-ranking): the mesh's last quota-ranking decision
        // for this node, overwritten on every claim — so a coordinator who was
        // not tailing logs at dispatch time can still see WHY the current
        // provider won (or that this claim ADOPTED an existing session without
        // ranking anything — the idle-drain/event-driven claim paths never run
        // the ranking loop; see mesh-quota-routing.ts LastQuotaRankingRecord).
        // Present in both compact and verbose: it is one small object, already
        // bounded to the mesh's node count, not a per-call cost like the
        // scheduling projection above.
        //
        // ★Since 2026-08-20 this also carries `taskId` and `rationale` — the
        // winner's fitness score plus each beaten candidate and why it lost.
        // Before that, the quota ORDER was visible here but the fitness scores
        // behind it were not, and they existed only in the task_dispatched
        // ledger payload that just one tool (mesh_task_history) reads. Asked
        // "what were the scores and why?", a coordinator had nothing to read
        // and answered from a back-derived estimate — twice, wrongly. The
        // rationale is a bounded summary (<=4 losers), not a copy of the
        // ledger's full selectionTrajectory, so the per-node cost stays small.
        const lastQuotaRanking = getLastQuotaRanking(node.id);
        if (lastQuotaRanking) {
            entry.scheduling = { ...(entry.scheduling ?? {}), lastQuotaRanking };
        }

        // Tracks whether THIS call obtained live truth from a fresh git_status probe.
        // The coordinator-facing mesh_status always probes each node fresh, so a probe
        // that returns is live truth and a probe that throws is an unreachable peer —
        // consumed below to stamp the additive `dataFreshness` marker.
        let liveTruthProbed = false;
        try {
            const autoDiscover = (node.policy as any)?.autoDiscoverSubmodules !== false;
            // OFFLINE-NODE-STATUS-REFRESH: this is the mesh_status per-node git_status probe
            // (first awaited in the sequence, so it blocks earliest). Mark it status-origin so
            // an offline peer's relay gives up on the SHORT connect-wait budget instead of
            // sinking the whole explicit_refresh into the 90s connect deadline.
            const statusResult = await commandForNode(ctx, node, 'git_status', {
                workspace: node.workspace,
                refreshUpstream: true,
                includeSubmodules: autoDiscover,
                submoduleIgnorePaths: (node.policy as any)?.submoduleIgnorePaths || undefined,
            }, { statusProbe: true });
            liveTruthProbed = true;
            const status = extractGitStatus(statusResult);
            const uncommittedChanges = countUncommittedChanges(status);
            const dirty = isGitStatusDirty(status);
            entry.health = status?.isGitRepo ? (dirty ? 'dirty' : 'online') : 'degraded';
            assignFullGitSnapshot(entry, status);
            entry.branch = status?.branch;
            entry.isDirty = dirty;
            entry.uncommittedChanges = uncommittedChanges;
            entry.branchConvergence = buildBranchConvergence(mesh, node, status, dirty, uncommittedChanges);
            // Stale-daemon-build warning: the live daemon's build commit is a
            // strict ancestor of this workspace HEAD (or its oss submodule),
            // meaning merged code is not yet live (awaiting deploy/restart).
            // Computed git-correctly on the daemon side (git_status →
            // daemonBuildBehind); surfaced here as a top-level node field.
            if (status?.daemonBuildBehind && typeof status.daemonBuildBehind === 'object') {
                entry.staleDaemonBuild = status.daemonBuildBehind;
            }
            // Provider quota, as reported by the node that owns the credentials.
            // Rides the same git_status envelope as the rest of the node-facts
            // bundle — the daemon fills it from a cached snapshot on its own
            // refresh timer, so reading it here costs this probe nothing extra.
            // This surface is the observation copy; the ROUTING consumer
            // (daemon-core mesh-quota-routing.ts gate/spread) reads the same
            // bundle on the coordinator side, so keep the shape intact.
            const reportedQuota = extractReporterNodeFactsQuota(statusResult);
            if (reportedQuota) entry.quota = reportedQuota;
            // Submodule out-of-sync warning
            const submodules = extractSubmodules(statusResult, (node.policy as any)?.submoduleIgnorePaths || []);
            if (submodules && submodules.some((s: any) => s?.outOfSync)) {
                entry.submoduleWarning = 'One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.';
                entry.outOfSyncSubmodules = submodules.filter((s: any) => s?.outOfSync).map((s: any) => s.path);
            }
        } catch (e: any) {
            const failure = buildCoordinatorP2pRelayFailure(e, {
                command: 'git_status',
                targetDaemonId: node.daemonId,
                nodeId: node.id,
            });
            entry.health = 'degraded';
            entry.error = failure.error;
            entry.degradedReason = failure.recoverable ? 'p2p_relay_failure' : 'git_status_unavailable';
            Object.assign(entry, {
                code: failure.code,
                transport: failure.transport,
                recoverable: failure.recoverable,
                retryRecommended: failure.retryRecommended,
                nextAction: failure.nextAction,
                noFallbackReason: failure.noFallbackReason,
            });
        }

        // Additive freshness/reachability marker. Without this, the coordinator's
        // mesh_status could not tell a node whose live probe just succeeded from one
        // it could not reach — both rendered as `health` + git scalars only. Derived
        // through the SINGLE canonical daemon-core live-probe adapter
        // (buildMeshNodeProbeFreshness) rather than rebuilding the freshness input
        // here, so the dataSource/staleness wiring cannot drift between this
        // coordinator surface and the daemon aggregate (the rc.371 regression where
        // dataFreshness was wired on the daemon surface but null on every coordinator
        // node because this site re-derived its own input).
        entry.dataFreshness = buildMeshNodeProbeFreshness({
            git: entry.git,
            liveTruthProbed,
            isSelfNode: (entry.machine as any)?.sameMachine === true,
            daemonId: readNodeDaemonId(node),
            node,
        });

        // Recovery Hints & Next-step reporting
        const recoveryContext = getSessionRecoveryContext(mesh.id, { nodeId: node.id });
        if (recoveryContext.consecutiveNodeFailures > 0) {
            entry.recoveryHints = {
                consecutiveFailures: recoveryContext.consecutiveNodeFailures,
                lastTaskMessage: typeof recoveryContext.lastTaskMessage === 'string'
                    ? recoveryContext.lastTaskMessage.slice(0, 100) + (recoveryContext.lastTaskMessage.length > 100 ? '…' : '')
                    : recoveryContext.lastTaskMessage,
                advice: recoveryContext.advice,
                retryRecommended: recoveryContext.retryRecommended,
            };
        }

        const activeLaunchFailure = getLatestActiveLaunchFailure(mesh.id, node.id);
        if (activeLaunchFailure && node.isLocalWorktree) {
            entry.health = 'degraded';
            entry.degradedReason = 'worktree_launch_failed';
            entry.launchReady = false;
            entry.launchBlockedReason = activeLaunchFailure.code || 'mesh_launch_failed';
            entry.launchBlockedMessage = activeLaunchFailure.error || 'Previous worktree session launch failed';
            entry.lastLaunchFailure = activeLaunchFailure;
        }

        const nextStepHints: string[] = [];
        if (entry.degradedReason === 'worktree_launch_failed') {
            nextStepHints.push(`Retry mesh_launch_session(node_id: "${node.id}") after daemon mesh transport/P2P is healthy.`);
            nextStepHints.push(`If retry is not desired, cleanup the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`);
        } else if (entry.health === 'online' && node.isLocalWorktree) {
            nextStepHints.push(`Merge worktree to base via mesh_refine_node(node_id: "${node.id}")`);
        } else if (entry.health === 'dirty') {
            nextStepHints.push(`Commit changes via mesh_checkpoint(node_id: "${node.id}", message: "...")`);
        } else if (entry.health === 'degraded' && entry.error?.includes('git')) {
            nextStepHints.push('Initialize git repository or check workspace path.');
        }

        if (entry.branchConvergence?.needsConvergence === true && entry.branchConvergence.nextStep) {
            nextStepHints.push(String(entry.branchConvergence.nextStep));
        }

        if (recoveryContext.consecutiveNodeFailures > 0) {
            if (recoveryContext.retryRecommended) {
                nextStepHints.push(`Retry task on this node or launch a fresh session.`);
            } else {
                nextStepHints.push(`Consider reassigning work to a different node.`);
            }
        }

        if (nextStepHints.length > 0) {
            entry.nextStepHints = nextStepHints;
        }

        const relatedRepos = await collectRelatedRepoStatuses(ctx, node);
        if (relatedRepos.length) entry.relatedRepos = relatedRepos;

        const statusProbe = await collectLiveStatusProbe(ctx, node);
        const liveSessions = statusProbe.sessions;
        // Per-node daemon build stamp (commit/version of the running daemon).
        // Compact mode folds these per-daemonId at the response level, but the
        // raw field is kept on the node so verbose callers and self-coordinator
        // shape stay intact.
        if (statusProbe.daemonBuild) entry.daemonBuild = statusProbe.daemonBuild;
        // Failed/rolled-back upgrade on this node's daemon. Folded per-daemonId at
        // the response level (top-level `daemonUpgradeFailures`) and dropped from
        // the node in compact mode — same treatment as daemonBuild.
        if (statusProbe.upgradeFailure) entry.upgradeFailure = statusProbe.upgradeFailure;
        if (liveSessions.length > 0) {
            // Slim to essential fields only — full session objects are expensive in coordinator context.
            entry.sessions = liveSessions
                .map((s: any) => {
                    // A session is marked as a coordinator for THIS mesh when the daemon's
                    // coordinator registry / session settings report its meshId matches ours.
                    // From the caller's perspective (which is itself a coordinator for this
                    // mesh), any such session is "self" — i.e. it is the calling coordinator
                    // session, not a foreign delegated worker. This prevents the coordinator
                    // from mis-reporting its own generating CLI session as someone else's
                    // delegated task.
                    const coordinatorMeshId =
                        typeof s.coordinator?.meshId === 'string' ? s.coordinator.meshId : undefined;
                    const isSelfCoordinator = coordinatorMeshId === mesh.id;
                    return {
                        id: s.instanceId ?? s.id ?? s.sessionId,
                        status: s.status ?? s.lifecycle ?? s.state,
                        providerType: s.providerType ?? s.cliType ?? s.type,
                        ...(s.activeChat?.status ? { chatStatus: s.activeChat.status } : {}),
                        // Stage 6: attempt identity + causal stage from the unified turn
                        // projection (present on mesh-owned sessions only), so mesh_status
                        // reports the SAME attemptId/stage as read_chat and the dashboard.
                        ...(s.turn?.attemptId ? { attemptId: s.turn.attemptId } : {}),
                        ...(s.turn?.stage ? { turnStage: s.turn.stage } : {}),
                        ...(isSelfCoordinator ? { isSelfCoordinator: true, role: 'coordinator' as const } : {}),
                        // [T2] Carry the worker-computed last-message preview through the slim so
                        // the coordinator's inbox can show the worker's latest ASSISTANT reply
                        // without re-deriving it from a live in-process instance it doesn't host.
                        // The worker's get_status_metadata snapshot already computes these
                        // (status/snapshot.ts) from its real transcript; dropping them here forced
                        // the coordinator down a derive path that fails for genuinely remote
                        // workers, leaving the mobile inbox stuck on the dispatched user task.
                        ...(typeof s.lastMessagePreview === 'string' && s.lastMessagePreview
                            ? { lastMessagePreview: s.lastMessagePreview } : {}),
                        ...(typeof s.lastMessageRole === 'string' && s.lastMessageRole
                            ? { lastMessageRole: s.lastMessageRole } : {}),
                        ...(typeof s.lastMessageAt === 'number' && Number.isFinite(s.lastMessageAt)
                            ? { lastMessageAt: s.lastMessageAt } : {}),
                        // RESTORE-STICK: carry the worker's AUTHORITATIVE dashboard hide/mute
                        // state (already resolved by the worker's status/builders honoring any
                        // per-session user override) plus the raw userHidden/userMuted overrides.
                        // The coordinator's cloud snapshot append (daemon-cloud
                        // appendMeshOwnedSessionsToSnapshot) otherwise re-derives hide/mute purely
                        // from mesh policy and clobbers a user's manual restore/un-mute every
                        // snapshot — the un-hide flickered visible then re-hid. Dropping these
                        // here is exactly what starved the coordinator of the worker's real state.
                        ...(typeof s.surfaceHidden === 'boolean' ? { surfaceHidden: s.surfaceHidden } : {}),
                        ...(typeof s.muted === 'boolean' ? { muted: s.muted } : {}),
                        ...(typeof s.settings?.userHidden === 'boolean' ? { userHidden: s.settings.userHidden } : {}),
                        ...(typeof s.settings?.userMuted === 'boolean' ? { userMuted: s.settings.userMuted } : {}),
                    };
                })
                // Exclude sessions with no resolvable id (malformed or custom provider response).
                .filter((s: any) => s.id);
        }

        return entry;
    }));

    let ledgerEntries = readLedgerEntries(mesh.id, { tail: 200 });
    let directDispatches = getActiveDirectDispatches(mesh.id);
    const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, results, directDispatches, ledgerEntries);
    if (directReconciliation.reconciled > 0) {
        ledgerEntries = readLedgerEntries(mesh.id, { tail: 200 });
        directDispatches = getActiveDirectDispatches(mesh.id);
        ledgerSummary = getLedgerSummary(mesh.id);
    }
    const activeWorkEvidence = buildMeshActiveWork({
        meshId: mesh.id,
        queue: getQueue(mesh.id),
        ledgerEntries,
        directDispatches,
        nodes: results,
    });

    const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);
    const staleDirectWorkSummary = buildCompactStaleDirectWorkSummary(activeWorkEvidence.staleDirectWork, {
        note: activeWorkEvidence.staleDirectWorkNote,
        detailHint: 'Full stale direct entries are omitted from mesh_status by default. Call mesh_status with includeStaleDirectWorkDetails=true or inspect mesh_task_history for ledger detail.',
    });
    // Leak #2: in compact mode each activeWork row drops the duplicated
    // taskSummary/message echoes (keeps a short taskTitle + dispatch scalars).
    // Verbose keeps the full per-record text for debugging.
    const activeWorkForResponse = compact
        ? compactActiveWorkRecords(activeWorkEvidence.activeWork)
        : { records: activeWorkEvidence.activeWork, omitted: 0 };

    // Surface coordinator session identity at the top level so the caller (which
    // is itself a coordinator for this mesh) can immediately recognize which
    // sessions in the response are its own — see the per-session
    // `isSelfCoordinator` marker derived above.
    const coordinatorSessions: Array<Record<string, unknown>> = [];
    for (const nodeEntry of results) {
        const sessions = Array.isArray((nodeEntry as any).sessions) ? (nodeEntry as any).sessions : [];
        for (const s of sessions) {
            if (s?.isSelfCoordinator === true && s.id) {
                coordinatorSessions.push({
                    nodeId: (nodeEntry as any).nodeId,
                    sessionId: s.id,
                    providerType: s.providerType,
                    status: s.status,
                });
            }
        }
    }

    // Compact mode: slim each node's large duplicated `git` blob down to the
    // coordinator-relevant scalars + submodules. branch/health/headCommit/ahead/
    // behind/dirty/upstreamStatus/branchConvergence live as top-level node
    // fields (or inside the slim git snapshot) and are always preserved.
    //
    // Session N×M de-duplication: the per-node session list comes from a
    // daemon-wide `get_status_metadata` probe, so every node that shares a
    // daemonId reports the SAME sessions. Emitting the full array on every node
    // makes the payload grow O(nodes × sessions). In compact mode we therefore
    // (a) fold each node's `sessions` array to a `sessionSummary` (counts only),
    // and (b) emit the full slim session arrays exactly once per daemon under
    // top-level `daemonSessions`. The self-coordinator marker survives in both
    // the per-node summary (`selfCoordinatorSessionIds`) and the top-level
    // `coordinatorSessions`/`selfIdentification`. Individual per-node session
    // detail can be opted back in with `includeSessions=true`.
    const includeSessions = args.includeSessions === true;
    // Top-level per-daemon session map (compact). Sessions are recorded ONCE per
    // daemonId regardless of how many mesh nodes share that daemon, eliminating
    // the N×M duplication. With includeSessions=true the full slim session arrays
    // are emitted; otherwise each daemon is folded to a counts summary.
    const daemonSessions: Record<string, unknown> = {};
    if (compact) {
        const seenDaemons = new Set<string>();
        for (const entry of results as any[]) {
            const daemonId = typeof entry?.daemonId === 'string' && entry.daemonId ? entry.daemonId : '';
            const sessions = Array.isArray(entry?.sessions) ? entry.sessions : [];
            if (daemonId && sessions.length > 0 && !seenDaemons.has(daemonId)) {
                seenDaemons.add(daemonId);
                daemonSessions[daemonId] = includeSessions ? sessions : summarizeNodeSessions(sessions);
            }
        }
    }
    // Per-daemon build fold: the daemon build stamp (commit/version/track) is identical for every node
    // sharing a daemonId (it's a daemon-wide probe), so record it ONCE per
    // daemonId at the top level. Small field — emitted in both compact and
    // verbose modes so the coordinator can compare the live daemon's commit with
    // a just-merged fix and see its explicitly reported release track without
    // paging through nodes. Legacy peers carry track:'unknown', never an inferred
    // stable value.
    const daemonBuilds: Record<string, unknown> = {};
    for (const entry of results as any[]) {
        const daemonId = typeof entry?.daemonId === 'string' && entry.daemonId ? entry.daemonId : '';
        if (daemonId && entry?.daemonBuild && !(daemonId in daemonBuilds)) {
            daemonBuilds[daemonId] = entry.daemonBuild;
        }
    }
    // Per-daemon machine/quota fold (same N×M pattern as daemonSessions/daemonBuilds).
    //
    // `machine` (identity: hostname/machineName/locality/identityEvidence) and `quota`
    // (provider credit, owned by the credential holder) are properties of the DAEMON,
    // not of the node: every worktree sharing a daemonId reports a byte-for-byte
    // identical copy. On a 23-node mesh that measured ~8.0KB of machine and ~4.1KB of
    // quota duplicated across nodes. Record each ONCE per daemonId at the top level.
    //
    // Emitted in BOTH compact and verbose. Verbose previously had no daemon dedup at
    // all, so it carried the full duplication; the fold is where the waste actually is.
    //
    // ADDITIVE ROLLOUT — the per-node `machine`/`quota` fields are deliberately KEPT.
    // An LLM coordinator may be reading nodes[].machine / nodes[].quota directly, and
    // that cannot be discovered statically. This step only ADDS the grouped top-level
    // copy; removing the node-side fields is a separate follow-up, once the grouped
    // form is known to be in use.
    //
    // Grouping is guarded by value equality: a daemon whose nodes somehow disagree on
    // machine/quota keeps only the FIRST value at the top level, and the divergence
    // stays visible on the nodes themselves (which are never stripped here). The
    // grouped map is therefore never a lie, only possibly incomplete.
    const daemonMachines: Record<string, unknown> = {};
    const daemonQuotas: Record<string, unknown> = {};
    for (const entry of results as any[]) {
        const daemonId = typeof entry?.daemonId === 'string' && entry.daemonId ? entry.daemonId : '';
        if (!daemonId) continue;
        if (entry?.machine && !(daemonId in daemonMachines)) daemonMachines[daemonId] = entry.machine;
        // Pure-additive freshness annotation: the raw snapshot keeps every field
        // (updatedAt included) and gains computed ageMs/stale so a coordinator
        // never has to subtract epoch ms itself — it doesn't, and a stale
        // boot-refresh snapshot then reads as the current value. `stale` uses
        // the routing gate's own threshold (see mesh-compact.ts).
        if (entry?.quota && !(daemonId in daemonQuotas)) daemonQuotas[daemonId] = annotateQuotaSnapshotFreshness(entry.quota);
    }

    // Per-daemon failed-upgrade fold. A detached daemon upgrade answers
    // "scheduled" seconds before it runs, and its real outcome — install /
    // health gate / rollback — lands tens of seconds later with no channel back
    // to the caller. The durable failure notice was already readable via a
    // per-node get_status_metadata probe, but nothing surfaced it HERE, so a
    // coordinator watching mesh_status saw a silently-failed upgrade as success.
    // Folded once per daemonId (the probe is daemon-wide, identical across a
    // daemon's nodes) and summarized, not raw — see MeshUpgradeFailureSummary.
    const daemonUpgradeFailures: Record<string, unknown> = {};
    for (const entry of results as any[]) {
        const daemonId = typeof entry?.daemonId === 'string' && entry.daemonId ? entry.daemonId : '';
        if (daemonId && entry?.upgradeFailure && !(daemonId in daemonUpgradeFailures)) {
            daemonUpgradeFailures[daemonId] = entry.upgradeFailure;
        }
    }
    // Stale-build aggregate: any node whose live daemon build is behind its
    // workspace HEAD. Deduplicated per daemonId+scope so N worktrees on one
    // stale daemon don't spam N identical warnings.
    const staleDaemonBuilds: Array<Record<string, unknown>> = [];
    const seenStale = new Set<string>();
    for (const entry of results as any[]) {
        const behind = entry?.staleDaemonBuild;
        if (!behind || typeof behind !== 'object') continue;
        const daemonId = typeof entry?.daemonId === 'string' ? entry.daemonId : '';
        const key = `${daemonId}::${behind.scope ?? ''}::${behind.buildCommit ?? ''}::${behind.head ?? ''}`;
        if (seenStale.has(key)) continue;
        seenStale.add(key);
        // web-only stale builds are informational, not "fix not live". Only daemon-
        // affecting stale builds (or ones where the classification is unknown →
        // defaulted true) mean a merged daemon/refinery fix is not yet live.
        const isDaemonAffecting = behind.isDaemonAffecting !== false;
        staleDaemonBuilds.push({
            daemonId,
            nodeId: entry.nodeId,
            scope: behind.scope,
            liveBuildCommit: behind.buildCommit,
            liveBuildCommitShort: behind.buildCommitShort,
            head: behind.head,
            isDaemonAffecting,
            ...(Array.isArray(behind.affectedPackages) && behind.affectedPackages.length > 0
                ? { affectedPackages: behind.affectedPackages }
                : {}),
            // The full ~300-char warning prose is identical for every entry and is
            // already emitted ONCE at the top level as `staleDaemonBuildWarning`.
            // Keep it per-entry only in verbose to avoid N× duplication in compact.
            ...(compact ? {} : { warning: behind.warning }),
        });
    }
    const daemonAffectingStaleBuilds = staleDaemonBuilds.filter((b) => b.isDaemonAffecting !== false);
    const webOnlyStaleBuilds = staleDaemonBuilds.filter((b) => b.isDaemonAffecting === false);

    // T7 (visibility 7-2b): provider-version skew across nodes. Mirrors the
    // daemonBuilds/staleDaemonBuild aggregate pattern — fold each node's
    // self-reported providerVersions into a per-provider view, then flag any
    // provider whose version differs across the nodes that reported it. Purely
    // observational (never fail-closed): a coordinator uses this to notice that
    // node A is on claude-cli 1.2.3 while node B is on 1.1.0 before it delegates
    // work that assumes a uniform toolchain — the exact gap daemonBuilds could not
    // show (build-commit alone doesn't capture the installed CLI versions).
    const providerVersionsByProvider: Record<string, Record<string, string[]>> = {};
    for (const entry of results as any[]) {
        const versions = entry?.providerVersions;
        if (!versions || typeof versions !== 'object') continue;
        const nodeId = typeof entry?.nodeId === 'string' ? entry.nodeId : '';
        for (const [providerId, rawVersion] of Object.entries(versions as Record<string, unknown>)) {
            const version = typeof rawVersion === 'string' ? rawVersion.trim() : '';
            if (!providerId || !version) continue;
            const byVersion = (providerVersionsByProvider[providerId] ??= {});
            (byVersion[version] ??= []).push(nodeId);
        }
    }
    const providerVersionSkew: Array<Record<string, unknown>> = [];
    for (const [providerId, byVersion] of Object.entries(providerVersionsByProvider)) {
        const distinctVersions = Object.keys(byVersion);
        if (distinctVersions.length <= 1) continue; // uniform → no skew
        providerVersionSkew.push({
            provider: providerId,
            versions: distinctVersions.map((version) => ({
                version,
                nodeIds: byVersion[version].filter(Boolean),
            })),
        });
    }

    let stubbedNodeCount = 0;
    let foldedNodesSummary: Record<string, unknown> | undefined;
    const nodesForResponse = compact
        ? (() => {
            const compacted = results.map((entry: any) => {
                const next = compactMeshStatusNode(entry);
                if (!next || typeof next !== 'object') return next;
                if (Array.isArray(next.sessions)) {
                    next.sessionSummary = summarizeNodeSessions(next.sessions);
                    // Drop the full per-node array unless explicitly opted in. The
                    // de-duplicated full lists are available under top-level
                    // `daemonSessions` keyed by daemonId.
                    if (!includeSessions) delete next.sessions;
                }
                // Build stamp is folded per-daemon under top-level `daemonBuilds`;
                // drop the repetitive per-node copy in compact mode.
                if (next.daemonBuild !== undefined) delete next.daemonBuild;
                // machine is daemon-wide and now recorded in full once under top-level
                // `daemonMachines`. In COMPACT only, reduce the per-node copy to the
                // scalars a coordinator reads off a node directly; daemonId is the join
                // key back into the grouped map, so nothing is lost — it is one lookup
                // away. Verbose keeps the full per-node copy untouched. This mirrors how
                // `sessions` folds to `daemonSessions` in compact mode only.
                //
                // `quota` is deliberately NOT pointer-ized: compactMeshStatusNode already
                // folds it to one short "7d X% · 5h Y% · <age>" string per provider, so the
                // per-node copy is a few dozen bytes and is exactly the signal a coordinator
                // wants inline when picking a node. The full bundle is in daemonQuotas.
                if (next.machine && typeof next.machine === 'object') {
                    const m = next.machine as Record<string, unknown>;
                    next.machine = {
                        daemonId: m.daemonId,
                        displayName: m.displayName,
                        sameMachine: m.sameMachine,
                        seeDaemonMachines: true,
                    };
                }
                // Same fold as daemonBuild: available per-daemon at the top level
                // under `daemonUpgradeFailures`.
                if (next.upgradeFailure !== undefined) delete next.upgradeFailure;
                return next;
            });

            // Two-tier bounding, highest-severity first:
            //  1. detail byte-budget — noteworthy nodes get full compact detail until
            //     COMPACT_DETAILED_NODES_BYTE_BUDGET is spent; the rest degrade to a stub.
            //  2. total node-array byte-budget — quiet/overflow nodes are emitted as
            //     minimal stubs until COMPACT_NODES_TOTAL_BYTE_BUDGET is spent; any node
            //     beyond that is fully folded into the foldedNodes id-list summary.
            // Nodes that survive in the array keep their ORIGINAL order. Every node id is
            // either in the array (detail or stub) or listed in foldedNodes.nodeIds.
            // Per-daemon representative pin (see pinnedRepresentativeNodeIds): one
            // machine node per daemon is awarded detail BEFORE severity ranking, so a
            // quiet machine can never be folded out from under a deploy roster by
            // noisier worktrees on the same daemon. Worktrees fold first by design.
            const pinnedIds = pinnedRepresentativeNodeIds(compacted);
            const noteworthy = compacted.filter((n: any) => n && typeof n === 'object' && isNoteworthyCompactNode(n));
            const bySeverityDesc = (a: any, b: any) => compactNodeSeverity(b) - compactNodeSeverity(a);
            const isPinned = (n: any) => pinnedIds.has(String(n?.nodeId));
            // Pinned first (severity-ordered among themselves), then the rest by severity.
            const ranked = [
                ...compacted.filter((n: any) => n && typeof n === 'object' && isPinned(n)).sort(bySeverityDesc),
                ...noteworthy.filter((n: any) => !isPinned(n)).sort(bySeverityDesc),
            ];
            const detailedIds = new Set<string>();
            let detailSpent = 0;
            for (const n of ranked) {
                const cost = JSON.stringify(n).length + 1;
                // A pinned representative is never dropped for budget: the roster
                // guarantee is what this pin exists to provide.
                if (detailedIds.size === 0 || isPinned(n) || detailSpent + cost <= COMPACT_DETAILED_NODES_BYTE_BUDGET) {
                    detailedIds.add(String(n.nodeId));
                    detailSpent += cost;
                }
            }

            // severity order for awarding the remaining total budget to stubs
            const stubOrder = [...compacted]
                .filter((n: any) => n && typeof n === 'object')
                .sort(bySeverityDesc);
            const keptIds = new Set<string>(detailedIds);
            let totalSpent = detailSpent;
            for (const n of stubOrder) {
                const id = String(n.nodeId);
                if (keptIds.has(id)) continue;
                const stubCost = JSON.stringify(minimalCompactNode(n)).length + 1;
                if (totalSpent + stubCost <= COMPACT_NODES_TOTAL_BYTE_BUDGET) {
                    keptIds.add(id);
                    totalSpent += stubCost;
                }
            }

            const fullyFolded: any[] = [];
            const out = compacted
                .map((n: any) => {
                    if (!n || typeof n !== 'object') return n;
                    const id = String(n.nodeId);
                    if (detailedIds.has(id)) return n;
                    if (keptIds.has(id)) {
                        stubbedNodeCount += 1;
                        return minimalCompactNode(n);
                    }
                    fullyFolded.push(n);
                    return null;
                })
                .filter((n: any) => n !== null);

            if (fullyFolded.length > 0) {
                const byBranchConvergence: Record<string, number> = {};
                const byHealth: Record<string, number> = {};
                const nodeIds: string[] = [];
                for (const n of fullyFolded) {
                    const bc = typeof n?.branchConvergence?.status === 'string' ? n.branchConvergence.status : 'unknown';
                    byBranchConvergence[bc] = (byBranchConvergence[bc] ?? 0) + 1;
                    const h = typeof n?.health === 'string' ? n.health : 'unknown';
                    byHealth[h] = (byHealth[h] ?? 0) + 1;
                    if (n?.nodeId) nodeIds.push(String(n.nodeId));
                }
                foldedNodesSummary = {
                    count: fullyFolded.length,
                    note: 'Node-array byte budget reached: these nodes are listed by id only. Query a specific node_id or use verbose=true for their detail.',
                    byHealth,
                    byBranchConvergence,
                    nodeIds,
                };
            }
            return out;
        })()
        : results;

    // MISSION-STATUS-TASK-WARNING-sibling MESH-CAP-SURFACE-REMOVAL: mesh.policy is
    // spread minus maxParallelTasks, and the mesh-level scheduling rollup drops the
    // global-cap numbers (maxParallelTasks/maxReadonlyParallelTasks/activeWriteAssigned/
    // activeReadonlyAssigned/globalWriteCapReached/globalReadonlyCapReached). Real
    // concurrency is governed per-node/per-slot (nodes[].scheduling.providerRoles /
    // capReasons, still present below) — the global number does not represent actual
    // capacity and misleads a coordinator into narrating "N of M slots free" from it.
    // Exposure-only: buildMeshSchedulingRuntime still computes these internally for
    // maybeAutoLaunchOneQueueSession's own gating; only the response surface changed.
    const { maxParallelTasks: _omitPolicyMaxParallelTasks, ...policyForResponse } = (mesh.policy || {}) as unknown as Record<string, unknown>;
    const response: Record<string, unknown> = {
        meshId: mesh.id,
        meshName: mesh.name,
        repoIdentity: mesh.repoIdentity,
        policy: policyForResponse,
        // Mesh-level scheduling rollup (strategy only — the global cap numbers are
        // deliberately not surfaced here, see the comment above). Per-node detail
        // (load/priority/provider caps/claim-block reasons) lives on each
        // nodes[].scheduling; the node array is dropped here to avoid duplicating it.
        scheduling: {
            strategy: schedulingRuntime.strategy,
        },
        payloadMode: compact ? 'compact' : 'full',
        refreshedAt: new Date().toISOString(),
        sourceOfTruth: {
            membership: 'coordinator_daemon_live_mesh',
            currentStatus: 'live_git_and_session_probes',
            activeWork: 'mesh_queue_file_and_local_ledger',
            historicalEvidenceOnly: ['recoveryHints', 'ledgerSummary'],
        },
        nodes: nodesForResponse,
        ...(compact && stubbedNodeCount > 0
            ? {
                stubbedNodesNote: `${stubbedNodeCount} node(s) in the array above are reduced to a minimal stub (marked folded:true) in compact mode — healthy/clean nodes plus any beyond the detail byte-budget. They remain addressable by node_id; use verbose=true for their full detail.`,
            }
            : {}),
        ...(compact && foldedNodesSummary ? { foldedNodes: foldedNodesSummary } : {}),
        ...(compact && Object.keys(daemonSessions).length > 0 ? { daemonSessions } : {}),
        ...(Object.keys(daemonBuilds).length > 0 ? { daemonBuilds } : {}),
        // Per-daemon machine identity / provider quota, recorded once per daemonId
        // instead of repeated on every node sharing that daemon. Both modes.
        ...(Object.keys(daemonMachines).length > 0 ? { daemonMachines } : {}),
        ...(Object.keys(daemonQuotas).length > 0 ? { daemonQuotas } : {}),
        ...(Object.keys(daemonUpgradeFailures).length > 0
            ? {
                daemonUpgradeFailures,
                daemonUpgradeFailureWarning: 'One or more daemons have a failed-upgrade notice on record: that daemon\'s LAST upgrade failed and rolled back, so it is still on the PREVIOUS version. An upgrade/restart response only reports "scheduled", never success — do not read a prior success as proof the version changed. The notice persists until a later upgrade succeeds, so check targetVersion/recordedAt: a target other than the running version is a stale earlier attempt. Full body at noticePath, trace at logPath.',
            }
            : {}),
        ...(staleDaemonBuilds.length > 0 ? { staleDaemonBuilds } : {}),
        ...(daemonAffectingStaleBuilds.length > 0
            ? {
                staleDaemonBuildWarning: 'One or more live daemons were built from a commit behind the workspace HEAD with daemon-runtime package changes. Merged refinery/mesh-tool fixes are NOT live on those daemons until they are rebuilt/redeployed and restarted — a local daemon-core dist rebuild does not update a cloud daemon. Do not assume a just-merged fix is active.',
            }
            : {}),
        ...(webOnlyStaleBuilds.length > 0
            ? {
                webOnlyStaleBuildNote: 'One or more live daemons are behind workspace HEAD, but only web packages changed in that range. The daemon does NOT need a rebuild/restart — redeploy the web app to reflect those changes. This is informational, not a "fix not live" condition.',
            }
            : {}),
        // T7: provider CLI/ACP version skew across nodes (observational only).
        ...(providerVersionSkew.length > 0
            ? {
                providerVersionSkew,
                providerVersionSkewWarning: 'One or more provider CLIs/ACP agents are running different versions across mesh nodes (see providerVersionSkew). This is informational, not a dispatch blocker — but a task that assumes a uniform toolchain (e.g. a version-specific flag or output format) may behave differently per node. Consider aligning versions or pinning the task to a node with the expected version.',
            }
            : {}),
        activeWork: activeWorkForResponse.records,
        ...(compact && activeWorkForResponse.omitted > 0
            ? { activeWorkRowsOmitted: activeWorkForResponse.omitted }
            : {}),
        ...(compact
            ? { activeWorkHint: `Compact activeWork rows carry a short taskTitle + dispatch scalars only; full task prompt/summary text is omitted — use mesh_task_history or mesh_status verbose=true. First ${COMPACT_MAX_ACTIVE_WORK_ROWS} rows serialized.` }
            : {}),
        staleDirectWorkSummary,
        ...(args.includeStaleDirectWorkDetails === true ? { staleDirectWork: activeWorkEvidence.staleDirectWork } : {}),
        // terminalDirectWork is historical (completed/failed direct dispatches) — opt-in only.
        ...(args.includeTerminalDirectWork === true ? { terminalDirectWork: activeWorkEvidence.terminalDirectWork } : {}),
        activeWorkSummary: activeWorkEvidence.summary,
        ...(pollingGuidance ? { pollingGuidance } : {}),
        ...(rateResult.rateLimitExceeded ? { pollingRateAdvisory: { type: 'rate_limit_exceeded', tool: 'mesh_status', callsInWindow: rateResult.callsInWindow, message: rateResult.advisory } } : {}),
        branchConvergenceSummary: summarizeBranchConvergence(results, compact),
        ...(coordinatorSessions.length > 0
            ? {
                coordinatorSessions,
                selfIdentification: {
                    meshId: mesh.id,
                    coordinatorSessions,
                    note: 'Sessions listed here are coordinator sessions for this mesh. The calling coordinator IS one of these sessions — do not treat its own generating CLI session as a foreign delegated task. Per-session marker: sessions[].isSelfCoordinator === true.',
                },
            }
            : {}),
    };

    // Include task ledger summary for coordinator context
    try {
        response.ledgerSummary = ledgerSummary;
    } catch { /* ledger read is best-effort */ }

    // Token/cost usage rollup. OPT-IN (includeUsage) rather than default-on:
    // mesh_status is the highest-frequency coordinator poll and already fights
    // the MCP token cap, so a rollup nobody asked for would cost every caller
    // budget on every poll. Read-only and best-effort — a missing or corrupt
    // usage file must never fail a status call.
    if (args.includeUsage === true) {
        try {
            response.usage = summarizeMeshUsage(mesh.id);
        } catch { /* usage read is best-effort */ }
    }

    // M3-2: mission summaries — goal + live task aggregates (derived, not stored).
    // M7: each mission also carries time/attempt stats derived from the ledger.
    //
    // The missions section previously dominated the compact payload: every live
    // mission AND up to 10 history missions were emitted in full (goalPreview +
    // tasks + a per-mission stats rollup) on every poll, so a mesh with many
    // missions pushed mesh_status past the MCP token cap. Compact mode now folds
    // missions like it folds nodes/sessions:
    //   • live (active/paused) missions keep detail, goal-elided to a tight preview
    //     and WITHOUT the stats rollup (the tasks aggregate already carries
    //     progress; stats is a verbose/dashboard concern);
    //   • completed/abandoned history is folded to a counts + id summary
    //     (missionsHistory) instead of full per-mission detail;
    //   • a byte budget bounds the live array — overflow folds into foldedMissions
    //     (id list), so even a mesh of many active missions can't blow the cap.
    // verbose=true restores the full dashboard-grade missions (full goal text, the
    // stats rollup, and full-detail history) — the backward-compatible escape hatch.
    try {
        if (compact) {
            const { live, historyFold } = getMeshStatusMissionsCompact(mesh.id);
            // Bound the live-mission detail by byte budget, newest-active first.
            // Overflow folds into foldedMissions so every live id stays addressable.
            const ranked = [...live].sort((a, b) =>
                String((b as any).tasks?.lastActivityAt ?? '').localeCompare(String((a as any).tasks?.lastActivityAt ?? '')));
            const kept: any[] = [];
            const overflow: any[] = [];
            let spent = 0;
            for (const m of ranked) {
                const cost = JSON.stringify(m).length + 1;
                if (kept.length === 0 || spent + cost <= COMPACT_MISSIONS_BYTE_BUDGET) {
                    kept.push(m);
                    spent += cost;
                } else {
                    overflow.push(m);
                }
            }
            if (kept.length > 0) response.missions = kept;
            if (overflow.length > 0) {
                const byStatus: Record<string, number> = {};
                for (const m of overflow) byStatus[String(m.status)] = (byStatus[String(m.status)] ?? 0) + 1;
                response.foldedMissions = {
                    count: overflow.length,
                    note: 'Live-mission byte budget reached: these active/paused missions are listed by id only. Use mesh_mission_list or mesh_status verbose=true for their detail.',
                    byStatus,
                    missionIds: overflow.map(m => String(m.id)),
                };
            }
            if (historyFold) response.missionsHistory = historyFold;
        } else {
            const missions = getMeshStatusMissionSummaries(mesh.id, { verbose: true });
            if (missions.length > 0) {
                response.missions = missions.map(mission => {
                    try {
                        return { ...mission, stats: computeMeshMissionStats(mesh.id, mission.id) };
                    } catch {
                        return mission;
                    }
                });
            }
        }
    } catch { /* mission read is best-effort */ }

    try {
        const pendingEvents = await drainCoordinatorPendingEvents(ctx);
        const asyncRefineJobs = buildMeshAsyncRefineJobs({
            meshId: mesh.id,
            ledgerEntries,
            pendingEvents,
        });
        if (asyncRefineJobs.length > 0) {
            if (compact) {
                // Drop terminal (completed/failed) refine jobs — they are historical and
                // dominate the payload. Keep active (non-terminal) job objects so the
                // coordinator can still track in-flight refines, and replace the rest with
                // a status-count summary.
                //
                // Stale terminal jobs (resolved refinery rejections/successes from earlier
                // in the ledger window — often multi-day-old) are folded out of the counts
                // so byStatus.failed reflects *current* breakage, not historical residue.
                // The folded count is surfaced as `staleTerminal` for transparency.
                const summary = summarizeMeshAsyncRefineJobs(asyncRefineJobs);
                if (summary.activeJobs.length > 0) response.asyncRefineJobs = summary.activeJobs;
                response.asyncRefineJobsSummary = {
                    total: summary.total,
                    byStatus: summary.byStatus,
                    ...(summary.staleTerminal > 0 ? { staleTerminal: summary.staleTerminal } : {}),
                };
            } else {
                response.asyncRefineJobs = asyncRefineJobs;
            }
        }

        // deltaE: fold persisted MAGI cross-verification activity into mesh_status so a
        // coordinator (and the dashboard's extractMagiActivity) can read the synthesis
        // fields — needs_verification counts, independence banner, and git skew —
        // without re-running collection. Bounded like asyncRefineJobs: running groups
        // always shown, synthesized groups only when recent (stale ones folded to a count).
        const magiActivity = buildMeshMagiActivity({ meshId: mesh.id, ledgerEntries });
        if (magiActivity.length > 0) {
            const fold = summarizeMeshMagiActivity(magiActivity);
            if (compact) {
                if (fold.groups.length > 0) response.magiActivity = fold.groups;
                response.magiActivitySummary = {
                    total: fold.total,
                    byStatus: fold.byStatus,
                    ...(fold.staleSynthesized > 0 ? { staleSynthesized: fold.staleSynthesized } : {}),
                };
            } else {
                response.magiActivity = magiActivity;
            }
        }

        if (pendingEvents.length > 0) {
            response.pendingCoordinatorEvents = pendingEvents;
        }

        // T7 (B4 visibility): mesh protocol v2 adoption metrics, derived from the
        // events surfaced in THIS drain. T1 stamps every newly-emitted pending event
        // with a v2 envelope (protocolVersion '2.0' + scope), so the share of drained
        // events carrying protocolVersion is the observable adoption signal — a
        // rollout gate that does NOT depend on daemonBuilds alone. This is a snapshot
        // of the drained batch (not a durable counter): quarantine/violation counts
        // and the PHASE-4 synthesis backstop counter are NOT aggregated here — those
        // counters land with the enforce path (T6, in mesh-reconcile-loop.ts, which
        // T7 does not touch). Omitted when nothing was drained.
        const protocolMetrics = summarizePendingEventProtocolMetrics(pendingEvents);
        if (protocolMetrics) {
            response.meshProtocolMetrics = protocolMetrics;
        }

        // T6 (B3c): the live enforce/backstop counters the daemon rode on the drain
        // above (drainCoordinatorPendingEvents stashed them on ctx). Unlike
        // meshProtocolMetrics (a per-batch adoption snapshot), these are process-lifetime
        // enforce-health totals: quarantine tallies + the last-resort backstop fire
        // counts (target 0 under a healthy v2 contract). Omitted on version-skewed
        // daemons that don't ride the field.
        if (ctx.lastMeshProtocolV2Counters) {
            response.meshProtocolV2Counters = ctx.lastMeshProtocolV2Counters;
        }

        // Pending-event retention sweep counters (see MeshContext.lastPendingRetentionCounters).
        // undrainedExpired non-zero is the operational signal: events queued for a coordinator
        // that were deleted before ever being drained. Mirrored to event_held first, so this
        // is a "check mesh_requeue_held_events" flag, not a bare loss report.
        if (ctx.lastPendingRetentionCounters) {
            response.pendingRetentionCounters = ctx.lastPendingRetentionCounters;
        }
    } catch {
        // Non-fatal: pending events are best-effort.
    }

    // Serialized WITHOUT indentation, deliberately.
    //
    // Two reasons. (1) Cost: this payload is consumed by an LLM coordinator, so
    // every indent byte is a billed token. Measured on a 23-node mesh, 2-space
    // indent was ~29% of the string — pure waste, zero information.
    // (2) Correctness: the node byte-budget above costs nodes with
    // `JSON.stringify(n).length` (no indent). While this returned indented JSON,
    // the budget undercounted the real wire size by that same ~29%, so the code
    // believed it was inside the cap at the moment the actual payload had already
    // blown past it. Budget accounting and final serialization must use the SAME
    // format; keep them in sync if either changes.
    return JSON.stringify(response);
}

export async function meshListNodes(ctx: MeshContext): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const { mesh } = ctx;
    return JSON.stringify({
        meshId: mesh.id,
        meshName: mesh.name,
        nodes: mesh.nodes.map(n => ({
            nodeId: n.id,
            workspace: n.workspace,
            repoRoot: n.repoRoot,
            daemonId: readNodeDaemonId(n),
            machineId: readNodeMachineId(n),
            machine: buildNodeMachineIdentity(ctx, n),
            isLocalWorktree: n.isLocalWorktree,
            policy: n.policy,
            relatedRepos: readRelatedRepos(n),
            ...getNodeLaunchReadiness(n),
            ...buildNodeCapabilityExposure(n),
            userOverrides: n.userOverrides,
        })),
    }, null, 2);
}
