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
 * Send now is gone with it. Automatic delivery when the turn ends is the normal
 * path, and the button's own tooltip had to admit it DISCARDS the running turn —
 * a destructive interrupt does not belong on permanent display next to every
 * queued line. Cancel survives as a small ✕ affordance, because withdrawing a
 * message you have not sent yet is the one thing the owner genuinely cannot do
 * anywhere else.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingLocalMessage } from './conversation-message-snapshot';

export interface PendingQueueStripProps {
    /** Every body still waiting, oldest first — the daemon's own drain order. */
    entries: readonly PendingLocalMessage[];
    /**
     * Interrupt the running turn and deliver this body now.
     *
     * ★ No longer rendered (QUEUE-BUBBLE-LOOK) — kept in the contract because
     * `ChatPane` and the in-transcript bubble still wire the same handler, and
     * because dropping it here would silently change the prop shape for every
     * surface that mounts the strip. The strip simply does not surface it.
     */
    onSendNow?: (pendingId?: string) => void;
    /** Withdraw this body from the daemon FIFO. */
    onCancelQueued?: (pendingId: string) => void;
    /** Disables the cancel affordance while a send/cancel round trip is open. */
    isSendingNow?: boolean;
}

function PendingQueueStripImpl({
    entries,
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

    // The region's own label must not out-live the claim its rows are making: a
    // strip holding nothing but undelivered bodies announced as "Waiting to send"
    // would tell a screen-reader user the exact thing this change exists to stop
    // saying. Any still-waiting row keeps the waiting label, since that is then
    // true of the region as a whole.
    const hasLiveWait = waiting.some(entry => entry.stale !== true);
    const regionLabel = hasLiveWait ? t('chat.waitingToSendAria') : t('chat.notDeliveredAria');

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
                        {/* The undelivered marker. A glyph rather than a sentence:
                            it has to sit on EVERY waiting line, and a sentence
                            repeated down the strip is what made the queue read as a
                            form. `aria-label` carries the meaning the glyph cannot,
                            so nothing is lost to a screen reader.
                          *
                          * ★ (QUEUED-SEND-STUCK-FOREVER) The glyph is what states the
                          * claim, so it is also where the claim has to STOP being made.
                          * ⏱ is a PROMISE — it says the agent will get this. That
                          * promise is false once the session was torn down mid-queue:
                          * `FsmDriver.shutdown()` discards `pendingSends` and notifies
                          * nobody, so no echo and no cancel confirmation will ever
                          * arrive, and the row previously sat here repeating the
                          * promise indefinitely. The owner reported exactly this. Past
                          * the threshold it becomes ⚠ and the label says undelivered.
                          *
                          * The row is KEPT rather than removed: the text is the owner's,
                          * a discarded body is one they most likely want to resend, and
                          * Cancel still works to dismiss it. Only the claim changes. */}
                        <span
                            className={entry.stale === true
                                ? 'chat-pending-queue-clock chat-pending-queue-stale'
                                : 'chat-pending-queue-clock'}
                            role="img"
                            aria-label={entry.stale === true ? t('chat.notDeliveredAria') : t('chat.waitingToSendAria')}
                            title={entry.stale === true ? t('chat.notDelivered') : t('chat.waitingToSendAria')}
                        >
                            {entry.stale === true ? '⚠' : '⏱'}
                        </span>
                    </div>
                    {onCancelQueued && (
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
                            disabled={isSendingNow}
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
    // `onSendNow` is intentionally absent: it is no longer rendered, so a fresh
    // identity for it must not force a re-render.
    prev.onCancelQueued === next.onCancelQueued
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
            && entry.stale === other.stale;
    })
));

export default PendingQueueStrip;
