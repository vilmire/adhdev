/**
 * S5 bootCommandPlane — command handler + router (wiring-unification B4).
 *
 * Everything the router reads is a VALUE by now: the poller (S3) for
 * `onIdeConnected`, the seqscribe runtime (S4) for stats / beacon / peer view /
 * replica store, and the bus for `command_executed`. The old holders
 * (`poller` / `seqscribeNodeRef` / `seqscribeCollector` / `componentsRef`) are gone.
 */

import { LOG } from '../../logging/logger.js';
import { getDaemonBuildInfo } from '../../build-info.js';
import { DaemonCommandHandler } from '../../commands/handler.js';
import { DaemonCommandRouter, getDaemonCommandRegistry } from '../../commands/router.js';
import { setupIdeInstance } from '../../cdp/setup.js';
import type { DaemonCdpManager } from '../../cdp/manager.js';
import { createDefaultGitCommandServices } from '../../git/git-commands.js';
import { getCachedProviderVersions } from '../../detection/cli-detector.js';
import { buildLocalSeqscribeStats } from '../../seqscribe/local-stats.js';
import { toBeaconDiagnosticsSummary } from '../../seqscribe/beacon-diagnostics.js';
import { meshNoticeRuntime } from '../../mesh/turn-ledger/deliver.js';
import type { CommandPlaneStage, SeqscribeNodeStage } from './types.js';

/**
 * Coordinator-notice delivery counters for the local stats surface (the turn
 * cursors + deliver outcomes; null before S7 binds the notice runtime). The
 * successor of the retired Stage 5a `readTerminalRedriveCounters`.
 */
export function readMeshDeliveryCounters(): Record<string, number> | null {
    const counters = meshNoticeRuntime.current()?.counters();
    return counters ? { ...counters } : null;
}

export function bootCommandPlane(s4: SeqscribeNodeStage): CommandPlaneStage {
    const { cfg, providerLoader, seqscribe, bus } = s4;

    const gitCommandServices = createDefaultGitCommandServices({
        // T7: fold this daemon's cached provider versions + build version
        // onto git_status so the coordinator self-heals each node's version
        // chips (per-machine RUNTIME facts). Non-blocking TTL cache read; the
        // default loader is registered in S2 so the cache is not empty.
        // Slots are NOT reported — coordinator-owned config.
        getReporterProviderVersions: () => {
            const providerVersions = getCachedProviderVersions(providerLoader);
            const daemonBuildVersion = getDaemonBuildInfo().version;
            return {
                ...(Object.keys(providerVersions).length > 0 ? { providerVersions } : {}),
                ...(daemonBuildVersion && daemonBuildVersion !== 'unknown' ? { daemonBuildVersion } : {}),
            };
        },
    });

    const commandHandler = new DaemonCommandHandler({
        cdpManagers: s4.cdpManagers,
        ideType: 'unknown',
        adapters: s4.cliManager.adapters,
        providerLoader,
        instanceManager: s4.instanceManager,
        sessionRegistry: s4.sessionRegistry,
        gitCommandServices,
        onProviderSettingChanged: async (providerType) => {
            await s4.refreshProviderAvailability(providerType);
            s4.emitFacts('provider_settings');
        },
        onProviderSourceConfigChanged: async () => {
            await s4.refreshProviderAvailability();
            s4.emitFacts('provider_settings');
        },
        // D4 (both hosts): a pre-turn workspace snapshot before user input is
        // dispatched. Fire-and-forget; the post-turn snapshot is the host
        // runtime's `status` subscriber (boot/host-turn-snapshots.ts).
        onBeforeSendChat: ({ workspace }) => {
            if (!workspace || !gitCommandServices.createSnapshot) return;
            void Promise.resolve(gitCommandServices.createSnapshot({
                workspace,
                reason: 'before_user_input_dispatch',
            })).catch(() => {});
        },
        // A value from S3 — no late setter.
        agentStreamManager: s4.agentStreamManager,
    });

    const router = new DaemonCommandRouter({
        commandHandler,
        cliManager: s4.cliManager,
        cdpManagers: s4.cdpManagers,
        providerLoader,
        instanceManager: s4.instanceManager,
        detectedIdes: s4.detectedIdes,
        sessionRegistry: s4.sessionRegistry,
        bus: s4.bus,
        onCdpManagerCreated: async (ideType: string, manager: DaemonCdpManager) => {
            // launch_ide: register instance + extension providers.
            await setupIdeInstance(s4.cdpSetupContext, { ideType, manager });
        },
        onIdeConnected: () => s4.poller.start(),
        // Command handlers that change daemon facts publish them on the bus;
        // hosts subscribe (no host callback reaches into the command plane).
        onStatusChange: () => s4.emitFacts('command'),
        onMeshStateChange: (meshId: string) => bus.emit({ kind: 'mesh_state', at: Date.now(), meshId: meshId || '*' }),
        // post-chat: `command_executed{postChat}` on the bus (router emits it).
        sessionHostControl: cfg.sessionHost.control ?? null,
        statusInstanceId: cfg.statusInstanceId,
        statusVersion: cfg.statusVersion,
        getMeshPeerConnectionStatus: cfg.mesh?.getMeshPeerConnectionStatus,
        dispatchMeshCommand: cfg.mesh?.dispatchMeshCommand,
        updateLocalMeshOwnedSession: cfg.mesh?.mirrorMeshWorkerEvent,
        getCdpLogFn: (ideType: string) => LOG.forComponent(`CDP:${ideType}`).asLogFn(),
        // Local replication-health read surface (get_status_metadata).
        // Aggregate-only by construction — see seqscribe/local-stats.ts.
        getSeqscribeStats: () => buildLocalSeqscribeStats(seqscribe, { meshDelivery: readMeshDeliveryCounters }),
        // Beacon staleness / sole-copy (§7.1). Unlike the stats this DOES carry
        // topic names and peer writer ids — LOCAL/P2P only, never status_report.
        // `diagnostics()` does no I/O, so an on-demand read cannot become a
        // Beacon traffic source. The host arms the slot on its first
        // authenticated epoch; standalone never does.
        getBeaconDiagnostics: () => {
            const beacon = seqscribe?.beacon.get();
            if (!beacon) return null;
            try {
                return toBeaconDiagnosticsSummary(beacon.diagnostics());
            } catch (error) {
                LOG.info(
                    'Seqscribe',
                    `beacon diagnostics unavailable for get_status_metadata: ${error instanceof Error ? error.message : String(error)}`,
                );
                return null;
            }
        },
        getFleetStatusPeerView: () => seqscribe?.fleetPeerView?.snapshot() ?? null,
        getTranscriptReplicaStore: () => seqscribe?.transcriptReplica ?? null,
        // G3: cloud-only — see CommandRouterDeps.resolveTranscriptPeer's doc
        // comment and DaemonBootConfig.mesh.resolveTranscriptPeer. Absent
        // (undefined) on standalone, same as every other `cfg.mesh?.*` hook
        // above — there is no mesh peer map to resolve a peer from.
        resolveTranscriptPeer: cfg.mesh?.resolveTranscriptPeer,
    });

    return { ...s4, commandRegistry: getDaemonCommandRegistry(), commandHandler, router };
}
