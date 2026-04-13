
/**
 * ChatPane — Chat view for IDE, ACP, and CLI chat-mode sessions.
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ChatMessageList, { getChatMessageStableKey } from '../ChatMessageList';
import ControlsBar from './ControlsBar';
import ChatInputBar from './ChatInputBar';
import ConversationMetaChips from './ConversationMetaChips';
import { getConversationViewStates } from './DashboardMobileChatShared';
import { webDebugStore } from '../../debug/webDebugStore';
import type { ReadChatCursor, ReadChatSyncResult, SessionChatTailUpdate } from '@adhdev/daemon-core';
import type { ActiveConversation, DashboardMessage } from './types';
import type { DaemonData } from '../../types';
import { useTransport } from '../../context/TransportContext';
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader';
import { useDevRenderTrace } from '../../hooks/useDevRenderTrace';
import { subscriptionManager } from '../../managers/SubscriptionManager';
import { IconPlug, IconEye, IconFolder } from '../Icons';
import {
    dedupeOptimisticMessages,
    excludeMessagesPresentInLiveFeed,
    getMessageTimestamp,
    sortMessagesChronologically,
} from './message-utils';
import {
    getConversationControlsContext,
    getConversationDaemonRouteId,
    getConversationDisplayLabel,
    getConversationProviderLabel,
    getConversationProviderType,
} from './conversation-selectors';
import { getDefaultVisibleLiveMessages } from './chat-visibility';

interface ChatHistoryResult {
    messages?: DashboardMessage[];
    hasMore?: boolean;
}

function unwrapChatHistoryResult(raw: unknown): ChatHistoryResult {
    if (!raw || typeof raw !== 'object') return {};
    if ('result' in raw && raw.result && typeof raw.result === 'object') {
        return raw.result as ChatHistoryResult;
    }
    return raw as ChatHistoryResult;
}

function hashSignatureParts(parts: string[]): string {
    let hash = 0x811c9dc5;
    for (const part of parts) {
        const text = String(part || '');
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        hash ^= 0xff;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function buildChatSnapshotSignature(messages: DashboardMessage[], status?: string): string {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return `empty:${status || ''}`;

    let content = '';
    try {
        content = JSON.stringify(lastMessage.content ?? '');
    } catch {
        content = String(lastMessage.content ?? '');
    }

    return [
        status || '',
        messages.length,
        String(lastMessage.id || ''),
        String(lastMessage.index ?? ''),
        String(lastMessage.receivedAt ?? lastMessage.timestamp ?? ''),
        content,
    ].join('|');
}

function buildLastMessageSignature(message: DashboardMessage | null | undefined): string {
    if (!message) return '';
    let content = '';
    try {
        content = JSON.stringify(message.content ?? '');
    } catch {
        content = String(message.content ?? '');
    }
    return hashSignatureParts([
        String(message.id || ''),
        String(message.index ?? ''),
        String(message.role || ''),
        String(message.receivedAt ?? message.timestamp ?? ''),
        content,
    ]);
}

function buildReadChatCursor(messages: DashboardMessage[]): ReadChatCursor {
    return {
        knownMessageCount: messages.length,
        lastMessageSignature: buildLastMessageSignature(messages[messages.length - 1]),
    };
}

function applyReadChatSync(
    previousMessages: DashboardMessage[],
    result: Partial<ReadChatSyncResult>,
): DashboardMessage[] {
    const incomingMessages = Array.isArray(result.messages) ? result.messages as DashboardMessage[] : [];
    switch (result.syncMode) {
        case 'noop':
            return previousMessages;
        case 'append':
            return dedupeOptimisticMessages([...previousMessages, ...incomingMessages]);
        case 'replace_tail': {
            const replaceFrom = Math.max(0, Math.min(Number(result.replaceFrom ?? previousMessages.length), previousMessages.length));
            return dedupeOptimisticMessages([
                ...previousMessages.slice(0, replaceFrom),
                ...incomingMessages,
            ]);
        }
        case 'full':
        default:
            return incomingMessages;
    }
}

export interface ChatPaneProps {
    activeConv: ActiveConversation;
    ideEntry?: DaemonData;
    handleSendChat: (message: string) => void;
    isSendingChat?: boolean;
    handleFocusAgent: () => void;
    isFocusingAgent: boolean;
    actionLogs: { routeId: string; text: string; timestamp: number }[];
    /** Display name for user messages */
    userName?: string;
    showMetaChips?: boolean;
    scrollToBottomRequestNonce?: number;
    isInputActive?: boolean;
}

const LIVE_MESSAGE_PAGE_SIZE = 60;

export default function ChatPane({
    activeConv, ideEntry, handleSendChat,
    isSendingChat = false,
    handleFocusAgent, isFocusingAgent, actionLogs, userName,
    showMetaChips = false,
    scrollToBottomRequestNonce,
    isInputActive = true,
}: ChatPaneProps) {
    const receivedAtCache = useRef<Map<string, number>>(new Map());
    const liveChatCache = useRef<Map<string, DashboardMessage[]>>(new Map());
    const liveChatCursorCache = useRef<Map<string, ReadChatCursor>>(new Map());
    const { sendCommand, sendData } = useTransport();
    const loadDaemonMetadata = useDaemonMetadataLoader();
    useDevRenderTrace('ChatPane', {
        tabKey: activeConv.tabKey,
        messageCount: activeConv.messages.length,
        actionLogCount: actionLogs.length,
        isSendingChat,
    });

    const viewStates = React.useMemo(() => getConversationViewStates(activeConv), [activeConv.status, activeConv.connectionState]);
    const controlsContext = useMemo(
        () => getConversationControlsContext(activeConv, ideEntry),
        [activeConv, ideEntry],
    )
    const defaultVisibleLiveMessages = getDefaultVisibleLiveMessages({
        isCliLike: controlsContext.isCli || controlsContext.isAcp,
    })

    // Per-tab history cache — survives tab switches
    interface TabHistoryState {
        messages: DashboardMessage[];
        offset: number;
        hasMore: boolean;
        error: string | null;
        visibleLiveCount: number;
    }
    const historyCache = useRef<Map<string, TabHistoryState>>(new Map());

    const getTabHistory = useCallback((tabKey: string): TabHistoryState => {
        if (!historyCache.current.has(tabKey)) {
            historyCache.current.set(tabKey, {
                messages: [],
                offset: 0,
                hasMore: true,
                error: null,
                visibleLiveCount: defaultVisibleLiveMessages,
            });
        }
        return historyCache.current.get(tabKey)!;
    }, [defaultVisibleLiveMessages]);

    const updateTabHistory = useCallback((tabKey: string, patch: Partial<TabHistoryState>) => {
        const prev = getTabHistory(tabKey);
        historyCache.current.set(tabKey, { ...prev, ...patch });
        // Force re-render
        setHistoryTick(t => t + 1);
    }, [getTabHistory]);

    const [, setHistoryTick] = useState(0);

    // Derive current tab state
    const tabKey = activeConv.tabKey;
    const tabHistory = getTabHistory(tabKey);
    const historyMessages = tabHistory.messages;
    const hasMoreHistory = tabHistory.hasMore;
    const loadError = tabHistory.error;
    const cachedLiveMessages = liveChatCache.current.get(tabKey);
    const optimisticMessages = activeConv.messages.filter(message => !!message?._localId);
    const liveMessages = cachedLiveMessages
        ? dedupeOptimisticMessages([...cachedLiveMessages, ...optimisticMessages])
        : activeConv.messages;
    useEffect(() => {
        if (tabHistory.visibleLiveCount >= defaultVisibleLiveMessages) return;
        updateTabHistory(tabKey, { visibleLiveCount: defaultVisibleLiveMessages });
    }, [defaultVisibleLiveMessages, tabHistory.visibleLiveCount, tabKey, updateTabHistory]);
    const hiddenLiveCount = Math.max(0, liveMessages.length - tabHistory.visibleLiveCount);
    const panelLabel = getConversationDisplayLabel(activeConv)
    const daemonId = getConversationDaemonRouteId(activeConv);
    const sessionId = activeConv.sessionId || '';
    const historySessionId = activeConv.providerSessionId || sessionId;

    const [isLoadingMore, setIsLoadingMore] = useState(false);
    useEffect(() => {
        const targetEntry = controlsContext.targetEntry;
        const needsMetadata = !!daemonId && (
            !targetEntry
            || targetEntry.providerControls === undefined
            || targetEntry.controlValues === undefined
            || (controlsContext.isAcp && (targetEntry.acpConfigOptions === undefined || targetEntry.acpModes === undefined))
        );

        if (!needsMetadata) return;
        void loadDaemonMetadata(daemonId, { minFreshMs: 30_000 }).catch(() => {});
    }, [
        daemonId,
        controlsContext.isAcp,
        controlsContext.targetEntry?.providerControls,
        controlsContext.targetEntry?.controlValues,
        controlsContext.targetEntry?.acpConfigOptions,
        controlsContext.targetEntry?.acpModes,
        loadDaemonMetadata,
    ]);

    useEffect(() => {
        if (!daemonId || !sessionId || !sendData) return;

        const previousMessages = liveChatCache.current.get(tabKey) || [];
        const cachedCursor = liveChatCursorCache.current.get(tabKey);
        const cursor = cachedCursor && cachedCursor.knownMessageCount
            ? cachedCursor
            : buildReadChatCursor(previousMessages);
        const subscriptionKey = `daemon:${daemonId}:session:${sessionId}`;
        const unsubscribe = subscriptionManager.subscribe(
            { sendData },
            daemonId,
            {
                type: 'subscribe',
                topic: 'session.chat_tail',
                key: subscriptionKey,
                params: {
                    targetSessionId: sessionId,
                    historySessionId,
                    knownMessageCount: cursor.knownMessageCount,
                    lastMessageSignature: cursor.lastMessageSignature,
                    ...(cursor.knownMessageCount ? {} : { tailLimit: LIVE_MESSAGE_PAGE_SIZE }),
                },
            },
            (update: SessionChatTailUpdate) => {
                const currentMessages = liveChatCache.current.get(tabKey) || [];
                const nextMessages = applyReadChatSync(currentMessages, update);
                const totalMessages = Math.max(
                    nextMessages.length,
                    Number(update.totalMessages || 0),
                );
                liveChatCursorCache.current.set(tabKey, {
                    knownMessageCount: totalMessages,
                    lastMessageSignature: typeof update.lastMessageSignature === 'string'
                        ? update.lastMessageSignature
                        : buildLastMessageSignature(nextMessages[nextMessages.length - 1]),
                });
                const unchanged = buildChatSnapshotSignature(currentMessages)
                    === buildChatSnapshotSignature(nextMessages);
                if (unchanged) return;
                liveChatCache.current.set(tabKey, nextMessages);
                webDebugStore.record({
                    interactionId: update.interactionId,
                    kind: 'dashboard.chat_tail_applied',
                    topic: 'session.chat_tail',
                    payload: {
                        sessionId,
                        syncMode: update.syncMode,
                        previousCount: currentMessages.length,
                        nextCount: nextMessages.length,
                    },
                });
                setHistoryTick(t => t + 1);
            },
        );

        return unsubscribe;
    }, [daemonId, historySessionId, sendData, sessionId, tabKey]);

    const handleLoadMore = useCallback(async () => {
        if (isLoadingMore) return;
        const tk = activeConv.tabKey;
        const currentState = getTabHistory(tk);
        if (liveMessages.length > currentState.visibleLiveCount) {
            updateTabHistory(tk, {
                visibleLiveCount: Math.min(
                    liveMessages.length,
                    currentState.visibleLiveCount + LIVE_MESSAGE_PAGE_SIZE,
                ),
                error: null,
            });
            return;
        }
        setIsLoadingMore(true);
        updateTabHistory(tk, { error: null });
        try {
            const daemonId = getConversationDaemonRouteId(activeConv);
            if (!daemonId) {
                updateTabHistory(tk, { hasMore: false });
                return;
            }

            const agentType = getConversationProviderType(activeConv);

            const raw = await sendCommand(daemonId, 'chat_history', {
                agentType,
                offset: currentState.offset,
                limit: 30,
                targetSessionId: activeConv.sessionId,
                historySessionId: activeConv.providerSessionId || activeConv.sessionId,
            });

            const result = unwrapChatHistoryResult(raw);
            const historyMessages = result.messages || [];

            if (historyMessages.length > 0) {
                const fresh = getTabHistory(tk);
                updateTabHistory(tk, {
                    messages: [...historyMessages, ...fresh.messages],
                    offset: fresh.offset + historyMessages.length,
                    hasMore: !!result.hasMore,
                });
            } else {
                updateTabHistory(tk, { hasMore: !!result.hasMore });
            }

        } catch (e: any) {
            const msg = e?.message || '';
            const isTransient = msg.includes('P2P not available')
                || msg.includes('channel not open')
                || msg.includes('P2P not connected')
                || msg.includes('timeout');
            if (!isTransient) {
                updateTabHistory(tk, { hasMore: false, error: 'Failed to load history' });
            } else {
                updateTabHistory(tk, { error: 'Connection not ready — tap to retry' });
            }
        } finally {
            setIsLoadingMore(false);
        }
    }, [isLoadingMore, activeConv, liveMessages.length, sendCommand, getTabHistory, updateTabHistory]);

    const { allMessages, receivedAtMap } = useMemo(() => {
        const visibleLiveMessages = hiddenLiveCount > 0
            ? liveMessages.slice(-tabHistory.visibleLiveCount)
            : liveMessages;
        if (historyMessages.length === 0) {
            const dedupedLiveMessages = sortMessagesChronologically(dedupeOptimisticMessages(visibleLiveMessages));
            const liveReceivedAtMap: Record<string, number> = {};
            dedupedLiveMessages.forEach((message, index: number) => {
                const messageKey = `${activeConv.tabKey}:${getChatMessageStableKey(message, index)}`;
                let receivedAt = getMessageTimestamp(message) || receivedAtCache.current.get(messageKey) || 0;
                if (!receivedAt) {
                    receivedAt = Date.now();
                    receivedAtCache.current.set(messageKey, receivedAt);
                }
                liveReceivedAtMap[getChatMessageStableKey(message, index)] = receivedAt;
            });
            return { allMessages: dedupedLiveMessages, receivedAtMap: liveReceivedAtMap };
        }

        // Dedup: exclude history messages already visible in live feed
        const uniqueHistory = excludeMessagesPresentInLiveFeed(historyMessages, visibleLiveMessages);
        const mergedMessages = sortMessagesChronologically(
            dedupeOptimisticMessages([...uniqueHistory, ...visibleLiveMessages]),
        );
        const nextReceivedAtMap: Record<string, number> = {};
        mergedMessages.forEach((message, index: number) => {
            const messageKey = `${activeConv.tabKey}:${getChatMessageStableKey(message, index)}`;
            let receivedAt = getMessageTimestamp(message) || receivedAtCache.current.get(messageKey) || 0;
            if (!receivedAt) {
                receivedAt = Date.now();
                receivedAtCache.current.set(messageKey, receivedAt);
            }
            nextReceivedAtMap[getChatMessageStableKey(message, index)] = receivedAt;
        });
        return { allMessages: mergedMessages, receivedAtMap: nextReceivedAtMap };
    }, [activeConv.tabKey, hiddenLiveCount, historyMessages, liveMessages, tabHistory.visibleLiveCount]);
    const visibleActionLogs = useMemo(
        () => actionLogs
            .filter(l => l.routeId === activeConv.tabKey)
            .sort((a, b) => a.timestamp - b.timestamp),
        [actionLogs, activeConv.tabKey],
    );
    const emptyState = useMemo(() => {
        if (liveMessages.length !== 0) return undefined;
        if (activeConv.connectionState === 'connecting' || activeConv.connectionState === 'new') {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-4">
                    <div className="connecting-logo-float">
                        <div style={{
                            width: 64, height: 64, borderRadius: '50%',
                            background: 'radial-gradient(circle, rgba(96,165,250,0.12), transparent 70%)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 0 40px rgba(96,165,250,0.08)',
                        }}>
                            <img src="/otter-logo.png" alt="ADHDev" style={{ width: 40, height: 40, borderRadius: '50%', opacity: 0.85 }} />
                        </div>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                        <div className="text-[13px] text-blue-400 font-medium">Connecting to your machine<span className="connecting-dots"></span></div>
                        <div className="text-[11px] opacity-35">Establishing P2P connection</div>
                    </div>
                </div>
            );
        }
        if (viewStates.isGenerating || activeConv.status === 'streaming') {
            setIsLoadingMore(false);
        }
        if (activeConv.status === 'not_monitored') {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="text-3xl opacity-60"><IconPlug size={28} /></div>
                    <div className="text-[13px] opacity-50">Agent not monitored</div>
                    <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                        {isFocusingAgent ? '⌛ Switching...' : <span className="flex items-center gap-1.5"><IconFolder size={14} /> Open {panelLabel} Panel</span>}
                    </button>
                    <div className="text-[11px] opacity-35 max-w-[280px]">Click to switch monitoring to this agent</div>
                </div>
            );
        }
        if (activeConv.status === 'panel_hidden') {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="text-3xl opacity-60"><IconEye size={28} /></div>
                    <div className="text-[13px] opacity-50">Agent panel is not visible yet</div>
                    <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                        {isFocusingAgent ? '⌛ Opening...' : <span className="flex items-center gap-1.5"><IconFolder size={14} /> Open {panelLabel} Panel</span>}
                    </button>
                    <div className="text-[11px] opacity-35 max-w-[280px]">Open the agent panel or chat view in the app you are using to start viewing messages</div>
                </div>
            );
        }
        if (activeConv.status === 'idle' && !isLoadingMore) {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="text-2xl opacity-40 animate-pulse">💬</div>
                    <div className="text-[13px] opacity-40">Loading chat...</div>
                </div>
            );
        }
        return undefined;
    }, [activeConv.connectionState, activeConv.status, handleFocusAgent, isFocusingAgent, isLoadingMore, liveMessages.length, panelLabel, viewStates.isGenerating]);

    return (
        <div className="flex-1 min-h-0 w-full flex flex-col">
            {showMetaChips && (
                <ConversationMetaChips conversation={activeConv} className="chat-pane-meta-row" />
            )}

            {/* Message Stream */}
                <ChatMessageList
                messages={allMessages}
                actionLogs={visibleActionLogs}
                agentName={getConversationProviderLabel(activeConv) || panelLabel || 'Agent'}
                userName={userName}
                isCliMode={controlsContext.isCli || controlsContext.isAcp}
                isWorking={viewStates.isGenerating}
                contextKey={activeConv.tabKey}
                receivedAtMap={receivedAtMap}
                onLoadMore={handleLoadMore}
                isLoadingMore={isLoadingMore}
                hasMoreHistory={hasMoreHistory}
                hiddenLiveCount={hiddenLiveCount}
                loadError={loadError ?? undefined}
                emptyState={emptyState}
                scrollToBottomRequestNonce={scrollToBottomRequestNonce}
            />

            {/* Controls Bar (dynamic or legacy fallback) */}
            {isInputActive && !controlsContext.isCliTerminal && (() => {
                return (
                    <ControlsBar
                        routeId={activeConv.routeId}
                        sessionId={activeConv.sessionId}
                        hostIdeType={activeConv.hostIdeType}
                        providerType={controlsContext.providerType}
                        displayLabel={controlsContext.displayLabel}
                        controls={controlsContext.targetEntry?.providerControls}
                        controlValues={controlsContext.targetEntry?.controlValues}
                        serverModel={controlsContext.targetEntry?.currentModel || undefined}
                        serverMode={controlsContext.targetEntry?.currentPlan || undefined}
                        acpConfigOptions={controlsContext.isAcp ? controlsContext.targetEntry?.acpConfigOptions : undefined}
                        acpModes={controlsContext.isAcp ? controlsContext.targetEntry?.acpModes : undefined}
                    />
                );
            })()}
            {!controlsContext.isCliTerminal && (
                <ChatInputBar
                    contextKey={activeConv.tabKey}
                    panelLabel={panelLabel}
                    isSending={isSendingChat}
                    onSend={handleSendChat}
                    isActive={isInputActive}
                />
            )}
        </div>
    );
}
