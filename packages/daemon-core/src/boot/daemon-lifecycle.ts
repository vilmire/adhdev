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
import { ProviderLoader } from '../providers/provider-loader.js';
import { VersionArchive, detectAllVersions } from '../providers/version-archive.js';
import { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { DevServer } from '../daemon/dev-server.js';
import { detectIDEs, type IDEInfo } from '../detection/ide-detector.js';
import { detectCLI, detectCLIs, getCachedProviderVersions, setDefaultProviderLoader } from '../detection/cli-detector.js';
import { getDaemonBuildInfo } from '../build-info.js';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG, installGlobalInterceptor } from '../logging/logger.js';
import {
    DEFAULT_CDP_DISCOVERY_INTERVAL_MS,
    DEFAULT_CDP_SCAN_INTERVAL_MS,
} from '../runtime-defaults.js';
import { loadConfig } from '../config/config.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { IdeProviderInstance } from '../providers/ide-provider-instance.js';
import { createDefaultGitCommandServices } from '../git/git-commands.js';
import { setupMeshEventForwarding } from '../mesh/mesh-events.js';
import { setupMeshReconcileLoop } from '../mesh/mesh-reconcile-loop.js';
import { loadMeshCoordinatorRegistry } from '../mesh/coordinator-registry.js';
import { applyProcessHardening } from './process-hardening.js';
import { installProviderProcessShim } from '../providers/sdk/v1/sandbox/require-whitelist.js';

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
    // Canonical status/daemon identity (e.g. `standalone_<machineId>` /
    // `daemon_<machineId>`). This is the SAME id the MCP layer stamps as a
    // worker's meshCoordinatorDaemonId (ctx.localDaemonId, sourced from
    // getStatus().status.instanceId), so the reconcile loop MUST drain with it —
    // draining with bare loadConfig().machineId never matches a unicast event
    // stamped with the prefixed status id. Absent → reconcile falls back to
    // machineId only.
    statusInstanceId?: string;
}

export interface DaemonDevSupportOptions {
    components: DaemonComponents;
    logFn?: (msg: string) => void;
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

    // 2. ProviderLoader (provider source mode from config.json)
    const appConfig = loadConfig();
    const providerSourceMode = appConfig.providerSourceMode || 'normal';
    const disableUpstream = providerSourceMode === 'no-upstream';
    const providerLoader = new ProviderLoader({
        logFn: config.providerLogFn,
        sourceMode: providerSourceMode,
        userDir: appConfig.providerDir,
        registryUrl: appConfig.registryUrl,
        providerTarballUrl: appConfig.providerTarballUrl,
    });

    // Boot-time auto-sync is intentionally disabled. The user picks which
    // providers to install via the dashboard onboarding / Providers tab; the
    // daemon ships empty and only contains what the user explicitly installs.
    // Manual sync is still available via the install / check_provider_updates
    // commands (and the REST endpoint at /api/v1/providers/updates).
    providerLoader.loadAll();
    providerLoader.registerToDetector();
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
            // providerVersions. Non-blocking: reads a TTL cache, lazily refreshed.
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
        getCdpLogFn: config.getCdpLogFn || ((ideType: string) => LOG.forComponent(`CDP:${ideType}`).asLogFn()),
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

    // 11. Setup Mesh Event Forwarding (queue persistence) + periodic reconcile loop.
    // injectMeshSystemMessage now ONLY persists events to the pending-events queue;
    // the reconcile loop drains that queue on a fixed interval and injects into live
    // CLI coordinators when idle (and, in cloud mode, pulls remote worker daemons'
    // queues over P2P). This is the single-model (queue + polling) replacement for the
    // old spontaneous-forward push paths.
    setupMeshEventForwarding(components);
    components.meshReconcileLoop = setupMeshReconcileLoop(components);

    // 12. Resume any refine jobs that were interrupted by a previous daemon restart.
    setImmediate(() => void router.resumePendingRefineJobsOnStartup());

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
        meshReconcileLoop,
    } = components;

    // 1. Stop timers
    poller.stop();
    cdpInitializer.stop();
    try { meshReconcileLoop?.stop(); } catch { /* noop */ }

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
}
