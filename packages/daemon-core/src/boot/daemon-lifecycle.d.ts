/**
 * Daemon Lifecycle — Shared init + shutdown logic
 *
 * initDaemonComponents(): Creates all core daemon components in correct order.
 * shutdownDaemonComponents(): Graceful shutdown of all components.
 *
 * Transport-specific setup (ServerConnection, P2P, HTTP/WS) remains in each daemon.
 */
import { DaemonCdpManager } from '../cdp/manager.js';
import { DaemonCdpInitializer } from '../cdp/initializer.js';
import { DaemonCommandHandler } from '../commands/handler.js';
import { DaemonCommandRouter } from '../commands/router.js';
import type { SessionHostControlPlane } from '../commands/router.js';
import { DaemonCliManager, type CliTransportFactoryParams, type HostedCliRuntimeDescriptor } from '../commands/cli-manager.js';
import { DaemonAgentStreamManager } from '../agent-stream/manager.js';
import { AgentStreamPoller } from '../agent-stream/poller.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { DevServer } from '../daemon/dev-server.js';
import { type IDEInfo } from '../detection/ide-detector.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
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
    };
    /** CDP config */
    enabledIdes?: string[];
    /** Router transport-specific callbacks */
    onStatusChange?: () => void;
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
}
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
    detectedIdes: {
        value: IDEInfo[];
    };
}
export interface DaemonDevSupportOptions {
    components: DaemonComponents;
    logFn?: (msg: string) => void;
}
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
export declare function initDaemonComponents(config: DaemonInitConfig): Promise<DaemonComponents>;
/**
 * Start shared dev-only helpers:
 * - DevServer on port 19280
 * - Provider hot-reload watcher
 */
export declare function startDaemonDevSupport(options: DaemonDevSupportOptions): Promise<DevServer>;
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
export declare function shutdownDaemonComponents(components: DaemonComponents): Promise<void>;
