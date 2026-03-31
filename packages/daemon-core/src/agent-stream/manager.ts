/**
 * DaemonAgentStreamManager — manage agent streams (ported for Daemon)
 * 
 * Agent stream manager for extension data collection.
 * All vscode dependencies removed — pure Node.js environment.
 * 
 * Panel focus is delegated to Extension via IPC.
 * CDP session management uses DaemonCdpManager directly.
 */

import { DaemonCdpManager, AgentWebviewTarget } from '../cdp/manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { ProviderStreamAdapter } from './provider-adapter.js';
import { LOG } from '../logging/logger.js';
import type {
    IAgentStreamAdapter,
    AgentStreamState,
    AgentChatListItem,
    AgentEvaluateFn,
} from './types.js';

export interface ManagedAgent {
    adapter: IAgentStreamAdapter;
    sessionId: string;
    target: AgentWebviewTarget;
    lastState: AgentStreamState | null;
    lastError: string | null;
    lastHiddenCheckTime: number;
}

export class DaemonAgentStreamManager {
    private allAdapters: IAgentStreamAdapter[] = [];
    private managedByScope = new Map<string, Map<string, ManagedAgent>>();
    private enabled = true;
    private logFn: (msg: string) => void;
    private lastDiscoveryTimeByScope = new Map<string, number>();
    private discoveryIntervalMsByScope = new Map<string, number>();
    private activeAgentTypeByScope = new Map<string, string | null>();

    constructor(logFn?: (msg: string) => void, providerLoader?: ProviderLoader) {
        this.logFn = logFn || LOG.forComponent('AgentStream').asLogFn();

 // Create adapter for all extension providers
 // Per-IDE filtering is handled by each CDP manager via setExtensionProviders
        if (providerLoader) {
            const allExtProviders = providerLoader.getByCategory('extension');
            for (const p of allExtProviders) {
                const resolved = providerLoader.resolve(p.type);
                if (!resolved) continue;
                const adapter = new ProviderStreamAdapter(resolved);
                this.allAdapters.push(adapter);
                this.logFn(`[AgentStream] Adapter created: ${p.type} (${p.name}) scripts=${Object.keys(resolved.scripts || {}).join(',') || 'none'}`);
            }
        }
    }

    setEnabled(enabled: boolean) { this.enabled = enabled; }
    get isEnabled() { return this.enabled; }
    getActiveAgentType(scopeKey: string): string | null {
        return this.activeAgentTypeByScope.get(scopeKey) || null;
    }

    private getManagedScope(scopeKey: string): Map<string, ManagedAgent> {
        let managed = this.managedByScope.get(scopeKey);
        if (!managed) {
            managed = new Map<string, ManagedAgent>();
            this.managedByScope.set(scopeKey, managed);
        }
        return managed;
    }

    resetScope(scopeKey: string): void {
        this.managedByScope.delete(scopeKey);
        this.activeAgentTypeByScope.delete(scopeKey);
        this.lastDiscoveryTimeByScope.delete(scopeKey);
        this.discoveryIntervalMsByScope.delete(scopeKey);
    }

 /** Panel focus based on provider.js focusPanel or extensionId (currently no-op) */
    async ensureAgentPanelOpen(agentType: string, targetIdeType?: string): Promise<void> {
 // Extension was removed, so localServer-based panel focus no longer works
 // Can be replaced with CDP-based focus (future implementation)
    }

    async switchActiveAgent(cdp: DaemonCdpManager, scopeKey: string, agentType: string | null): Promise<void> {
        const managed = this.getManagedScope(scopeKey);
        const previousAgentType = this.getActiveAgentType(scopeKey);
        if (previousAgentType === agentType) return;

        if (previousAgentType) {
            const prev = managed.get(previousAgentType);
            if (prev) {
                try { await cdp.detachAgent(prev.sessionId); } catch { }
                managed.delete(previousAgentType);
                this.logFn(`[AgentStream] Deactivated: ${prev.adapter.agentName} (${scopeKey})`);
            }
        }

        this.activeAgentTypeByScope.set(scopeKey, agentType);
        this.lastDiscoveryTimeByScope.set(scopeKey, 0);
        if (!agentType && managed.size === 0) {
            this.managedByScope.delete(scopeKey);
        }
        this.logFn(`[AgentStream] Active agent (${scopeKey}): ${agentType || 'none'}`);
    }

 /** Agent webview discovery + session connection */
    async syncAgentSessions(cdp: DaemonCdpManager, scopeKey: string): Promise<void> {
        const activeAgentType = this.getActiveAgentType(scopeKey);
        if (!this.enabled || !activeAgentType) return;

        const now = Date.now();
        const managed = this.getManagedScope(scopeKey);
        const lastDiscoveryTime = this.lastDiscoveryTimeByScope.get(scopeKey) || 0;
        const discoveryIntervalMs = this.discoveryIntervalMsByScope.get(scopeKey) || 10_000;
        if (managed.has(activeAgentType) && (now - lastDiscoveryTime) < discoveryIntervalMs) {
            return;
        }
        this.lastDiscoveryTimeByScope.set(scopeKey, now);

        try {
            const targets = await cdp.discoverAgentWebviews();
            const activeTarget = targets.find(t => t.agentType === activeAgentType);

            if (activeTarget && !managed.has(activeAgentType)) {
                const adapter = this.allAdapters.find(a => a.agentType === activeAgentType);
                if (adapter) {
                    const sessionId = await cdp.attachToAgent(activeTarget);
                    if (sessionId) {
                        managed.set(activeAgentType, {
                            adapter,
                            sessionId,
                            target: activeTarget,
                            lastState: null,
                            lastError: null,
                            lastHiddenCheckTime: 0,
                        });
                        this.logFn(`[AgentStream] Connected: ${adapter.agentName} (${scopeKey})`);
                    }
                }
            }

 // Cleanup inactive agents
            for (const [type, agent] of managed) {
                if (type !== activeAgentType) {
                    await cdp.detachAgent(agent.sessionId);
                    managed.delete(type);
                }
            }

            this.discoveryIntervalMsByScope.set(scopeKey, managed.has(activeAgentType) ? 30_000 : 10_000);
        } catch (e) {
            this.logFn(`[AgentStream] sync error (${scopeKey}): ${(e as Error).message}`);
        }
    }

 /** Collect active agent status */
    async collectAgentStreams(cdp: DaemonCdpManager, scopeKey: string): Promise<AgentStreamState[]> {
        if (!this.enabled) return [];

        const results: AgentStreamState[] = [];
        const activeAgentType = this.getActiveAgentType(scopeKey);
        const managed = this.managedByScope.get(scopeKey);

        if (activeAgentType && managed?.has(activeAgentType)) {
            const agent = managed.get(activeAgentType)!;
            const type = activeAgentType;

            const isHidden = agent.lastState?.status === 'panel_hidden';
            const hiddenCacheFresh = isHidden && (Date.now() - agent.lastHiddenCheckTime < 30000);

            if (hiddenCacheFresh) {
                results.push(agent.lastState!);
            } else {
                try {
                    const evaluate: AgentEvaluateFn = (expr, timeout) =>
                        cdp.evaluateInSessionFrame(agent.sessionId, expr, timeout);
                    const state = await agent.adapter.readChat(evaluate);
                    LOG.debug('AgentStream', `[AgentStream] readChat(${type}) result: status=${state.status} msgs=${state.messages?.length || 0} model=${state.model || ''}${state.status === 'error' ? ' error=' + JSON.stringify((state as any).error || (state as any)._error || 'unknown') : ''}`);
                    agent.lastState = state;
                    agent.lastError = null;
                    if (state.status === 'panel_hidden') {
                        agent.lastHiddenCheckTime = Date.now();
                    }
                    results.push(state);
                } catch (e) {
                    const errorMsg = (e as Error)?.message || String(e);
                    this.logFn(`[AgentStream] readChat(${type}) error: ${errorMsg.slice(0, 200)}`);
                    agent.lastError = errorMsg;
                    results.push({
                        agentType: type,
                        agentName: agent.adapter.agentName,
                        extensionId: agent.adapter.extensionId,
                        status: 'disconnected',
                        messages: agent.lastState?.messages || [],
                        inputContent: '',
                    });
                    if (errorMsg.includes('timeout') || errorMsg.includes('not connected') || errorMsg.includes('Session')) {
                        try { await cdp.detachAgent(agent.sessionId); } catch { }
                        managed.delete(type);
                        this.lastDiscoveryTimeByScope.set(scopeKey, 0);
                    }
                }
            }
        }

        return results;
    }

    async sendToAgent(cdp: DaemonCdpManager, scopeKey: string, agentType: string, text: string, targetIdeType?: string): Promise<boolean> {
        await this.ensureAgentPanelOpen(agentType, targetIdeType);
        const agent = this.getManagedAgent(agentType, scopeKey);
        if (!agent) return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.sessionId, expr, timeout);
            await agent.adapter.sendMessage(evaluate, text);
            return true;
        } catch (e) {
            this.logFn(`[AgentStream] sendToAgent(${agentType}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async resolveAgentAction(cdp: DaemonCdpManager, scopeKey: string, agentType: string, action: 'approve' | 'reject', targetIdeType?: string): Promise<boolean> {
        await this.ensureAgentPanelOpen(agentType, targetIdeType);
        const agent = this.getManagedAgent(agentType, scopeKey);
        if (!agent) return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.sessionId, expr, timeout);
            return await agent.adapter.resolveAction(evaluate, action);
        } catch (e) {
            this.logFn(`[AgentStream] resolveAction(${agentType}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async newAgentSession(cdp: DaemonCdpManager, scopeKey: string, agentType: string, targetIdeType?: string): Promise<boolean> {
        await this.ensureAgentPanelOpen(agentType, targetIdeType);
        const agent = this.getManagedAgent(agentType, scopeKey);
        if (!agent) return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.sessionId, expr, timeout);
            await agent.adapter.newSession(evaluate);
            return true;
        } catch (e) {
            this.logFn(`[AgentStream] newSession(${agentType}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async listAgentChats(cdp: DaemonCdpManager, scopeKey: string, agentType: string): Promise<AgentChatListItem[]> {
        let agent = this.getManagedAgent(agentType, scopeKey);
 // on-demand: try activate+sync if not in managed list
        if (!agent) {
            this.logFn(`[AgentStream] listChats: ${agentType} not managed in ${scopeKey}, trying on-demand activation`);
            await this.switchActiveAgent(cdp, scopeKey, agentType);
            await this.syncAgentSessions(cdp, scopeKey);
            agent = this.getManagedAgent(agentType, scopeKey);
        }
        if (!agent || typeof agent.adapter.listChats !== 'function') return [];
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent!.sessionId, expr, timeout);
            return await agent.adapter.listChats(evaluate);
        } catch (e) {
            this.logFn(`[AgentStream] listChats(${agentType}) error: ${(e as Error).message}`);
            return [];
        }
    }

    async switchAgentSession(cdp: DaemonCdpManager, scopeKey: string, agentType: string, sessionId: string): Promise<boolean> {
        let agent = this.getManagedAgent(agentType, scopeKey);
        if (!agent) {
            this.logFn(`[AgentStream] switchSession: ${agentType} not managed in ${scopeKey}, trying on-demand activation`);
            await this.switchActiveAgent(cdp, scopeKey, agentType);
            await this.syncAgentSessions(cdp, scopeKey);
            agent = this.getManagedAgent(agentType, scopeKey);
        }
        if (!agent || typeof agent.adapter.switchSession !== 'function') return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent!.sessionId, expr, timeout);
            return await agent.adapter.switchSession(evaluate, sessionId);
        } catch (e) {
            this.logFn(`[AgentStream] switchSession(${agentType}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async focusAgentEditor(cdp: DaemonCdpManager, scopeKey: string, agentType: string): Promise<boolean> {
        const agent = this.getManagedAgent(agentType, scopeKey);
        if (!agent || typeof agent.adapter.focusEditor !== 'function') return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.sessionId, expr, timeout);
            await agent.adapter.focusEditor(evaluate);
            return true;
        } catch (e) {
            this.logFn(`[AgentStream] focusEditor(${agentType}) error: ${(e as Error).message}`);
            return false;
        }
    }

    getConnectedAgents(scopeKey?: string): string[] {
        if (scopeKey) return Array.from((this.managedByScope.get(scopeKey) || new Map()).keys());
        return Array.from(this.managedByScope.values()).flatMap(scope => Array.from(scope.keys()));
    }

    getManagedAgent(agentType: string, scopeKey: string): ManagedAgent | undefined {
        return this.managedByScope.get(scopeKey)?.get(agentType);
    }

    async dispose(cdpManagers: Map<string, DaemonCdpManager>): Promise<void> {
        for (const [scopeKey, managed] of this.managedByScope) {
            const cdp = cdpManagers.get(scopeKey);
            if (!cdp) continue;
            for (const [, agent] of managed) {
                try { await cdp.detachAgent(agent.sessionId); } catch { }
            }
        }
        this.managedByScope.clear();
        this.activeAgentTypeByScope.clear();
        this.lastDiscoveryTimeByScope.clear();
        this.discoveryIntervalMsByScope.clear();
    }
}
