/**
 * RF-ROUTER LOW family — status/metadata + user-name commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Each handler
 * reads only ctx.deps (+ process-global config/status builders) and returns the
 * same CommandRouterResult the inlined case did. get_session_info aggregates the
 * session/coordinator registries the router already holds via deps; none of these
 * touch the router's inline-mesh cache or other instance state.
 */
import { loadConfig, updateConfig } from '../../config/config.js';
import { readUpgradeFailureNotice } from '../upgrade-helper.js';
import { buildMachineInfo, buildStatusSnapshot } from '../../status/snapshot.js';
import { getDaemonBuildInfo } from '../../build-info.js';
import { TRACK } from '../../track-identity.js';
import { getCoordinatorForSession, listCoordinatorsForMesh } from '../../mesh/coordinator-registry.js';
import { currentRefineExecutorBootId } from '../../mesh/mesh-refine-executor-liveness.js';
import { readTerminalRedriveDiagnostics } from '../../mesh/mesh-terminal-redrive-diagnostics.js';
// ★These two commands are the SWR read surfaces — the ONLY read path allowed to
// schedule a background refresh (quota/refresh.ts readQuotaCacheWithRevalidate).
// They qualify because they are on-demand and human-paced: a machine page load
// and a session-info dialog open. They are emphatically NOT the periodic
// mesh_status probe or buildLocalNodeFacts, which run per git_status and per
// 4-second reconcile tick and must keep calling the fetch-free readQuotaCache().
//
// The return value is still the CACHED snapshot, returned synchronously — the
// revalidate improves the next read, it is never awaited here.
import { readQuotaCacheWithRevalidate } from '../../quota/index.js';
import { forceRefreshQuota } from '../../quota/index.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const statusMetaHandlers: Record<string, LowFamilyHandler> = {
    set_user_name: async (_ctx: LowFamilyContext, args: any) => {
        const name = args?.userName;
        if (!name || typeof name !== 'string') throw new Error('userName required');
        updateConfig({ userName: name });
        return { success: true, userName: name };
    },

    get_status_metadata: async (ctx: LowFamilyContext, _args: any) => {
        const snapshot = buildStatusSnapshot({
            allStates: ctx.deps.instanceManager.collectAllStates(),
            cdpManagers: ctx.deps.cdpManagers,
            providerLoader: ctx.deps.providerLoader,
            detectedIdes: ctx.deps.detectedIdes.value,
            instanceId: ctx.deps.statusInstanceId || loadConfig().machineId || 'daemon',
            version: ctx.deps.statusVersion || 'unknown',
            profile: 'metadata',
        });
        // Surface the daemon's build stamp so coordinators (mesh_status)
        // can detect a running daemon that predates a just-merged fix and
        // is awaiting deploy/restart. Sibling of `status` to avoid
        // perturbing the dashboard status snapshot shape.
        //
        // `upgradeFailure` is the post-hoc observability half of the
        // intent-vs-result contract (see daemon-lifecycle daemon_upgrade):
        // the schedule-time response cannot know the detached helper's
        // outcome, so a failed/rolled-back upgrade is reported HERE via the
        // durable notice the helper leaves behind. null = no failed upgrade
        // on record.
        // `providerChannelStaleness` mirrors the upgradeFailure pattern: pure
        // read of the 24h probe's cached snapshot (null until the first probe)
        // so dashboards can badge stale pins / never-installed channel types
        // without any network on a status path.
        return {
            success: true,
            status: snapshot,
            // `track` is reported by the daemon that answered this command. It
            // must travel explicitly: version strings do not identify a release
            // track (stable can legitimately publish an rc), and an older daemon
            // that omits this field must remain "unknown" to remote consumers.
            daemonBuild: { ...getDaemonBuildInfo(), track: TRACK },
            upgradeFailure: readUpgradeFailureNotice(),
            providerChannelStaleness: ctx.deps.providerLoader?.getChannelStalenessSnapshot?.() ?? null,
            // Per-process id, minted once at module load (mesh-refine-executor-
            // liveness.ts) — differs across a real process restart even if the
            // OS reissues the same pid, unlike daemonBuild.builtAt (build time,
            // not boot time) or machine uptime (survives a daemon restart
            // untouched). A coordinator that called restart_daemon_node can
            // read this before and after (per the clientHint retry delay) and
            // compare: same id means the daemon never actually exited/re-spawned.
            bootId: currentRefineExecutorBootId(),
            // Local read surface for seqscribe replication health. Until now
            // `getSeqscribeStats` was reachable only through the status report
            // to the cloud server, so an operator on the machine had no way to
            // see whether replication was healthy — `adhdev`/mesh_status can
            // now answer it without a round trip through the server.
            //
            // ★This is the SAME aggregate-only summary the status path carries
            // (seqscribe/stats.ts): counters, booleans and bucket ordinals.
            // The server content boundary is untouched — nothing is added to
            // status_report here, and this field must never widen into topic
            // names, peer ids, or anything derived from an entry payload.
            //
            // null = replication unavailable (node failed to open, or stats
            // threw); the key is always present so a caller can tell "no node"
            // from an older daemon that never reported the field at all.
            seqscribe: ctx.deps.getSeqscribeStats?.() ?? null,
            // Beacon staleness / sole-copy (design §7.1, mission b60d70b8).
            //
            // ★Unlike `seqscribe` above, this DOES carry topic names and peer
            // writer ids — that is the feature ("which topic is how far
            // ahead"), and it is why it appears on THIS local surface and on
            // the P2P payload, but never on `status_report` to the server. The
            // approved Beacon content exception (CLAUDE.md) covers the beacon
            // BOARD path; it does not widen the status path's allow-list.
            //
            // null = no beacon armed (standalone never arms one) or none yet on
            // this daemon, so it stays distinguishable from an older daemon
            // that never reported the field.
            beacon: ctx.deps.getBeaconDiagnostics?.() ?? null,
            // Phase 4 Stage 2 receive-side fleet view. This is a pure local
            // snapshot of fixed-key entries delivered by connection-scoped
            // seqscribe SUBs; it neither polls nor touches the server status
            // path. Raw numeric receive/comparison counters live alongside the
            // entries because no content or dynamic-key map is present.
            fleetStatusPeerView: ctx.deps.getFleetStatusPeerView?.() ?? null,
            // Terminal-redrive health (see mesh-terminal-redrive-diagnostics.ts).
            //
            // ★ Stage 5c-1 replaced the two fields that used to sit here —
            // `outbox` (turn-outbox backlog/enqueue state) and
            // `outboxRedriveCoverage` (the redrive-vs-outbox subset join) — with
            // this single one. Both of the old fields were reads of
            // `mesh_turn_outbox`, and that table is gone; the coverage join in
            // particular had the outbox as its DENOMINATOR, so it could not
            // survive the removal as anything but a vacuous constant.
            //
            // What to watch now that redrive is the sole re-arm path:
            // `quarantinedMeshCount` is the successor to the outbox's `failed`
            // park. Non-zero means a mesh's cursor is held, which also pins the
            // seqscribe archive floor open — so it costs storage, not just
            // notification latency. It auto-resolves after the cooldown.
            terminalRedrive: readTerminalRedriveDiagnostics(),
        };
    },

    /**
     * ★FORCE REFRESH — the single entry point for "read my quota again, now".
     *
     * Every surface funnels here: `adhdev quota --refresh` (over local IPC), a
     * dashboard refresh button, an MCP caller. One entry point rather than
     * several is what keeps the 429 cooldown, the enable gate and the
     * carry-forward from being re-implemented (and quietly weakened) per
     * surface.
     *
     * ★It runs INSIDE the daemon, so it warms the cache that routing and every
     * dashboard read consume. This is the difference from `adhdev quota codex`,
     * which calls a fetcher in a separate CLI process: that prints a number and
     * leaves the daemon exactly as stale as it was.
     *
     * ★It does not bypass the 429 cooldown. A cooling-down provider comes back
     * with outcome 'cooldown' + retryAtMs, and the caller is expected to SAY so
     * — see forceRefreshQuota for why overriding on user request is the wrong
     * behaviour here.
     */
    refresh_provider_quota: async (_ctx: LowFamilyContext, args: any) => {
        const raw = args?.providers ?? args?.provider;
        const providers = Array.isArray(raw)
            ? raw.filter((p: unknown): p is string => typeof p === 'string')
            : typeof raw === 'string' && raw.trim()
                ? [raw.trim()]
                : undefined;
        const { entries, quota } = await forceRefreshQuota(providers);
        return {
            success: true,
            refreshed: entries,
            // Same "omit rather than send undefined" contract as the reads above.
            ...(quota ? { quota } : {}),
            machineNickname: loadConfig().machineNickname,
            timestamp: Date.now(),
        };
    },

    get_machine_runtime_stats: async (_ctx: LowFamilyContext, _args: any) => {
        const quota = readQuotaCacheWithRevalidate();
        return {
            success: true,
            machine: {
                ...buildMachineInfo('full'),
                // Omit the key entirely rather than shipping `quota: undefined`
                // — same "never reported" vs "reported empty" contract as
                // buildLocalNodeFacts (mesh/node-facts.ts). `'quota' in machine`
                // must stay false until the refresh loop's first tick.
                ...(quota ? { quota } : {}),
                machineNickname: loadConfig().machineNickname,
            },
            timestamp: Date.now(),
        };
    },

    // Session-info popup data. Aggregates whatever the daemon knows
    // about a single live session into one envelope so the dashboard
    // doesn't need to stitch together status + coordinator registry +
    // session registry on the client. Includes the actual system
    // prompt that was injected at launch when the session is a mesh
    // coordinator — that's the "what prompt did the agent see?"
    // question the info-icon dialog is meant to answer.
    get_session_info: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
            : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) return { success: false, error: 'targetSessionId required' };
        // Fetch both lookups up front. We used to bail with "Session not
        // found" when sessionRegistry forgot the SID (auto-cleanup,
        // daemon restart with the session not yet restored, etc), which
        // hid the coordinator-side metadata even though the
        // coordinator-registry still has it. Now we return whichever
        // side we have. The dashboard renders "no coordinator-specific
        // prompt" only when *neither* side knows the session.
        const target = ctx.deps.sessionRegistry.get(sessionId);
        const coord = getCoordinatorForSession(sessionId);
        if (!target && !coord) return { success: false, error: 'Session not found', sessionId };
        const adapter = target
            ? ctx.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter
            : undefined;
        const runtimeMeta = (adapter && typeof (adapter as any).getRuntimeMetadata === 'function')
            ? (adapter as any).getRuntimeMetadata()
            : undefined;
        // Launch metadata (args / cwd / extra-env keys / providerSessionId) is
        // derived from the live adapter's spawn plan; only available while the
        // adapter is alive (resumed-from-history sessions report nothing here).
        const launchInfo = (adapter && typeof (adapter as any).getLaunchInfo === 'function')
            ? (adapter as any).getLaunchInfo()
            : undefined;
        const providerType = target?.providerType || coord?.cliType || '';
        const providerMetaForSession = providerType
            ? ctx.deps.providerLoader.resolve?.(providerType) || ctx.deps.providerLoader.getMeta(providerType)
            : undefined;
        // WORKER-side mesh linkage — the inverse of the `coordinator` block
        // below. A session the mesh auto-launch spawned carries authoritative
        // stamps on its live instance settings (same order the event
        // forwarder trusts, resolveForwardEventMeshId): meshNodeFor = meshId,
        // meshNodeId, meshActiveTaskId. Join this daemon's registered
        // coordinator for that mesh so the dashboard can render "spawned by
        // the coordinator" and offer a jump to its chat — until now only the
        // coordinator side got special treatment and its spawned workers
        // rendered as plain CLI sessions.
        let meshWorker: Record<string, unknown> | null = null;
        if (!coord && target) {
            try {
                const state = ctx.deps.instanceManager?.getInstance?.(sessionId)?.getState?.();
                const settings = (state?.settings as Record<string, unknown>) || {};
                const workerMeshId = typeof settings.meshNodeFor === 'string' ? settings.meshNodeFor.trim() : '';
                const workerNodeId = typeof settings.meshNodeId === 'string' ? settings.meshNodeId.trim() : '';
                const workerTaskId = typeof settings.meshActiveTaskId === 'string' ? settings.meshActiveTaskId.trim() : '';
                if (workerMeshId || workerNodeId || workerTaskId) {
                    // LOCAL registry first: listCoordinatorsForMesh knows the
                    // coordinator's cliType and lets us compute liveness — richer
                    // than the stamp, so it keeps priority (same-machine case is
                    // unchanged). The stamp fallback below only fires on a miss.
                    const coordinatorEntry = workerMeshId ? listCoordinatorsForMesh(workerMeshId)[0] : undefined;
                    const stampCoordinatorSessionId = typeof settings.meshCoordinatorSessionId === 'string' ? settings.meshCoordinatorSessionId.trim() : '';
                    const stampCoordinatorDaemonId = typeof settings.meshCoordinatorDaemonId === 'string' ? settings.meshCoordinatorDaemonId.trim() : '';
                    meshWorker = {
                        ...(workerMeshId ? { meshId: workerMeshId } : {}),
                        ...(workerNodeId ? { nodeId: workerNodeId } : {}),
                        ...(workerTaskId ? { taskId: workerTaskId } : {}),
                        ...(coordinatorEntry ? {
                            coordinatorSessionId: coordinatorEntry.sessionId,
                            coordinatorCliType: coordinatorEntry.cliType,
                            // Live only while the coordinator's session record
                            // exists — the jump button should not point at a
                            // chat that no longer has a session behind it.
                            coordinatorAlive: Boolean(ctx.deps.sessionRegistry.get(coordinatorEntry.sessionId)),
                        } : stampCoordinatorSessionId ? {
                            // REMOTE-worker fallback: the coordinator registry is
                            // machine-local, so a worker on a remote node misses it
                            // even though the dispatch stamped the coordinator's
                            // session id onto this worker's settings (carried over
                            // P2P — buildMeshWorkerRelayStamp). Liveness of a
                            // remote session is unknowable from here, so
                            // coordinatorAlive stays undefined and the dialog
                            // renders the jump button optimistically (a miss is
                            // answered by the existing chatNotFound toast).
                            coordinatorSessionId: stampCoordinatorSessionId,
                            ...(stampCoordinatorDaemonId ? { coordinatorDaemonId: stampCoordinatorDaemonId } : {}),
                        } : {}),
                    };
                }
            } catch { /* linkage is best-effort observability */ }
        }
        const quota = readQuotaCacheWithRevalidate();
        return {
            success: true,
            session: {
                sessionId,
                providerType,
                providerName: providerMetaForSession?.name,
                transport: target?.transport,
                workspace: (target as any)?.workspace || coord?.workspace,
                spawnedAtMs: (target as any)?.spawnedAtMs || coord?.startedAt,
                // providerSessionId now comes from the live adapter's launch info
                // (the registry target never carried it — it was always undefined).
                providerSessionId: launchInfo?.providerSessionId || (target as any)?.providerSessionId,
                runtimeMetadata: runtimeMeta,
                launch: launchInfo,
            },
            // Machine-scoped, not session-scoped: this daemon is the one the
            // dialog already talked to (ctx handles the routing), so it can
            // answer for its own machine's quota with no mesh lookup. Cache
            // read only — see the import comment above. Key omitted entirely
            // (not `quota: undefined`) until the refresh loop's first tick —
            // same never-reported-vs-reported-empty contract as node-facts.ts.
            ...(quota ? { quota } : {}),
            machineNickname: loadConfig().machineNickname,
            // Present only for coordinator-spawned worker sessions; null keeps
            // the "field exists, nothing to show" contract of `coordinator`.
            meshWorker,
            coordinator: coord ? {
                meshId: coord.meshId,
                startedAt: coord.startedAt,
                cliType: coord.cliType,
                systemPrompt: coord.systemPrompt,
                extraSystemPrompt: coord.extraSystemPrompt,
                injection: coord.injection,
                mcpConfigPath: coord.mcpConfigPath,
            } : null,
        };
    },
};
