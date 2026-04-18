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
import type { SessionRegistry } from '../sessions/registry.js';
import { reconcileIdeRuntimeSessions } from '../sessions/reconcile.js';
import { LOG } from '../logging/logger.js';
import type { AgentStreamState } from './types.js';
import { formatAutoApprovalMessage, pickApprovalButton } from '../providers/approval-utils.js';
import type { ProviderModule } from '../providers/contracts.js';
import { buildRuntimeSystemChatMessage } from '../providers/chat-message-normalization.js';

interface ExtensionInstanceLike {
    type?: string;
    getInstanceId?(): string;
}

interface IdeInstanceLike {
    getInstanceId?(): string;
    getExtensionTypes?(): string[];
    getExtension?(type: string): ExtensionInstanceLike | undefined;
    addExtension?(provider: ProviderModule, settings: Record<string, unknown>): void;
    removeExtension?(type: string): void;
}

// ─── Types ───

export interface AgentStreamPollerDeps {
    agentStreamManager: DaemonAgentStreamManager;
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    sessionRegistry: SessionRegistry;
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
    resetActiveIde(parentSessionId: string): void {
        this.deps.agentStreamManager.resetParentSession(parentSessionId);
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
            sessionRegistry,
        } = this.deps;

        if (!agentStreamManager || cdpManagers.size === 0) return;

        // Defensive repair: keep SessionRegistry aligned with live IDE/extension instances.
        reconcileIdeRuntimeSessions(instanceManager, sessionRegistry);

        // ─── Phase 1: Refresh extension providers + IDE instance extensions ───
        for (const [ideType, cdp] of cdpManagers) {
            // 1a. Refresh CDP manager's extension providers from config
            registerExtensionProviders(providerLoader, cdp, ideType);

            // 1b. Dynamically add/remove IDE instance extensions
            const ideInstance = instanceManager.getInstance(`ide:${ideType}`) as IdeInstanceLike | undefined;
            const parentSessionId = ideInstance?.getInstanceId?.();
            if (ideInstance?.getExtensionTypes && ideInstance?.addExtension && ideInstance?.removeExtension) {
                const currentExtTypes = new Set(ideInstance.getExtensionTypes());
                const enabledExtTypes = new Set(
                    providerLoader.getEnabledByCategory('extension', ideType).map((p) => p.type)
                );

                // Remove disabled extensions
                for (const extType of currentExtTypes) {
                    if (!enabledExtTypes.has(extType)) {
                        const extInstance = ideInstance.getExtension?.(extType);
                        if (extInstance?.getInstanceId) {
                            sessionRegistry.unregister(extInstance.getInstanceId());
                        }
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
                            const extInstance = ideInstance.getExtension?.(extType);
                            if (parentSessionId && extInstance?.getInstanceId) {
                                sessionRegistry.register({
                                    sessionId: extInstance.getInstanceId(),
                                    parentSessionId,
                                    providerType: extType,
                                    transport: 'cdp-webview',
                                    cdpManagerKey: ideType,
                                    instanceKey: `ide:${ideType}`,
                                });
                                const activeSessionId = agentStreamManager.getActiveSessionId(parentSessionId);
                                if (!activeSessionId || enabledExtTypes.size === 1) {
                                    await agentStreamManager.setActiveSession(
                                        cdp,
                                        parentSessionId,
                                        extInstance.getInstanceId(),
                                    );
                                    LOG.info('AgentStream', `Auto-activated enabled extension: ${extType} (${ideType})`);
                                }
                            }
                            LOG.info('AgentStream', `Extension added: ${extType} (enabled for ${ideType})`);
                        }
                    }
                }
            }

            // 1c. If the active agent stream belongs to a now-disabled extension, detach it
            const activeSessionId = parentSessionId ? agentStreamManager.getActiveSessionId(parentSessionId) : null;
            if (activeSessionId) {
                const activeTarget = sessionRegistry.get(activeSessionId);
                const enabledExtTypes = new Set(providerLoader.getEnabledExtensionProviders(ideType).map((p) => p.type));
                if (!activeTarget || !enabledExtTypes.has(activeTarget.providerType)) {
                    LOG.info('AgentStream', `Active agent ${activeTarget?.providerType || activeSessionId} was disabled for ${ideType} — detaching`);
                    await agentStreamManager.setActiveSession(cdp, parentSessionId!, null);
                    // Report empty streams so dashboard removes the tab
                    this.deps.onStreamsUpdated?.(ideType, []);
                }
            }
            if (!cdp.isConnected) {
                if (parentSessionId && activeSessionId) {
                    agentStreamManager.resetParentSession(parentSessionId);
                    this.deps.onStreamsUpdated?.(ideType, []);
                }
                continue;
            }

            // ─── Phase 2: Agent session sync + collect ───
            let resolvedActiveSessionId = activeSessionId;

            // ─── Phase 3: Auto-discover agents ───
            if (!resolvedActiveSessionId && parentSessionId) {
                try {
                    const discovered = await cdp.discoverAgentWebviews();
                    for (const target of discovered) {
                        const sessionId = agentStreamManager.resolveSessionForAgent(parentSessionId, target.agentType);
                        if (sessionId) {
                            resolvedActiveSessionId = sessionId;
                            await agentStreamManager.setActiveSession(cdp, parentSessionId, sessionId);
                            LOG.info('AgentStream', `Auto-activated: ${target.agentType} (${ideType})`);
                            break;
                        }
                    }
                } catch { }
            }

            if (!resolvedActiveSessionId || !parentSessionId) {
                if (parentSessionId) {
                    this.deps.onStreamsUpdated?.(ideType, []);
                }
                continue;
            }

            try {
                await agentStreamManager.syncActiveSession(cdp, parentSessionId);
                let stream = await agentStreamManager.collectActiveSession(cdp, parentSessionId);
                resolvedActiveSessionId = stream?.sessionId || agentStreamManager.getActiveSessionId(parentSessionId) || resolvedActiveSessionId;
                if (stream?.status === 'waiting_approval') {
                    const autoApprove = providerLoader.getSettings(stream.agentType).autoApprove !== false;
                    if (autoApprove && resolvedActiveSessionId) {
                        const provider = providerLoader.getMeta(stream.agentType);
                        const { label: buttonLabel } = pickApprovalButton(stream.activeModal?.buttons, provider);
                        const approved = await agentStreamManager.resolveSessionAction(cdp, resolvedActiveSessionId, 'approve', buttonLabel);
                        if (approved) {
                            const effectId = [
                                'auto_approval',
                                resolvedActiveSessionId,
                                String(stream.messages?.length || 0),
                                buttonLabel,
                                String(stream.activeModal?.message || '').trim(),
                            ].join(':');
                            stream = {
                                ...stream,
                                status: 'streaming',
                                activeModal: undefined,
                                effects: [
                                    ...(stream.effects || []),
                                    {
                                        type: 'message',
                                        id: effectId,
                                        persist: true,
                                        message: buildRuntimeSystemChatMessage({
                                            content: formatAutoApprovalMessage(stream.activeModal?.message, buttonLabel),
                                        }),
                                    },
                                ],
                            };
                        }
                    }
                }
                this.deps.onStreamsUpdated?.(ideType, stream ? [stream] : []);
            } catch { }
        }
    }
}
