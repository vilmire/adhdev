/**
 * Browser-side seqscribe authority hooks — a NON-SIGNING, reject-all verifier.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * `session.<id>.transcript` is a content-class policy that names
 * `finalityAuthority: ADHDEV_AUTHORITY_ID` (topic-addressing.ts, mirroring
 * daemon-core `seqscribe/topics.ts`). seqscribe refuses to DEFINE such a topic
 * unless an `AuthorityHooks.verifyFinality` is present:
 *
 *   vendor/seqscribe/src/topics.ts:53-54
 *     if (p.finalityAuthority !== undefined && !authority?.verifyFinality)
 *       throw misuse(`${topic} sets finalityAuthority but ... absent`);
 *
 * That check is the WHOLE gate. It tests for the hook's *existence*; it never
 * reads `p.access`, never asks whether the hook can sign, and never asks for a
 * secret. So a browser can satisfy it without holding fleet key material.
 *
 * ── Why we do not simply drop `finalityAuthority` in the browser ───────────
 * Because `finalityAuthority` is an input to `topicSchemaHash` (seqscribe SPEC
 * §14 / host-guide §6). Dropping it on one end only would fork the hash and
 * every daemon peer would reject the topic with `ERR_SCHEMA_MISMATCH`. Removing
 * it fleet-wide is separately forbidden by the design doc. The policy therefore
 * stays byte-identical to the daemon's, and only the hook differs.
 *
 * ── Why reject-all is safe on a RING topic, or a FULL+subscribe-only one ───
 * `verifyFinality: () => false` rejects *every* certificate, including
 * legitimate ones. Two distinct, independently-sufficient reasons make that
 * inert rather than destructive, and `isBrowserSafeFinalityPolicy` below
 * accepts a topic when EITHER applies:
 *
 *   1. RING retention: certs never arrive on a ring topic at all — SPEC §7.9
 *      exempts ring retention from finality/archive/snapshot entirely. There
 *      is nothing for this hook to reject in the first place.
 *   2. FULL retention + `subscribe-only` replication (G2b, landed
 *      2026-09-24 — `session.<id>.transcript`): certs DO arrive here, but a
 *      rejected cert takes a DEFINED branch, not an invented state —
 *      vendor/seqscribe/src/finality.ts:115-119 routes a failed verify to
 *      `emitAnomaly({ kind: 'bad_cert' })`, no throw, no wedge — and that
 *      rejection is purely LOCAL: `verifyAndClassify` only mutates THIS
 *      node's own `applyCert`/`getCert` state, never propagated to peers. A
 *      `subscribe-only` leaf never re-serves what it locally rejected as
 *      accepted to anyone else, so the browser's blanket "no" never corrupts
 *      another peer's view of finality. `full` + `full-sync` is the case
 *      this does NOT cover: a full-sync topic IS cross-peer canonical, so
 *      this node's own cert handling could matter to peers syncing through
 *      it — no topic on the browser side is full-sync today, but the guard
 *      stays conservative rather than assume that never changes.
 *
 * Either way, the SUB/tail read path this node uses for live delivery does
 * not touch signatures at all — `vendor/seqscribe/src/subs.ts` contains zero
 * authority references, ring or full.
 *
 * The corollary is the danger: on a `full-sync` content topic (e.g.
 * `config.settings`), reject-all would silently kill finality rather than
 * merely being inert. That is why `assertBrowserSafeFinalityPolicy` below
 * exists and why `guardBrowserSafeDefineTopic` is applied at the node
 * boundary — a node wired with these hooks must only ever define a policy
 * this module has actually reasoned about being safe.
 *
 * ── G2b (landed 2026-09-24): the vendor `tail`-view blocker is resolved ────
 * `session.<id>.transcript` switching to `full` retention was blocked once
 * before by `oss/vendor/seqscribe/src/subs.ts`'s `view:'tail'` throwing
 * `ERR_UNKNOWN_VIEW` for any non-ring topic — unrelated to this file's own
 * guard, which was already sound for the `subscribe-only` case even then.
 * That vendor restriction is now resolved: `tail` also serves `full` +
 * `subscribe-only` topics with identical SNAP/DELTA/Row wire shapes, so both
 * the daemon replica store and this package's own
 * `transcript-session-subscription.ts` keep working unmodified.
 *
 * ── Why this is NOT a secret ───────────────────────────────────────────────
 * There is no key, no HMAC, no `issue*` hook. Nothing here can produce a
 * signature, so nothing here can be exfiltrated into forged finality. Compare
 * daemon-core `seqscribe/authority.ts`, which takes the fleet HMAC secret and
 * supplies the real `verifyFinality`/`issueWriterDirective`. This module is the
 * deliberate opposite: the minimum shape that unblocks `defineTopic`, with the
 * signing capability structurally absent rather than merely unused.
 *
 * Precedent for secretless seqscribe nodes:
 *   - `daemon-core/src/seqscribe/node.ts:211` — a node without the fleet secret
 *     filters itself down to metadata-only topics (production path).
 *   - `transcript-worker-node.ts` — already calls `createSeqscribe()` with no
 *     authority key at all.
 */
import type { AuthorityHooks, TopicPolicy } from 'seqscribe';

/**
 * Non-signing hooks that satisfy seqscribe's `finalityAuthority` presence gate
 * while being incapable of asserting or accepting finality.
 *
 * Frozen so a consumer cannot bolt an `issue*` hook onto the shared object and
 * quietly turn this into a signing surface.
 */
export const browserRejectAuthority: AuthorityHooks = Object.freeze({
    // Rejects every certificate. See this file's header: on a ring topic no
    // cert is ever produced (SPEC §7.9); on a full+subscribe-only topic a
    // rejected cert is a defined, purely-local `bad_cert` anomaly, not an
    // error path and never propagated to peers.
    verifyFinality: (): boolean => false,
});

/**
 * True when `policy` is one this authority may safely back — see this file's
 * header for the two independently-sufficient reasons: bounded ring
 * retention (finality exempt entirely, SPEC §7.9), or `full` retention with
 * `subscribe-only` replication (this node's rejection is purely local, never
 * propagated). `full` + `full-sync` is NOT safe and returns false.
 */
export function isBrowserSafeFinalityPolicy(policy: TopicPolicy): boolean {
    if (policy.retention.mode === 'ring') return true;
    return policy.retention.mode === 'full' && policy.replication === 'subscribe-only';
}

/**
 * Fail-closed guard: throws unless {@link isBrowserSafeFinalityPolicy} accepts `policy`.
 *
 * ★ This is the safety interlock for `browserRejectAuthority`. Rejecting all
 * certificates is harmless on the policies `isBrowserSafeFinalityPolicy` accepts
 * and silently destructive on a `full-sync` content topic, where real finality
 * would be dropped with no symptom other than a watermark that never advances.
 * Rather than trust future callers to remember that, any node wired with these
 * hooks refuses at `defineTopic` time to define a policy this module has not
 * reasoned about being safe.
 */
export function assertBrowserSafeFinalityPolicy(topic: string, policy: TopicPolicy): void {
    if (isBrowserSafeFinalityPolicy(policy)) return;
    throw new Error(
        `browserRejectAuthority refuses to define "${topic}": retention "${policy.retention.mode}" + ` +
            `replication "${policy.replication}" is not a policy these hooks can safely back. These hooks reject ` +
            'every finality certificate, which is inert only on ring-retention topics (seqscribe SPEC §7.9 exempts ' +
            'ring retention from finality) or full-retention subscribe-only topics (rejection never propagates to ' +
            'peers); on a full-sync topic it would silently drop legitimate finality. A node using ' +
            'browserRejectAuthority must define only policies isBrowserSafeFinalityPolicy accepts.',
    );
}

/** Minimal structural view of the node surface this guard wraps. */
export interface BrowserSafeDefineTopicTarget {
    defineTopic(topic: string, policy: TopicPolicy): void;
}

/**
 * Wrap a node so `defineTopic` enforces {@link assertBrowserSafeFinalityPolicy}
 * before delegating. Applied by `TranscriptWorkerNode` whenever reject-all
 * authority hooks are supplied, so the interlock cannot be bypassed by
 * reaching for `node.defineTopic` directly.
 */
export function guardBrowserSafeDefineTopic<T extends BrowserSafeDefineTopicTarget>(node: T): T {
    const original = node.defineTopic.bind(node);
    const guarded = (topic: string, policy: TopicPolicy): void => {
        assertBrowserSafeFinalityPolicy(topic, policy);
        original(topic, policy);
    };
    return new Proxy(node, {
        get(target, prop) {
            if (prop === 'defineTopic') return guarded;
            // ★ Read through to the TARGET, not the proxy: seqscribe's node is a
            // closure/class object whose other methods must keep their original
            // `this`. Forwarding `receiver` here would rebind `this` to the
            // proxy and break any private-field access inside them.
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
    });
}
