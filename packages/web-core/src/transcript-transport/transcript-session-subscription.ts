/**
 * Worker-side live chat feed for ONE session — design 2026-09-28
 * message-keyed storage §5.4.
 *
 * This joins three already-built halves:
 *
 *   topic-addressing.ts     → WHICH topic (`session.<id>.chat`, byte-identical
 *                             to the daemon's)
 *   TranscriptWorkerNode    → attach/subscribe mechanics
 *   KeyedTranscriptFolder   → keyed rows → verified committed view + per-commit
 *                             changes (`onFrame`)
 *
 * ── Why the folder is imported from daemon-core rather than copied ──────────
 * `transcript-keyed-folder.ts` and its codec are portable on purpose (no
 * `Buffer`, no Node builtins — see the codec's header), so the browser folds
 * and verifies with the SAME code the daemon's replica store runs: the commit
 * digest over `(id, rev)`, the live count, the session/owner identity gates.
 * A second implementation could drift into accepting a frame the daemon would
 * reject. It is reached through daemon-core's
 * `./seqscribe/transcript-keyed-folder` SUBPATH export, never the root barrel:
 * a barrel value-import would drag the logger's fs/path into the browser
 * bundle and kill it.
 *
 * ── A SNAP reset is a display signal, not a data loss ───────────────────────
 * A keyed `tail` SNAP is `latestPerKey(W) ∪ rowsAfter(W)` (the daemon's tail
 * selector, W = the newest commit's rowid): the WHOLE committed live set, not
 * a ring window. The folder verifies it against that commit and swaps
 * atomically; until it verifies, the previous committed view keeps serving —
 * so a reset never blanks the pane and never replays history through it.
 * Whether earlier bubbles were omitted is the producer's own statement
 * (`meta.coverage.omittedBefore`: a window source or the live-size cap), not
 * something a reader has to infer from ring positions.
 *
 * ── Resync ──────────────────────────────────────────────────────────────────
 * A frame that fails verification (digest mismatch, a torn SNAP, a foreign
 * owner) leaves the folder flagged `needsResync`. The subscription is then
 * restarted — a fresh SUB answers with a reset SNAP — while the SAME folder is
 * kept, so its last verified view keeps serving. When the same reason repeats
 * `BASE_REQUEST_AFTER` times in a row, the owner is asked for one base frame
 * (`onBaseRequest` → `request_transcript_base` on the main thread's command
 * path), mirroring the daemon replica store
 * (`seqscribe/transcript-replica-store.ts`).
 */
import {
    KeyedTranscriptFolder,
    parseChatSubRow,
    type KeyedChatRow,
    type KeyedFoldRejectReason,
    type KeyedTranscriptFrameDelta,
} from '@adhdev/daemon-core/seqscribe/transcript-keyed-folder';
import type { ReplicatedTranscriptViewV2 } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec';
import type { PeerHandle, Row, Subscription, Unsub } from 'seqscribe';
import { sessionChatPolicy, sessionChatTopic } from './topic-addressing.js';
import type { TranscriptWorkerNode } from './transcript-worker-node.js';

/**
 * Consecutive resyncs for the same reason before asking the owner for a base
 * frame. Mirrors `TRANSCRIPT_REPLICA_BASE_REQUEST_AFTER` in the daemon's
 * replica store.
 */
export const BASE_REQUEST_AFTER = 3;

export interface TranscriptSessionSubscriptionOptions {
    /** Raw session id. Sanitized into the topic name here — callers pass raw. */
    readonly sessionId: string;
    /** The attached daemon peer this session's transcript is served by. */
    readonly peer: PeerHandle;
    /**
     * The producing daemon's id. When present the folder refuses a commit any
     * other daemon produced (`daemonIdsEquivalent`), on top of the topic name
     * and the commit's own session id.
     */
    readonly ownerDaemonId?: string;
    /**
     * Fires once per applied commit with exactly what changed — `reset:true`
     * carries the whole live set (SNAP, first commit, writer change).
     */
    onFrame(delta: KeyedTranscriptFrameDelta): void;
    /** A row or frame was rejected. The reason is the folder's closed union. */
    onRejected?(reason: KeyedFoldRejectReason): void;
    /** The same rejection repeated `BASE_REQUEST_AFTER` resyncs in a row. */
    onBaseRequest?(): void;
    /** Defers the resubscribe off the ingest call stack. Defaults to `setTimeout(cb, 0)`. */
    schedule?(cb: () => void): void;
}

export interface TranscriptSessionSubscriptionHandle {
    /** The topic this subscription is bound to — for diagnostics/tests. */
    readonly topic: string;
    /** The last verified committed view, or null before the first one. */
    view(): ReplicatedTranscriptViewV2 | null;
    /** Subscriptions restarted after a folder resync — diagnostics/tests. */
    resubscribes(): number;
    /** Idempotent. */
    close(): void;
}

/**
 * Define the session's chat topic, subscribe to its `tail` through the
 * already-attached daemon peer, and fold the rows into verified frames.
 *
 * The topic is defined on THIS node with the same policy the daemon uses
 * (`sessionChatPolicy`) — `topicSchemaHash` covers the policy's kind and
 * finality authority, and a divergent one is rejected peer-side as
 * `ERR_SCHEMA_MISMATCH`. `TranscriptWorkerNode`'s browser-safe-finality
 * interlock (`browser-reject-authority.ts`) independently refuses any policy it
 * has not reasoned about being safe here — `full` retention + `subscribe-only`
 * is one of the two shapes it accepts.
 */
export function subscribeSessionChat(
    node: TranscriptWorkerNode,
    options: TranscriptSessionSubscriptionOptions,
): TranscriptSessionSubscriptionHandle {
    const topic = sessionChatTopic(options.sessionId);
    // Idempotent by design: re-defining an identical topic/policy is a no-op in
    // seqscribe, so a second session activation for the same topic is safe.
    node.node.defineTopic(topic, sessionChatPolicy());

    const folder = new KeyedTranscriptFolder({
        expectedSessionId: options.sessionId,
        ...(options.ownerDaemonId ? { expectedOwnerDaemonId: options.ownerDaemonId } : {}),
        onFrame: (delta) => {
            if (closed) return;
            // An applied commit ends any resync streak.
            streak = null;
            options.onFrame(delta);
        },
    });
    const schedule = options.schedule ?? ((cb: () => void): void => void setTimeout(cb, 0));

    let subscription: Subscription | null = null;
    let unsubs: Unsub[] = [];
    let generation = 0;
    let streak: { reason: KeyedFoldRejectReason; count: number } | null = null;
    let resyncScheduled = false;
    let resubscribes = 0;
    let closed = false;

    const parse = (rows: readonly Row[]): KeyedChatRow[] => {
        const out: KeyedChatRow[] = [];
        for (const row of rows) {
            const parsed = parseChatSubRow(row);
            if (parsed) out.push(parsed);
            else options.onRejected?.('malformed_row');
        }
        return out;
    };

    const detach = (): void => {
        for (const unsub of unsubs) {
            try {
                unsub();
            } catch {
                // listener already gone with its subscription
            }
        }
        unsubs = [];
        if (subscription) {
            try {
                node.unsubscribe(subscription);
            } catch {
                // subscription already torn down with its peer
            }
        }
        subscription = null;
    };

    /** Restart the SUB (→ fresh reset SNAP), keeping the folder's verified view. */
    const scheduleResync = (reason: KeyedFoldRejectReason): void => {
        streak = streak?.reason === reason ? { reason, count: streak.count + 1 } : { reason, count: 1 };
        if (streak.count >= BASE_REQUEST_AFTER) {
            streak = null;
            try {
                options.onBaseRequest?.();
            } catch {
                // best-effort — the resubscribe below still runs
            }
        }
        if (resyncScheduled) return;
        resyncScheduled = true;
        schedule(() => {
            resyncScheduled = false;
            if (closed) return;
            detach();
            resubscribes += 1;
            attach();
        });
    };

    /** Surface this batch's rejections and resync when the folder asks for it. */
    const after = (rejectedBefore: number, gen: number): void => {
        if (closed || gen !== generation) return;
        const stats = folder.stats();
        if (stats.rejectedRows > rejectedBefore && stats.lastRejectReason) {
            options.onRejected?.(stats.lastRejectReason);
        }
        const reason = folder.needsResync;
        if (!reason) return;
        // Only a rejection that happened in THIS batch counts toward the streak
        // — rows arriving before the resubscribe lands must not re-trigger it.
        if (stats.rejectedRows > rejectedBefore) scheduleResync(reason);
    };

    const attach = (): void => {
        generation += 1;
        const gen = generation;
        const sub = node.subscribe(options.peer, { view: 'tail', params: { topic } });
        subscription = sub;
        unsubs = [
            sub.onSnapshot((rows) => {
                if (closed || gen !== generation) return;
                const before = folder.stats().rejectedRows;
                folder.ingestSnapshot(parse(rows));
                after(before, gen);
            }),
            // DELTA upserts are the steady-state path once a SNAP has landed.
            // A keyed tail DELTA carries appended rows only; a deleted bubble
            // arrives as a `chat.del.v2` tombstone ROW, so `deletes` (seqscribe
            // row keys) carries nothing the folder needs.
            sub.onDelta(({ upserts }) => {
                if (closed || gen !== generation) return;
                const before = folder.stats().rejectedRows;
                folder.ingestRows(parse(upserts));
                after(before, gen);
            }),
        ];
    };

    attach();

    return {
        topic,
        view: () => folder.view(),
        resubscribes: () => resubscribes,
        close(): void {
            if (closed) return;
            closed = true;
            detach();
        },
    };
}
