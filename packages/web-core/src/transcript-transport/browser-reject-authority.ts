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
 * ── Why reject-all is safe HERE, and only here ─────────────────────────────
 * `verifyFinality: () => false` rejects *every* certificate, including
 * legitimate ones. On a ring-retention topic that costs nothing:
 *
 *   1. A rejected cert takes a DEFINED branch, not an invented state —
 *      vendor/seqscribe/src/finality.ts:115-119 routes a failed verify to
 *      `emitAnomaly({ kind: 'bad_cert' })`. No throw, no wedge.
 *   2. Certs never arrive on this topic anyway: SPEC §7.9 exempts ring
 *      retention from finality/archive/snapshot entirely.
 *   3. The SUB/tail read path this node uses does not touch signatures —
 *      `vendor/seqscribe/src/subs.ts` contains zero authority references.
 *
 * The corollary is the danger: on a `full`-retention content topic (e.g.
 * `config.settings`), reject-all would silently kill finality rather than
 * merely being inert. That is why `assertRingOnlyPolicy` below exists and why
 * `guardRingOnlyDefineTopic` is applied at the node boundary — a node wired
 * with these hooks must only ever define ring topics.
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
    // cert is ever produced (SPEC §7.9), and a rejected one is a defined
    // `bad_cert` anomaly, not an error path.
    verifyFinality: (): boolean => false,
});

/**
 * True when `policy` is one this authority may safely back — i.e. its retention
 * is a bounded ring, so finality is exempt (SPEC §7.9) and reject-all is inert.
 */
export function isRingOnlyPolicy(policy: TopicPolicy): boolean {
    return policy.retention.mode === 'ring';
}

/**
 * Fail-closed guard: throws unless `policy` is ring-retention.
 *
 * ★ This is the safety interlock for `browserRejectAuthority`. Rejecting all
 * certificates is harmless on a ring topic and silently destructive on a
 * `full`-retention content topic, where real finality would be dropped with no
 * symptom other than a watermark that never advances. Rather than trust future
 * callers to remember that, any node wired with these hooks refuses at
 * `defineTopic` time to define a non-ring topic.
 */
export function assertRingOnlyPolicy(topic: string, policy: TopicPolicy): void {
    if (isRingOnlyPolicy(policy)) return;
    throw new Error(
        `browserRejectAuthority refuses to define "${topic}": retention "${policy.retention.mode}" is not "ring". ` +
            'These hooks reject every finality certificate, which is inert only on ring topics (seqscribe SPEC §7.9 ' +
            'exempts ring retention from finality); on a full-retention topic it would silently drop legitimate ' +
            'finality. A node using browserRejectAuthority must define ring topics only.',
    );
}

/** Minimal structural view of the node surface this guard wraps. */
export interface RingOnlyDefineTopicTarget {
    defineTopic(topic: string, policy: TopicPolicy): void;
}

/**
 * Wrap a node so `defineTopic` enforces {@link assertRingOnlyPolicy} before
 * delegating. Applied by `TranscriptWorkerNode` whenever reject-all authority
 * hooks are supplied, so the interlock cannot be bypassed by reaching for
 * `node.defineTopic` directly.
 */
export function guardRingOnlyDefineTopic<T extends RingOnlyDefineTopicTarget>(node: T): T {
    const original = node.defineTopic.bind(node);
    const guarded = (topic: string, policy: TopicPolicy): void => {
        assertRingOnlyPolicy(topic, policy);
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
