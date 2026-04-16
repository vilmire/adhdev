/**
 * Agent Stream Types — ported for Daemon (identical to original)
 * 
 * Agent stream types.
 * No vscode dependency — can be used as-is.
 */

import type { ProviderEffect, FocusEditorResult, OpenPanelResult } from '../providers/contracts.js';
import type { ProviderSummaryMetadata } from '../shared-types.js';
import type { ChatMessageKind } from '../providers/chat-message-normalization.js';

/** Agent chat message */
export interface AgentChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    kind?: ChatMessageKind;
    timestamp?: number;
    receivedAt?: number;
    id?: string;
    index?: number;
    meta?: Record<string, unknown>;
    senderName?: string;
    _type?: string;
    _sub?: string;
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
    sessionId?: string;
    providerSessionId?: string;
    status: 'idle' | 'streaming' | 'waiting_approval' | 'error' | 'disconnected' | 'panel_hidden' | 'not_monitored';
    messages: AgentChatMessage[];
    inputContent: string;
    title?: string;
    activeModal?: { message: string; buttons: string[] };
    error?: string;
    _error?: string;
    /** Dynamic control current values (populated from readChat + provider controls schema) */
    controlValues?: Record<string, string | number | boolean>;
    /** Flexible compact/live summary metadata from readChat */
    summaryMetadata?: ProviderSummaryMetadata;
    /** Provider-driven UI effects from readChat */
    effects?: ProviderEffect[];
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
    focusEditor?(evaluate: AgentEvaluateFn): Promise<FocusEditorResult>;
    openPanel?(evaluate: AgentEvaluateFn): Promise<OpenPanelResult>;
    setProvider?(provider: any): void;
}

export type AgentEvaluateFn = (expression: string, timeoutMs?: number) => Promise<unknown>;
