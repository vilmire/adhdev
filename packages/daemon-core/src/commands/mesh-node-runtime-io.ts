/**
 * I/O edges of the coordinator-held node RUNTIME (mesh/mesh-node-runtime-summary.ts):
 *   - member side: read THIS daemon's runtime summary in-process (no command
 *     dispatch, no command log line) for mesh-node-state-pusher.ts, and wake the
 *     pusher on session lifecycle facts;
 *   - coordinator side: the nudge that makes a member push (and subscribe) now —
 *     used by mesh-node-git-refresher.ts, never awaited by a request path. The
 *     coordinator never reads a member's runtime itself.
 */
import { getMachineId, getMachineNickname } from '../config/config.js';
import { getCachedProviderVersions } from '../detection/cli-detector.js';
import { getDaemonBuildInfo } from '../build-info.js';
import { TRACK } from '../track-identity.js';
import { buildSessionEntries } from '../status/builders.js';
import { readUpgradeFailureNotice } from './upgrade-failure-notice.js';
import { buildLocalNodeFacts } from '../mesh/node-facts.js';
import { buildMeshNodeRuntimeProviders, buildMeshNodeRuntimeSummary, type MeshNodeRuntimeSummary } from '../mesh/mesh-node-runtime-summary.js';
import type { MeshNodeStatePusher } from '../mesh/mesh-node-state-pusher.js';
import { MESH_NODE_STATE_NUDGE_COMMAND, type MeshNodeGitRefreshTarget } from '../mesh/mesh-node-git-refresher.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { unwrapMeshRelayResult } from './mesh-relay-result.js';
import type { CommandRouterDeps } from './router.js';

/**
 * This daemon's content-free runtime summary (sessions / build / upgrade marker /
 * facts incl. quota). Session entries come from the SAME builder
 * get_status_metadata uses (metadata profile) — without the machine/config/
 * provider-catalog half of the snapshot, which the summary never carries.
 */
export function readLocalMeshNodeRuntime(
    deps: Pick<CommandRouterDeps, 'instanceManager' | 'cdpManagers' | 'providerLoader' | 'statusInstanceId'>,
    daemonBootId?: string,
): MeshNodeRuntimeSummary | null {
    const core = {
        // Per-process id: a coordinator seeing it change knows this daemon restarted.
        ...(daemonBootId ? { daemonBootId } : {}),
        status: {
            instanceId: deps.statusInstanceId || getMachineId() || 'daemon',
            sessions: buildSessionEntries(deps.instanceManager.collectAllStates(), deps.cdpManagers, { profile: 'metadata' }),
        },
        daemonBuild: { ...getDaemonBuildInfo(), track: TRACK },
        upgradeFailure: readUpgradeFailureNotice(),
    };
    let nodeFacts: unknown;
    let providers: unknown;
    try {
        const providerVersions = deps.providerLoader ? getCachedProviderVersions(deps.providerLoader) : {};
        // Provider catalog (installed / enabled / versions / auto-approve modes) —
        // in-memory loader state + the cached version map, no detection run here.
        try {
            const loader = deps.providerLoader as unknown as { getAvailableProviderInfos?: () => unknown[]; getAll?: () => unknown[] } | undefined;
            const rows = loader?.getAvailableProviderInfos?.() ?? loader?.getAll?.();
            providers = buildMeshNodeRuntimeProviders(rows, providerVersions);
        } catch { providers = undefined; }
        let machineNickname: string | null = null;
        try {
            const nick = getMachineNickname();
            machineNickname = typeof nick === 'string' && nick.trim() ? nick.trim() : null;
        } catch { /* best-effort */ }
        // Cache reads only (buildLocalNodeFacts' performance contract): quota comes
        // from the refresh loop's cache, never a fetcher.
        nodeFacts = buildLocalNodeFacts({ providerVersions, machineNickname });
    } catch {
        nodeFacts = undefined;
    }
    return buildMeshNodeRuntimeSummary(core, nodeFacts, providers);
}

/** Lifecycle facts that change what the runtime summary shows. */
const RUNTIME_LIFECYCLE_KINDS = ['registered', 'status', 'terminated', 'binding', 'launch_updated'] as const;

export function subscribeMeshNodeRuntimePush(bus: SessionLifecycleBus | null | undefined, pusher: MeshNodeStatePusher): Unsubscribe | null {
    if (!bus) return null;
    return bus.on(RUNTIME_LIFECYCLE_KINDS, () => pusher.noteRuntimeChanged(), { name: 'mesh-node-runtime-push' });
}

/** Budget for a nudge round trip (it only registers intent; the push follows separately). */
export const MESH_NODE_STATE_NUDGE_TIMEOUT_MS = 10_000;

/**
 * Ask a member to push its node state now. The nudge carries the node's
 * workspace, so a member not yet pushing this node subscribes on the spot.
 * Resolves true when the member took it, false when it refused (e.g. the
 * workspace is not on that machine). Rejects when the member is unreachable.
 */
export async function nudgeMeshNodeStatePush(
    dispatchMeshCommand: CommandRouterDeps['dispatchMeshCommand'],
    target: MeshNodeGitRefreshTarget,
    timeoutMs: number,
): Promise<boolean> {
    if (!dispatchMeshCommand) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        const raw = await Promise.race([
            dispatchMeshCommand(target.daemonId, MESH_NODE_STATE_NUDGE_COMMAND, { meshId: target.meshId, nodeId: target.nodeId, workspace: target.workspace }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('mesh_node_state_nudge_timeout')), timeoutMs);
                (timer as { unref?: () => void }).unref?.();
            }),
        ]);
        const result = unwrapMeshRelayResult(raw, { command: MESH_NODE_STATE_NUDGE_COMMAND, peerDaemonId: target.daemonId }) as Record<string, unknown> | null;
        return !!result && result.success !== false && result.subscribed === true;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
