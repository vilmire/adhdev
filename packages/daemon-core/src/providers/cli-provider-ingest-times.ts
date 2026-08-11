// Ingest-time timestamp stamping for provider-parsed chat messages that carry
// no producer timestamp.
//
// Why this exists: several CLI transcript parsers (e.g. the PTY screen parser
// used for kimi and other spec-driven providers) emit messages with no
// receivedAt/timestamp. Two downstream orderings then misfire together:
//
// 1. mergeConversationMessages (cli-provider-transcript-merge.ts) only
//    interleaves by time when BOTH sides are timed; against untimed parsed
//    messages the timestamped runtime user-input ack falls back to positional
//    ordering, which pins it after every parsed message.
// 2. web-core sorts by `receivedAt || timestamp || 0`, so untimed messages
//    sort to key 0 above the timed ack.
//
// Net effect: the user's own message bubble renders below the assistant
// bubbles that answered it.
//
// The fix follows the transcript-v2 `orderingTimestamp` contract ("assigned
// by the daemon at ingest") and the native-history executor's mtime back-fill
// precedent: the FIRST time the daemon observes an untimed parsed message, it
// assigns the current time and remembers it, so the value is stable across
// polls (the chat read path derives content hashes / providerUnitKeys from
// receivedAt, so re-stamping on every poll would churn those identities).
// Once every message is timed, both the merge interleave and the web sort
// order the user ack correctly between the turns that preceded and followed
// the send.

import { flattenContent } from './contracts.js';

const MAX_TRACKED_MESSAGES = 2000;

type StampableMessage = {
    role?: unknown;
    kind?: unknown;
    content?: unknown;
    receivedAt?: unknown;
    timestamp?: unknown;
};

function hasUsableTimestamp(message: StampableMessage): boolean {
    const value = Number(message.receivedAt || message.timestamp || 0);
    return Number.isFinite(value) && value > 0;
}

export class ParsedIngestTimestampStamper {
    private readonly firstSeenAtByKey = new Map<string, number>();

    stamp<T extends StampableMessage>(messages: T[], nowMs: number = Date.now()): T[] {
        return messages.map((message) => {
            if (!message || hasUsableTimestamp(message)) return message;
            const key = this.keyFor(message);
            let firstSeenAt = this.firstSeenAtByKey.get(key);
            if (firstSeenAt === undefined) {
                firstSeenAt = nowMs;
                this.remember(key, firstSeenAt);
            }
            return { ...message, receivedAt: firstSeenAt };
        });
    }

    private keyFor(message: StampableMessage): string {
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        const kind = typeof message.kind === 'string' ? message.kind.trim().toLowerCase() : '';
        let text = '';
        try {
            text = flattenContent(message.content as never);
        } catch {
            text = String(message.content ?? '');
        }
        // Duplicate bubbles with identical text intentionally share one stamp;
        // the merge/sort index tie-break keeps their relative order.
        return `${role}|${kind}|${text.replace(/\s+/g, ' ').trim()}`;
    }

    private remember(key: string, firstSeenAt: number): void {
        this.firstSeenAtByKey.set(key, firstSeenAt);
        while (this.firstSeenAtByKey.size > MAX_TRACKED_MESSAGES) {
            const oldest = this.firstSeenAtByKey.keys().next();
            if (oldest.done) break;
            this.firstSeenAtByKey.delete(oldest.value);
        }
    }
}
