/**
 * chat-injected-row — daemon-typed input, drawn as what it is.
 *
 * A relay is a collapsed card ("Relay · <project> · <outcome>" + a one-line
 * preview) that expands to the coordinator's message without the envelope
 * lines; a one-line project signal, the review prompt and daemon notices are
 * chips. One delivered input holding several of these renders one card / chip
 * each. Card open state lives in the list's expand store (`openSegments`).
 */

import { useTranslation } from 'react-i18next';
import { IconBell, IconBook, IconShuffle } from '../Icons';
import { likelyNeedsMarkdownRender } from './chatMessageHelpers';
import { ChatMarkdownBody } from './chat-row-content';
import { Collapsible, RowMeta } from './chat-row-shell';
import type { ChatRowModel } from './chat-row-model';
import type { InjectedSegment } from './injected-text';

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

function NoticeChip({ segment, timestamp }: { segment: InjectedSegment; timestamp: number | null }) {
    const { t } = useTranslation('common');
    const label = segment.source === 'signal'
        ? segment.project || ''
        : segment.source === 'review' ? t('chat.reviewLabel') : t('chat.daemonNoticeLabel');
    const Icon = segment.source === 'review' ? IconBook : IconBell;
    return (
        <div className="chat-notice-chip" data-injected-source={segment.source} title={segment.body}>
            <span className="chat-row-icon" aria-hidden="true"><Icon size={11} /></span>
            <span className="chat-notice-chip-label">{label}</span>
            <span className="chat-notice-chip-text">{segment.preview}</span>
            <RowMeta className="chat-bubble-header-end" copyText={segment.body || null} timestamp={timestamp} />
        </div>
    );
}

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
