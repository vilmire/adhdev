/**
 * buildConversations — Convert raw DaemonData[] (ides) into ActiveConversation[]
 *
 * Pure function: ides + local pending messages → flat conversation list.
 * Reusable across Dashboard, mobile views, widgets, etc.
 */
import type { DaemonData } from '../../types';
import type { RecentSessionBucket } from '@adhdev/daemon-core';
import { deriveStreamConversationStatus, formatIdeType, getAgentDisplayName, getMachineDisplayName, isGenericAgentTitle } from '../../utils/daemon-utils';
import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize';
import { isCliConv, isAcpConv } from './types';
import type { ActiveConversation } from './types';
import { normalizeTextContent } from '../../utils/text';

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

function getConversationTabKey(sessionId: string | undefined, fallbackKey: string): string {
    return sessionId || fallbackKey;
}

function normalizeMessageContent(content: unknown): string {
    return normalizeTextContent(content)
}

function getMessageTimestamp(message: any): number {
    const ts = Number(message?.receivedAt || 0)
    return Number.isFinite(ts) ? ts : 0
}

function isLikelySameMessage(a: any, b: any): boolean {
    if (!a || !b) return false
    if (a === b) return true
    if (a.id && b.id && String(a.id) === String(b.id)) return true
    if (a._localId && b._localId && String(a._localId) === String(b._localId)) return true

    const roleA = String(a.role || '').toLowerCase()
    const roleB = String(b.role || '').toLowerCase()
    if (roleA !== roleB) return false

    const contentA = normalizeMessageContent(a.content)
    const contentB = normalizeMessageContent(b.content)
    if (!contentA || contentA !== contentB) return false

    const tsA = getMessageTimestamp(a)
    const tsB = getMessageTimestamp(b)
    if (tsA && tsB) return Math.abs(tsA - tsB) <= 15000

    return !!a._localId !== !!b._localId
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
        if (daemon.type === 'adhdev-daemon' || daemon.daemonMode) {
            machineNames[daemon.id] = getMachineDisplayName(daemon, { fallbackId: daemon.id });
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
        providerSessionId?: string;
        transport?: string;
        agentType: string;
        agentName: string;
        status: string;
        title?: string;
        messages: any[];
        activeModal?: { message: string; buttons: string[] };
        unread?: boolean;
        lastSeenAt?: number;
        lastUpdated?: number;
        inboxBucket?: RecentSessionBucket;
        surfaceHidden?: boolean;
    }[] = Array.isArray(ide.childSessions)
        ? ide.childSessions.map(child => ({
            sessionId: child.id,
            instanceId: child.id,
            providerSessionId: child.providerSessionId,
            transport: child.transport,
            agentType: child.providerType,
            agentName: child.providerName,
            status: child.status,
            title: child.title,
            messages: child.activeChat?.messages || [],
            activeModal: child.activeChat?.activeModal || undefined,
            unread: child.unread,
            lastSeenAt: child.lastSeenAt,
            lastUpdated: child.lastUpdated,
            inboxBucket: child.inboxBucket,
            surfaceHidden: child.surfaceHidden,
        }))
        : [];
    const useConversationFirst = isConversationFirstIde(ide);

    // Parent IDE chat title — shared with extension tabs
    const parentChat = ide.activeChat || { title: '', messages: [] };
    const parentTitle = (parentChat.title && String(parentChat.title).trim()) ? String(parentChat.title).trim() : '';

    // 1) IDE native chat tab
    if (useConversationFirst) {
        const nativeSessionId = ide.sessionId || ide.instanceId;
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
        const nativeProviderType = (isCliConv(ide) || isAcpConv(ide))
            ? ((ide as any).cliType || (ide as any).acpType || ide.type)
            : ide.type;
        const effectiveNativeTitle = (isCliConv(ide) || isAcpConv(ide))
            && isGenericAgentTitle(title, agentName, nativeProviderType)
            ? ''
            : title;
        const nativeServerMsgs = chat.messages || [];
        const nativeLocalMsgs = getLocalMessages(localUserMessages, [ide.id, nativeSessionId]);
        const unmatchedNativeServerUsers = nativeServerMsgs
            .filter((m: any) => String(m?.role || '').toLowerCase() === 'user')
            .slice();
        const nativePendingLocal = nativeLocalMsgs.filter(lm => {
            const matchIndex = unmatchedNativeServerUsers.findIndex(serverMsg => isLikelySameMessage(serverMsg, lm));
            if (matchIndex >= 0) {
                unmatchedNativeServerUsers.splice(matchIndex, 1);
                return false;
            }
            return true;
        });
        results.push({
            ideId: ide.id,
            sessionId: nativeSessionId,
            providerSessionId: ide.providerSessionId,
            nativeSessionId,
            transport: ide.transport,
            daemonId: ide.daemonId || undefined,
            mode: isCliConv(ide) ? ((ide.mode || 'terminal') as 'terminal' | 'chat') : 'chat',
            agentName,
            agentType: nativeProviderType,
            status: agentStatus,
            title: effectiveNativeTitle,
            messages: [...nativeServerMsgs, ...nativePendingLocal],
            resume: ide.resume,
            ideType: nativeProviderType,
            workspaceName,
            displayPrimary: workspaceName
                || effectiveNativeTitle
                || (isCliConv(ide)
                    ? ((ide.mode === 'chat') ? agentName : 'Terminal')
                    : agentName),
            displaySecondary: ideLabel,
            cdpConnected: ide.cdpConnected,
            modalButtons: hasRealModal ? (modal.buttons as string[]) : undefined,
            modalMessage: hasRealModal ? (modal.message as string) : undefined,
            streamSource: 'native',
            tabKey: getConversationTabKey(nativeSessionId, ide.id),
            machineName,
            connectionState,
        });
    }

    // 2) Per-agent-stream tabs
    if (useConversationFirst && (isCliConv(ide) || isAcpConv(ide))) {
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
        const unmatchedServerUsers = serverMsgs
            .filter((m: any) => String(m?.role || '').toLowerCase() === 'user')
            .slice();
        const pendingLocal = localMsgs.filter(lm => {
            const matchIndex = unmatchedServerUsers.findIndex(serverMsg => isLikelySameMessage(serverMsg, lm));
            if (matchIndex >= 0) {
                unmatchedServerUsers.splice(matchIndex, 1);
                return false;
            }
            return true;
        });
        const hasMeaningfulStream =
            stream.transport === 'cdp-webview'
            || !!stream.sessionId
            || !!stream.providerSessionId
            || serverMsgs.length > 0
            || pendingLocal.length > 0
            || hasModal
            || !!effectiveStreamTitle
            || !['idle', 'panel_hidden', 'disconnected', 'not_monitored'].includes(streamStatus);
        if (!hasMeaningfulStream) continue;
        results.push({
            ideId: ide.id,
            sessionId: stream.sessionId || stream.instanceId,
            providerSessionId: stream.providerSessionId,
            nativeSessionId: ide.sessionId || ide.instanceId,
            transport: (stream.transport || 'cdp-webview') as import('../../types').SessionTransport,
            daemonId: ide.daemonId || undefined,
            mode: 'chat',
            agentName: stream.agentName,
            agentType: stream.agentType,
            status: streamStatus,
            title: effectiveStreamTitle,
            messages: [...serverMsgs, ...pendingLocal],
            ideType: stream.agentType,
            workspaceName,
            displayPrimary: workspaceName || parentTitle || effectiveStreamTitle || ideLabel,
            displaySecondary: `${ideLabel} · ${stream.agentName}`,
            cdpConnected: ide.cdpConnected,
            modalButtons: hasModal ? stream.activeModal!.buttons : undefined,
            modalMessage: hasModal ? stream.activeModal!.message : undefined,
            streamSource: 'agent-stream',
            tabKey: getConversationTabKey(stream.sessionId || stream.instanceId, streamTabKey),
            machineName,
            connectionState,
        });
    }

    // 3) IDE with neither native nor agent stream → empty tab
    if (results.length === 0) {
        results.push({
            ideId: ide.id,
            sessionId: ide.sessionId || ide.instanceId,
            providerSessionId: ide.providerSessionId,
            nativeSessionId: ide.sessionId || ide.instanceId,
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
            streamSource: 'native',
            tabKey: getConversationTabKey(ide.sessionId || ide.instanceId, ide.id),
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
