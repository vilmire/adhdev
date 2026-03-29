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
    private managed = new Map<string, ManagedAgent>();
    private enabled = true;
    private logFn: (msg: string) => void;
    private lastDiscoveryTime = 0;
    private discoveryIntervalMs = 10_000;


    private _activeAgentType: string | null = null;

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
    get activeAgentType(): string | null { return this._activeAgentType; }

 /** Panel focus based on provider.js focusPanel or extensionId (currently no-op) */
    async ensureAgentPanelOpen(agentType: string, targetIdeType?: string): Promise<void> {
 // Extension was removed, so localServer-based panel focus no longer works
 // Can be replaced with CDP-based focus (future implementation)
    }

    async switchActiveAgent(cdp: DaemonCdpManager, agentType: string | null): Promise<void> {
        if (this._activeAgentType === agentType) return;

        if (this._activeAgentType) {
            const prev = this.managed.get(this._activeAgentType);
            if (prev) {
                try { await cdp.detachAgent(prev.sessionId); } catch { }
                this.managed.delete(this._activeAgentType);
                this.logFn(`[AgentStream] Deactivated: ${prev.adapter.agentName}`);
            }
        }

        this._activeAgentType = agentType;
        this.lastDiscoveryTime = 0;
        this.logFn(`[AgentStream] Active agent: ${agentType || 'none'}`);
    }

 /** Agent webview discovery + session connection */
    async syncAgentSessions(cdp: DaemonCdpManager): Promise<void> {
        if (!this.enabled || !this._activeAgentType) return;

        const now = Date.now();
        if (this.managed.has(this._activeAgentType) && (now - this.lastDiscoveryTime) < this.discoveryIntervalMs) {
            return;
        }
        this.lastDiscoveryTime = now;

        try {
            const targets = await cdp.discoverAgentWebviews();
            const activeTarget = targets.find(t => t.agentType === this._activeAgentType);

            if (activeTarget && !this.managed.has(this._activeAgentType)) {
                const adapter = this.allAdapters.find(a => a.agentType === this._activeAgentType);
                if (adapter) {
                    const sessionId = await cdp.attachToAgent(activeTarget);
                    if (sessionId) {
                        this.managed.set(this._activeAgentType, {
                            adapter,
                            sessionId,
                            target: activeTarget,
                            lastState: null,
                            lastError: null,
                            lastHiddenCheckTime: 0,
                        });
                        this.logFn(`[AgentStream] Connected: ${adapter.agentName}`);
                    }
                }
            }

 // Cleanup inactive agents
            for (const [type, agent] of this.managed) {
                if (type !== this._activeAgentType) {
                    await cdp.detachAgent(agent.sessionId);
                    this.managed.delete(type);
                }
            }

            this.discoveryIntervalMs = this.managed.has(this._activeAgentType) ? 30_000 : 10_000;
        } catch (e) {
            this.logFn(`[AgentStream] sync error: ${(e as Error).message}`);
        }
    }

 /** Collect active agent status */
    async collectAgentStreams(cdp: DaemonCdpManager): Promise<AgentStreamState[]> {
        if (!this.enabled) return [];

        const results: AgentStreamState[] = [];

        if (this._activeAgentType && this.managed.has(this._activeAgentType)) {
            const agent = this.managed.get(this._activeAgentType)!;
            const type = this._activeAgentType;

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
                        this.managed.delete(type);
                        this.lastDiscoveryTime = 0;
                    }
                }
            }
        }

        return results;
    }

    async sendToAgent(cdp: DaemonCdpManager, agentType: string, text: string, targetIdeType?: string): Promise<boolean> {
        await this.ensureAgentPanelOpen(agentType, targetIdeType);
        const agent = this.managed.get(agentType);
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

    async resolveAgentAction(cdp: DaemonCdpManager, agentType: string, action: 'approve' | 'reject', targetIdeType?: string): Promise<boolean> {
        await this.ensureAgentPanelOpen(agentType, targetIdeType);
        const agent = this.managed.get(agentType);
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

    async newAgentSession(cdp: DaemonCdpManager, agentType: string, targetIdeType?: string): Promise<boolean> {
        await this.ensureAgentPanelOpen(agentType, targetIdeType);
        const agent = this.managed.get(agentType);
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

    async listAgentChats(cdp: DaemonCdpManager, agentType: string): Promise<AgentChatListItem[]> {
        let agent = this.managed.get(agentType);
 // on-demand: try activate+sync if not in managed list
        if (!agent) {
            this.logFn(`[AgentStream] listChats: ${agentType} not managed, trying on-demand activation`);
            await this.switchActiveAgent(cdp, agentType);
            await this.syncAgentSessions(cdp);
            agent = this.managed.get(agentType);
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

    async switchAgentSession(cdp: DaemonCdpManager, agentType: string, sessionId: string): Promise<boolean> {
        let agent = this.managed.get(agentType);
        if (!agent) {
            this.logFn(`[AgentStream] switchSession: ${agentType} not managed, trying on-demand activation`);
            await this.switchActiveAgent(cdp, agentType);
            await this.syncAgentSessions(cdp);
            agent = this.managed.get(agentType);
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

    async focusAgentEditor(cdp: DaemonCdpManager, agentType: string): Promise<boolean> {
        const agent = this.managed.get(agentType);
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

    getConnectedAgents(): string[] { return Array.from(this.managed.keys()); }
    getManagedAgent(agentType: string): ManagedAgent | undefined { return this.managed.get(agentType); }

    async dispose(cdp: DaemonCdpManager): Promise<void> {
        for (const [, agent] of this.managed) {
            try { await cdp.detachAgent(agent.sessionId); } catch { }
        }
        this.managed.clear();
    }
}
