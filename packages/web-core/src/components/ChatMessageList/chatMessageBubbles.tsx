/**
 * chatMessageBubbles — presentational bubble/row renderers for ChatMessageList.
 *
 * Extracted verbatim from ChatMessageList.tsx (survey C9 3/3). Render output,
 * memo comparators, class names, and markdown-render decisions are preserved
 * exactly. No logic change, no optimization, no bug fix.
 */

import { memo, useState, useCallback, isValidElement } from 'react';
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkAlert from 'remark-github-blockquote-alert';
import remarkBreaks from 'remark-breaks';
import { buildChatMessageSignature } from '@adhdev/daemon-core/chat/chat-signatures';
import type { Pluggable, PluggableList } from 'unified';
import { IconThought, IconClipboard, IconCheck, IconSpinner } from '../Icons';
import { stringifyTextContent } from '../../utils/text';
import { classifyChatMessageForDisplay } from '../dashboard/chat-activity-visibility';
import type { ChatMessage } from '../../types';
import {
    formatTime,
    likelyNeedsMarkdownRender,
    getResourceDisplayName,
    buildMediaSrc,
    isStructuredMessagePartArray,
    safeResourceHref,
    type ActionLog,
    type MessageMeta,
    type StructuredMessagePart,
} from './chatMessageHelpers';

// System bubbles (git errors, status lines, long file paths) truncate at this
// length before the "show more" toggle kicks in. 100 chars is roughly one
// terminal line of context — enough to identify the message at a glance
// without the system-message row dominating the chat column (G8).
const SYSTEM_BUBBLE_TRUNCATE_LENGTH = 100;

function CopyButton({ text }: { text: string }) {
    const { t } = useTranslation('common');
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        // The checkmark previously showed unconditionally even when the write
        // rejected (denied clipboard permission, insecure context) — telling the
        // user their copy worked when nothing was on their clipboard.
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    }, [text]);
    return (
        <button
            type="button"
            onClick={handleCopy}
            aria-label={t('chat.copyMessage')}
            className="chat-copy-btn"
        >
            {copied ? <IconCheck size={11} /> : <IconClipboard size={11} />}
        </button>
    );
}

function CodeBlockCopyButton({ text }: { text: string }) {
    const { t } = useTranslation('common');
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback((event: ReactMouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    }, [text]);
    return (
        <button
            type="button"
            onClick={handleCopy}
            aria-label={t('chat.copyCode')}
            title={t('chat.copyCode')}
            className="chat-code-copy-btn"
        >
            {copied ? <IconCheck size={12} /> : <IconClipboard size={12} />}
        </button>
    );
}

/**
 * G8-8: `pre` override for ReactMarkdown fenced code blocks — adds the
 * hover-revealed copy button. `children` is the `<code>` element ReactMarkdown
 * already produced; its text is extracted for the clipboard write rather than
 * re-stringifying `props` (which would lose the exact rendered text).
 */
function ChatCodeBlock(props: ComponentPropsWithoutRef<'pre'>) {
    const codeText = extractPlainTextFromReactNode(props.children);
    return (
        <pre {...props}>
            {props.children}
            <CodeBlockCopyButton text={codeText} />
        </pre>
    );
}

function extractPlainTextFromReactNode(node: ReactNode): string {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractPlainTextFromReactNode).join('');
    if (isValidElement(node)) {
        const children = (node.props as { children?: ReactNode } | undefined)?.children;
        return extractPlainTextFromReactNode(children);
    }
    return '';
}

const chatMarkdownComponents = { pre: ChatCodeBlock };

const gfmRemarkPlugin: Pluggable = [remarkGfm, { singleTilde: false }];
const chatRemarkPlugins: PluggableList = [gfmRemarkPlugin, remarkAlert, remarkBreaks];
const actionLogRemarkPlugins: PluggableList = [gfmRemarkPlugin];

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
            <ReactMarkdown remarkPlugins={chatRemarkPlugins} components={chatMarkdownComponents}>
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
            <ReactMarkdown remarkPlugins={chatRemarkPlugins} components={chatMarkdownComponents}>
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
                    const href = safeResourceHref(part.uri);
                    return (
                        <div key={`resource-link-${index}`} className="flex flex-col gap-1">
                            {href ? (
                                <a href={href} target="_blank" rel="noreferrer" download className="underline break-all">
                                    {label}
                                </a>
                            ) : (
                                renderStructuredPlaceholder('Resource', label, detail)
                            )}
                            {href && detail ? <div className="text-sm opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{detail}</div> : null}
                        </div>
                    );
                }

                if (part.type === 'resource' && part.resource) {
                    const label = getResourceDisplayName(part.resource.uri, 'resource');
                    if (part.resource.text) {
                        return (
                            <div key={`resource-${index}`} className="rounded-md border border-border-subtle p-2">
                                <div className="text-2xs opacity-70 mb-1">{label}</div>
                                {renderTextLikeContent(part.resource.text, true)}
                            </div>
                        );
                    }
                    const resourceHref = safeResourceHref(part.resource.uri);
                    if (resourceHref) {
                        return (
                            <a key={`resource-uri-${index}`} href={resourceHref} target="_blank" rel="noreferrer" className="underline break-all">
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

export const ActionLogRow = memo(function ActionLogRow({ log }: { log: ActionLog }) {
    return (
        <div className="self-center chat-msg-action">
            <ReactMarkdown remarkPlugins={actionLogRemarkPlugins}>{log.text}</ReactMarkdown>
            <span className="action-time">{formatTime(log.timestamp)}</span>
        </div>
    );
}, (prev, next) => (
    prev.log === next.log
));

export interface ChatMessageRowProps {
    message: ChatMessage;
    receivedAt?: number;
    agentName: string;
    userName?: string;
    isCliMode: boolean;
    isTextExpanded: boolean;
    onToggleTextExpanded: () => void;
    /**
     * SEND-NOW: interrupt the agent's current turn so this queued body is
     * delivered as a real turn. Optional — read-only viewers (SessionShare)
     * pass nothing and the affordance simply does not render.
     *
     * Receives the row's own pending id so a MULTI-QUEUE pane acts on the
     * bubble that was actually pressed, not on whichever entry the hook
     * happens to consider current.
     */
    onSendNow?: (pendingId?: string) => void;
    /** True while a send-now request for this row is in flight. */
    isSendingNow?: boolean;
    /**
     * (QUEUED-SEND-CANCEL) Withdraw this still-waiting body. Optional for the
     * same read-only reason as `onSendNow`.
     */
    onCancelQueued?: (pendingId: string) => void;
}

/** The per-entry id `withPendingLocalMessages` stamps onto a pending bubble. */
function getPendingId(message: ChatMessage): string {
    const meta = message.meta as (Record<string, unknown> | undefined);
    const value = meta?.pendingId;
    return typeof value === 'string' ? value : '';
}

/**
 * Whether this row is the optimistic local bubble that the daemon has ACCEPTED
 * but not yet written to the PTY (`{status:'queued'}`). Written by
 * withPendingLocalMessage; see conversation-message-snapshot.ts.
 */
function isQueuedPendingLocal(message: ChatMessage): boolean {
    const meta = message.meta as (Record<string, unknown> | undefined);
    return meta?.pendingLocal === true && meta?.queued === true;
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
/**
 * Signature cache keyed by message object identity.
 *
 * Every input to `buildChatMessageRowSignature` is read off the message object
 * itself, and transcript messages are immutable snapshots — the pipeline
 * replaces a message with a NEW object whenever any field changes (including
 * `meta.pendingLocal` / `meta.queued`, which `withPendingLocalMessage` applies
 * as a render-time overlay producing a fresh object). So object identity fully
 * determines the signature, and caching on it cannot go stale: a changed field
 * arrives as a different key.
 *
 * Why this matters: the `ChatMessageRow` memo comparator below runs for EVERY
 * row on EVERY tick and hashed BOTH `prev` and `next` — and the hash walks the
 * whole `JSON.stringify(content)` (chat-signatures FNV-1a). With N rows that is
 * O(2N) full-content hashes per tick; each message object now hashes once and
 * is reused across every subsequent comparison it participates in.
 *
 * WeakMap (not Map) so evicted/scrolled-off messages are garbage collected with
 * no eviction bookkeeping.
 */
const rowSignatureCache = new WeakMap<ChatMessage, string>();

export function buildChatMessageRowSignature(message: ChatMessage): string {
    const cached = rowSignatureCache.get(message);
    if (cached !== undefined) return cached;
    const signature = computeChatMessageRowSignature(message);
    rowSignatureCache.set(message, signature);
    return signature;
}

function computeChatMessageRowSignature(message: ChatMessage): string {
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
        // SEND-NOW: the optimistic bubble flips `queued` false→true on the SAME
        // content and sentAt, so without these the signature is identical and the
        // memo suppresses the re-render — the queued badge and its Send now
        // button would never appear.
        meta ? String(meta.pendingLocal ?? '') : '',
        meta ? String(meta.queued ?? '') : '',
        // MULTI-QUEUE: two entries can carry identical content and timestamps
        // (the same text queued twice). Without the id in the signature their
        // rows hash identically and the memo would render one for both.
        meta ? String(meta.pendingId ?? '') : '',
    ].join('');
}

export const ChatMessageRow = memo(function ChatMessageRow({
    message,
    receivedAt,
    agentName,
    userName,
    isCliMode: _isCliMode,
    isTextExpanded,
    onToggleTextExpanded,
    onSendNow,
    isSendingNow,
    onCancelQueued,
}: ChatMessageRowProps) {
    const { t } = useTranslation('common');
    const isQueued = isQueuedPendingLocal(message);
    const pendingId = getPendingId(message);
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
        const label = typeof message.meta?.label === 'string' ? message.meta.label : t('chat.thought');
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
                    <span className="tool-icon" aria-hidden="true" />
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
        const label = typeof message.meta?.label === 'string' ? message.meta.label : 'Ran command';
        return (
            <div className="self-start chat-msg-terminal" data-chat-activity-row={displayClassification.isActivityFacing ? 'true' : undefined}>
                <div className="chat-msg-header">
                    <span>{message.meta?.isRunning ? <IconSpinner size={12} /> : <IconCheck size={12} />}</span>
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
        // G8-9: system bubbles were hard-cut at 100 chars with no way to see the
        // rest — a truncated audit/status line (e.g. a git error, a long file
        // path) was simply lost. `title=` surfaces the full text on hover, and
        // reusing the row's existing isTextExpanded/onToggleTextExpanded (already
        // threaded in for the standard-bubble expand toggle) lets it expand in
        // place, consistent with how a long assistant/user bubble expands.
        const isTruncated = contentStr.length > SYSTEM_BUBBLE_TRUNCATE_LENGTH;
        const systemText = isTextExpanded || !isTruncated ? contentStr : `${contentStr.slice(0, SYSTEM_BUBBLE_TRUNCATE_LENGTH)}…`;
        return (
            <div className="self-center chat-msg-system" title={contentStr}>
                {hasStructuredRenderer && structuredParts ? (
                    <MessagePartsRenderer parts={structuredParts} renderAsPreformatted={false} />
                ) : (
                    <>
                        {systemText}
                        {isTruncated && onToggleTextExpanded && (
                            <button
                                type="button"
                                onClick={onToggleTextExpanded}
                                className="chat-msg-system-expand ml-1.5 text-3xs font-semibold underline opacity-70 hover:opacity-100"
                            >
                                {isTextExpanded ? t('chat.showLess') : t('chat.showMore')}
                            </button>
                        )}
                    </>
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
                        <span className="chat-bubble-header-end">
                            {(displayContent || hasStructuredRenderer) && (
                                <CopyButton text={contentStr} />
                            )}
                            {receivedAt != null && (
                                <span className="chat-time">{formatTime(receivedAt)}</span>
                            )}
                        </span>
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
                            className="mt-1.5 text-2xs font-semibold text-[var(--accent-primary)] p-0 opacity-80"
                        >
                            {isTextExpanded ? 'Collapse ↑' : `Show more (${Math.round(displayContent.length / 100) * 100} chars) ↓`}
                        </button>
                    )}
                    {/* SEND-NOW: the queued state and its escape hatch live INSIDE
                        the bubble, so every layout that renders chat bubbles
                        (desktop dockview, mobile panes, mobile chat room, remote
                        dialog, standalone and cloud) gets them from this one
                        place. `onSendNow` is optional so the read-only share
                        viewer renders the badge-free bubble unchanged. */}
                    {isQueued && (
                        <div className="chat-bubble-queued" data-chat-queued-row="true">
                            <span className="chat-bubble-queued-label" aria-label={t('chat.waitingToSendAria')}>
                                {t('chat.waitingToSend')}
                            </span>
                            {onSendNow && (
                                <button
                                    type="button"
                                    onClick={() => onSendNow(pendingId || undefined)}
                                    disabled={isSendingNow}
                                    className="chat-bubble-send-now"
                                    aria-label={t('chat.sendNowAria')}
                                    // The interrupt DISCARDS the turn in flight — that is
                                    // inherent to steering a running agent, not a defect,
                                    // so it is stated up front rather than after the fact.
                                    title={t('chat.sendNowTitle')}
                                >
                                    {isSendingNow ? t('chat.sending') : t('chat.sendNow')}
                                </button>
                            )}
                            {/* QUEUED-SEND-CANCEL: the owner queued this body and changed
                                their mind before the agent ever saw it. Requires a
                                pendingId — cancelling is destructive and must address
                                exactly one entry, never "whatever is current". */}
                            {onCancelQueued && pendingId && (
                                <button
                                    type="button"
                                    onClick={() => onCancelQueued(pendingId)}
                                    disabled={isSendingNow}
                                    className="chat-bubble-cancel-queued"
                                    aria-label={t('chat.cancelQueuedAria')}
                                    title={t('chat.cancelQueuedTitle')}
                                >
                                    {t('chat.cancelQueued')}
                                </button>
                            )}
                        </div>
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
    // SEND-NOW: the button's disabled/label state and its handler identity must
    // reach the row, or pressing it would call a stale closure.
    && prev.isSendingNow === next.isSendingNow
    && prev.onSendNow === next.onSendNow
    // QUEUED-SEND-CANCEL: same stale-closure hazard as onSendNow — a cancel
    // wired to a previous render's handler would address the wrong queue.
    && prev.onCancelQueued === next.onCancelQueued
));
