/**
 * buildConversations — Convert raw DaemonData[] (ides) into ActiveConversation[]
 *
 * Pure function: ides + local pending messages → flat conversation list.
 * Reusable across Dashboard, mobile views, widgets, etc.
 */
import type { DaemonData } from '../../types';
import { deriveStreamConversationStatus, formatIdeType, getAgentDisplayName, getMachineDisplayName, isGenericAgentTitle } from '../../utils/daemon-utils';
import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize';
import { isCliConv, isAcpConv } from './types';
import type { ActiveConversation } from './types';

export type LocalUserMessage = {
    role: string;
    content: string;
    timestamp: number;
    _localId: string;
};

interface BuildConversationContext {
    machineName?: string;
    connectionState?: string;
}

// ─── Helper functions ────────────────────────────────────────

/** Conversation-first IDE: CLI or IDE category → native tab */
export const isConversationFirstIde = (ide: DaemonData) => {
    if (ide.transport === 'pty') return true;
    if (ide.transport === 'acp') return true;
    if (ide.transport === 'cdp-page') return true;
    if (ide.daemonId === ide.id) return false;
    return true;
};

export function getWorkspaceName(ide: DaemonData): string {
    const ws = ide.workspace || '';
    if (!ws) return '';
    const parts = ws.split(/[/\\]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : ws;
}

function getStreamKey(stream: { sessionId?: string; instanceId?: string; agentType: string }): string {
    return stream.sessionId || stream.instanceId || stream.agentType;
}

function normalizeMessageContent(content: unknown): string {
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
    if (Array.isArray(content)) {
        return content
            .map(block => {
                if (typeof block === 'string') return block;
                if (block && typeof block === 'object' && 'text' in block) return String((block as any).text || '');
                return '';
            })
            .join('\n')
            .replace(/\s+/g, ' ')
            .trim();
    }
    if (content && typeof content === 'object' && 'text' in content) {
        return String((content as any).text || '').replace(/\s+/g, ' ').trim();
    }
    return String(content || '').replace(/\s+/g, ' ').trim();
}

function getLocalMessages(
    localUserMessages: Record<string, LocalUserMessage[]>,
    keys: Array<string | undefined>,
) {
    const seen = new Set<string>();
    const merged: { role: string; content: string; timestamp: number; _localId: string }[] = [];

    for (const key of keys) {
        if (!key) continue;
        for (const msg of localUserMessages[key] || []) {
            const dedupKey = msg._localId || `${msg.role}:${msg.timestamp}:${msg.content}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            merged.push(msg);
        }
    }

    return merged.sort((a, b) => a.timestamp - b.timestamp);
}

export function buildMachineNameMap(allIdes: DaemonData[] = []): Record<string, string> {
    const machineNames: Record<string, string> = {};
    for (const daemon of allIdes) {
        const entry = daemon as any;
        if (entry.type === 'adhdev-daemon' || entry.daemonMode) {
            machineNames[entry.id] = getMachineDisplayName(entry, { fallbackId: entry.id });
        }
    }
    return machineNames;
}

export function buildIdeConversations(
    ide: DaemonData,
    localUserMessages: Record<string, LocalUserMessage[]>,
    context: BuildConversationContext = {},
): ActiveConversation[] {
    const results: ActiveConversation[] = [];
    const machineName = context.machineName;
    const connectionState = context.connectionState;
    const workspaceName = getWorkspaceName(ide);
    const ideLabel = formatIdeType(ide.type);
    const streams: {
        sessionId?: string;
        instanceId?: string;
        agentType: string;
        agentName: string;
        status: string;
        title?: string;
        messages: any[];
        activeModal?: { message: string; buttons: string[] };
        recentKey?: string;
        unread?: boolean;
        lastSeenAt?: number;
        inboxBucket?: 'needs_attention' | 'working' | 'task_complete' | 'idle';
    }[] = Array.isArray(ide.childSessions)
        ? ide.childSessions.map(child => ({
            sessionId: child.id,
            instanceId: child.id,
            agentType: child.providerType,
            agentName: child.providerName,
            status: child.status,
            title: child.title,
            messages: child.activeChat?.messages || [],
            activeModal: child.activeChat?.activeModal || undefined,
            recentKey: (child as any).recentKey,
            unread: (child as any).unread,
            lastSeenAt: (child as any).lastSeenAt,
            inboxBucket: (child as any).inboxBucket,
        }))
        : [];
    const useConversationFirst = isConversationFirstIde(ide);

    // Parent IDE chat title — shared with extension tabs
    const parentChat = ide.activeChat || { title: '', messages: [] };
    const parentTitle = (parentChat.title && String(parentChat.title).trim()) ? String(parentChat.title).trim() : '';

    // 1) IDE native chat tab
    if (useConversationFirst) {
        const nativeSessionId = (ide as any).sessionId || ide.instanceId;
        const agentName = getAgentDisplayName(ide.type);
        const modal = ide.activeChat?.activeModal;
        const hasRealModal = modal && Array.isArray(modal.buttons) && modal.buttons.length > 0;
        const agentStatus = normalizeManagedStatus(ide.activeChat?.status, { activeModal: ide.activeChat?.activeModal })
            || normalizeManagedStatus(ide.agents?.[0]?.status)
            || 'idle';
        const chat = ide.activeChat || { title: '', messages: [] };
        let title = (chat.title && String(chat.title).trim()) ? String(chat.title).trim() : '';
        const activeId = ide.activeChat?.id;
        const chats = ide.chats as { id: string; title?: string }[] | undefined;
        if (activeId && Array.isArray(chats) && chats.length > 0) {
            const matched = chats.find((c: { id: string; title?: string }) => c.id === activeId || (c.id && String(c.id) === String(activeId)));
            if (matched?.title && String(matched.title).trim()) title = String(matched.title).trim();
        }
        const nativeServerMsgs = chat.messages || [];
        const nativeLocalMsgs = getLocalMessages(localUserMessages, [ide.id, nativeSessionId]);
        const serverContentCounts = new Map<string, number>();
        nativeServerMsgs.filter((m: any) => m.role === 'user').forEach((m: any) => {
            const key = normalizeMessageContent(m.content);
            if (!key) return;
            serverContentCounts.set(key, (serverContentCounts.get(key) || 0) + 1);
        });
        const nativePendingLocal = nativeLocalMsgs.filter(lm => {
            const key = normalizeMessageContent(lm.content);
            const count = serverContentCounts.get(key) || 0;
            if (count > 0) { serverContentCounts.set(key, count - 1); return false; }
            return true;
        });
        results.push({
            ideId: ide.id,
            sessionId: nativeSessionId,
            transport: ide.transport,
            daemonId: ide.daemonId || undefined,
            mode: isCliConv(ide as any) ? (((ide as any).mode as 'terminal' | 'chat' | undefined) || 'terminal') : 'chat',
            agentName,
            agentType: (isCliConv(ide as any) || isAcpConv(ide as any))
                ? ((ide as any).cliType || (ide as any).acpType || ide.type)
                : ide.type,
            status: agentStatus,
            title,
            messages: [...nativeServerMsgs, ...nativePendingLocal],
            resume: (ide as any).resume,
            ideType: (ide as any).cliType || (ide as any).acpType || ide.type,
            workspaceName,
            displayPrimary: title || workspaceName || ((isCliConv(ide as any) || isAcpConv(ide as any)) ? 'Terminal' : agentName),
            displaySecondary: ideLabel,
            cdpConnected: ide.cdpConnected,
            recentKey: (ide as any).recentKey,
            modalButtons: hasRealModal ? (modal.buttons as string[]) : undefined,
            modalMessage: hasRealModal ? (modal.message as string) : undefined,
            unread: (ide as any).unread,
            lastSeenAt: (ide as any).lastSeenAt,
            inboxBucket: (ide as any).inboxBucket,
            streamSource: 'native',
            tabKey: ide.id,
            machineName,
            connectionState,
        });
    }

    // 2) Per-agent-stream tabs
    if (useConversationFirst && (isCliConv(ide as any) || isAcpConv(ide as any))) {
        return results;
    }
    for (const stream of streams) {
        const hasModal = stream.activeModal && Array.isArray(stream.activeModal.buttons) && stream.activeModal.buttons.length > 0;
        const streamStatus = deriveStreamConversationStatus(stream);
        const streamKey = getStreamKey(stream);
        const streamTabKey = `${ide.id}:${streamKey}`;
        const streamTitle = (stream.title && String(stream.title).trim()) || '';
        const effectiveStreamTitle = isGenericAgentTitle(streamTitle, stream.agentName, stream.agentType) ? '' : streamTitle;
        const serverMsgs = stream.messages || [];
        const localMsgs = getLocalMessages(localUserMessages, [streamTabKey, stream.sessionId, stream.instanceId]);
        const serverContentCounts = new Map<string, number>();
        serverMsgs.filter((m: any) => m.role === 'user').forEach((m: any) => {
            const key = normalizeMessageContent(m.content);
            if (!key) return;
            serverContentCounts.set(key, (serverContentCounts.get(key) || 0) + 1);
        });
        const pendingLocal = localMsgs.filter(lm => {
            const key = normalizeMessageContent(lm.content);
            const count = serverContentCounts.get(key) || 0;
            if (count > 0) { serverContentCounts.set(key, count - 1); return false; }
            return true;
        });
        results.push({
            ideId: ide.id,
            sessionId: (stream as any).sessionId || (stream as any).instanceId,
            transport: (stream as any).transport || 'cdp-webview',
            daemonId: ide.daemonId || undefined,
            mode: 'chat',
            agentName: stream.agentName,
            agentType: stream.agentType,
            status: streamStatus,
            title: effectiveStreamTitle,
            messages: [...serverMsgs, ...pendingLocal],
            ideType: stream.agentType,
            workspaceName,
            displayPrimary: effectiveStreamTitle || parentTitle || workspaceName || ideLabel,
            displaySecondary: `${ideLabel}·${stream.agentName}`,
            cdpConnected: ide.cdpConnected,
            recentKey: (stream as any).recentKey ?? (stream as any).id,
            modalButtons: hasModal ? stream.activeModal!.buttons : undefined,
            modalMessage: hasModal ? stream.activeModal!.message : undefined,
            unread: (stream as any).unread,
            lastSeenAt: (stream as any).lastSeenAt,
            inboxBucket: (stream as any).inboxBucket,
            streamSource: 'agent-stream',
            tabKey: streamTabKey,
            machineName,
            connectionState,
        });
    }

    // 3) IDE with neither native nor agent stream → empty tab
    if (results.length === 0) {
        results.push({
            ideId: ide.id,
            sessionId: (ide as any).sessionId || ide.instanceId,
            transport: ide.transport,
            daemonId: ide.daemonId || undefined,
            mode: 'chat',
            agentName: getAgentDisplayName(ide.type),
            agentType: 'ide-native',
            status: 'idle',
            title: '',
            messages: [],
            ideType: ide.type,
            workspaceName,
            displayPrimary: workspaceName || ideLabel,
            displaySecondary: ideLabel,
            cdpConnected: ide.cdpConnected,
            recentKey: (ide as any).recentKey,
            unread: (ide as any).unread,
            lastSeenAt: (ide as any).lastSeenAt,
            inboxBucket: (ide as any).inboxBucket,
            streamSource: 'native',
            tabKey: ide.id,
            connectionState,
        });
    }

    return results;
}

// ─── Main conversion function ────────────────────────────────

/** Derive ActiveConversation[] from ides + localUserMessages */
export function buildConversations(
    chatIdes: DaemonData[],
    localUserMessages: Record<string, LocalUserMessage[]>,
    allIdes?: DaemonData[],
    connectionStates?: Record<string, string>,
): ActiveConversation[] {
    const machineNames = buildMachineNameMap(allIdes);
    return chatIdes.flatMap(ide => {
        const daemonId = ide.daemonId || ide.id?.split(':')[0] || ide.id;
        return buildIdeConversations(ide, localUserMessages, {
            machineName: (ide.daemonId && machineNames[ide.daemonId]) || undefined,
            connectionState: connectionStates ? (connectionStates[daemonId] || 'new') : undefined,
        });
    });
}
