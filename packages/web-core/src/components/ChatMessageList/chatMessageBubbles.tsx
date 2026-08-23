/**
 * chatMessageBubbles — presentational bubble/row renderers for ChatMessageList.
 *
 * Extracted verbatim from ChatMessageList.tsx (survey C9 3/3). Render output,
 * memo comparators, class names, and markdown-render decisions are preserved
 * exactly. No logic change, no optimization, no bug fix.
 */

import { memo, useState, useCallback } from 'react';
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
    type ActionLog,
    type MessageMeta,
    type StructuredMessagePart,
} from './chatMessageHelpers';

function CopyButton({ text }: { text: string }) {
    const { t } = useTranslation('common');
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
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
                                <div className="text-2xs opacity-70 mb-1">{label}</div>
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
