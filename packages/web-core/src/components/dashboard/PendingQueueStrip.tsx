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
 *
 * ★ Why it LOOKS like a chat bubble (QUEUE-BUBBLE-LOOK).
 *
 * The first version of this strip stated its case in full: a bordered card per
 * row, the sentence "Waiting to send — the agent is still working", and a Send
 * now / Cancel button pair. On a phone that reads as a management panel bolted
 * onto the conversation — the owner's words for it were that it should look like
 * other messengers, and it did not.
 *
 * So the POSITION above is unchanged (it is the correctness property) and only
 * the presentation moved: each waiting body is a right-aligned user bubble in
 * the same `.chat-bubble-user` skin the transcript uses, marked as undelivered
 * by a small clock glyph and reduced opacity rather than a sentence. What the
 * owner sees is their own message, sitting where they sent it, visibly not gone
 * yet — which is what a messenger shows and what the sentence was only
 * describing.
 *
 * Send now first left with the sentence, then came back (QUEUE-SEND-NOW-
 * RESTORED): the owner noticed it missing from the live product and asked for
 * it, specifically NOT as the old button-pile — as a small icon that pairs
 * with cancel the same way a messenger's own affordances stay out of the way
 * until touched. It is an ↑ glyph, same 28px hit target and hover treatment
 * as `.chat-pending-queue-cancel`, sitting right next to it. The
 * interrupt-and-discard behaviour is unchanged; only its permanent-sentence
 * presentation was ever the objection.
 */
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingLocalMessage } from './conversation-message-snapshot';

export interface PendingQueueStripProps {
    /** Every body still waiting, oldest first — the daemon's own drain order. */
    entries: readonly PendingLocalMessage[];
    /**
     * Interrupt the running turn and deliver this body now.
     *
     * ★ (QUEUE-SEND-NOW-RESTORED) Rendered as a small icon beside cancel —
     * see the file header. Optional so a read-only viewer that never wires it
     * renders the row without the affordance.
     */
    onSendNow?: (pendingId?: string) => void;
    /** Withdraw this body from the daemon FIFO. */
    onCancelQueued?: (pendingId: string) => void;
    /** Disables the cancel affordance while a send/cancel round trip is open. */
    isSendingNow?: boolean;
}

function PendingQueueStripImpl({
    entries,
    onSendNow,
    onCancelQueued,
    isSendingNow,
}: PendingQueueStripProps) {
    const { t } = useTranslation();
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

    // Show parked bodies and unresolved native submissions. Explicit uncertainty
    // prevents this placement from claiming the body is still in the FIFO.
    //
    // An entry without an id is skipped rather than rendered action-less: both
    // controls address exactly one FIFO entry by id, and Cancel in particular is
    // destructive, so a row that cannot name its target would be a button that
    // acts on "whatever is current". Only the legacy single-entry prop can
    // produce one, and that path keeps its in-transcript bubble.
    const waiting = entries.filter(entry => (entry.queued === true || entry.deliveryUncertain === true) && !!entry.id && !(entry.deliveryUncertain && entry.outgoingReceipt?.state !== 'failed' && dismissed.has(entry.id)));
    if (waiting.length === 0) return null;

    // The region's own label must not out-live the claim its rows are making: a
    // strip holding nothing but undelivered bodies announced as "Waiting to send"
    // would tell a screen-reader user the exact thing this change exists to stop
    // saying. Any still-waiting row keeps the waiting label, since that is then
    // true of the region as a whole.
    const hasLiveWait = waiting.some(entry => entry.stale !== true && !entry.deliveryUncertain);
    const regionLabel = hasLiveWait ? t('chat.waitingToSendAria') : waiting.some(entry => entry.deliveryUncertain && entry.outgoingReceipt?.state !== 'failed') ? t('chat.deliveryUncertain') : t('chat.notDeliveredAria');

    return (
        <div
            className="chat-pending-queue-strip"
            data-testid="pending-queue-strip"
            data-pending-queue-count={waiting.length}
            role="region"
            aria-label={regionLabel}
        >
            {waiting.map(entry => (
                <div
                    key={entry.id}
                    className="chat-pending-queue-row"
                    data-chat-queued-row="true"
                    // ★ (QUEUED-SEND-STUCK-FOREVER) Marks a body that has waited past
                    // the window in which "waiting to send" is still a true statement.
                    // See the marker below for what changes when it is set.
                    data-chat-delivery-uncertain={entry.deliveryUncertain ? 'true' : undefined}
                    data-chat-queued-stale={entry.stale === true ? 'true' : undefined}
                >
                    {/* `.chat-bubble` + `.chat-bubble-user` is the transcript's own
                        user skin, reused verbatim so a theme change moves both at
                        once and a waiting body is recognisably the same object as
                        the delivered one it becomes. */}
                    <div
                        className="chat-bubble chat-bubble-user chat-pending-queue-bubble"
                        title={entry.content}
                    >
                        <div className="chat-pending-queue-body">{entry.content}</div>
                        {entry.outgoingReceipt?.state === 'failed' && <div className="text-2xs" role="status">{t('chat.deliveryFailed')}</div>}
                        {/* Accepted queues and unconfirmed native writes stay neutral.
                            Only a proven rejection or expired queue gets a warning;
                            the localized accessible label carries the exact state. */}
                        <span
                            className={entry.stale === true && !entry.deliveryUncertain
                                ? 'chat-pending-queue-clock chat-pending-queue-stale'
                                : 'chat-pending-queue-clock'}
                            role="img"
                            aria-label={entry.outgoingReceipt?.state === 'failed' ? t('chat.deliveryFailed') : entry.deliveryUncertain ? t('chat.deliveryUncertain') : entry.stale === true ? t('chat.notDeliveredAria') : t('chat.waitingToSendAria')}
                            title={entry.outgoingReceipt?.state === 'failed' ? t('chat.deliveryFailed') : entry.deliveryUncertain ? t('chat.deliveryUncertain') : entry.stale === true ? t('chat.notDelivered') : t('chat.waitingToSendAria')}
                        >
                            {entry.outgoingReceipt?.state === 'failed' || (entry.stale === true && !entry.deliveryUncertain) ? '⚠' : '⏱'}
                        </span>
                    </div>
                    {entry.deliveryUncertain && entry.outgoingReceipt?.state !== 'failed' && <button
                        type="button" className="chat-pending-queue-cancel"
                        aria-label={t('common.close')} title={t('chat.deliveryUncertain')}
                        onClick={() => setDismissed(previous => new Set(previous).add(entry.id!))}>✕</button>}
                    {onSendNow && !entry.deliveryUncertain && (
                        // ★ (QUEUE-SEND-NOW-RESTORED) Same always-in-DOM,
                        // hover-dimmed treatment as cancel below — a phone has no
                        // hover, so touch must not lose the affordance either.
                        // SEND-NOW-AGENT-QUEUE: this hands the body to the
                        // agent's own queue and does NOT discard the running
                        // turn; what it does lives in the tooltip, not in a
                        // permanent sentence next to every row.
                        <button
                            type="button"
                            onClick={() => onSendNow(entry.id)}
                            disabled={isSendingNow || entry.deliveryUncertain || (entry.requiresReceipt && !entry.outgoingReceipt)}
                            className="chat-pending-queue-send"
                            aria-label={t('chat.sendNowAria')}
                            title={t('chat.sendNowTitle')}
                        >
                            ↑
                        </button>
                    )}
                    {onCancelQueued && (!entry.deliveryUncertain || entry.outgoingReceipt?.state === 'failed') && (
                        // ★ Always in the DOM, never hover-gated in markup.
                        //
                        // Hover-only would make cancelling unreachable on a phone,
                        // which is the surface the owner reported this from. It is
                        // instead always present and always tappable, dimmed until
                        // hover/focus on pointer devices (see `.chat-pending-queue-
                        // cancel` — a `@media (hover: hover)` rule, so touch keeps
                        // it visible). Keyboard focus reveals it the same way, so
                        // tabbing to it does not press an invisible control.
                        <button
                            type="button"
                            onClick={() => onCancelQueued(entry.id)}
                            disabled={isSendingNow || (entry.deliveryUncertain && entry.outgoingReceipt?.state !== 'failed') || (entry.requiresReceipt && !entry.outgoingReceipt)}
                            className="chat-pending-queue-cancel"
                            aria-label={t('chat.cancelQueuedAria')}
                            title={t('chat.cancelQueuedTitle')}
                        >
                            ✕
                        </button>
                    )}
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
    // ★ (QUEUE-SEND-NOW-RESTORED) `onSendNow` is rendered again, so a stale
    // closure here would fire a previous render's handler on click.
    prev.onSendNow === next.onSendNow
    && prev.onCancelQueued === next.onCancelQueued
    && prev.isSendingNow === next.isSendingNow
    && prev.entries.length === next.entries.length
    && prev.entries.every((entry, index) => {
        const other = next.entries[index];
        return !!other
            && entry.id === other.id
            && entry.content === other.content
            && entry.queued === other.queued
            // ★ `stale` selects the row's label, so omitting it here would let the
            // strip keep rendering "Waiting to send" after the entry had already
            // been marked undelivered — the memo would report no visible change.
            && entry.stale === other.stale
            && entry.deliveryUncertain === other.deliveryUncertain
            && entry.outgoingReceipt === other.outgoingReceipt;
    })
));

export default PendingQueueStrip;
