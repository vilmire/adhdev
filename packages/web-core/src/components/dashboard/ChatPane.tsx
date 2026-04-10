
/**
 * ChatPane — Chat view for IDE, ACP, and CLI chat-mode sessions.
 */
import React, { useRef, useState, useCallback, useMemo } from 'react';
import ChatMessageList, { getChatMessageStableKey } from '../ChatMessageList';
import ControlsBar from './ControlsBar';
import ChatInputBar from './ChatInputBar';
import ConversationMetaChips from './ConversationMetaChips';
import { getConversationViewStates } from './DashboardMobileChatShared';
import type { ActiveConversation, DashboardMessage } from './types';
import type { DaemonData } from '../../types';
import { useTransport } from '../../context/TransportContext';
import { useDevRenderTrace } from '../../hooks/useDevRenderTrace';
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

export interface ChatPaneProps {
    activeConv: ActiveConversation;
    ideEntry?: DaemonData;
    handleSendChat: (message: string) => void;
    isSendingChat?: boolean;
    handleFocusAgent: () => void;
    isFocusingAgent: boolean;
    actionLogs: { ideId: string; text: string; timestamp: number }[];
    /** Display name for user messages */
    userName?: string;
    showMetaChips?: boolean;
    scrollToBottomRequestNonce?: number;
    isInputActive?: boolean;
}

const DEFAULT_VISIBLE_LIVE_MESSAGES = 60;
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
    const { sendCommand } = useTransport();
    useDevRenderTrace('ChatPane', {
        tabKey: activeConv.tabKey,
        messageCount: activeConv.messages.length,
        actionLogCount: actionLogs.length,
        isSendingChat,
    });

    const viewStates = React.useMemo(() => getConversationViewStates(activeConv), [activeConv.status, activeConv.connectionState]);

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
                visibleLiveCount: DEFAULT_VISIBLE_LIVE_MESSAGES,
            });
        }
        return historyCache.current.get(tabKey)!;
    }, []);

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
    const hiddenLiveCount = Math.max(0, activeConv.messages.length - tabHistory.visibleLiveCount);

    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const handleLoadMore = useCallback(async () => {
        if (isLoadingMore) return;
        const tk = activeConv.tabKey;
        const currentState = getTabHistory(tk);
        if (activeConv.messages.length > currentState.visibleLiveCount) {
            updateTabHistory(tk, {
                visibleLiveCount: Math.min(
                    activeConv.messages.length,
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
    }, [isLoadingMore, ideEntry, activeConv, sendCommand, getTabHistory, updateTabHistory]);

    const { allMessages, receivedAtMap } = useMemo(() => {
        const liveMessages = hiddenLiveCount > 0
            ? activeConv.messages.slice(-tabHistory.visibleLiveCount)
            : activeConv.messages;
        if (historyMessages.length === 0) {
            const dedupedLiveMessages = sortMessagesChronologically(dedupeOptimisticMessages(liveMessages));
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
        const uniqueHistory = excludeMessagesPresentInLiveFeed(historyMessages, liveMessages);
        const mergedMessages = sortMessagesChronologically(
            dedupeOptimisticMessages([...uniqueHistory, ...liveMessages]),
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
    }, [activeConv.messages, activeConv.tabKey, hiddenLiveCount, historyMessages, tabHistory.visibleLiveCount]);
    const visibleActionLogs = useMemo(
        () => actionLogs
            .filter(l => l.ideId === activeConv.tabKey)
            .sort((a, b) => a.timestamp - b.timestamp),
        [actionLogs, activeConv.tabKey],
    );
    const panelLabel = getConversationDisplayLabel(activeConv)
    const controlsContext = useMemo(
        () => getConversationControlsContext(activeConv, ideEntry),
        [activeConv, ideEntry],
    )
    const emptyState = useMemo(() => {
        if (activeConv.messages.length !== 0) return undefined;
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
    }, [activeConv.messages.length, activeConv.connectionState, activeConv.status, handleFocusAgent, isFocusingAgent, isLoadingMore, panelLabel, viewStates.isGenerating]);

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
                        ideId={activeConv.ideId}
                        sessionId={activeConv.sessionId}
                        ideType={activeConv.ideType}
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
