/**
 * ProviderStreamAdapter — generic Extension adapter based on provider.js
 *
 * Consolidates ClineAdapter, RooCodeAdapter, ContinueAdapter.
 * Auto-configured using provider.js scripts + metadata.
 */
import type { IAgentStreamAdapter, AgentStreamState, AgentChatListItem, AgentEvaluateFn } from './types.js';
import type { ProviderModule, FocusEditorResult, OpenPanelResult } from '../providers/contracts.js';
export declare class ProviderStreamAdapter implements IAgentStreamAdapter {
    readonly agentType: string;
    readonly agentName: string;
    readonly extensionId: string;
    readonly extensionIdPattern: RegExp;
    private provider;
    private lastSuccessState;
    constructor(provider: ProviderModule);
    private callScript;
    private hasScript;
    private getStateTitle;
    private parseMaybeJson;
    private summarizeRaw;
    private isTransportError;
    private titlesMatch;
    private messageCount;
    private lastMessageSignature;
    private verifySendOutcome;
    private readStableBaselineState;
    readChat(evaluate: AgentEvaluateFn): Promise<AgentStreamState>;
    sendMessage(evaluate: AgentEvaluateFn, text: string): Promise<void>;
    resolveAction(evaluate: AgentEvaluateFn, action: string, button?: string): Promise<boolean>;
    newSession(evaluate: AgentEvaluateFn): Promise<void>;
    listChats(evaluate: AgentEvaluateFn): Promise<AgentChatListItem[]>;
    switchSession(evaluate: AgentEvaluateFn, sessionId: string): Promise<boolean>;
    focusEditor(evaluate: AgentEvaluateFn): Promise<FocusEditorResult>;
    openPanel(evaluate: AgentEvaluateFn): Promise<OpenPanelResult>;
    private errorState;
}
