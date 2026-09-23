/**
 * Recent interaction id per target session.
 *
 * A command's `_interactionId` is remembered against the session it targets so
 * later topic publishes for that session (chat tail, modal) can be correlated
 * with the command that caused them in the debug trace.
 *
 * MEM-3 bound (moved from the cloud daemon): the map is keyed by session id and
 * would otherwise grow with every session the daemon ever saw. An entry is only
 * useful while its session is still producing updates, so a generous TTL (1h —
 * far longer than any command→update round trip) plus a cardinality backstop
 * bounds it without ever dropping an id a live session could still need. The
 * row just written is the newest, so its own sweep can never remove it.
 */
import { applyBoundedRetention } from '../shared/bounded-retention.js';

export const INTERACTION_CONTEXT_TTL_MS = 60 * 60 * 1000;
export const INTERACTION_CONTEXT_MAX_ENTRIES = 2000;

interface InteractionEntry {
    interactionId: string;
    at: number;
}

export class InteractionContextMap {
    private readonly bySession = new Map<string, InteractionEntry>();

    constructor(
        private readonly bounds: { ttlMs: number; maxEntries: number } = {
            ttlMs: INTERACTION_CONTEXT_TTL_MS,
            maxEntries: INTERACTION_CONTEXT_MAX_ENTRIES,
        },
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Remember `args._interactionId` for `args.targetSessionId` (when both are
     * present) and return the interaction id.
     */
    record(args: Record<string, unknown>): string | undefined {
        const interactionId = typeof args._interactionId === 'string' && args._interactionId.trim()
            ? args._interactionId
            : undefined;
        const targetSessionId = typeof args.targetSessionId === 'string' ? args.targetSessionId : '';
        if (interactionId && targetSessionId) {
            const at = this.now();
            this.bySession.set(targetSessionId, { interactionId, at });
            applyBoundedRetention(this.bySession, {
                ttlMs: this.bounds.ttlMs,
                maxEntries: this.bounds.maxEntries,
                readTimestamp: (entry) => entry.at,
                now: at,
            });
        }
        return interactionId;
    }

    /** The most recent interaction id recorded for a session. */
    get(sessionId: string | undefined): string | undefined {
        if (!sessionId) return undefined;
        return this.bySession.get(sessionId)?.interactionId;
    }

    get size(): number {
        return this.bySession.size;
    }
}
