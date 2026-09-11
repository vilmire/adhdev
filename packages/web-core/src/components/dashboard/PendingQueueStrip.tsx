/**
 * (QUEUE-PINNED-COMPOSER) The waiting bodies, pinned directly above the composer.
 *
 * ★ Why these rows are NOT in the transcript.
 *
 * They were, and the owner's objection was exactly right: "유저가 보낸 메세지는
 * 실제로 해당 부분에 들어간게 아니니까 최하단에 계속 떠있는게 맞을 것 같음. 여타 다른
 * 메신저들처럼." A queued body has not been delivered to the agent — it is parked
 * in `FsmDriver.pendingSends` — so placing it in the message stream asserts a
 * position in a conversation it is not part of yet. Appending it to the tail
 * looked right only while nothing followed it: as soon as the agent emitted
 * anything, the waiting bubble scrolled away and the owner had to hunt upward
 * for the controls that withdraw their own message.
 *
 * Pinning is therefore a correctness fix, not a cosmetic one. The strip lives
 * OUTSIDE the scroll container, between the message list and the composer, so
 * the queue stays in view no matter where the transcript is scrolled and no
 * matter how much the agent says while it works.
 *
 * ★ What still belongs to the transcript. Delivery, not submission, is what puts
 * a message in the conversation: the daemon's echo retires the pending entry and
 * the body appears in the stream as an ordinary user turn. This strip only ever
 * shows bodies that are still waiting.
 *
 * ★ Height. A queue can grow (the store caps it at MAX_PENDING_QUEUED_MESSAGES),
 * and an unbounded strip would eat the transcript it sits above. It scrolls
 * internally past a few rows rather than pushing the composer off screen.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingLocalMessage } from './conversation-message-snapshot';

export interface PendingQueueStripProps {
    /** Every body still waiting, oldest first — the daemon's own drain order. */
    entries: readonly PendingLocalMessage[];
    /** Interrupt the running turn and deliver this body now. */
    onSendNow?: (pendingId?: string) => void;
    /** Withdraw this body from the daemon FIFO. */
    onCancelQueued?: (pendingId: string) => void;
    /** Disables both actions while a send/cancel round trip is open. */
    isSendingNow?: boolean;
}

function PendingQueueStripImpl({
    entries,
    onSendNow,
    onCancelQueued,
    isSendingNow,
}: PendingQueueStripProps) {
    const { t } = useTranslation();

    // Only bodies the daemon confirmed it PARKED. An entry whose send is still
    // in its round trip is shown by the optimistic transcript bubble instead —
    // it may yet turn out to have been delivered outright, and pinning it would
    // claim a wait that is not happening.
    //
    // An entry without an id is skipped rather than rendered action-less: both
    // controls address exactly one FIFO entry by id, and Cancel in particular is
    // destructive, so a row that cannot name its target would be a button that
    // acts on "whatever is current". Only the legacy single-entry prop can
    // produce one, and that path keeps its in-transcript bubble.
    const waiting = entries.filter(entry => entry.queued === true && !!entry.id);
    if (waiting.length === 0) return null;

    return (
        <div
            className="chat-pending-queue-strip"
            data-testid="pending-queue-strip"
            data-pending-queue-count={waiting.length}
            role="region"
            aria-label={t('chat.waitingToSendAria')}
        >
            {waiting.map(entry => (
                <div key={entry.id} className="chat-pending-queue-row" data-chat-queued-row="true">
                    <div className="chat-pending-queue-body" title={entry.content}>
                        {entry.content}
                    </div>
                    <div className="chat-bubble-queued chat-pending-queue-actions">
                        <span className="chat-bubble-queued-label" aria-label={t('chat.waitingToSendAria')}>
                            {t('chat.waitingToSend')}
                        </span>
                        {onSendNow && (
                            <button
                                type="button"
                                onClick={() => onSendNow(entry.id)}
                                disabled={isSendingNow}
                                className="chat-bubble-send-now"
                                aria-label={t('chat.sendNowAria')}
                                // The interrupt DISCARDS the turn in flight, which is
                                // inherent to steering a running agent — stated up
                                // front, exactly as on the in-bubble control.
                                title={t('chat.sendNowTitle')}
                            >
                                {isSendingNow ? t('chat.sending') : t('chat.sendNow')}
                            </button>
                        )}
                        {onCancelQueued && (
                            <button
                                type="button"
                                onClick={() => onCancelQueued(entry.id)}
                                disabled={isSendingNow}
                                className="chat-bubble-cancel-queued"
                                aria-label={t('chat.cancelQueuedAria')}
                                title={t('chat.cancelQueuedTitle')}
                            >
                                {t('chat.cancelQueued')}
                            </button>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}

/**
 * Memoised on the fields the strip actually renders. The pane hands down a new
 * array identity on every tail tick, so a reference check would re-render this
 * (and re-run the filter) on every status update while nothing visible changed.
 */
export const PendingQueueStrip = memo(PendingQueueStripImpl, (prev, next) => (
    prev.onSendNow === next.onSendNow
    && prev.onCancelQueued === next.onCancelQueued
    && prev.isSendingNow === next.isSendingNow
    && prev.entries.length === next.entries.length
    && prev.entries.every((entry, index) => {
        const other = next.entries[index];
        return !!other
            && entry.id === other.id
            && entry.content === other.content
            && entry.queued === other.queued;
    })
));

export default PendingQueueStrip;
