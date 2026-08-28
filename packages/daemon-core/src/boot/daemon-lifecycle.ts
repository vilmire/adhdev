/**
 * Daemon Lifecycle — Shared init + shutdown logic
 *
 * initDaemonComponents(): Creates all core daemon components in correct order.
 * shutdownDaemonComponents(): Graceful shutdown of all components.
 *
 * Transport-specific setup (ServerConnection, P2P, HTTP/WS) remains in each daemon.
 */

import { DaemonCdpManager } from '../cdp/manager.js';
import { DaemonCdpInitializer, type CdpInitializerConfig } from '../cdp/initializer.js';
import { setupIdeInstance, type CdpSetupContext } from '../cdp/setup.js';
import { DaemonCommandHandler } from '../commands/handler.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../commands/router.js';
import type { SessionHostControlPlane } from '../commands/router.js';
import {
    DaemonCliManager,
    type CliTransportFactoryParams,
    type HostedCliRuntimeDescriptor,
} from '../commands/cli-manager.js';
import { DaemonAgentStreamManager } from '../agent-stream/manager.js';
import { AgentStreamPoller } from '../agent-stream/poller.js';
import { ProviderLoader, providerLoaderConfigOptions } from '../providers/provider-loader.js';
import { VersionArchive, detectAllVersions } from '../providers/version-archive.js';
import { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { DevServer } from '../daemon/dev-server.js';
import { detectIDEs, type IDEInfo } from '../detection/ide-detector.js';
import { detectCLI, detectCLIs, getCachedProviderVersions, setDefaultProviderLoader } from '../detection/cli-detector.js';
import { getDaemonBuildInfo } from '../build-info.js';
import { SessionRegistry } from '../sessions/registry.js';
import { setTranscriptClaimLivenessProbe } from '../providers/native-history/transcript-claim-registry.js';
import { LOG, installGlobalInterceptor } from '../logging/logger.js';
import {
    DEFAULT_CDP_DISCOVERY_INTERVAL_MS,
    DEFAULT_CDP_SCAN_INTERVAL_MS,
} from '../runtime-defaults.js';
import { loadConfig, getConfigDir } from '../config/config.js';
import { configDirChannelMismatch } from '../config/config-dir.js';
import { isPreviewReleaseChannel, PROVIDER_CHANNEL_ENV_VAR } from '../providers/channel/contract.js';
import { readUpgradeFailureNotice } from '../commands/upgrade-helper.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { IdeProviderInstance } from '../providers/ide-provider-instance.js';
import { createDefaultGitCommandServices } from '../git/git-commands.js';
import { setupMeshEventForwarding } from '../mesh/mesh-events.js';
import { setupMeshReconcileLoop } from '../mesh/mesh-reconcile-loop.js';
import { migratePendingEventsJsonlToSqlite } from '../mesh/mesh-events-pending-migration.js';
import { setupQuotaRefreshLoop, setupQuotaEventRefresh, refreshQuotaCacheOnBoot, hydrateQuotaCacheFromDisk, quotaProviderEnabledFromLoader } from '../quota/refresh.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { loadMeshCoordinatorRegistry } from '../mesh/coordinator-registry.js';
import { currentRefineExecutorBootId } from '../mesh/mesh-refine-executor-liveness.js';
import { applyProcessHardening } from './process-hardening.js';
import { startEventLoopMonitor } from './event-loop-monitor.js';
import { installProviderProcessShim } from '../providers/sdk/v1/sandbox/require-whitelist.js';
import { loadStoredFleetSecret } from '../seqscribe/fleet-secret.js';
import {
    toBeaconDiagnosticsSummary,
    type BeaconDiagnostics,
} from '../seqscribe/beacon-diagnostics.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../seqscribe/node.js';
import { startConvergenceProbe, type ProbeHandle } from '../seqscribe/probe.js';
import { summarizeSeqscribeStats } from '../seqscribe/stats.js';
import {
    startSeqscribeThroughputCollector,
    type SeqscribeThroughputCollector,
} from '../seqscribe/throughput-collector.js';
import { configureMeshReadReadinessCollector } from '../seqscribe/mesh-read-readiness.js';
import {
    configureMeshDualWrite,
    isMeshDualWriteActive,
    meshDualWriteCounters,
} from '../seqscribe/mesh-dual-write.js';
import { configureFleetStatusShadow } from '../seqscribe/fleet-status-shadow.js';
import { configureFleetStatusParity } from '../seqscribe/fleet-status-parity.js';
import { meshParityCounters } from '../seqscribe/mesh-parity.js';
import { startMeshParityLoop, type MeshParityLoopHandle } from '../mesh/mesh-parity-loop.js';
import {
    configureMeshReadModel,
    pruneStaleConsumersAtBoot,
} from '../seqscribe/mesh-read-model.js';

// ─── Init Config ───

export interface DaemonInitConfig {
    /** ProviderLoader log function */
    providerLogFn?: (msg: string) => void;

    /** CLI Manager deps (transport-specific) */
    cliManagerDeps: {
        getServerConn: () => any;
        getP2p: () => any;
        onStatusChange: () => void;
        removeAgentTracking: (key: string) => void;
        createPtyTransportFactory?: (params: CliTransportFactoryParams) => PtyTransportFactory | null;
        listHostedCliRuntimes?: () => Promise<HostedCliRuntimeDescriptor[]>;
        hostedRuntimeManagerTag?: string;
    };

    /** CDP config */
    enabledIdes?: string[];

    /** Router transport-specific callbacks */
    onStatusChange?: () => void;
    onMeshStateChange?: (meshId: string) => void;
    onPostChatCommand?: () => void;
    sessionHostControl?: SessionHostControlPlane | null;
    getCdpLogFn?: (ideType: string) => (msg: string) => void;

    /** Additional callback after CDP manager created (transport-specific extras) */
    onCdpManagerSetup?: (ideType: string, manager: DaemonCdpManager, managerKey: string) => void | Promise<void>;

    /** Poller callback (transport-specific) */
    onStreamsUpdated?: (ideType: string, streams: any[]) => void;

    /** Instance ticking interval (ms), default 5000 */
    tickIntervalMs?: number;

    /** CDP scan interval (ms), default 30000 */
    cdpScanIntervalMs?: number;

    /** Canonical status identity used by on-demand snapshot commands */
    statusInstanceId?: string;
    statusVersion?: string;
    statusDaemonMode?: boolean;

    /** Fired before send_chat is dispatched — used for turn snapshot hooks */
    onBeforeSendChat?: (params: { workspace: string; sessionId: string }) => void;

    /** Relays a command to a remote mesh node daemon */
    dispatchMeshCommand?: (daemonId: string, command: string, args: Record<string, unknown>) => Promise<any>;
    /** Returns selected-coordinator mesh peer telemetry for a target daemon when available. */
    getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
    /** Cloud-only: P2P dashboard metadata sync after the core forwarder handles a mesh event. */
    onMeshCoordinatorEventForwarded?: (payload: Record<string, unknown>) => void;
    /**
     * Cloud-only: refresh THIS daemon's own coordinator mirror for a self-hosted mesh session
     * (coordinator == this daemon), used by the SELF-DIAL branch of set_conversation_prefs so a
     * locally coordinated session updates its mirror in-process instead of P2P-dialing its own id
     * (refused as SELF_DIAL). Injected by daemon-cloud (updateMeshOwnedSession + dashboard flush);
     * absent on standalone (no coordinator mirror).
     */
    updateLocalMeshOwnedSession?: (payload: Record<string, unknown>) => void;
}

// ─── Result ───

export interface DaemonComponents {
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    cliManager: DaemonCliManager;
    commandHandler: DaemonCommandHandler;
    agentStreamManager: DaemonAgentStreamManager;
    router: DaemonCommandRouter;
    poller: AgentStreamPoller;
    cdpInitializer: DaemonCdpInitializer;
    cdpManagers: Map<string, DaemonCdpManager>;
    sessionRegistry: SessionRegistry;
    detectedIdes: { value: IDEInfo[] };
    refreshProviderAvailability: (providerType?: string) => Promise<void>;
    dispatchMeshCommand?: (daemonId: string, command: string, args: Record<string, unknown>) => Promise<any>;
    // Cloud-only: live selected-coordinator mesh peer telemetry for a target daemon.
    // Lets the remote task-dispatch path (mesh-events-coordinator deliverTaskToSession)
    // tell a still-opening DataChannel ("cold") apart from an open one ("warm") so a
    // cold-open handshake is charged to the connect budget, not the response budget.
    // Injected by daemon-cloud; absent on standalone (no P2P mesh), where the remote
    // dispatch path is unused.
    getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
    // Cloud-only hook: after the single core forwarder handles a mesh coordinator event, cloud
    // uses this to keep its P2P dashboard view in sync (mesh-owned session metadata + flush
    // subscriptions). Injected by daemon-cloud; absent/no-op on standalone. Replaces cloud's
    // former separate instanceManager.onEvent listener so the event path stays single-listener.
    onMeshCoordinatorEventForwarded?: (payload: Record<string, unknown>) => void;
    // Periodic queue → live-coordinator reconcile loop handle. Set during
    // initDaemonComponents, stopped during shutdownDaemonComponents. Drives the
    // single-model (queue + polling) delivery: drains the pending-events queue
    // on a fixed interval and injects into live CLI coordinators when idle.
    meshReconcileLoop?: { stop(): void };
    // Periodic provider-quota refresh handle. Fills the in-memory quota cache
    // that buildLocalNodeFacts READS (never fetches from) so quota rides the
    // node-facts bundle without charging a codex app-server spawn to every
    // git_status. Skips ticks entirely while this machine is idle.
    quotaRefreshLoop?: { stop(): void };
    // Event-driven quota refresh handle (agent:generating_completed → refetch
    // just that provider, debounced). Complements the periodic loop: the
    // post-turn reading lands within seconds instead of up to one interval.
    quotaEventRefresh?: { stop(): void };
    // Verified-channel staleness probe (24h read-only listing → dashboard
    // badge data). Stopped during shutdownDaemonComponents.
    providerStalenessProbe?: { stop(): void };
    // EVENT-LOOP-LAG-HEARTBEAT: periodic perf_hooks event-loop-lag sampler.
    // Emits a WARN naming the blackout duration when the whole process was
    // frozen (machine saturation) — turning "handler slow vs process frozen"
    // from log-gap inference into a direct measurement (2026-08-18 RCA).
    eventLoopMonitor?: { stop(): void };
    // Canonical status/daemon identity (e.g. `standalone_<machineId>` /
    // `daemon_<machineId>`). This is the SAME id the MCP layer stamps as a
    // worker's meshCoordinatorDaemonId (ctx.localDaemonId, sourced from
    // getStatus().status.instanceId), so the reconcile loop MUST drain with it —
    // draining with bare loadConfig().machineId never matches a unicast event
    // stamped with the prefixed status id. Absent → reconcile falls back to
    // machineId only.
    statusInstanceId?: string;
    // One live seqscribe node per daemon process. Opening is fail-soft so a DB
    // or native-addon failure never prevents the rest of the daemon booting.
    seqscribeNode?: SeqscribeNodeHandle;
    // Stage 1 convergence probe (seqscribe/probe.ts). Null in provisional mode
    // (no fleet secret → no content topics → nothing to probe).
    seqscribeProbe?: ProbeHandle | null;
    // Stage 3 parity loop (mesh/mesh-parity-loop.ts). Null when the Stage 2
    // dual-write shadow is off — with nothing written there is nothing to compare.
    seqscribeParityLoop?: MeshParityLoopHandle | null;
    // The single `node.stats()` reader (seqscribe/throughput-collector.ts).
    // Everything else reads its published snapshot.
    seqscribeCollector?: SeqscribeThroughputCollector;
    /**
     * The armed Beacon, once a host has armed one (design §7.1, mission b60d70b8).
     *
     * ★ WRITTEN BY THE HOST, NOT BY THIS MODULE. The beacon needs a transport
     * that only the cloud daemon has (a WS bridge), and it is armed on the first
     * AUTHENTICATED EPOCH — long after `initDaemonComponents` returns. So this
     * is a slot the host fills (`armSeqscribeBeacon` in daemon-cloud), which is
     * what lets the router's `getBeaconDiagnostics` closure below read it at
     * call time.
     *
     * Stays undefined on standalone, which never arms a beacon — and that is
     * the whole "transport absent → not started" contract (§7.1.6), not a gap.
     *
     * Typed structurally rather than as `BeaconHandle` so this interface does
     * not drag the beacon module into every consumer of DaemonComponents.
     */
    seqscribeBeacon?: { diagnostics(): BeaconDiagnostics } | null;
}

export interface DaemonDevSupportOptions {
    components: DaemonComponents;
    logFn?: (msg: string) => void;
}

export interface DaemonSeqscribeBootOptions {
    daemonId?: string;
    env?: NodeJS.ProcessEnv;
    /** Test override; production always uses the config-dir default. */
    dbPath?: string;
}

/** Open the daemon-owned node without turning replication failure into boot failure. */
export function tryOpenDaemonSeqscribeNode(
    options: DaemonSeqscribeBootOptions = {},
): SeqscribeNodeHandle | undefined {
    const env = options.env ?? process.env;
    try {
        return openSeqscribeNode({
            daemonId: options.daemonId,
            ...(options.dbPath ? { dbPath: options.dbPath } : {}),
            env,
            storedFleetSecret: loadStoredFleetSecret(env)?.secret ?? null,
        });
    } catch (error) {
        LOG.warn(
            'Seqscribe',
            `node unavailable; daemon will continue without replication: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
    }
}

// ─── Init ───

/**
 * Initialize all daemon core components.
 *
 * Order:
 *   1. Global log interceptor
 *   2. ProviderLoader
 *   3. InstanceManager + CliManager
 *   4. Detect IDEs
 *   5. CdpInitializer → connectAll + periodic scan + discovery
 *   6. CommandHandler + AgentStreamManager
 *   7. Router + Poller
 *   8. Start instance ticking
 */
export async function initDaemonComponents(config: DaemonInitConfig): Promise<DaemonComponents> {
    // 0. Process-level hardening (must run before any provider script is loaded).
    //    Freezes built-in prototypes (Object/Array/Function/String/Number/Boolean/Promise)
    //    and shadows process.exit/kill/abort/binding/dlopen so provider-script callers
    //    throw instead of killing the daemon. See ./process-hardening.ts for details.
    applyProcessHardening();
    installProviderProcessShim();

    // 1. Global log interceptor
    installGlobalInterceptor();
    loadMeshCoordinatorRegistry();

    // 1.5 Post-restart rollback visibility. The detached upgrade helper leaves
    // `daemon-upgrade-last-error.txt` on failure and removes it only after a
    // successful install/re-spawn, so a notice still present at boot means the
    // LAST upgrade attempt failed and THIS daemon was rolled back to (or left
    // on) the previous version. Say so loudly: the schedule-time command
    // response went out long before the helper failed, so this boot log (plus
    // get_status_metadata.upgradeFailure) is the only in-band signal that the
    // "upgrade" never actually happened.
    //
    // The notice is durable and NOT self-expiring, so this line re-prints on
    // EVERY boot until an upgrade succeeds and clears it. Without age, a
    // days-old failure reads exactly like one that just happened — a reader who
    // has already recovered sees this warning and concludes the upgrade failed
    // AGAIN. So state when it was recorded and which version it targeted, and
    // say plainly when that target is not the version now running: that
    // combination is the signal that this is stale evidence, not a new failure.
    const upgradeFailureNotice = readUpgradeFailureNotice();
    if (upgradeFailureNotice) {
        const age = upgradeFailureNotice.ageLabel
            ? `${upgradeFailureNotice.ageLabel}, recorded ${upgradeFailureNotice.recordedAt}`
            : 'recorded at an unknown time';
        const target = upgradeFailureNotice.targetVersion
            ? `, attempted target v${upgradeFailureNotice.targetVersion}`
            : '';
        const running = (config.statusVersion || '').trim().replace(/^v/, '');
        const supersededHint = upgradeFailureNotice.targetVersion
            && running
            && upgradeFailureNotice.targetVersion.replace(/^v/, '') !== running
            ? ` This notice targets a DIFFERENT version than the one now running (v${running}) — it is most likely a stale record of an earlier attempt, not a report about this boot.`
            : '';
        LOG.warn('Upgrade', `Previous daemon upgrade FAILED and was rolled back — this daemon is running the previous version. Notice (${age}${target}) at ${upgradeFailureNotice.noticePath}:\n${upgradeFailureNotice.notice}${supersededHint}`);
    }

    // 2. ProviderLoader (provider source mode + channel from config.json)
    // One-shot migration first: record the effective provider channel as an
    // explicit config.providerChannel so the legacy updateChannel fallback
    // (resolveProviderChannel priority 4) can eventually be removed without
    // silently flipping any machine's channel. Best-effort — never block boot.
    try {
        const { migrateProviderChannelConfig } = await import('../providers/channel/channel-migration.js');
        const migration = migrateProviderChannelConfig();
        if (migration.migrated) {
            LOG.info('Providers', `Recorded explicit providerChannel=${migration.channel} in config (migrated from build-track/updateChannel derivation)`);
        }
    } catch { /* best-effort — the resolver's fallback chain still applies */ }
    const appConfig = loadConfig();
    const providerSourceMode = appConfig.providerSourceMode || 'normal';
    const disableUpstream = providerSourceMode === 'no-upstream';
    const providerLoader = new ProviderLoader({
        logFn: config.providerLogFn,
        // Shared config projection — keeps this site, launch.ts, and the CLI
        // factory from drifting (the launch path once dropped userDir/sourceMode).
        ...providerLoaderConfigOptions(appConfig),
        // The boot path resolves sourceMode with an explicit 'normal' default
        // for the disableUpstream derivation above — keep that authoritative.
        sourceMode: providerSourceMode,
        // Enables the daemon-update = provider-activation stamp (option C):
        // a boot on a NEW daemon version runs one verified sync; same-version
        // boots stay network-free.
        daemonVersion: config.statusVersion,
    });

    // Boot-time auto-sync is intentionally limited to the bounded first-sync
    // below (empty channel store only). A fresh install has an empty store
    // AND an empty .upstream, so the first-sync bootstraps the whole verified
    // channel from the registry — the earlier "daemon ships empty, user
    // installs via dashboard" design left new users at 0 providers and unable
    // to run anything. After the bootstrap, the user still picks which
    // additional providers to install via the dashboard onboarding /
    // Providers tab. Manual sync is still available via the install /
    // check_provider_updates commands (and the REST endpoint at
    // /api/v1/providers/updates).
    providerLoader.loadAll();
    providerLoader.registerToDetector();

    // 2.0.1 Config-dir/provider-channel axis warning. These two axes normally
    // move together (both derive from the build-track stamp), but
    // ADHDEV_CONFIG_DIR only overrides the config-dir PATH — it feeds no
    // signal into resolveProviderChannel — so a config dir that LOOKS like
    // one track can silently resolve providers on the other track's channel
    // (e.g. a preview session-host child re-run under `tsx`, which has no
    // `__ADHDEV_BUILD_CHANNEL__` bundler define). Informational only: never
    // changes channel/provider resolution, and stays silent whenever the
    // divergence is explained by an explicit signal (config.providerChannel,
    // ADHDEV_PROVIDER_CHANNEL env, or a preview updateChannel) rather than by
    // this axis decoupling.
    const hasExplicitChannelSignal = Boolean(
        (appConfig.providerChannel && appConfig.providerChannel.trim())
        || (process.env[PROVIDER_CHANNEL_ENV_VAR] ?? '').trim()
        || isPreviewReleaseChannel(appConfig.updateChannel),
    );
    const resolvedConfigDir = getConfigDir();
    const channelMismatch = configDirChannelMismatch(resolvedConfigDir, providerLoader.channel, hasExplicitChannelSignal);
    if (channelMismatch) {
        LOG.warn('Init', `Config dir looks like the ${channelMismatch.impliedTrack} track (${resolvedConfigDir}) but the resolved provider channel is '${channelMismatch.channel}'. This usually means the build-track stamp (__ADHDEV_BUILD_CHANNEL__) was absent for this process — e.g. running via tsx/ts-node instead of a built bundle — so provider-channel resolution fell through to its 'stable' default instead of following ADHDEV_CONFIG_DIR. Impact: providers installed under the OTHER channel's store will not be visible (can present as 0 providers loaded). Fix: set ADHDEV_PROVIDER_CHANNEL=${channelMismatch.impliedTrack} (or config.providerChannel) explicitly for this process, or run the built bundle instead of source.`);
    }

    // 2.1 Verified-channel first sync. When the resolved provider channel has
    // an EMPTY store, run one bounded verified sync so channel
    // switch/upgrade/setup/restart/fresh-install paths — which all converge
    // on this boot — activate the channel without any manual step. Gated
    // inside maybeFirstSyncVerifiedChannel: non-empty stores (last-known-good)
    // never touch the network here, and no status path performs network calls.
    // Fire-and-forget so a slow/unreachable registry never delays boot.
    // Fail-closed: errors keep the previous (possibly empty) store and retry
    // on next boot.
    void providerLoader.maybeFirstSyncVerifiedChannel()
        .then(async (report) => {
            if (!report) return null;
            if (report.status === 'error') {
                LOG.warn('Init', `Verified channel first-sync failed (last-known-good preserved): ${report.errors.map((e) => e.code).join(', ') || 'unknown'}`);
            } else if (report.activated.length > 0) {
                LOG.info('Init', `Verified channel first-sync activated ${report.activated.length} providers (${providerLoader.channel})`);
                // The sync's own loadAll() (provider-loader.ts) just cleared
                // providerAvailability, so any provider enabled before this
                // sync landed with no lastDetection yet reads back as
                // 'enabled_unchecked' until the next manual/dev re-detect.
                // Re-run detection now so first-boot enables resolve to
                // detected/not_detected instead of sitting unchecked forever.
                providerLoader.registerToDetector();
                await refreshProviderAvailability();
                config.onStatusChange?.();
            }
            return report;
        })
        // 2.2 Daemon-update activation (owner decision 2026-08-10, option C):
        // chained AFTER the first-sync so the two verified syncs never run
        // concurrently. No-op unless the store is non-empty AND the daemon
        // version stamp differs (first boot of a new daemon version / channel
        // switch) — every same-version boot stays network-free, preserving
        // the pin design's boot contract. Fail-closed like the first-sync.
        .then(async (firstSyncReport) => {
            if (firstSyncReport) return; // first-sync ran — its success already stamped this version
            const report = await providerLoader.maybeSyncVerifiedChannelOnDaemonUpdate();
            if (!report) return;
            if (report.status === 'error') {
                LOG.warn('Init', `Daemon-update channel sync failed (last-known-good preserved, retries next boot): ${report.errors.map((e) => e.code).join(', ') || 'unknown'}`);
            } else if (report.activated.length > 0) {
                LOG.info('Init', `Daemon-update channel sync activated ${report.activated.length} providers (${providerLoader.channel})`);
                providerLoader.registerToDetector();
                await refreshProviderAvailability();
                config.onStatusChange?.();
            }
        })
        .catch((e: any) => LOG.warn('Init', `Verified channel boot sync error: ${e?.message || e}`));

    // 2.3 Verified-channel staleness probe (owner decision 2026-08-10, option A):
    // a read-only channel listing (one request, no downloads, no pointer
    // writes) 10 minutes after boot and every 24h, so dashboards can badge
    // stale pins and never-installed new types without the user opening the
    // Providers tab. Deliberately NOT on the boot path and never from a
    // status path; activation itself stays explicit (activate_provider_updates)
    // plus the daemon-update ride-along above.
    const runStalenessProbe = async () => {
        try {
            const snap = await providerLoader.checkVerifiedChannelStaleness();
            if (snap.error) {
                LOG.debug('Provider', `Channel staleness probe failed (kept previous snapshot): ${snap.error}`);
            } else if (snap.staleTypes.length > 0 || snap.newTypes.length > 0) {
                LOG.info('Provider', `Channel staleness: ${snap.staleTypes.length} stale [${snap.staleTypes.join(', ')}], ${snap.newTypes.length} never-installed [${snap.newTypes.join(', ')}] (${snap.channel})`);
                config.onStatusChange?.();
            }
        } catch (e: any) {
            LOG.debug('Provider', `Channel staleness probe error: ${e?.message || e}`);
        }
    };
    const stalenessInitialTimer = setTimeout(() => { void runStalenessProbe(); }, 10 * 60_000);
    stalenessInitialTimer.unref?.();
    const stalenessIntervalTimer = setInterval(() => { void runStalenessProbe(); }, 24 * 60 * 60_000);
    stalenessIntervalTimer.unref?.();
    const providerStalenessProbe = {
        stop() {
            clearTimeout(stalenessInitialTimer);
            clearInterval(stalenessIntervalTimer);
        },
    };
    // Register this loader as the default for loader-less provider-version reads.
    // The coordinator's own self/worktree node self-heal (mesh-node-identity.ts) reads
    // getCachedProviderVersions() with no loader in scope; without this the detection
    // list is empty and the self node's provider-version chips never populate, even
    // though remote nodes (which self-report via the git_status envelope) do.
    setDefaultProviderLoader(providerLoader);

    // 2.5 Provider version detection & archive
    // Run after startup work continues. The detector still performs expensive
    // version probing, so invoking it directly here would block daemon init.
    const versionArchive = new VersionArchive();
    providerLoader.setVersionArchive(versionArchive);
    setTimeout(() => {
        void detectAllVersions(providerLoader, versionArchive)
            .then((versionResults) => {
                const installedProviders = versionResults.filter(v => v.installed);
                const withVersion = installedProviders.filter(v => v.version);
                LOG.info('Init', `Provider versions: ${installedProviders.length} installed, ${withVersion.length} versioned`);
                for (const v of withVersion) {
                    LOG.info('Init', `  ${v.type} (${v.category}): v${v.version}${v.warning ? ' ⚠ ' + v.warning : ''}`);
                }
                const noVersion = installedProviders.filter(v => !v.version);
                if (noVersion.length > 0) {
                    LOG.warn('Init', `  ${noVersion.length} installed but version unknown: ${noVersion.map(v => v.type).join(', ')}`);
                }
            })
            .catch(() => {});
    }, 0);

    // 3. Shared state
    const instanceManager = new ProviderInstanceManager();
    const cdpManagers = new Map<string, DaemonCdpManager>();
    const sessionRegistry = new SessionRegistry();
    // Transcript-claim liveness (Stage 4): a claim held by a session that is no
    // longer registered is demonstrably dead and safely reclaimable; a claim
    // held by a REGISTERED session is never stolen, even past the time-based
    // stale window (an idle live session may not refresh for a long time).
    // Owner tokens are iid:<sessionId>; any other form is treated as live.
    setTranscriptClaimLivenessProbe((owner: string) => {
        const match = /^iid:(.+)$/.exec(owner);
        if (!match) return true;
        return sessionRegistry.get(match[1]) !== undefined;
    });
    const detectedIdesRef: { value: IDEInfo[] } = { value: [] };
    let agentStreamManager: DaemonAgentStreamManager | null = null;
    let poller: AgentStreamPoller | null = null;

    const refreshProviderAvailability = async (providerType?: string) => {
        const targetProvider = providerType ? providerLoader.getMeta(providerLoader.resolveAlias(providerType)) : null;
        const targetCategory = targetProvider?.category;

        if (!providerType || targetCategory === 'cli' || targetCategory === 'acp') {
            if (providerType && targetProvider) {
                const detected = await detectCLI(targetProvider.type, providerLoader, { includeVersion: false });
                providerLoader.setCliDetectionResults([{
                    id: targetProvider.type,
                    installed: !!detected,
                    path: detected?.path,
                }], false);
            } else {
                providerLoader.setCliDetectionResults(await detectCLIs(providerLoader, { includeVersion: false }), true);
            }
        }

        if (!providerType || targetCategory === 'ide') {
            detectedIdesRef.value = await detectIDEs(providerLoader);
            providerLoader.setIdeDetectionResults(detectedIdesRef.value, true);
        }
    };

    // 4. CLI Manager
    const cliManager = new DaemonCliManager({
        ...config.cliManagerDeps,
        getInstanceManager: () => instanceManager,
        getSessionRegistry: () => sessionRegistry,
    }, providerLoader);

    // 5. Detect IDEs
    LOG.info('Init', 'Detecting IDEs...');
    await refreshProviderAvailability();
    const installed = detectedIdesRef.value.filter((i) => i.installed);
    LOG.info('Init', `Found ${installed.length} IDE(s): ${installed.map((i) => i.id).join(', ') || 'none'}`);

    // 6. CDP Initializer — connect + register instances
    const cdpSetupContext: CdpSetupContext = {
        providerLoader,
        instanceManager,
        cdpManagers,
        sessionRegistry,
    };

    const cdpInitializer = new DaemonCdpInitializer({
        providerLoader,
        cdpManagers,
        enabledIdes: config.enabledIdes || loadConfig().enabledIdes || undefined,
        onConnected: async (ideType, manager, managerKey) => {
            // Register IDE instance (shared logic)
            await setupIdeInstance(cdpSetupContext, { ideType, manager, managerKey });
            // Transport-specific extras
            await config.onCdpManagerSetup?.(ideType, manager, managerKey);
        },
        onDisconnected: async (_ideType, _manager, managerKey) => {
            sessionRegistry.unregisterByManagerKey(managerKey);
            const instanceKey = `ide:${managerKey}`;
            const ideInstance = instanceManager.getInstance(instanceKey) as IdeProviderInstance | undefined;

            if (ideInstance) {
                instanceManager.removeInstance(instanceKey);
                LOG.info('IDE', `Instance removed after detach: ${instanceKey}`);
            }

            if (ideInstance?.getInstanceId) {
                agentStreamManager?.resetParentSession(ideInstance.getInstanceId());
            }
            config.onStatusChange?.();
        },
    });
    await cdpInitializer.connectAll(detectedIdesRef.value);
    cdpInitializer.startPeriodicScan(config.cdpScanIntervalMs ?? DEFAULT_CDP_SCAN_INTERVAL_MS);
    cdpInitializer.startDiscovery(DEFAULT_CDP_DISCOVERY_INTERVAL_MS);

    // 7. CommandHandler
    const commandHandler = new DaemonCommandHandler({
        cdpManagers,
        ideType: 'unknown',
        adapters: cliManager.adapters,
        providerLoader,
        instanceManager,
        sessionRegistry,
        gitCommandServices: createDefaultGitCommandServices({
            // T7: fold this daemon's cached provider versions + build version onto the
            // git_status envelope so the mesh coordinator self-heals each node's
            // providerVersions/build (the blue version chips) — these are per-machine
            // RUNTIME facts (e.g. this node has claude-cli@2.1.168 while the
            // coordinator has @2.1.170), so they stay reported. Non-blocking: reads a
            // TTL cache, lazily refreshed. (setDefaultProviderLoader is registered
            // above so getCachedProviderVersions is not empty — see the 380556d3
            // version-chip lesson.)
            //
            // Slots are NOT reported: they are coordinator-owned config
            // (node.policy.slots for every node, resolved via
            // resolveNodeCapabilitySlots), not a per-machine runtime fact — the
            // reporter round-trip for slots was removed (REMOTE-NODE-SLOTS-
            // COORDINATOR-LOCAL fix).
            getReporterProviderVersions: () => {
                const providerVersions = getCachedProviderVersions(providerLoader);
                const daemonBuildVersion = getDaemonBuildInfo().version;
                return {
                    ...(Object.keys(providerVersions).length > 0 ? { providerVersions } : {}),
                    ...(daemonBuildVersion && daemonBuildVersion !== 'unknown' ? { daemonBuildVersion } : {}),
                };
            },
        }),
        onProviderSettingChanged: async (providerType) => {
            await refreshProviderAvailability(providerType);
            config.onStatusChange?.();
        },
        onProviderSourceConfigChanged: async () => {
            await refreshProviderAvailability();
            config.onStatusChange?.();
        },
        onBeforeSendChat: config.onBeforeSendChat,
    });

    // 8. AgentStreamManager
    agentStreamManager = new DaemonAgentStreamManager(
        LOG.forComponent('AgentStream').asLogFn(),
        providerLoader,
        sessionRegistry,
    );
    commandHandler.setAgentStreamManager(agentStreamManager);

    // 9. Router + Poller (with internal cross-wiring)
    // Note: poller is declared first so router's onIdeConnected closure captures it
    //
    // The seqscribe node opens at step 10a, AFTER the router is constructed, so
    // `getSeqscribeStats` below closes over this holder rather than the handle.
    // Reading at call time is required anyway: the stats are live numbers, not
    // a wiring-time snapshot.
    let seqscribeNodeRef: SeqscribeNodeHandle | undefined;
    // ★ The daemon's ONLY caller of `node.stats()`. Since library P24 that call
    // DRAINS the interval throughput counters, so a second caller silently
    // steals part of every interval and every reader's numbers become wrong by
    // an unknowable factor. The collector ticks on its own cadence and
    // publishes a snapshot; everything else — including the closure below —
    // reads the snapshot, which is a pure getter.
    // See seqscribe/throughput-collector.ts.
    let seqscribeCollector: SeqscribeThroughputCollector | undefined;
    // Same holder trick as `seqscribeNodeRef` above, one step later: the beacon
    // is armed by the HOST after this function returns, so the router's
    // `getBeaconDiagnostics` closure cannot capture a value — it captures the
    // components object and reads the slot at call time.
    let componentsRef: DaemonComponents | undefined;
    const router = new DaemonCommandRouter({
        commandHandler,
        cliManager,
        cdpManagers,
        providerLoader,
        instanceManager,
        detectedIdes: detectedIdesRef,
        sessionRegistry,
        onCdpManagerCreated: async (ideType: string, manager: DaemonCdpManager) => {
            // For launch_ide: register instance + extension providers
            await setupIdeInstance(cdpSetupContext, { ideType, manager });
            await config.onCdpManagerSetup?.(ideType, manager, ideType);
        },
        onIdeConnected: () => poller?.start(),
        onStatusChange: config.onStatusChange,
        onMeshStateChange: config.onMeshStateChange,
        onPostChatCommand: config.onPostChatCommand,
        sessionHostControl: config.sessionHostControl,
        statusInstanceId: config.statusInstanceId,
        statusVersion: config.statusVersion,
        getMeshPeerConnectionStatus: config.getMeshPeerConnectionStatus,
        dispatchMeshCommand: config.dispatchMeshCommand,
        updateLocalMeshOwnedSession: config.updateLocalMeshOwnedSession,
        getCdpLogFn: config.getCdpLogFn || ((ideType: string) => LOG.forComponent(`CDP:${ideType}`).asLogFn()),
        // Local read surface for replication health (get_status_metadata).
        // Aggregate-only by construction — summarizeSeqscribeStats is the same
        // allow-list projection the status report uses, and nothing here
        // touches the status_report payload itself.
        getSeqscribeStats: () => {
            if (!seqscribeNodeRef) return null;
            try {
                // Stage 2+3 counters ride the same aggregate-only projection:
                // summarizeSeqscribeStats buckets them, so nothing here is a
                // live counter and the status-frame dedup keeps working.
                const dual = meshDualWriteCounters();
                const parity = meshParityCounters();
                // ★ Read the collector's PUBLISHED snapshot — never
                // `node.stats()`, and never `collector.collect()` either.
                //
                // This closure is called by the status reporter (~30s) AND by
                // `get_status_metadata` (on demand). Forcing a collect here
                // would cut the interval at those arbitrary moments — the exact
                // interval fragmentation the collector exists to prevent, just
                // relocated. Only the collector's own timer advances the
                // interval; this is a pure read of whatever it last published.
                //
                // Cost: the numbers are up to one tick stale. That is the
                // correct trade — a coherent interval that is a minute old is
                // useful, a fragmented one is not.
                const snapshot = seqscribeCollector?.snapshot() ?? null;
                if (!snapshot) return null;
                return summarizeSeqscribeStats(snapshot.stats, {
                    authorityEnabled: seqscribeNodeRef.authorityEnabled,
                    // Local surface: `get_status_metadata` and the status
                    // reporter share this closure, but the cloud projection
                    // (buildCloudSeqscribeSummary) is a fixed-key allow-list
                    // that drops every field below, so these never reach the
                    // server. syncHotspots in particular carries topic names
                    // and peer ids and is local-only by contract.
                    includeLocalDiagnostics: true,
                    throughput: snapshot,
                    dualWrite: {
                        active: isMeshDualWriteActive(),
                        failed: dual.failed,
                        dropped: dual.dropped,
                        backfilled: dual.backfilled,
                    },
                    parity: {
                        runs: parity.runs,
                        mismatches: parity.mismatches,
                        persistentMismatches: parity.persistentMismatches,
                        missingInShadow: parity.missingInShadow,
                        extraInShadow: parity.extraInShadow,
                        fieldMismatch: parity.fieldMismatch,
                    },
                });
            } catch (error) {
                LOG.warn(
                    'Seqscribe',
                    `stats unavailable for get_status_metadata: ${error instanceof Error ? error.message : String(error)}`,
                );
                return null;
            }
        },
        // Beacon staleness / sole-copy for `get_status_metadata` (§7.1, mission
        // b60d70b8). A getter for the same reason as getSeqscribeStats — but
        // one level more so: the beacon is armed by the HOST on its first
        // authenticated epoch, long after this router is constructed, so the
        // closure reads `components.seqscribeBeacon` at call time.
        //
        // ★Unlike getSeqscribeStats above, the value here DOES carry topic
        // names and peer writer ids. That is the feature, and it is why it is
        // exposed on this LOCAL surface (and the P2P payload) only — never on
        // status_report. `buildCloudSeqscribeSummary` is a fixed-key allow-list
        // that could not forward it even by accident.
        //
        // `diagnostics()` performs no I/O: it reads the last board the beacon
        // captured, so an on-demand `get_status_metadata` cannot turn into a
        // Beacon traffic source (§7.1.2's idle-silence property).
        getBeaconDiagnostics: () => {
            const beacon = componentsRef?.seqscribeBeacon;
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
    });

    poller = new AgentStreamPoller({
        agentStreamManager,
        providerLoader,
        instanceManager,
        cdpManagers,
        sessionRegistry,
        onStreamsUpdated: config.onStreamsUpdated,
    });
    poller.start();

    // 10. Start instance ticking
    instanceManager.startTicking(config.tickIntervalMs ?? 5_000);

    const components: DaemonComponents = {
        providerLoader,
        instanceManager,
        cliManager,
        commandHandler,
        agentStreamManager,
        router,
        poller,
        cdpInitializer,
        cdpManagers,
        sessionRegistry,
        detectedIdes: detectedIdesRef,
        refreshProviderAvailability,
        dispatchMeshCommand: config.dispatchMeshCommand,
        getMeshPeerConnectionStatus: config.getMeshPeerConnectionStatus,
        onMeshCoordinatorEventForwarded: config.onMeshCoordinatorEventForwarded,
        statusInstanceId: config.statusInstanceId,
    };
    // Publish to the holder the router's getBeaconDiagnostics closure reads.
    componentsRef = components;

    // 10a. Open the process-wide seqscribe node. The auth_ok-delivered fleet
    // secret is read explicitly here and passed as the stored fallback; the
    // authority resolver inside openSeqscribeNode still gives the environment
    // override first priority. Any failure is non-fatal by contract (node.ts):
    // later status/transport wiring simply observes an absent node.
    components.seqscribeNode = tryOpenDaemonSeqscribeNode({ daemonId: config.statusInstanceId });
    // Publish to the holder the router's getSeqscribeStats closure reads.
    seqscribeNodeRef = components.seqscribeNode;

    // Start the throughput collector — the process's single `node.stats()`
    // reader (library P24 drains the interval counters on every read, so any
    // second reader corrupts everyone's numbers; see throughput-collector.ts).
    // Every other consumer reads `snapshot()`.
    if (components.seqscribeNode) {
        try {
            const node = components.seqscribeNode;
            seqscribeCollector = startSeqscribeThroughputCollector({
                readStats: () => node.node.stats(),
            });
            // Prime it once so `get_status_metadata` and the first status
            // report have a snapshot to read instead of null for a full tick.
            seqscribeCollector.collect();
            components.seqscribeCollector = seqscribeCollector;
            // The mesh read-readiness gate reads seqscribe stats too; point it
            // at the collector so it also stops calling stats() directly.
            configureMeshReadReadinessCollector(seqscribeCollector);
        } catch (error) {
            LOG.warn(
                'Seqscribe',
                `throughput collector unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    // 10b. Stage 1 convergence probe. Until now nothing in the daemon appended
    // to or consumed from a topic, so a correctly wired fleet and a broken one
    // produced identical logs (silence). This appends one small record and logs
    // records other daemons wrote, making live convergence greppable. Returns
    // null in provisional mode; never throws (seqscribe/probe.ts).
    if (components.seqscribeNode) {
        try {
            components.seqscribeProbe = startConvergenceProbe(components.seqscribeNode, {
                version: config.statusVersion ?? getDaemonBuildInfo().version,
                bootId: currentRefineExecutorBootId(),
            });
        } catch (error) {
            LOG.warn(
                'Seqscribe',
                `convergence probe unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    // 10c. Phase 2 Stage 2+3: arm the mesh ledger dual-write SHADOW leg and the
    // parity loop that compares it against the ledger.
    //
    // Ordering matters: configureMeshDualWrite must run BEFORE the parity loop
    // starts (the loop returns null unless the shadow is active) and before any
    // ledger append — appends before this point simply do not shadow, which is
    // also why the loop records `armedAt` and ignores older entries.
    //
    // Stage 4A additionally wires the materialized READ MODEL. Attaching it is
    // unconditional and cheap — it registers no consumer until a mesh is first
    // queried — while whether any read is actually SERVED from it depends on
    // `ADHDEV_SEQSCRIBE_MESH=primary` plus the per-mesh readiness gate
    // (seqscribe/mesh-read-readiness.ts). Under the default `shadow` mode this
    // wiring changes no behaviour at all.
    try {
        configureMeshDualWrite(components.seqscribeNode ?? null);
        configureMeshReadModel(components.seqscribeNode ?? null);
        // Phase 4 Stage 1: arm the fleet.status producer shadow. Now defaults
        // ON like the mesh leg (ADHDEV_SEQSCRIBE_FLEET_STATUS=off opts out):
        // Stage 3 parity below is a live consumer of the ring append, so the
        // original "no consumer yet" reason to default off no longer holds.
        configureFleetStatusShadow(components.seqscribeNode ?? null);
        // Phase 4 Stage 3: the checker only arms when the shadow call above
        // resolved to `shadow`, which is now the default — the parity loop
        // arms fleet-wide unless a daemon explicitly opts out.
        configureFleetStatusParity(components.seqscribeNode ?? null);
        if (components.seqscribeNode) {
            // GC durable cursors older builds left behind: pre-P17 read-model
            // generation names (`…#2`) and pre-P21 per-sweep parity nonces.
            // Each one holds the topic's §7.6 archive floor open until removed,
            // and nothing in the current code path creates either any more.
            // Runs BEFORE the parity loop arms so the first sweep sees a clean
            // consumer set. Best-effort by construction — see the function.
            pruneStaleConsumersAtBoot();
            components.seqscribeParityLoop = startMeshParityLoop(components.seqscribeNode);
        }
    } catch (error) {
        LOG.warn(
            'Seqscribe',
            `mesh dual-write/parity unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    // 11. Setup Mesh Event Forwarding (queue persistence) + periodic reconcile loop.
    // injectMeshSystemMessage now ONLY persists events to the pending-events queue;
    // the reconcile loop drains that queue on a fixed interval and injects into live
    // CLI coordinators when idle (and, in cloud mode, pulls remote worker daemons'
    // queues over P2P). This is the single-model (queue + polling) replacement for the
    // old spontaneous-forward push paths.
    setupMeshEventForwarding(components);
    // 11a. One-shot: drain any leftover legacy `*.pending-events.jsonl` into the SQLite
    // inbox. MUST run BEFORE setupMeshReconcileLoop — that loop drives the disk
    // retention sweep, whose pruneExpiredLedgerJsonl deletes `*.jsonl` at 30 days
    // WITHOUT draining, so a machine upgrading past the JSONL cut would silently lose
    // every event still queued at upgrade time.
    try { migratePendingEventsJsonlToSqlite(); } catch { /* best-effort — never block boot */ }
    components.meshReconcileLoop = setupMeshReconcileLoop(components);
    // 11b. Periodic quota refresh. Writes the cache that buildLocalNodeFacts
    // reads; the builder never fetches, so mesh_status stays as cheap as it
    // was. The snapshots are no longer observation-only: quota-aware routing
    // (mesh-quota-routing.ts) consumes them for the launch/claim GATE and the
    // fitness SPREAD bonus — always from this cache, never by fetching inline.
    components.quotaRefreshLoop = setupQuotaRefreshLoop(components);
    // 11b-2. Event-driven complement: refetch JUST the provider whose agent
    // finished a turn, so the post-turn reading lands within seconds instead
    // of up to one refresh interval. Same enable gate as the periodic loop.
    components.quotaEventRefresh = setupQuotaEventRefresh(components);
    // 11b-3. Verified-channel staleness probe handle (timers armed in step 2.3).
    components.providerStalenessProbe = providerStalenessProbe;
    // 11c. Restore the last persisted snapshots, then fire the one-shot boot
    // refresh. Both are deferred past this function's return and neither is
    // awaited — a ~900ms codex app-server spawn must not add to daemon startup
    // latency, and neither must a file read.
    //
    // Hydration runs FIRST so a restart shows its last known numbers
    // immediately rather than an empty "never reported" state; the boot refresh
    // then replaces them with fresh ones (and is skipped entirely when the
    // cache is already populated, saving a spawn per restart). A freshly booted
    // daemon has no recent CLI activity BY DEFINITION, so that refresh
    // deliberately bypasses the idle gate the periodic loop applies — see
    // refreshQuotaCacheOnBoot.
    setImmediate(() => {
        // The enable gate (machineProviders[type].enabled via ProviderLoader)
        // is the SAME authority cli-manager and mesh-queue-assignment launch
        // on: a provider this machine cannot run is never probed for quota.
        const isQuotaProviderEnabled = quotaProviderEnabledFromLoader(components.providerLoader);
        try { hydrateQuotaCacheFromDisk(process.env, isQuotaProviderEnabled); } catch { /* fail-soft: an unusable cache is just an empty one */ }
        refreshQuotaCacheOnBoot(isQuotaProviderEnabled);
    });

    // 12. Resume any refine jobs that were interrupted by a previous daemon restart.
    setImmediate(() => void router.resumePendingRefineJobsOnStartup());

    // 12a. EVENT-LOOP-LAG-HEARTBEAT: start the event-loop-lag sampler AFTER the
    // logger is installed (step 1) so a post-freeze WARN lands in the dated
    // daemon log. Unref'd, never throws, 10s interval / 5s WARN threshold.
    components.eventLoopMonitor = startEventLoopMonitor();

    // 13. Re-arm any persisted restart_daemon_node whenIdle schedules that were
    // pending when this daemon last exited (expired ones are audited + dropped).
    setImmediate(() => router.resumeDeferredRestartsOnStartup());

    return components;
}

/**
 * Start shared dev-only helpers:
 * - DevServer on port 19280
 * - Provider hot-reload watcher
 */
export async function startDaemonDevSupport(options: DaemonDevSupportOptions): Promise<DevServer> {
    const devServer = new DevServer({
        providerLoader: options.components.providerLoader,
        cdpManagers: options.components.cdpManagers,
        instanceManager: options.components.instanceManager,
        cliManager: options.components.cliManager,
        logFn: options.logFn,
        onProviderSourceConfigChanged: async () => {
            await options.components.refreshProviderAvailability();
        },
    });
    await devServer.start();
    options.components.providerLoader.watch();
    return devServer;
}

// ─── Shutdown ───

/**
 * Graceful shutdown of all daemon components.
 *
 * Order:
 *   1. Stop timers (poller, cdpInitializer)
 *   2. Dispose agent stream
 *   3. Shutdown CLIs
 *   4. Dispose instances
 *   5. Disconnect CDPs
 */
export async function shutdownDaemonComponents(components: DaemonComponents): Promise<void> {
    const {
        poller, cdpInitializer, agentStreamManager,
        cliManager, instanceManager, cdpManagers,
        meshReconcileLoop, quotaRefreshLoop, quotaEventRefresh, providerStalenessProbe,
        eventLoopMonitor, seqscribeNode, seqscribeProbe, seqscribeParityLoop,
        seqscribeCollector,
    } = components;

    // 1. Stop timers
    poller.stop();
    cdpInitializer.stop();
    try { eventLoopMonitor?.stop(); } catch { /* noop */ }
    try { meshReconcileLoop?.stop(); } catch { /* noop */ }
    try { quotaRefreshLoop?.stop(); } catch { /* noop */ }
    try { quotaEventRefresh?.stop(); } catch { /* noop */ }
    try { providerStalenessProbe?.stop(); } catch { /* noop */ }
    // Stop the convergence probe here, with the other timers — its append and
    // its consumer must both be quiet before step 7 closes the node underneath
    // them, or a tick races the close.
    try { seqscribeProbe?.stop(); } catch { /* noop */ }
    // The throughput collector reads `node.stats()` on a timer, so it must stop
    // before step 7 closes the node — a tick landing after the close would read
    // a released store.
    try { seqscribeCollector?.stop(); } catch { /* noop */ }
    try { configureMeshReadReadinessCollector(null); } catch { /* noop */ }
    // Same reasoning for the parity loop, and additionally detach the dual-write
    // shadow so any ledger append during the rest of shutdown becomes a no-op
    // rather than an append into a node that step 7 is about to close.
    try { seqscribeParityLoop?.stop(); } catch { /* noop */ }
    try { configureMeshDualWrite(null); } catch { /* noop */ }
    // Detach the fleet parity timer before its producer/node. This also drops
    // its retained WS expectations before shutdown can observe an old producer
    // snapshot.
    try { configureFleetStatusParity(null); } catch { /* noop */ }
    // Same for the fleet.status leg — a status tick racing shutdown must not
    // append into a node step 7 is about to close.
    try { configureFleetStatusShadow(null); } catch { /* noop */ }
    // Detach the read model too, so its per-mesh onEntry consumers are
    // unsubscribed before step 7 closes the node. A consumer still registered
    // when the node closes would touch the store after the owner lock released.
    try { configureMeshReadModel(null); } catch { /* noop */ }

    // 2. Dispose agent stream
    try {
        if (agentStreamManager) {
            await agentStreamManager.dispose(cdpManagers);
        }
    } catch (e: any) { LOG.warn('Shutdown', `AgentStream dispose: ${e?.message}`); }

    // 3. Detach CLIs (persistent runtimes survive daemon restarts)
    try { cliManager.detachAll(); } catch { /* noop */ }

    // 4. Remove CLI instances without disposing their runtimes again
    try { instanceManager.removeByCategory('cli', { dispose: false }); } catch { /* noop */ }

    // 5. Dispose remaining instances
    try { instanceManager.disposeAll(); } catch { /* noop */ }

    // 6. Disconnect CDPs
    for (const m of cdpManagers.values()) {
        try { m.disconnect(); } catch { /* noop */ }
    }
    cdpManagers.clear();

    // 7. Stop replication and release the seqscribe DB owner lock after its
    // live transports have stopped producing work. Close is idempotent and a
    // failure must not prevent the remaining daemon shutdown steps.
    try { await seqscribeNode?.close(); } catch (error) {
        LOG.warn('Shutdown', `Seqscribe close: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 8. VACUUM the mesh runtime DB. Retention prunes rows with DELETE (frees pages
    // inside the file but never shrinks it); the mesh-runtime.db grew to hundreds of
    // MB (mission 86def38d disk-accumulation bootstrap failure) because it was never
    // compacted. Do this LAST, after all writers (reconcile loop, CLIs, instances)
    // are stopped, so nothing contends for the exclusive VACUUM lock. Best-effort —
    // vacuum() swallows its own errors; the try/catch guards the getInstance() throw
    // when the store never opened (degraded JSONL-only mode).
    try { MeshRuntimeStore.getInstance().vacuum(); } catch { /* store unavailable — nothing to vacuum */ }
}
