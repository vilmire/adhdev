/**
 * Agent Stream Types — ported for Daemon (identical to original)
 * 
 * Agent stream types.
 * No vscode dependency — can be used as-is.
 */

/** Agent chat message */
export interface AgentChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: number;
}

/** Agent chat history item */
export interface AgentChatListItem {
    title: string;
    id: string;
    status?: string;
    time?: string;
    cost?: string;
}

/** Agent stream status */
export interface AgentStreamState {
    agentType: string;
    agentName: string;
    extensionId: string;
    status: 'idle' | 'streaming' | 'waiting_approval' | 'error' | 'disconnected' | 'panel_hidden' | 'not_monitored';
    messages: AgentChatMessage[];
    inputContent: string;
    model?: string;
    mode?: string;
    activeModal?: { message: string; buttons: string[] };
}

/** Agent webview target info */
export interface AgentWebviewTarget {
    targetId: string;
    extensionId: string;
    agentType: string;
    url: string;
}

/** Agent stream adapter interface */
export interface IAgentStreamAdapter {
    readonly agentType: string;
    readonly agentName: string;
    readonly extensionId: string;
    readonly extensionIdPattern: RegExp;

    readChat(evaluate: AgentEvaluateFn): Promise<AgentStreamState>;
    sendMessage(evaluate: AgentEvaluateFn, text: string): Promise<void>;
    resolveAction(evaluate: AgentEvaluateFn, action: string, button?: string): Promise<boolean>;
    newSession(evaluate: AgentEvaluateFn): Promise<void>;
    listChats?(evaluate: AgentEvaluateFn): Promise<AgentChatListItem[]>;
    switchSession?(evaluate: AgentEvaluateFn, sessionId: string): Promise<boolean>;
    focusEditor?(evaluate: AgentEvaluateFn): Promise<void>;
    setProvider?(provider: any): void;
}

export type AgentEvaluateFn = (expression: string, timeoutMs?: number) => Promise<unknown>;
