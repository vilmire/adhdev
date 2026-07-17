/**
 * ChatMessageList — shared Chat message rendering component
 *
 * Dashboard / IDE / AgentStreamPanelfrom commonto use.
 * Supports 5 message types: thought, tool, system, action, standard.
 *
 * Rendering only:
 * - Provider/daemon own transcript parsing and message boundaries.
 * - The web client must not reinterpret CLI transcript semantics.
 * - Presentation hints such as preformatted rendering must come from message kind/meta.
 *
 * Structure (survey C9 3/3 decomposition — pure move, behaviour preserved):
 * - ./ChatMessageList/chatMessageHelpers.ts — pure helpers, types, constants.
 * - ./ChatMessageList/chatScrollHelpers.ts  — pure scroll-decision functions.
 * - ./ChatMessageList/chatMessageBubbles.tsx — bubble/row renderers + row memo.
 * This file keeps the shell: the scroll-owning component body (refs, state, and
 * the stateful effects that a source-string test pins here) and the list JSX.
 */

import { memo, useState, useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import {
    getRenderableTimestamp,
    getChatMessageStableKey,
    type ActionLog,
} from './ChatMessageList/chatMessageHelpers';
import {
    CHAT_SCROLL_NEAR_BOTTOM_PX,
    CHAT_BOTTOM_AUTO_SCROLL_WINDOW_MS,
    chatScrollSnapshotCache,
    getChatScrollJumpButtonStateForElement,
    restoreChatScrollSnapshot,
    buildChatScrollFingerprint,
    shouldRestoreChatScrollSnapshot,
    isChatScrollSnapshotScrolledUp,
    shouldOpenBottomAutoScrollWindowOnInitialChatMount,
    shouldAutoScrollAfterChatContentChange,
    shouldAutoScrollOnChatResize,
    shouldAutoScrollOnChatVisibilityChange,
    shouldRestoreChatScrollOnVisibilityChange,
    type ChatScrollSnapshot,
    type ChatScrollJumpButtonState,
} from './ChatMessageList/chatScrollHelpers';
import {
    ActionLogRow,
    ChatMessageRow,
} from './ChatMessageList/chatMessageBubbles';
import { classifyChatMessageForDisplay, filterChatMessagesForDefaultTranscript, filterChatActivityMessages, mergeChatAndActivityMessages, collapseAdjacentDuplicateChatMessages } from './dashboard/chat-activity-visibility';

// ─── Types ────────────────────────────────────

import type { ChatMessage } from '../types';

// Re-export the pure helpers so existing import paths (tests, ChatPane) keep
// resolving from this module after the C9 3/3 decomposition.
export type { ActionLog } from './ChatMessageList/chatMessageHelpers';
export { getChatMessageStableKey } from './ChatMessageList/chatMessageHelpers';
export {
    buildChatScrollFingerprint,
    getChatScrollJumpButtonState,
    isChatScrollSnapshotScrolledUp,
    shouldAutoScrollAfterChatContentChange,
    shouldAutoScrollOnChatResize,
    shouldAutoScrollOnChatVisibilityChange,
    shouldOpenBottomAutoScrollWindowOnInitialChatMount,
    shouldRestoreChatScrollOnVisibilityChange,
    shouldRestoreChatScrollSnapshot,
} from './ChatMessageList/chatScrollHelpers';
export { buildChatMessageRowSignature } from './ChatMessageList/chatMessageBubbles';

export interface ChatMessageListProps {
    messages: ChatMessage[];
    actionLogs?: ActionLog[];
    agentName?: string;
    /** Display name for user messages (instead of 'You') */
    userName?: string;
    isCliMode?: boolean;
    isWorking?: boolean;
    /** Manage expand status with this key prefix */
    contextKey?: string;
    /** Forward received timestamp map from external (messageId → timestamp) */
    receivedAtMap?: Record<string, number>;
    /** Daemon-provided hash for the current last message; avoids re-hashing large idle transcripts. */
    lastMessageHash?: string;
    /** Opt-in: show tool/terminal/runtime activity rows in a distinct activity surface. */
    showActivityMessages?: boolean;
    /** custom empty state */
    emptyState?: React.ReactNode;
    /** Load previous messages when user clicks load button */
    onLoadMore?: () => void;
    isLoadingMore?: boolean;
    hasMoreHistory?: boolean;
    hiddenLiveCount?: number;
    /** Error message to show on load button (e.g. retry hint) */
    loadError?: string;
    scrollToBottomRequestNonce?: number;
    /** Whether this chat pane is currently visible to the user. Hidden-but-mounted panes re-scroll on reveal. */
    isVisible?: boolean;
}

export interface ChatMessageListRef {
    scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export function shouldRenderChatMessageInVisibleTranscript(message: ChatMessage): boolean {
    return classifyChatMessageForDisplay(message).isUserFacing;
}

// ─── Component ────────────────────────────────

const ChatMessageList = forwardRef<ChatMessageListRef, ChatMessageListProps>(function ChatMessageList(
    { messages, actionLogs, agentName = 'Agent', userName, isCliMode = false, isWorking = false, contextKey = '', receivedAtMap = {}, lastMessageHash, showActivityMessages = false, emptyState, onLoadMore, isLoadingMore, hasMoreHistory, hiddenLiveCount = 0, loadError, scrollToBottomRequestNonce, isVisible = true },
    ref
) {
    const { t } = useTranslation('common');
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const prevCountRef = useRef<number>(0);
    const prevFingerprintRef = useRef<string>('');
    const prevContextRef = useRef<string>('');  // Empty value → always different on first render
    const mountedRef = useRef(false);
    const scrollFrameRef = useRef<number | null>(null);
    const contextAutoScrollRef = useRef(false);
    const contextAutoScrollTimerRef = useRef<number | null>(null);
    const hasSelectionRef = useRef(false);
    const [expandedTexts, setExpandedTexts] = useState<Set<string>>(new Set());
    const [jumpButtons, setJumpButtons] = useState<ChatScrollJumpButtonState>({ showTop: false, showBottom: false });

    const userScrolledUp = useRef(false);
    const restoredInitialScrollRef = useRef(false);
    const previousIsVisibleRef = useRef(isVisible);
    const isVisibleRef = useRef(isVisible);
    const latestScrollSnapshotRef = useRef<{ contextKey: string; snapshot: ChatScrollSnapshot } | null>(null);
    isVisibleRef.current = isVisible;

    /** Check if user is near bottom of scroll */
    const isNearBottom = () => {
        const el = containerRef.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < CHAT_SCROLL_NEAR_BOTTOM_PX;
    };

    const updateJumpButtonState = useCallback(() => {
        const el = containerRef.current;
        const next = el
            ? getChatScrollJumpButtonStateForElement(el)
            : { showTop: false, showBottom: false };
        setJumpButtons(prev => (
            prev.showTop === next.showTop && prev.showBottom === next.showBottom
                ? prev
                : next
        ));
    }, []);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        const el = containerRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior });
        el.ownerDocument.defaultView?.requestAnimationFrame(() => updateJumpButtonState());
    }, [updateJumpButtonState]);

    const scrollToTop = useCallback((behavior: ScrollBehavior = 'auto') => {
        const el = containerRef.current;
        if (!el) return;
        el.scrollTo({ top: 0, behavior });
        el.ownerDocument.defaultView?.requestAnimationFrame(() => updateJumpButtonState());
    }, [updateJumpButtonState]);

    const updateSelectionState = useCallback(() => {
        const container = containerRef.current;
        const selection = window.getSelection?.();
        if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
            hasSelectionRef.current = false;
            return;
        }
        const anchorNode = selection.anchorNode;
        const focusNode = selection.focusNode;
        hasSelectionRef.current = !!(
            anchorNode
            && focusNode
            && container.contains(anchorNode)
            && container.contains(focusNode)
        );
    }, []);

    // Visible chat transcript hides internal provider/coordinator activity rows.
    // The daemon/read_chat transcript still preserves these messages for debug/export paths.
    const visibleMessages = useMemo(() => {
        const chatMessages = filterChatMessagesForDefaultTranscript(messages);
        const activityMessages = filterChatActivityMessages(messages);
        // Collapse back-to-back identical bubbles (history↔live seam duplicate, or a
        // native transcript replaying a finalized turn) before rendering — this is
        // adjacent-only, so the intentional non-adjacent history/live overlap is
        // preserved. (ANTIGRAVITY-REPLICA-DUP)
        return collapseAdjacentDuplicateChatMessages(
            mergeChatAndActivityMessages(chatMessages, activityMessages, showActivityMessages),
        );
    }, [messages, showActivityMessages]);

    const visibleLastMessageHash = visibleMessages.length === messages.length ? lastMessageHash : undefined;

    // Last message signature — prefer daemon-owned hash so idle status renders don't re-hash large content.
    const lastMsgFingerprint = buildChatScrollFingerprint(visibleMessages, visibleLastMessageHash);

    const saveScrollSnapshot = useCallback(() => {
        const el = containerRef.current;
        if (!el || !contextKey || !isVisibleRef.current) return;
        const snapshot = {
            top: el.scrollTop,
            fromBottom: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
            messageFingerprint: lastMsgFingerprint,
        };
        latestScrollSnapshotRef.current = { contextKey, snapshot };
        chatScrollSnapshotCache.set(contextKey, snapshot);
    }, [contextKey, lastMsgFingerprint]);

    const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        if (scrollFrameRef.current != null) {
            cancelAnimationFrame(scrollFrameRef.current);
        }
        scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = null;
            scrollToBottom(behavior);
        });
    }, [scrollToBottom]);

    const openBottomAutoScrollWindow = useCallback(() => {
        userScrolledUp.current = false;
        contextAutoScrollRef.current = true;
        restoredInitialScrollRef.current = true;
        if (contextAutoScrollTimerRef.current != null) {
            window.clearTimeout(contextAutoScrollTimerRef.current);
        }
        contextAutoScrollTimerRef.current = window.setTimeout(() => {
            contextAutoScrollRef.current = false;
            contextAutoScrollTimerRef.current = null;
        }, CHAT_BOTTOM_AUTO_SCROLL_WINDOW_MS);
    }, []);

    // Auto-scroll: On new message / streaming update / tab switch
    useEffect(() => {
        const isFirstMount = !mountedRef.current;
        const isTabSwitch = prevContextRef.current !== contextKey;
        prevContextRef.current = contextKey;

        if (isFirstMount || isTabSwitch) {
            mountedRef.current = true;
            const snapshot = contextKey ? chatScrollSnapshotCache.get(contextKey) : null;
            const canRestoreSnapshot = !!snapshot && shouldRestoreChatScrollSnapshot(snapshot, lastMsgFingerprint);
            userScrolledUp.current = canRestoreSnapshot ? isChatScrollSnapshotScrolledUp(snapshot) : false;
            contextAutoScrollRef.current = shouldOpenBottomAutoScrollWindowOnInitialChatMount(snapshot, lastMsgFingerprint);
            if (!hasSelectionRef.current) {
                if (canRestoreSnapshot) {
                    requestAnimationFrame(() => {
                        const el = containerRef.current;
                        if (!el) return;
                        restoreChatScrollSnapshot(el, snapshot);
                        userScrolledUp.current = isChatScrollSnapshotScrolledUp(snapshot);
                        updateJumpButtonState();
                        restoredInitialScrollRef.current = true;
                    });
                } else {
                    scheduleScrollToBottom('auto');
                }
            }
            prevCountRef.current = visibleMessages.length;
            prevFingerprintRef.current = lastMsgFingerprint;
            return;
        }

        // When chat content changes, keep following the bottom unless the user explicitly scrolled up.
        // This covers both appended messages and same-message streaming growth, where checking
        // near-bottom after DOM growth can already be too late.
        const isNewMessage = visibleMessages.length > prevCountRef.current;
        const hasChatContentChanged = lastMsgFingerprint !== prevFingerprintRef.current;
        if (shouldAutoScrollAfterChatContentChange({
            hasSelection: hasSelectionRef.current,
            userScrolledUp: userScrolledUp.current,
            hasChatContentChanged,
            isNewMessage,
        })) {
            scheduleScrollToBottom('auto');
        }
        prevCountRef.current = visibleMessages.length;
        prevFingerprintRef.current = lastMsgFingerprint;
    }, [lastMsgFingerprint, contextKey, visibleMessages.length, scheduleScrollToBottom, updateJumpButtonState]);

    useEffect(() => {
        if (!scrollToBottomRequestNonce) return;
        openBottomAutoScrollWindow();
        if (!hasSelectionRef.current) {
            scheduleScrollToBottom('auto');
        }
    }, [openBottomAutoScrollWindow, scheduleScrollToBottom, scrollToBottomRequestNonce]);

    useEffect(() => {
        const wasVisible = previousIsVisibleRef.current;
        if (wasVisible && !isVisible) {
            // Dockview tab/context-menu actions can hide a mounted pane without
            // unmounting it. Persist the last visible position before marking it
            // hidden so a later reveal does not fall back to scrollTop=0.
            saveScrollSnapshot();
        }
        isVisibleRef.current = isVisible;
        previousIsVisibleRef.current = isVisible;
        const snapshot = contextKey ? chatScrollSnapshotCache.get(contextKey) : null;
        if (shouldRestoreChatScrollOnVisibilityChange(wasVisible, isVisible, snapshot, lastMsgFingerprint)) {
            if (!snapshot) return;
            userScrolledUp.current = isChatScrollSnapshotScrolledUp(snapshot);
            contextAutoScrollRef.current = false;
            if (!hasSelectionRef.current) {
                requestAnimationFrame(() => {
                    const el = containerRef.current;
                    if (!el) return;
                    restoreChatScrollSnapshot(el, snapshot);
                    updateJumpButtonState();
                });
            }
            return;
        }
        if (!shouldAutoScrollOnChatVisibilityChange(wasVisible, isVisible)) return;
        openBottomAutoScrollWindow();
        if (!hasSelectionRef.current) {
            scheduleScrollToBottom('auto');
        }
    }, [isVisible, contextKey, lastMsgFingerprint, openBottomAutoScrollWindow, saveScrollSnapshot, scheduleScrollToBottom, updateJumpButtonState]);

    useEffect(() => () => {
        const latestSnapshot = latestScrollSnapshotRef.current;
        if (latestSnapshot) {
            chatScrollSnapshotCache.set(latestSnapshot.contextKey, latestSnapshot.snapshot);
        }
        if (scrollFrameRef.current != null) {
            cancelAnimationFrame(scrollFrameRef.current);
        }
        if (contextAutoScrollTimerRef.current != null) {
            window.clearTimeout(contextAutoScrollTimerRef.current);
        }
    }, []);

    useEffect(() => {
        const contentEl = contentRef.current;
        const containerEl = containerRef.current;
        if (!contentEl || !containerEl) return;

        const finishContextAutoScroll = () => {
            if (contextAutoScrollTimerRef.current != null) {
                window.clearTimeout(contextAutoScrollTimerRef.current);
            }
            contextAutoScrollTimerRef.current = window.setTimeout(() => {
                contextAutoScrollRef.current = false;
                contextAutoScrollTimerRef.current = null;
            }, CHAT_BOTTOM_AUTO_SCROLL_WINDOW_MS);
        };

        const observer = new ResizeObserver(() => {
            updateJumpButtonState();
            const contextAutoScrollActive = contextAutoScrollRef.current;
            if (!shouldAutoScrollOnChatResize({
                hasSelection: hasSelectionRef.current,
                userScrolledUp: userScrolledUp.current,
                contextAutoScrollActive,
            })) return;
            scheduleScrollToBottom('auto');
            if (contextAutoScrollActive) finishContextAutoScroll();
        });

        observer.observe(contentEl);
        if (containerEl !== contentEl) observer.observe(containerEl);
        return () => {
            observer.disconnect();
            if (contextAutoScrollTimerRef.current != null) {
                window.clearTimeout(contextAutoScrollTimerRef.current);
                contextAutoScrollTimerRef.current = null;
            }
        };
    }, [scheduleScrollToBottom, contextKey, updateJumpButtonState]);

    useImperativeHandle(ref, () => ({
        scrollToBottom: (behavior: ScrollBehavior = 'smooth') => {
            scrollToBottom(behavior);
        },
    }), [scrollToBottom]);

    // Track user scroll intent
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        let scrollTimer: NodeJS.Timeout;
        const onScroll = () => {
            saveScrollSnapshot();
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
                // If 200px+ from bottom, user has scrolled up
                userScrolledUp.current = !isNearBottom();
                updateJumpButtonState();
            }, 50);
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => { el.removeEventListener('scroll', onScroll); clearTimeout(scrollTimer); };
    }, [saveScrollSnapshot, updateJumpButtonState]);

    useEffect(() => {
        document.addEventListener('selectionchange', updateSelectionState);
        return () => document.removeEventListener('selectionchange', updateSelectionState);
    }, [updateSelectionState]);

    // After messages prepended, restore scroll position so content doesn't jump
    const prevScrollHeight = useRef(0);
    const isHistoryLoading = useRef(false);

    useEffect(() => {
        const el = containerRef.current;
        if (!el || !isHistoryLoading.current || prevScrollHeight.current === 0) return;
        const addedHeight = el.scrollHeight - prevScrollHeight.current;
        if (addedHeight > 0) el.scrollTop = addedHeight;
        updateJumpButtonState();
        saveScrollSnapshot();
        prevScrollHeight.current = 0;
        isHistoryLoading.current = false;
    }, [visibleMessages.length, saveScrollSnapshot, updateJumpButtonState]);

    useEffect(() => {
        if (restoredInitialScrollRef.current) return;
        if (!contextKey) return;
        const snapshot = chatScrollSnapshotCache.get(contextKey);
        const el = containerRef.current;
        if (!snapshot || !el) return;
        if (!shouldRestoreChatScrollSnapshot(snapshot, lastMsgFingerprint)) {
            scrollToBottom('auto');
            restoredInitialScrollRef.current = true;
            return;
        }
        restoreChatScrollSnapshot(el, snapshot);
        userScrolledUp.current = isChatScrollSnapshotScrolledUp(snapshot);
        updateJumpButtonState();
        restoredInitialScrollRef.current = true;
    }, [contextKey, lastMsgFingerprint, visibleMessages.length, scrollToBottom, updateJumpButtonState]);

    // Track when load starts so we can restore scroll after
    const handleLoadMoreClick = () => {
        const el = containerRef.current;
        if (el) prevScrollHeight.current = el.scrollHeight;
        isHistoryLoading.current = true;
        onLoadMore?.();
    };

    const handleJumpToTop = () => {
        userScrolledUp.current = true;
        scrollToTop('smooth');
        saveScrollSnapshot();
    };

    const handleJumpToBottom = () => {
        openBottomAutoScrollWindow();
        scrollToBottom('smooth');
        saveScrollSnapshot();
    };

    // Merge messages + action logs by timestamp
    type MsgItem = { type: 'message'; data: ChatMessage; index: number; ts: number };
    type LogItem = { type: 'action'; data: ActionLog; index: number; ts: number };
    type MergedItem = MsgItem | LogItem;

    const items: MergedItem[] = useMemo(() => {
        const msgItems: MsgItem[] = visibleMessages.map((m, i) => ({
            type: 'message' as const,
            data: m,
            index: i,
            ts: getRenderableTimestamp(m, i, receivedAtMap),
        }));

        if (!actionLogs || actionLogs.length === 0) return msgItems;

        const logItems: LogItem[] = [...actionLogs]
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((l, i) => ({ type: 'action' as const, data: l, index: i, ts: l.timestamp }));

        const merged: MergedItem[] = [];
        let logIdx = 0;
        for (const msg of msgItems) {
            while (logIdx < logItems.length && msg.ts > 0 && logItems[logIdx].ts < msg.ts) {
                merged.push(logItems[logIdx++]);
            }
            merged.push(msg);
        }
        while (logIdx < logItems.length) merged.push(logItems[logIdx++]);
        return merged;
    }, [visibleMessages, actionLogs, receivedAtMap]);
    const hasMoreVisibleContent = hiddenLiveCount > 0 || !!hasMoreHistory;
    const loadMoreLabel = hiddenLiveCount > 0
        ? (hiddenLiveCount > 80
            ? t('chatList.showEarlierMessagesHidden', { count: Math.min(hiddenLiveCount, 80), total: hiddenLiveCount })
            : t('chatList.showEarlierMessages', { count: Math.min(hiddenLiveCount, 80) }))
        : (loadError ? t('chatList.loadErrorRetry', { error: loadError }) : t('chatList.loadOlderMessages'));

    return (
        <div className="chat-scroll-frame">
            <div
                ref={containerRef}
                data-chat-scroll
                className="chat-container"
            >
                <div ref={contentRef} className="chat-container-content">
            {/* Load more button — shown at top when there's history available */}
            {isLoadingMore && (
                <div className="text-center py-3 text-text-muted text-xs opacity-60 animate-pulse">
                    {t('chatList.loadingOlderMessages')}
                </div>
            )}
            {hasMoreVisibleContent && !isLoadingMore && (
                <div className="text-center py-2">
                    <button
                        type="button"
                        onClick={handleLoadMoreClick}
                        className={`text-[11px] rounded-xl px-4 py-1.5 cursor-pointer border transition-all ${
                            loadError && hiddenLiveCount === 0
                                ? 'bg-transparent border-yellow-500/30 text-yellow-400 opacity-80 hover:opacity-100'
                                : 'bg-transparent border-border-subtle text-text-muted opacity-70 hover:opacity-100 hover:border-accent/40'
                        }`}
                    >
                        {loadMoreLabel}
                    </button>
                </div>
            )}

            {items.length === 0 && !hasMoreVisibleContent && (
                emptyState || (
                    <div className="text-center mt-16 opacity-20 text-[13px]">
                        {t('chatList.waitingForMessages')}
                    </div>
                )
            )}

            {/*
              * TODO(perf, deferred): virtualize this list (windowed rendering) so
              * only on-screen rows mount. Fix #1 (field-aware row memo + content-keyed
              * markdown) already removes the per-tick CPU storm; virtualization would
              * additionally remove DOM-size scaling for very long transcripts.
              *
              * Integration points that MUST be honored to avoid breaking behavior:
              *  - The scroll container (`containerRef` / `.chat-container`) and content
              *    wrapper (`contentRef`) drive ALL of: auto-follow-to-bottom
              *    (scrollToBottom / scheduleScrollToBottom), scroll-restore snapshots
              *    (saveScrollSnapshot / restoreChatScrollSnapshot, which read
              *    `el.scrollHeight - el.scrollTop - el.clientHeight`), the "Load older"
              *    prepend offset restore (prevScrollHeight vs el.scrollHeight, ~line
              *    912-921), the ResizeObserver auto-scroll, and the jump-button state
              *    (getChatScrollJumpButtonStateForElement). A virtualizer must expose a
              *    measured TOTAL size and feed it everywhere those reads assume the full
              *    content height — partial integration WILL corrupt scroll position.
              *  - Prefer @tanstack/react-virtual (compatible with React 18). Add it to
              *    oss/packages/web-core/package.json when implementing.
              */}
            {items.map((item) => {
                if (item.type === 'action') {
                    const log = item.data as ActionLog;
                    return (
                        <ActionLogRow
                            key={`action-${item.index}`}
                            log={log}
                        />
                    );
                }

                const m = item.data as ChatMessage;
                const i = item.index;
                const messageKey = getChatMessageStableKey(m, i);
                const receivedAt = m.receivedAt || receivedAtMap[messageKey];
                const expandKey = `${contextKey}-${messageKey}`;
                const isTextExpanded = expandedTexts.has(expandKey);
                return (
                    <ChatMessageRow
                        key={`msg-${messageKey}`}
                        message={m}
                        receivedAt={receivedAt}
                        agentName={agentName}
                        userName={userName}
                        isCliMode={isCliMode}
                        isTextExpanded={isTextExpanded}
                        onToggleTextExpanded={() => setExpandedTexts(prev => {
                            const next = new Set(prev);
                            isTextExpanded ? next.delete(expandKey) : next.add(expandKey);
                            return next;
                        })}
                    />
                );
            })}

            {/* Typing indicator */}
            {isWorking && (
                <div className="self-start chat-typing-wrapper">
                    <div className="typing-indicator">
                        <div className="dot" />
                        <div className="dot" />
                        <div className="dot" />
                        <span className="text-[11px] text-text-muted ml-1">{t('chatList.agentGenerating')}</span>
                    </div>
                </div>
            )}

            <div className="min-h-10" ref={endRef} />
                </div>
            </div>
            {(jumpButtons.showTop || jumpButtons.showBottom) && (
                <div className="chat-scroll-jump-controls" aria-label={t('chatList.jumpToTop')}>
                    {jumpButtons.showTop && (
                        <button
                            type="button"
                            className="chat-scroll-jump-button"
                            onClick={handleJumpToTop}
                            aria-label={t('chatList.jumpToOldestMessages')}
                            title={t('chatList.jumpToTop')}
                        >
                            {t('chatList.top')}
                        </button>
                    )}
                    {jumpButtons.showBottom && (
                        <button
                            type="button"
                            className="chat-scroll-jump-button chat-scroll-jump-button-primary"
                            onClick={handleJumpToBottom}
                            aria-label={t('chatList.jumpToLatestMessages')}
                            title={t('chatList.jumpToBottom')}
                        >
                            {t('chatList.latest')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
});

const MemoizedChatMessageList = memo(ChatMessageList, (prev, next) => (
    prev.messages === next.messages
    && prev.actionLogs === next.actionLogs
    && prev.agentName === next.agentName
    && prev.userName === next.userName
    && prev.isCliMode === next.isCliMode
    && prev.isWorking === next.isWorking
    && prev.contextKey === next.contextKey
    && prev.receivedAtMap === next.receivedAtMap
    && prev.lastMessageHash === next.lastMessageHash
    && prev.showActivityMessages === next.showActivityMessages
    && prev.emptyState === next.emptyState
    && prev.onLoadMore === next.onLoadMore
    && prev.isLoadingMore === next.isLoadingMore
    && prev.hasMoreHistory === next.hasMoreHistory
    && prev.hiddenLiveCount === next.hiddenLiveCount
    && prev.loadError === next.loadError
    && prev.scrollToBottomRequestNonce === next.scrollToBottomRequestNonce
    && prev.isVisible === next.isVisible
));

export default MemoizedChatMessageList;
