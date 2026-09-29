// Direct git-status probe of a remote mesh node (single-flight cache, bounded
// retries, warmup-aware deadline) and the inline-mesh direct-truth hydration that
// uses it. Split out of mesh-node-identity.ts (re-exported there).

import { readMeshTimeoutEnvMs, MESH_CONNECT_TIMEOUT_MS } from '../runtime-defaults.js';
import {
    withStatusProbeMarker,
    normalizeMeshNodeFacts,
    normalizeMeshNodeId,
    daemonIdsEquivalent,
} from '@adhdev/mesh-shared';
import { awaitWithWarmupDeadline, resolveWarmupDeadlineOpts } from './mesh-warmup-deadline.js';
import { readStringValue } from './mesh-node-record-readers.js';
import {
    readProviderVersionsRecord,
    normalizeReportedMemberState,
    isDeadLocalWorktreeNode,
    recordInlineMeshDirectGitTruth,
    persistNodeReporterPlatform,
    buildInlineMeshTransitGitStatus,
} from './mesh-inline-mesh-cache.js';
import { LOG } from '../logging/logger.js';
import * as fs from 'fs';
import { getGitRepoStatus } from '../git/git-status.js';

// Direct-peer git_status probe timeout for the dashboard's requireDirectPeerTruth
// bootstrap. The previous hard-coded 8s/12s were shorter than the real P2P
// round-trip to slow (often TURN-relayed) peers, so such a node was permanently
// marked unavailable and blocked the whole mesh graph. Default raised to 25s
// (still under the P2P REQUEST_TIMEOUT of 30s) and made env-overridable.
export const MESH_DIRECT_PROBE_TIMEOUT_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_TIMEOUT_MS', 25_000);
export const MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS', 25_000);
// Cold-open warmup budget for the FIRST direct-peer probe to a peer whose mesh
// DataChannel is not open yet. A fresh cross-machine, TURN-relayed handshake
// (ICE gather + TURN allocation + DTLS across two residential networks) routinely
// needs many seconds. Charging that warmup against the response deadline
// (MESH_DIRECT_PROBE_TIMEOUT_MS) made the very first git_status to a cold peer
// false-timeout, after which the warm retry — reusing the now-open channel —
// succeeded: the classic cold-open signature. This budget bounds ONLY the
// "channel not open yet" phase; once the channel opens the response deadline
// governs the round trip. A genuine connect failure still rejects immediately —
// the mesh manager fails the peer the instant its PeerConnection state goes
// terminal, and isMeshConnectionDefinitivelyDown pre-gates an already-dead peer —
// so this never masks a real failure for the whole window; it only grants a
// still-handshaking peer the time it legitimately needs. Matches the daemon-cloud
// DaemonMeshManager CONNECT_TIMEOUT_MS (45s). Env-overridable for very slow links.
// Re-exported from the unified MESH_CONNECT_TIMEOUT_MS (runtime-defaults) so this
// probe path and the coordinator's remote task-dispatch path share ONE
// env-overridable connect budget instead of silently diverging when the env is set.
export const MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS = MESH_CONNECT_TIMEOUT_MS;
// How long a successful LOCAL git_status read stays reusable by a later
// mesh_status / get_mesh call (the dashboard's retry loop and the MCP poll hit
// the same local workspaces seconds apart). Min-clamped to 1s by
// readMeshTimeoutEnvMs. Remote nodes are never probed on a request path — their
// state is held by the coordinator (mesh-node-git-state.ts).
export const MESH_DIRECT_PROBE_REUSE_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_REUSE_MS', 12_000);

/**
 * De-duplicates LOCAL (same-machine) git_status reads. The direct-truth
 * classification and the per-node render loop both call
 * getGitRepoStatus(refreshUpstream:true) for the same local workspace within
 * one mesh_status call; each read fans out ~13-15 git subprocesses, and the two
 * passes routinely straddle the getGitRepoStatus 1.5s TTL. Routing both through
 * this cache collapses them to one read per workspace, reused across the reuse
 * window so a retry burst cannot restart a fresh local read seconds apart.
 *
 *  - In-flight dedup: a second read of a workspace with one already running
 *    shares (awaits) the in-flight promise.
 *  - Recently-read reuse: a successful read younger than `reuseMs` is reused.
 *    Failures are NOT cached.
 *
 * Lives on the router instance so the gate spans separate calls.
 */
export class MeshGitProbeCache {
    private inflight = new Map<string, Promise<Record<string, unknown> | null>>();
    private recent = new Map<string, { at: number; value: Record<string, unknown> }>();

    constructor(private readonly reuseMs: number, private readonly now: () => number = Date.now) {}

    async probeLocal(
        workspace: string,
        probe: () => Promise<Record<string, unknown> | null>,
    ): Promise<Record<string, unknown> | null> {
        const key = workspace;
        const cached = this.recent.get(key);
        if (cached && this.now() - cached.at < this.reuseMs) {
            return cached.value;
        }
        const existing = this.inflight.get(key);
        if (existing) return existing;
        const pending = (async () => {
            const result = await probe();
            if (result) this.recent.set(key, { at: this.now(), value: result });
            return result;
        })();
        this.inflight.set(key, pending);
        try {
            return await pending;
        } finally {
            // Only clear the slot if it is still ours — a later overlapping call
            // would have reused this very promise, so it is safe to delete here.
            if (this.inflight.get(key) === pending) this.inflight.delete(key);
        }
    }
}

async function probeRemoteMeshGitStatus(args: {
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    daemonId: string;
    workspace: string;
    // Response deadline — applies only once the peer's DataChannel is open (warm).
    responseTimeoutMs: number;
    // Cold-open warmup budget — applies only while the channel is still opening.
    connectTimeoutMs: number;
    // Live peer connection snapshot getter; lets the deadline tell "still warming
    // up" apart from "warm but slow". Absent → degrade conservatively (fail-loud,
    // combined connect+response window) rather than silently assuming "always warm"
    // — see resolveWarmupDeadlineOpts.
    getConnection?: (daemonId: string) => Record<string, unknown> | null;
    /** Extra git_status args (e.g. the coordinator's meshStateSubscription). */
    extraArgs?: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
    if (!args.dispatchMeshCommand) return null;
    // Fire the dispatch first — this is what drives the mesh manager to ensure /
    // open the peer connection. The warmup-aware deadline then charges the
    // cold-open handshake to the connect budget and only the warm round trip to
    // the response budget, so the first probe to a cold peer is no longer
    // false-timed-out before its channel has even opened.
    // OFFLINE-NODE-STATUS-REFRESH: stamp the status-origin marker so the daemon-cloud
    // dispatch wrapper grants this explicit_refresh / mesh_status git_status probe the
    // SHORT connect-wait budget. Without it, an offline (powered-off) peer sinks the
    // probe into the 90s connect deadline and blocks the whole status assembly. A
    // user-driven / targeted git_status (no marker) is unaffected.
    const dispatch = args.dispatchMeshCommand(
        args.daemonId,
        'git_status',
        withStatusProbeMarker({ ...(args.extraArgs ?? {}), workspace: args.workspace, refreshUpstream: true }),
    );
    // A missing connection getter no longer silently becomes `() => true`
    // ("always warm") — that charged a still-opening channel against the response
    // budget and re-introduced the cold-open false-timeout. resolveWarmupDeadlineOpts
    // warns once per peer and grants the combined budget instead.
    const remoteResult = await awaitWithWarmupDeadline(dispatch, resolveWarmupDeadlineOpts({
        getConnection: args.getConnection,
        daemonId: args.daemonId,
        connectTimeoutMs: args.connectTimeoutMs,
        responseTimeoutMs: args.responseTimeoutMs,
        onMissingGetter: warnMeshWarmupGetterMissingOnce,
    })) as any;
    const remoteGit = remoteResult?.status ?? remoteResult?.git ?? remoteResult;
    if (!remoteGit || typeof remoteGit !== 'object' || typeof remoteGit.isGitRepo !== 'boolean') return null;
    // The member daemon stamps its own platform/arch onto the git_status result
    // envelope (see git-commands.ts). Reflect them onto the returned git object
    // under non-colliding reporter* keys so recordInlineMeshDirectGitTruth can
    // persist them to node.userOverrides without touching the git status shape.
    const reporterPlatform = readStringValue(remoteResult?.reporterPlatform);
    const reporterArch = readStringValue(remoteResult?.reporterArch);
    const reporterMachineNickname = readStringValue(remoteResult?.reporterMachineNickname);
    const git = remoteGit as Record<string, unknown>;
    if (reporterPlatform) git.reporterPlatform = reporterPlatform;
    if (reporterArch) git.reporterArch = reporterArch;
    if (reporterMachineNickname) git.reporterMachineNickname = reporterMachineNickname;
    // T7: propagate the member's self-reported provider versions + build version on
    // the same reporter* channel so a remote node's providerVersions self-heal too.
    const reporterProviderVersions = readProviderVersionsRecord(remoteResult?.reporterProviderVersions);
    if (reporterProviderVersions) git.reporterProviderVersions = reporterProviderVersions;
    const reporterDaemonBuildVersion = readStringValue(remoteResult?.reporterDaemonBuildVersion);
    if (reporterDaemonBuildVersion) git.reporterDaemonBuildVersion = reporterDaemonBuildVersion;
    // Propagate the member's UNIFIED reportedMemberState (per-machine runtime facts:
    // versions + build + lastReportedAt) on the same channel so the coordinator can
    // ingest it wholesale. Slots are NOT carried — coordinator-owned config
    // (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix). Carried alongside the legacy flat
    // fields above for a mixed-version-mesh rollout.
    const reporterMemberState = normalizeReportedMemberState(remoteResult?.reporterMemberState);
    if (reporterMemberState) git.reporterMemberState = reporterMemberState;
    // Propagate the member's self-reported nodeFacts bundle (built locally by the
    // reporter via buildLocalNodeFacts, see git-commands.ts) on the same reporter*
    // channel. Without this re-attachment the probe dropped the bundle wholesale,
    // so recordInlineMeshDirectGitTruth read git.reporterNodeFacts as undefined and
    // the node.nodeFacts stamp never happened for remote nodes (local nodes are
    // unaffected — their facts are built locally, not via this probe).
    const reporterNodeFacts = normalizeMeshNodeFacts(remoteResult?.reporterNodeFacts);
    if (reporterNodeFacts) git.reporterNodeFacts = reporterNodeFacts;
    return git;
}

/** Number of bounded retries after the initial direct-peer git probe attempt. */
const MESH_DIRECT_PROBE_MAX_RETRIES = 2;

function readMeshConnectionState(connection: Record<string, unknown> | null | undefined): string | undefined {
    return readStringValue((connection as any)?.state);
}

// Fail-loud (but throttled) trace for the degraded-warmup case: a direct-peer mesh
// dispatch ran with NO live connection getter wired. This is a misconfiguration in a
// P2P-capable daemon (the getter should be present), and the old `() => true`
// fallback hid it while silently re-introducing the cold-open false-timeout. Warn
// once per peer so the degrade is visible without flooding the log on every probe.
const meshWarmupGetterMissingWarned = new Set<string>();
function warnMeshWarmupGetterMissingOnce(daemonId: string): void {
    if (meshWarmupGetterMissingWarned.has(daemonId)) return;
    meshWarmupGetterMissingWarned.add(daemonId);
    LOG.warn('Mesh', `Mesh peer connection getter unavailable for ${String(daemonId).slice(0, 12)}; warmup deadline degraded to the combined connect+response window (cannot observe DataChannel open). This avoids a cold-open false-timeout but loses warm/cold precision — wire getMeshPeerConnectionStatus on this daemon.`);
}

/**
 * Connection states that mean the peer is definitively NOT reachable right now —
 * an offline machine (no peer entry at all) or a transport that has dropped
 * (failed/closed/disconnected). Probing such a peer would just burn the full
 * MESH_DIRECT_PROBE_TIMEOUT_MS window before timing out, so the cold-open of the
 * mesh graph stalls 25s behind one powered-off node. `connecting` is deliberately
 * NOT here: a peer mid-handshake may complete during the probe window, so it still
 * gets its attempt. Held standing git truth is consulted by the caller BEFORE this
 * runs, so the invariant "connected+held is never unavailable" is untouched — this
 * only short-circuits a peer that has no usable transport to probe over.
 */
function isMeshConnectionDefinitivelyDown(
    connection: Record<string, unknown> | null | undefined,
): boolean {
    if (!connection) return true;
    const state = readMeshConnectionState(connection);
    return state === 'failed' || state === 'closed' || state === 'disconnected';
}

/**
 * Probe a remote peer's git_status with a bounded retry budget, but only while
 * the peer is reported `connected`. A single slow (often TURN-relayed) peer can
 * exceed one probe window; retrying — with the connection re-checked before each
 * attempt so we abandon a peer that dropped — recovers it without blocking the
 * mesh forever. Used ONLY by the coordinator's background handshake probe
 * (mesh-node-git-refresher.ts) — never by a request path.
 *
 * Returns the git status on success, or null if every attempt failed/timed out
 * (caller decides how to classify). `getConnection` is consulted before each
 * attempt; a non-`connected` state short-circuits the retry loop (the very first
 * attempt always runs so a missing connection getter still gets one try).
 */
export async function probeRemoteMeshGitStatusWithRetry(args: {
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    daemonId: string;
    workspace: string;
    timeoutMs: number;
    /** Per-attempt timeout for retries (attempts > 0); defaults to timeoutMs. */
    retryTimeoutMs?: number;
    /** Cold-open warmup budget per attempt; defaults to MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS. */
    connectTimeoutMs?: number;
    getConnection?: (daemonId: string) => Record<string, unknown> | null;
    onConnection?: (connection: Record<string, unknown>) => void;
    /** Extra git_status args forwarded on every attempt. */
    extraArgs?: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
    // Fast-fail an offline / dropped peer BEFORE the first attempt. Previously the
    // liveness re-check only ran *between* attempts, so a powered-off node still ate
    // the full first MESH_DIRECT_PROBE_TIMEOUT_MS (25s) window — stalling the mesh
    // graph cold-open behind one dead machine. If a connection getter is wired and
    // it reports the peer as definitively down (no peer entry / failed / closed /
    // disconnected), skip straight to "no truth" instead of awaiting a 25s timeout.
    // A `connecting` peer still gets its attempt (it may complete mid-probe). No
    // onConnection side effect here: this is a pure liveness gate, and the caller's
    // own connection read already seeds status.connection — only the between-attempt
    // path needs to surface a freshly-observed connection.
    if (args.getConnection && isMeshConnectionDefinitivelyDown(args.getConnection(args.daemonId))) {
        return null;
    }
    for (let attempt = 0; attempt <= MESH_DIRECT_PROBE_MAX_RETRIES; attempt += 1) {
        if (attempt > 0) {
            // Re-check liveness before spending another probe window; a peer that
            // dropped between attempts is not worth retrying.
            const connection = args.getConnection?.(args.daemonId);
            if (args.getConnection && readMeshConnectionState(connection) !== 'connected') break;
            if (connection) args.onConnection?.(connection);
            // Exponential backoff: 250ms, 500ms before attempts 1 and 2.
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        }
        try {
            const remoteGit = await probeRemoteMeshGitStatus({
                dispatchMeshCommand: args.dispatchMeshCommand,
                daemonId: args.daemonId,
                workspace: args.workspace,
                responseTimeoutMs: attempt === 0 ? args.timeoutMs : (args.retryTimeoutMs ?? args.timeoutMs),
                connectTimeoutMs: args.connectTimeoutMs ?? MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS,
                getConnection: args.getConnection,
                extraArgs: args.extraArgs,
            });
            if (remoteGit) return remoteGit;
        } catch {
            // Timed out or P2P error — fall through to the next bounded attempt.
        }
    }
    return null;
}

/**
 * Direct-truth accounting for a requireDirectPeerTruth caller: read the LOCAL
 * nodes' git (this machine) and count the remote nodes' HELD standing truth
 * (the coordinator store, hydrated onto node.lastGit by the caller). A remote
 * peer is never probed here — the coordinator answers from what members pushed —
 * so `peerAttemptedCount` / `peerConfirmedCount` stay 0 (kept for response-shape
 * compatibility) and a remote node without held truth is simply not counted
 * (pending), never unavailable.
 */
export async function hydrateInlineMeshDirectTruth(args: {
    mesh: any;
    meshSource: 'inline_cache' | 'inline_bootstrap' | 'local_config';
    statusInstanceId?: string;
    localMachineId?: string;
    // Optional shared local-read cache: dedups the local git reads of one call
    // against the render loop's, and reuses a recent read.
    probeCache?: MeshGitProbeCache;
}): Promise<{
    directEvidenceCount: number;
    localConfirmedCount: number;
    peerAttemptedCount: number;
    peerConfirmedCount: number;
    standingEvidenceCount: number;
    unavailableNodeIds: string[];
    deadNodeIds: string[];
}> {
    const nodes = Array.isArray(args.mesh?.nodes) ? args.mesh.nodes : [];
    if (!nodes.length) {
        return {
            directEvidenceCount: 0,
            localConfirmedCount: 0,
            peerAttemptedCount: 0,
            peerConfirmedCount: 0,
            standingEvidenceCount: 0,
            unavailableNodeIds: [],
            deadNodeIds: [],
        };
    }

    const selectedCoordinatorNodeId = readStringValue(
        args.mesh?.coordinator?.preferredNodeId,
        nodes[0]?.id,
        nodes[0]?.nodeId,
    );

    let localConfirmedCount = 0;
    let standingEvidenceCount = 0;
    const unavailableNodeIds: string[] = [];
    const deadNodeIds: string[] = [];

    // Each node's classification (local git read or held standing truth) is
    // independent; classify all nodes concurrently via Promise.allSettled and fold
    // the counters afterward so no shared mutable state is touched concurrently.
    type NodeTruthResult =
        | { kind: 'dead'; nodeId: string }
        | { kind: 'unavailable'; nodeId: string; attempted?: boolean }
        | { kind: 'local' }
        | { kind: 'standing' }
        | { kind: 'skip' };

    const classifyNode = async (nodeIndex: number, node: any): Promise<NodeTruthResult> => {
        const nodeId = normalizeMeshNodeId(node) || `node_${nodeIndex}`;
        const workspace = readStringValue(node?.workspace);
        const daemonId = readStringValue(node?.daemonId);
        const isSelfNode = Boolean(
            nodeId && selectedCoordinatorNodeId && daemonIdsEquivalent(nodeId, selectedCoordinatorNodeId),
        ) || Boolean(
            daemonId && (daemonIdsEquivalent(daemonId, args.localMachineId) || daemonIdsEquivalent(daemonId, args.statusInstanceId)),
        ) || Boolean(args.meshSource !== 'local_config' && nodeIndex === 0);

        // A dead local worktree owned by this coordinator (isLocalWorktree, the
        // node's daemon is us, workspace path gone) has no live truth and cannot
        // be probed — the directory it would self-probe no longer exists. Exclude
        // it entirely from direct-peer-truth accounting: do not probe it, do not
        // attempt it, do not push it to unavailableNodeIds (which would otherwise
        // wedge the graph in a permanent direct_peer_truth_unavailable). This is
        // strictly self + isLocalWorktree + absent-path; remote peers and nodes
        // whose workspace still exists are unaffected and stay classifiable.
        const isSelfDaemonNode = Boolean(
            daemonId && (daemonIdsEquivalent(daemonId, args.localMachineId) || daemonIdsEquivalent(daemonId, args.statusInstanceId)),
        );
        if ((isSelfNode || isSelfDaemonNode) && isDeadLocalWorktreeNode(node)) {
            return { kind: 'dead', nodeId };
        }

        if (!workspace) {
            return (!isSelfNode && daemonId) ? { kind: 'unavailable', nodeId } : { kind: 'skip' };
        }

        if (fs.existsSync(workspace)) {
            try {
                // Route the local probe through the shared cache so the per-node
                // render loop's getGitRepoStatus for the same workspace reuses this
                // exact result instead of re-shelling ~14 git processes when the two
                // passes straddle the getGitRepoStatus 1.5s TTL.
                const runLocalProbe = () => getGitRepoStatus(workspace, { timeoutMs: 10_000, refreshUpstream: true }) as unknown as Promise<Record<string, unknown> | null>;
                const localGit = args.probeCache
                    ? await args.probeCache.probeLocal(workspace, runLocalProbe)
                    : await runLocalProbe();
                if (localGit?.isGitRepo) {
                    const reporter = recordInlineMeshDirectGitTruth(node, localGit as unknown as Record<string, unknown>, 'selected_coordinator_local_git');
                    persistNodeReporterPlatform(args.meshSource, args.mesh, nodeId, reporter);
                    return { kind: 'local' };
                }
            } catch {
                // Fall through to remote classification.
            }
        }

        // A non-local node's HELD git truth (the coordinator store, hydrated onto
        // node.lastGit by the caller) counts as direct evidence — no probe.
        const standingGit = buildInlineMeshTransitGitStatus(node);
        if (standingGit) {
            return { kind: 'standing' };
        }

        // No held truth yet: pending (the render loop marks it gitProbePending),
        // never unavailable — the member's push (or the coordinator's background
        // handshake probe) fills the store.
        return { kind: 'skip' };
    };

    const nodeEntries = [...nodes.entries()];
    const settledResults = await Promise.allSettled(
        nodeEntries.map(([nodeIndex, node]) => classifyNode(nodeIndex, node)),
    );
    settledResults.forEach((settled, i) => {
        const [nodeIndex, node] = nodeEntries[i];
        // A classifier should never reject (every probe is caught internally), but
        // if one does, degrade that node to `unavailable` when it is a remote peer —
        // never silently drop it, never fail the whole aggregate.
        const result: NodeTruthResult = settled.status === 'fulfilled'
            ? settled.value
            : (() => {
                const nodeId = normalizeMeshNodeId(node) || `node_${nodeIndex}`;
                const daemonId = readStringValue(node?.daemonId);
                const isSelfNode = Boolean(
                    nodeId && selectedCoordinatorNodeId && daemonIdsEquivalent(nodeId, selectedCoordinatorNodeId),
                ) || Boolean(
                    daemonId && (daemonIdsEquivalent(daemonId, args.localMachineId) || daemonIdsEquivalent(daemonId, args.statusInstanceId)),
                );
                return (!isSelfNode && daemonId) ? { kind: 'unavailable', nodeId } as NodeTruthResult : { kind: 'skip' } as NodeTruthResult;
            })();
        switch (result.kind) {
            case 'dead':
                deadNodeIds.push(result.nodeId);
                break;
            case 'unavailable':
                unavailableNodeIds.push(result.nodeId);
                break;
            case 'local':
                localConfirmedCount += 1;
                break;
            case 'standing':
                standingEvidenceCount += 1;
                break;
            case 'skip':
            default:
                break;
        }
    });

    return {
        directEvidenceCount: localConfirmedCount + standingEvidenceCount,
        localConfirmedCount,
        // No remote peer is probed on this path (see the doc comment above).
        peerAttemptedCount: 0,
        peerConfirmedCount: 0,
        standingEvidenceCount,
        unavailableNodeIds,
        deadNodeIds,
    };
}
