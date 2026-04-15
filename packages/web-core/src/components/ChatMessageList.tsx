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
 */

import { memo, useState, useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkAlert from 'remark-github-blockquote-alert';
import remarkBreaks from 'remark-breaks';
import { IconThought } from './Icons';
import { stringifyTextContent } from '../utils/text';

// ─── Types ────────────────────────────────────

import type { ChatMessage } from '../types';

export interface ActionLog {
    text: string;
    timestamp: number;
}

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
}

export interface ChatMessageListRef {
    scrollToBottom: (behavior?: ScrollBehavior) => void;
}

type ChatScrollSnapshot = {
    top: number;
    fromBottom: number;
}

const chatScrollSnapshotCache = new Map<string, ChatScrollSnapshot>();

// ─── Helpers ──────────────────────────────────

type MessageMeta = NonNullable<ChatMessage['meta']> & { renderMode?: unknown };

function formatTime(ms?: number): string {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function getRenderableTimestamp(message: ChatMessage, index: number, receivedAtMap: Record<string, number>): number {
    return Number(
        message.receivedAt
        || receivedAtMap[getChatMessageStableKey(message, index)]
        || 0,
    ) || 0;
}

function likelyNeedsMarkdownRender(content: string): boolean {
    return /[`*_#[\]()>-]|https?:\/\/|\n\s*[-*]\s|\n\s*\d+\.\s|\|/.test(content);
}

type StructuredMessagePart = {
    type: string;
    text?: string;
    uri?: string;
    data?: string;
    mimeType?: string;
    name?: string;
    posterUri?: string;
    resource?: {
        uri?: string;
        text?: string;
        blob?: string;
        mimeType?: string | null;
    };
};

function isStructuredMessagePartArray(content: unknown): content is StructuredMessagePart[] {
    return Array.isArray(content) && content.some((part) => !!part && typeof part === 'object' && 'type' in part);
}

function getResourceDisplayName(uri: string | undefined, fallback: string): string {
    if (!uri) return fallback;
    try {
        const withoutScheme = uri.startsWith('file://') ? new URL(uri).pathname : uri;
        const normalized = withoutScheme.split(/[\\/]/).filter(Boolean).pop();
        return normalized || fallback;
    } catch {
        const normalized = uri.split(/[\\/]/).filter(Boolean).pop();
        return normalized || fallback;
    }
}

function buildMediaSrc(part: StructuredMessagePart): string | undefined {
    if (typeof part.uri === 'string' && part.uri) return part.uri;
    if (typeof part.data === 'string' && part.data && typeof part.mimeType === 'string' && part.mimeType) {
        return `data:${part.mimeType};base64,${part.data}`;
    }
    return undefined;
}

function renderTextLikeContent(content: string, renderAsPreformatted: boolean): React.ReactNode {
    if (!content) return null;
    if (renderAsPreformatted) {
        return <pre className="chat-preformatted">{content}</pre>;
    }
    if (likelyNeedsMarkdownRender(content)) {
        return (
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkAlert, remarkBreaks]}>
                {content}
            </ReactMarkdown>
        );
    }
    return <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>;
}

function MessagePartsRenderer({ parts, renderAsPreformatted }: { parts: StructuredMessagePart[]; renderAsPreformatted: boolean }): React.ReactNode {
    return (
        <div className="flex flex-col gap-2">
            {parts.map((part, index) => {
                if (part.type === 'text') {
                    return <div key={`text-${index}`}>{renderTextLikeContent(String(part.text || ''), renderAsPreformatted)}</div>;
                }

                if (part.type === 'image') {
                    const src = buildMediaSrc(part);
                    if (!src) return null;
                    return (
                        <img
                            key={`image-${index}`}
                            src={src}
                            alt={getResourceDisplayName(part.uri, 'image')}
                            className="max-w-full rounded-md border border-border-subtle"
                        />
                    );
                }

                if (part.type === 'audio') {
                    const src = buildMediaSrc(part);
                    return src ? <audio key={`audio-${index}`} controls src={src} className="max-w-full" /> : null;
                }

                if (part.type === 'video') {
                    const src = buildMediaSrc(part);
                    if (src) {
                        return (
                            <video
                                key={`video-${index}`}
                                controls
                                src={src}
                                poster={part.posterUri}
                                className="max-w-full rounded-md border border-border-subtle"
                            />
                        );
                    }
                    if (part.uri) {
                        return (
                            <a key={`video-link-${index}`} href={part.uri} target="_blank" rel="noreferrer" className="underline break-all">
                                {getResourceDisplayName(part.uri, 'video')}
                            </a>
                        );
                    }
                    return null;
                }

                if (part.type === 'resource_link') {
                    if (!part.uri) return null;
                    return (
                        <a key={`resource-link-${index}`} href={part.uri} target="_blank" rel="noreferrer" className="underline break-all">
                            {part.name || getResourceDisplayName(part.uri, 'resource')}
                        </a>
                    );
                }

                if (part.type === 'resource' && part.resource) {
                    const label = getResourceDisplayName(part.resource.uri, 'resource');
                    if (part.resource.text) {
                        return (
                            <div key={`resource-${index}`} className="rounded-md border border-border-subtle p-2">
                                <div className="text-[11px] opacity-70 mb-1">{label}</div>
                                {renderTextLikeContent(part.resource.text, true)}
                            </div>
                        );
                    }
                    if (part.resource.uri) {
                        return (
                            <a key={`resource-uri-${index}`} href={part.resource.uri} target="_blank" rel="noreferrer" className="underline break-all">
                                {label}
                            </a>
                        );
                    }
                }

                return null;
            })}
        </div>
    );
}

export function getChatMessageStableKey(message: ChatMessage, index: number): string {
    const dashboardMessage = message as ChatMessage & { _localId?: string; _turnKey?: string }
    const content = stringifyTextContent(message.content, { joiner: '\n' });
    const parts = [
        message.id ? `id:${message.id}` : '',
        dashboardMessage._localId ? `local:${dashboardMessage._localId}` : '',
        dashboardMessage._turnKey ? `turn:${dashboardMessage._turnKey}` : '',
        typeof message.index === 'number' ? `msgIndex:${message.index}` : '',
        message.role ? `role:${message.role}` : '',
        content ? `content:${content.slice(0, 80)}` : '',
        `fallback:${index}`,
    ].filter(Boolean);

    return parts.join('|');
}

const ActionLogRow = memo(function ActionLogRow({ log }: { log: ActionLog }) {
    return (
        <div className="self-center chat-msg-action">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{log.text}</ReactMarkdown>
            <span className="action-time">{formatTime(log.timestamp)}</span>
        </div>
    );
}, (prev, next) => (
    prev.log === next.log
));

interface ChatMessageRowProps {
    message: ChatMessage;
    receivedAt?: number;
    agentName: string;
    userName?: string;
    isCliMode: boolean;
    isTextExpanded: boolean;
    onToggleTextExpanded: () => void;
}

const ChatMessageRow = memo(function ChatMessageRow({
    message,
    receivedAt,
    agentName,
    userName,
    isCliMode: _isCliMode,
    isTextExpanded,
    onToggleTextExpanded,
}: ChatMessageRowProps) {
    const role = (message.role || '').toLowerCase();
    const isUser = role === 'user' || role === 'human';
    const kind = message.kind || (role === 'tool' ? 'tool' : 'standard');
    const structuredParts = isStructuredMessagePartArray(message.content) ? message.content : null;
    const hasStructuredRenderer = !!structuredParts?.some((part) => part.type !== 'text');
    const contentStr = stringifyTextContent(message.content, { joiner: '\n' });

    if (kind === 'thought') {
        const label = typeof message.meta?.label === 'string' ? message.meta.label : 'Thought';
        return (
            <div className="self-start chat-msg-thought">
                <div className="chat-msg-header">
                    <IconThought size={13} />
                    <span>{label}</span>
                </div>
                <div className="chat-msg-body">
                    {contentStr}
                </div>
            </div>
        );
    }

    if (kind === 'tool') {
        return (
            <div className="self-start chat-msg-tool">
                <span className="tool-icon">⏺</span>
                {hasStructuredRenderer && structuredParts ? (
                    <div className="tool-text w-full">
                        <MessagePartsRenderer parts={structuredParts} renderAsPreformatted={false} />
                    </div>
                ) : (
                    <span className="tool-text">{contentStr.split('\n')[0].slice(0, 80)}</span>
                )}
            </div>
        );
    }

    if (kind === 'terminal') {
        const icon = message.meta?.isRunning ? '⏳' : '✅';
        const label = typeof message.meta?.label === 'string' ? message.meta.label : 'Ran command';
        return (
            <div className="self-start chat-msg-terminal">
                <div className="chat-msg-header">
                    <span>{icon}</span>
                    <span>{label}</span>
                </div>
                {hasStructuredRenderer && structuredParts ? (
                    <div className="chat-msg-body">
                        <MessagePartsRenderer parts={structuredParts} renderAsPreformatted={true} />
                    </div>
                ) : (
                    <pre className="chat-msg-body">
                        {contentStr}
                    </pre>
                )}
            </div>
        );
    }

    if (kind === 'system') {
        return (
            <div className="self-center chat-msg-system">
                {hasStructuredRenderer && structuredParts ? (
                    <MessagePartsRenderer parts={structuredParts} renderAsPreformatted={false} />
                ) : (
                    contentStr.slice(0, 100)
                )}
            </div>
        );
    }

    const meta = message.meta as MessageMeta | undefined;
    const renderMode = typeof meta?.renderMode === 'string' ? meta.renderMode.trim() : '';
    const contentLooksPreformatted = renderMode === 'preformatted';
    const displayContent = contentStr;
    const showExpandBtn = false;
    const visibleContent = displayContent;
    const renderAsPreformatted = contentLooksPreformatted;
    const renderAsMarkdown = !renderAsPreformatted && likelyNeedsMarkdownRender(visibleContent);

    return (
        <div className={`max-w-[88%] min-w-0 flex flex-col gap-1 ${isUser ? 'self-end' : 'self-start'}`}>
            {(displayContent || hasStructuredRenderer || isUser) && (
                <div className={`chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
                    <div className={`chat-bubble-header ${(displayContent || hasStructuredRenderer) ? 'mb-1.5' : 'mb-0'}`}>
                        <span className="chat-sender">
                            {isUser ? (userName || 'You') : (message.senderName || agentName)}
                        </span>
                        {receivedAt != null && (
                            <span className="chat-time">{formatTime(receivedAt)}</span>
                        )}
                    </div>
                    {(displayContent || hasStructuredRenderer) && (
                        <div className="chat-markdown">
                            {hasStructuredRenderer && structuredParts ? (
                                <MessagePartsRenderer parts={structuredParts} renderAsPreformatted={renderAsPreformatted} />
                            ) : renderAsPreformatted ? (
                                <pre className="chat-preformatted">{visibleContent}</pre>
                            ) : renderAsMarkdown ? (
                                <ReactMarkdown remarkPlugins={[remarkGfm, remarkAlert, remarkBreaks]}>
                                    {visibleContent}
                                </ReactMarkdown>
                            ) : (
                                <div style={{ whiteSpace: 'pre-wrap' }}>
                                    {visibleContent}
                                </div>
                            )}
                        </div>
                    )}
                    {showExpandBtn && (
                        <button
                            onClick={onToggleTextExpanded}
                            className="mt-1.5 text-[11px] font-semibold text-[var(--accent-primary)] p-0 opacity-80"
                        >
                            {isTextExpanded ? 'Collapse ↑' : `Show more (${Math.round(displayContent.length / 100) * 100} chars) ↓`}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}, (prev, next) => (
    prev.message === next.message
    && prev.receivedAt === next.receivedAt
    && prev.agentName === next.agentName
    && prev.userName === next.userName
    && prev.isCliMode === next.isCliMode
    && prev.isTextExpanded === next.isTextExpanded
));

// ─── Component ────────────────────────────────

const ChatMessageList = forwardRef<ChatMessageListRef, ChatMessageListProps>(function ChatMessageList(
    { messages, actionLogs, agentName = 'Agent', userName, isCliMode = false, isWorking = false, contextKey = '', receivedAtMap = {}, emptyState, onLoadMore, isLoadingMore, hasMoreHistory, hiddenLiveCount = 0, loadError, scrollToBottomRequestNonce },
    ref
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const prevCountRef = useRef<number>(0);
    const prevContextRef = useRef<string>('');  // Empty value → always different on first render
    const mountedRef = useRef(false);
    const scrollFrameRef = useRef<number | null>(null);
    const contextAutoScrollRef = useRef(false);
    const contextAutoScrollTimerRef = useRef<number | null>(null);
    const hasSelectionRef = useRef(false);
    const [expandedTexts, setExpandedTexts] = useState<Set<string>>(new Set());

    const userScrolledUp = useRef(false);
    const restoredInitialScrollRef = useRef(false);

    /** Check if user is near bottom of scroll */
    const isNearBottom = () => {
        const el = containerRef.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    };

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        const el = containerRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior });
    }, []);

    const saveScrollSnapshot = useCallback(() => {
        const el = containerRef.current;
        if (!el || !contextKey) return;
        chatScrollSnapshotCache.set(contextKey, {
            top: el.scrollTop,
            fromBottom: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
        });
    }, [contextKey]);

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

    const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        if (scrollFrameRef.current != null) {
            cancelAnimationFrame(scrollFrameRef.current);
        }
        scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = null;
            scrollToBottom(behavior);
        });
    }, [scrollToBottom]);

    // Last message content length — detect content updates during streaming
    const lastMsgFingerprint = messages.length > 0
        ? `${messages.length}:${(messages[messages.length - 1]?.content || '').length}`
        : '0:0';

    // Auto-scroll: On new message / streaming update / tab switch
    useEffect(() => {
        const isFirstMount = !mountedRef.current;
        const isTabSwitch = prevContextRef.current !== contextKey;
        prevContextRef.current = contextKey;

        if (isFirstMount || isTabSwitch) {
            mountedRef.current = true;
            userScrolledUp.current = false;
            contextAutoScrollRef.current = true;
            if (!hasSelectionRef.current) {
                const snapshot = contextKey ? chatScrollSnapshotCache.get(contextKey) : null;
                if (snapshot) {
                    requestAnimationFrame(() => {
                        const el = containerRef.current;
                        if (!el) return;
                        const nextTop = Math.max(0, el.scrollHeight - el.clientHeight - snapshot.fromBottom);
                        el.scrollTop = Number.isFinite(nextTop) ? nextTop : snapshot.top;
                        restoredInitialScrollRef.current = true;
                    });
                } else {
                    scheduleScrollToBottom('auto');
                }
            }
            prevCountRef.current = messages.length;
            return;
        }

        // When new message added — follow if user hasn't scrolled up
        const isNewMessage = messages.length > prevCountRef.current;
        if (isNewMessage) {
            if (!userScrolledUp.current && !hasSelectionRef.current) {
                scheduleScrollToBottom('auto');
            }
        } else if (isNearBottom() && !userScrolledUp.current && !hasSelectionRef.current) {
            scheduleScrollToBottom('auto');
        }
        prevCountRef.current = messages.length;
    }, [lastMsgFingerprint, contextKey, isWorking, messages.length, scheduleScrollToBottom]);

    useEffect(() => {
        if (!scrollToBottomRequestNonce) return;
        userScrolledUp.current = false;
        contextAutoScrollRef.current = true;
        restoredInitialScrollRef.current = true;
        if (contextAutoScrollTimerRef.current != null) {
            window.clearTimeout(contextAutoScrollTimerRef.current);
        }
        contextAutoScrollTimerRef.current = window.setTimeout(() => {
            contextAutoScrollRef.current = false;
            contextAutoScrollTimerRef.current = null;
        }, 180);
        if (!hasSelectionRef.current) {
            scheduleScrollToBottom('auto');
        }
    }, [scheduleScrollToBottom, scrollToBottomRequestNonce]);

    useEffect(() => () => {
        saveScrollSnapshot();
        if (scrollFrameRef.current != null) {
            cancelAnimationFrame(scrollFrameRef.current);
        }
        if (contextAutoScrollTimerRef.current != null) {
            window.clearTimeout(contextAutoScrollTimerRef.current);
        }
    }, [saveScrollSnapshot]);

    useEffect(() => {
        const contentEl = contentRef.current;
        if (!contentEl) return;

        const finishContextAutoScroll = () => {
            if (contextAutoScrollTimerRef.current != null) {
                window.clearTimeout(contextAutoScrollTimerRef.current);
            }
            contextAutoScrollTimerRef.current = window.setTimeout(() => {
                contextAutoScrollRef.current = false;
                contextAutoScrollTimerRef.current = null;
            }, 180);
        };

        const observer = new ResizeObserver(() => {
            if (!contextAutoScrollRef.current) return;
            if (hasSelectionRef.current) return;
            scheduleScrollToBottom('auto');
            finishContextAutoScroll();
        });

        observer.observe(contentEl);
        return () => {
            observer.disconnect();
            if (contextAutoScrollTimerRef.current != null) {
                window.clearTimeout(contextAutoScrollTimerRef.current);
                contextAutoScrollTimerRef.current = null;
            }
        };
    }, [scheduleScrollToBottom, contextKey]);

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
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
                // If 200px+ from bottom, user has scrolled up
                userScrolledUp.current = !isNearBottom();
                saveScrollSnapshot();
            }, 50);
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => { el.removeEventListener('scroll', onScroll); clearTimeout(scrollTimer); };
    }, [saveScrollSnapshot]);

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
        saveScrollSnapshot();
        prevScrollHeight.current = 0;
        isHistoryLoading.current = false;
    }, [messages.length, saveScrollSnapshot]);

    useEffect(() => {
        if (restoredInitialScrollRef.current) return;
        if (!contextKey) return;
        const snapshot = chatScrollSnapshotCache.get(contextKey);
        const el = containerRef.current;
        if (!snapshot || !el) return;
        const nextTop = Math.max(0, el.scrollHeight - el.clientHeight - snapshot.fromBottom);
        el.scrollTop = Number.isFinite(nextTop) ? nextTop : snapshot.top;
        restoredInitialScrollRef.current = true;
    }, [contextKey, messages.length]);

    // Track when load starts so we can restore scroll after
    const handleLoadMoreClick = () => {
        const el = containerRef.current;
        if (el) prevScrollHeight.current = el.scrollHeight;
        isHistoryLoading.current = true;
        onLoadMore?.();
    };

    // Merge messages + action logs by timestamp
    type MsgItem = { type: 'message'; data: ChatMessage; index: number; ts: number };
    type LogItem = { type: 'action'; data: ActionLog; index: number; ts: number };
    type MergedItem = MsgItem | LogItem;

    const items: MergedItem[] = useMemo(() => {
        const msgItems: MsgItem[] = messages.map((m, i) => ({
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
    }, [messages, actionLogs, receivedAtMap]);
    const hasMoreVisibleContent = hiddenLiveCount > 0 || !!hasMoreHistory;
    const loadMoreLabel = hiddenLiveCount > 0
        ? `↑ Show ${Math.min(hiddenLiveCount, 80)} earlier messages${hiddenLiveCount > 80 ? ` (${hiddenLiveCount} hidden)` : ''}`
        : (loadError ? `↻ ${loadError}` : '↑ Load older messages');

    return (
        <div
            ref={containerRef}
            data-chat-scroll
            className="chat-container"
        >
            <div ref={contentRef} className="chat-container-content">
            {/* Load more button — shown at top when there's history available */}
            {isLoadingMore && (
                <div className="text-center py-3 text-text-muted text-xs opacity-60 animate-pulse">
                    Loading older messages...
                </div>
            )}
            {hasMoreVisibleContent && !isLoadingMore && (
                <div className="text-center py-2">
                    <button
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
                        Waiting for messages...
                    </div>
                )
            )}

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
                        <span className="text-[11px] text-text-muted ml-1">Agent generating...</span>
                    </div>
                </div>
            )}

            <div className="min-h-10" ref={endRef} />
            </div>
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
    && prev.emptyState === next.emptyState
    && prev.onLoadMore === next.onLoadMore
    && prev.isLoadingMore === next.isLoadingMore
    && prev.hasMoreHistory === next.hasMoreHistory
    && prev.hiddenLiveCount === next.hiddenLiveCount
    && prev.loadError === next.loadError
    && prev.scrollToBottomRequestNonce === next.scrollToBottomRequestNonce
));

export default MemoizedChatMessageList;
