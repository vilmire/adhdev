/**
 * buildConversations — Convert raw DaemonData[] (ides) into ActiveConversation[]
 *
 * Pure function: daemon/session state → flat conversation list.
 * Reusable across Dashboard, mobile views, widgets, etc.
 */
import type { DaemonData } from '../../types';
import type { GitCompactSummary, MessageInputSupport, RecentSessionBucket } from '@adhdev/daemon-core';
import { deriveNativeConversationStatus, deriveStreamConversationStatus, formatIdeType, getAgentDisplayName, getMachineDisplayName, isGenericAgentTitle } from '../../utils/daemon-utils';
import { isCliConv, isAcpConv } from './types';
import type { ActiveConversation, DashboardMessage } from './types';
import { getConversationTabKey, resolveOwnerMachineName } from './conversation-identity';

interface BuildConversationContext {
    machineName?: string;
    connectionState?: string;
}

interface SharedConversationBuildContextOptions {
    machineNames?: Record<string, string>;
    connectionStates?: Record<string, string>;
    defaultConnectionState?: string;
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

/**
 * Resolve the tab SUBTITLE = the session's active model name (owner UX:
 * title=folder, subtitle=model, for every provider).
 *
 * Model source priority (best available first):
 *   1. summaryMetadata item id='model' — the provider's own display label for
 *      its running model (e.g. "Kimi K2.7", "Sonnet 4.6"). Prefer the human
 *      `value`, fall back to the compact `shortValue`.
 *   2. controlValues.model — the raw selected model id (e.g. "gpt-5-codex",
 *      "claude-opus-4-8") when no summary label was published.
 * When no model is reliably known we do NOT leave the subtitle blank: fall back
 * to the caller-supplied provider label (getAgentDisplayName / formatIdeType),
 * so a model-less session still shows "Claude Code" / "Opencode Code" / the type.
 */
export function resolveModelSubtitle(ide: DaemonData, providerFallback: string): string {
    return resolveModelName(ide) || providerFallback;
}

/**
 * Extract just the model name (no provider fallback) from any session-shaped
 * entry that carries summaryMetadata / controlValues. Returns '' when no model
 * is reliably reported. Shared by the ide-level subtitle and per-stream subtitle.
 */
function resolveModelName(entry: {
    summaryMetadata?: DaemonData['summaryMetadata'];
    controlValues?: DaemonData['controlValues'];
}): string {
    const modelItem = entry.summaryMetadata?.items?.find(item => item?.id === 'model');
    const summaryModel = (modelItem?.value || modelItem?.shortValue || '').trim();
    if (summaryModel) return summaryModel;
    const rawModel = entry.controlValues?.model;
    if (typeof rawModel === 'string' && rawModel.trim()) return rawModel.trim();
    return '';
}

/** Per-child-session model name (child SessionEntry) or '' when absent. */
function resolveChildModel(child: {
    summaryMetadata?: DaemonData['summaryMetadata'];
    controlValues?: DaemonData['controlValues'];
}): string | undefined {
    return resolveModelName(child) || undefined;
}

function getStreamKey(stream: { sessionId?: string; instanceId?: string; agentType: string }): string {
    return stream.sessionId || stream.instanceId || stream.agentType;
}

function isConversationIdentityDebugEnabled(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return !!((window as any).__ADHDEV_CONVERSATION_DEBUG__ || window.localStorage.getItem('adhdev_conversation_debug') === '1');
    } catch {
        return false;
    }
}

function logConversationIdentitySummary(conversations: ActiveConversation[]): void {
    const tabKeyCounts = new Map<string, number>();
    for (const conversation of conversations) {
        tabKeyCounts.set(conversation.tabKey, (tabKeyCounts.get(conversation.tabKey) || 0) + 1);
    }
    const duplicates = Array.from(tabKeyCounts.entries()).filter(([, count]) => count > 1).map(([tabKey]) => tabKey);
    if (duplicates.length === 0 && !isConversationIdentityDebugEnabled()) return;
    const payload = conversations.map(conversation => ({
        daemonId: conversation.daemonId,
        sessionId: conversation.sessionId,
        providerSessionId: conversation.providerSessionId,
        tabKey: conversation.tabKey,
        duplicate: duplicates.includes(conversation.tabKey),
    }));
    if (duplicates.length > 0) {
        console.warn('[dashboard-conversations] duplicate tabKey detected after buildConversations', { duplicates, conversations: payload });
    } else {
        console.debug('[dashboard-conversations] buildConversations', payload);
    }
}


export function buildMachineNameMap(allIdes: DaemonData[] = []): Record<string, string> {
    const machineNames: Record<string, string> = {};
    for (const daemon of allIdes) {
        if (daemon.type === 'adhdev-daemon') {
            machineNames[daemon.id] = getMachineDisplayName(daemon, { fallbackId: daemon.id });
        }
    }
    return machineNames;
}

export function getIdeConversationBuildContext(
    ide: DaemonData,
    options: SharedConversationBuildContextOptions = {},
): BuildConversationContext {
    const daemonId = ide.daemonId || ide.id?.split(':')[0] || ide.id;
    // Mesh delegated sessions are synthesised into the coordinator's snapshot but belong to a
    // worker node. resolveOwnerMachineName honours the per-session owner attribution (resolved
    // owning daemon's machine name, then an explicit fallback, then the snapshot daemon's machine)
    // so the dashboard shows the worker machine rather than the coordinator's.
    return {
        machineName: resolveOwnerMachineName(ide, options.machineNames),
        connectionState: options.connectionStates
            ? (options.connectionStates[daemonId] || options.defaultConnectionState || 'new')
            : options.defaultConnectionState,
    };
}

export function buildScopedIdeConversations(
    ide: DaemonData,
    options: SharedConversationBuildContextOptions = {},
): ActiveConversation[] {
    return buildIdeConversations(
        ide,
        getIdeConversationBuildContext(ide, options),
    );
}

export function buildIdeConversations(
    ide: DaemonData,
    context: BuildConversationContext = {},
): ActiveConversation[] {
    const results: ActiveConversation[] = [];
    const machineName = context.machineName;
    const connectionState = context.connectionState;
    const workspaceName = getWorkspaceName(ide);
    const workspacePath = ide.workspace || '';
    const providerLabel = getAgentDisplayName(ide.type, { agentName: ide.cliName });
    const ideLabel = (isCliConv(ide) || isAcpConv(ide)) ? providerLabel : formatIdeType(ide.type);
    // Owner UX: tab title = workspace/folder name, subtitle = model name for ALL
    // providers. modelSubtitle falls back to the provider label when no model is
    // reliably reported, so the subtitle is never blank.
    const modelSubtitle = resolveModelSubtitle(ide, ideLabel);
    const streams: {
        sessionId?: string;
        instanceId?: string;
        providerSessionId?: string;
        activeChatId?: string;
        transport?: string;
        sessionCapabilities?: string[];
        agentType: string;
        agentName: string;
        model?: string;
        status: string;
        title?: string;
        lastMessagePreview?: string;
        lastMessageRole?: string;
        lastMessageAt?: number;
        lastMessageHash?: string;
        messages: DashboardMessage[];
        activeModal?: { message: string; buttons: string[] };
        unread?: boolean;
        lastSeenAt?: number;
        lastUpdated?: number;
        inboxBucket?: RecentSessionBucket;
        completionMarker?: string;
        surfaceHidden?: boolean;
        muted?: boolean;
        git?: GitCompactSummary;
        settings?: Record<string, any>;
        coordinator?: { meshId: string; role: 'coordinator' };
        messageInput?: MessageInputSupport;
    }[] = Array.isArray(ide.childSessions)
        ? ide.childSessions.map(child => ({
            sessionId: child.id,
            instanceId: child.id,
            providerSessionId: child.providerSessionId,
            activeChatId: child.activeChat?.id,
            transport: child.transport,
            sessionCapabilities: child.capabilities,
            agentType: child.providerType,
            agentName: child.providerName || formatIdeType(child.providerType),
            model: resolveChildModel(child),
            status: child.status,
            title: child.title,
            lastMessagePreview: child.lastMessagePreview,
            lastMessageRole: child.lastMessageRole,
            lastMessageAt: child.lastMessageAt,
            lastMessageHash: child.lastMessageHash,
            messages: child.activeChat?.messages || [],
            activeModal: child.activeChat?.activeModal || undefined,
            unread: child.unread,
            lastSeenAt: child.lastSeenAt,
            lastUpdated: child.lastUpdated,
            inboxBucket: child.inboxBucket,
            completionMarker: child.completionMarker,
            surfaceHidden: child.surfaceHidden,
            muted: child.muted,
            git: child.git,
            settings: child.settings,
            coordinator: child.coordinator,
            messageInput: child.messageInput,
        }))
        : [];
    const useConversationFirst = isConversationFirstIde(ide);

    // 1) IDE native chat tab
    if (useConversationFirst) {
        const nativeSessionId = ide.sessionId || ide.instanceId;
        const isMeshCoordinator = ide.settings?.meshCoordinatorFor;
        const isMeshNode = ide.settings?.meshNodeFor
            || (!ide.settings?.meshCoordinatorFor && ide.settings?.launchedByCoordinator);
        const roleSuffix = isMeshCoordinator ? ' (Coordinator)' : isMeshNode ? ' (Mesh Node)' : '';
        const agentName = providerLabel + roleSuffix;
        const modal = ide.activeChat?.activeModal;
        const hasRealModal = modal && Array.isArray(modal.buttons) && modal.buttons.length > 0;
        const agentStatus = deriveNativeConversationStatus(
            ide.activeChat,
            [{ status: ide.status, activeModal: ide.activeChat?.activeModal }],
            ide.agents || [],
        );
        const chat = ide.activeChat || { title: '', messages: [] };
        let title = (chat.title && String(chat.title).trim()) ? String(chat.title).trim() : '';
        const activeId = ide.activeChat?.id;
        const chats = ide.chats as { id: string; title?: string }[] | undefined;
        if (activeId && Array.isArray(chats) && chats.length > 0) {
            const matched = chats.find((c: { id: string; title?: string }) => c.id === activeId || (c.id && String(c.id) === String(activeId)));
            if (matched?.title && String(matched.title).trim()) title = String(matched.title).trim();
        }
        const nativeProviderType = (isCliConv(ide) || isAcpConv(ide))
            ? ide.type
            : ide.type;
        const effectiveNativeTitle = (isCliConv(ide) || isAcpConv(ide))
            && isGenericAgentTitle(title, agentName, nativeProviderType)
            ? ''
            : title;
        const nativeServerMsgs = chat.messages || [];
        const normalizedActiveId = typeof activeId === 'string' ? activeId.trim() : '';
        const genericCliActiveId = (isCliConv(ide) || isAcpConv(ide))
            && normalizedActiveId === String(ide.type || '').trim();
        const nativeHistorySessionId = normalizedActiveId && !genericCliActiveId
            ? normalizedActiveId
            : ide.providerSessionId;
        const nativeCoordinator = ide.coordinator
            || (typeof ide.settings?.meshCoordinatorFor === 'string' && ide.settings.meshCoordinatorFor
                ? { meshId: ide.settings.meshCoordinatorFor, role: 'coordinator' as const }
                : undefined);
        results.push({
            routeId: ide.id,
            sessionId: nativeSessionId,
            providerSessionId: ide.providerSessionId,
            historySessionId: nativeHistorySessionId,
            nativeSessionId,
            transport: ide.transport,
            daemonId: ide.daemonId || undefined,
            sessionCapabilities: ide.sessionCapabilities,
            // Default unhydrated CLI mode to 'chat', not 'terminal': before the
            // daemon snapshot delivers the persisted mode, a parsed-chat CLI
            // provider must not flash raw PTY on refresh. See getCliConversationViewMode.
            mode: isCliConv(ide) ? ((ide.mode || 'chat') as 'terminal' | 'chat') : 'chat',
            agentName,
            agentType: nativeProviderType,
            status: agentStatus,
            title: effectiveNativeTitle,
            messages: nativeServerMsgs,
            resume: ide.resume,
            hostIdeType: !isCliConv(ide) && !isAcpConv(ide) ? ide.type : undefined,
            workspaceName,
            workspacePath,
            git: ide.git,
            // Owner UX: folder name is the primary tab label for every provider.
            // Fall back to an explicit chat title, then the provider label, so a
            // workspace-less session still renders something meaningful.
            displayPrimary: workspaceName
                || effectiveNativeTitle
                || (isCliConv(ide)
                    ? ((ide.mode === 'chat') ? agentName : `Terminal${roleSuffix}`)
                    : agentName),
            // Subtitle = active model (falls back to provider label via resolveModelSubtitle).
            displaySecondary: modelSubtitle,
            cdpConnected: ide.cdpConnected,
            lastMessagePreview: ide.lastMessagePreview,
            lastMessageRole: ide.lastMessageRole,
            lastMessageAt: ide.lastMessageAt,
            lastMessageHash: ide.lastMessageHash,
            lastUpdated: ide.lastUpdated,
            inboxBucket: ide.inboxBucket,
            completionMarker: ide.completionMarker,
            modalButtons: hasRealModal ? modal.buttons : undefined,
            modalMessage: hasRealModal ? modal.message : undefined,
            streamSource: 'native',
            tabKey: getConversationTabKey(nativeSessionId, ide.id),
            machineName,
            connectionState,
            settings: ide.settings,
            coordinator: nativeCoordinator,
            messageInput: ide.messageInput,
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
        const hasMeaningfulStream =
            stream.transport === 'cdp-webview'
            || !!stream.sessionId
            || !!stream.providerSessionId
            || serverMsgs.length > 0
            || hasModal
            || !!effectiveStreamTitle
            || !['idle', 'panel_hidden', 'disconnected', 'not_monitored'].includes(streamStatus);
        if (!hasMeaningfulStream) continue;
        const streamCoordinator = stream.coordinator
            || (typeof stream.settings?.meshCoordinatorFor === 'string' && stream.settings.meshCoordinatorFor
                ? { meshId: stream.settings.meshCoordinatorFor, role: 'coordinator' as const }
                : undefined);
        results.push({
            routeId: ide.id,
            sessionId: stream.sessionId || stream.instanceId,
            providerSessionId: stream.providerSessionId,
            historySessionId: stream.activeChatId || stream.providerSessionId,
            nativeSessionId: ide.sessionId || ide.instanceId,
            transport: (stream.transport || 'cdp-webview') as import('../../types').SessionTransport,
            daemonId: ide.daemonId || undefined,
            sessionCapabilities: stream.sessionCapabilities,
            mode: 'chat',
            agentName: stream.agentName,
            agentType: stream.agentType,
            status: streamStatus,
            title: effectiveStreamTitle,
            messages: serverMsgs,
            hostIdeType: ide.type,
            workspaceName,
            workspacePath,
            git: stream.git || ide.git,
            // Owner UX: folder name primary. Subtitle = the stream's model when
            // reported, else the agent identity ("<host> · <agent>").
            displayPrimary: workspaceName || effectiveStreamTitle || stream.agentName || ideLabel,
            displaySecondary: stream.model && stream.model.trim()
                ? stream.model.trim()
                : `${ideLabel} · ${stream.agentName}`,
            cdpConnected: ide.cdpConnected,
            lastMessagePreview: stream.lastMessagePreview,
            lastMessageRole: stream.lastMessageRole,
            lastMessageAt: stream.lastMessageAt,
            lastMessageHash: stream.lastMessageHash,
            lastUpdated: stream.lastUpdated || ide.lastUpdated,
            inboxBucket: stream.inboxBucket,
            completionMarker: stream.completionMarker,
            modalButtons: hasModal ? stream.activeModal!.buttons : undefined,
            modalMessage: hasModal ? stream.activeModal!.message : undefined,
            streamSource: 'agent-stream',
            tabKey: getConversationTabKey(stream.sessionId || stream.instanceId, streamTabKey),
            machineName,
            connectionState,
            settings: stream.settings,
            coordinator: streamCoordinator,
            messageInput: stream.messageInput,
        });
    }

    // 3) IDE with neither native nor agent stream → empty tab
    if (results.length === 0) {
        results.push({
            routeId: ide.id,
            sessionId: ide.sessionId || ide.instanceId,
            providerSessionId: ide.providerSessionId,
            nativeSessionId: ide.sessionId || ide.instanceId,
            transport: ide.transport,
            daemonId: ide.daemonId || undefined,
            sessionCapabilities: ide.sessionCapabilities,
            mode: 'chat',
            agentName: providerLabel,
            agentType: 'ide-native',
            status: 'idle',
            title: '',
            messages: [],
            hostIdeType: ide.type,
            workspaceName,
            workspacePath,
            git: ide.git,
            displayPrimary: workspaceName || ideLabel,
            displaySecondary: modelSubtitle,
            cdpConnected: ide.cdpConnected,
            lastUpdated: ide.lastUpdated,
            streamSource: 'native',
            tabKey: getConversationTabKey(ide.sessionId || ide.instanceId, ide.id),
            connectionState,
            settings: ide.settings,
            messageInput: ide.messageInput,
        });
    }

    return results;
}

// ─── Main conversion function ────────────────────────────────

/** Derive ActiveConversation[] from daemon/session entries. */
export function buildConversations(
    chatIdes: DaemonData[],
    allIdes?: DaemonData[],
    connectionStates?: Record<string, string>,
): ActiveConversation[] {
    const machineNames = buildMachineNameMap(allIdes);
    const conversations = chatIdes
        .filter(ide => !ide.surfaceHidden)
        .flatMap((ide) => buildScopedIdeConversations(ide, {
            machineNames,
            connectionStates,
            defaultConnectionState: 'new',
        }));
    logConversationIdentitySummary(conversations);
    return conversations;
}
