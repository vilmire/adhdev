/**
 * mesh_status compact-mode per-node fold helpers.
 *
 * Physically split out of mesh-tools.ts (RF-SURVEY candidate C1) with no behavior
 * change. Slims the LLM-facing node copy: compact git snapshot, the canonical
 * preserved-marker list, the full per-node compaction (compactMeshStatusNode), the
 * quiet-node minimal stub (minimalCompactNode), node severity / noteworthiness
 * ranking, and the per-node session summary. Imports only the shared large-value
 * elider; the mesh_status node-array byte-budget bounding stays in mesh-tools.ts and
 * imports these back, so there is no runtime import cycle.
 */
import { elideLargeNestedValue } from './mesh-tool-shared.js';

// Compact-mode git snapshot for LLM callers: keep the coordinator-relevant scalar
// signals (branch/upstream/ahead/behind/dirty/headCommit) and the submodules array
// (its out-of-sync state drives convergence decisions) while dropping the large
// duplicated blobs (full changed-file lists, diffs, raw porcelain) that the full
// dashboard payload carries. The full status object remains available via verbose.
function buildCompactGitSnapshot(status: any): Record<string, unknown> | undefined {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined;
    const slim: Record<string, unknown> = {};
    const carry = [
        'isGitRepo',
        'branch',
        'headCommit',
        'upstream',
        'upstreamStatus',
        'ahead',
        'behind',
        'dirty',
        'detached',
        'submodules',
    ];
    for (const key of carry) {
        if (status[key] !== undefined) slim[key] = status[key];
    }
    return slim;
}

// Compact-mode submodules fold: the full submodules array (path/commit/status/
// branch per submodule) is repeated on every node that shares a superproject, so
// it grows O(nodes × submodules). In compact mode we keep the actionable signal
// (count + the out-of-sync paths, which drive convergence decisions) and drop the
// per-submodule commit/status blobs. The full array stays in verbose. Out-of-sync
// paths are also surfaced separately on the node as `outOfSyncSubmodules`.
function summarizeCompactSubmodules(submodules: any): Record<string, unknown> | undefined {
    if (!Array.isArray(submodules) || submodules.length === 0) return undefined;
    const outOfSync = submodules.filter((s: any) => s?.outOfSync).map((s: any) => s?.path).filter(Boolean);
    return {
        count: submodules.length,
        ...(outOfSync.length > 0 ? { outOfSyncPaths: outOfSync } : {}),
    };
}

// Canonical set of small per-node MARKER fields that MUST survive compact folding
// intact on every node — quiet stub or detailed. Both fold paths reference this one
// list: (a) the generic elide backstop skips these so they aren't truncated, and
// (b) the minimal-stub reconstruction (minimalCompactNode) re-attaches them. Keeping
// it single-sourced is the fix for the class of bug the rc.371 dataFreshness
// regression exposed — a canonical node marker that survived the elide skip-list but
// was silently dropped by the allowlist-based minimal stub, so it read null on
// exactly the quiet nodes a coordinator most needs the marker for. Add a new marker
// field HERE once and both fold paths preserve it; never hand-list it in two places.
const MESH_COMPACT_PRESERVED_MARKER_FIELDS = ['dataFreshness', 'quota', 'isLocalWorktree'] as const;

/**
 * Fold a node's reported quota bundle into a terse per-provider marker.
 *
 * This fold is the coordinator-facing observation view; routing itself
 * (daemon-core mesh-quota-routing.ts) consumes the raw bundle on the daemon
 * side, so this summary must stay a faithful projection of it — a coordinator
 * comparing what it sees here against where work actually lands is debugging
 * through exactly this string.
 *
 * Compact shape is one short string per provider ("38%/12%" = session/weekly,
 * or a bare status word when the node could not read one) because the raw
 * bundle is ~4 nested objects per provider and would cost more bytes on every
 * node than the whole rest of the compact entry. A provider that FAILED still
 * appears, carrying its failureKind: "this node looked and could not tell" is a
 * different diagnosis from "this node never reported", and collapsing the two
 * into an absent key would destroy exactly the distinction worth having.
 */
export function summarizeNodeQuota(quota: any): Record<string, string> | undefined {
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return undefined;
    const out: Record<string, string> = {};
    for (const [provider, snapshot] of Object.entries(quota as Record<string, any>)) {
        if (!snapshot || typeof snapshot !== 'object') continue;
        const status = typeof snapshot.status === 'string' ? snapshot.status : 'unknown';
        if (status !== 'ok') {
            const kind = typeof snapshot.metadata?.failureKind === 'string' ? snapshot.metadata.failureKind : undefined;
            out[provider] = kind ? `${status}:${kind}` : status;
            continue;
        }
        const pct = (w: any): string => (w && Number.isFinite(w.usedPercent) ? `${Math.round(w.usedPercent)}%` : '—');
        out[provider] = `${pct(snapshot.session)}/${pct(snapshot.weekly)}`;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// Compact-mode per-node fold for mesh_status. The dashboard/verbose payload
// (`results`) is untouched; this only slims the LLM-facing node copy. It folds
// the repetitive heavy fields that scale O(nodes):
//   - git: slim scalar snapshot + summarized submodules (no full file lists/blobs)
//   - machine: drop the verbose identityEvidence[] array and the long
//     localityReason string (which interpolates every evidence token) — keep the
//     resolved scalars (displayName/daemonId/machineId/hostname/sameMachine/locality)
//   - staleDaemonBuild: the full ~300-char warning + duplicated build fields are
//     already aggregated ONCE at the top level under staleDaemonBuilds[] +
//     staleDaemonBuildWarning. On the node, collapse to a short boolean-ish flag so
//     the per-node copy isn't N× the same warning text.
//   - branchConvergence: keep the decision fields (status/needsConvergence/reason/
//     branch/ahead/behind); drop the long per-node nextStep prose (it is echoed in
//     nextStepHints and branchConvergenceSummary).
// Any remaining oversized nested blob is elided by the generic byte guard.
export function compactMeshStatusNode(entry: any): any {
    if (!entry || typeof entry !== 'object') return entry;
    const next: any = { ...entry };

    if (next.git !== undefined) {
        const slimGit = buildCompactGitSnapshot(next.git);
        if (slimGit) {
            if (slimGit.submodules !== undefined) {
                const subSummary = summarizeCompactSubmodules(slimGit.submodules);
                if (subSummary) slimGit.submodules = subSummary;
                else delete slimGit.submodules;
            }
            next.git = slimGit;
        }
    }

    if (next.machine && typeof next.machine === 'object') {
        const m = next.machine as Record<string, unknown>;
        next.machine = {
            daemonId: m.daemonId,
            machineId: m.machineId,
            hostname: m.hostname,
            displayName: m.displayName,
            sameMachine: m.sameMachine,
            locality: m.locality,
        };
    }

    // submoduleWarning is a fixed ~120-char prose string repeated on every node
    // with an out-of-sync submodule. The actionable signal (which submodules) is
    // already on `outOfSyncSubmodules`; collapse the prose to a boolean flag in
    // compact mode.
    if (typeof next.submoduleWarning === 'string') {
        next.submodulesOutOfSync = true;
        delete next.submoduleWarning;
    }

    if (next.staleDaemonBuild && typeof next.staleDaemonBuild === 'object') {
        const b = next.staleDaemonBuild as Record<string, unknown>;
        // Replace the full per-node object (warning prose + build fields, all of
        // which are aggregated top-level) with a terse flag. The daemonId lets the
        // coordinator cross-reference the top-level staleDaemonBuilds[] entry.
        next.staleDaemonBuild = {
            scope: b.scope,
            isDaemonAffecting: b.isDaemonAffecting !== false,
            seeStaleDaemonBuilds: true,
        };
    }

    // Quota folds to one short string per provider; the full bundle stays in verbose.
    if (next.quota !== undefined) {
        const summary = summarizeNodeQuota(next.quota);
        if (summary) next.quota = summary;
        else delete next.quota;
    }

    // branchConvergence is kept intact for detailed compact nodes (it carries the
    // actionable per-node nextStep). It is small per-node and bounded by the
    // detail byte-budget; the larger repetition lives in branchConvergenceSummary,
    // which is capped separately. Quiet nodes drop nextStep via minimalCompactNode.

    // capabilityTagsByProvider repeats the os=/arch=/converge= base set once per
    // provider — heavy and O(nodes × providers). The representative capabilityTags
    // (kept) already conveys what a node can match; the per-provider breakdown is a
    // verbose/dashboard concern. Drop it from the compact LLM-facing copy.
    delete next.capabilityTagsByProvider;

    // Generic backstop: elide any other oversized nested blob on the node. The
    // structural blobs slimmed above plus the canonical preserved markers are skipped
    // so the byte guard never truncates them.
    const elideSkip = new Set<string>(['git', 'machine', 'branchConvergence', 'staleDaemonBuild', 'sessions', ...MESH_COMPACT_PRESERVED_MARKER_FIELDS]);
    for (const k of Object.keys(next)) {
        if (elideSkip.has(k)) continue;
        next[k] = elideLargeNestedValue(k, next[k]);
    }

    return next;
}

// Rough severity ranking so that when the byte budget forces a downgrade, the most
// urgent nodes (errors/degraded/blocked launches) are the ones kept in detail.
export function compactNodeSeverity(entry: any): number {
    if (!entry || typeof entry !== 'object') return 0;
    if (entry.error || (entry.health && entry.health !== 'online' && entry.health !== 'dirty')) return 5;
    if (entry.launchReady === false) return 4;
    if (entry.isDirty === true || entry.health === 'dirty') return 3;
    if (entry.branchConvergence?.needsConvergence === true) return 2;
    if (entry.staleDaemonBuild || entry.submodulesOutOfSync || entry.recoveryHints) return 1;
    return 0;
}

// Per-daemon representative pin.
//
// The byte-budget fold ranks by severity, so a QUIET node folds first. That is the
// right instinct for worktrees and exactly wrong for machine nodes: a healthy,
// idle, nothing-to-converge machine is precisely the node a deploy/restart roster
// must enumerate, and severity ranking pushed it out of `nodes[]` first — the whole
// machine silently vanished from the roster (it remained only as a bare id under
// foldedNodes.nodeIds, which carries no daemonId, so it could not even be mapped
// back to its daemon).
//
// So before severity is consulted, pin ONE representative node per daemonId: the
// non-worktree (machine/repo-root) node when the daemon has one, else the daemon's
// first node so a worktree-only daemon is still represented. Pinned nodes are
// awarded detail first; everything else — worktrees included — competes for what
// remains and folds first. Every daemon therefore keeps at least one full-detail
// node no matter how noisy the worktrees on it are.
export function pinnedRepresentativeNodeIds(compacted: any[]): Set<string> {
    const byDaemon = new Map<string, any>();
    for (const n of compacted) {
        if (!n || typeof n !== 'object') continue;
        const daemonId = typeof n.daemonId === 'string' && n.daemonId ? n.daemonId : '';
        if (!daemonId) continue;
        const current = byDaemon.get(daemonId);
        if (!current) {
            byDaemon.set(daemonId, n);
            continue;
        }
        // A machine node always outranks a worktree as the daemon's representative.
        if (current.isLocalWorktree === true && n.isLocalWorktree !== true) {
            byDaemon.set(daemonId, n);
        }
    }
    const pinned = new Set<string>();
    for (const n of byDaemon.values()) {
        if (n?.nodeId !== undefined) pinned.add(String(n.nodeId));
    }
    return pinned;
}

export function isNoteworthyCompactNode(entry: any): boolean {
    if (!entry || typeof entry !== 'object') return true;
    if (entry.health && entry.health !== 'online') return true;
    if (entry.isDirty === true) return true;
    if (entry.error) return true;
    if (entry.launchReady === false) return true;
    if (entry.staleDaemonBuild) return true;
    if (entry.submoduleWarning || entry.submodulesOutOfSync) return true;
    if (entry.recoveryHints) return true;
    if (Array.isArray(entry.nextStepHints) && entry.nextStepHints.length > 0) return true;
    if (entry.branchConvergence?.needsConvergence === true) return true;
    const sessionCount = Array.isArray(entry.sessions)
        ? entry.sessions.length
        : (entry.sessionSummary?.total ?? 0);
    if (sessionCount > 0) return true;
    return false;
}

// Minimal per-node stub for quiet nodes / byte-budget overflow. Keeps the fields a
// coordinator needs to find and reason about a node (id/workspace/health/branch/
// launchReady) plus the branchConvergence decision scalars, marked `folded` so
// callers know the full compact detail is available via verbose.
export function minimalCompactNode(entry: any): any {
    if (!entry || typeof entry !== 'object') return entry;
    const bc = entry.branchConvergence && typeof entry.branchConvergence === 'object'
        ? {
            status: entry.branchConvergence.status,
            needsConvergence: entry.branchConvergence.needsConvergence,
            reason: entry.branchConvergence.reason,
            branch: entry.branchConvergence.branch,
        }
        : undefined;
    // Canonical per-node marker fields (e.g. dataFreshness) are exactly the signal a
    // coordinator needs on a QUIET node — is this idle peer live, cached, or
    // unreachable? — and they are tiny, so re-attach them from the single canonical
    // list rather than hand-listing each one (the path the dataFreshness regression
    // slipped through when only one field was added by hand).
    const preservedMarkers: Record<string, unknown> = {};
    for (const field of MESH_COMPACT_PRESERVED_MARKER_FIELDS) {
        if (entry[field] !== undefined) preservedMarkers[field] = entry[field];
    }
    return {
        nodeId: entry.nodeId,
        workspace: entry.workspace,
        daemonId: entry.daemonId,
        health: entry.health,
        branch: entry.branch,
        launchReady: entry.launchReady,
        ...(entry.providerPriority !== undefined ? { providerPriority: entry.providerPriority } : {}),
        // Keep the routable tag set on quiet/folded nodes — a coordinator planning
        // required_tags routing needs it even for nodes with nothing to converge.
        ...(entry.capabilityTags !== undefined ? { capabilityTags: entry.capabilityTags } : {}),
        ...(entry.launchBlockedReason !== undefined ? { launchBlockedReason: entry.launchBlockedReason } : {}),
        ...(bc ? { branchConvergence: bc } : {}),
        ...(entry.sessionSummary ? { sessionSummary: entry.sessionSummary } : {}),
        ...preservedMarkers,
        folded: true,
    };
}

// Fold a node's slim session list into status/provider counts. Compact mode
// returns this instead of the full per-session array so the payload does not
// grow O(nodes × sessions). The self-coordinator marker is preserved as a
// dedicated count + id list so the coordinator never mis-reads its own
// generating CLI session as a foreign delegated task.
export function summarizeNodeSessions(sessions: any[]): Record<string, unknown> {
    const list = Array.isArray(sessions) ? sessions : [];
    const byStatus: Record<string, number> = {};
    const providerCounts: Record<string, number> = {};
    const selfCoordinatorSessionIds: string[] = [];
    for (const s of list) {
        const status = typeof s?.status === 'string' && s.status ? s.status : 'unknown';
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        const provider = typeof s?.providerType === 'string' && s.providerType ? s.providerType : 'unknown';
        providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
        if (s?.isSelfCoordinator === true && s.id) selfCoordinatorSessionIds.push(String(s.id));
    }
    const summary: Record<string, unknown> = {
        total: list.length,
        byStatus,
        providerCounts,
    };
    if (selfCoordinatorSessionIds.length > 0) {
        summary.selfCoordinatorSessionIds = selfCoordinatorSessionIds;
    }
    return summary;
}
