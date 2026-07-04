/**
 * Shared types for Dashboard components
 */

import type { GitCompactSummary, MessageInputSupport, RecentSessionBucket, SessionTransport } from '@adhdev/daemon-core';
import type { ChatMessage } from '../../types';

export type CliConversationViewMode = 'terminal' | 'chat';
export type DashboardMessage = ChatMessage & { _localId?: string; _turnKey?: string };

export interface ActiveConversation {
    routeId: string;
    sessionId?: string;
    providerSessionId?: string;
    historySessionId?: string;
    nativeSessionId?: string;
    transport?: SessionTransport;
    /** Daemon DO ID — actual server connection ID for command routing */
    daemonId?: string;
    mode?: 'terminal' | 'chat';
    agentName: string;
    agentType: string;
    status: string;
    title: string;
    messages: DashboardMessage[];
    resume?: import('../../types').ProviderResumeCapability;
    hostIdeType?: string;
    workspaceName: string;
    /** Full workspace path, when available. workspaceName is display-only/basename. */
    workspacePath?: string;
    /** Compact daemon-owned Git state for the backing session/workspace. */
    git?: GitCompactSummary;
    displayPrimary: string;
    displaySecondary: string;
    cdpConnected?: boolean;
    lastMessagePreview?: string;
    lastMessageRole?: string;
    lastMessageAt?: number;
    lastMessageHash?: string;
    lastUpdated?: number;
    inboxBucket?: RecentSessionBucket;
    completionMarker?: string;
    modalButtons?: string[];
    modalMessage?: string;
    streamSource: 'native' | 'agent-stream';
    tabKey: string;
    /** Parent machine name (hostname or nickname) */
    machineName?: string;
    /** Parent daemon's connection status (injected by platform) */
    connectionState?: string;
    sessionCapabilities?: string[];
    settings?: Record<string, any>;
    /** Set when this session is acting as a mesh coordinator. Survives daemon restart via registry. */
    coordinator?: { meshId: string; role: 'coordinator' };
    meshQueueStats?: {
        total?: number;
        active?: number;
        historical?: number;
        pending: number;
        assigned: number;
        completed: number;
        failed: number;
        cancelled?: number;
    };
    /** Effective message input/media support. Absent → text-only. */
    messageInput?: MessageInputSupport;
}

/** CLI detection: PTY transport */
export const isCliConv = (conv: { transport?: string }) =>
    conv.transport === 'pty';

export const getCliConversationViewMode = (
    conv: { transport?: string; mode?: 'terminal' | 'chat' },
    override?: CliConversationViewMode,
): CliConversationViewMode => {
    if (!isCliConv(conv)) return 'chat';
    // Unhydrated CLI mode (undefined before the daemon snapshot delivers the
    // persisted mode) must default to 'chat', not 'terminal'. Parsed-chat CLI
    // providers (e.g. antigravity-cli, transport=pty, real mode 'chat') would
    // otherwise flash/stick on raw PTY on refresh until the snapshot arrives.
    return override || conv.mode || 'chat';
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
