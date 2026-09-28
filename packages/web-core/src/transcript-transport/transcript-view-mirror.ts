/**
 * Main-thread mirror of each session's committed keyed chat view — design
 * 2026-09-28 message-keyed storage §5.4 "브리지 증분화".
 *
 * The worker folds and verifies; the bridge then carries only what each
 * applied commit changed (`TranscriptBridgeFrameMessage`). This module keeps,
 * per session, a `Map<messageId, message>` and rebuilds the `ord`-sorted view
 * from it:
 *
 *   - a bubble the frame did not touch keeps its OBJECT IDENTITY across frames,
 *     so everything downstream that caches by reference (the chat-pane
 *     adapter's per-bubble mapping, React's memoized rows) sees it unchanged;
 *   - only upserted bubbles are new objects (they crossed the port, so the
 *     structured clone already made them new);
 *   - `reset` replaces the whole map — the worker only emits it for a SNAP,
 *     the first commit, or a producer writer change, each of which is the
 *     complete verified live set.
 *
 * The main thread still parses nothing and verifies nothing (bridge-protocol's
 * header): this is bookkeeping over already-verified, already-structured
 * values, in commit order, exactly as the worker's folder applied them.
 */
import type {
    ReplicatedTranscriptMessageV2,
    ReplicatedTranscriptViewV2,
} from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec';
import type { TranscriptBridgeFrameMessage, TranscriptViewMeta } from './bridge-protocol.js';

/** One session's view after a frame applied — what the host hands its caller. */
export interface TranscriptSessionView {
    /** Raw (unsanitized) session id, as activated. */
    readonly sessionId: string;
    /** The committed view: messages in `ord` order, unchanged bubbles identity-preserved. */
    readonly view: ReplicatedTranscriptViewV2;
    /** This frame replaced the whole live set (SNAP / first commit / writer change). */
    readonly reset: boolean;
}

interface SessionMirror {
    meta: TranscriptViewMeta;
    byId: Map<string, ReplicatedTranscriptMessageV2>;
    ordered: ReplicatedTranscriptMessageV2[];
    /** messageId → index in `ordered`, for the in-place fast path. */
    indexOf: Map<string, number>;
}

/**
 * Ascending `ord` order — the fractional-index contract (plain code-unit
 * compare, `messageId` as the tie-break). Must match daemon-core
 * `transcript-keyed-codec.ts#compareChatOrd`; it is restated here rather than
 * value-imported so the MAIN-thread bundle does not pull the codec (and its
 * JCS/SHA-256 dependencies) in for a three-line comparator.
 */
export function compareTranscriptOrd(
    a: { readonly ord: string; readonly messageId: string },
    b: { readonly ord: string; readonly messageId: string },
): number {
    if (a.ord !== b.ord) return a.ord < b.ord ? -1 : 1;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

function indexMessages(ordered: readonly ReplicatedTranscriptMessageV2[]): Map<string, number> {
    const indexOf = new Map<string, number>();
    ordered.forEach((message, index) => indexOf.set(message.messageId, index));
    return indexOf;
}

function buildView(mirror: SessionMirror): ReplicatedTranscriptViewV2 {
    const live = mirror.ordered.length;
    return {
        ...mirror.meta,
        coverage: { ...mirror.meta.coverage, totalMessageCount: live, returnedMessageCount: live },
        messages: mirror.ordered,
    };
}

export class TranscriptViewMirror {
    private readonly sessions = new Map<string, SessionMirror>();

    /**
     * Apply one frame. Returns the session's new view, or null when a non-reset
     * frame arrives for a session with no base (it cannot be applied without
     * one; the worker's next reset re-establishes it).
     */
    apply(frame: TranscriptBridgeFrameMessage): TranscriptSessionView | null {
        if (frame.reset) {
            if (!frame.meta) return null;
            const ordered = [...frame.upserts].sort(compareTranscriptOrd);
            const mirror: SessionMirror = {
                meta: frame.meta,
                byId: new Map(ordered.map((message) => [message.messageId, message])),
                ordered,
                indexOf: indexMessages(ordered),
            };
            this.sessions.set(frame.sessionId, mirror);
            return { sessionId: frame.sessionId, view: buildView(mirror), reset: true };
        }

        const mirror = this.sessions.get(frame.sessionId);
        if (!mirror) return null;

        // Meta travels only when it changed; the commit identity (epoch/frame)
        // advances on every frame regardless.
        mirror.meta = frame.meta ?? { ...mirror.meta, epoch: frame.epoch, frame: frame.frame };

        // ── Fast path: every upsert replaces an existing bubble at the same
        // `ord` and nothing was deleted — the order is unchanged, so swap the
        // changed slots in a copy instead of re-sorting the whole transcript
        // (the common streaming tick: one growing bubble).
        const inPlace = frame.deletes.length === 0 && frame.upserts.every((message) => {
            const previous = mirror.byId.get(message.messageId);
            return previous !== undefined && previous.ord === message.ord;
        });
        if (inPlace) {
            if (frame.upserts.length > 0) {
                const ordered = mirror.ordered.slice();
                for (const message of frame.upserts) {
                    mirror.byId.set(message.messageId, message);
                    ordered[mirror.indexOf.get(message.messageId)!] = message;
                }
                mirror.ordered = ordered;
            }
        } else {
            for (const id of frame.deletes) mirror.byId.delete(id);
            for (const message of frame.upserts) mirror.byId.set(message.messageId, message);
            mirror.ordered = Array.from(mirror.byId.values()).sort(compareTranscriptOrd);
            mirror.indexOf = indexMessages(mirror.ordered);
        }
        return { sessionId: frame.sessionId, view: buildView(mirror), reset: false };
    }

    /** The session's current view, or null before its first reset frame. */
    view(sessionId: string): ReplicatedTranscriptViewV2 | null {
        const mirror = this.sessions.get(sessionId);
        return mirror ? buildView(mirror) : null;
    }

    /** Drop every session not in `sessionIds` (deactivated sessions). */
    retain(sessionIds: readonly string[]): void {
        const keep = new Set(sessionIds);
        for (const sessionId of [...this.sessions.keys()]) {
            if (!keep.has(sessionId)) this.sessions.delete(sessionId);
        }
    }

    clear(): void {
        this.sessions.clear();
    }
}
