/**
 * Shared types for Dashboard components
 */

export interface ActiveConversation {
    ideId: string;
    sessionId?: string;
    transport?: 'cdp-page' | 'cdp-webview' | 'pty' | 'acp';
    /** Daemon DO ID — actual server connection ID for command routing */
    daemonId?: string;
    mode?: 'terminal' | 'chat';
    agentName: string;
    agentType: string;
    status: string;
    title: string;
    messages: any[];
    terminalHistory?: string;
    resume?: import('../../types').ProviderResumeCapability;
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

/** CLI detection: PTY transport */
export const isCliConv = (conv: { transport?: string }) =>
    conv.transport === 'pty';

/** ACP detection: ACP transport */
export const isAcpConv = (conv: { transport?: string }) =>
    conv.transport === 'acp';
