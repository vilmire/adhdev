/**
 * mesh_read_chat replica window honesty.
 *
 * The transcript replica holds only the newest bubbles (`omittedBefore`). These
 * helpers decide whether it can answer a read (it must not silently return fewer
 * messages than asked) and how a replica-served answer says that older messages
 * exist beyond its window.
 */

type ReadChatTailArgs = { tail?: number; compact?: boolean };

/** Largest tail one read may ask for; a bigger request is clamped, never relayed as-is. */
export const MAX_READ_CHAT_TAIL = 500;

/** The caller's `tail` after validation and the ceiling (default 10): the value a live read relays. */
export function clampedReadChatTail(args: ReadChatTailArgs): number {
    const tail = typeof args.tail === 'number' && Number.isInteger(args.tail) && args.tail > 0 ? args.tail : 10;
    return Math.min(tail, MAX_READ_CHAT_TAIL);
}

/** How many messages this read asks for: compact mode caps its tail at 10, compact:false does not. */
export function requestedReadChatTail(args: ReadChatTailArgs): number {
    const tail = clampedReadChatTail(args);
    return args.compact === false ? tail : Math.min(tail, 10);
}

/**
 * Can a replica payload answer this read? When the request needs more messages than the
 * replica holds and the replica does not reach the chat's start, answering from it would
 * silently return fewer than asked. A replica that reaches the start is complete.
 */
export function replicaCoversRequestedTail(payload: Record<string, any>, args: ReadChatTailArgs): boolean {
    if (payload.omittedBefore !== true) return true;
    const held = Array.isArray(payload.messages) ? payload.messages.length : 0;
    return held >= requestedReadChatTail(args);
}

/**
 * Fields a replica-served answer adds so the caller does not take the window for the whole
 * chat: its total is a lower bound, and `truncated` when it returned fewer messages than
 * requested (only possible when the live read was unavailable).
 */
export function buildReplicaWindowNote(
    payload: Record<string, any>,
    args: ReadChatTailArgs,
    liveReadUnavailable: boolean,
): Record<string, unknown> {
    if (payload.transcriptReadSource !== 'replica' || payload.omittedBefore !== true) return {};
    const requestedTail = requestedReadChatTail(args);
    const returnedMessages = Array.isArray(payload.messages) ? payload.messages.length : 0;
    return {
        totalMessagesIsLowerBound: true,
        ...(returnedMessages < requestedTail
            ? {
                truncated: true,
                requestedTail,
                returnedMessages,
                truncatedReason: liveReadUnavailable
                    ? 'The transcript replica holds only the newest messages and the live read was unavailable; older messages exist.'
                    : 'The transcript replica holds only the newest messages; older messages exist.',
            }
            : {}),
    };
}
