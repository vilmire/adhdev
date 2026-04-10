/**
 * DaemonCdpSetup — Shared CDP initialization helpers
 *
 * Common CDP setup logic for consistent
 * CDP → ProviderInstance registration.
 */
import { DaemonCdpManager } from './manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { IdeProviderInstance } from '../providers/ide-provider-instance.js';
import { SessionRegistry } from '../sessions/registry.js';
export interface CdpSetupContext {
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    sessionRegistry: SessionRegistry;
    /** Server connection (optional) */
    serverConn?: any;
}
export interface SetupIdeInstanceOptions {
    /** Provider-based IDE type (e.g., 'antigravity', 'cursor') */
    ideType: string;
    /** Connected CDP manager */
    manager: DaemonCdpManager;
    /** CDP manager key (for multi-window: 'antigravity_remote_vs', single: 'antigravity') */
    managerKey?: string;
    /** Provider settings override */
    settings?: Record<string, any>;
}
/**
 * Register extension providers on a CDP manager.
 * Common pattern used during CDP init and periodic scans.
 */
export declare function registerExtensionProviders(providerLoader: ProviderLoader, manager: DaemonCdpManager, ideType: string): void;
/**
 * Setup a CDP-connected IDE as a ProviderInstance.
 *
 * Performs:
 * 1. providerLoader.resolve() to get scripts
 * 2. Create IdeProviderInstance
 * 3. Register in InstanceManager
 * 4. Register enabled extensions
 * 5. Register runtime sessions (workspace + extension children)
 *
 * @returns The created IdeProviderInstance, or null if provider not found
 */
export declare function setupIdeInstance(ctx: CdpSetupContext, opts: SetupIdeInstanceOptions): Promise<IdeProviderInstance | null>;
/**
 * Create and connect a DaemonCdpManager for a given port.
 *
 * @returns Connected manager or null if connection failed
 */
export declare function connectCdpManager(port: number, ideType: string, logFn: (msg: string) => void, providerLoader: ProviderLoader, targetId?: string): Promise<DaemonCdpManager | null>;
/**
 * Probe a CDP port to check if it's listening.
 * @returns true if CDP is available on this port
 */
export declare function probeCdpPort(port: number, timeoutMs?: number): Promise<boolean>;
