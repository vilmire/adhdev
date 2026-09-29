// Mesh tool implementations — status domain.
// Pure move out of mesh-tools.ts (no behavior change). Helpers are imported from the
// modules that define them; mesh-tools.ts is the tool barrel.

import {
    buildActiveWorkPollingGuidance,
    buildMeshCoordinatorToolCallArgs,
    buildPendingMeshEventsDrainArgs,
    refreshMeshFromDaemon,
    applyMeshMembership,
} from './mesh-tools-internal.js';
import { COMPACT_MAX_ACTIVE_WORK_ROWS, compactActiveWorkRecords } from './mesh-queue-helpers.js';
import { buildCompactStaleDirectWorkSummary, summarizeMeshUsage } from '@adhdev/daemon-core';
import {
    buildNodeCapabilityExposure,
    getNodeLaunchReadiness,
    readRelatedRepos,
    summarizeBranchConvergence,
} from './mesh-tools-internal-core.js';
import { buildNodeMachineIdentity, readNodeDaemonId, readNodeMachineId } from './mesh-node-identity.js';
import { latestActiveLaunchFailureFromEntries } from './mesh-launch-failure.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';
// MESH-IMAGE-DISPATCH: view-surface projection — not (yet) re-exported through
// mesh-tools-internal.ts, imported directly from the package like the other
// daemon-core symbols mesh-tools-internal.ts itself imports.
import type { MeshLedgerSummary as MeshLedgerSummaryView, MeshSchedulingRuntime, SessionRecoveryContext } from '@adhdev/daemon-core';
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { buildNodeGitStateSummary } from './mesh-status-held-git.js';
import { localStatusProbe, parseCoordinatorHeldNodeState } from './mesh-held-node-state.js';
import { ensureMeshNodeRoutes } from './mesh-node-routes.js';
import {
    applyMeshStatusViewRoutes,
    readMeshStatusView,
    readViewActiveWork,
    readViewRecovery,
    readViewToolCall,
    sealMeshStatusViewTransport,
    type MeshStatusView,
} from './mesh-status-view.js';
import {
    applyStatusDrainSections,
    applyStatusMissions,
    buildStatusNodeEntry,
    collectCoordinatorSessions,
    collectStaleDaemonBuilds,
    compactStatusNodes,
    computeProviderVersionSkew,
    foldPerDaemonFields,
    statusPolicyForResponse,
} from './mesh-status-sections.js';

/**
 * graph-orchestration-simplification D6 — `graphUsage` is COMPUTED IN THE DAEMON
 * (graphsLast7d, nodesPerGraphP50, gatesExpired, gatesAutoAbandoned,
 * depsChainedViaEnqueueTask); this surface only passes the first block it finds
 * through, verbatim. Sources are tried in the caller's order — mesh_status passes
 * `activeWork.summary` first (where daemon-core's active_work_query folds it: both
 * are JSON-passthrough records, the wire slots a daemon can extend without a
 * turn-ipc schema change), then the record summary, the response itself and the
 * refreshed mesh snapshot. Anything
 * that is not a plain object is ignored — never synthesized, never defaulted.
 */
export function pickDaemonGraphUsage(...sources: unknown[]): Record<string, unknown> | undefined {
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        const block = (source as { graphUsage?: unknown }).graphUsage;
        if (block && typeof block === 'object' && !Array.isArray(block)) return block as Record<string, unknown>;
    }
    return undefined;
}

/** Shallow copy of a summary record without its `graphUsage` key (same object when absent). */
function withoutGraphUsage<T>(summary: T): T {
    if (!summary || typeof summary !== 'object' || !('graphUsage' in (summary as object))) return summary;
    const { graphUsage: _hoisted, ...rest } = summary as unknown as Record<string, unknown>;
    return rest as unknown as T;
}

// ─── Tool Implementations ───────────────────────

export async function meshStatus(outerCtx: MeshContext, args: { includeStaleDirectWorkDetails?: boolean; includeTerminalDirectWork?: boolean; includeSessions?: boolean; includeUsage?: boolean; compact?: boolean; verbose?: boolean; refresh?: boolean } = {}): Promise<string> {
    // Default to the slim payload for LLM callers; verbose forces the full payload.
    const compact = args.verbose === true ? false : (args.compact ?? true);

    // ONE daemon call (mesh-status-view.ts): the coordinator composes every input
    // this tool reads — its held mesh_status (the dashboard's view: git,
    // submodules, gitObservation, remote nodes' pushed runtime), membership, its
    // own status, recovery contexts, active work, missions, this caller's
    // pending-event drain and the polling-rate record. Everything below renders.
    // `refresh` only asks the coordinator to nudge members to push (never a read).
    let view: MeshStatusView;
    try {
        view = await readMeshStatusView(outerCtx, {
            refresh: args.refresh === true,
            compact,
            includeTerminalDirect: args.includeTerminalDirectWork === true,
            pendingEvents: buildPendingMeshEventsDrainArgs(outerCtx),
            toolCall: buildMeshCoordinatorToolCallArgs(outerCtx, 'mesh_status'),
        });
    } catch (error: any) {
        return JSON.stringify({
            success: false,
            code: 'mesh_coordinator_unavailable',
            meshId: outerCtx.mesh.id,
            error: `The coordinator daemon could not answer mesh_status: ${error?.message || error}`,
        });
    }
    // Everything below renders the view. The renderer's context carries a sealed
    // transport: a read the view does not carry throws instead of reaching a daemon
    // (no member is ever read).
    const ctx: MeshContext = { ...outerCtx, transport: sealMeshStatusViewTransport(outerCtx.transport) } as MeshContext;
    const rateResult = readViewToolCall(view);

    // Membership, then every node's locality, its held state and the coordinator's
    // own status — all straight from the view. The routes are held for the node set
    // before AND after the membership merge, so no step re-asks for them.
    applyMeshStatusViewRoutes(ctx, view);
    await applyMeshMembership(ctx, view.membership);
    applyMeshStatusViewRoutes(ctx, view);
    const { mesh } = ctx;

    const heldNodeState = parseCoordinatorHeldNodeState(view.status);
    const recoveryByNode = readViewRecovery(view, mesh.nodes.map(n => n.id));
    const runtimeAnswers = { local: localStatusProbe(view.localStatus), held: heldNodeState };

    // Assemble all nodes in parallel — held git (above) + session collection per node.
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
    const results = await Promise.all(mesh.nodes.map((node) => buildStatusNodeEntry(ctx, node, { view, heldNodeState, runtimeAnswers })));

    // C-W9a: active work is computed in the daemon over its queue, open direct
    // dispatches and records (+ turn outcomes); the inputs come back only for the
    // transcript-reconcile pass below. buildMeshActiveWork never reads `task.input`
    // (MESH-IMAGE-DISPATCH), and no queue row reaches this response from here.
    const activeWorkView = readViewActiveWork(view);
    const ledgerSummary = activeWorkView.summary as unknown as MeshLedgerSummaryView;
    // Scheduling-runtime projection (load-balancer's live view): tie-break strategy,
    // global parallel caps + consumption, and per-node load / priority / provider caps
    // with structured "why this node can't take more write work" reasons. Derived in
    // the daemon from the mesh config + its queue (read-only) — never drives a
    // scheduling decision, only exposes the picture the claim path acts on.
    const schedulingRuntime = (activeWorkView.schedulingRuntime ?? { nodes: [] }) as unknown as MeshSchedulingRuntime;
    const schedulingByNode = new Map((schedulingRuntime.nodes ?? []).map(n => [n.nodeId, n]));
    // The same record tail (200) the launch-failure check used to re-read with its
    // own ledger_query — one window, shared.
    const recordTail = activeWorkView.records;
    for (const entry of results as any[]) {
        const node = mesh.nodes.find(n => n.id === entry.nodeId);
        if (!node) continue;
        applyNodeSchedulingAndHints(entry, node, {
            compact,
            nodeScheduling: schedulingByNode.get(node.id),
            recoveryContext: (recoveryByNode.get(node.id) ?? { consecutiveNodeFailures: 0 }) as unknown as SessionRecoveryContext,
            activeLaunchFailure: latestActiveLaunchFailureFromEntries(recordTail, node.id),
        });
    }
    const activeWorkEvidence = activeWorkView.activeWork!;
    // The record tail the refine-job and MAGI folds below read (the same window as before).
    const ledgerEntries = activeWorkView.records;

    const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);
    // D6 graphUsage: daemon-computed (active_work_query folds it into
    // activeWork.summary), passed through untouched — verbose only, as its own
    // top-level block. Hoisted OUT of activeWorkSummary in both modes so the
    // compact poll does not carry it and verbose does not carry it twice.
    const graphUsage = pickDaemonGraphUsage(activeWorkEvidence.summary, activeWorkView.summary, activeWorkView, ctx.mesh);
    const activeWorkSummaryForResponse = withoutGraphUsage(activeWorkEvidence.summary);
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
    const coordinatorSessions = collectCoordinatorSessions(results);

    const includeSessions = args.includeSessions === true;
    const { daemonSessions, daemonBuilds, daemonMachines, daemonQuotas, daemonUpgradeFailures } = foldPerDaemonFields(results, { compact, includeSessions });
    const { staleDaemonBuilds, daemonAffectingStaleBuilds, webOnlyStaleBuilds } = collectStaleDaemonBuilds(results, compact);
    const providerVersionSkew = computeProviderVersionSkew(results);
    const compacted = compact ? compactStatusNodes(results, includeSessions) : null;
    const nodesForResponse = compacted ? compacted.nodes : results;
    const stubbedNodeCount = compacted?.stubbedNodeCount ?? 0;
    const foldedNodesSummary = compacted?.foldedNodesSummary;

    const response: Record<string, unknown> = {
        meshId: mesh.id,
        meshName: mesh.name,
        repoIdentity: mesh.repoIdentity,
        policy: statusPolicyForResponse(mesh.policy, compact),
        // Mesh-level scheduling rollup (strategy only — the global cap numbers are
        // deliberately not surfaced here, see the comment above). Per-node detail
        // (load/priority/provider caps/claim-block reasons) lives on each
        // nodes[].scheduling; the node array is dropped here to avoid duplicating it.
        scheduling: {
            strategy: schedulingRuntime.strategy,
        },
        payloadMode: compact ? 'compact' : 'full',
        refreshedAt: new Date().toISOString(),
        // Static provenance prose: verbose only.
        ...(compact ? {} : { sourceOfTruth: {
            membership: 'coordinator_daemon_live_mesh',
            // Git truth is the coordinator daemon's held node state (member pushes +
            // background refresh; per-node gitObservation says how old). Sessions are
            // still a per-daemon get_status_metadata probe (5 s cache).
            currentStatus: 'coordinator_held_git_and_live_session_probes',
            activeWork: 'mesh_queue_file_and_local_ledger',
            historicalEvidenceOnly: ['recoveryHints', 'ledgerSummary'],
        } }),
        ...buildNodeGitStateSummary(results, heldNodeState.error, args.refresh === true),
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
        ...(compact && activeWorkForResponse.omitted > 0
            ? { activeWorkHint: `Compact activeWork rows carry a short taskTitle + dispatch scalars only; full task prompt/summary text is omitted — use mesh_task_history or mesh_status verbose=true. First ${COMPACT_MAX_ACTIVE_WORK_ROWS} rows serialized.` }
            : {}),
        staleDirectWorkSummary,
        ...(args.includeStaleDirectWorkDetails === true ? { staleDirectWork: activeWorkEvidence.staleDirectWork } : {}),
        // terminalDirectWork is historical (completed/failed direct dispatches) — opt-in only.
        ...(args.includeTerminalDirectWork === true ? { terminalDirectWork: activeWorkEvidence.terminalDirectWork } : {}),
        activeWorkSummary: activeWorkSummaryForResponse,
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

    if (!compact && graphUsage) response.graphUsage = graphUsage;

    // Include task ledger summary for coordinator context
    try {
        response.ledgerSummary = withoutGraphUsage(ledgerSummary);
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
    applyStatusMissions(response, view, compact);

    applyStatusDrainSections(response, ctx, view, ledgerEntries, compact);

    // The drain's bookkeeping lands on the caller's context.
    outerCtx.noticeDrainCount = ctx.noticeDrainCount;
    outerCtx.lastNoticeReplication = ctx.lastNoticeReplication;

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

/**
 * Per-node fields that depend on the daemon's active-work read (scheduling
 * slice, last quota ranking) and on the record tail / recovery contexts
 * (launch-failure degradation, recovery hints, next-step hints). Applied after
 * the node assembly so ONE active_work_query serves all of them.
 */
export function applyNodeSchedulingAndHints(entry: any, node: LocalMeshNodeEntry, opts: {
    compact: boolean;
    nodeScheduling?: Record<string, any>;
    recoveryContext: SessionRecoveryContext;
    activeLaunchFailure: Record<string, unknown> | null;
}): void {
    // Per-node scheduling runtime (load, priority, provider caps, claim-block reasons).
    // Full detail is a dashboard/verbose concern; in compact mode it repeats per node
    // and would inflate the LLM payload past its byte budget, so compact keeps only the
    // two scalars a coordinator needs to reason about load (current load + cap-reached).
    //
    // OBSERVABILITY (quota-ranking): `lastQuotaRanking` is the mesh's last
    // quota-ranking decision for this node, overwritten on every claim (winner,
    // fitness rationale, adopted/claimed/refused outcome — see mesh-quota-routing.ts
    // LastQuotaRankingRecord). It is recorded by the DAEMON's claim path, so it comes
    // from the daemon's scheduling runtime; this process's own map was always empty
    // (the field never appeared before 2026-09-27). Present in both modes.
    if (opts.nodeScheduling) {
        const { nodeId: _omit, lastQuotaRanking, ...rest } = opts.nodeScheduling;
        entry.scheduling = opts.compact
            ? { load: rest.load, capReached: rest.capReached, ...(lastQuotaRanking ? { lastQuotaRanking } : {}) }
            : { ...rest, ...(lastQuotaRanking ? { lastQuotaRanking } : {}) };
    }

    const recoveryContext = opts.recoveryContext;
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

    const activeLaunchFailure = opts.activeLaunchFailure;
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
}

export async function meshListNodes(ctx: MeshContext): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    // Every node's locality is the coordinator's answer, carried in the view.
    await ensureMeshNodeRoutes(ctx, { force: true });
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
