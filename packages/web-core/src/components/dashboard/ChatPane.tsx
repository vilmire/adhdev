
/**
 * ChatPane — Chat view for IDE, ACP, and CLI chat-mode sessions.
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ChatMessageList, { getChatMessageStableKey } from '../ChatMessageList';
import ChatControlsSection from './ChatControlsSection';
import ChatInputBar, { type ImageAttachment } from './ChatInputBar';
import PendingQueueStrip from './PendingQueueStrip';
import SessionInfoButton from './SessionInfoButton';
import ConversationMuteButton from './ConversationMuteButton';
import { getVisibleBarControls } from './ControlsBar';
import { useControlsBarVisibility } from '../../hooks/useControlsBarVisibility';
import { useTransport } from '../../context/TransportContext';
import { unwrapCommandResult } from '../../hooks/useDashboardConversationCommands';
import { buildChatDebugBundleClipboardText, buildChatDebugBundleToastMessage, buildChatFrontendDebugSnapshot, copyChatDebugBundleTextToClipboard, recordControlsToggleDebugGesture, type ControlsToggleDebugGestureState } from './chat-debug-bundle';
import { eventManager } from '../../managers/EventManager';
import { getConversationViewStates } from './DashboardMobileChatShared';
import type { ToolExpandState } from '../ChatMessageList/chatMessageBubbles';
import type { ActiveConversation, DashboardMessage } from './types';
import type { ChatMessage, DaemonData } from '../../types';
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader';
import { useDevRenderTrace } from '../../hooks/useDevRenderTrace';
import { IconChat, IconEye, IconFolder, IconPlug, IconSpinner } from '../Icons';
import {
    getMessageTimestamp,
} from './message-utils';
import {
    getConversationControlsContext,
    getConversationDaemonRouteId,
    getConversationDisplayLabel,
    getConversationProviderLabel,
    getCoordinatorRoutingHint,
} from './conversation-selectors';
import { getConversationSendBlockMessage, SEND_BLOCKED_PLACEHOLDER } from '../../hooks/dashboardCommandUtils'
import { getDefaultChatTailHydrateLimit, getDefaultVisibleLiveMessages, getRememberedVisibleLiveCount, rememberVisibleLiveCount } from './chat-visibility';
import { useSessionChatTailController } from './session-chat-tail-controller';
import { buildTranscriptReadSourceAttributes } from './transcript-chat-pane-adapter';
import { buildVisibleConversationMessages, getConversationLiveMessages, withPendingLocalMessages, type PendingLocalMessage } from './conversation-message-snapshot';
import { shouldShowOpenPanelAction } from './dashboardSessionCapabilities';
import { publishChatTyping } from './chat-typing-indicator-store';
import { buildGitSystemBubbleMessages } from './git-system-bubbles';
import {
    filterChatActivityMessages,
    readChatActivityVisiblePreference,
    setChatActivityVisiblePreference,
    subscribeChatActivityVisiblePreference,
} from './chat-activity-visibility';

export interface ChatPaneProps {
    activeConv: ActiveConversation;
    ideEntry?: DaemonData;
    handleSendChat: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>;
    /**
     * SEND-NOW: interrupt the agent's turn in flight so the queued optimistic
     * bubble is delivered as a real turn. Rendered inside that bubble by
     * ChatMessageRow, which is why every layout gets it from this one prop.
     */
    handleSendNowQueued?: (pendingId?: string) => Promise<boolean>;
    /** (QUEUED-SEND-CANCEL) Withdraw one still-waiting body by its pending id. */
    handleCancelQueued?: (pendingId: string) => Promise<boolean>;
    isSendingChat?: boolean;
    sendFeedbackMessage?: string | null;
    /** (OPTIMISTIC-USER-BUBBLE) Newest locally-rendered message awaiting its echo. */
    pendingLocalMessage?: PendingLocalMessage | null;
    /**
     * (MULTI-QUEUE) Every body still waiting, oldest first. Takes precedence over
     * `pendingLocalMessage` when provided — that single-entry prop remains only
     * for surfaces that have not been migrated.
     */
    pendingLocalMessages?: readonly PendingLocalMessage[] | null;
    /**
     * ★ (QUEUED-SEND-STUCK-FOREVER) Hand the daemon's transcript tail back to the
     * queue's owner so echoed bodies are retired from state, not merely hidden by
     * the render. Optional so the read-only share viewer — which renders a
     * transcript it does not own and has no queue to reconcile — can omit it.
     */
    retireEchoedPendingMessages?: (liveMessages: DashboardMessage[]) => void;
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

/**
 * (QUEUED-SEND-STUCK-FOREVER) How often the pane re-checks whether a waiting body
 * has outlived the window in which calling it "waiting" is still true.
 *
 * Only runs while the queue is non-empty, and only writes when a row actually
 * crosses the threshold. Coarse on purpose: it enforces a minutes-scale bound, so
 * checking every 30s bounds the lag to a small fraction of it while staying far
 * away from anything that could be mistaken for polling.
 */
const PENDING_QUEUE_STALE_SWEEP_INTERVAL_MS = 30_000;

/**
 * (CHAT-TAB-SWITCH-STALE-FALLBACK ①) Build the chat-tail controller options for
 * a pane, splitting SUBSCRIPTION lifetime from REFRESH gating.
 *
 * `isVisible` is dockview PANEL visibility — it flips on every session-tab
 * switch, not only when the browser tab is backgrounded. Gating `enabled` on it
 * tore the controller down, which emptied the live snapshot
 * (`hasLiveSnapshot: false`) and made `getConversationLiveMessages` fall back to
 * the stale status-meta `conversation.messages` list for a beat before the
 * re-pull caught up. The subscription therefore stays up while hidden (it is
 * refcounted and shared through the module-level controller registry, so a
 * hidden pane normally rides an instance the warm-controller pass already
 * retains) and only the authoritative re-pull is gated on visibility.
 *
 * Exported for the regression test: this is the whole of the decision.
 */
export function buildChatPaneTailControllerOptions(options: {
    sessionId?: string;
    isVisible: boolean;
    tailLimit: number;
}): { enabled: boolean; refreshEnabled: boolean; tailLimit: number } {
    return {
        enabled: !!options.sessionId,
        refreshEnabled: options.isVisible,
        tailLimit: options.tailLimit,
    };
}

export function buildBusyChatInputStatusMessage(
    conversation: Pick<ActiveConversation, 'status' | 'modalButtons'>,
    t: (key: string) => string,
): string | null {
    if (conversation.status === 'no_progress' || conversation.status === 'long_generating') {
        return t('chatPane.busyNoProgress')
    }
    if (conversation.status === 'generating' || conversation.status === 'streaming') {
        return t('chatPane.busyGenerating')
    }
    if (conversation.status === 'waiting_approval' && (!conversation.modalButtons || conversation.modalButtons.length === 0)) {
        return t('chatPane.busyWaitingApproval')
    }
    return null
}

export default function ChatPane({
    activeConv, ideEntry,
    handleSendChat,
    handleSendNowQueued,
    handleCancelQueued,
    isSendingChat = false,
    sendFeedbackMessage = null,
    pendingLocalMessage = null,
    pendingLocalMessages = null,
    retireEchoedPendingMessages,
    handleFocusAgent, isFocusingAgent, actionLogs, userName,
    scrollToBottomRequestNonce,
    isInputActive = true,
    isVisible = true,
}: ChatPaneProps) {
    const { t } = useTranslation('common');
    const receivedAtCache = useRef<Map<string, number>>(new Map());
    const debugGestureStateRef = useRef<ControlsToggleDebugGestureState | undefined>(undefined);
    const loadDaemonMetadata = useDaemonMetadataLoader();
    const { sendCommand } = useTransport();
    const { isVisible: areControlsVisible } = useControlsBarVisibility();
    useDevRenderTrace('ChatPane', {
        tabKey: activeConv.tabKey,
        messageCount: activeConv.messages.length,
        actionLogCount: actionLogs.length,
        isSendingChat,
    });

    const viewStates = React.useMemo(() => getConversationViewStates(activeConv), [activeConv.status, activeConv.connectionState]);

    // The chat-bubble "Agent generating..." indicator is the
    // authoritative signal for "this session is currently generating".
    // Publish it to the shared store so the tab spinner reads the same
    // value (the user reported the two surfaces could diverge for ~25s+
    // because each computed isGenerating from its own snapshot of
    // conversation.status).
    React.useEffect(() => {
        const sessionId = activeConv.sessionId;
        if (!sessionId) return;
        publishChatTyping(sessionId, viewStates.isGenerating);
        return () => {
            // Clear our claim when this ChatPane instance unmounts (tab
            // closed, tab switched away). The next ChatPane to mount for
            // the same session re-publishes from its own viewStates.
            publishChatTyping(sessionId, false);
        };
    }, [activeConv.sessionId, viewStates.isGenerating]);
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
    // (CHAT-TAB-SWITCH-STALE-FALLBACK) `isVisible` here is DOCKVIEW PANEL
    // visibility, not browser-tab visibility — it flips on every session-tab
    // switch. It must not gate `enabled`: dropping the controller empties the
    // live snapshot, and the pane then renders the stale status-meta
    // `conversation.messages` fallback for a beat before the re-pull catches up
    // (the reported "old messages, then it catches up, feels jumpy"). Keep the
    // subscription — it is refcounted and shared through the module-level
    // controller registry, so a hidden pane usually rides an instance
    // `useWarmSessionChatTailControllers` already retains — and gate only the
    // per-visibility authoritative re-pull.
    const chatTailState = useSessionChatTailController(activeConv, buildChatPaneTailControllerOptions({
        sessionId: activeConv.sessionId,
        isVisible,
        tailLimit: defaultChatTailHydrateLimit,
    }))

    const [visibleLiveCount, setVisibleLiveCount] = useState(
        () => getRememberedVisibleLiveCount(activeConv.tabKey, defaultVisibleLiveMessages),
    );
    const [showActivityMessages, setShowActivityMessages] = useState(() => readChatActivityVisiblePreference());

    const tabKey = activeConv.tabKey;
    const historyMessages = chatTailState.historyMessages;
    const hasMoreHistory = chatTailState.hasMoreHistory;
    const loadError = chatTailState.historyError;
    // (OPTIMISTIC-USER-BUBBLE) Layer the owner's just-sent message on top of the
    // live tail so it appears immediately instead of after the daemon round trip
    // (which, on a busy agent, waits for the send queue to drain). It is retired
    // the moment a matching user bubble arrives in the tail — see
    // `withPendingLocalMessage` for the dedup contract.
    //
    // ★ Applied HERE rather than inside the controller deliberately: the
    // controller's window is a single-authority, last-writer-wins projection of
    // the daemon's transcript, and injecting a client-authored row into it would
    // be wiped by the next update AND would corrupt the shrink-defense/dedup
    // signatures computed over it. This is a render-time overlay, so the
    // controller's contract is untouched.
    //
    // (QUEUE-PINNED-COMPOSER) PARKED bodies are excluded here and rendered by
    // `PendingQueueStrip` above the composer instead. Appending them to the tail
    // pinned them only until the agent said anything else, after which they
    // scrolled out of view along with the controls that withdraw them — and a
    // body the agent has not received does not belong in the transcript at all.
    //
    // Entries whose send is still in its round trip DO stay in the tail: the
    // instant optimistic bubble is the point, and such a send may yet resolve as
    // delivered rather than parked.
    //
    // ★ (QUEUED-SEND-STUCK-FOREVER) The DAEMON's tail, before any local bubble is
    // overlaid, is kept separate because it — and only it — is valid evidence that
    // a body was delivered. Matching echoes against the overlaid list would let a
    // pending entry match ITSELF and retire on the frame it was created.
    const daemonLiveMessages = getConversationLiveMessages(activeConv, chatTailState);
    const liveMessages = withPendingLocalMessages(
        daemonLiveMessages,
        // MULTI-QUEUE: prefer the full list; fall back to the single-entry prop
        // for callers that still pass only the newest bubble.
        pendingLocalMessages ?? (pendingLocalMessage ? [pendingLocalMessage] : null),
        undefined,
        { excludeQueued: true },
    );

    // ★ (QUEUED-SEND-STUCK-FOREVER) Hand the authoritative tail to the queue's
    // owner so an echoed body is retired from STATE — and therefore from
    // localStorage and from the pinned strip — instead of merely being skipped by
    // the render above. Before this, the transcript hid a delivered body while the
    // store kept it forever, which is what left "Waiting to send" rows pinned above
    // the composer for messages the agent had already answered.
    //
    // ★ Two triggers, because there are two ways a body stops deserving its row.
    // The TAIL moving is how a delivered body is detected. But the case that
    // produced the bug report is a session torn down while bodies were parked —
    // its transcript never moves again, so a tail-only trigger would never fire
    // and the row would stay pinned exactly as before. Hence the timer as well:
    // coarse (the threshold it enforces is minutes), only while the queue is
    // non-empty, and a no-op write unless something actually changed.
    const hasPendingEntries = (pendingLocalMessages?.length ?? 0) > 0;
    useEffect(() => {
        if (!retireEchoedPendingMessages) return;
        retireEchoedPendingMessages(daemonLiveMessages);
        if (!hasPendingEntries) return;
        const timer = setInterval(
            () => retireEchoedPendingMessages(daemonLiveMessages),
            PENDING_QUEUE_STALE_SWEEP_INTERVAL_MS,
        );
        return () => clearInterval(timer);
    }, [retireEchoedPendingMessages, daemonLiveMessages, hasPendingEntries]);
    // Only the COUNT is consumed (activity-toggle affordance), but the filter
    // classifies every live message. Memoized on `liveMessages` so it runs when
    // the tail actually changes rather than on every render of this pane.
    const activityToggleCount = useMemo(
        () => filterChatActivityMessages(liveMessages).length,
        [liveMessages],
    );

    // (CHAT-TAB-SWITCH-STALE-FALLBACK ②) Restore this tab's remembered expanded
    // window instead of collapsing to the default. Switching to a DIFFERENT tab
    // still re-reads for THAT tab's key, so a fresh session opens at its default
    // — the memory is per-tab, never carried across sessions.
    useEffect(() => {
        setVisibleLiveCount(getRememberedVisibleLiveCount(tabKey, defaultVisibleLiveMessages));
    }, [defaultVisibleLiveMessages, tabKey]);
    const hiddenLiveCount = Math.max(0, liveMessages.length - visibleLiveCount);
    const panelLabel = getConversationDisplayLabel(activeConv)
    const daemonId = getConversationDaemonRouteId(activeConv);
    const canOpenPanel = shouldShowOpenPanelAction(activeConv)
    const sendBlockMessage = getConversationSendBlockMessage(activeConv)
    const busyStatusMessage = buildBusyChatInputStatusMessage(activeConv, t)
    // The blocked state lives in the placeholder as a short one-liner — the
    // approval banner above already explains itself, and a long placeholder
    // must never wrap and grow the box. The dedicated line below the input is
    // reserved for send errors (kept visible while typing); the block reason
    // reappears there via getInlineSendFailureMessage only when a send bounces.
    const inlineStatusMessage = sendFeedbackMessage || null
    const chatInputStatusMessage = (sendBlockMessage ? SEND_BLOCKED_PLACEHOLDER : null)
        || sendFeedbackMessage
        || busyStatusMessage
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
            setVisibleLiveCount((current) => {
                const next = Math.min(liveMessages.length, current + LIVE_MESSAGE_PAGE_SIZE);
                rememberVisibleLiveCount(tabKey, next);
                return next;
            });
            return;
        }
        setIsLoadingMore(true);
        try {
            await chatTailState.loadHistoryPage()
        } finally {
            setIsLoadingMore(false);
        }
    }, [chatTailState, isLoadingMore, liveMessages.length, tabKey, visibleLiveCount]);

    const { allMessages, receivedAtMap } = useMemo(() => {
        const visibleMessages = buildVisibleConversationMessages({
            historyMessages,
            liveMessages,
            visibleLiveCount,
        });
        const gitSystemMessages = buildGitSystemBubbleMessages(activeConv);
        const allMessages = gitSystemMessages.length > 0
            ? [...visibleMessages, ...gitSystemMessages]
            : visibleMessages;
        const nextReceivedAtMap: Record<string, number> = {};
        allMessages.forEach((message, index: number) => {
            // Compute the stable key ONCE per message: it was previously derived
            // twice here (cache key + map key) for the same (message, index), and
            // the key builder hashes message content on its fallback path.
            const stableKey = getChatMessageStableKey(message, index);
            const messageKey = `${activeConv.tabKey}:${stableKey}`;
            let receivedAt = getMessageTimestamp(message) || receivedAtCache.current.get(messageKey) || 0;
            if (!receivedAt) {
                receivedAt = Date.now();
                receivedAtCache.current.set(messageKey, receivedAt);
            }
            nextReceivedAtMap[stableKey] = receivedAt;
        });
        return { allMessages, receivedAtMap: nextReceivedAtMap };
    }, [
        activeConv.tabKey,
        activeConv.sessionId,
        activeConv.status,
        activeConv.inboxBucket,
        activeConv.completionMarker,
        activeConv.lastMessageHash,
        activeConv.lastMessageAt,
        activeConv.lastUpdated,
        activeConv.workspacePath,
        activeConv.git,
        hiddenLiveCount,
        historyMessages,
        liveMessages,
        visibleLiveCount,
    ]);
    const visibleActionLogs = useMemo(
        () => actionLogs
            .filter(l => l.routeId === activeConv.tabKey)
            .sort((a, b) => a.timestamp - b.timestamp),
        [actionLogs, activeConv.tabKey],
    );

    /**
     * (TOOL-EXPAND) Per-bubble expansion state, keyed by the same stable message
     * key the list uses for React keys, so an expansion follows its bubble as
     * the transcript tail grows rather than sliding onto a neighbour.
     */
    const [toolExpansions, setToolExpansions] = useState<Record<string, ToolExpandState>>({});

    // Expansions are transcript-position-specific; when the conversation changes
    // the old keys describe bubbles that are no longer on screen.
    useEffect(() => {
        setToolExpansions({});
    }, [activeConv.tabKey]);

    const handleExpandToolBlock = useCallback(async (
        messageKey: string,
        ref: NonNullable<ChatMessage['toolBlockRef']>,
    ) => {
        if (!daemonId) return;
        setToolExpansions(prev => ({ ...prev, [messageKey]: { status: 'loading' } }));
        try {
            const raw = await sendCommand(daemonId, 'expand_tool_block', {
                targetSessionId: activeConv.sessionId,
                agentType: controlsContext.providerType || activeConv.agentType,
                toolBlockRef: ref,
            });
            const body = unwrapCommandResult(raw) as {
                success?: boolean;
                toolName?: string;
                callArgs?: string;
                result?: string;
            } | null;
            // A refusal (most importantly `source_changed`) is surfaced as an
            // error rather than an empty expansion: the daemon declined to guess
            // which block the ref now names, and the UI must not imply the
            // output was empty.
            const text = body?.success
                ? (body.callArgs !== undefined
                    ? `${body.toolName ? `${body.toolName}: ` : ''}${body.callArgs}`
                    : body.result)
                : undefined;
            setToolExpansions(prev => ({
                ...prev,
                [messageKey]: text !== undefined
                    ? { status: 'expanded', text }
                    : { status: 'error' },
            }));
        } catch {
            setToolExpansions(prev => ({ ...prev, [messageKey]: { status: 'error' } }));
        }
    }, [activeConv.agentType, activeConv.sessionId, controlsContext.providerType, daemonId, sendCommand]);

    const handleCollapseToolBlock = useCallback((messageKey: string) => {
        setToolExpansions(prev => {
            if (!prev[messageKey]) return prev;
            const next = { ...prev };
            delete next[messageKey];
            return next;
        });
    }, []);

    const collectChatDebugBundle = useCallback(async () => {
        if (!daemonId) return;
        const frontendSnapshot = buildChatFrontendDebugSnapshot({
            activeConv,
            visibleMessages: allMessages,
            actionLogs,
            controls: controlsContext.targetEntry?.providerControls,
            controlValues: controlsContext.targetEntry?.controlValues,
            visibleBarControlCount: visibleBarControls.length,
            chatTailState: {
                liveMessages: chatTailState.liveMessages,
                hasLiveSnapshot: chatTailState.hasLiveSnapshot,
                hasMoreHistory,
                historyError: loadError,
                historyMessages,
            },
            ui: {
                controlsVisible: areControlsVisible,
                visibleLiveCount,
                activityVisible: showActivityMessages,
                activityCount: activityToggleCount,
                hiddenLiveCount,
                isInputActive,
                isVisible,
            },
        });
        const raw = await sendCommand(daemonId, 'get_chat_debug_bundle', {
            agentType: controlsContext.providerType || activeConv.agentType,
            targetSessionId: activeConv.sessionId,
            delivery: 'daemon_file',
            frontendSnapshot,
        });
        const result = unwrapCommandResult(raw);
        const text = buildChatDebugBundleClipboardText(result);
        const locatorCopyStatus = await copyChatDebugBundleTextToClipboard(text);
        if (locatorCopyStatus === 'failed') {
            console.warn('[chat-debug-bundle] failed to copy or present debug bundle locator');
        }
        eventManager.showToast(
            buildChatDebugBundleToastMessage(result, { locatorCopyStatus }),
            locatorCopyStatus === 'failed' ? 'warning' : 'success',
        );
    }, [
        activeConv,
        actionLogs,
        activityToggleCount,
        allMessages,
        areControlsVisible,
        chatTailState.hasLiveSnapshot,
        chatTailState.liveMessages,
        controlsContext.providerType,
        controlsContext.targetEntry?.controlValues,
        controlsContext.targetEntry?.providerControls,
        daemonId,
        hasMoreHistory,
        hiddenLiveCount,
        historyMessages,
        isInputActive,
        isVisible,
        loadError,
        sendCommand,
        showActivityMessages,
        visibleBarControls.length,
        visibleLiveCount,
    ]);

    // React to preference flips from the Settings toggle (same document, custom
    // event) and from other tabs (storage event).
    useEffect(() => subscribeChatActivityVisiblePreference(setShowActivityMessages), []);

    const handleActivityToggle = useCallback(() => {
        setShowActivityMessages((current) => {
            const next = !current;
            setChatActivityVisiblePreference(next);
            return next;
        });
    }, []);

    const handleControlsToggleDebugGesture = useCallback(() => {
        const result = recordControlsToggleDebugGesture(debugGestureStateRef.current);
        debugGestureStateRef.current = result.state;
        if (!result.shouldCollect) return;
        void collectChatDebugBundle().catch((error) => {
            console.warn('[chat-debug-bundle] failed to collect debug bundle', error);
            eventManager.showToast('Chat debug signal failed. Check the browser console or P2P connection.', 'warning');
        });
    }, [collectChatDebugBundle]);
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
                        <div className="text-xxs text-blue-400 font-medium">{t('chatPane.connectingToMachine')}<span className="connecting-dots"></span></div>
                        <div className="text-2xs opacity-35">{t('chatPane.establishingP2P')}</div>
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
                    <div className="text-xxs opacity-50">{t('chatPane.agentNotMonitored')}</div>
                    <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                        {isFocusingAgent ? <span className="inline-flex items-center gap-1.5"><IconSpinner size={12} />{t('chatPane.switchingPanel')}</span> : <span className="flex items-center gap-1.5"><IconFolder size={14} /> {t('chatPane.openPanel', { label: panelLabel })}</span>}
                    </button>
                    <div className="text-2xs opacity-35 max-w-[280px]">{t('chatPane.clickToSwitchMonitoring')}</div>
                </div>
            );
        }
        if (activeConv.status === 'panel_hidden' && canOpenPanel) {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="text-3xl opacity-60"><IconEye size={28} /></div>
                    <div className="text-xxs opacity-50">{t('chatPane.agentPanelHidden')}</div>
                    <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                        {isFocusingAgent ? <span className="inline-flex items-center gap-1.5"><IconSpinner size={12} />{t('chatPane.openingPanel')}</span> : <span className="flex items-center gap-1.5"><IconFolder size={14} /> {t('chatPane.openPanel', { label: panelLabel })}</span>}
                    </button>
                    <div className="text-2xs opacity-35 max-w-[280px]">{t('chatPane.openPanelHint')}</div>
                </div>
            );
        }
        if (activeConv.status === 'idle' && !isLoadingMore) {
            // Chat tail connected and confirmed no more history — session is genuinely empty
            if (!hasMoreHistory && historyMessages.length === 0) {
                return (
                    <div className="text-center mt-16 flex flex-col items-center gap-3">
                        <div className="opacity-40"><IconChat size={26} /></div>
                        <div className="text-xxs opacity-40">{t('chatPane.noMessagesYet')}</div>
                    </div>
                );
            }
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="opacity-40 animate-pulse"><IconChat size={26} /></div>
                    <div className="text-xxs opacity-40">{t('chatPane.loadingChat')}</div>
                </div>
            );
        }
        return undefined;
    }, [activeConv.connectionState, activeConv.status, canOpenPanel, handleFocusAgent, hasMoreHistory, historyMessages.length, isFocusingAgent, isLoadingMore, liveMessages.length, panelLabel, viewStates.isGenerating]);

    return (
        /* (§8 unit 4c, design §5.6) Makes the replica/legacy decision
           observable without devtools — see `buildTranscriptReadSourceAttributes`
           for why it is a data attribute rather than visible UI or a log. */
        <div
            className="flex-1 min-h-0 w-full flex flex-col relative"
            {...buildTranscriptReadSourceAttributes(chatTailState)}
        >
            {/* Message Stream */}
{/* Compact chat header. The Activity toggle was dropped once as noise, which
                left the visibility preference with readers but no writer — activity rows
                became permanently hidden for everyone (O5). Restored by owner decision:
                it flips the same global preference the Settings → Appearance toggle
                writes, with the live activity-row count as the affordance. */}
            <div className="chat-activity-toggle-bar">
                <button
                    type="button"
                    className={`chat-activity-toggle ${showActivityMessages ? 'chat-activity-toggle-active' : ''}`}
                    onClick={handleActivityToggle}
                    aria-pressed={showActivityMessages}
                    title={t('chatPane.activityToggleTitle')}
                >
                    <span className="chat-activity-toggle-dot" />
                    {t('chatPane.activityToggleLabel')}
                    {activityToggleCount > 0 && (
                        <span className="chat-activity-toggle-count">{activityToggleCount}</span>
                    )}
                </button>
                <div className="ml-auto flex items-center gap-1">
                    <ConversationMuteButton
                        sessionId={activeConv.sessionId}
                        daemonId={activeConv.daemonId}
                        muted={!!controlsContext.targetEntry?.muted}
                        sendDaemonCommand={sendCommand}
                    />
                    <SessionInfoButton sessionId={activeConv.sessionId} daemonId={activeConv.daemonId} conv={activeConv} />
                </div>
            </div>
            {/* (§8 unit 5, design §3.7) A transcript-replica SNAP reset discards the
                ring's in-flight/older rows; the live tail restarts from whatever the
                next verified-complete revision carries. This is a UI cache-reset
                signal, not data loss (provider-native/ADHDev JSONL history is
                untouched) — "Load older" still reaches it via chat_history.

                That is exactly why it no longer renders a banner here: the
                "Load older messages" button below is gated independently of
                `omittedBefore`, so the banner named a control the user could
                already see and framed a recoverable cache reset as loss. The
                signal now rides the pane's `data-transcript-omitted-before`
                attribute instead — see `buildTranscriptReadSourceAttributes`. */}
            {/* (§8 unit 9) ★ The replica lane REGRESSED — the one transcript
                condition that is worth a visible notice.

                Read the contrast with the retired `omittedBefore` banner
                directly above, because it is the whole design constraint. That
                banner fired when nothing was wrong, was twice reported as a
                defect, and had to be removed. This one is gated on
                `transcriptReplicaDegraded`, which the controller sets ONLY when
                a session that HAD a working replica lost it — never on a
                session that was legacy all along, which is the normal state on
                a `shadow`-mode daemon and is not a fault. So if this is on
                screen, something genuinely broke.

                Without it, unit 9's auto-re-arm would be a silent-failure
                machine: the pane keeps working, the replica stays broken, and
                nobody finds out — which would defeat running the replica on
                preview to learn whether it works. It clears itself when the
                replica recovers. */}
            {chatTailState.transcriptReplicaDegraded && (
                <div
                    className="px-3 py-1.5 text-2xs text-amber-400/90 bg-amber-500/10 border-b border-amber-500/20"
                    role="status"
                    data-testid="transcript-replica-degraded-notice"
                >
                    {t('chatPane.replicaDegraded')}
                </div>
            )}
            <ChatMessageList
                messages={allMessages}
                actionLogs={visibleActionLogs}
                agentName={getConversationProviderLabel(activeConv) || panelLabel || 'Agent'}
                userName={userName}
                isCliMode={controlsContext.isCli || controlsContext.isAcp}
                isWorking={viewStates.isGenerating}
                contextKey={activeConv.tabKey}
                receivedAtMap={receivedAtMap}
                lastMessageHash={activeConv.lastMessageHash}
                showActivityMessages={showActivityMessages}
                onLoadMore={handleLoadMore}
                isLoadingMore={isLoadingMore}
                hasMoreHistory={hasMoreHistory}
                hiddenLiveCount={hiddenLiveCount}
                loadError={loadError ?? undefined}
                emptyState={emptyState}
                scrollToBottomRequestNonce={scrollToBottomRequestNonce}
                isVisible={isVisible}
                onSendNow={handleSendNowQueued}
                isSendingNow={isSendingChat}
                onCancelQueued={handleCancelQueued}
                toolExpansions={toolExpansions}
                onExpandToolBlock={handleExpandToolBlock}
                onCollapseToolBlock={handleCollapseToolBlock}
            />

            {/* (QUEUE-PINNED-COMPOSER) Outside the scroll container by design: a
                body still parked in the daemon FIFO has not entered the
                conversation, so it sits with the composer it was typed into and
                stays put however far the transcript scrolls. */}
            <PendingQueueStrip
                entries={pendingLocalMessages ?? (pendingLocalMessage ? [pendingLocalMessage] : [])}
                onSendNow={handleSendNowQueued}
                onCancelQueued={handleCancelQueued}
                isSendingNow={isSendingChat}
            />

            <ChatControlsSection
                routeId={activeConv.routeId}
                sessionId={activeConv.sessionId}
                hostIdeType={activeConv.hostIdeType}
                providerType={controlsContext.providerType}
                displayLabel={controlsContext.displayLabel}
                controls={controlsContext.targetEntry?.providerControls}
                controlValues={controlsContext.targetEntry?.controlValues}
                currentStatus={activeConv.status}
                coordinatorHint={getCoordinatorRoutingHint(activeConv)}
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
                    inlineStatusMessage={inlineStatusMessage}
                    onSend={handleSendChat}
                    isActive={isInputActive}
                    showControlsToggle={visibleBarControls.length > 0}
                    onControlsToggle={handleControlsToggleDebugGesture}
                    messageInput={activeConv.messageInput}
                />
            )}
        </div>
    );
}
