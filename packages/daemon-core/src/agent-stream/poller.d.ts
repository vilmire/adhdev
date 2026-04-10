/**
 * AgentStreamPoller — Periodic agent stream polling + extension dynamic management
 *
 * Handles periodic agent stream polling and extension dynamic management.
 *
 * Responsibilities:
 *   1. Refresh extension providers in CDP managers (config changes take effect immediately)
 *   2. Dynamically add/remove IDE instance extensions based on enabled state
 *   3. Sync agent sessions + collect agent streams
 *   4. Auto-discover agents in connected IDEs
 */
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { DaemonAgentStreamManager } from './manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { SessionRegistry } from '../sessions/registry.js';
import type { AgentStreamState } from './types.js';
export interface AgentStreamPollerDeps {
    agentStreamManager: DaemonAgentStreamManager;
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    sessionRegistry: SessionRegistry;
    /** Callback when agent streams are updated */
    onStreamsUpdated?: (ideType: string, streams: AgentStreamState[]) => void;
}
export declare class AgentStreamPoller {
    private deps;
    private timer;
    constructor(deps: AgentStreamPollerDeps);
    /** Currently active IDE type for agent streaming */
    get activeIde(): string | null;
    /** Reset active IDE tracking (e.g., when IDE is stopped) */
    resetActiveIde(parentSessionId: string): void;
    /** Start polling (idempotent — ignored if already started) */
    start(intervalMs?: number): void;
    /** Stop polling */
    stop(): void;
    /** Single poll tick — can also be called manually */
    private tick;
}
