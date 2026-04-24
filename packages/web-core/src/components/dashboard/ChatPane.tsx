
/**
 * ChatPane — Chat view for IDE, ACP, and CLI chat-mode sessions.
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ChatMessageList, { getChatMessageStableKey } from '../ChatMessageList';
import ChatControlsSection from './ChatControlsSection';
import ChatInputBar from './ChatInputBar';
import { getVisibleBarControls } from './ControlsBar';
import ConversationMetaChips from './ConversationMetaChips';
import { getConversationViewStates } from './DashboardMobileChatShared';
import type { ActiveConversation } from './types';
import type { DaemonData } from '../../types';
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader';
import { useDevRenderTrace } from '../../hooks/useDevRenderTrace';
import { IconPlug, IconEye, IconFolder } from '../Icons';
import {
    getMessageTimestamp,
} from './message-utils';
import {
    getConversationControlsContext,
    getConversationDaemonRouteId,
    getConversationDisplayLabel,
    getConversationProviderLabel,
} from './conversation-selectors';
import { getConversationSendBlockMessage } from '../../hooks/dashboardCommandUtils'
import { getDefaultChatTailHydrateLimit, getDefaultVisibleLiveMessages } from './chat-visibility';
import { useSessionChatTailController } from './session-chat-tail-controller';
import { shouldShowOpenPanelAction } from './dashboardSessionCapabilities';

export interface ChatPaneProps {
    activeConv: ActiveConversation;
    ideEntry?: DaemonData;
    handleSendChat: (message: string) => Promise<boolean>;
    isSendingChat?: boolean;
    sendFeedbackMessage?: string | null;
    handleFocusAgent: () => void;
    isFocusingAgent: boolean;
    actionLogs: { routeId: string; text: string; timestamp: number }[];
    /** Display name for user messages */
    userName?: string;
    showMetaChips?: boolean;
    scrollToBottomRequestNonce?: number;
    isInputActive?: boolean;
    isVisible?: boolean;
}

const LIVE_MESSAGE_PAGE_SIZE = 60;

export default function ChatPane({
    activeConv, ideEntry,
    handleSendChat,
    isSendingChat = false,
    sendFeedbackMessage = null,
    handleFocusAgent, isFocusingAgent, actionLogs, userName,
    showMetaChips = false,
    scrollToBottomRequestNonce,
    isInputActive = true,
    isVisible = true,
}: ChatPaneProps) {
    const receivedAtCache = useRef<Map<string, number>>(new Map());
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
    const visibleBarControls = useMemo(
        () => getVisibleBarControls(controlsContext.targetEntry?.providerControls, {
            hostIdeType: activeConv.hostIdeType,
            providerType: controlsContext.providerType,
        }),
        [activeConv.hostIdeType, controlsContext.providerType, controlsContext.targetEntry?.providerControls],
    )
    const defaultVisibleLiveMessages = getDefaultVisibleLiveMessages({
        isCliLike: controlsContext.isCli || controlsContext.isAcp,
    })
    const defaultChatTailHydrateLimit = getDefaultChatTailHydrateLimit({
        isCliLike: controlsContext.isCli || controlsContext.isAcp,
    })
    const chatTailState = useSessionChatTailController(activeConv, {
        enabled: isVisible && !!activeConv.sessionId,
        tailLimit: defaultChatTailHydrateLimit,
    })

    const [visibleLiveCount, setVisibleLiveCount] = useState(defaultVisibleLiveMessages);

    const tabKey = activeConv.tabKey;
    const historyMessages = chatTailState.historyMessages;
    const hasMoreHistory = chatTailState.hasMoreHistory;
    const loadError = chatTailState.historyError;
    const liveMessages = chatTailState.liveMessages.length > 0
        ? chatTailState.liveMessages
        : activeConv.messages;

    useEffect(() => {
        setVisibleLiveCount(defaultVisibleLiveMessages);
    }, [defaultVisibleLiveMessages, tabKey]);
    const hiddenLiveCount = Math.max(0, liveMessages.length - visibleLiveCount);
    const panelLabel = getConversationDisplayLabel(activeConv)
    const daemonId = getConversationDaemonRouteId(activeConv);
    const canOpenPanel = shouldShowOpenPanelAction(activeConv)
    const sendBlockMessage = getConversationSendBlockMessage(activeConv)
    const chatInputStatusMessage = sendFeedbackMessage || sendBlockMessage
    const isChatInputBlocked = !!sendBlockMessage

    const [isLoadingMore, setIsLoadingMore] = useState(false);
    useEffect(() => {
        const targetEntry = controlsContext.targetEntry;
        const needsMetadata = !!daemonId && (
            !targetEntry
            || targetEntry.providerControls === undefined
            || targetEntry.controlValues === undefined
        );

        if (!needsMetadata) return;
        void loadDaemonMetadata(daemonId, { minFreshMs: 30_000 }).catch(() => {});
    }, [
        daemonId,
        controlsContext.isAcp,
        controlsContext.targetEntry?.providerControls,
        controlsContext.targetEntry?.controlValues,
        loadDaemonMetadata,
    ]);

    const handleLoadMore = useCallback(async () => {
        if (isLoadingMore) return;
        if (liveMessages.length > visibleLiveCount) {
            setVisibleLiveCount((current) => Math.min(
                liveMessages.length,
                current + LIVE_MESSAGE_PAGE_SIZE,
            ));
            return;
        }
        setIsLoadingMore(true);
        try {
            await chatTailState.loadHistoryPage()
        } finally {
            setIsLoadingMore(false);
        }
    }, [chatTailState, isLoadingMore, liveMessages.length, visibleLiveCount]);

    const { allMessages, receivedAtMap } = useMemo(() => {
        const visibleLiveMessages = hiddenLiveCount > 0
            ? liveMessages.slice(-visibleLiveCount)
            : liveMessages;
        const allMessages = historyMessages.length === 0
            ? visibleLiveMessages
            : [...historyMessages, ...visibleLiveMessages];
        const nextReceivedAtMap: Record<string, number> = {};
        allMessages.forEach((message, index: number) => {
            const messageKey = `${activeConv.tabKey}:${getChatMessageStableKey(message, index)}`;
            let receivedAt = getMessageTimestamp(message) || receivedAtCache.current.get(messageKey) || 0;
            if (!receivedAt) {
                receivedAt = Date.now();
                receivedAtCache.current.set(messageKey, receivedAt);
            }
            nextReceivedAtMap[getChatMessageStableKey(message, index)] = receivedAt;
        });
        return { allMessages, receivedAtMap: nextReceivedAtMap };
    }, [activeConv.tabKey, hiddenLiveCount, historyMessages, liveMessages, visibleLiveCount]);
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
        if (activeConv.status === 'not_monitored' && canOpenPanel) {
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
        if (activeConv.status === 'panel_hidden' && canOpenPanel) {
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
    }, [activeConv.connectionState, activeConv.status, canOpenPanel, handleFocusAgent, isFocusingAgent, isLoadingMore, liveMessages.length, panelLabel, viewStates.isGenerating]);

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
                isVisible={isVisible}
            />

            <ChatControlsSection
                routeId={activeConv.routeId}
                sessionId={activeConv.sessionId}
                hostIdeType={activeConv.hostIdeType}
                providerType={controlsContext.providerType}
                displayLabel={controlsContext.displayLabel}
                controls={controlsContext.targetEntry?.providerControls}
                controlValues={controlsContext.targetEntry?.controlValues}
                isActive={isInputActive}
                isCliTerminal={controlsContext.isCliTerminal}
            />
            {!controlsContext.isCliTerminal && (
                <ChatInputBar
                    contextKey={activeConv.tabKey}
                    panelLabel={panelLabel}
                    isSending={isSendingChat}
                    isBusy={isChatInputBlocked}
                    statusMessage={chatInputStatusMessage}
                    onSend={handleSendChat}
                    isActive={isInputActive}
                    showControlsToggle={visibleBarControls.length > 0}
                />
            )}
        </div>
    );
}
