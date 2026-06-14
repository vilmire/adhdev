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
import { buildChatMessageSignature } from '@adhdev/daemon-core/chat/chat-signatures';
import type { Pluggable, PluggableList } from 'unified';
import { IconThought } from './Icons';
import { stringifyTextContent } from '../utils/text';
import { classifyChatMessageForDisplay, filterChatMessagesForDefaultTranscript, filterChatActivityMessages, mergeChatAndActivityMessages } from './dashboard/chat-activity-visibility';

// ─── Types ────────────────────────────────────

import type { ChatMessage } from '../types';

const gfmRemarkPlugin: Pluggable = [remarkGfm, { singleTilde: false }];
const chatRemarkPlugins: PluggableList = [gfmRemarkPlugin, remarkAlert, remarkBreaks];
const actionLogRemarkPlugins: PluggableList = [gfmRemarkPlugin];

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

type ChatScrollSnapshot = {
    top: number;
    fromBottom: number;
    messageFingerprint?: string;
}

type ChatContentAutoScrollOptions = {
    hasSelection: boolean;
    userScrolledUp: boolean;
    /** True only when the transcript fingerprint changed; status/typing-only updates must not pull history to bottom. */
    hasChatContentChanged?: boolean;
    isNewMessage?: boolean;
    isNearBottomAfterUpdate?: boolean;
}

type ChatResizeAutoScrollOptions = {
    hasSelection: boolean;
    userScrolledUp: boolean;
    contextAutoScrollActive: boolean;
}

type ChatScrollJumpButtonState = {
    showTop: boolean;
    showBottom: boolean;
}

type ChatScrollJumpButtonOptions = {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    topThresholdPx?: number;
    bottomThresholdPx?: number;
}

const CHAT_SCROLL_NEAR_BOTTOM_PX = 200;
const CHAT_SCROLL_TOP_JUMP_THRESHOLD_PX = 80;
const CHAT_BOTTOM_AUTO_SCROLL_WINDOW_MS = 650;
const chatScrollSnapshotCache = new Map<string, ChatScrollSnapshot>();

export function shouldRestoreChatScrollSnapshot(
    snapshot: ChatScrollSnapshot | null | undefined,
    currentMessageFingerprint: string,
): boolean {
    if (!snapshot) return false;
    const savedFingerprint = String(snapshot.messageFingerprint || '');
    if (!savedFingerprint) return true;
    return savedFingerprint === String(currentMessageFingerprint || '');
}

export function buildChatScrollFingerprint(messages: ChatMessage[], lastMessageHash?: string): string {
    if (!Array.isArray(messages) || messages.length === 0) return '0:empty';
    const providedHash = String(lastMessageHash || '').trim();
    if (providedHash) return `${messages.length}:${providedHash}`;
    const lastMessage = messages[messages.length - 1];
    return `${messages.length}:${buildChatMessageSignature(lastMessage)}`;
}

export function shouldAutoScrollOnChatVisibilityChange(
    previousIsVisible: boolean,
    nextIsVisible: boolean,
): boolean {
    void previousIsVisible;
    void nextIsVisible;
    // Dockview tab/focus/split/floating changes should preserve the user's current
    // read position. Explicit navigation intents still use scrollToBottomRequestNonce.
    return false;
}

export function shouldRestoreChatScrollOnVisibilityChange(
    previousIsVisible: boolean,
    nextIsVisible: boolean,
    snapshot: ChatScrollSnapshot | null | undefined,
    currentMessageFingerprint: string,
): boolean {
    if (previousIsVisible || !nextIsVisible) return false;
    return shouldRestoreChatScrollSnapshot(snapshot, currentMessageFingerprint);
}

export function getChatScrollJumpButtonState({
    scrollTop,
    scrollHeight,
    clientHeight,
    topThresholdPx = CHAT_SCROLL_TOP_JUMP_THRESHOLD_PX,
    bottomThresholdPx = CHAT_SCROLL_NEAR_BOTTOM_PX,
}: ChatScrollJumpButtonOptions): ChatScrollJumpButtonState {
    const safeScrollTop = Math.max(0, Number(scrollTop) || 0);
    const safeScrollHeight = Math.max(0, Number(scrollHeight) || 0);
    const safeClientHeight = Math.max(0, Number(clientHeight) || 0);
    const maxScrollTop = Math.max(0, safeScrollHeight - safeClientHeight);
    if (maxScrollTop <= 0) return { showTop: false, showBottom: false };
    return {
        showTop: safeScrollTop > topThresholdPx,
        showBottom: Math.max(0, safeScrollHeight - safeScrollTop - safeClientHeight) > bottomThresholdPx,
    };
}

function getChatScrollJumpButtonStateForElement(el: HTMLElement): ChatScrollJumpButtonState {
    return getChatScrollJumpButtonState({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
    });
}

export function isChatScrollSnapshotScrolledUp(
    snapshot: ChatScrollSnapshot | null | undefined,
    thresholdPx = CHAT_SCROLL_NEAR_BOTTOM_PX,
): boolean {
    return !!snapshot && snapshot.fromBottom >= thresholdPx;
}

export function shouldOpenBottomAutoScrollWindowOnInitialChatMount(
    snapshot: ChatScrollSnapshot | null | undefined,
    currentMessageFingerprint: string,
): boolean {
    if (!shouldRestoreChatScrollSnapshot(snapshot, currentMessageFingerprint)) return true;
    return !isChatScrollSnapshotScrolledUp(snapshot);
}

export function shouldAutoScrollAfterChatContentChange({
    hasSelection,
    userScrolledUp,
    hasChatContentChanged = true,
}: ChatContentAutoScrollOptions): boolean {
    if (hasSelection) return false;
    if (userScrolledUp) return false;
    if (!hasChatContentChanged) return false;
    // If the view is in bottom-follow mode, keep following for both appended messages
    // and same-message streaming growth. Reading "near bottom" after the DOM update
    // can already be false when a tall chunk or a wrapped split-pane layout was added.
    return true;
}

export function shouldAutoScrollOnChatResize({
    hasSelection,
    userScrolledUp,
    contextAutoScrollActive,
}: ChatResizeAutoScrollOptions): boolean {
    if (hasSelection) return false;
    return contextAutoScrollActive || !userScrolledUp;
}

function restoreChatScrollSnapshot(el: HTMLDivElement, snapshot: ChatScrollSnapshot): void {
    const nextTop = Math.max(0, el.scrollHeight - el.clientHeight - snapshot.fromBottom);
    el.scrollTop = Number.isFinite(nextTop) ? nextTop : snapshot.top;
}

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

export function shouldRenderChatMessageInVisibleTranscript(message: ChatMessage): boolean {
    return classifyChatMessageForDisplay(message).isUserFacing;
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
    alt?: string;
    transcript?: string;
    name?: string;
    title?: string;
    description?: string;
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

function renderStructuredPlaceholder(kind: string, label: string, detail?: string): React.ReactNode {
    return (
        <div className="rounded-md border border-border-subtle p-2 text-sm" role="note">
            <span className="font-medium">{kind}</span>
            {label ? <span className="ml-1 break-all">{label}</span> : null}
            {detail ? <div className="mt-1 opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{detail}</div> : null}
        </div>
    );
}

function renderTextLikeContent(content: string, renderAsPreformatted: boolean): React.ReactNode {
    if (!content) return null;
    if (renderAsPreformatted) {
        return <pre className="chat-preformatted">{content}</pre>;
    }
    if (likelyNeedsMarkdownRender(content)) {
        return (
            <ReactMarkdown remarkPlugins={chatRemarkPlugins}>
                {content}
            </ReactMarkdown>
        );
    }
    return <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>;
}

/**
 * Standalone, content-keyed markdown body for standard chat bubbles.
 *
 * ReactMarkdown re-parses its input string on every render. The chat list
 * re-renders on every tail/status tick, so without this memo each visible row
 * would re-parse Markdown even when its text is identical to the previous tick.
 * Keying the memo on the raw `content` string (plus the render mode flags that
 * change the output) lets unchanged rows skip the parse entirely; the actively
 * streaming last message still re-parses because its content keeps growing.
 */
const ChatMarkdownBody = memo(function ChatMarkdownBody({
    content,
    renderAsPreformatted,
    renderAsMarkdown,
}: {
    content: string;
    renderAsPreformatted: boolean;
    renderAsMarkdown: boolean;
}) {
    if (renderAsPreformatted) {
        return <pre className="chat-preformatted">{content}</pre>;
    }
    if (renderAsMarkdown) {
        return (
            <ReactMarkdown remarkPlugins={chatRemarkPlugins}>
                {content}
            </ReactMarkdown>
        );
    }
    return (
        <div style={{ whiteSpace: 'pre-wrap' }}>
            {content}
        </div>
    );
});

function MessagePartsRenderer({ parts, renderAsPreformatted }: { parts: StructuredMessagePart[]; renderAsPreformatted: boolean }): React.ReactNode {
    return (
        <div className="flex flex-col gap-2">
            {parts.map((part, index) => {
                if (part.type === 'text') {
                    return <div key={`text-${index}`}>{renderTextLikeContent(String(part.text || ''), renderAsPreformatted)}</div>;
                }

                if (part.type === 'image') {
                    const src = buildMediaSrc(part);
                    const alt = part.alt || part.description || getResourceDisplayName(part.uri, 'image');
                    if (!src) return <div key={`image-fallback-${index}`}>{renderStructuredPlaceholder('Image', alt, part.mimeType)}</div>;
                    return (
                        <img
                            key={`image-${index}`}
                            src={src}
                            alt={alt}
                            className="max-w-full rounded-md border border-border-subtle"
                        />
                    );
                }

                if (part.type === 'audio') {
                    const src = buildMediaSrc(part);
                    return src ? (
                        <div key={`audio-${index}`} className="flex flex-col gap-1">
                            <audio controls src={src} className="max-w-full" />
                            {part.transcript ? <div className="text-sm opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{part.transcript}</div> : null}
                        </div>
                    ) : <div key={`audio-fallback-${index}`}>{renderStructuredPlaceholder('Audio', getResourceDisplayName(part.uri, 'audio'), part.transcript || part.mimeType)}</div>;
                }

                if (part.type === 'video') {
                    const src = buildMediaSrc(part);
                    const label = part.title || part.name || part.alt || getResourceDisplayName(part.uri, 'video');
                    const detail = [part.transcript, part.description, part.mimeType].filter(Boolean).join('\n');
                    return (
                        <div key={`video-${index}`} className="flex flex-col gap-1">
                            {src ? (
                                <video
                                    controls
                                    src={src}
                                    poster={part.posterUri}
                                    className="max-w-full rounded-md border border-border-subtle"
                                />
                            ) : (
                                renderStructuredPlaceholder('Video', label, detail)
                            )}
                            {src && detail ? <div className="text-sm opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{detail}</div> : null}
                        </div>
                    );
                }

                if (part.type === 'resource_link') {
                    const label = part.title || part.name || getResourceDisplayName(part.uri, 'resource');
                    const detail = [part.description, part.mimeType].filter(Boolean).join('\n');
                    return (
                        <div key={`resource-link-${index}`} className="flex flex-col gap-1">
                            {part.uri ? (
                                <a href={part.uri} target="_blank" rel="noreferrer" download className="underline break-all">
                                    {label}
                                </a>
                            ) : (
                                renderStructuredPlaceholder('Resource', label, detail)
                            )}
                            {part.uri && detail ? <div className="text-sm opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{detail}</div> : null}
                        </div>
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
            <ReactMarkdown remarkPlugins={actionLogRemarkPlugins}>{log.text}</ReactMarkdown>
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

/**
 * Stable render-signature for a chat message row.
 *
 * The tail controller hands the list a brand-new message array (with new object
 * identities) on every status/tail tick, so a `prev.message === next.message`
 * reference check never short-circuits and every visible row re-renders (and
 * re-parses Markdown) each tick. This signature instead captures exactly the
 * fields the row render reads, so an unchanged message produces an identical
 * signature across ticks while the actively-streaming last message — whose
 * content keeps growing — produces a changing one and keeps updating.
 *
 * `buildChatMessageSignature` already folds in id/index/role/receivedAt/content;
 * we append the remaining render-driving fields (kind, sender, and the meta /
 * visibility flags consumed by the activity/thought/terminal/markdown branches).
 */
export function buildChatMessageRowSignature(message: ChatMessage): string {
    const meta = message.meta as (Record<string, unknown> | undefined);
    return [
        buildChatMessageSignature(message),
        message.kind || '',
        message.senderName || '',
        message.bubbleId || '',
        message.bubbleState || '',
        // Classification inputs (see classifyChatMessageForDisplay): a message can
        // flip between chat-visible and activity-facing without its content
        // changing, which changes the rendered branch.
        message.visibility || '',
        message.transcriptVisibility || '',
        message.audience || '',
        message.source || '',
        message.userFacing === undefined ? '' : String(message.userFacing),
        message.internal === undefined ? '' : String(message.internal),
        message.isInternal === undefined ? '' : String(message.isInternal),
        message.debug === undefined ? '' : String(message.debug),
        // Meta flags read directly in render (thought/terminal labels, run state,
        // preformatted render mode).
        meta ? String(meta.label ?? '') : '',
        meta ? String(meta.isRunning ?? '') : '',
        meta ? String(meta.renderMode ?? '') : '',
    ].join('');
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
    const displayClassification = classifyChatMessageForDisplay(message);
    const structuredParts = isStructuredMessagePartArray(message.content) ? message.content : null;
    const hasStructuredRenderer = !!structuredParts?.some((part) => part.type !== 'text');
    const contentStr = stringifyTextContent(message.content, { joiner: '\n' });

    if (displayClassification.isActivityFacing && kind !== 'thought' && kind !== 'tool' && kind !== 'terminal') {
        const label = displayClassification.label || 'Activity';
        return (
            <div className="self-start chat-msg-activity" data-chat-activity-row="true">
                <div className="chat-msg-activity-meta" aria-label="Activity message">
                    <span className="activity-dot" />
                    <span>{label}</span>
                </div>
                {hasStructuredRenderer && structuredParts ? (
                    <div className="chat-msg-activity-body">
                        <MessagePartsRenderer parts={structuredParts} renderAsPreformatted={false} />
                    </div>
                ) : (
                    <div className="chat-msg-activity-body" style={{ whiteSpace: 'pre-wrap' }}>{contentStr}</div>
                )}
            </div>
        );
    }

    if (kind === 'thought') {
        const label = typeof message.meta?.label === 'string' ? message.meta.label : 'Thought';
        return (
            <div className="self-start chat-msg-thought" data-chat-activity-row={displayClassification.isActivityFacing ? 'true' : undefined}>
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
            <div className="self-start chat-msg-tool" data-chat-activity-row={displayClassification.isActivityFacing ? 'true' : undefined}>
                <div className="chat-msg-tool-meta" aria-label="Tool message">
                    <span className="tool-icon">⏺</span>
                    <span className="tool-label">Tool</span>
                </div>
                {hasStructuredRenderer && structuredParts ? (
                    <div className="tool-text w-full">
                        <MessagePartsRenderer parts={structuredParts} renderAsPreformatted={false} />
                    </div>
                ) : (
                    <div className="tool-text w-full" style={{ whiteSpace: 'pre-wrap' }}>{contentStr}</div>
                )}
            </div>
        );
    }

    if (kind === 'terminal') {
        const icon = message.meta?.isRunning ? '⏳' : '✅';
        const label = typeof message.meta?.label === 'string' ? message.meta.label : 'Ran command';
        return (
            <div className="self-start chat-msg-terminal" data-chat-activity-row={displayClassification.isActivityFacing ? 'true' : undefined}>
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
    // User-authored messages render as plain pre-wrap text — never markdown or
    // PTY-style parsing. The user typed it themselves, so `*foo*` should stay
    // literal and intentional newlines must be preserved exactly as written.
    const renderAsMarkdown = !isUser && !renderAsPreformatted && likelyNeedsMarkdownRender(visibleContent);
    const rowClassName = [
        'chat-message-row',
        isUser ? 'chat-message-row-user self-end' : 'chat-message-row-assistant self-start',
    ].join(' ');

    return (
        <div className={rowClassName}>
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
                            ) : (
                                <ChatMarkdownBody
                                    content={visibleContent}
                                    renderAsPreformatted={renderAsPreformatted}
                                    renderAsMarkdown={renderAsMarkdown}
                                />
                            )}
                        </div>
                    )}
                    {showExpandBtn && (
                        <button
                            type="button"
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
    // Field-aware equality: a fresh message object with identical render-driving
    // fields must NOT re-render (and re-parse Markdown). Reference identity is
    // checked first as a cheap fast-path; otherwise fall back to the signature.
    (prev.message === next.message
        || buildChatMessageRowSignature(prev.message) === buildChatMessageRowSignature(next.message))
    && prev.receivedAt === next.receivedAt
    && prev.agentName === next.agentName
    && prev.userName === next.userName
    && prev.isCliMode === next.isCliMode
    && prev.isTextExpanded === next.isTextExpanded
));

// ─── Component ────────────────────────────────

const ChatMessageList = forwardRef<ChatMessageListRef, ChatMessageListProps>(function ChatMessageList(
    { messages, actionLogs, agentName = 'Agent', userName, isCliMode = false, isWorking = false, contextKey = '', receivedAtMap = {}, lastMessageHash, showActivityMessages = false, emptyState, onLoadMore, isLoadingMore, hasMoreHistory, hiddenLiveCount = 0, loadError, scrollToBottomRequestNonce, isVisible = true },
    ref
) {
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
        return mergeChatAndActivityMessages(chatMessages, activityMessages, showActivityMessages);
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
        ? `↑ Show ${Math.min(hiddenLiveCount, 80)} earlier messages${hiddenLiveCount > 80 ? ` (${hiddenLiveCount} hidden)` : ''}`
        : (loadError ? `↻ ${loadError}` : '↑ Load older messages');

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
                    Loading older messages...
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
                        Waiting for messages...
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
                        <span className="text-[11px] text-text-muted ml-1">Agent generating...</span>
                    </div>
                </div>
            )}

            <div className="min-h-10" ref={endRef} />
                </div>
            </div>
            {(jumpButtons.showTop || jumpButtons.showBottom) && (
                <div className="chat-scroll-jump-controls" aria-label="Chat scroll shortcuts">
                    {jumpButtons.showTop && (
                        <button
                            type="button"
                            className="chat-scroll-jump-button"
                            onClick={handleJumpToTop}
                            aria-label="Jump to oldest messages"
                            title="Jump to top"
                        >
                            ↑ Top
                        </button>
                    )}
                    {jumpButtons.showBottom && (
                        <button
                            type="button"
                            className="chat-scroll-jump-button chat-scroll-jump-button-primary"
                            onClick={handleJumpToBottom}
                            aria-label="Jump to latest messages"
                            title="Jump to bottom"
                        >
                            ↓ Latest
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
