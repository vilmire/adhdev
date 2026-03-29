/**
 * Daemon Lifecycle — Shared init + shutdown for cloud/standalone
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
import { DaemonCliManager } from '../commands/cli-manager.js';
import { DaemonAgentStreamManager } from '../agent-stream/manager.js';
import { AgentStreamPoller } from '../agent-stream/poller.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { VersionArchive, detectAllVersions } from '../providers/version-archive.js';
import { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { detectIDEs } from '../detection/ide-detector.js';
import { installGlobalInterceptor, LOG } from '../logging/logger.js';
import { loadConfig } from '../config/config.js';

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
    };

    /** CDP config */
    enabledIdes?: string[];

    /** Router transport-specific callbacks */
    onStatusChange?: () => void;
    onPostChatCommand?: () => void;
    getCdpLogFn?: (ideType: string) => (msg: string) => void;

    /** Additional callback after CDP manager created (transport-specific extras) */
    onCdpManagerSetup?: (ideType: string, manager: DaemonCdpManager, managerKey: string) => void | Promise<void>;

    /** Poller callback (transport-specific) */
    onStreamsUpdated?: (ideType: string, streams: any[]) => void;

    /** Instance ticking interval (ms), default 5000 */
    tickIntervalMs?: number;

    /** CDP scan interval (ms), default 30000 */
    cdpScanIntervalMs?: number;
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
    instanceIdMap: Map<string, string>;
    detectedIdes: { value: any[] };
}

// ─── Init ───

/**
 * Initialize all daemon core components.
 * Shared by both cloud and standalone daemons.
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
    // 1. Global log interceptor
    installGlobalInterceptor();

    // 2. ProviderLoader (disableUpstream from config.json)
    const appConfig = loadConfig();
    const disableUpstream = appConfig.disableUpstream ?? false;
    const providerLoader = new ProviderLoader({
        logFn: config.providerLogFn,
        disableUpstream,
    });

    // If no upstream providers exist, fetch them first (blocking — critical for new users)
    if (!disableUpstream && !providerLoader.hasUpstream()) {
        LOG.info('Provider', 'No upstream providers found — downloading from GitHub...');
        try {
            await providerLoader.fetchLatest();
        } catch (e: any) {
            LOG.warn('Provider', `⚠ Failed to fetch providers: ${e?.message}`);
        }
    }

    providerLoader.loadAll();
    providerLoader.registerToDetector();

    // 2.5 Provider version detection & archive (non-blocking — don't delay startup)
    const versionArchive = new VersionArchive();
    providerLoader.setVersionArchive(versionArchive);
    detectAllVersions(providerLoader, versionArchive)
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

    // 3. Shared state
    const instanceManager = new ProviderInstanceManager();
    const cdpManagers = new Map<string, DaemonCdpManager>();
    const instanceIdMap = new Map<string, string>();
    const detectedIdesRef = { value: [] as any[] };

    // 4. CLI Manager
    const cliManager = new DaemonCliManager({
        ...config.cliManagerDeps,
        getInstanceManager: () => instanceManager,
    }, providerLoader);

    // 5. Detect IDEs
    LOG.info('Init', 'Detecting IDEs...');
    detectedIdesRef.value = await detectIDEs();
    const installed = detectedIdesRef.value.filter((i: any) => i.installed);
    LOG.info('Init', `Found ${installed.length} IDE(s): ${installed.map((i: any) => i.id).join(', ') || 'none'}`);

    // 6. CDP Initializer — connect + register instances
    const cdpSetupContext: CdpSetupContext = {
        providerLoader,
        instanceManager,
        cdpManagers,
        instanceIdMap,
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
    });
    await cdpInitializer.connectAll(detectedIdesRef.value);
    cdpInitializer.startPeriodicScan(config.cdpScanIntervalMs ?? 30_000);
    cdpInitializer.startDiscovery(30_000);

    // 7. CommandHandler
    const commandHandler = new DaemonCommandHandler({
        cdpManagers,
        ideType: 'unknown',
        adapters: cliManager.adapters,
        providerLoader,
        instanceManager,
        instanceIdMap,
    });

    // 8. AgentStreamManager
    const agentStreamManager = new DaemonAgentStreamManager(
        LOG.forComponent('AgentStream').asLogFn(),
        providerLoader,
    );
    commandHandler.setAgentStreamManager(agentStreamManager);

    // 9. Router + Poller (with internal cross-wiring)
    // Note: poller is declared first so router's onIdeConnected closure captures it
    let poller: AgentStreamPoller;

    const router = new DaemonCommandRouter({
        commandHandler,
        cliManager,
        cdpManagers,
        providerLoader,
        instanceManager,
        detectedIdes: detectedIdesRef,
        instanceIdMap,
        onCdpManagerCreated: async (ideType: string, manager: DaemonCdpManager) => {
            // For launch_ide: register instance + extension providers
            await setupIdeInstance(cdpSetupContext, { ideType, manager });
            await config.onCdpManagerSetup?.(ideType, manager, ideType);
        },
        onIdeConnected: () => poller?.start(),
        onStatusChange: config.onStatusChange,
        onPostChatCommand: config.onPostChatCommand,
        getCdpLogFn: config.getCdpLogFn || ((ideType: string) => LOG.forComponent(`CDP:${ideType}`).asLogFn()),
    });

    poller = new AgentStreamPoller({
        agentStreamManager,
        providerLoader,
        instanceManager,
        cdpManagers,
        onStreamsUpdated: config.onStreamsUpdated,
    });
    poller.start();

    // 10. Start instance ticking
    instanceManager.startTicking(config.tickIntervalMs ?? 5_000);

    return {
        providerLoader,
        instanceManager,
        cliManager,
        commandHandler,
        agentStreamManager,
        router,
        poller,
        cdpInitializer,
        cdpManagers,
        instanceIdMap,
        detectedIdes: detectedIdesRef,
    };
}

// ─── Shutdown ───

/**
 * Graceful shutdown of all daemon components.
 * Shared by both cloud and standalone daemons.
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
    } = components;

    // 1. Stop timers
    poller.stop();
    cdpInitializer.stop();

    // 2. Dispose agent stream
    try {
        const anyCdp = [...cdpManagers.values()].find(m => m.isConnected);
        if (agentStreamManager && anyCdp) {
            await agentStreamManager.dispose(anyCdp);
        }
    } catch (e: any) { LOG.warn('Shutdown', `AgentStream dispose: ${e?.message}`); }

    // 3. Shutdown CLIs
    try { await cliManager.shutdownAll(); } catch { /* noop */ }

    // 4. Dispose instances
    try { instanceManager.disposeAll(); } catch { /* noop */ }

    // 5. Disconnect CDPs
    for (const m of cdpManagers.values()) {
        try { m.disconnect(); } catch { /* noop */ }
    }
    cdpManagers.clear();
}
