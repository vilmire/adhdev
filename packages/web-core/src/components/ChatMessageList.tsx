/**
 * ChatMessageList — shared Chat message rendering component
 *
 * Dashboard / IDE / AgentStreamPanelfrom commonto use.
 * Supports 5 message types: thought, tool, system, action, standard.
 */

import { memo, useState, useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkAlert from 'remark-github-blockquote-alert';
import remarkBreaks from 'remark-breaks';
import { IconThought } from './Icons';

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

// ─── CLI Content Parser ────────────────────────

export function parseCliContent(content: string): {
    toolCounts: Record<string, number>;
    textContent: string;
    hasTools: boolean;
} {
    const normalizeCliLine = (value: string) => value
        .replace(/^\d+;/, '')
        .replace(/\u0007/g, '')
        .trim()

    // Pre-process carriage returns: PTY \r overwrites — prioritize ⏺ response content
    const processedContent = content.split('\n').map(line => {
        if (!line.includes('\r')) return line;
        const segments = line.split('\r').map(s => s.trim()).filter(Boolean);
        if (segments.length === 0) return '';
        const responseSegs = segments.filter(s => s.startsWith('⏺'));
        if (responseSegs.length > 0) return responseSegs[responseSegs.length - 1];
        const nonTuiSegs = segments.filter(s => {
            if (/^[❯›>]\s*$/.test(s)) return false;
            if (/^[^a-zA-Z0-9\s]\s*\S+[…\.]{1,3}\s*$/.test(s) && s.length < 40) return false;
            if (/^[╭╰│├╮╯─═]+$/.test(s)) return false;
            return true;
        });
        if (nonTuiSegs.length > 0) return nonTuiSegs[nonTuiSegs.length - 1];
        return segments[segments.length - 1];
    }).join('\n');

    const lines = processedContent.split('\n');
    const toolCounts: Record<string, number> = {};
    const textLines: string[] = [];
    let skipUntilEmpty = false;

    for (const line of lines) {
        const trimmed = normalizeCliLine(line);
        if (trimmed === '') { skipUntilEmpty = false; textLines.push(''); continue; }

        // TUI artifact filtering
        if (/^❯\s*$/.test(trimmed) || /^>\s*$/.test(trimmed)) continue;
        if (/^[✡-✩✪-✿⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◆◇◐◑◒◓]\s*\S+[…\.]{1,3}\s*$/.test(trimmed)) continue;
        if (/^◐\s/.test(trimmed) || /\/effort/.test(trimmed)) continue;
        if (/^⎿\s+(Tip|Note|Hint):/.test(trimmed)) continue;
        if (/^\?\s*(for\s*shortcuts|shortcuts)/.test(trimmed)) continue;
        if (/esc\s+to\s+interrupt|shift\+tab\s+to\s+cycle|accept\s+edits\s+on/i.test(trimmed)) continue;
        if (/Brewing[…\.]{0,3}\s*\d*$/i.test(trimmed) || /^[✢✳✶✻⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◆◇✦\s]+$/.test(trimmed)) continue;
        if (/^Auto-updating/i.test(trimmed)) continue;
        if (/^✳\s*Debug (?:Claude Code|Codex) CLI/i.test(trimmed)) continue;
        if (/^(?:─|═|╭|╰|│|├|╮|╯|┌|┐|└|┘|┬|┴|┼)+$/.test(trimmed)) continue;

        // ⏺ / ● / · — tool call or action summary
        if (/^[⏺●·⏵]/.test(line)) {
            const m = line.match(/^[⏺●·]\s*([A-Za-z][A-Za-z0-9_]*)\s*[\(\[]/);
            if (m) {
                toolCounts[m[1]] = (toolCounts[m[1]] || 0) + 1;
            } else {
                const action = line.replace(/^[⏺●·⏵]\s*/, '').trim().slice(0, 40);
                if (action) toolCounts[action] = (toolCounts[action] || 0) + 1;
            }
            skipUntilEmpty = true;
            continue;
        }

        if (/^(?:Bash|Read|Write|Edit|MultiEdit|Task|Glob|Grep|LS|NotebookEdit|Exact output)(?:\(|:)/.test(trimmed)) {
            const toolName = trimmed.match(/^([A-Za-z][A-Za-z0-9_ ]+)/)?.[1]?.trim() || 'Tool';
            toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
            skipUntilEmpty = true;
            continue;
        }
        if (/^Read\s+\d+\s+files?(?:\s+\(.*\))?$/i.test(trimmed)) {
            toolCounts.Read = (toolCounts.Read || 0) + 1;
            skipUntilEmpty = true;
            continue;
        }

        if (/^[\s]*[╭╰│├╮╯]/.test(line) || /^[╭╰│├╮╯─]+/.test(trimmed)) continue;
        if (/^\s+[⊙✓✗○◎▸►✦]/.test(line)) continue;
        if (skipUntilEmpty && /^\s{2,}/.test(line)) continue;

        skipUntilEmpty = false;
        const cleaned = trimmed.replace(/^❯\s+/, '');
        textLines.push(cleaned);
    }

    const textContent = textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { toolCounts, textContent, hasTools: Object.keys(toolCounts).length > 0 };
}

// ─── Helpers ──────────────────────────────────

function formatTime(ms?: number): string {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function getRenderableTimestamp(message: ChatMessage, index: number, receivedAtMap: Record<string, number>): number {
    const anyMessage = message as any;
    return Number(
        anyMessage.timestamp
        || anyMessage.receivedAt
        || anyMessage.createdAt
        || receivedAtMap[getChatMessageStableKey(message, index)]
        || 0,
    ) || 0;
}

function likelyNeedsMarkdownRender(content: string): boolean {
    return /[`*_#[\]()>-]|https?:\/\/|\n\s*[-*]\s|\n\s*\d+\.\s|\|/.test(content);
}

export function getChatMessageStableKey(message: ChatMessage, index: number): string {
    const anyMessage = message as any;
    const content = typeof anyMessage.content === 'string'
        ? anyMessage.content
        : Array.isArray(anyMessage.content)
            ? anyMessage.content.map((block: any) => block?.text || '').join('\n')
            : String(anyMessage.content || '');
    const parts = [
        anyMessage.id ? `id:${anyMessage.id}` : '',
        anyMessage._localId ? `local:${anyMessage._localId}` : '',
        anyMessage._turnKey ? `turn:${anyMessage._turnKey}` : '',
        typeof anyMessage.index === 'number' ? `msgIndex:${anyMessage.index}` : '',
        anyMessage.timestamp ? `ts:${anyMessage.timestamp}` : '',
        anyMessage.role ? `role:${anyMessage.role}` : '',
        content ? `content:${content.slice(0, 80)}` : '',
        `fallback:${index}`,
    ].filter(Boolean);

    return parts.join('|');
}

const CLI_TRUNCATE = 700;

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
    isExpanded: boolean;
    isTextExpanded: boolean;
    onToggleExpanded: () => void;
    onToggleTextExpanded: () => void;
}

const ChatMessageRow = memo(function ChatMessageRow({
    message,
    receivedAt,
    agentName,
    userName,
    isCliMode,
    isExpanded,
    isTextExpanded,
    onToggleExpanded,
    onToggleTextExpanded,
}: ChatMessageRowProps) {
    const role = (message.role || '').toLowerCase();
    const isUser = role === 'user' || role === 'human';
    const kind = message.kind || (role === 'tool' ? 'tool' : 'standard');
    const contentStr = typeof message.content === 'string'
        ? message.content
        : (message.content || []).map((block: any) => block.text || '').join('\n');

    if (kind === 'thought') {
        const label = (message as any).meta?.label || 'Thought';
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
                <span className="tool-text">{contentStr.split('\n')[0].slice(0, 80)}</span>
            </div>
        );
    }

    if (kind === 'terminal') {
        const meta = (message as any).meta || {};
        const icon = meta.isRunning ? '⏳' : '✅';
        const label = meta.label || 'Ran command';
        return (
            <div className="self-start chat-msg-terminal">
                <div className="chat-msg-header">
                    <span>{icon}</span>
                    <span>{label}</span>
                </div>
                <pre className="chat-msg-body">
                    {contentStr}
                </pre>
            </div>
        );
    }

    if (kind === 'system') {
        return (
            <div className="self-center chat-msg-system">
                {contentStr.slice(0, 100)}
            </div>
        );
    }

    const parsed = (!isUser && isCliMode) ? parseCliContent(contentStr) : null;
    const displayContent = parsed ? parsed.textContent : contentStr;
    const toolEntries = parsed ? Object.entries(parsed.toolCounts) : [];
    const showExpandBtn = isCliMode && !isUser && !isExpanded && displayContent.length > CLI_TRUNCATE;
    const visibleContent = isExpanded
        ? contentStr
        : (showExpandBtn && !isTextExpanded)
            ? displayContent.slice(0, CLI_TRUNCATE)
            : displayContent;
    const renderAsMarkdown = likelyNeedsMarkdownRender(visibleContent);

    return (
        <div className={`max-w-[88%] min-w-0 flex flex-col gap-1 ${isUser ? 'self-end' : 'self-start'}`}>
            {toolEntries.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center mb-0.5">
                    {toolEntries.map(([name, count]) => (
                        <span key={name} className="chat-tool-badge">
                            ⏺ {name}{count > 1 ? ` ×${count}` : ''}
                        </span>
                    ))}
                    {parsed?.hasTools && (
                        <button onClick={onToggleExpanded} className="text-[10px] text-text-muted px-1 py-px opacity-50">
                            {isExpanded ? 'Collapse' : 'Original'}
                        </button>
                    )}
                    {!displayContent && receivedAt != null && (
                        <span className="text-[10px] opacity-35 ml-0.5">{formatTime(receivedAt)}</span>
                    )}
                </div>
            )}
            {(displayContent || isUser) && (
                <div className={`chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
                    <div className={`chat-bubble-header ${displayContent ? 'mb-1.5' : 'mb-0'}`}>
                        <span className="chat-sender">
                            {isUser ? (userName || 'You') : (message.senderName || agentName)}
                        </span>
                        {receivedAt != null && (
                            <span className="chat-time">{formatTime(receivedAt)}</span>
                        )}
                    </div>
                    {displayContent && (
                        <div className="chat-markdown">
                            {renderAsMarkdown ? (
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
    && prev.isExpanded === next.isExpanded
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
    const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());
    const [expandedTexts, setExpandedTexts] = useState<Set<string>>(new Set());

    const userScrolledUp = useRef(false);

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
            if (!hasSelectionRef.current) scheduleScrollToBottom('auto');
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
        if (scrollFrameRef.current != null) {
            cancelAnimationFrame(scrollFrameRef.current);
        }
        if (contextAutoScrollTimerRef.current != null) {
            window.clearTimeout(contextAutoScrollTimerRef.current);
        }
    }, []);

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
            }, 50);
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => { el.removeEventListener('scroll', onScroll); clearTimeout(scrollTimer); };
    }, []);

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
        prevScrollHeight.current = 0;
        isHistoryLoading.current = false;
    }, [messages.length]);

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
                const isExpanded = expandedMsgs.has(expandKey);
                const isTextExpanded = expandedTexts.has(expandKey);
                return (
                    <ChatMessageRow
                        key={`msg-${messageKey}`}
                        message={m}
                        receivedAt={receivedAt}
                        agentName={agentName}
                        userName={userName}
                        isCliMode={isCliMode}
                        isExpanded={isExpanded}
                        isTextExpanded={isTextExpanded}
                        onToggleExpanded={() => setExpandedMsgs(prev => {
                            const next = new Set(prev);
                            isExpanded ? next.delete(expandKey) : next.add(expandKey);
                            return next;
                        })}
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
