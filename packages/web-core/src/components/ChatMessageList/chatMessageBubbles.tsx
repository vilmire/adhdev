/**
 * chatMessageBubbles — the chat row component and the action-log row.
 *
 * `ChatMessageRow` renders a `ChatRowModel` (chat-row-model.ts) — it does not
 * classify. The list resolves the model once per message and passes it as
 * `row`; a row rendered on its own (tests, embeds) resolves it from `message`
 * through the same function. Layout lives in chat-row-shell.tsx, body renderers
 * in chat-row-content.tsx, injected input in chat-injected-row.tsx.
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../types';
import { formatTime, type ActionLog, type ToolExpandAddress } from './chatMessageHelpers';
import { ChatMarkdownBody } from './chat-row-content';
import { ChatRowShell } from './chat-row-shell';
import { InjectedRow } from './chat-injected-row';
import { resolveChatRow, type ChatRowModel } from './chat-row-model';
import type { ToolExpandState } from './chat-row-expansion';

export { isMeshInjectedSystemText } from './injected-text';
export type { ToolExpandFailureReason, ToolExpandState } from './chat-row-expansion';

export const ActionLogRow = memo(function ActionLogRow({ log }: { log: ActionLog }) {
    return (
        <div className="self-center chat-msg-action">
            <ChatMarkdownBody content={log.text} renderAsPreformatted={false} renderAsMarkdown={true} />
            <span className="action-time">{formatTime(log.timestamp)}</span>
        </div>
    );
}, (prev, next) => (
    prev.log === next.log
));

export interface ChatMessageRowProps {
    message: ChatMessage;
    /** The resolved row. The list always passes it; absent → resolved here. */
    row?: ChatRowModel;
    receivedAt?: number;
    agentName: string;
    userName?: string;
    isCliMode: boolean;
    isTextExpanded: boolean;
    onToggleTextExpanded: () => void;
    /**
     * SEND-NOW: deliver this queued body now. Optional — read-only viewers
     * (SessionShare) pass nothing and the affordance does not render. Receives
     * the row's own pending id so a MULTI-QUEUE pane acts on the pressed bubble.
     */
    onSendNow?: (pendingId?: string) => void;
    /** True while a send-now request for this row is in flight. */
    isSendingNow?: boolean;
    /** (QUEUED-SEND-CANCEL) Withdraw this still-waiting body. */
    onCancelQueued?: (pendingId: string) => void;
    /** (TOOL-EXPAND) Fetch the untruncated body; absent → no expand affordance. */
    onExpandToolBlock?: (address: ToolExpandAddress) => void;
    /** Collapse back to the summary. */
    onCollapseToolBlock?: () => void;
    /** This row's fetched-expansion state. */
    toolExpand?: ToolExpandState;
    /** Open relay-card indices, comma-joined (one card per relay in a delivery). */
    openSegments?: string;
    onToggleSegment?: (index: number) => void;
}

function rowOf(props: ChatMessageRowProps): ChatRowModel {
    return props.row ?? resolveChatRow(props.message, {
        agentName: props.agentName,
        userName: props.userName,
        receivedAt: props.receivedAt ?? null,
    });
}

/**
 * Stable render-signature for a chat message, as a standalone row would render
 * it. Derived from the row model (`ChatRowModel.signature`), so it covers
 * exactly what renders. Cached by message identity inside `resolveChatRow`.
 */
export function buildChatMessageRowSignature(message: ChatMessage): string {
    return resolveChatRow(message).signature;
}

/**
 * SEND-NOW: the queued state and its escape hatch live INSIDE the bubble, so
 * every layout that renders chat bubbles gets them from this one place.
 */
function QueuedStrip({ pendingId, onSendNow, isSendingNow, onCancelQueued }: {
    pendingId: string;
    onSendNow?: (pendingId?: string) => void;
    isSendingNow?: boolean;
    onCancelQueued?: (pendingId: string) => void;
}) {
    const { t } = useTranslation('common');
    return (
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
                    // SEND-NOW-AGENT-QUEUE: the body goes into the AGENT's own
                    // input queue and the turn in flight keeps running — said
                    // up front so the owner is not left guessing.
                    title={t('chat.sendNowTitle')}
                >
                    {isSendingNow ? t('chat.sending') : t('chat.sendNow')}
                </button>
            )}
            {/* QUEUED-SEND-CANCEL: requires a pendingId — cancelling is
                destructive and must address exactly one entry. */}
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
    );
}

export const ChatMessageRow = memo(function ChatMessageRow(props: ChatMessageRowProps) {
    const row = rowOf(props);
    const { isTextExpanded, onToggleTextExpanded, onSendNow, isSendingNow, onCancelQueued, onExpandToolBlock, onCollapseToolBlock, toolExpand } = props;

    if (row.kind === 'injected') {
        return <InjectedRow model={row} openSegments={props.openSegments ?? ''} onToggleSegment={props.onToggleSegment} />;
    }
    const queued = row.status?.queued;
    return (
        <ChatRowShell
            model={row}
            expanded={isTextExpanded}
            onToggle={onToggleTextExpanded}
            remoteState={toolExpand}
            onExpandRemote={onExpandToolBlock}
            onCollapseRemote={onCollapseToolBlock}
        >
            {queued && (
                <QueuedStrip pendingId={queued.pendingId} onSendNow={onSendNow} isSendingNow={isSendingNow} onCancelQueued={onCancelQueued} />
            )}
        </ChatRowShell>
    );
}, (prev, next) => (
    // Field-aware equality: a fresh message object with identical render-driving
    // fields must NOT re-render (and re-parse Markdown). The model signature
    // covers every field the row reads from the message.
    (prev.message === next.message && prev.row === next.row
        || rowOf(prev).signature === rowOf(next).signature)
    && prev.receivedAt === next.receivedAt
    && prev.agentName === next.agentName
    && prev.userName === next.userName
    && prev.isCliMode === next.isCliMode
    && prev.isTextExpanded === next.isTextExpanded
    && prev.openSegments === next.openSegments
    // SEND-NOW / QUEUED-SEND-CANCEL: disabled/label state and handler identity
    // must reach the row, or a press calls a stale closure over queue state.
    && prev.isSendingNow === next.isSendingNow
    && prev.onSendNow === next.onSendNow
    && prev.onCancelQueued === next.onCancelQueued
    // TOOL-EXPAND: the expansion STATE drives what renders. The per-row
    // handlers are fresh closures each list render that only capture this
    // row's own key, so a "stale" one still addresses the right row — they are
    // deliberately not compared (doing so would defeat memoization).
    && prev.toolExpand === next.toolExpand
));
