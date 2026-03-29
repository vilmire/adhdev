/**
 * ChatMessageList — shared Chat message rendering component
 *
 * Dashboard / IDE / AgentStreamPanelfrom commonto use.
 * Supports 5 message types: thought, tool, system, action, standard.
 */

import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
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
    /** Error message to show on load button (e.g. retry hint) */
    loadError?: string;
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
        const trimmed = line.trim();
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

        if (/^[\s]*[╭╰│├╮╯]/.test(line) || /^[╭╰│├╮╯─]+/.test(trimmed)) continue;
        if (/^\s+[⊙✓✗○◎▸►✦]/.test(line)) continue;
        if (skipUntilEmpty && /^\s{2,}/.test(line)) continue;

        skipUntilEmpty = false;
        const cleaned = line.replace(/^❯\s+/, '');
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

// ─── Component ────────────────────────────────

const ChatMessageList = forwardRef<ChatMessageListRef, ChatMessageListProps>(function ChatMessageList(
    { messages, actionLogs, agentName = 'Agent', userName, isCliMode = false, isWorking = false, contextKey = '', receivedAtMap = {}, emptyState, onLoadMore, isLoadingMore, hasMoreHistory, loadError },
    ref
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const prevCountRef = useRef<number>(0);
    const prevContextRef = useRef<string>('');  // Empty value → always different on first render
    const mountedRef = useRef(false);
    const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());
    const [expandedTexts, setExpandedTexts] = useState<Set<string>>(new Set());

    const userScrolledUp = useRef(false);

    /** Check if user is near bottom of scroll */
    const isNearBottom = () => {
        const el = containerRef.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    };

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
            const scrollToEnd = () => {
                endRef.current?.scrollIntoView({ behavior: 'instant' });
            };
            requestAnimationFrame(() => requestAnimationFrame(scrollToEnd));
            setTimeout(scrollToEnd, 100);
            setTimeout(scrollToEnd, 300);
            prevCountRef.current = messages.length;
            return;
        }

        // When new message added — follow if user hasn't scrolled up
        const isNewMessage = messages.length > prevCountRef.current;
        if (isNewMessage) {
            if (!userScrolledUp.current) {
                // New message: follow instantly
                endRef.current?.scrollIntoView({ behavior: 'instant' });
            }
        } else if (isNearBottom() && !userScrolledUp.current) {
            // Streaming content update — follow smoothly
            endRef.current?.scrollIntoView({ behavior: 'instant' });
        }
        prevCountRef.current = messages.length;
    }, [lastMsgFingerprint, contextKey, isWorking]);

    useImperativeHandle(ref, () => ({
        scrollToBottom: (behavior: ScrollBehavior = 'smooth') => {
            endRef.current?.scrollIntoView({ behavior });
        },
    }));

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

    const items: MergedItem[] = (() => {
        const msgItems: MsgItem[] = messages.map((m, i) => ({
            type: 'message' as const,
            data: m,
            index: i,
            ts: m.receivedAt || receivedAtMap[m.id ?? `i-${i}`] || 0,
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
    })();

    const CLI_TRUNCATE = 700;

    return (
        <div
            ref={containerRef}
            data-chat-scroll
            className="chat-container"
        >
            {/* Load more button — shown at top when there's history available */}
            {isLoadingMore && (
                <div className="text-center py-3 text-text-muted text-xs opacity-60 animate-pulse">
                    Loading older messages...
                </div>
            )}
            {hasMoreHistory && !isLoadingMore && (
                <div className="text-center py-2">
                    <button
                        onClick={handleLoadMoreClick}
                        className={`text-[11px] rounded-xl px-4 py-1.5 cursor-pointer border transition-all ${
                            loadError
                                ? 'bg-transparent border-yellow-500/30 text-yellow-400 opacity-80 hover:opacity-100'
                                : 'bg-transparent border-border-subtle text-text-muted opacity-70 hover:opacity-100 hover:border-accent/40'
                        }`}
                    >
                        {loadError ? `↻ ${loadError}` : '↑ Load older messages'}
                    </button>
                </div>
            )}

            {items.length === 0 && !hasMoreHistory && (
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
                        <div key={`action-${item.index}`} className="self-center chat-msg-action">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{log.text}</ReactMarkdown>
                            <span className="action-time">{formatTime(log.timestamp)}</span>
                        </div>
                    );
                }

                const m = item.data as ChatMessage;
                const i = item.index;
                const role = (m.role || '').toLowerCase();
                const isUser = role === 'user' || role === 'human';
                const kind = m.kind || (role === 'tool' ? 'tool' : 'standard');
                const receivedAt = m.receivedAt || receivedAtMap[m.id ?? `i-${i}`];
                const expandKey = `${contextKey}-${i}`;
                const isExpanded = expandedMsgs.has(expandKey);
                const isTextExpanded = expandedTexts.has(expandKey);

                const contentStr = typeof m.content === 'string' ? m.content : (m.content || []).map((b: any) => b.text || '').join('\n');

                // thought: collapsible thinking block
                if (kind === 'thought') {
                    const label = (m as any).meta?.label || 'Thought';
                    return (
                        <div key={`msg-${i}`} className="self-start chat-msg-thought">
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

                // tool: compact badge
                if (kind === 'tool') {
                    return (
                        <div key={`msg-${i}`} className="self-start chat-msg-tool">
                            <span className="tool-icon">⏺</span>
                            <span className="tool-text">{contentStr.split('\n')[0].slice(0, 80)}</span>
                        </div>
                    );
                }

                // terminal: command execution with header + scrollable output
                if (kind === 'terminal') {
                    const meta = (m as any).meta || {};
                    const icon = meta.isRunning ? '⏳' : '✅';
                    const label = meta.label || 'Ran command';
                    return (
                        <div key={`msg-${i}`} className="self-start chat-msg-terminal">
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

                // system: center pill
                if (kind === 'system') {
                    return (
                        <div key={`msg-${i}`} className="self-center chat-msg-system">
                            {contentStr.slice(0, 100)}
                        </div>
                    );
                }

                // standard message (user / assistant)
                const parsed = (!isUser && isCliMode) ? parseCliContent(contentStr) : null;
                const displayContent = parsed ? parsed.textContent : contentStr;
                const toolEntries = parsed ? Object.entries(parsed.toolCounts) : [];

                const showExpandBtn = isCliMode && !isUser && !isExpanded && displayContent.length > CLI_TRUNCATE;
                const visibleContent = isExpanded
                    ? contentStr
                    : (showExpandBtn && !isTextExpanded)
                        ? displayContent.slice(0, CLI_TRUNCATE)
                        : displayContent;

                return (
                    <div key={`msg-${i}`} className={`max-w-[88%] min-w-0 flex flex-col gap-1 ${isUser ? 'self-end' : 'self-start'}`}>
                        {/* Tool activity badges (CLI) */}
                        {toolEntries.length > 0 && (
                            <div className="flex flex-wrap gap-1 items-center mb-0.5">
                                {toolEntries.map(([name, count]) => (
                                    <span key={name} className="chat-tool-badge">
                                        ⏺ {name}{count > 1 ? ` ×${count}` : ''}
                                    </span>
                                ))}
                                {parsed?.hasTools && (
                                    <button onClick={() => setExpandedMsgs(prev => {
                                        const next = new Set(prev);
                                        isExpanded ? next.delete(expandKey) : next.add(expandKey);
                                        return next;
                                    })} className="text-[10px] text-text-muted px-1 py-px opacity-50">
                                        {isExpanded ? 'Collapse' : 'Original'}
                                    </button>
                                )}
                                {!displayContent && receivedAt != null && (
                                    <span className="text-[10px] opacity-35 ml-0.5">{formatTime(receivedAt)}</span>
                                )}
                            </div>
                        )}
                        {/* Message bubble */}
                        {(displayContent || isUser) && (
                            <div className={`chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
                                <div className={`chat-bubble-header ${displayContent ? 'mb-1.5' : 'mb-0'}`}>
                                    <span className="chat-sender">
                                        {isUser ? (userName || 'You') : agentName}
                                    </span>
                                    {receivedAt != null && (
                                        <span className="chat-time">{formatTime(receivedAt)}</span>
                                    )}
                                </div>
                                {displayContent && (
                                    <div className="chat-markdown">
                                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkAlert, remarkBreaks]}>
                                            {visibleContent}
                                        </ReactMarkdown>
                                    </div>
                                )}
                                {showExpandBtn && (
                                    <button
                                        onClick={() => setExpandedTexts(prev => {
                                            const next = new Set(prev);
                                            isTextExpanded ? next.delete(expandKey) : next.add(expandKey);
                                            return next;
                                        })}
                                        className="mt-1.5 text-[11px] font-semibold text-[var(--accent-primary)] p-0 opacity-80"
                                    >
                                        {isTextExpanded ? 'Collapse ↑' : `Show more (${Math.round(displayContent.length / 100) * 100} chars) ↓`}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}

            {/* Typing indicator */}
            {isWorking && (
                <div className="self-start chat-typing-wrapper">
                    <div className="typing-indicator">
                        <div className="dot" />
                        <div className="dot" />
                        <div className="dot" />
                        <span className="text-[11px] text-text-muted ml-1">Agent working...</span>
                    </div>
                </div>
            )}

            <div className="min-h-10" ref={endRef} />
        </div>
    );
});

export default ChatMessageList;
