/**
 * chat-row-content — the body renderers every chat row shares: the one copy
 * button, the one markdown renderer, and structured message parts.
 *
 * There is exactly one markdown path (`ChatMarkdownBody`, one remark plugin
 * set) — message bodies, text parts, embedded text resources and action-log
 * lines all go through it, so a fenced block gets the same copy button and a
 * `~` range renders the same way everywhere.
 */

import { memo, useState, useCallback, isValidElement } from 'react';
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkAlert from 'remark-github-blockquote-alert';
import remarkBreaks from 'remark-breaks';
import type { Pluggable, PluggableList } from 'unified';
import { IconClipboard, IconCheck } from '../Icons';
import {
    likelyNeedsMarkdownRender,
    getResourceDisplayName,
    buildMediaSrc,
    safeResourceHref,
    type StructuredMessagePart,
} from './chatMessageHelpers';
import type { RowBody } from './chat-row-model';

/**
 * One copy control. `size:'sm'` is the row-header control; `size:'code'` sits
 * on a fenced code block (it must not toggle a surrounding control, hence the
 * preventDefault/stopPropagation, and it keeps its own class for the
 * hover-reveal rule on `pre`).
 */
export function CopyButton({ text, size = 'sm' }: { text: string; size?: 'sm' | 'code' }) {
    const { t } = useTranslation('common');
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback((event: ReactMouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        // The checkmark previously showed unconditionally even when the write
        // rejected (denied clipboard permission, insecure context) — telling the
        // user their copy worked when nothing was on their clipboard.
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    }, [text]);
    const isCode = size === 'code';
    const label = isCode ? t('chat.copyCode') : t('chat.copyMessage');
    const iconSize = isCode ? 12 : 11;
    return (
        <button
            type="button"
            onClick={handleCopy}
            aria-label={label}
            title={isCode ? label : undefined}
            className={isCode ? 'chat-code-copy-btn' : 'chat-copy-btn'}
        >
            {copied ? <IconCheck size={iconSize} /> : <IconClipboard size={iconSize} />}
        </button>
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

/**
 * G8-8: `pre` override for fenced code blocks — adds the hover-revealed copy
 * button. The text is extracted from the `<code>` element ReactMarkdown already
 * produced, so the clipboard gets exactly the rendered text.
 */
function ChatCodeBlock(props: ComponentPropsWithoutRef<'pre'>) {
    const codeText = extractPlainTextFromReactNode(props.children);
    return (
        <pre {...props}>
            {props.children}
            <CopyButton text={codeText} size="code" />
        </pre>
    );
}

const chatMarkdownComponents = { pre: ChatCodeBlock };
// `singleTilde:false` keeps numeric ranges (`4~11%`) literal instead of strikethrough.
const gfmRemarkPlugin: Pluggable = [remarkGfm, { singleTilde: false }];
const chatRemarkPlugins: PluggableList = [gfmRemarkPlugin, remarkAlert, remarkBreaks];

/**
 * Content-keyed text body. ReactMarkdown re-parses on every render and the list
 * re-renders on every tail tick; keying the memo on the raw string (plus the
 * mode flags) lets unchanged text skip the parse while the streaming message
 * still updates.
 */
export const ChatMarkdownBody = memo(function ChatMarkdownBody({
    content,
    renderAsPreformatted,
    renderAsMarkdown,
}: {
    content: string;
    renderAsPreformatted: boolean;
    renderAsMarkdown: boolean;
}) {
    if (renderAsPreformatted) return <pre className="chat-preformatted">{content}</pre>;
    if (renderAsMarkdown) {
        return (
            <ReactMarkdown remarkPlugins={chatRemarkPlugins} components={chatMarkdownComponents}>
                {content}
            </ReactMarkdown>
        );
    }
    return <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>;
});

/** Free text of unknown shape (a text part, an embedded resource). */
function TextContent({ text, preformatted }: { text: string; preformatted: boolean }) {
    if (!text) return null;
    return <ChatMarkdownBody content={text} renderAsPreformatted={preformatted} renderAsMarkdown={!preformatted && likelyNeedsMarkdownRender(text)} />;
}

function StructuredPlaceholder({ kind, label, detail }: { kind: string; label: string; detail?: string }) {
    return (
        <div className="rounded-md border border-border-subtle p-2 text-sm" role="note">
            <span className="font-medium">{kind}</span>
            {label ? <span className="ml-1 break-all">{label}</span> : null}
            {detail ? <div className="mt-1 opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{detail}</div> : null}
        </div>
    );
}

function MessagePart({ part, preformatted }: { part: StructuredMessagePart; preformatted: boolean }) {
    if (part.type === 'text') {
        return <div><TextContent text={String(part.text || '')} preformatted={preformatted} /></div>;
    }
    if (part.type === 'image') {
        const src = buildMediaSrc(part);
        const alt = part.alt || part.description || getResourceDisplayName(part.uri, 'image');
        if (!src) return <div><StructuredPlaceholder kind="Image" label={alt} detail={part.mimeType} /></div>;
        return <img src={src} alt={alt} className="max-w-full rounded-md border border-border-subtle" />;
    }
    if (part.type === 'audio') {
        const src = buildMediaSrc(part);
        return src ? (
            <div className="flex flex-col gap-1">
                <audio controls src={src} className="max-w-full" />
                {part.transcript ? <div className="text-sm opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{part.transcript}</div> : null}
            </div>
        ) : <div><StructuredPlaceholder kind="Audio" label={getResourceDisplayName(part.uri, 'audio')} detail={part.transcript || part.mimeType} /></div>;
    }
    if (part.type === 'video') {
        const src = buildMediaSrc(part);
        const label = part.title || part.name || part.alt || getResourceDisplayName(part.uri, 'video');
        const detail = [part.transcript, part.description, part.mimeType].filter(Boolean).join('\n');
        return (
            <div className="flex flex-col gap-1">
                {src ? (
                    <video controls src={src} poster={part.posterUri} className="max-w-full rounded-md border border-border-subtle" />
                ) : (
                    <StructuredPlaceholder kind="Video" label={label} detail={detail} />
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
            <div className="flex flex-col gap-1">
                {href ? (
                    <a href={href} target="_blank" rel="noreferrer" download className="underline break-all">{label}</a>
                ) : (
                    <StructuredPlaceholder kind="Resource" label={label} detail={detail} />
                )}
                {href && detail ? <div className="text-sm opacity-80" style={{ whiteSpace: 'pre-wrap' }}>{detail}</div> : null}
            </div>
        );
    }
    if (part.type === 'resource' && part.resource) {
        const label = getResourceDisplayName(part.resource.uri, 'resource');
        if (part.resource.text) {
            return (
                <div className="rounded-md border border-border-subtle p-2">
                    <div className="text-2xs opacity-70 mb-1">{label}</div>
                    <TextContent text={part.resource.text} preformatted={true} />
                </div>
            );
        }
        const resourceHref = safeResourceHref(part.resource.uri);
        if (resourceHref) {
            return <a href={resourceHref} target="_blank" rel="noreferrer" className="underline break-all">{label}</a>;
        }
    }
    return null;
}

export function MessagePartsRenderer({ parts, renderAsPreformatted }: { parts: StructuredMessagePart[]; renderAsPreformatted: boolean }) {
    return (
        <div className="flex flex-col gap-2">
            {parts.map((part, index) => <MessagePart key={`${part.type}-${index}`} part={part} preformatted={renderAsPreformatted} />)}
        </div>
    );
}

/**
 * A row body. `className` is the kind's existing body class (`chat-markdown`,
 * `tool-text w-full`, `chat-msg-body`, …); `null` renders the content with no
 * wrapper (the inline system row). `text` overrides the body text when the row
 * is folded or replaced by a fetched expansion.
 */
export function RowBodyView({ body, className, text, asPre }: { body: RowBody; className: string | null; text?: string; asPre?: boolean }) {
    if (body.type === 'parts') {
        const inner = <MessagePartsRenderer parts={body.parts} renderAsPreformatted={body.preformatted} />;
        return className === null ? inner : <div className={className}>{inner}</div>;
    }
    const content = text ?? body.text;
    if (className === null) return <>{content}</>;
    if (asPre && body.type === 'pre') return <pre className={className}>{content}</pre>;
    if (body.type === 'plain') return <div className={className} style={{ whiteSpace: 'pre-wrap' }}>{content}</div>;
    return (
        <div className={className}>
            <ChatMarkdownBody content={content} renderAsPreformatted={body.type === 'pre'} renderAsMarkdown={body.type === 'markdown'} />
        </div>
    );
}
