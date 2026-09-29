// mesh_status render sections. meshStatus (mesh-tools-status.ts) reads ONE coordinator
// view and renders it; each function here is one self-contained section of that
// render — per-node assembly, per-daemon folds, compact node bounding, missions and
// the drained-event sections — so the tool reads as the sequence of steps it is.

import {
    COMPACT_DETAILED_NODES_BYTE_BUDGET,
    COMPACT_MISSIONS_BYTE_BUDGET,
    COMPACT_NODES_TOTAL_BYTE_BUDGET,
    collectRelatedRepoStatuses,
} from './mesh-tools-internal.js';
import {
    annotateQuotaSnapshotFreshness,
    compactMagiActivityGroup,
    compactMeshStatusNode,
    compactNodeSeverity,
    isNoteworthyCompactNode,
    pinnedRepresentativeNodeIds,
    minimalCompactNode,
    summarizeNodeSessions,
} from './mesh-compact.js';
import {
    buildMeshAsyncRefineJobs,
    buildMeshMagiActivity,
    summarizeMeshMagiActivity,
    summarizeMeshAsyncRefineJobs,
} from '@adhdev/daemon-core';
import { buildNodeCapabilityExposure, getNodeLaunchReadiness } from './mesh-tools-internal-core.js';
import { buildNodeMachineIdentity, readNodeDaemonId, readNodeMachineId } from './mesh-node-identity.js';
import type { MeshContext } from './mesh-tools-internal.js';
import { DEFAULT_MESH_POLICY } from '@adhdev/daemon-core';
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { compactDaemonMachine, compactDaemonQuotaSnapshots, dedupeCompactNodeGitFields, dedupeProviderCapabilityTags } from './mesh-compact.js';
import { applyHeldNodeGitToEntry } from './mesh-status-held-git.js';
import { findHeldNodeStatus, resolveNodeRuntime, type parseCoordinatorHeldNodeState } from './mesh-held-node-state.js';
import {
    drainViewPendingEvents,
    readViewMissionsCompact,
    readViewMissionsVerbose,
    readViewRelatedRepoGit,
    type MeshStatusView,
} from './mesh-status-view.js';

type StatusNodeEntry = any;

/**
 * One live session, slimmed to the fields a coordinator reads. A session whose
 * coordinator registry names THIS mesh is the caller's own (isSelfCoordinator).
 */
function slimStatusSession(s: any, meshId: string): Record<string, unknown> {
    const mesh = { id: meshId };

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
        // Phase E launch provenance: which model / thinking level the
        // session runs and where the model came from (user pick, mesh
        // slot, task override, provider default, …).
        ...slimSessionLaunchFields(s),
    };
}

/**
 * Assemble one node's mesh_status entry from the view: identity, launch readiness,
 * capability exposure, coordinator-held git, related repos, and the node's runtime
 * (sessions / daemon build / upgrade marker) from the held push or own status.
 *
 * Dual-surface note (mesh-status-dual-surface): this coordinator-side node object
 * is assembled independently of the daemon-core finalize path
 * (commands/high-family/mesh-status.ts, which stamps its own node via
 * buildMeshNodeMachineIdentity). The two surfaces are INTENTIONALLY distinct:
 *   • machine identity — buildNodeMachineIdentity (mesh-node-identity.ts) emits
 *     the SAME output shape as daemon-core's buildMeshNodeMachineIdentity, so a
 *     field added to one must be added to the other. It cannot be collapsed into
 *     the daemon-core builder because the coordinator surface derives
 *     sameMachine/locality from richer control-plane evidence that needs the full
 *     MeshContext, which the daemon-core `opts`-scalar signature does not carry.
 *   • capability exposure — buildNodeCapabilityExposure already delegates its tag
 *     computation to daemon-core's buildMeshNodeCapabilityTags (the SAME function
 *     the queue/dispatch matcher uses); only the exposure wrapper is local.
 * When adding a node field on either surface, update the peer surface too.
 */
export async function buildStatusNodeEntry(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    inputs: {
        view: MeshStatusView;
        heldNodeState: ReturnType<typeof parseCoordinatorHeldNodeState>;
        runtimeAnswers: Parameters<typeof resolveNodeRuntime>[2];
    },
): Promise<StatusNodeEntry> {
    const { mesh } = ctx;
    const { view, heldNodeState, runtimeAnswers } = inputs;
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

    // COORDINATOR-HELD NODE GIT (owner principle 2026-09-26): this tool no longer
    // probes each node's git_status over P2P on the request path. Git, submodules,
    // quota facts and freshness come from the coordinator daemon's held node
    // state (ONE local `mesh_status` read above — member pushes + the daemon's
    // own background refresh), the same view the dashboard renders.
    const heldNode = findHeldNodeStatus(heldNodeState, node);
    applyHeldNodeGitToEntry(entry, {
        mesh,
        node,
        held: heldNode,
        heldStateError: heldNodeState.error,
    });

    // Related repos are not part of the coordinator-held state: a remote node's
    // related repo is listed without a live probe (mesh_git_status reads it live).
    const relatedRepos = await collectRelatedRepoStatuses(ctx, node, {
        localOnly: true,
        readGitStatus: (workspace) => readViewRelatedRepoGit(view, workspace),
    });
    if (relatedRepos.length) entry.relatedRepos = relatedRepos;

    // Sessions / daemon build / upgrade marker: a node served by ANOTHER daemon
    // answers ONLY from the coordinator-held runtime (member push, content-free;
    // `source: 'none'` = nothing held yet — never a live read of the member).
    // The coordinator's own nodes read its own status from the view.
    const runtime = resolveNodeRuntime(ctx, node, runtimeAnswers);
    const statusProbe = runtime.probe;
    entry.runtimeObservation = runtime.observation;
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
            .map((s: any) => slimStatusSession(s, mesh.id))
            // Exclude sessions with no resolvable id (malformed or custom provider response).
            .filter((s: any) => s.id);
    }

    return entry;
}

/** Top-level coordinator-session identity: the caller's own sessions in this mesh. */
export function collectCoordinatorSessions(results: StatusNodeEntry[]): Array<Record<string, unknown>> {
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
    return coordinatorSessions;
}

/**
 * Per-daemon folds (sessions / build / machine / quota / failed upgrade): every node
 * sharing a daemonId reports the same daemon-wide values, so each is recorded ONCE per
 * daemonId at the top level instead of N× per node.
 */
export function foldPerDaemonFields(results: StatusNodeEntry[], opts: { compact: boolean; includeSessions: boolean }): {
    daemonSessions: Record<string, unknown>;
    daemonBuilds: Record<string, unknown>;
    daemonMachines: Record<string, unknown>;
    daemonQuotas: Record<string, unknown>;
    daemonUpgradeFailures: Record<string, unknown>;
} {
    const { compact, includeSessions } = opts;
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
    // identityEvidence is debug provenance: verbose only.
    if (entry?.machine && !(daemonId in daemonMachines)) daemonMachines[daemonId] = compact ? compactDaemonMachine(entry.machine) : entry.machine;
    // Pure-additive freshness annotation: the raw snapshot keeps every field
    // (updatedAt included) and gains computed ageMs/stale so a coordinator
    // never has to subtract epoch ms itself — it doesn't, and a stale
    // boot-refresh snapshot then reads as the current value. `stale` uses
    // the routing gate's own threshold (see mesh-compact.ts).
    // Compact keeps only what the per-node quota string lacks (reset times,
    // error text, metadata, buckets — compactDaemonQuotaSnapshots); the raw
    // snapshots + freshness annotation are verbose.
    if (entry?.quota && !(daemonId in daemonQuotas)) {
        const grouped = compact ? compactDaemonQuotaSnapshots(entry.quota) : annotateQuotaSnapshotFreshness(entry.quota);
        if (grouped) daemonQuotas[daemonId] = grouped;
    }
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
    return { daemonSessions, daemonBuilds, daemonMachines, daemonQuotas, daemonUpgradeFailures };
}

/** Live daemons built from a commit behind their workspace HEAD, split daemon-affecting vs web-only. */
export function collectStaleDaemonBuilds(results: StatusNodeEntry[], compact: boolean): {
    staleDaemonBuilds: Array<Record<string, unknown>>;
    daemonAffectingStaleBuilds: Array<Record<string, unknown>>;
    webOnlyStaleBuilds: Array<Record<string, unknown>>;
} {
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
    return { staleDaemonBuilds, daemonAffectingStaleBuilds, webOnlyStaleBuilds };
}

export function computeProviderVersionSkew(results: StatusNodeEntry[]): Array<Record<string, unknown>> {
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
    return providerVersionSkew;
}

/**
 * Compact node bounding: fold per-node sessions/build/machine/upgrade copies (they live
 * per-daemon at the top level), then award full detail and minimal stubs by severity
 * under the two byte budgets. Every node id stays addressable — in the array (detail or
 * stub) or in the returned foldedNodesSummary id list.
 */
export function compactStatusNodes(results: StatusNodeEntry[], includeSessions: boolean): {
    nodes: any[];
    stubbedNodeCount: number;
    foldedNodesSummary: Record<string, unknown> | undefined;
} {
    let stubbedNodeCount = 0;
    let foldedNodesSummary: Record<string, unknown> | undefined;
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
            // Final compact de-dup (after ranking/budgeting, which read the
            // duplicated fields): keep one copy of each git scalar and drop
            // provider tags that repeat providerPriority (mesh-compact.ts).
            if (detailedIds.has(id)) {
                dedupeCompactNodeGitFields(n);
                dedupeProviderCapabilityTags(n);
                return n;
            }
            if (keptIds.has(id)) {
                stubbedNodeCount += 1;
                const stub = minimalCompactNode(n);
                dedupeCompactNodeGitFields(stub);
                dedupeProviderCapabilityTags(stub);
                return stub;
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
            // mesh_status itself has no node_id / node-filter parameter (the old
            // wording pointed at a param that does not exist on this tool). The
            // actual ways to narrow: mesh_list_nodes for a lightweight roster, or
            // mesh_git_status(node_id) for one node's git/branch detail; verbose=true
            // widens THIS call's byte budget for full per-node status instead.
            note: 'Node-array byte budget reached: these nodes are listed by id only. Use mesh_list_nodes for a lightweight roster, mesh_git_status(node_id) for one node\'s git/branch detail, or call mesh_status again with verbose=true for full detail.',
            byHealth,
            byBranchConvergence,
            nodeIds,
        };
    }
    return { nodes: out, stubbedNodeCount, foldedNodesSummary };
}

/** The mesh policy as mesh_status reports it (compact: only keys that differ from the defaults). */
export function statusPolicyForResponse(meshPolicy: unknown, compact: boolean): Record<string, unknown> {
    const mesh = { policy: meshPolicy };
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
// Compact: only the policy keys that differ from the defaults (DEFAULT_MESH_POLICY)
// — the rest is the same static block on every poll. Verbose: the full policy.
const policyOverrides: Record<string, unknown> = {};
for (const [key, value] of Object.entries(policyForResponse)) {
    if (JSON.stringify(value) !== JSON.stringify((DEFAULT_MESH_POLICY as unknown as Record<string, unknown>)[key])) policyOverrides[key] = value;
}
    return compact ? policyOverrides : policyForResponse;
}

/** Missions section (compact: byte-bounded live detail + history fold; verbose: full rows + stats). */
export function applyStatusMissions(response: Record<string, unknown>, view: MeshStatusView, compact: boolean): void {
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
        // Computed in the daemon (mission_list_query meshStatusView) — this
        // process no longer opens the daemon's store to re-read the whole queue
        // once per live mission.
        const { live, historyFold } = readViewMissionsCompact(view);
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
        // Rows from the daemon's projection; every stats rollup from ONE batched
        // task_stats_query (was one IPC round trip — and one full queue + record
        // pass in the daemon — per mission).
        const missions = readViewMissionsVerbose(view);
        if (missions.length > 0) response.missions = missions;
    }
} catch { /* mission read is best-effort */ }
}

/** Sections derived from this call's pending-event drain: refine jobs, MAGI activity, events, protocol metrics. */
export function applyStatusDrainSections(
    response: Record<string, unknown>,
    ctx: MeshContext,
    view: MeshStatusView,
    ledgerEntries: any[],
    compact: boolean,
): void {
    const { mesh } = ctx;
try {
    const pendingEvents = drainViewPendingEvents(ctx, view);
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
            if (fold.groups.length > 0) response.magiActivity = fold.groups.map(compactMagiActivityGroup);
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

    // The inbox read above reported that another writer's notices have not
    // replicated here yet: the pending list may be incomplete (C-W3).
    if (ctx.lastNoticeReplication === 'pending') {
        response.replication = 'pending';
    }
} catch {
    // Non-fatal: pending events are best-effort.
}
}

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

/**
 * Phase E: the launch fields `mesh_status` reports per session. The daemon's
 * status builders already derive `model` / `modelSource` / `thinkingLevel` from
 * the session's launch record, so this only type-checks and copies them (an
 * older daemon simply omits them). The full record stays out of the coordinator
 * context — it is P2P / dashboard material.
 */
export function slimSessionLaunchFields(session: unknown): { model?: string; modelSource?: string; thinkingLevel?: string } {
    if (!session || typeof session !== 'object') return {};
    const s = session as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const model = text(s.model);
    const modelSource = text(s.modelSource);
    const thinkingLevel = text(s.thinkingLevel);
    return {
        ...(model ? { model } : {}),
        ...(modelSource ? { modelSource } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
    };
}
