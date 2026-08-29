/**
 * `session.<safeSessionId>.transcript` dynamic activation — §8 unit 3
 * ("dynamic transcript activation + daemon replica store").
 *
 * This is the piece transcript-topic-claim.ts's header and transcript-
 * publisher.ts's header both name as deferred: wiring the LOCAL, in-memory
 * claim primitive (transcript-topic-claim.ts) and the topic table
 * (topics.ts#sessionTranscriptTopic/sessionTranscriptPolicy, from §8 unit 1)
 * into an actual `node.node.defineTopic` call, on BOTH the publisher and the
 * subscriber side of a session — design §3.1: "런타임 session discovery 때 양
 * 끝이 같은 policy로 define한 뒤, handle의 topics에 push한 뒤 topic activation
 * notification을 보낸다. 기존 mesh runtime activation의 define → topics.push →
 * onTopicActivated → full grant map 재산출 → reconnect.updateGrants 패턴을
 * 일반화한다."
 *
 * ── Reused, not reinvented ─────────────────────────────────────────────────
 * `announceTopicActivated`/`onTopicActivated` (mesh-dual-write.ts) are keyed
 * on the NODE HANDLE, not on any mesh-specific state — the P14/P15 grant
 * re-derivation they drive already runs for ANY topic in `node.topics`
 * regardless of which module defined it. So a transcript topic activated
 * through `ensureSessionTranscriptTopic` below reaches the exact same
 * transport listener (today: `SeqscribeDataChannelRouter.deriveGrants`) that
 * mesh events/handoff topics do, with no new plumbing on that side.
 *
 * ★ That reuse is also this unit's honestly-reported LIMIT, not a full
 * solution: `deriveGrants()` grants every currently-defined topic to every
 * attached peer uniformly (the existing "fleet-wide full-map" the mesh events/
 * handoff topics were designed for). Owner decision §9 item 4 explicitly
 * REJECTS that shape for transcript topics in favor of a session-interest
 * grant map (least privilege — a peer should see `serve` only for the
 * sessions it actually subscribed to). Achieving that requires per-peer grant
 * differentiation in the TRANSPORT layer (`packages/daemon-cloud`'s
 * `SeqscribeDataChannelRouter`/the standalone WS equivalent), which is outside
 * `oss/packages/daemon-core` and outside this unit's declared file scope
 * (§8 unit 3 is "daemon replica store", not the P2P transport). What THIS
 * unit does instead, as a partial, real mitigation: a transcript topic is
 * only ever DEFINED (and therefore only ever eligible for ANY grant) once a
 * producer has something to publish or a consumer has actually asked to
 * subscribe (`ensureSessionTranscriptTopic` is called on demand, per session —
 * see transcript-publish-runtime.ts and transcript-replica-store.ts — never
 * at boot for every known session). That bounds exposure to "sessions someone
 * cares about" rather than "every session that ever existed", but it is not
 * the per-peer narrowing the owner decision asks for. Follow-up: a
 * `packages/daemon-cloud` change to make `deriveGrants` peer-aware for
 * `access:'content'`+`subscribe-only` topics.
 */

import { LOG } from '../logging/logger.js';
import { announceTopicActivated } from './mesh-dual-write.js';
import type { SeqscribeNodeHandle } from './node.js';
import { sessionTranscriptPolicy, sessionTranscriptTopic } from './topics.js';
import type { TranscriptTopicClaim, TranscriptTopicClaimRegistry } from './transcript-topic-claim.js';

export type TranscriptActivationRejectReason =
    | 'raw_session_id_conflict'
    | 'authority_unavailable'
    | 'define_failed';

export type TranscriptActivationResult =
    | { readonly ok: true; readonly topic: string }
    | {
          readonly ok: false;
          readonly reason: TranscriptActivationRejectReason;
          /** Only for `raw_session_id_conflict` — the claim that already holds the topic. */
          readonly existing?: TranscriptTopicClaim;
      };

/**
 * Per-node cache of "have we already defined (or permanently failed to
 * define) this transcript topic on THIS node handle". Same non-enumerable
 * symbol-on-the-handle idiom `mesh-dual-write.ts#listenersFor` uses, for the
 * same two reasons: a process can hold more than one open node, and
 * daemon-core can be loaded as two separate module registry entries (built
 * bundle + tsx source path mapping) that must not each keep their own cache.
 */
const DEFINED_TRANSCRIPT_TOPICS = Symbol.for('adhdev.seqscribe.definedTranscriptTopics');
type DefinedTopicsHost = { [DEFINED_TRANSCRIPT_TOPICS]?: Map<string, boolean> };

function definedTopicsFor(node: SeqscribeNodeHandle): Map<string, boolean> {
    const host = node as unknown as DefinedTopicsHost;
    let map = host[DEFINED_TRANSCRIPT_TOPICS];
    if (!map) {
        map = new Map<string, boolean>();
        Object.defineProperty(node, DEFINED_TRANSCRIPT_TOPICS, {
            value: map,
            enumerable: false,
            writable: false,
            configurable: true,
        });
    }
    return map;
}

/**
 * Claim + define + announce `session.<safeSessionId>.transcript` for
 * `rawSessionId` on `node`, if not already done. Both the publisher
 * (transcript-publish-runtime.ts) and the subscriber
 * (transcript-replica-store.ts) call this on their OWN node before they
 * append/subscribe — each end needs the schema locally, and each end needs
 * the fail-closed claim (design §3.5): "이미 다른 raw ID가 claim한 topic이면
 * define/serve/publish/SUB를 모두 fail-closed하고 legacy로 fallback한다."
 *
 * `authority_unavailable` (no fleet secret) is NOT cached as a permanent
 * failure — an `auth_ok`-delivered secret can arrive later in the process
 * lifetime, and the caller is expected to simply retry on its next
 * publish/subscribe attempt rather than latch a stale negative.
 */
export function ensureSessionTranscriptTopic(
    node: SeqscribeNodeHandle,
    claims: TranscriptTopicClaimRegistry,
    rawSessionId: string,
    ownerDaemonId: string,
): TranscriptActivationResult {
    const topic = sessionTranscriptTopic(rawSessionId);

    const claimResult = claims.claim({ topic, rawSessionId, ownerDaemonId });
    if (!claimResult.ok) {
        return { ok: false, reason: claimResult.reason, existing: claimResult.existing };
    }

    const cache = definedTopicsFor(node);
    const known = cache.get(topic);
    if (known === true) return { ok: true, topic };
    if (known === false) return { ok: false, reason: 'define_failed' };

    if (!node.authorityEnabled) {
        return { ok: false, reason: 'authority_unavailable' };
    }

    // Already defined by a prior process lifetime path (unexpected for a
    // per-session topic — there is no boot-time registration for these, see
    // topics.ts#baseTopicDefinitions — but adopt rather than redefine, which
    // the library rejects, matching ensureTopic/ensureHandoffTopic.
    if (node.topics.some((d) => d.topic === topic)) {
        cache.set(topic, true);
        return { ok: true, topic };
    }

    try {
        const policy = sessionTranscriptPolicy();
        node.node.defineTopic(topic, policy);
        node.topics.push({ topic, policy });
        cache.set(topic, true);
        LOG.info('Seqscribe', `transcript topic defined topic=${topic}`);
        // MUST come after the `node.topics.push` above — see the identical
        // ordering note in mesh-dual-write.ts#ensureTopic: the listener
        // re-derives its grant map from `node.topics`.
        announceTopicActivated(node, topic);
        return { ok: true, topic };
    } catch (error) {
        cache.set(topic, false);
        LOG.warn(
            'Seqscribe',
            `transcript topic activation failed topic=${topic}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return { ok: false, reason: 'define_failed' };
    }
}

/**
 * Release the claim for a session's transcript topic — daemon-side session
 * teardown (transcript-topic-claim.ts#release doc). Does NOT undefine the
 * topic on the node (seqscribe has no `undefineTopic`); it only lifts the
 * fail-closed guard so a genuinely new session that collides on the sanitized
 * segment (design §3.5) can claim the name again.
 */
export function releaseSessionTranscriptTopic(claims: TranscriptTopicClaimRegistry, rawSessionId: string): void {
    claims.release(sessionTranscriptTopic(rawSessionId));
}

/** TESTS ONLY — clears the per-node definition cache. */
export function __resetTranscriptActivationCacheForTests(node: SeqscribeNodeHandle): void {
    definedTopicsFor(node).clear();
}
