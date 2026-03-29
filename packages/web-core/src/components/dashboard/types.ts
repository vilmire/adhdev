/**
 * Shared types for Dashboard components
 */

export interface ActiveConversation {
    ideId: string;
    /** Daemon DO ID — actual server connection ID for command routing */
    daemonId?: string;
    mode?: 'terminal' | 'chat';
    agentName: string;
    agentType: string;
    status: string;
    title: string;
    messages: any[];
    ideType: string;
    workspaceName: string;
    displayPrimary: string;
    displaySecondary: string;
    cdpConnected?: boolean;
    modalButtons?: string[];
    modalMessage?: string;
    streamSource: 'native' | 'agent-stream';
    tabKey: string;
    /** Parent machine name (hostname or nickname) */
    machineName?: string;
    /** Parent daemon's connection status (injected by platform) */
    connectionState?: string;
}

/** CLI detection: id includes ':cli:' */
export const isCliConv = (conv: { ideType?: string; agentType?: string; ideId?: string; tabKey?: string; id?: string }) =>
    (conv.ideId || conv.tabKey || conv.id || '').includes(':cli:');

/** ACP detection: id includes ':acp:' */
export const isAcpConv = (conv: { ideType?: string; agentType?: string; ideId?: string; tabKey?: string; id?: string }) =>
    (conv.ideId || conv.tabKey || conv.id || '').includes(':acp:');
