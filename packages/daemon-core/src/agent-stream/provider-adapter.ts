/**
 * ProviderStreamAdapter — generic Extension adapter based on provider.js
 * 
 * Consolidates ClineAdapter, RooCodeAdapter, ContinueAdapter.
 * Auto-configured using provider.js scripts + metadata.
 */

import type {
    IAgentStreamAdapter,
    AgentStreamState,
    AgentChatListItem,
    AgentEvaluateFn,
} from './types.js';
import type { ProviderModule } from '../providers/contracts.js';

export class ProviderStreamAdapter implements IAgentStreamAdapter {
    readonly agentType: string;
    readonly agentName: string;
    readonly extensionId: string;
    readonly extensionIdPattern: RegExp;
    private provider: ProviderModule;
    private lastSuccessState: AgentStreamState | null = null;

    constructor(provider: ProviderModule) {
        this.provider = provider;
        this.agentType = provider.type;
        this.agentName = provider.displayName || provider.name;
        this.extensionId = provider.extensionId || provider.type;
        this.extensionIdPattern = provider.extensionIdPattern
            || new RegExp(`extensionId=${this.extensionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    }

    private callScript(name: string, ...args: any[]): string | null {
        const fn = (this.provider.scripts as any)?.[name];
        if (typeof fn !== 'function') return null;
        return fn(...args) || null;
    }

    private hasScript(name: string): boolean {
        return typeof (this.provider.scripts as any)?.[name] === 'function';
    }

    async readChat(evaluate: AgentEvaluateFn): Promise<AgentStreamState> {
        const script = this.callScript('readChat');
        if (!script) return this.errorState('readChat script not available');

        try {
            const raw = await evaluate(script) as string;
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (data?.error) {
                const state = this.errorState(data.error);
                if (this.lastSuccessState?.messages?.length) {
                    state.messages = this.lastSuccessState.messages;
                }
                return state;
            }
            const state: AgentStreamState = {
                agentType: this.agentType,
                agentName: this.agentName,
                extensionId: this.extensionId,
                status: data.status || 'idle',
                messages: data.messages || [],
                inputContent: data.inputContent || '',
                model: data.model,
                mode: data.mode,
                activeModal: data.activeModal,
            };
            if (state.messages.length > 0) {
                this.lastSuccessState = state;
            }
            return state;
        } catch {
            const state = this.errorState(`Failed to parse ${this.agentName} state`);
            if (this.lastSuccessState?.messages?.length) {
                state.messages = this.lastSuccessState.messages;
            }
            return state;
        }
    }

    async sendMessage(evaluate: AgentEvaluateFn, text: string): Promise<void> {
        const script = this.callScript('sendMessage', text);
        if (!script) throw new Error(`[${this.agentName}] sendMessage script not available`);
        const result = await evaluate(script) as string;
        if (result && typeof result === 'string' && result.startsWith('error:')) {
            throw new Error(`[${this.agentName}] sendMessage failed: ${result}`);
        }
    }

    async resolveAction(evaluate: AgentEvaluateFn, action: string, button?: string): Promise<boolean> {
        const script = this.callScript('resolveAction', { action, button });
        if (!script) return false; // Not supported if provider has no resolveAction
        return (await evaluate(script)) === true;
    }

    async newSession(evaluate: AgentEvaluateFn): Promise<void> {
        const script = this.callScript('newSession');
        if (!script) throw new Error(`[${this.agentName}] newSession script not available`);
        const result = await evaluate(script) as string;
        if (result && typeof result === 'string' && result.startsWith('error:')) {
            throw new Error(`[${this.agentName}] newSession failed: ${result}`);
        }
        this.lastSuccessState = null;
    }

    async listChats(evaluate: AgentEvaluateFn): Promise<AgentChatListItem[]> {
        const script = this.callScript('listSessions');
        if (!script) return [];
        try {
            const raw = await evaluate(script, 10000) as string;
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (data?.error) return [];
            return Array.isArray(data) ? data : [];
        } catch { return []; }
    }

    async switchSession(evaluate: AgentEvaluateFn, sessionId: string): Promise<boolean> {
        const script = this.callScript('switchSession', sessionId);
        if (!script) return false;
        return (await evaluate(script, 10000)) === true;
    }

    async focusEditor(evaluate: AgentEvaluateFn): Promise<void> {
        const script = this.callScript('focusEditor');
        if (!script) return;
        await evaluate(script);
    }

    private errorState(message: string): AgentStreamState {
        return {
            agentType: this.agentType,
            agentName: this.agentName,
            extensionId: this.extensionId,
            status: 'error',
            messages: [],
            inputContent: '',
            _error: message,
        } as any;
    }
}
