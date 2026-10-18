/**
 * chat-injected-row — daemon-typed input, drawn as what it is.
 *
 * A relay is a collapsed card ("Relay · <project> · <outcome>" + a one-line
 * preview) that expands to the coordinator's message without the envelope
 * lines; a one-line project signal, the review prompt and daemon notices are
 * chips. One delivered input holding several of these renders one card / chip
 * each. Card open state lives in the list's expand store (`openSegments`).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconBell, IconBook, IconShuffle } from '../Icons';
import { likelyNeedsMarkdownRender } from './chatMessageHelpers';
import { ChatMarkdownBody } from './chat-row-content';
import { Collapsible, RowMeta } from './chat-row-shell';
import type { ChatRowModel } from './chat-row-model';
import type { InjectedSegment } from './injected-text';
import { summarizeNotice } from './notice-summary';

const CARD_COLLAPSE = { mode: 'local', threshold: 0, previewChars: 0 } as const;

function RelayCard({ segment, timestamp, open, onToggle }: { segment: InjectedSegment; timestamp: number | null; open: boolean; onToggle?: () => void }) {
    const { t } = useTranslation('common');
    const outcome = segment.outcome || '';
    const label = t('chat.relayLabel', {
        project: segment.project || '',
        outcome: t(`chat.relayOutcome.${outcome}`, { defaultValue: outcome }),
    });
    return (
        <div className="chat-relay-card" data-relay-outcome={outcome} data-expanded={open ? 'true' : 'false'}>
            <div className="chat-row-header chat-relay-header">
                <span className="chat-row-icon" aria-hidden="true"><IconShuffle size={12} /></span>
                <span className="chat-relay-label">{label}</span>
                {segment.idle && <span className="chat-relay-badge">{t('chat.relayIdle')}</span>}
                <RowMeta className="chat-bubble-header-end" copyText={segment.body || null} timestamp={timestamp} />
            </div>
            {(segment.reportMissing || segment.reportTruncated) && (
                <div className="chat-relay-note" data-relay-note={segment.reportMissing ? 'missing' : 'truncated'}>
                    {t(segment.reportMissing ? 'chat.relayReportMissing' : 'chat.relayReportTruncated')}
                </div>
            )}
            {open ? (
                <div className="chat-relay-body chat-markdown">
                    <ChatMarkdownBody content={segment.body} renderAsPreformatted={false} renderAsMarkdown={likelyNeedsMarkdownRender(segment.body)} />
                </div>
            ) : (
                segment.preview ? <div className="chat-relay-preview">{segment.preview}</div> : null
            )}
            {segment.body && <Collapsible collapse={CARD_COLLAPSE} className="chat-relay-expand" expanded={open} onToggle={onToggle} />}
        </div>
    );
}

function noticeLabel(segment: InjectedSegment, t: (key: string) => string): string {
    return segment.source === 'signal'
        ? segment.project || ''
        : segment.source === 'review' ? t('chat.reviewLabel') : t('chat.daemonNoticeLabel');
}

/**
 * One daemon notice. Tapping it shows the full original text (a tooltip alone
 * never reached touch screens); copy keeps the original too.
 */
function NoticeChip({ segment, timestamp }: { segment: InjectedSegment; timestamp: number | null }) {
    const { t } = useTranslation('common');
    const [open, setOpen] = useState(false);
    const Icon = segment.source === 'review' ? IconBook : IconBell;
    const summary = summarizeNotice(segment);
    const hasMore = !!segment.body && segment.body !== segment.preview || !!summary;
    return (
        <div className="chat-notice" data-injected-source={segment.source} data-expanded={open ? 'true' : 'false'}>
            <div className="chat-notice-chip" title={segment.body}>
                <button
                    type="button"
                    className="chat-notice-chip-toggle"
                    aria-expanded={open}
                    disabled={!hasMore}
                    onClick={() => setOpen(v => !v)}
                >
                    <span className="chat-row-icon" aria-hidden="true"><Icon size={11} /></span>
                    <span className="chat-notice-chip-label">{noticeLabel(segment, t)}</span>
                    <span className="chat-notice-chip-text">{summary ? t(summary.key, summary.values) : segment.preview}</span>
                </button>
                <RowMeta className="chat-bubble-header-end" copyText={segment.body || null} timestamp={timestamp} />
            </div>
            {open && <div className="chat-notice-detail">{segment.body}</div>}
        </div>
    );
}

/** Two or more notices delivered together fold into one line until opened. */
function NoticeGroup({ segments, timestamp }: { segments: InjectedSegment[]; timestamp: number | null }) {
    const { t } = useTranslation('common');
    const [open, setOpen] = useState(false);
    const first = segments[0]!;
    const summary = summarizeNotice(first);
    if (open) {
        return (
            <div className="chat-notice-group" data-expanded="true">
                <button type="button" className="chat-notice-group-close" aria-expanded onClick={() => setOpen(false)}>
                    {t('chat.noticeGroupCollapse', { count: segments.length })}
                </button>
                {segments.map((segment, index) => <NoticeChip key={index} segment={segment} timestamp={timestamp} />)}
            </div>
        );
    }
    return (
        <div className="chat-notice" data-expanded="false">
            <div className="chat-notice-chip" title={segments.map(s => s.body).join('\n\n')}>
                <button type="button" className="chat-notice-chip-toggle" aria-expanded={false} onClick={() => setOpen(true)}>
                    <span className="chat-row-icon" aria-hidden="true"><IconBell size={11} /></span>
                    <span className="chat-notice-chip-label">{t('chat.noticeGroup', { count: segments.length })}</span>
                    <span className="chat-notice-chip-text">{summary ? t(summary.key, summary.values) : first.preview}</span>
                </button>
                <RowMeta className="chat-bubble-header-end" copyText={segments.map(s => s.body).join('\n\n') || null} timestamp={timestamp} />
            </div>
        </div>
    );
}

const isNoticeSegment = (segment: InjectedSegment) => segment.source !== 'relay' && segment.source !== 'text';

export function InjectedRow({ model, openSegments, onToggleSegment }: { model: ChatRowModel; openSegments: string; onToggleSegment?: (index: number) => void }) {
    const segments = model.injected?.segments ?? [];
    const open = new Set(openSegments ? openSegments.split(',') : []);
    return (
        <div
            className="chat-row chat-row-injected self-stretch chat-msg-injected"
            data-chat-row-kind="injected"
            data-injected-source={model.injected?.source}
        >
            {segments.map((segment, index) => {
                // Consecutive notices: the first of a run renders the whole run.
                if (isNoticeSegment(segment)) {
                    if (index > 0 && isNoticeSegment(segments[index - 1]!)) return null;
                    let end = index;
                    while (end + 1 < segments.length && isNoticeSegment(segments[end + 1]!)) end++;
                    if (end > index) return <NoticeGroup key={`group-${index}`} segments={segments.slice(index, end + 1)} timestamp={model.timestamp} />;
                }
                if (segment.source === 'relay') {
                    return (
                        <RelayCard
                            key={`relay-${index}`}
                            segment={segment}
                            timestamp={model.timestamp}
                            open={open.has(String(index))}
                            onToggle={onToggleSegment ? () => onToggleSegment(index) : undefined}
                        />
                    );
                }
                if (segment.source === 'text') {
                    return <div key={`text-${index}`} className="chat-injected-text" style={{ whiteSpace: 'pre-wrap' }}>{segment.body}</div>;
                }
                return <NoticeChip key={`${segment.source}-${index}`} segment={segment} timestamp={model.timestamp} />;
            })}
        </div>
    );
}
