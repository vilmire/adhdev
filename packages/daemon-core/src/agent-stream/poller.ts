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
import { registerExtensionProviders } from '../cdp/setup.js';
import { LOG } from '../logging/logger.js';
import type { AgentStreamState } from './types.js';

// ─── Types ───

export interface AgentStreamPollerDeps {
    agentStreamManager: DaemonAgentStreamManager;
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    /** Callback when agent streams are updated */
    onStreamsUpdated?: (ideType: string, streams: AgentStreamState[]) => void;
}

export class AgentStreamPoller {
    private deps: AgentStreamPollerDeps;
    private timer: NodeJS.Timeout | null = null;

    constructor(deps: AgentStreamPollerDeps) {
        this.deps = deps;
    }

    /** Currently active IDE type for agent streaming */
    get activeIde(): string | null {
        return null;
    }

    /** Reset active IDE tracking (e.g., when IDE is stopped) */
    resetActiveIde(ideType: string): void {
        this.deps.agentStreamManager.resetScope(ideType);
    }

    /** Start polling (idempotent — ignored if already started) */
    start(intervalMs = 5000): void {
        if (this.timer) return; // Already running

        this.timer = setInterval(async () => {
            await this.tick();
        }, intervalMs);
    }

    /** Stop polling */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Single poll tick — can also be called manually */
    private async tick(): Promise<void> {
        const {
            agentStreamManager,
            providerLoader,
            instanceManager,
            cdpManagers,
        } = this.deps;

        if (!agentStreamManager || cdpManagers.size === 0) return;

        // ─── Phase 1: Refresh extension providers + IDE instance extensions ───
        for (const [ideType, cdp] of cdpManagers) {
            // 1a. Refresh CDP manager's extension providers from config
            registerExtensionProviders(providerLoader, cdp, ideType);

            // 1b. Dynamically add/remove IDE instance extensions
            const ideInstance = instanceManager.getInstance(`ide:${ideType}`) as any;
            if (ideInstance?.getExtensionTypes && ideInstance?.addExtension && ideInstance?.removeExtension) {
                const currentExtTypes = new Set(ideInstance.getExtensionTypes() as string[]);
                const enabledExtTypes = new Set(
                    providerLoader.getEnabledByCategory('extension', ideType).map((p: any) => p.type)
                );

                // Remove disabled extensions
                for (const extType of currentExtTypes) {
                    if (!enabledExtTypes.has(extType)) {
                        ideInstance.removeExtension(extType);
                        LOG.info('AgentStream', `Extension removed: ${extType} (disabled for ${ideType})`);
                    }
                }

                // Add newly enabled extensions
                for (const extType of enabledExtTypes) {
                    if (!currentExtTypes.has(extType)) {
                        const extProvider = providerLoader.getMeta(extType);
                        if (extProvider) {
                            const extSettings = providerLoader.getSettings(extType);
                            ideInstance.addExtension(extProvider, extSettings);
                            LOG.info('AgentStream', `Extension added: ${extType} (enabled for ${ideType})`);
                        }
                    }
                }
            }

            // 1c. If the active agent stream belongs to a now-disabled extension, detach it
            const activeType = agentStreamManager.getActiveAgentType(ideType);
            if (activeType) {
                const enabledExtTypes = new Set(
                    providerLoader.getEnabledExtensionProviders(ideType).map((p: any) => p.type)
                );
                if (!enabledExtTypes.has(activeType)) {
                    LOG.info('AgentStream', `Active agent ${activeType} was disabled for ${ideType} — detaching`);
                    await agentStreamManager.switchActiveAgent(cdp, ideType, null);
                    // Report empty streams so dashboard removes the tab
                    this.deps.onStreamsUpdated?.(ideType, []);
                }
            }
            if (!cdp.isConnected) {
                if (activeType) {
                    agentStreamManager.resetScope(ideType);
                    this.deps.onStreamsUpdated?.(ideType, []);
                }
                continue;
            }

            // ─── Phase 2: Agent session sync + collect ───
            let resolvedActiveType = activeType;

            // ─── Phase 3: Auto-discover agents ───
            if (!resolvedActiveType) {
                try {
                    const discovered = await cdp.discoverAgentWebviews();
                    if (discovered.length > 0) {
                        resolvedActiveType = discovered[0].agentType;
                        await agentStreamManager.switchActiveAgent(cdp, ideType, resolvedActiveType);
                        LOG.info('AgentStream', `Auto-activated: ${resolvedActiveType} (${ideType})`);
                    }
                } catch { }
            }

            if (!resolvedActiveType) continue;

            try {
                await agentStreamManager.syncAgentSessions(cdp, ideType);
                const streams = await agentStreamManager.collectAgentStreams(cdp, ideType);
                this.deps.onStreamsUpdated?.(ideType, streams);
            } catch { }
        }
    }
}
