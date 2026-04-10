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
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import type {
    IAgentStreamAdapter,
    AgentStreamState,
    AgentChatListItem,
    AgentEvaluateFn,
} from './types.js';

export interface ManagedAgent {
    adapter: IAgentStreamAdapter;
    runtimeSessionId: string;
    parentSessionId: string;
    cdpSessionId: string;
    target: AgentWebviewTarget;
    lastState: AgentStreamState | null;
    lastError: string | null;
    lastHiddenCheckTime: number;
}

export class DaemonAgentStreamManager {
    private adaptersByType = new Map<string, IAgentStreamAdapter>();
    private managedBySessionId = new Map<string, ManagedAgent>();
    private enabled = true;
    private logFn: (msg: string) => void;
    private lastDiscoveryTimeByParent = new Map<string, number>();
    private discoveryIntervalMsByParent = new Map<string, number>();
    private activeSessionIdByParent = new Map<string, string | null>();

    constructor(
        logFn?: (msg: string) => void,
        providerLoader?: ProviderLoader,
        private readonly sessionRegistry?: SessionRegistry,
    ) {
        this.logFn = logFn || LOG.forComponent('AgentStream').asLogFn();

 // Create adapter for all extension providers
 // Per-IDE filtering is handled by each CDP manager via setExtensionProviders
        if (providerLoader) {
            const allExtProviders = providerLoader.getByCategory('extension');
            for (const p of allExtProviders) {
                const resolved = providerLoader.resolve(p.type);
                if (!resolved) continue;
                const adapter = new ProviderStreamAdapter(resolved);
                this.adaptersByType.set(p.type, adapter);
                this.logFn(`[AgentStream] Adapter created: ${p.type} (${p.name}) scripts=${Object.keys(resolved.scripts || {}).join(',') || 'none'}`);
            }
        }
    }

    setEnabled(enabled: boolean) { this.enabled = enabled; }
    get isEnabled() { return this.enabled; }
    getActiveSessionId(parentSessionId: string): string | null {
        return this.activeSessionIdByParent.get(parentSessionId) || null;
    }

    private isRecoverableSessionError(message: string): boolean {
        return message.includes('timeout')
            || message.includes('not connected')
            || message.includes('Session')
            || message.includes('Target closed')
            || message.includes('execution context')
            || message.includes('context with specified id');
    }

    private getSessionTarget(sessionId: string) {
        return this.sessionRegistry?.get(sessionId);
    }

    resetParentSession(parentSessionId: string): void {
        const activeSessionId = this.activeSessionIdByParent.get(parentSessionId);
        if (activeSessionId) this.managedBySessionId.delete(activeSessionId);
        for (const child of this.sessionRegistry?.listChildren(parentSessionId) || []) {
            this.managedBySessionId.delete(child.sessionId);
        }
        this.activeSessionIdByParent.delete(parentSessionId);
        this.lastDiscoveryTimeByParent.delete(parentSessionId);
        this.discoveryIntervalMsByParent.delete(parentSessionId);
    }

 /** Panel focus based on provider.js focusPanel or extensionId (currently no-op) */
    async ensureSessionPanelOpen(_sessionId: string): Promise<void> {
 // Extension was removed, so localServer-based panel focus no longer works
 // Can be replaced with CDP-based focus (future implementation)
    }

    async setActiveSession(cdp: DaemonCdpManager, parentSessionId: string, sessionId: string | null): Promise<void> {
        const previousSessionId = this.getActiveSessionId(parentSessionId);
        if (previousSessionId === sessionId) return;

        if (previousSessionId) {
            const prev = this.managedBySessionId.get(previousSessionId);
            if (prev) {
                try { await cdp.detachAgent(prev.cdpSessionId); } catch { }
                this.managedBySessionId.delete(previousSessionId);
                this.logFn(`[AgentStream] Deactivated: ${prev.adapter.agentName} (${parentSessionId})`);
            }
        }

        this.activeSessionIdByParent.set(parentSessionId, sessionId);
        this.lastDiscoveryTimeByParent.set(parentSessionId, 0);
        this.logFn(`[AgentStream] Active session (${parentSessionId}): ${sessionId || 'none'}`);
    }

    private resolveSessionIdForTarget(parentSessionId: string, agentType: string): string | null {
        const child = (this.sessionRegistry?.listChildren(parentSessionId) || [])
            .find((entry) => entry.transport === 'cdp-webview' && entry.providerType === agentType);
        return child?.sessionId || null;
    }

    private getStateError(state: AgentStreamState): string {
        if (typeof state.error === 'string' && state.error.trim()) return state.error.trim();
        if (typeof state._error === 'string' && state._error.trim()) return state._error.trim();
        return 'unknown';
    }

    private async connectManagedSession(
        cdp: DaemonCdpManager,
        parentSessionId: string,
        runtimeSessionId: string,
    ): Promise<ManagedAgent | null> {
        const target = this.getSessionTarget(runtimeSessionId);
        if (!target || target.transport !== 'cdp-webview') return null;
        const adapter = this.adaptersByType.get(target.providerType);
        if (!adapter) return null;
        const targets = await cdp.discoverAgentWebviews();
        const activeTarget = targets.find((entry) => entry.agentType === target.providerType);
        if (!activeTarget) return null;
        const cdpSessionId = await cdp.attachToAgent(activeTarget);
        if (!cdpSessionId) return null;
        const managed: ManagedAgent = {
            adapter,
            runtimeSessionId,
            parentSessionId,
            cdpSessionId,
            target: activeTarget,
            lastState: null,
            lastError: null,
            lastHiddenCheckTime: 0,
        };
        this.managedBySessionId.set(runtimeSessionId, managed);
        this.logFn(`[AgentStream] Connected: ${adapter.agentName} (${parentSessionId})`);
        return managed;
    }

    /** Agent webview discovery + session connection */
    async syncActiveSession(cdp: DaemonCdpManager, parentSessionId: string): Promise<void> {
        const activeSessionId = this.getActiveSessionId(parentSessionId);
        if (!this.enabled || !activeSessionId) return;

        const now = Date.now();
        const managed = this.managedBySessionId.get(activeSessionId);
        const lastDiscoveryTime = this.lastDiscoveryTimeByParent.get(parentSessionId) || 0;
        const discoveryIntervalMs = this.discoveryIntervalMsByParent.get(parentSessionId) || 10_000;
        if (managed && (now - lastDiscoveryTime) < discoveryIntervalMs) {
            return;
        }
        this.lastDiscoveryTimeByParent.set(parentSessionId, now);

        try {
            if (!managed) {
                await this.connectManagedSession(cdp, parentSessionId, activeSessionId);
            }
            this.discoveryIntervalMsByParent.set(parentSessionId, this.managedBySessionId.has(activeSessionId) ? 30_000 : 10_000);
        } catch (e) {
            this.logFn(`[AgentStream] sync error (${parentSessionId}): ${(e as Error).message}`);
        }
    }

    /** Collect active extension session state */
    async collectActiveSession(cdp: DaemonCdpManager, parentSessionId: string): Promise<AgentStreamState | null> {
        if (!this.enabled) return null;
        const activeSessionId = this.getActiveSessionId(parentSessionId);
        if (!activeSessionId) return null;
        let agent = this.managedBySessionId.get(activeSessionId);
        if (!agent) {
            agent = await this.connectManagedSession(cdp, parentSessionId, activeSessionId) || undefined;
        }
        if (!agent) return null;
        const type = agent.adapter.agentType;
        const isHidden = agent.lastState?.status === 'panel_hidden';
        const hiddenCacheFresh = isHidden && (Date.now() - agent.lastHiddenCheckTime < 30000);

        if (hiddenCacheFresh) return agent.lastState!;

        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.cdpSessionId, expr, timeout);
            const state = await agent.adapter.readChat(evaluate);
            const stateError = this.getStateError(state);
            LOG.debug('AgentStream', `[AgentStream] readChat(${type}) result: status=${state.status} msgs=${state.messages?.length || 0} model=${state.model || ''}${state.status === 'error' ? ' error=' + JSON.stringify(stateError) : ''}`);
            if (state.status === 'error' && this.isRecoverableSessionError(stateError)) {
                throw new Error(stateError);
            }
            agent.lastState = state;
            agent.lastError = null;
            if (state.status === 'panel_hidden') {
                agent.lastHiddenCheckTime = Date.now();
            }
            return state;
        } catch (e) {
            const errorMsg = (e as Error)?.message || String(e);
            this.logFn(`[AgentStream] readChat(${type}) error: ${errorMsg.slice(0, 200)}`);
            agent.lastError = errorMsg;
            if (this.isRecoverableSessionError(errorMsg)) {
                try { await cdp.detachAgent(agent.cdpSessionId); } catch { }
                this.managedBySessionId.delete(activeSessionId);
                this.lastDiscoveryTimeByParent.set(parentSessionId, 0);
            }
            return {
                agentType: type,
                agentName: agent.adapter.agentName,
                extensionId: agent.adapter.extensionId,
                status: 'disconnected',
                messages: agent.lastState?.messages || [],
                inputContent: '',
            };
        }
    }

    async sendToSession(cdp: DaemonCdpManager, sessionId: string, text: string): Promise<boolean> {
        await this.ensureSessionPanelOpen(sessionId);
        const target = this.getSessionTarget(sessionId);
        if (!target?.parentSessionId) return false;
        await this.setActiveSession(cdp, target.parentSessionId, sessionId);
        await this.syncActiveSession(cdp, target.parentSessionId);
        const agent = this.managedBySessionId.get(sessionId);
        if (!agent) return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.cdpSessionId, expr, timeout);
            await agent.adapter.sendMessage(evaluate, text);
            return true;
        } catch (e) {
            this.logFn(`[AgentStream] sendToSession(${sessionId}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async resolveSessionAction(cdp: DaemonCdpManager, sessionId: string, action: 'approve' | 'reject', button?: string): Promise<boolean> {
        await this.ensureSessionPanelOpen(sessionId);
        const target = this.getSessionTarget(sessionId);
        if (!target?.parentSessionId) return false;
        await this.setActiveSession(cdp, target.parentSessionId, sessionId);
        await this.syncActiveSession(cdp, target.parentSessionId);
        const agent = this.managedBySessionId.get(sessionId);
        if (!agent) return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.cdpSessionId, expr, timeout);
            return await agent.adapter.resolveAction(evaluate, action, button);
        } catch (e) {
            this.logFn(`[AgentStream] resolveAction(${sessionId}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async newSession(cdp: DaemonCdpManager, sessionId: string): Promise<boolean> {
        await this.ensureSessionPanelOpen(sessionId);
        const target = this.getSessionTarget(sessionId);
        if (!target?.parentSessionId) return false;
        await this.setActiveSession(cdp, target.parentSessionId, sessionId);
        await this.syncActiveSession(cdp, target.parentSessionId);
        const agent = this.managedBySessionId.get(sessionId);
        if (!agent) return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.cdpSessionId, expr, timeout);
            await agent.adapter.newSession(evaluate);
            return true;
        } catch (e) {
            this.logFn(`[AgentStream] newSession(${sessionId}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async listSessionChats(cdp: DaemonCdpManager, sessionId: string): Promise<AgentChatListItem[]> {
        const target = this.getSessionTarget(sessionId);
        if (!target?.parentSessionId) return [];
        await this.setActiveSession(cdp, target.parentSessionId, sessionId);
        await this.syncActiveSession(cdp, target.parentSessionId);
        const agent = this.managedBySessionId.get(sessionId);
        if (!agent || typeof agent.adapter.listChats !== 'function') return [];
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.cdpSessionId, expr, timeout);
            return await agent.adapter.listChats(evaluate);
        } catch (e) {
            this.logFn(`[AgentStream] listChats(${sessionId}) error: ${(e as Error).message}`);
            return [];
        }
    }

    async switchConversation(cdp: DaemonCdpManager, sessionId: string, conversationId: string): Promise<boolean> {
        const target = this.getSessionTarget(sessionId);
        if (!target?.parentSessionId) return false;
        await this.setActiveSession(cdp, target.parentSessionId, sessionId);
        await this.syncActiveSession(cdp, target.parentSessionId);
        const agent = this.managedBySessionId.get(sessionId);
        if (!agent || typeof agent.adapter.switchSession !== 'function') return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.cdpSessionId, expr, timeout);
            return await agent.adapter.switchSession(evaluate, conversationId);
        } catch (e) {
            this.logFn(`[AgentStream] switchSession(${sessionId}) error: ${(e as Error).message}`);
            return false;
        }
    }

    async focusSession(cdp: DaemonCdpManager, sessionId: string): Promise<boolean> {
        const target = this.getSessionTarget(sessionId);
        if (!target?.parentSessionId) return false;
        await this.setActiveSession(cdp, target.parentSessionId, sessionId);
        await this.syncActiveSession(cdp, target.parentSessionId);
        const agent = this.managedBySessionId.get(sessionId);
        if (!agent || typeof agent.adapter.focusEditor !== 'function') return false;
        try {
            const evaluate: AgentEvaluateFn = (expr, timeout) =>
                cdp.evaluateInSessionFrame(agent.cdpSessionId, expr, timeout);
            await agent.adapter.focusEditor(evaluate);
            return true;
        } catch (e) {
            this.logFn(`[AgentStream] focusEditor(${sessionId}) error: ${(e as Error).message}`);
            return false;
        }
    }

    getConnectedSessions(parentSessionId?: string): string[] {
        if (parentSessionId) {
            return [...this.managedBySessionId.values()]
                .filter((entry) => entry.parentSessionId === parentSessionId)
                .map((entry) => entry.runtimeSessionId);
        }
        return [...this.managedBySessionId.keys()];
    }

    getManagedSession(sessionId: string): ManagedAgent | undefined {
        return this.managedBySessionId.get(sessionId);
    }

    async dispose(cdpManagers: Map<string, DaemonCdpManager>): Promise<void> {
        for (const managed of this.managedBySessionId.values()) {
            const managerKey = this.getSessionTarget(managed.runtimeSessionId)?.cdpManagerKey;
            const cdp = managerKey ? cdpManagers.get(managerKey) : null;
            if (!cdp) continue;
            try { await cdp.detachAgent(managed.cdpSessionId); } catch { }
        }
        this.managedBySessionId.clear();
        this.activeSessionIdByParent.clear();
        this.lastDiscoveryTimeByParent.clear();
        this.discoveryIntervalMsByParent.clear();
    }

    resolveSessionForAgent(parentSessionId: string, agentType: string): string | null {
        return this.resolveSessionIdForTarget(parentSessionId, agentType);
    }
}
