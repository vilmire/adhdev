/**
 * Shared types for Dashboard components
 */

import type { SessionTransport } from '@adhdev/daemon-core';

export type CliConversationViewMode = 'terminal' | 'chat';

export interface ActiveConversation {
    ideId: string;
    sessionId?: string;
    providerSessionId?: string;
    nativeSessionId?: string;
    transport?: SessionTransport;
    /** Daemon DO ID — actual server connection ID for command routing */
    daemonId?: string;
    mode?: 'terminal' | 'chat';
    agentName: string;
    agentType: string;
    status: string;
    title: string;
    messages: any[];
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

export const getCliConversationViewMode = (
    conv: { transport?: string; mode?: 'terminal' | 'chat' },
    override?: CliConversationViewMode,
): CliConversationViewMode => {
    if (!isCliConv(conv)) return 'chat';
    return override || conv.mode || 'terminal';
};

/** CLI chat mode detection: PTY transport rendered as chat */
export const isCliChatConv = (
    conv: { transport?: string; mode?: 'terminal' | 'chat' },
    override?: CliConversationViewMode,
) =>
    isCliConv(conv) && getCliConversationViewMode(conv, override) === 'chat';

/** CLI terminal detection: PTY transport rendered as terminal */
export const isCliTerminalConv = (
    conv: { transport?: string; mode?: 'terminal' | 'chat' },
    override?: CliConversationViewMode,
) =>
    isCliConv(conv) && getCliConversationViewMode(conv, override) === 'terminal';

/** ACP detection: ACP transport */
export const isAcpConv = (conv: { transport?: string }) =>
    conv.transport === 'acp';
